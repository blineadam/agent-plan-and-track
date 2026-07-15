---
applyTo: "hooks/**/*.js,hooks/**/*.json,**/*.sh,install.sh"
excludeAgent: "cloud-agent"
---

# Script review instructions

Applies to the Node hook scripts under `hooks/` and every bash script
(including `install.sh`). See `.ai-style-rules.md` (Golden Files: `gateguard.js`,
`delivery-gate.js`, `scan-context.sh`) for full detail.

## JS hooks

- Must fail open: wrap `main()` in a top-level `try { main() } catch { ...
  ; process.exit(0) }` and never let an error escape uncaught.
- No silent `catch {}` with zero recovery action. Assigning or returning a
  self-evidently safe default (`''`, `null`, `{}`, `[]`) needs no comment;
  that's the norm across the golden hooks, not just `readStdin()`. Add a
  one-line comment or stderr diagnostic only when the fallback's safety
  isn't obvious from the code alone (e.g. it changes control flow).
- Do not propose factoring the duplicated `readStdin()` / `intEnv()` helpers
  into a shared module. Each script installs standalone into a different
  harness's scripts directory with no shared `node_modules` or relative
  import root: the duplication is intentional.
- `camelCase` for variables and functions, except wire-format fields
  mirrored verbatim from a JSON payload (`tool_name`, `tool_input`,
  `session_id`), which stay snake_case to match the payload.
- `require` ordering: alphabetical, Node core modules only, no external npm
  dependencies.

## Shell scripts

- Start with `set -euo pipefail`.
- Gate nonstandard or optional external CLI dependencies before use, e.g.
  `command -v jq >/dev/null 2>&1 || { echo "error: ..." >&2; exit 1; }`
  (keep the `>/dev/null 2>&1`: without it, a successful `command -v` prints
  the executable's path to stdout, corrupting a script whose stdout is a
  JSON contract). Don't flag POSIX core utilities (`wc`, `tr`, `awk`,
  `sort`, `find`, `grep`, `sed`, ...) for a gate: those are assumed always
  present.
- Use `mktemp -d` for scratch space with a matching `trap ... EXIT` cleanup.
- Build JSON via `jq -n --arg` / `--argjson`, not string concatenation.
- `snake_case` for local variables and functions. Top-level script
  constants (computed-once paths, thresholds, config arrays) use
  `SCREAMING_SNAKE_CASE`, matching env-var-tunable settings.

## Hook wiring files (JSON)

- `hooks/claude/*.json`, `hooks/codex/*.json`, and `hooks/copilot/*.json`
  each speak that harness's own wire dialect (event key casing, `command`
  vs `bash`, `timeout` vs `timeoutSec`). Don't propose normalizing one
  dialect to match another: the differing shape is a harness contract, not
  an inconsistency.

## File placement

- Don't add a top-level `scripts/` directory. Skill-owned scripts live at
  `skills/<name>/scripts/`, next to the `SKILL.md` that documents them.
  Hook scripts live at `hooks/` (shared) or `hooks/<harness>/` (wiring only).

## install.sh defaults

- A repo-owned managed default (model/effort settings, skill installs)
  should be overwritten on every install run, not guarded by
  set-if-absent, unless the target write is genuinely unsafe to clobber
  (e.g. a config file a JSON tool can't round-trip losslessly).
