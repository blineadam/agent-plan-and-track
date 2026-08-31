# Installers reference

How `install.sh` and `install.ps1` deploy this repo into each harness, and the
idempotency rules they hold to.

## Overview

Two installers are kept in lockstep: `install.sh` (bash + jq, macOS/Linux)
and `install.ps1` (PowerShell 5.1, jq-free, Windows). Each has three targets:
`install_claude` / `Install-Claude`, and the corresponding pairs for Codex
and Copilot.

Both share a common set of helper functions:

- `copy_skills`
- `install_digest`
- `install_instructions`
- `write_back`
- `render_hook`

A parity note in both file headers lists the managed surface that must be
mirrored. Change one installer, change the other. Idempotent re-runs re-assert
the repo's intended state without clobbering user content, as described below.

## Dependencies

`install.sh` requires Node.js (checked before any files are written) and `jq`
for the Claude and Codex targets; Copilot has no jq dependency. `install.ps1`
requires only PowerShell 5.1, with no jq dependency to mirror.

When `jq` is missing, `install.sh` offers to install it through the platform's
package manager, probed in this order:

| Manager | Command | Sudo-gated |
| --- | --- | --- |
| `brew` | `brew install jq` | No (user-scoped) |
| `apt-get` | `apt-get update && apt-get install -y jq` | Yes, unless root |
| `dnf` | `dnf install -y jq` | Yes, unless root |
| `yum` | `yum install -y jq` | Yes, unless root |
| `pacman` | `pacman -S --noconfirm jq` | Yes, unless root |
| `zypper` | `zypper --non-interactive install jq` | Yes, unless root |
| `apk` | `apk add --no-cache jq` | Yes, unless root |

An interactive run (connected to a TTY) prompts the user for confirmation
before installing. A non-interactive run (piped shell or CI) requires
`PT_INSTALL_JQ=1` to authorize the install; without it, the script exits with
an error and no changes made to the system. If no supported package manager is
found, the installer also exits with an error, leaving the user to install `jq`
by hand.

## Skills

Skills are repo-owned and copied with `cp -R` into the existing destination.
This overwrites matching files but never removes user-added files sharing the
same directory.

A reinstall also prunes repo-owned copies whose source left the repo, tracked
per directory by a `.plan-and-track-manifest`. A name recorded by the previous
manifest but absent from the current install is moved to the
`.plan-and-track-pruned/` dot-attic.

The entry is moved, not deleted, because a user could have installed their own
content under a formerly repo-owned name that git cannot restore. The manifest
keeps pruning narrow:

- Only manifest-recorded names are ever touched.
- A name the manifest never recorded (a user-added skill, an office skill) is never pruned.
- A missing manifest prunes nothing.
- Pruning is direct-children only. A renamed file inside a still-installed
  skill directory, or a stale hook script under the scripts directory, is out
  of scope.

`NON_COPILOT_SKILLS` in `install.sh` lists the skills omitted from Copilot,
currently `skill-comply`. Those install to Claude and Codex only. Everything
else under `skills/` installs to all three harnesses.

Subagents (`agents/*.md`) are repo-owned too, but each harness gets them differently:

- `install_claude` copies each file verbatim into `~/.claude/agents/` via `copy_agents`.
- `install_codex` renders each one into a native `~/.codex/agents/<name>.toml`.
- `install_copilot` renders each one into a native `~/.copilot/agents/<name>.agent.md`.

The Codex and Copilot rendering formats are covered next.

## Subagents

### Codex

Codex subagents are rendered, not copied. Each `agents/*.md` file's
frontmatter and body map onto Codex's TOML subagent format.

- Required fields: `name`, `description`, `developer_instructions`.
- Optional fields: `model`, `model_reasoning_effort`, `sandbox_mode`.

The current compatibility mapping for `model`:

| Source model | Rendered as |
| --- | --- |
| `fable` / `opus` | `gpt-5.6-sol` |
| `sonnet` | `gpt-5.6-terra` |
| `haiku` | `gpt-5.6-luna` |

`model_reasoning_effort` carries over 1:1 from `effort`. `sandbox_mode` is
`workspace-write` if `tools` includes Edit or Write, otherwise it is
`read-only`. Other Codex config, including `[features]`, remains user-owned.

### Copilot

Copilot subagents are rendered too. Each `agents/*.md` file's frontmatter and
body map onto Copilot's custom-agent Markdown format at
`~/.copilot/agents/<name>.agent.md`. The rendered file has fenced YAML
frontmatter with `name`, a double-quoted `description`, and `tools` as a YAML
flow array. The body below it is unchanged.

`tools` maps through a closed alias table, deduped in first-occurrence order:

| Source tool(s) | Copilot alias |
| --- | --- |
| `Read` | `read` |
| `Grep` / `Glob` | `search` |
| `Edit` / `Write` / `MultiEdit` | `edit` |
| `Bash` | `execute` |
| `WebFetch` / `WebSearch` | `web` |

An unknown source tool name is warned to stderr and dropped, rather than aborting the install.

`model` is deliberately left unset, and `effort` is dropped because Copilot's
agent frontmatter has no matching fields. On Copilot, the tier distinction
shows up only as tool permissions.

## Instruction files

Instruction files get the repo content inside a marker-delimited managed
block, from
`<!-- agent-plan-and-track:begin (managed block: edit in the repo, not here) -->`
to `<!-- agent-plan-and-track:end -->`. `install.sh` matches the begin marker
by prefix.

Content a user adds outside the markers survives re-installs. A file without
markers at all is left alone entirely.

## Hook wiring

Hook *scripts* are copied into each harness's scripts directory, with per-harness scopes:

- `core-rules-digest.js`, `gateguard.js`, and `git-guard.js` go to all three harnesses.
- `delivery-gate.js` goes to Claude and Codex.
- Claude and Codex each get their own separate `plan-gate.js` implementation.

Codex uses an `apply_patch` disk-delta stamp because its installed skills do
not produce Claude's Skill-tool invocation stamp. Its scope and migration
checks remain warn-only, while its Bash mutation gate blocks.

Hook *wiring* commands are templates carrying a `__SCRIPTS__` placeholder.
Both installers replace it with the resolved absolute scripts directory at
install time. The path is baked with forward slashes, so no
`$HOME`/`%USERPROFILE%` expansion runs at hook time. This avoids Claude Code's
Windows hook-resolution bugs.

Claude and Codex merge wiring only when it is not already present:

- Claude writes to `settings.json`.
- Codex writes to `hooks.json`.
- The digest idempotency check matches `core-rules`, covering the current
  command and any pre-existing inline command.

Most single-entry hooks (`suggest-compact.js`, `delivery-gate.js`,
`gateguard.js`) check idempotency with a coarse whole-file match on the hook's
script name. `plan-gate.js`/`plan-gate-pilot.js` and `git-guard.js` check
per-entry instead (matcher + command, not a whole-file grep or
`.Contains(...)`), because a coarse whole-file match can be fooled by any
other occurrence of the name elsewhere in the file, for example a user
permission-allowlist entry naming the script path, which would silently leave
the actual hook entry missing after it was deleted while install still prints
success.

Hooks with multiple wiring entries are checked and repaired one entry at a
time:

- Claude's `plan-gate.js` has two `PreToolUse` entries.
- Codex's `plan-gate-pilot.js` has a startup-or-resume `SessionStart` entry, an
  `apply_patch` `PreToolUse` entry, a Bash `PreToolUse` entry, and an
  `apply_patch` `PostToolUse` entry.

If one entry is missing, the installer appends only that entry. It never
duplicates the entries still present.

Copilot's hook files (`core-rules.json`, `pretooluse-gateguard.json`,
`pretooluse-git-guard.json`) are repo-owned and overwritten outright. The
installer takes a `.bak` backup if the existing file differs.

## Managed and permission defaults

### Managed defaults

Model, output-style, and artifact defaults are repo-owned and overwritten on
each install unless `PT_KEEP_MODEL=1`:

- Claude: `opusplan` + `switchModelsOnFlag` + `outputStyle: Concise` (requires
  Claude Code v2.1.237 or later) + `enableArtifact: false`.
- Copilot: `auto`.

`enableArtifact: false` turns off the Artifact tool, which publishes HTML pages
to claude.ai. The
[settings reference](https://code.claude.com/docs/en/settings-reference#enableartifact)
describes the key as turning the tool off with a `false` in any file, with no
file turning it back on, so re-enabling means setting this same key to `true`
and installing with `PT_KEEP_MODEL=1`. The precedence-exceptions table in
[the settings guide](https://code.claude.com/docs/en/settings) adds that
overriding a managed `true` this way requires Claude Code v2.1.242 or later.

The context saving is this repo's own observation rather than a documented
guarantee. A headless session started with the key set reports no Artifact tool,
while the same prompt without it reports one, so a session that cannot publish
is not carrying the tool's schema on every turn.

Codex's plan-mode reasoning effort is separate and always overwritten,
regardless of `PT_KEEP_MODEL`, which covers model, output-style, and artifact
settings only.

### Permission posture

Claude's permission posture is opt-in and never changes on a bare install.
`PT_BYPASS_PERMISSIONS=1` sets `permissions.defaultMode` to
`bypassPermissions` and `skipDangerousModePermissionPrompt` to `true`.

Leaving the variable unset is the opt-out, so a pre-existing stricter
`defaultMode` survives a reinstall untouched. `PT_KEEP_MODEL` does not cover
these two keys.

Separately, `enabledPlugins["frontend-design@claude-plugins-official"]` is set
to `false` on every install. This repo ships its own `frontend-design` skill,
and the plugin bundles a second skill with the same name, causing a routing
collision.
