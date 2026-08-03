# Installers reference

How `install.sh` and `install.ps1` deploy this repo into each harness, and the idempotency rules they hold to.

## Overview

Two installers are kept in lockstep: `install.sh` (bash + jq, macOS/Linux) and `install.ps1` (PowerShell 5.1, jq-free, Windows). Each has three targets (`install_claude` / `Install-Claude`, and so on for Codex and Copilot).

Both share a common set of helper functions:

- `copy_skills`
- `install_digest`
- `install_instructions`
- `write_back`
- `render_hook`

A parity note in both file headers lists the managed surface that must be mirrored: change one installer, change the other. Idempotent re-runs re-assert the repo's intended state without clobbering user content, in the ways described below.

## Skills

Skills are repo-owned and copied with `cp -R` into the existing destination. This overwrites matching files but never removes user-added files sharing the same directory.

A reinstall also prunes repo-owned copies whose source left the repo, tracked per-directory by a `.plan-and-track-manifest`. A name the manifest recorded last time, but that the current install no longer produces, is quarantined into a `.plan-and-track-pruned/` dot-attic: moved, not deleted, since a user could have installed their own content at a formerly repo-owned name that git can't restore. Because of that manifest scoping:

- Only manifest-recorded names are ever touched.
- A name the manifest never recorded (a user-added skill, an office skill) is never pruned.
- A missing manifest prunes nothing.
- Pruning is direct-children only: a renamed file inside a still-installed skill directory, or a stale hook script under the scripts directory, is out of scope.

`NON_COPILOT_SKILLS` in `install.sh` lists the skills omitted from Copilot (currently `skill-comply`), so those install to Claude and Codex only; everything else under `skills/` installs to all three harnesses.

Subagents (`agents/*.md`) are repo-owned too, but each harness gets them differently:

- `install_claude` copies each file verbatim into `~/.claude/agents/` via `copy_agents`.
- `install_codex` renders each one into a native `~/.codex/agents/<name>.toml`.
- `install_copilot` renders each one into a native `~/.copilot/agents/<name>.agent.md`.

The Codex and Copilot rendering formats are covered next.

## Subagents

### Codex

Codex subagents are rendered, not copied: each `agents/*.md`'s frontmatter and body map onto Codex's own TOML subagent format.

- Required fields: `name`, `description`, `developer_instructions`.
- Optional fields: `model`, `model_reasoning_effort`, `sandbox_mode`.

The current compatibility mapping for `model`:

| Source model | Rendered as |
| --- | --- |
| `fable` / `opus` | `gpt-5.6-sol` |
| `sonnet` | `gpt-5.6-terra` |
| `haiku` | `gpt-5.6-luna` |

`model_reasoning_effort` carries over 1:1 from `effort`. `sandbox_mode` is `workspace-write` if `tools` includes Edit or Write, else `read-only`. Other Codex config, including `[features]`, remains user-owned.

### Copilot

Copilot subagents are rendered too: each `agents/*.md`'s frontmatter and body map onto Copilot's own custom-agent Markdown format at `~/.copilot/agents/<name>.agent.md`, fenced YAML frontmatter with `name`, a double-quoted `description`, and `tools` as a YAML flow array; the body is unchanged below.

`tools` maps through a closed alias table, deduped in first-occurrence order:

| Source tool(s) | Copilot alias |
| --- | --- |
| `Read` | `read` |
| `Grep` / `Glob` | `search` |
| `Edit` / `Write` / `MultiEdit` | `edit` |
| `Bash` | `execute` |
| `WebFetch` / `WebSearch` | `web` |

An unknown source tool name is warned to stderr and dropped, rather than aborting the install.

`model` is deliberately left unset, and `effort` is dropped entirely, since Copilot's agent frontmatter has no matching fields. On Copilot, the tier distinction shows up only as tool permissions.

## Instruction files

Instruction files get the repo content inside a marker-delimited managed block, from `<!-- agent-plan-and-track:begin (managed block: edit in the repo, not here) -->` to `<!-- agent-plan-and-track:end -->` (`install.sh` matches the begin marker by prefix).

Content a user adds outside the markers survives re-installs. A file without markers at all is left alone entirely.

## Hook wiring

Hook *scripts* are copied into each harness's scripts directory, with per-harness scopes:

- `core-rules-digest.js` and `gateguard.js` go to all three harnesses.
- `delivery-gate.js` goes to Claude and Codex.
- Claude and Codex each get their own separate `plan-gate.js` implementation.

Codex uses an `apply_patch` disk-delta stamp because its installed skills don't produce Claude's Skill-tool invocation stamp; its scope and migration checks remain warn-only while its Bash mutation gate blocks.

Hook *wiring* commands are templates carrying a `__SCRIPTS__` placeholder that both installers substitute with the resolved absolute scripts directory at install time. This is baked forward-slashed, so no `$HOME`/`%USERPROFILE%` expansion runs at hook time, which is what Claude Code's Windows hook-resolution bugs mishandle.

The wiring is merged in only if not already present, for Claude (`settings.json`) and Codex (`hooks.json`); the digest idempotency check matches `core-rules`, covering both the new command and any pre-existing inline one. A hook wired as more than one entry, such as Claude's `plan-gate.js` (two PreToolUse entries) or Codex's `plan-gate-pilot.js` (an `apply_patch` PreToolUse entry, a Bash PreToolUse entry, and an `apply_patch` PostToolUse entry), is checked and repaired per exact entry: an install missing just one gets only that one appended, never a duplicate of the entries still present.

Copilot's own hook files (`core-rules.json`, `pretooluse-gateguard.json`) are instead repo-owned and overwritten outright, with a `.bak` backup taken if the existing file differed.

## Model and permission defaults

### Model defaults

Model defaults are repo-owned and overwritten on each install unless `PT_KEEP_MODEL=1`:

- Claude: `opusplan` + `switchModelsOnFlag`.
- Copilot: `auto`.

Codex's plan-mode reasoning effort is separate and always overwritten regardless of `PT_KEEP_MODEL`, which covers model settings only.

### Permission posture

Claude's permission posture is opt-in and never changes on a bare install. `PT_BYPASS_PERMISSIONS=1` sets `permissions.defaultMode` to `bypassPermissions` and `skipDangerousModePermissionPrompt` to `true`; leaving the variable unset is the opt-out, so a pre-existing stricter `defaultMode` survives a re-install untouched. `PT_KEEP_MODEL` does not cover these two keys.

Separately, `enabledPlugins["frontend-design@claude-plugins-official"]` is set to `false` unconditionally on every install: this repo ships its own `frontend-design` skill, and the plugin bundles a second skill of the same name, which is a routing collision.
