# agent-plan-and-track

Portable, user-scoped agent rules, skills, and hooks for Claude Code, GitHub
Copilot, and Codex. They stay active through a session and carry over into
the next one.

Uses a `tasks/todo.md` to plan non-trivial work, logs your corrections in
`tasks/lessons.md`, and verifies changes before calling anything done.
These rules stay in place even as a session's context grows.

Best for iterative work in an existing repo: features, bug fixes,
refactors, anywhere a persistent plan, a completion gate, and a growing
lessons file pay off over time.

## Why this exists

Global instruction files (`CLAUDE.md`, `AGENTS.md`, `copilot-instructions.md`)
sit at the top of the context window, and in a long chat the model's
attention to them drifts: it starts forgetting your rules. The fix is
matching each kind of rule to a mechanism that keeps it alive:

| Rule type | Mechanism | Why it sticks |
| --- | --- | --- |
| Short, constant constraints | Instructions file | Always loaded and kept short |
| Procedures | **Skills** | Loaded near the end of context when triggered |
| Core rules | **Hooks** re-injecting a digest | Repeated by the harness throughout the session |

This repo checks its own enforcement. `skill-comply` measures whether a rule
is followed, while `skill-activation` measures whether the right skill fires.
Both have caught real gaps in past runs.

Supporting three harnesses accounts for most of the installer's bulk. At
runtime, each session uses only its own harness integration.

## What you get

The skills used most often are:

- `plan-and-track` plans and tracks non-trivial work.
- `gateguard` asks for concrete facts before the first edit to a file.
- `capture-lesson` turns corrections into durable rules.
- `humanizer` cleans up longer user-facing writing before it ships.

Other skills cover autonomous work, docs-first research, maintenance, and
delegation to subagents.

See [docs/skills.md](docs/skills.md) for the full catalog, including the
maintenance and design skills. See [docs/models.md](docs/models.md) for model
defaults, tiered subagents, and per-tool notes.

## Install

The hooks run on Node.js; the installer checks for it before touching
anything. The macOS/Linux installer also needs `jq` for the Claude and
Codex targets (not required for Copilot-only): install it first, since a
missing `jq` is caught partway through rather than up front.

```sh
# to set Claude Code to bypassPermissions and suppress its
# dangerous-mode warning
export PT_BYPASS_PERMISSIONS=1

#checkout and install
git clone https://github.com/blineadam/agent-plan-and-track.git
cd agent-plan-and-track

# macOS/Linux; or: claude | copilot | codex
./install.sh all

# Optional docx, pdf, pptx, and xlsx skills
./install-office-skills.sh
```

On Windows, run the PowerShell installer instead (same targets):

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 all
powershell -ExecutionPolicy Bypass -File install-office-skills.ps1
```

Re-running is safe: each run updates the files this repo manages and leaves
your additions alone. A skill or subagent this repo has renamed or removed is
moved into `.plan-and-track-pruned/` rather than deleted. The exact ownership
rules are in the `install.sh` header.

To update, run `git pull` and reinstall. Tagged releases (`vX.Y.Z` on the
Releases tab) are known-good snapshots you can pin first, for example:

```sh
git checkout <tag>
```

The office skills stay separate for licensing reasons.

### First run in a new project

The installer is per-machine; each project still needs its own context.
Start by generating the harness's project instructions (`CLAUDE.md`, or
`AGENTS.md` on Codex), then capture the repo's conventions:

```text
/init                         # create project instructions
/inherit-legacy-style         # capture conventions in .ai-style-rules.md
/copilot-review-instructions  # on GitHub, teach Copilot those conventions
```

On Codex, invoke the installed skills with `$skill-name` instead of a
slash, or pick them from `/skills`.

## Layout

```text
rules/               portable instruction files and the hook-injected digest
skills/              task procedures; see docs/skills.md for the full catalog
agents/              tiered subagent sources rendered for all three harnesses
hooks/               shared scripts plus Claude, Codex, and Copilot wiring
docs/                skill, model, hook, and installer references
install.sh           macOS/Linux installer
install.ps1          Windows installer
install-office-*     optional office-skill installers
```

## Customizing

Two things survive every update:

- **`core-rules.local.md`** next to each tool's `core-rules.md`: extra
  digest lines just for this machine (venvs, local paths). The installer
  never touches it; the hooks append it after the shared digest.
- **Anything outside the managed block** in an instruction file, like a
  `## Python Environment` section you added below the end marker.

To change a shared rule, edit `rules/core-rules.md` and/or
`rules/agent-guidelines.md` and re-run `./install.sh all`. Digest changes are
live immediately; restart Copilot and Codex sessions for instruction changes.

To add a skill, create `skills/<name>/SKILL.md`. Its `description` tells the
agent when to use it. Reinstall afterward, and add a harness-scope exception
to both installers only when the skill cannot be portable.

For per-harness quirks (how each tool loads the digest, restart
requirements, known caveats), see
[docs/models.md](docs/models.md#per-tool-notes).

## Nightly style refresh

A scheduled workflow keeps this repo's own style artifacts current: it
re-runs `/inherit-legacy-style` and `/copilot-review-instructions` against
`main`, opens a PR with any drift, has Copilot review it, and squash-merges
once the review is addressed. Details are in the header of
[`.github/workflows/nightly-style-refresh.yml`](.github/workflows/nightly-style-refresh.yml).
