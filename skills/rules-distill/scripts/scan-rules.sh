#!/usr/bin/env bash
# scan-rules.sh — index this repo's rule files (H2 headings + line counts) so a
# distill run can check candidates against what the rules already cover.
#
# Usage: scan-rules.sh [RULES_DIR]
# Output: JSON to stdout. Requires jq.
#
# This repo is the source of truth for the rules (README: "This repo is the
# source of truth"), so we index the repo's rules/ dir — NOT the per-tool
# installed copies. Run from the repo root, or pass the rules dir explicitly.
#
# Environment:
#   RULES_DISTILL_DIR  Override the rules dir (for testing).

set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }

RULES_DIR="${RULES_DISTILL_DIR:-${1:-$PWD/rules}}"

if [[ ! -d "$RULES_DIR" ]]; then
  jq -n --arg path "$RULES_DIR" \
    '{error:"rules dir not found — run from the repo root or pass RULES_DIR",path:$path}' >&2
  exit 1
fi

files=()
while IFS= read -r f; do files+=("$f"); done \
  < <(find "$RULES_DIR" -name '*.md' -type f 2>/dev/null | sort)

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

for i in "${!files[@]}"; do
  file="${files[$i]}"
  headings=$({ grep -E '^## ' "$file" 2>/dev/null || true; } | sed 's/^## //' | jq -R . | jq -s '.')
  lines=$(wc -l < "$file" | tr -d ' ')
  jq -n --arg file "$(basename "$file")" --argjson lines "$lines" --argjson headings "$headings" \
    '{file:$file,lines:$lines,headings:$headings}' > "$tmpdir/$i.json"
done

if [[ ${#files[@]} -eq 0 ]]; then
  rules="[]"
else
  rules=$(jq -s '.' "$tmpdir"/*.json)
fi

jq -n --arg dir "$RULES_DIR" --argjson rules "$rules" \
  '{rules_dir:$dir,total:($rules|length),rules:$rules}'
