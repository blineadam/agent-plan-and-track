# agent-plan-and-track

Portable, user-scoped agent rules for Claude Code, GitHub Copilot, and Codex:
plan non-trivial work in `tasks/todo.md`, capture corrections in
`tasks/lessons.md`, verify before claiming done — and keep those rules
**sticky** in long sessions instead of letting them fade as the context grows.

## Why this exists

Global instruction files (`CLAUDE.md`, `AGENTS.md`, `copilot-instructions.md`)
sit at the very top of the context window, and in a long chat the model's
attention to them drifts — it starts "forgetting" your rules. The fix is to
match each kind of rule to a mechanism that keeps it alive:

| Rule type | Mechanism | Why it sticks |
| --- | --- | --- |
| Short, constant constraints | Instructions file | Always loaded; kept tiny so it isn't buried by its own bulk |
| Procedures (plan, capture lessons) | **Skills** | Loaded just-in-time, at the recent end of context, when triggered |
| The core rules themselves | **Hooks** re-injecting a digest | Harness-enforced repetition, immune to attention decay |

## The everyday skills

- **`plan-and-track`** — kicks in on multi-step work (a feature, a refactor, a
  3+ step fix, or resuming a repo that already has a `tasks/todo.md`). Writes a
  checklist, tracks it, and verifies before closing out.
- **`capture-lesson`** — kicks in whenever you correct the agent, turning the
  correction into a durable rule in `tasks/lessons.md`.

Best for iterative work in a real repo — features, bug fixes, refactors — where
a durable plan and a growing lessons file pay off across a session.

## Meta-maintenance skills

Skills that maintain the rules and skills themselves (adapted from
[affaan-m/ecc](https://github.com/affaan-m/ecc)). Portable where it's safe,
Claude-only where the mechanism is genuinely Claude-native.

| Skill | What it does | Where |
| --- | --- | --- |
| **`rules-distill`** | Finds principles recurring across your skills that aren't rules yet, and proposes promoting them. | All 3 |
| **`strategic-compact`** | Guides you to `/compact` at logical boundaries instead of mid-task. | All 3 |
| **`context-budget`** | Audits always-on context cost and flags what's too big. | All 3 |
| **`skill-comply`** | Measures whether a fresh agent actually follows a given rule. | Claude only |
| **`gateguard`** | Before the first edit to a file, demand the facts — callers, blast radius, schemas — instead of guessing. | All 3 |
| **`inherit-legacy-style`** | Captures a legacy codebase's conventions into an enforceable `.ai-style-rules.md`. | All 3 |

On Claude, three of these are backed by **hooks** that enforce the rule rather
than just suggest it — installed idempotently, each with an off switch:

- **compact suggester** — nudges you toward `/compact` when the context gets
  large. Never blocks.
- **delivery-gate** — a warn-only pre-finish check ("did you verify? did you
  checkpoint?"). `DELIVERY_GATE_BLOCK=1` makes it actually block.
- **gateguard** — denies the first edit to each file until you've presented the
  facts; the retry always passes. `GATEGUARD_DISABLED=1` / `GATEGUARD_WARN=1`
  to soften it.

Each hook's tuning knobs live in its script header under `hooks/claude/`.
Copilot and Codex get the guidance as skills but not the enforcement — those
events are Claude-only.

## Model defaults

The installer also sets a sensible model default for each harness so routine
work doesn't run at top-tier cost — written **only if you haven't already chosen
one**, so it never clobbers your setting and re-runs are no-ops. What the
default does differs by harness:

| Harness | Default | Effect |
| --- | --- | --- |
| Claude Code | `model: opusplan` | Opus in Plan mode, Sonnet for execution — a real per-phase model swap |
| Codex | `plan_mode_reasoning_effort: high` | More reasoning in Plan mode only; the execution model and effort are untouched |
| Copilot | `model: auto` | Copilot routes each task to a fitting model (no fixed plan/execute split) |

Only Claude's `opusplan` actually swaps models between planning and execution;
Codex has no plan-mode *model* lever (only effort), and Copilot's `auto` just
routes dynamically. To change a default, edit its config file (or use the
harness's `/model`) — the installer leaves your value alone.

**Tiered subagents (Claude only)** install to `~/.claude/agents/`, each pinned
to a cheaper model so delegated work stays cheap:

- **`researcher`** (Sonnet, read-only) — offloaded exploration: map code, find
  callers, gather the facts an edit needs. Never writes.
- **`mechanic`** (Haiku) — already-decided mechanical edits; kicks anything that
  needs a judgment call back to you.

Call them by name ("use the researcher agent to…"). Copilot and Codex have no
user-definable per-agent model pin, so this part is Claude-only.

## Install

```sh
git clone https://github.com/blineadam/agent-plan-and-track.git
cd agent-plan-and-track
./install.sh all        # or: claude | copilot | codex
```

Idempotent and non-destructive:

- **Skills, digest, and hooks** are copied/merged into each tool's user config;
  a differing existing digest or Copilot hook is backed up to `*.bak`.
- **Instruction files** get the repo content inside a marker-delimited managed
  block — re-installs update only that block, and anything you add outside it is
  never touched. A file without the markers is left alone entirely.
- **Model defaults** are written only when you haven't already chosen one. The
  Claude **subagents** are repo-owned like skills — kept in sync on each install
  (customize them in the repo, not in `~/.claude/agents/`).

Requires `jq`. Update later with `git pull && ./install.sh all`.

## Layout

```text
rules/agent-guidelines.md    the short instructions file (constant constraints)
rules/core-rules.md          one-paragraph digest the hooks re-inject
skills/plan-and-track/       plan → track → verify workflow (tasks/todo.md)
skills/capture-lesson/       turn every user correction into a rule (tasks/lessons.md)
skills/rules-distill/        distill cross-cutting skill principles into rules (portable)
skills/strategic-compact/    when to /compact at logical boundaries (portable)
skills/context-budget/       audit always-on context cost, flag bloat (portable)
skills/skill-comply/         measure whether a rule/skill is actually followed (Claude-only)
skills/gateguard/            fact-forcing gate: investigate before the first edit to a file (portable)
skills/inherit-legacy-style/ capture legacy conventions as a standing constraint (portable)
agents/                      Claude-only tiered subagents: researcher (Sonnet), mechanic (Haiku)
hooks/claude/                Claude hooks: digest + compact suggester + delivery-gate + gateguard
hooks/copilot/               Copilot hook (post-tool-use injection, throttled)
hooks/codex/                 Codex hook (re-inject on resume/compact)
install.sh                   per-tool installer
```

## Customizing

Two things survive every update:

- **`core-rules.local.md`** next to each tool's `core-rules.md` — extra digest
  lines just for this machine (venvs, local paths). The installer never touches
  it; the hooks append it after the shared digest.
- **Anything outside the managed block** in an instruction file — e.g. a
  `## Python Environment` section below the end marker.

To change a shared rule, edit `rules/core-rules.md` and/or
`rules/agent-guidelines.md` and re-run `./install.sh all` — digest changes are
live immediately; restart Copilot/Codex sessions for instruction changes. To add
a skill, drop it in `skills/<name>/SKILL.md` (the `description` tells the agent
*when* to use it) and re-install; if it's Claude-only, add it to
`CLAUDE_ONLY_SKILLS` in `install.sh`.

## Per-tool notes

- **Claude** (`~/.claude`) — the digest is injected every turn via a
  `UserPromptSubmit` hook, so edits to `core-rules.md` are live. Set
  `"includeCoAuthoredBy": false` in `settings.json` to drop the co-author
  trailer.
- **Copilot** (`~/.copilot`) — reads instructions at session start (restart
  after edits); the digest rides a throttled `postToolUse` hook (once per
  10 min, since Copilot has no prompt-submit injection). `"includeCoAuthoredBy":
  false` drops its trailer too.
- **Codex** (`~/.codex`) — the user `AGENTS.md` loads before project ones; skills
  live in `~/.agents/skills/`. Run `codex` and press `2` to accept new hooks.
  Recent builds add no attribution trailer.

To check any of them: start a session, get a few messages in, and ask *"what are
your standing rules?"*
