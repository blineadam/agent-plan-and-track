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

jq -n --argjson skills "$skills" --argjson configs "$configs" \
      --argjson sl "$SKILL_LINE_LIMIT" --argjson rl "$RULES_LINE_LIMIT" \
      --argjson il "$INSTRUCTIONS_LINE_LIMIT" '
  {
    limits: {skill_lines:$sl, rules_lines:$rl, instructions_lines:$il},
    always_on_tokens: (($skills | map(.frontmatter_tokens) | add) // 0)
                    + (($configs | map(.tokens) | add) // 0),
    skill_body_tokens_total: (($skills | map(.body_tokens) | add) // 0),
    counts: {skills: ($skills | length), configs: ($configs | length),
             oversized_skills: ($skills | map(select(.over_limit)) | length),
             oversized_configs: ($configs | map(select(.over_limit)) | length)},
    skills: $skills,
    configs: $configs
  }'
