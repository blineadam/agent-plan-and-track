# agent-plan-and-track

Portable, user-scoped agent rules/skills/hooks for Claude Code, GitHub Copilot, and Codex that 
remain active throughout a session and persist across future sessions.

Uses a `tasks/todo.md` to plan non-trivial work, records your user corrections in 
`tasks/lessons.md`, and verify changes before claiming completion. These rules 
stay durable even as the context grows.

Best for iterative work in an existing repository, including features, bug fixes, 
and refactors, where a persistent plan, an enforced completion gate, and a 
growing lessons file improve work over time.

## Why this exists

Global instruction files (`CLAUDE.md`, `AGENTS.md`, `copilot-instructions.md`)
sit at the very top of the context window, and in a long chat the model's
attention to them drifts: it starts "forgetting" your rules. The fix is to
match each kind of rule to a mechanism that keeps it alive:

| Rule type | Mechanism | Why it sticks |
| --- | --- | --- |
| Short, constant constraints | Instructions file | Always loaded; kept tiny so it isn't buried by its own bulk |
| Procedures (plan, capture lessons) | **Skills** | Loaded just-in-time, at the recent end of context, when triggered |
| The core rules themselves | **Hooks** re-injecting a digest | Harness-enforced repetition, immune to attention decay |

## The everyday workflow

These are the ones you hit every session, roughly in the order you hit them:
plan it, implement under a fact-forcing gate, get checked before you call it
done, and turn any correction into a durable rule:

- **`plan-and-track`** (skill): kicks in on multi-step work (a feature, a
  refactor, a 3+ step fix, or resuming a repo that already has a
  `tasks/todo.md`). Writes a checklist, tracks it, and verifies before closing
  out.
- **gateguard** (skill + enforcing hook, Claude/Codex/Copilot): before the
  first edit to a file, demand the facts: callers, blast radius, schemas,
  instead of guessing. The hook denies that first edit until you've presented
  them; the retry always passes. One script handles all three harnesses, and an
  env var can soften or disable it.
- **delivery-gate** (enforcing hook only, Claude/Codex): a warn-only
  pre-finish Stop check ("did you verify? did you checkpoint?") backing the
  verify-before-done and capture-lesson rules at the harness layer. An env var
  can make it block.
- **`capture-lesson`** (skill): kicks in whenever you correct the agent,
  turning the correction into a durable rule in `tasks/lessons.md`.

A harness that can't run a given hook still gets the rule as a skill: that's
why Copilot (no Stop event) gets gateguard but not delivery-gate. Tuning knobs
for both hooks live in their script headers under `hooks/`.

## Maintenance skills

Skills that maintain the rules and skills themselves (adapted from
[affaan-m/ecc](https://github.com/affaan-m/ecc)) rather than the everyday
coding workflow above. Portable where it's safe, Claude-only where the
mechanism is genuinely Claude-native.

| Skill | What it does | Where |
| --- | --- | --- |
| **`rules-distill`** | Finds principles recurring across your skills that aren't rules yet, and proposes promoting them. | All 3 |
| **`strategic-compact`** | Guides you to `/compact` at logical boundaries instead of mid-task; backed by a Claude-only enforcing hook that nudges you there. | All 3 |
| **`context-budget`** | Audits always-on context cost and flags what's too big. | All 3 |
| **`skill-comply`** | Measures whether a fresh agent actually follows a given rule. | Claude only |
| **`skill-activation`** | Tests whether the *right* skill fires for a prompt: routing regression, sibling to `skill-comply`. | All 3 (runtime check is Claude-only) |
| **`inherit-legacy-style`** | Captures a legacy codebase's conventions into an enforceable `.ai-style-rules.md`. | All 3 |
| **`copilot-review-instructions`** | Generates path-scoped `.github/instructions/*.instructions.md` PR-review directives from a project's documented conventions (style rules, instructions file, README, docs). | All 3 (Copilot-only output) |

## Model defaults

The installer sets a sensible model default for each harness so routine work
doesn't run at top-tier cost. These are repo-owned: every install restores 
the intended default even on a machine that had drifted. What the default does
differs by harness:

| Harness | Default | Effect |
| --- | --- | --- |
| Claude Code | `model: opusplan` | Opus in Plan mode, Sonnet for execution: a real per-phase model swap |
| Claude Code | `switchModelsOnFlag: true` | Switches to another model on a safety-flagged message instead of stopping the session |
| Codex | `plan_mode_reasoning_effort: high` | More reasoning in Plan mode only; the execution model and effort stay yours |
| Copilot | `model: auto` | Copilot routes each task to a fitting model (no fixed plan/execute split) |

Install with `PT_KEEP_MODEL=1` to keep a machine's existing Claude and Copilot
model settings (the model and `switchModelsOnFlag`) instead of overwriting them;
the Codex plan-mode effort still updates.

**Tiered subagents (Claude only)** install to `~/.claude/agents/`, each pinned
to a cheaper model so delegated work stays cheap:

- **`researcher`** (Sonnet, read-only) offloads exploration: map code, find
  callers, gather the facts an edit needs. Never writes.
- **`mechanic`** (Haiku): already-decided mechanical edits; kicks anything that
  needs a judgment call back to you.

Claude routes work to them automatically based on their descriptions; you can
also invoke one explicitly ("use the researcher agent to…"). Copilot and Codex
have no user-definable per-agent model pin, so tiered subagents are Claude-only.

## Install

```sh
git clone https://github.com/blineadam/agent-plan-and-track.git
cd agent-plan-and-track
./install.sh all        # or: claude | copilot | codex
```

Idempotent. Re-runs re-assert the repo's intended state; your own content is kept:

- **Skills, digest, and hooks** are copied/merged into each tool's user config;
  a differing existing digest or Copilot hook is backed up to `*.bak`.
- **Instruction files** get the repo content inside a marker-delimited managed
  block: re-installs update only that block, and anything you add outside it is
  never touched. A file without the markers is left alone entirely.
- **Model defaults** are repo-owned and overwritten on each install (set
  `PT_KEEP_MODEL=1` to keep a machine's own model choice). The Claude
  **subagents** are repo-owned like skills, kept in sync on each install
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
skills/skill-activation/     routing regression: does the right skill fire? (static: all 3; runtime: Claude)
skills/gateguard/            fact-forcing gate: investigate before the first edit to a file (portable)
skills/inherit-legacy-style/ capture legacy conventions as a standing constraint (portable)
skills/copilot-review-instructions/ generate Copilot PR-review instructions from a project's documented conventions (portable; Copilot-only output)
agents/                      Claude-only tiered subagents: researcher (Sonnet), mechanic (Haiku)
hooks/gateguard.js           universal fact-forcing edit gate (Claude/Codex/Copilot)
hooks/delivery-gate.js       pre-finish Stop check (Claude/Codex)
hooks/claude/                Claude wiring: digest + compact suggester + gateguard + delivery-gate
hooks/copilot/               Copilot wiring: throttled digest + gateguard
hooks/codex/                 Codex wiring: digest + gateguard + delivery-gate
install.sh                   per-tool installer
```

## Customizing

Two things survive every update:

- **`core-rules.local.md`** next to each tool's `core-rules.md`: extra digest
  lines just for this machine (venvs, local paths). The installer never touches
  it; the hooks append it after the shared digest.
- **Anything outside the managed block** in an instruction file, e.g. a
  `## Python Environment` section below the end marker.

To change a shared rule, edit `rules/core-rules.md` and/or
`rules/agent-guidelines.md` and re-run `./install.sh all`: digest changes are
live immediately; restart Copilot/Codex sessions for instruction changes. To add
a skill, drop it in `skills/<name>/SKILL.md` (the `description` tells the agent
*when* to use it) and re-install; if it's Claude-only, add it to
`CLAUDE_ONLY_SKILLS` in `install.sh`.

## Per-tool notes

- **Claude** (`~/.claude`): the digest is injected every turn via a
  `UserPromptSubmit` hook, so edits to `core-rules.md` are live. Set
  `"includeCoAuthoredBy": false` in `settings.json` to drop the co-author
  trailer.
- **Copilot** (`~/.copilot`): reads instructions at session start (restart
  after edits); the digest rides a throttled `postToolUse` hook (once per
  10 min, since Copilot has no prompt-submit injection). `"includeCoAuthoredBy":
  false` drops its trailer too.
- **Codex** (`~/.codex`): the user `AGENTS.md` loads before project ones; skills
  live in `~/.agents/skills/`. Run `codex` and press `2` to accept new hooks.
  Recent builds add no attribution trailer.

To check any of them: start a session, get a few messages in, and ask *"what are
your standing rules?"*

## Other helpful tools

These are other skills I install and use that may also be helpful. Nothing in
this repository installs or depends on them.

- [graphify](https://github.com/safishamsi/graphify): builds a queryable
  knowledge graph of a codebase, so an agent can look up definitions, callers,
  and structure instead of grepping blind. This repo's own graphify usage
  rules live in a gitignored `CLAUDE.local.md`/`AGENTS.local.md`, not in the
  tracked `CLAUDE.md`/`AGENTS.md`, since not every checkout has it installed.
