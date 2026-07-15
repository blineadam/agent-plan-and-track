---
applyTo: "hooks/**/*.js,**/*.sh,install.sh"
---

# Script review instructions

Applies to the Node hook scripts under `hooks/` and every bash script
(including `install.sh`). See `.ai-style-rules.md` (Golden Files: `gateguard.js`,
`delivery-gate.js`, `scan-context.sh`) for full detail.

## JS hooks

- Must fail open: wrap `main()` in a top-level `try { main() } catch { ...
  ; process.exit(0) }` and never let an error escape uncaught.
- No bare, uncommented `catch {}`. Every catch needs either a one-line
  comment explaining why swallowing is safe, or a stderr diagnostic.
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
- Gate every external dependency before use, e.g.
  `command -v jq || { echo "error: ..." >&2; exit 1; }`.
- Use `mktemp -d` for scratch space with a matching `trap ... EXIT` cleanup.
- Build JSON via `jq -n --arg` / `--argjson`, not string concatenation.
- `snake_case` for functions and variables.
