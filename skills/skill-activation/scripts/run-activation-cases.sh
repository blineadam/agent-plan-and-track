#!/usr/bin/env bash
# run-activation-cases.sh — routing-regression harness for skills.
#
# Tests whether the RIGHT skill fires for a given prompt (a description/router
# question) — the static + runtime complement to skill-comply, which tests
# whether a fired skill is FOLLOWED (a body question).
#
# Activation is checked DETERMINISTICALLY: a case passes iff the expected skill
# appears as a `Skill` tool_use in the fresh agent's stream-json trace, and any
# forbidden skill does not. No LLM judgment, so `--precheck` and `--check` cost
# nothing and are fully reproducible.
#
# Usage:
#   run-activation-cases.sh [--dry-run] [FIXTURES]        # list cases (default; free)
#   run-activation-cases.sh --precheck [SKILLS_DIR]       # static router-signal lint (free)
#   run-activation-cases.sh --check TRACE_DIR [FIXTURES]  # verify pre-captured traces (free)
#   run-activation-cases.sh --run [FIXTURES]              # invoke claude -p per case (COSTS money)
#
# FIXTURES defaults to the sibling fixtures/activation-cases.jsonl.
# SKILLS_DIR defaults to ~/.claude/skills (the installed set the agent routes on).
#
# --check reads one trace per case at TRACE_DIR/<id>.jsonl (id = each case's
# "id" field). --run writes those same files then checks them, but is a real,
# billable, tool-executing operation: it refuses unless ACTIVATION_ALLOW_SPEND=1,
# and you MUST run it inside an isolated container/VM with no network egress and
# restricted mounts — a competing/injected prompt will execute tool calls. Never
# pass --dangerously-skip-permissions here. See SKILL.md for the full rationale.
#
# Tuning (env):
#   DESC_TOKEN_FLOOR   words below which a description is a weak router signal (default 12)
#   ACTIVATION_ALLOW_SPEND   set to 1 to permit --run to call claude -p
#
# Requires jq. Portability:
#   --precheck  fully portable — reads SKILL.md descriptions only. Point it at
#               ~/.claude/skills, ~/.copilot/skills, or ~/.codex/skills.
#   --check     parses any JSONL trace that surfaces a skill tool call, keyed on
#               a tool named "skill" (case-insensitive): Claude Code's `Skill`
#               tool_use (verified) and, by the same shape, GitHub Copilot's
#               `skill` tool (likely; verify empirically). Codex `exec --json`
#               emits no skill event, so runtime activation is NOT detectable
#               there — use --precheck only on Codex.
#   --run       Claude only (invokes `claude -p`).
# Recursive descent makes the parse envelope-agnostic to minor format changes.

set -euo pipefail
command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_FIXTURES="$SCRIPT_DIR/../fixtures/activation-cases.jsonl"
DESC_TOKEN_FLOOR="${DESC_TOKEN_FLOOR:-12}"

mode="dry-run"
trace_dir=""
case "${1:-}" in
  --precheck) mode="precheck"; shift ;;
  --check)    mode="check"; trace_dir="${2:-}"; shift 2 || { echo "error: --check needs TRACE_DIR" >&2; exit 1; } ;;
  --run)      mode="run"; shift ;;
  --dry-run)  mode="dry-run"; shift ;;
  -*)         echo "error: unknown flag ${1}" >&2; exit 1 ;;
esac

# Extract the set of skills a trace activated via the skill tool. Harness-
# tolerant: matches any object whose tool name is "skill" (case-insensitive) —
# Claude's `Skill`, Copilot's `skill` — and reads the skill name from the field
# either harness places it in.
activated_skills() {
  jq -r '
    .. | objects
    | select(((.name? // "") | ascii_downcase) == "skill")
    | (.input.skill? // .input.name? // .arguments.skill? // empty)
    | select(. != null and . != "")
  ' "$1" 2>/dev/null | sort -u
}

# ---- Static router-signal lint (free) ---------------------------------------
if [[ "$mode" == "precheck" ]]; then
  skills_dir="${1:-$HOME/.claude/skills}"
  [[ -d "$skills_dir" ]] || { echo "error: no skills dir at $skills_dir" >&2; exit 1; }
  i=0; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  while IFS= read -r f; do
    name=$(basename "$(dirname "$f")")
    desc=$(awk 'BEGIN{fm=0} /^---$/{fm++; if(fm>=2)exit; next} fm==1 && /^description:/{sub(/^description:[[:space:]]*/,""); print}' "$f")
    words=$(printf '%s' "$desc" | wc -w | tr -d ' ')
    # A trigger clause is what drives routing: look for "use"/"when"/"after"/"trigger".
    has_trigger=$(printf '%s' "$desc" | grep -qiE '(^|[^[:alpha:]])(use|when|after|before|trigger)([^[:alpha:]]|$)' && echo true || echo false)
    weak=$([[ "$words" -lt "$DESC_TOKEN_FLOOR" || "$has_trigger" == false ]] && echo true || echo false)
    jq -n --arg name "$name" --argjson words "$words" \
          --argjson has_trigger "$has_trigger" --argjson weak "$weak" \
      '{skill:$name, desc_words:$words, has_trigger:$has_trigger, weak_router_signal:$weak}' \
      > "$tmp/s.$i.json"; i=$((i+1))
  done < <(find "$skills_dir" -name SKILL.md -type f 2>/dev/null | sort)
  [[ $i -eq 0 ]] && { echo '{"skills":[],"weak_count":0}'; exit 0; }
  jq -s '{skills:., weak_count:(map(select(.weak_router_signal))|length)}' "$tmp"/s.*.json
  exit 0
fi

# ---- Case-driven modes ------------------------------------------------------
FIXTURES="${1:-$DEFAULT_FIXTURES}"
[[ -f "$FIXTURES" ]] || { echo "error: no fixtures at $FIXTURES" >&2; exit 1; }

if [[ "$mode" == "dry-run" ]]; then
  jq -s '{case_count: length,
          cases: map({id, expect_skill, forbid_skill, prompt})}' "$FIXTURES"
  echo "# dry-run: no claude -p runs, no cost. Use --check TRACE_DIR or --run." >&2
  exit 0
fi

if [[ "$mode" == "run" ]]; then
  [[ "${ACTIVATION_ALLOW_SPEND:-}" == "1" ]] || {
    echo "refusing: --run invokes claude -p (billable, executes tool calls)." >&2
    echo "Run inside an isolated container/VM, then set ACTIVATION_ALLOW_SPEND=1." >&2
    exit 2
  }
  command -v claude >/dev/null 2>&1 || { echo "error: claude CLI not found" >&2; exit 1; }
  trace_dir=$(mktemp -d)
fi

# Verify each case against its trace (check + run share this).
i=0; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  id=$(jq -r '.id' <<<"$line")
  prompt=$(jq -r '.prompt' <<<"$line")
  expect=$(jq -r '.expect_skill // empty' <<<"$line")
  forbid=$(jq -r '.forbid_skill // empty' <<<"$line")

  # Validate before touching the filesystem or passing vacuously: the id is
  # interpolated into a trace path (reject path syntax so a case can't escape
  # the trace dir), and expect_skill is required (a case with no expect and no
  # forbidden hit would "pass" while testing nothing — a false negative).
  invalid=""
  case "$id" in ""|*/*|*..*) invalid="invalid id '$id': path syntax not allowed" ;; esac
  [[ -z "$invalid" && -z "$expect" ]] && invalid="invalid case '$id': missing required expect_skill"
  if [[ -n "$invalid" ]]; then
    jq -n --arg id "$id" --arg expect "$expect" --arg forbid "$forbid" --arg reason "$invalid" \
      '{id:$id, expect_skill:$expect, forbid_skill:$forbid, activated:[], pass:false, reason:$reason}' > "$tmp/c.$i.json"
    i=$((i+1)); continue
  fi
  trace="$trace_dir/$id.jsonl"

  if [[ "$mode" == "run" ]]; then
    claude -p "$prompt" --output-format stream-json --verbose \
      > "$trace" 2> "$trace_dir/$id.err" || true
  fi
  if [[ ! -f "$trace" ]]; then
    jq -n --arg id "$id" --arg expect "$expect" --arg forbid "$forbid" \
      '{id:$id, expect_skill:$expect, forbid_skill:$forbid, activated:[], pass:false, reason:"no trace file"}' > "$tmp/c.$i.json"
    i=$((i+1)); continue
  fi

  # Portable (bash 3.2 / macOS) read into array; empty-safe under `set -u`.
  acts=()
  while IFS= read -r a; do [[ -n "$a" ]] && acts+=("$a"); done < <(activated_skills "$trace")
  activated=$(printf '%s\n' ${acts[@]+"${acts[@]}"} | jq -R . | jq -s 'map(select(length>0))')
  pass=true; reason="ok"
  if [[ -n "$expect" ]] && ! printf '%s\n' ${acts[@]+"${acts[@]}"} | grep -qxF "$expect"; then
    pass=false; reason="expected '$expect' not activated"
  fi
  if [[ -n "$forbid" ]] && printf '%s\n' ${acts[@]+"${acts[@]}"} | grep -qxF "$forbid"; then
    pass=false; reason="forbidden '$forbid' activated"
  fi
  jq -n --arg id "$id" --argjson pass "$pass" --arg reason "$reason" \
        --arg expect "$expect" --arg forbid "$forbid" --argjson activated "$activated" \
    '{id:$id, expect_skill:$expect, forbid_skill:$forbid, activated:$activated, pass:$pass, reason:$reason}' \
    > "$tmp/c.$i.json"
  i=$((i+1))
done < "$FIXTURES"

# In --run we created trace_dir with mktemp; disclose it rather than silently
# leaving prompts and tool-call transcripts in /tmp. Kept (not deleted) so a
# failing case's trace can be inspected; rm it when done.
[[ "$mode" == "run" ]] && echo "# traces retained at $trace_dir — inspect failing cases, then rm" >&2

# accuracy stays present (null) on the empty-corpus path so the report shape
# never varies for consumers.
[[ $i -eq 0 ]] && { echo '{"total":0,"passed":0,"accuracy":null,"cases":[]}'; exit 0; }
jq -s '{total: length,
        passed: (map(select(.pass))|length),
        accuracy: ((map(select(.pass))|length) / length),
        cases: .}' "$tmp"/c.*.json
