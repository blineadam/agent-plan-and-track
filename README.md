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

## When this actually gets used

**`plan-and-track`** triggers on multi-step engineering work: implementing a
feature, a refactor, or a fix with 3+ dependent steps or an architectural
decision, resuming a project that already has a `tasks/todo.md`, work going
sideways mid-task, or an explicit "plan/scope/spec this out" ask. This is
common — most non-trivial coding sessions hit it at least once.

**`capture-lesson`** triggers on any user correction: a rejected approach, a
bug you introduced, a misread requirement, a workflow preference you missed.
Frequency scales with how often you correct course, not with codebase size —
sessions with zero corrections never touch it.

**Good for**: iterative engineering work in a repo — features, bug fixes,
refactors, multi-file changes — where a durable plan and a growing lessons
file pay off across a session or across resumed sessions.

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
  `~/.copilot/copilot-instructions.md`) get the repo content inside a
  marker-delimited **managed block** (`<!-- agent-plan-and-track:begin -->` …
  `<!-- agent-plan-and-track:end -->`). Re-installs update only that block;
  anything you add outside the markers is never touched. An existing file
  *without* markers is left alone entirely.
- **Hooks** are merged via `jq` (Claude/Codex) only when not already installed;
  the Copilot hook file is repo-owned and kept in sync (differing copy backed
  up to `*.bak`).

Requires `jq` (install-time for Claude/Codex, runtime for the Copilot hook).

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

## Updating

```sh
cd agent-plan-and-track
git pull
./install.sh all
```

That propagates skills, the digest, instruction managed blocks, and the Copilot
hook. The one thing it won't rewrite is a hook already merged into
`~/.claude/settings.json` or `~/.codex/hooks.json` — if a repo update ever
changes those hook *commands*, delete the old entry and re-run the installer.

## Machine-specific rules

Two customization points survive every update:

- **`core-rules.local.md`** next to each tool's `core-rules.md` (e.g.
  `~/.claude/core-rules.local.md`) — extra digest lines for this machine
  (Python venvs, local paths). The hooks concatenate it after the shared
  digest; the installer never touches it.
- **Anything outside the managed block** in the instruction files — e.g. a
  `## Python Environment` section below the end marker.

## Per-tool details

### Claude Code (`~/.claude`)

- Instructions: `~/.claude/CLAUDE.md` (loaded every session, re-injected after compaction).
- Skills: `~/.claude/skills/<name>/SKILL.md`.
- Hook: `UserPromptSubmit` in `~/.claude/settings.json` — `cat`s the digest, so
  its stdout is injected as context **every turn**. Editing
  `~/.claude/core-rules.md` takes effect immediately; no restart needed.
- Verify: start a session, send a few messages, then ask *"what are your
  standing rules?"*
- Attribution: set `"includeCoAuthoredBy": false` in `~/.claude/settings.json`
  to stop Claude Code appending the `Co-Authored-By: Claude` trailer and the
  "Generated with Claude Code" footer at the source (default `true`). The core
  rule stays the cross-tool backstop.

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
- Attribution: set `"includeCoAuthoredBy": false` in `~/.copilot/settings.json`
  to stop the Copilot CLI adding a `Co-authored-by: Copilot` trailer (default
  `true`).

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
- Accept: Run `codex` in a terminal and `2` to accpet all new hooks.
- Verify: new codex session, a few messages in, ask for its standing rules.
- Attribution: nothing to set — current Codex builds add no co-author or
  "generated with" trailer, and the old `commit_attribution` config key was
  removed upstream (May 2026). The core rule is the backstop; leaving
  `commit_attribution = ""` in `~/.codex/config.toml` is harmless on older
  builds that still read it.

## Managing your rules

This repo is the source of truth. To change a rule:

1. Edit `rules/core-rules.md` (the digest) and/or `rules/agent-guidelines.md`.
2. Re-run `./install.sh all`.
3. Copilot/Codex instructions: restart sessions. Digest changes (Claude, Codex,
   Copilot hooks read the file at fire time): take effect immediately.

To add a new skill: create `skills/<name>/SKILL.md` with `name:` and
`description:` frontmatter (the description tells the agent *when* to use it),
add a `cp` line for it in `copy_skills()` in `install.sh`, and re-install.
