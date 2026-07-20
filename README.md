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
| Short, constant constraints | Instructions file | Always loaded; kept tiny so it isn't buried by its own bulk |
| Procedures (plan, capture lessons) | **Skills** | Loaded just-in-time, at the recent end of context, when triggered |
| The core rules themselves | **Hooks** re-injecting a digest | Harness-enforced repetition, immune to attention decay |

The extra weight buys two concrete things. This repo checks its own
enforcement: `skill-comply` measures whether a rule is really followed and
`skill-activation` measures whether the right skill fires, and both have
caught real gaps in past runs. Supporting three harnesses is most of the
installer's bulk and none of the runtime cost: once a session starts, it
doesn't add anything.

## Install

```sh
git clone https://github.com/blineadam/agent-plan-and-track.git
cd agent-plan-and-track
./install.sh all        # macOS/Linux; or: claude | copilot | codex
./install-office-skills.sh   # optional docx, pdf, pptx, xlsx skills, kept separate for licensing reasons
```

On Windows, run the PowerShell installer instead (same targets):

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 all
powershell -ExecutionPolicy Bypass -File install-office-skills.ps1
```

You can safely run the installer again any time. It updates the files this
repo manages and leaves anything you've added yourself alone: skills are
copied straight over since this repo is their source of truth, the digest
and Copilot's own hook files get a `.bak` backup first if they'd changed,
hook wiring is only added where it's missing on Claude and Codex,
instruction files only get their clearly marked managed section touched,
and model settings reset to the repo defaults each run (set
`PT_KEEP_MODEL=1` to keep your own choice). Claude and Codex subagents
stay in sync too.

The macOS/Linux installer needs `jq`; the Windows one doesn't. Both check
for Node.js first, since the hooks need it, and will tell you what to
install if it's missing:

```bash
brew install node
```

```powershell
winget install OpenJS.NodeJS.LTS
```

### Updates

To update, `git pull` and rerun the installer for your OS. It deploys
whatever's checked out, normally the latest `main`, but tagged releases
(`vX.Y.Z`, on the Releases tab) are known-good snapshots you can pin with
`git checkout v1.0.0` first.

### First run in a new project

The installer is per-machine; each project still needs its own context.
The first time you use Claude Code in a new repo, run its built-in
`/init`. Then run `/inherit-legacy-style` (works in Codex, Claude Code, or
Copilot), and `/copilot-review-instructions` too if the project's on
GitHub:

```text
/init                         # generate the project's own CLAUDE.md
/inherit-legacy-style         # capture its implicit conventions in .ai-style-rules.md
/copilot-review-instructions  # if on GitHub: teach Copilot's PR review those conventions
```

## What you get

The skills you'll actually hit every session: `plan-and-track` plans and
tracks non-trivial work, `gateguard` makes you show your work before the
first edit to a file, `capture-lesson` turns your corrections into durable
rules, and `humanizer` cleans up the writing voice before anything
user-facing ships. A few more round out autonomous work, docs-first
research, and delegation to subagents.

See [docs/skills.md](docs/skills.md) for the full catalog, including the
maintenance and design skills. 
See [docs/models.md](docs/models.md) for the model defaults each harness 
gets, the tiered subagents Claude and Codex install, and per-tool notes.

## Layout

```text
rules/agent-guidelines.md    the short instructions file (constant constraints)
rules/core-rules.md          one-paragraph digest the hooks re-inject
skills/plan-and-track/       plan → track → verify workflow (tasks/todo.md)
skills/capture-lesson/       turn every user correction into a rule (tasks/lessons.md)
skills/humanizer/            strip AI-writing tells, restore a natural voice (portable)
skills/rules-distill/        distill cross-cutting skill principles into rules (portable)
skills/strategic-compact/    when to /compact at logical boundaries (portable)
skills/context-budget/       audit always-on context cost, flag bloat (portable)
skills/skill-comply/         measure whether a rule/skill is actually followed (Claude-only)
skills/skill-activation/     routing regression: does the right skill fire? (static: all 3; runtime: Claude)
skills/gateguard/            fact-forcing gate: investigate before the first edit to a file (portable)
skills/inherit-legacy-style/ capture legacy conventions as a standing constraint (portable)
skills/copilot-review-instructions/ generate Copilot PR-review instructions from a project's documented conventions (portable; Copilot-only output)
skills/plow-ahead/           autonomy contract for open-ended work: state assumptions, keep going,
                              stop only for true blockers (portable)
skills/efficient-frontier/   routing doctrine: which tiered subagent fits a piece of delegated work (portable)
skills/read-the-damn-docs/   docs-first grounding before third-party API/version work (portable)
skills/canvas-design/        original visual art (poster/PDF/PNG) built from a stated design philosophy (portable)
skills/frontend-design/      distinctive visual/UI design direction, not templated defaults (portable)
skills/theme-factory/        apply or generate a cohesive color/font theme for a deck or artifact (portable)
skills/slack-gif-creator/    create animated GIFs optimized for Slack with dimension/FPS/color constraints, validation tools, and animation guidance (portable)
skills/webapp-testing/       drive a local web app in a real browser with Playwright: verify frontend behavior, debug UI, screenshot, read console logs (portable)
skills/migration-discipline/ disciplines for large migrations/ports: ownership isolation, validation ladder, work-queue batching, durable migration state (portable)
agents/                      tiered subagents (Claude .md + rendered Codex TOML): architect-reviewer,
                              security-auditor, fable-advisor, planner (Fable); researcher, debugger,
                              executor (Sonnet); mechanic (Haiku)
hooks/gateguard.js           universal fact-forcing edit gate (Claude/Codex/Copilot)
hooks/delivery-gate.js       pre-finish Stop check (Claude/Codex)
hooks/claude/                Claude wiring: digest + compact suggester + gateguard + delivery-gate + plan-gate
hooks/copilot/                Copilot wiring: throttled digest + gateguard
hooks/codex/                  Codex wiring: digest + gateguard + delivery-gate
install.sh                    per-tool installer
docs/skills.md                full skill catalog
docs/models.md                model defaults, tiered subagents, per-tool notes
```

## Customizing

Two things survive every update:

- **`core-rules.local.md`** next to each tool's `core-rules.md`: extra
  digest lines just for this machine (venvs, local paths). The installer
  never touches it; the hooks append it after the shared digest.
- **Anything outside the managed block** in an instruction file, like a
  `## Python Environment` section you added below the end marker.

To change a shared rule, edit `rules/core-rules.md` and/or
`rules/agent-guidelines.md` and re-run `./install.sh all`. Digest changes
are live immediately; restart Copilot/Codex sessions for instruction
changes. To add a skill, drop it in `skills/<name>/SKILL.md` (the
`description` field tells the agent *when* to use it) and re-install; if
it's Claude-only, add it to `CLAUDE_ONLY_SKILLS` in `install.sh`.

For per-harness quirks (how each tool loads the digest, restart
requirements, known caveats), see
[docs/models.md](docs/models.md#per-tool-notes).

## Nightly style refresh

A scheduled workflow keeps this repo's own style artifacts current: it
re-runs `/inherit-legacy-style` and `/copilot-review-instructions` against
`main`, opens a PR with any drift, has Copilot review it, and squash-merges
once the review is addressed. Details are in the header of
[`.github/workflows/nightly-style-refresh.yml`](.github/workflows/nightly-style-refresh.yml).
