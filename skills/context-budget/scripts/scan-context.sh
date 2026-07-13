#!/usr/bin/env bash
# scan-context.sh — estimate the always-on context cost of the agent config
# (skills + instruction files + rules digest) and flag oversized components.
#
# Usage: scan-context.sh [EXTRA_SKILLS_DIR ...]
# Output: JSON to stdout. Requires jq.
#
# Tool-agnostic: scans the user-scope skills dir of Claude Code, GitHub Copilot,
# and Codex (whichever exist), plus any dirs passed as arguments (e.g. this
# repo's own skills/ when run from the repo root); each harness's instruction
# file (CLAUDE.md / AGENTS.md / copilot-instructions.md); and the core-rules
# digest (core-rules.md) wherever it is installed.
#
# Token estimate is deliberately crude: words × 1.3. It is a relative signal for
# spotting bloat, not an exact tokenizer count.
#
# What counts as "always on": a skill's SKILL.md frontmatter (name + description)
# is what loads into every session; the body loads only when the skill fires.
# So we report BOTH — `frontmatter_tokens` (the always-on cost) and `body_tokens`
# (the on-demand cost) — and size-flag on the body, which is what balloons.
#
# Thresholds (override via env): SKILL_LINE_LIMIT (400), RULES_LINE_LIMIT (100),
# INSTRUCTIONS_LINE_LIMIT (300).
#
# Environment:
#   CONTEXT_BUDGET_SKILLS_DIRS  Colon-separated dirs to scan instead of the
#                               default harness dirs (for testing).
#   CONTEXT_BUDGET_CONFIG_DIRS  Colon-separated dirs to search for instruction
#                               files + core-rules.md instead of the defaults.

set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }

SKILL_LINE_LIMIT="${SKILL_LINE_LIMIT:-400}"
RULES_LINE_LIMIT="${RULES_LINE_LIMIT:-100}"
INSTRUCTIONS_LINE_LIMIT="${INSTRUCTIONS_LINE_LIMIT:-300}"

# Default scan sets.
default_skills_dirs=(
  "$HOME/.claude/skills"
  "$HOME/.copilot/skills"
  "$HOME/.agents/skills"
)
default_config_dirs=(
  "$HOME/.claude"
  "$HOME/.copilot"
  "$HOME/.codex"
)

skills_dirs=()
if [[ -n "${CONTEXT_BUDGET_SKILLS_DIRS:-}" ]]; then
  IFS=':' read -r -a skills_dirs <<< "$CONTEXT_BUDGET_SKILLS_DIRS"
else
  skills_dirs=("${default_skills_dirs[@]}")
fi
skills_dirs+=("$@")

config_dirs=()
if [[ -n "${CONTEXT_BUDGET_CONFIG_DIRS:-}" ]]; then
  IFS=':' read -r -a config_dirs <<< "$CONTEXT_BUDGET_CONFIG_DIRS"
else
  config_dirs=("${default_config_dirs[@]}")
fi

# Estimated tokens for a file (words × 1.3, rounded). 0 for a missing file.
est_tokens() {
  [[ -f "$1" ]] || { echo 0; return; }
  local words
  words=$(wc -w < "$1" | tr -d ' ')
  awk -v w="$words" 'BEGIN { printf "%d", (w * 1.3) + 0.5 }'
}

line_count() {
  [[ -f "$1" ]] || { echo 0; return; }
  wc -l < "$1" | tr -d ' '
}

# Bytes of a file's YAML frontmatter block (the always-on part of a skill),
# written to a temp file so we can token-estimate just that slice.
frontmatter_tokens() {
  local file="$1"
  awk '
    BEGIN { fm=0 }
    /^---$/ { fm++; if (fm>=2) exit; next }
    fm==1 { print }
  ' "$file" | wc -w | awk '{ printf "%d", ($1 * 1.3) + 0.5 }'
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# --- Skills ---
i=0
seen_dirs=""
for dir in "${skills_dirs[@]}"; do
  [[ -n "$dir" && -d "$dir" ]] || continue
  case ":$seen_dirs:" in *":$dir:"*) continue ;; esac
  seen_dirs="$seen_dirs:$dir"
  while IFS= read -r file; do
    total=$(est_tokens "$file")
    fm=$(frontmatter_tokens "$file")
    body=$((total - fm)); [[ $body -lt 0 ]] && body=0
    lines=$(line_count "$file")
    over=$([[ "$lines" -gt "$SKILL_LINE_LIMIT" ]] && echo true || echo false)
    dp="${file/#$HOME/~}"
    name=$(basename "$(dirname "$file")")
    jq -n --arg path "$dp" --arg name "$name" --arg source "${dir/#$HOME/~}" \
          --argjson total "$total" --argjson fm "$fm" --argjson body "$body" \
          --argjson lines "$lines" --argjson over "$over" \
      '{path:$path,name:$name,source:$source,total_tokens:$total,frontmatter_tokens:$fm,body_tokens:$body,lines:$lines,over_limit:$over}' \
      > "$tmpdir/skill.$i.json"
    i=$((i+1))
  done < <(find "$dir" -name SKILL.md -type f 2>/dev/null | sort)
done
if [[ $i -eq 0 ]]; then skills="[]"; else skills=$(jq -s '.' "$tmpdir"/skill.*.json); fi

# --- Instruction files + rules digest (always on) ---
j=0
for dir in "${config_dirs[@]}"; do
  [[ -n "$dir" && -d "$dir" ]] || continue
  for base in CLAUDE.md AGENTS.md copilot-instructions.md core-rules.md; do
    file="$dir/$base"
    [[ -f "$file" ]] || continue
    kind=$([[ "$base" == "core-rules.md" ]] && echo rules || echo instructions)
    limit=$([[ "$kind" == rules ]] && echo "$RULES_LINE_LIMIT" || echo "$INSTRUCTIONS_LINE_LIMIT")
    tokens=$(est_tokens "$file")
    lines=$(line_count "$file")
    over=$([[ "$lines" -gt "$limit" ]] && echo true || echo false)
    dp="${file/#$HOME/~}"
    jq -n --arg path "$dp" --arg kind "$kind" --argjson tokens "$tokens" \
          --argjson lines "$lines" --argjson limit "$limit" --argjson over "$over" \
      '{path:$path,kind:$kind,tokens:$tokens,lines:$lines,limit:$limit,over_limit:$over}' \
      > "$tmpdir/cfg.$j.json"
    j=$((j+1))
  done
done
if [[ $j -eq 0 ]]; then configs="[]"; else configs=$(jq -s '.' "$tmpdir"/cfg.*.json); fi

# Report always-on cost PER HARNESS, not as one cross-harness sum: the three
# harnesses are mutually exclusive — a session runs in exactly one, so summing
# them (and any repo ./skills copies passed as args) would charge a portable
# skill up to four times and combine three instruction/digest pairs that never
# co-load. Each skill/config is classified to its harness; extra dirs (e.g. the
# repo's own ./skills) land in a separate `repo_inventory` bucket that is a
# pre-install source listing, never a session cost.
jq -n --argjson skills "$skills" --argjson configs "$configs" \
      --argjson sl "$SKILL_LINE_LIMIT" --argjson rl "$RULES_LINE_LIMIT" \
      --argjson il "$INSTRUCTIONS_LINE_LIMIT" '
  def hkey(p):
    if   (p | test("\\.claude"))          then "claude"
    elif (p | test("\\.copilot"))         then "copilot"
    elif (p | test("\\.agents|\\.codex")) then "codex"
    else "repo" end;
  def hstats($s; $c):
    (($s | map(.frontmatter_tokens) | add) // 0) as $fm
    | (($c | map(.tokens) | add) // 0) as $ct
    | {
        skill_count: ($s | length),
        skill_frontmatter_tokens: $fm,
        skill_body_tokens: (($s | map(.body_tokens) | add) // 0),
        config_tokens: $ct,
        always_on_tokens: ($fm + $ct),
        oversized: (($s | map(select(.over_limit)) | length)
                  + ($c | map(select(.over_limit)) | length))
      };
  ($skills  | map(. + {harness: hkey(.source)})) as $sk
  | ($configs | map(. + {harness: hkey(.path)}))  as $cf
  | {
      limits: {skill_lines:$sl, rules_lines:$rl, instructions_lines:$il},
      note: "always_on_tokens is PER harness — a session pays one harness column, never the sum. repo_inventory is source skills from extra dirs passed as args (e.g. ./skills), not a session cost.",
      harnesses: {
        claude:  hstats([$sk[]|select(.harness=="claude")];  [$cf[]|select(.harness=="claude")]),
        copilot: hstats([$sk[]|select(.harness=="copilot")]; [$cf[]|select(.harness=="copilot")]),
        codex:   hstats([$sk[]|select(.harness=="codex")];   [$cf[]|select(.harness=="codex")])
      },
      repo_inventory: {
        skill_count: ([$sk[]|select(.harness=="repo")] | length),
        skill_frontmatter_tokens: (([$sk[]|select(.harness=="repo")] | map(.frontmatter_tokens) | add) // 0),
        skill_body_tokens: (([$sk[]|select(.harness=="repo")] | map(.body_tokens) | add) // 0)
      },
      counts: {skills: ($sk | length), configs: ($cf | length),
               oversized_skills: ($sk | map(select(.over_limit)) | length),
               oversized_configs: ($cf | map(select(.over_limit)) | length)},
      skills: $sk,
      configs: $cf
    }'
