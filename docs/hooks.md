# Hooks reference

What each hook script does, which harnesses it runs on, and the wiring contract behind it.

## Shared script architecture

`hooks/core-rules-digest.js`, `hooks/gateguard.js`, and `hooks/delivery-gate.js` are single shared Node scripts, not one fork per harness. Each one handles the Claude/Codex/Copilot differences a different way, matched to what actually varies:

- `gateguard.js` sniffs the wire dialect at runtime (`detectDialect`) and branches between Copilot's shape and the shared Claude/Codex shape, since its payload genuinely differs by harness.
- `core-rules-digest.js` branches on a `--copilot` argv flag instead, baked into its wiring at install time. Copilot needs a 10-minute throttle, tracked via a `.core-rules-last` stamp file, plus `{"additionalContext": ...}` JSON-wrapping; this is why the old inline bash+jq throttle in `core-rules.json` is gone.
- `delivery-gate.js` needs no branching at all, since Claude and Codex already expose the same Stop payload contract.

The `hooks/<harness>/*.json` wiring files carry no logic of their own, only a plain `node "<scripts>/<name>.js"` command (with the `__SCRIPTS__` path baked in at install time). Each one wires the shared script into its harness's own hook contract: Claude/Codex use a PascalCase `matcher` + `hooks[].command` shape, Copilot uses a `version:1` + `bash` + `timeoutSec` shape. The differing keys are a wire-contract requirement, never normalize one to match the other.

All six Node hook scripts fail open, wrapped in a top-level `try { main() } catch { ...; process.exit(0) }`. Only `gateguard.js`'s catch needs to emit an explicit allow decision, since Copilot's `PreToolUse` is fail-closed. `core-rules-digest.js`, `delivery-gate.js`, `suggest-compact.js`, and `plan-gate.js` simply exit 0 on failure, since a hook that produces no output is already a no-op on every harness.

## core-rules-digest.js

- Hook event: `UserPromptSubmit` on Claude/Codex, `postToolUse` on Copilot. Runs on all 3 harnesses.
- Prints the `core-rules.md` (+ `core-rules.local.md`) digest so the standing rules get re-injected mid-session.
- `--copilot` flag: adds the 10-minute throttle (via the `.core-rules-last` stamp) and the `additionalContext` JSON-wrapping described above.
- Locates the digest via `../core-rules.md` relative to itself, so it needs no runtime home-dir lookup.

## gateguard.js

- Hook event: `PreToolUse`. Runs on all 3 harnesses.
- On the first edit to a file per session, injects a fact demand (callers, blast radius, schemas).
- Default behavior is mode-dependent: a non-blocking warning on Claude and Codex, a blocking deny on Copilot, since Copilot's `PreToolUse` has no soft-warn channel.
- Env vars:
  - `GATEGUARD_WARN=1`: selects warn behavior. On Copilot, where there's no true warn channel, this degrades to allow plus a stderr note.
  - `GATEGUARD_DENY=1`: restores blocking deny behavior on Claude/Codex.
  - Precedence: if both vars are set, `GATEGUARD_DENY` wins on every harness.
- Rationale for the deny-to-warn default flip: the file was marked "checked" at deny time, so a denied-then-retried edit always passed and the gate could never actually verify the demanded facts were presented. A measured A/B found the deny-and-retry loop cost about 20% more turns for an identical edit.

## delivery-gate.js

- Hook event: `Stop`. Claude/Codex only.
- Not installed on Copilot: Copilot's `agentStop` exists but its output contract is block/allow only, with no warn-only lever, and the documented exit-2 stderr warn channel was observed landing only in `~/.copilot/logs`, not user-visible, on headless CLI 1.0.73. The warn-only design doesn't port there yet.
- Behavior: warn-only pre-finish checks backing verify-before-done and capture-lesson, plus a capitulation nudge when recent assistant text pairs an agreement opener with self-blame.

## hooks/claude/suggest-compact.js

Claude-only nudge toward `/compact` at logical boundaries.

## hooks/claude/plan-gate.js

- Hook event: `PreToolUse`. Claude only. Codex uses its own disk-delta plan stamp and Bash gate (`plan-gate-pilot.js`, below); Copilot has no Skill tool and a fail-closed `PreToolUse`, so it isn't installed there.
- Wired via two separate `PreToolUse` entries sharing the same command: one matching `Skill|Edit|Write|MultiEdit`, the other matching `Bash` for the mutation gate below.

It implements several independent gates in one file:

### Stamp gate

Denies `Edit`/`Write`/`MultiEdit` to `tasks/todo.md` until a `plan-and-track` Skill invocation has stamped the session; the Skill tool call itself writes the stamp.

### Scope gate

Once a session's distinct edited-file count reaches `PLANGATE_SCOPE_THRESHOLD` (default `3`) without a stamp, every further `Edit`/`Write`/`MultiEdit` is denied the same hard way. This catches a prompt that skips planning and edits source directly, never touching `tasks/todo.md`. `tasks/todo.md`, `tasks/lessons.md`, and `.claude/settings*.json` are exempt from the file count.

### Mutation gate

On the `Bash` entry, counts distinct outward git/gh mutation kinds (`git push`, `gh pr create`, `gh pr merge`, classified quote-aware and conservatively) toward `PLANGATE_MUTATION_THRESHOLD` (default `2`). Once a session would cross that count without a stamp, the Bash call is denied the same hard way. This catches a PR-shaped task (push, open a PR, merge) that never touches enough distinct files to trip the scope gate.

The stamp, scope, and mutation gates share one deny-until-stamped model, unlike gateguard's once-per-file gating: a bare retry never passes, only the `plan-and-track` stamp unlocks. There's no subagent carve-out either: a subagent's tool call shares its parent's `session_id`, so the same stamp check covers delegated writes too.

### Content lint

Once a session is stamped, writes to `tasks/todo.md` are also content-linted: a new unchecked `## Plan` step must carry a trailing owner tag, and `(main)` needs a colon-separated reason. `PLANGATE_LINT_DISABLED=1` turns off just this lint.

### Migration-state deletion guard

A stamped session's `tasks/todo.md` write that would delete an existing `## Migration State` heading (the durable block the `migration-discipline` skill keeps in a target project's todo.md) is denied once per session, gateguard-style: the marker is written at deny time, so an intentional retry passes. `PLANGATE_LINT_DISABLED` does not cover this guard.

### Attribution guard

A separate guard, also once per session and also mark-at-deny-time, fires when an unchecked `## Plan` step's `(main: <reason>)` tag reads as a claim about what the user did or asked rather than a fact about the work. Deny-once is deliberate here: the attribution may well be true and the hook cannot tell, so the point is to force one conscious re-assertion rather than to block outright.

It inspects steps that are new or whose text changed, since a wrapped step carries its owner tag on a continuation line, and a first-line-only newness test would miss an edit there. The older content lint still looks only at new steps. Unlike the migration-state guard, `PLANGATE_LINT_DISABLED=1` does cover this one, because it's a phrasing tripwire on a single common fingerprint rather than a data-loss guard.

## hooks/codex/plan-gate-pilot.js

Installed as `~/.codex/scripts/plan-gate.js`, wired for `apply_patch` `PreToolUse`/`PostToolUse` plus `Bash` `PreToolUse`.

### Scope tracking

It snapshots declared patch paths, then assesses their disk delta after the tool runs, and emits one nonblocking `systemMessage` after three distinct unstamped source paths or a deleted `## Migration State` block.

### Attribution guard (Codex)

Before snapshotting, a narrow exact simulation of single-file structured `apply_patch` Update File hunks denies once when a new or changed unchecked `## Plan` step's `(main: <reason>)` tag reads as a claim about what the user did or asked. The denial timestamp is stored in the existing session-and-cwd scope record before the denial completes: concurrent first calls deny, while an aged, intentional retry passes.

Multi-file patches, ambiguous context, fuzzy-only or unsupported patch syntax, unreadable state, and path failures all fail open. `PLANGATE_LINT_DISABLED=1` disables this attribution check.

### Mutation gate (Codex)

The same session state counts allowed mutation kinds from the closed set `git push`, `gh pr create`, `gh pr merge`. The second distinct kind is denied before execution until a valid new unchecked `## Plan` item, written through `apply_patch`, stamps the session. Denied kinds are not recorded, so a bare retry is denied again.

### State handling

It rejects symlinked paths, retains text only for `tasks/todo.md`, and stores other paths as hashes; it stops retaining source paths once it warns. Missing or malformed state fails open; completed transaction state is removed, and stale state is bounded by pruning.
