# agent-plan-and-track

Portable, user-scoped agent rules for Claude Code, GitHub Copilot, and Codex:
plan non-trivial work in `tasks/todo.md`, capture corrections in
`tasks/lessons.md`, verify before claiming done — and keep those rules **sticky**
in long sessions instead of fading as the context grows.

## Why this exists

Global instruction files (`CLAUDE.md`, `AGENTS.md`, `copilot-instructions.md`)
sit at the very beginning of the context window. In long chats the model's
attention to them dilutes and it starts "forgetting" your rules. The fix is to
match each kind of rule to the mechanism that keeps it alive:

| Rule type | Mechanism | Why it sticks |
| --- | --- | --- |
| Constant constraints (short) | Instructions file | Always loaded; kept tiny so it isn't diluted by its own bulk |
| Episodic procedures (plan, capture lessons) | **Skills** | Loaded just-in-time at the *recent* end of context, exactly when triggered |
| The core rules themselves | **Hooks** re-injecting a digest | Harness-enforced repetition; immune to attention decay |

## Layout

```text
rules/agent-guidelines.md    the short instructions file (constant constraints)
rules/core-rules.md          one-paragraph digest the hooks re-inject
skills/plan-and-track/       plan → track → verify workflow (tasks/todo.md)
skills/capture-lesson/       turn every user correction into a rule (tasks/lessons.md)
hooks/claude/                Claude Code hook snippet (per-turn injection)
hooks/copilot/               Copilot hook (post-tool-use injection, throttled)
hooks/codex/                 Codex hook (re-inject on resume/compact)
install.sh                   per-tool installer
```

## Install

```sh
git clone https://github.com/blineadam/agent-plan-and-track.git
cd agent-plan-and-track
./install.sh all        # or: claude | copilot | codex
```

The installer is idempotent and non-destructive:

- **Skills** are copied into the tool's user skills dir (this repo is the source of truth).
- **`core-rules.md`** is copied next to the tool's config; a differing existing copy is backed up to `*.bak`.
- **Instruction files** (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
  `~/.copilot/copilot-instructions.md`) are **never modified if they already
  exist** — merge `rules/agent-guidelines.md` into yours manually.
- **Hooks** are merged (Claude/Codex, via `jq`) or copied (Copilot) only when
  not already installed.

Requires `jq` (install-time for Claude/Codex, runtime for the Copilot hook).

## Per-tool details

### Claude Code (`~/.claude`)

- Instructions: `~/.claude/CLAUDE.md` (loaded every session, re-injected after compaction).
- Skills: `~/.claude/skills/<name>/SKILL.md`.
- Hook: `UserPromptSubmit` in `~/.claude/settings.json` — `cat`s the digest, so
  its stdout is injected as context **every turn**. Editing
  `~/.claude/core-rules.md` takes effect immediately; no restart needed.
- Verify: start a session, send a few messages, then ask *"what are your
  standing rules?"*

### GitHub Copilot (`~/.copilot`)

- Instructions: `~/.copilot/copilot-instructions.md` (CLI reads it at **session
  start only** — restart sessions after editing).
- Skills: `~/.copilot/skills/` (Copilot also scans `~/.claude/skills/` and `~/.agents/skills/`).
- Hook: `~/.copilot/hooks/core-rules.json` — Copilot doesn't support context
  injection on prompt-submit, so this rides `postToolUse` (which does support
  `additionalContext`), throttled to once per 10 minutes via a timestamp file
  (`~/.copilot/.core-rules-last`). Change the `600` in the hook to re-tune.
- Verify: new `copilot` session → run something that uses a tool → ask for its
  standing rules.

### Codex (`~/.codex`)

- Instructions: `~/.codex/AGENTS.md` (user-level, loaded once per session and
  concatenated *before* project `AGENTS.md` files — so project instructions win
  on conflict by appearing later in the prompt).
- Skills: `~/.agents/skills/<name>/SKILL.md` — the documented user-scope
  location (`~/.codex/skills/` is legacy). Copilot scans `~/.agents/skills/`
  too, so Codex-installed skills are visible to both.
- Hook: merged into `~/.codex/hooks.json` — a `UserPromptSubmit` hook whose
  stdout is injected as context **every turn**, same as Claude Code. Editing
  `~/.codex/core-rules.md` takes effect immediately.
- Verify: new codex session, a few messages in, ask for its standing rules.

## Managing your rules

This repo is the source of truth. To change a rule:

1. Edit `rules/core-rules.md` (the digest) and/or `rules/agent-guidelines.md`.
2. Re-run `./install.sh all`.
3. Copilot/Codex: restart sessions. Claude Code: takes effect next turn.

To add a new skill: create `skills/<name>/SKILL.md` with `name:` and
`description:` frontmatter (the description tells the agent *when* to use it),
add a `cp` line for it in `copy_skills()` in `install.sh`, and re-install.
