---
name: gateguard
description: Fact-forcing gate for file edits. Before the first edit to any file in a session, present concrete investigation (importers/callers, affected API, real data schemas, the user's verbatim instruction) instead of guessing. Use when editing unfamiliar files, fixing bugs in an existing codebase, or when AI edits keep breaking callers or mis-assuming data formats. Claude Code installs enforce this with a PreToolUse hook.
---

# GateGuard: Investigate Before You Edit

Self-evaluation doesn't work: ask a model "are you sure?" and the answer is
always "yes". Asking for *concrete facts* does work: "list every file that
imports this module" forces a real search, and the investigation itself
changes the edit that follows.

Adapted from the ECC `gateguard` skill. The fact protocol below is
harness-agnostic guidance; Claude Code installs additionally get an enforcing
`PreToolUse` hook (`gateguard.js`): see the end.

## The protocol

Before the **first edit to any file in a session**, present these facts:

1. **Importers/callers**: list the files that import, require, or call this
   one (search the tree; don't recite from memory).
2. **Blast radius**: the public functions/classes/exports this change
   affects.
3. **Data schemas**: if the file reads or writes data, show the real field
   names, structure, and date/number formats (use redacted or synthetic
   values, never raw production data).
4. **The instruction**: quote the user's current instruction verbatim.

Before **creating a new file**:

1. Name the file(s) and line(s) that will call the new file.
2. Confirm no existing file already serves the same purpose (search first).
3. Same data-schema check as above, if applicable.
4. Quote the user's current instruction verbatim.

Present the facts, then make the edit. Files you've already gated this
session don't need re-gating on later edits.

Gathering these facts (importers, blast radius, schemas) is researcher-tier
work: where this repo's tiered subagents are available, that investigation can
be delegated per [[efficient-frontier]] and the returned evidence presented
here.

## Why the schema check matters

The canonical failure: assuming ISO-8601 dates when the real data uses
`%Y/%m/%d %H:%M`. Reading one real (redacted) record before editing prevents
that entire class of bug. Guessing a schema is never faster than looking.

## Anti-patterns

- **Self-evaluation as a substitute**: "did you check the callers?" always
  gets "yes". Demand the list, not the assurance.
- **Pre-answering from memory**: the value is the *search*, not the prose.
  Run the grep; don't reconstruct importers from recall.
- **Gating trivia**: task-tracking files (`tasks/todo.md`,
  `tasks/lessons.md`) and similar scratch files have no importers or schemas;
  don't burn a round-trip on them.

## Claude Code enforcing hook (Claude-only)

Manual installs (`./install.sh claude`, or `install.ps1 claude` on Windows) register a `PreToolUse` hook on
Edit/Write/MultiEdit/NotebookEdit, `~/.claude/scripts/gateguard.js`, that
**denies the first edit to each file per session** with the fact demand above.
The file is marked at deny time, so the retry (after presenting facts) always
passes: a file can never be denied twice, and the gate can't loop.

Skipped automatically: subagent tool calls, `.claude/settings*.json` (so hook
repair is never blocked), and `tasks/todo.md` / `tasks/lessons.md`.

Tune via environment variables:

- `GATEGUARD_DISABLED=1`: turn the gate off entirely.
- `GATEGUARD_WARN=1`: demote deny to a non-blocking warning (the fact demand
  is injected as context instead of blocking the edit).
- `GATEGUARD_EXEMPT_GLOBS`: comma-separated globs to exempt (e.g.
  `**/generated/**,*.snap`). `*` matches within a path segment, `**` across.
- `GATEGUARD_FULL_DENIALS`: how many denials per session get the full
  fact block before condensing to one line to avoid repetitive context
  (default 3).

Copilot and Codex have no tool-deny event, so they rely on the protocol above
plus the investigate-before-editing line in the rules digest.

Deliberately not ported from ECC: the destructive-Bash and routine-Bash gates; Claude Code's own permission system already covers destructive commands,
and a once-per-session gate on the first Bash call is friction without signal.
