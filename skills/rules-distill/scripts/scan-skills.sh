#!/usr/bin/env bash
# scan-skills.sh — enumerate installed skills across every supported harness and
# extract each skill's name/description/mtime as a JSON inventory.
#
# Usage: scan-skills.sh [EXTRA_SKILLS_DIR ...]
# Output: JSON to stdout. Requires jq.
#
# Tool-agnostic: scans the user-scope skills dir of Claude Code, GitHub Copilot,
# and Codex (whichever exist), plus any dirs passed as arguments (e.g. this
# repo's own skills/ when run from the repo root). Duplicate skill names across
# dirs are reported as-is — a distill run treats them as one skill by name.
#
# Environment:
#   RULES_DISTILL_SKILLS_DIRS  Colon-separated dirs to scan instead of the
#                              default harness dirs (for testing).

set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }

# Default scan set: the three harness user-scope skills dirs.
default_dirs=(
  "$HOME/.claude/skills"
  "$HOME/.copilot/skills"
  "$HOME/.agents/skills"
)

dirs=()
if [[ -n "${RULES_DISTILL_SKILLS_DIRS:-}" ]]; then
  IFS=':' read -r -a dirs <<< "$RULES_DISTILL_SKILLS_DIRS"
else
  dirs=("${default_dirs[@]}")
fi
# Append any extra dirs passed as positional args (e.g. ./skills from the repo).
dirs+=("$@")

# Extract a single-line frontmatter field (quoted or unquoted). Does not handle
# multi-line YAML blocks or nested keys.
extract_field() {
  awk -v f="$2" '
    BEGIN { fm=0 }
    /^---$/ { fm++; next }
    fm==1 {
      n = length(f) + 2
      if (substr($0, 1, n) == f ": ") {
        val = substr($0, n+1)
        gsub(/^"/, "", val); gsub(/"$/, "", val)
        print val; exit
      }
    }
    fm>=2 { exit }
  ' "$1"
}

# File mtime as UTC ISO8601, portable across GNU and BSD stat/date.
get_mtime() {
  local secs
  secs=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null) || return 0
  date -u -d "@$secs" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$secs" +%Y-%m-%dT%H:%M:%SZ
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

i=0
seen_dirs=""
for dir in "${dirs[@]}"; do
  [[ -n "$dir" && -d "$dir" ]] || continue
  # Skip a dir we already scanned (harnesses can share ~/.agents/skills).
  case ":$seen_dirs:" in *":$dir:"*) continue ;; esac
  seen_dirs="$seen_dirs:$dir"

  while IFS= read -r file; do
    name=$(extract_field "$file" "name")
    desc=$(extract_field "$file" "description")
    mtime=$(get_mtime "$file")
    dp="${file/#$HOME/~}"
    jq -n --arg path "$dp" --arg name "$name" --arg description "$desc" \
          --arg mtime "$mtime" --arg source "${dir/#$HOME/~}" \
      '{path:$path,name:$name,description:$description,mtime:$mtime,source:$source}' \
      > "$tmpdir/$i.json"
    i=$((i+1))
  done < <(find "$dir" -name SKILL.md -type f 2>/dev/null | sort)
done

if [[ $i -eq 0 ]]; then
  skills="[]"
else
  skills=$(jq -s '.' "$tmpdir"/*.json)
fi

jq -n --argjson skills "$skills" '{count: ($skills | length), skills: $skills}'
