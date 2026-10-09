---
name: strategic-compact
description: Decide when to manually compact context at logical task boundaries instead of relying on arbitrary auto-compaction. Use when asked whether now is a good moment to compact, clear out, or reset context, at a phase boundary (just finished research, planning, or debugging; about to start the next phase), when switching between unrelated tasks, after a milestone or an abandoned approach, when a long session or a big task is wrapping up, or when responses degrade under context pressure. Not for auditing always-on config cost; that's context-budget.
---

# Strategic Compact

Compact at logical boundaries, not mid-task. Compaction keeps files on disk and
drops what lived only in the conversation, so write state down first.

## Before compacting or stopping

Write the current state (what's done, what's next, open decisions) to
`.tasks/todo.md`, and capture any correction via `capture-lesson`. Do this on
every harness: Codex and Copilot have no hook that creates this moment, so this
skill alone carries it. It applies when a long session or task is wrapping up
even if nobody compacts.

## When to compact

Suggest `/compact` at a phase boundary (research or debugging done, plan
settled, an approach abandoned, switching to unrelated work), never
mid-implementation, where paths, variable names, and partial state get lost.
`/compact` is user-run: suggest it, with a focus line such as
`/compact Focus on the auth middleware next`, rather than trying to run it.

## What survives

Files on disk (instruction files, `.tasks/todo.md`, `.tasks/lessons.md`,
anything written) and git state survive. File contents you read, tool history,
intermediate reasoning, and preferences stated only in chat do not.

## Claude Code hook

Claude installs also register `~/.claude/scripts/suggest-compact.js`, which
nudges when real context size passes a window-scaled threshold. Tune with
`COMPACT_CONTEXT_THRESHOLD` (`0` disables) and `COMPACT_CONTEXT_INTERVAL`;
defaults are in the installed header.
