---
name: strategic-compact
description: Decide when to manually compact context at logical task boundaries instead of relying on arbitrary auto-compaction. Use during long or multi-phase sessions (research → plan → implement → test), when switching between unrelated tasks, after a milestone, after abandoning a failed approach, or when responses degrade under context pressure.
---

# Strategic Compact

Compact context (`/compact`, or your harness's equivalent) at *logical*
boundaries rather than letting auto-compaction fire mid-task. This is the
active-decision companion to the **Checkpoint & Compact** standing rule.

Adapted from the ECC `strategic-compact` skill. The guidance below is
harness-agnostic. Claude Code installs additionally get an auto-suggest hook
(`suggest-compact.js`) that nudges you at token thresholds — see the end.

## Why manual beats auto

Auto-compaction triggers at arbitrary points — often mid-task, with no awareness
of task boundaries, so it can drop the file paths, variable names, and partial
state you still need. Compacting deliberately at a boundary keeps the distilled
output (the plan, the milestone) and sheds only the bulk you're done with.

## Compaction decision guide

| Phase transition | Compact? | Why |
| --- | --- | --- |
| Research → planning | Yes | Research context is bulky; the plan is the distilled output |
| Planning → implementation | Yes | Plan lives in `tasks/todo.md`; free the window for code |
| Implementation → testing | Maybe | Keep if tests reference recent code; compact if focus shifts |
| Debugging → next feature | Yes | Debug traces pollute context for unrelated work |
| Mid-implementation | **No** | Losing variable names, paths, and partial state is costly |
| After a failed approach | Yes | Clear the dead-end reasoning before trying a new one |

## What survives compaction

| Persists | Lost |
| --- | --- |
| Instruction files (CLAUDE.md / AGENTS.md / copilot-instructions.md) | Intermediate reasoning and analysis |
| `tasks/todo.md` and `tasks/lessons.md` on disk | File contents you previously read |
| Git state (commits, branches) | Tool-call history |
| Anything written to a file | Preferences stated only in chat |

The rule follows from the table: **write before you compact.** Checkpoint state
to `tasks/todo.md` (and capture any correction via `capture-lesson`) first, then
compact — nothing important should live only in the conversation.

## Best practices

1. **Compact after planning** — once the plan is in `tasks/todo.md`, start fresh for the build.
2. **Compact after debugging** — clear error-resolution context before moving on.
3. **Don't compact mid-implementation** — preserve context for related edits.
4. **You decide *if*** — a suggestion tells you *when*; the call is yours.
5. **Compact with a summary** — e.g. `/compact Focus on the auth middleware next`.
6. **`/compact` is user-run** — an agent can suggest it but can't trigger it.

## Claude Code auto-suggest hook (Claude-only)

Manual installs (`./install.sh claude`) also register a `PreToolUse` (Edit/Write)
hook, `~/.claude/scripts/suggest-compact.js`, that reads the session transcript's
latest context size and nudges you toward `/compact` at a window-scaled
threshold — plus a tool-call-count fallback. It only ever adds a one-line
suggestion; it never blocks a tool call.

Tune via environment variables:

- `COMPACT_THRESHOLD` — tool calls before the first count-based nudge (default 50; then every 25).
- `COMPACT_CONTEXT_THRESHOLD` — context tokens before the size-based nudge (default 160000 on a 200k window, 250000 on 1M; `0` disables it).
- `COMPACT_CONTEXT_INTERVAL` — extra tokens of growth before it re-nudges (default 60000).

Copilot and Codex don't get this hook (their harnesses don't expose the same
transcript/`/compact` mechanics) — the decision guide above is the portable part.
