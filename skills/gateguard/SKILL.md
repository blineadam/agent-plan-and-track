---
name: gateguard
description: Use before editing an unfamiliar file, fixing a bug in an existing codebase, or when AI edits keep breaking callers or mis-assuming data formats. Demands concrete facts (importers/callers, blast radius, real data schemas, the user's verbatim instruction) on the first edit to a file each session instead of letting the model guess. A PreToolUse hook backs this on all three harnesses, warning by default on Claude and Codex and blocking by default on Copilot (GATEGUARD_DENY, GATEGUARD_WARN, GATEGUARD_DISABLED env vars tune it). Not for task-tracking files or similar scratch files, which the hook already exempts.
---

# GateGuard: Investigate Before You Edit

Self-evaluation doesn't work: ask a model "are you sure?" and the answer is
always "yes". Asking for *concrete facts* does work: "list every file that
imports this module" forces a real search, and the investigation itself
changes the edit that follows.

Adapted from the ECC `gateguard` skill. The fact protocol below is
harness-agnostic guidance; installs additionally get a `PreToolUse` hook
(`gateguard.js`) on all three harnesses that re-injects it as a reminder (a
blocking gate on Copilot): see the end.

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
   to the tasks/todo.md plan (or invoke plan-and-track first). If this edit
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
- **Gating trivia**: task-tracking files (`tasks/todo.md`,
  `tasks/lessons.md`) and similar scratch files have no importers or schemas;
  don't burn a round-trip on them.

## Enforcing hook (all three harnesses)

Installs (`./install.sh <target>`, or `install.ps1 <target>` on Windows)
register a `PreToolUse` hook running the same shared `gateguard.js` script on
every harness; the script detects each harness's wire dialect at runtime.
Claude Code's wiring matches Edit/Write/MultiEdit/NotebookEdit and Codex's
matches `apply_patch`; Copilot's hook contract has no matcher, so the script
filters for edit tools itself. On the **first edit to each file per
session**, it injects the fact demand above: as a non-blocking warning by
default on Claude and Codex, as a blocking deny by default on Copilot (see
Why the default is warn, below). Either way the file is marked at that
moment, so a later edit of the same file in the same session is never
gated again.

Skipped automatically: subagent tool calls, `.claude/settings*.json` (so hook
repair is never blocked), and `tasks/todo.md` / `tasks/lessons.md`.

Tune via environment variables:

- `GATEGUARD_DISABLED=1`: turn the gate off entirely.
- `GATEGUARD_WARN=1`: use the non-blocking warning (the fact demand is
  injected as context instead of blocking). Already the default on Claude
  and Codex; on Copilot this explicitly opts into warn, which there means
  allow plus a stderr note (see below).
- `GATEGUARD_DENY=1`: use the blocking deny instead. Already the default on
  Copilot. If both `GATEGUARD_DENY=1` and `GATEGUARD_WARN=1` are set, deny
  wins.
- `GATEGUARD_EXEMPT_GLOBS`: comma-separated globs to exempt (e.g.
  `**/generated/**,*.snap`). `*` matches within a path segment, `**` across.
- `GATEGUARD_FULL_DENIALS`: how many firings per session get the full
  fact block before condensing to one line to avoid repetitive context
  (default 3).

Copilot's PreToolUse contract is fail-closed, so the script's failure path
emits an explicit allow decision there; Claude Code and Codex share the same
hook payload shape. All three harnesses also carry the
investigate-before-editing rule through the always-on instruction file
(`rules/agent-guidelines.md`), not the rules digest: the digest deliberately
drops it, leaving this hook and the instruction file as its only delivery
paths (see AGENTS.md's rule-delivery section).

### Why the default is warn

The hook used to deny the first edit and mark the file "checked" at the
moment of denial, so the retry that followed always passed; the gate had no
way to confirm the demanded facts were actually presented; it could only
observe a second tool call. Two data points, neither of which is a direct
warn-versus-deny comparison:

- Of 1,282 real firings recorded across 167 local sessions, 12 were actually
  classified, spread across 8 projects; none of those 12 showed the demanded
  investigation changing the resulting edit. The remaining firings were never
  classified, so this is a small spot-check, not a full-corpus finding.
- A controlled A/B (4 runs per arm, one fixture, Sonnet) compared blocking
  gateguard against gateguard turned off entirely, not warn against deny.
  The blocking loop cost about 20% more turns and 18% more dollars than the
  off arm, and still produced an identical edit in 4 of 4 runs per arm.

Ceiling caveat: the control arm (hook off) never failed either, so the A/B
measures the blocking loop's cost on a task it could pass without the hook,
and shows no benefit there; it cannot rule out a benefit on a task hard
enough for the control arm to fail. It never measured warn mode at all, so it
doesn't show warn matches deny's accuracy, only that deny's extra cost wasn't
earned back on this one task. One task, one model, not a general verdict on
fact-forcing. Copilot keeps deny by default because its PreToolUse has no
soft-warn channel: a warn default there would make the hook silently do
nothing.

Deliberately not ported from ECC: the destructive-Bash and routine-Bash gates; Claude Code's own permission system already covers destructive commands,
and a once-per-session gate on the first Bash call is friction without signal.
