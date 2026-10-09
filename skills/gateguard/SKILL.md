---
name: gateguard
description: Use before editing an unfamiliar file, fixing a bug in an existing codebase, or when AI edits keep breaking callers or mis-assuming data formats. Demands concrete facts (importers/callers, blast radius, real data schemas, the user's verbatim instruction) on the first edit to a file each session instead of letting the model guess. A PreToolUse hook backs this on all three harnesses, warning by default on Claude and Codex and blocking by default on Copilot (GATEGUARD_DENY, GATEGUARD_WARN, GATEGUARD_DISABLED env vars tune it). Not for task-tracking files or similar scratch files, which the hook already exempts.
---

# GateGuard: Investigate Before You Edit

Self-evaluation doesn't work: ask a model "are you sure?" and the answer is
always "yes". Asking for *concrete facts* does work: "list every file that
imports this module" forces a real search, and the investigation itself
changes the edit that follows.

Adapted from the ECC `gateguard` skill. The protocol below is
harness-agnostic; installs also get a `PreToolUse` hook (`gateguard.js`) on
all three harnesses that re-injects it (see the end).

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
5. **Scope**: is this part of a 3+ step or architectural task? If so, point
   to the .tasks/todo.md plan (or invoke plan-and-track first). If this edit
   doesn't need one, say why.

Before **creating a new file**:

1. Name the file(s) and line(s) that will call the new file.
2. Confirm no existing file already serves the same purpose (search first).
3. Same data-schema check as above, if applicable.
4. Quote the user's current instruction verbatim.

Present the facts, then make the edit. Files you've already gated this
session don't need re-gating on later edits.

Gathering these facts (importers, blast radius, schemas) is researcher-tier
work: where the tiered subagent roster is available, that investigation can
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
- **Gating trivia**: task-tracking files (`.tasks/todo.md`,
  `.tasks/lessons.md`) and similar scratch files have no importers or schemas;
  don't burn a round-trip on them.

## Enforcing hook (all three harnesses)

Installs (`./install.sh <target>`, or `install.ps1 <target>` on Windows)
register a `PreToolUse` hook running the same shared `gateguard.js` script on
every harness; the script detects each harness's wire dialect at runtime.
Claude Code's wiring matches Edit/Write/MultiEdit/NotebookEdit and Codex's
matches `apply_patch`; Copilot's hook contract has no matcher, so the script
filters for edit tools itself. On the **first edit to each file per
session**, it injects the fact demand above: as a non-blocking warning by
default on Claude and Codex, as a blocking deny by default on Copilot. Either
way the file is marked at that moment, so a later edit of the same file in the
same session is never gated again.

Skipped automatically: subagent tool calls, `.claude/settings*.json` (so hook
repair is never blocked), and `.tasks/todo.md` / `.tasks/lessons.md`.

Env vars: `GATEGUARD_DISABLED=1` turns the gate off; `GATEGUARD_WARN=1`
forces the non-blocking warning; `GATEGUARD_DENY=1` forces the blocking deny
(wins if both are set); `GATEGUARD_EXEMPT_GLOBS` (comma-separated globs)
exempts paths (`*` matches within a path segment, `**` across);
`GATEGUARD_FULL_DENIALS` (default 3) sets how many firings per session carry
the full fact block. Full details are in the header comment of the installed
script: `~/.claude/scripts/gateguard.js` (`~/.codex/scripts/` or
`~/.copilot/scripts/` on the other harnesses).

Copilot's PreToolUse contract is fail-closed, so the script's failure path
emits an explicit allow decision there; Claude Code and Codex share the same
hook payload shape. All three harnesses also carry the
investigate-before-editing rule through the always-on instruction file
(`rules/agent-guidelines.md`), not the rules digest, so this hook and the
instruction file are its only delivery paths.

Warn is the default on Claude and Codex, deny on Copilot (no soft-warn
channel there). The maintainer rationale and measurements live in the
agent-plan-and-track repo's `docs/hooks.md`: context only, nothing to act on.
