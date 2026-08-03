# Hooks reference

What each hook script does, which harnesses it runs on, and the wiring contract behind it.

## Shared script architecture

`hooks/core-rules-digest.js`, `hooks/gateguard.js`, and
`hooks/delivery-gate.js` are shared Node scripts, not one fork per harness.
Each handles harness differences at the point where they matter:

- `gateguard.js` sniffs the wire dialect at runtime (`detectDialect`) and
  branches between Copilot's shape and the shared Claude/Codex shape. Its
  payload differs by harness.
- `core-rules-digest.js` branches on a `--copilot` argv flag baked into its
  wiring at install time. Copilot needs a 10-minute throttle, tracked via a
  `.core-rules-last` stamp file, plus `{"additionalContext": ...}` JSON
  wrapping. This is why the old inline bash+jq throttle in `core-rules.json`
  is gone.
- `delivery-gate.js` needs no branching because Claude and Codex expose the
  same `Stop` payload contract.

The `hooks/<harness>/*.json` files carry no logic, only a plain
`node "<scripts>/<name>.js"` command with the `__SCRIPTS__` path baked in at
install time. Each uses its harness's hook contract:

- Claude and Codex use a PascalCase `matcher` plus `hooks[].command`.
- Copilot uses `version:1`, `bash`, and `timeoutSec`.

Those keys come from the wire contracts. Do not normalize one shape to match
the other.

All six Node hook scripts fail open, wrapped in a top-level
`try { main() } catch { ...; process.exit(0) }`. Only `gateguard.js` needs to
emit an explicit allow decision because Copilot's `PreToolUse` is fail-closed.
`core-rules-digest.js`, `delivery-gate.js`, `suggest-compact.js`, and
`plan-gate.js` simply exit 0 on failure. A hook that produces no output is
already a no-op on every harness.

## core-rules-digest.js

- Hook event: `UserPromptSubmit` on Claude/Codex, `postToolUse` on Copilot.
  Runs on all 3 harnesses.
- Prints the `core-rules.md` plus `core-rules.local.md` digest so the standing
  rules get re-injected mid-session.
- The `--copilot` flag adds the 10-minute throttle via the `.core-rules-last`
  stamp and the `additionalContext` JSON wrapping described above.
- Locates the digest via `../core-rules.md` relative to itself, so it needs no
  runtime home-directory lookup.

## gateguard.js

- Hook event: `PreToolUse`. Runs on all 3 harnesses.
- On the first edit to a file per session, injects a fact demand covering
  callers, blast radius, and schemas.
- Defaults to a non-blocking warning on Claude and Codex, and a blocking deny
  on Copilot because Copilot's `PreToolUse` has no soft-warn channel.

### Configuration

- `GATEGUARD_WARN=1` selects warn behavior. On Copilot, where there is no true
  warn channel, this becomes allow plus a stderr note.
- `GATEGUARD_DENY=1` restores blocking behavior on Claude and Codex.
- If both variables are set, `GATEGUARD_DENY` wins on every harness.

### Why warn by default on Claude and Codex

The file was marked "checked" at deny time, so a denied-then-retried edit
always passed. The gate could not verify that the demanded facts were ever
presented. A measured A/B found that the deny-and-retry loop cost about 20%
more turns for an identical edit.

## delivery-gate.js

- Hook event: `Stop`. Claude and Codex only.
- Runs warn-only pre-finish checks backing verify-before-done and
  capture-lesson. It also nudges when recent assistant text pairs an agreement
  opener with self-blame.

Copilot's `agentStop` exists, but its output contract is block/allow only. The
documented exit-2 stderr warning was observed only in `~/.copilot/logs`, not in
the user-visible output, on headless CLI 1.0.73. The warn-only design does not
port there yet.

## hooks/claude/suggest-compact.js

Claude-only nudge toward `/compact` at logical boundaries.

## hooks/claude/plan-gate.js

- Hook event: `PreToolUse`. Claude only. Codex uses its own disk-delta plan
  stamp and Bash gate (`plan-gate-pilot.js`, below). Copilot has no Skill tool
  and a fail-closed `PreToolUse`, so this hook is not installed there.
- Wired through two `PreToolUse` entries that share a command. One matches
  `Skill|Edit|Write|MultiEdit`; the other matches `Bash` for the mutation gate.

It implements several independent gates in one file:

### Stamp gate

Denies `Edit`/`Write`/`MultiEdit` to `tasks/todo.md` until a `plan-and-track`
Skill invocation stamps the session. The Skill tool call writes the stamp.

### Scope gate

Once a session's distinct edited-file count reaches
`PLANGATE_SCOPE_THRESHOLD` (default `3`) without a stamp, every further
`Edit`/`Write`/`MultiEdit` is denied. This catches a prompt that skips planning
and edits source directly without touching `tasks/todo.md`.

`tasks/todo.md`, `tasks/lessons.md`, and `.claude/settings*.json` are exempt
from the file count.

### Mutation gate

On the `Bash` entry, counts distinct outward git/gh mutation kinds toward
`PLANGATE_MUTATION_THRESHOLD` (default `2`): `git push`, `gh pr create`, and
`gh pr merge`, classified conservatively with quote awareness.

Once a session would cross that count without a stamp, the Bash call is
denied. This catches a PR-shaped task that never touches enough files to trip
the scope gate.

The stamp, scope, and mutation gates share one deny-until-stamped model. Unlike
gateguard's once-per-file gate, a bare retry never passes. Only the
`plan-and-track` stamp unlocks the session.

There is no subagent carve-out. A subagent's tool call shares its parent's
`session_id`, so the same stamp check covers delegated writes.

### Content lint

Once a session is stamped, writes to `tasks/todo.md` are content-linted. A new
unchecked `## Plan` step must carry a trailing owner tag, and `(main)` needs a
colon-separated reason. `PLANGATE_LINT_DISABLED=1` turns off only this lint.

### Migration-state deletion guard

A stamped `tasks/todo.md` write that would delete an existing
`## Migration State` heading is denied once per session, gateguard-style. This
is the durable block that `migration-discipline` keeps in a target project's
todo file. The marker is written at deny time, so an intentional retry passes.

`PLANGATE_LINT_DISABLED` does not cover this guard.

### Attribution guard

A separate guard fires once per session when an unchecked `## Plan` step's
`(main: <reason>)` tag reads as a claim about what the user did or asked rather
than a fact about the work. It also marks at deny time.

Deny-once is deliberate because the attribution may be true and the hook
cannot tell. The point is to force one conscious re-assertion, not to block it
outright.

It inspects steps that are new or whose text changed. A wrapped step carries
its owner tag on a continuation line, which a first-line-only newness test
would miss. The older content lint still looks only at new steps.

Unlike the migration-state guard, `PLANGATE_LINT_DISABLED=1` does cover this
one. It is a phrasing tripwire on a common fingerprint, not a data-loss guard.

## hooks/codex/plan-gate-pilot.js

Installed as `~/.codex/scripts/plan-gate.js`, wired for `apply_patch`
`PreToolUse`/`PostToolUse` plus `Bash` `PreToolUse`.

### Scope tracking

It snapshots declared patch paths, then assesses their disk delta after the
tool runs. It emits one nonblocking `systemMessage` after three distinct
unstamped source paths or a deleted `## Migration State` block.

### Attribution guard (Codex)

Before snapshotting, a narrow exact simulation of single-file structured
`apply_patch` Update File hunks denies once when a new or changed unchecked
`## Plan` step's `(main: <reason>)` tag reads as a claim about what the user
did or asked.

The denial timestamp is stored in the existing session-and-cwd scope record
before the denial completes. Concurrent first calls deny, while an aged,
intentional retry passes.

Multi-file patches, ambiguous context, fuzzy-only or unsupported patch syntax,
unreadable state, and path failures all fail open.
`PLANGATE_LINT_DISABLED=1` disables this attribution check.

### Mutation gate (Codex)

The same session state counts allowed mutation kinds from the closed set
`git push`, `gh pr create`, and `gh pr merge`. The second distinct kind is
denied before execution until a valid new unchecked `## Plan` item, written
through `apply_patch`, stamps the session.

Denied kinds are not recorded, so a bare retry is denied again.

### State handling

It rejects symlinked paths, retains text only for `tasks/todo.md`, and stores
other paths as hashes. It stops retaining source paths once it warns.

Missing or malformed state fails open. Completed transaction state is
removed, and stale state is bounded by pruning.
