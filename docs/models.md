# Model defaults and subagents

## Model defaults

The installer sets a model default for each harness so routine work does not
run at top-tier cost. These settings are repo-owned: every install restores
the intended default, even on a machine that has drifted. What each default
does depends on the harness:

| Harness | Default | Effect |
| --- | --- | --- |
| Claude Code | `model: opusplan` | Opus in Plan mode, Sonnet during execution |
| Claude Code | `switchModelsOnFlag: true` | Switch models on a safety flag instead of stopping |
| Claude Code | `outputStyle: Concise` | Trim narration in responses (needs Claude Code v2.1.237+) |
| Codex | `plan_mode_reasoning_effort: xhigh` | Plan mode: `xhigh`; execution unchanged |
| Copilot | `model: auto` | Let Copilot choose per task; no fixed phase split |

Install with `PT_KEEP_MODEL=1` to keep a machine's existing Claude and Copilot
model and output-style settings, including `switchModelsOnFlag`, instead of
overwriting them. The Codex plan-mode effort still updates.

## Tiered subagents

Tiered subagents install to `~/.claude/agents/`. The installer also renders
them into each harness's native format: TOML under `~/.codex/agents/` and
Markdown custom agents under `~/.copilot/agents/`.

Each agent carries a model and effort assignment sized to the work. Routine
delegation stays on a cheaper tier, while judgment calls use a stronger tier
that a same-topic skill cannot guarantee.

- **`architect-reviewer`** (Fable, read-only) weighs a non-trivial design
  decision before it's locked in: coupling, blast radius, simpler
  alternatives. Never implements.
- **`security-auditor`** (Fable, read-only) reviews security-sensitive code
  (auth, injection, secrets) and reports exploit scenarios ranked by
  severity. Never patches.
- **`fable-advisor`** (Fable, read-only) gives an independent gut-check on a
  decision at a commitment boundary, in under 300 words. Never implements.
- **`planner`** (Opus, read-only) turns a non-trivial task into an ordered
  implementation spec naming exact files, steps, and verification. Never
  implements.
- **`researcher`** (Sonnet, read-only) offloads exploration: mapping code,
  finding callers, gathering the facts an edit needs. Never writes.
- **`debugger`** (Sonnet, read-only + Bash) reproduces a failure and traces
  it to root cause before any fix is attempted, then hands back a failing
  regression test. Never edits code.
- **`executor`** (Sonnet) carries out an already-written spec, the shape
  `planner` produces: exact files, ordered steps, per-step verification.
  Stops and reports on any spec gap instead of improvising.
- **`mechanic`** (Haiku) handles already-decided mechanical edits, and
  kicks anything needing a judgment call back to you.

### Harness mappings and fallbacks

If your account doesn't have Fable access, agents pinned to it just fall
back to your normal model. Codex gets the same eight agents through the
current compatibility mapping:

| Source tier | Codex model |
| --- | --- |
| Fable / Opus | `gpt-5.6-sol` |
| Sonnet | `gpt-5.6-terra` |
| Haiku | `gpt-5.6-luna` |

The rendered Codex profile carries the assigned reasoning effort and sandbox
mode. Copilot also gets the same eight agents, but only tool permissions carry
over there, not the model tier or effort.

### Invoking agents

Claude picks an agent automatically, or you can call one by name: "use the
researcher agent to..."

Copilot CLI uses its custom-agent and subagent-delegation system. Invoke an
installed agent through `copilot --agent=<name>`, the `/agent` picker, or by
naming the agent in a prompt. The native files live at
`~/.copilot/agents/*.agent.md`.

Current Codex releases delegate after a direct request or applicable
`AGENTS.md` and skill instructions; `/agent` shows the threads in an
interactive CLI session.
[OpenAI's subagent reference](https://developers.openai.com/codex/subagents)
documents that a custom agent's `model` and `model_reasoning_effort` take
precedence when set. Its effective sandbox can still be narrower than the
rendered mode because subagents inherit the parent runtime policy.

Codex CLI 0.147.0 note: the tagged
[spawn handler](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L210-L235)
defaults an omitted `fork_turns` to full history, and its
[shared validation](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L226-L235)
rejects a named agent override in that mode. Use `none` for a self-contained
handoff or a positive bounded count when prior turns are required.

## Per-tool notes

### Claude

The digest is injected every turn through a `UserPromptSubmit` hook, so edits
to `core-rules.md` take effect immediately. Set
`"includeCoAuthoredBy": false` in `~/.claude/settings.json` to drop the
co-author trailer.

### Copilot

Copilot reads instructions at session start, so restart after editing them.
The digest rides a throttled `postToolUse` hook once per 10 minutes because
Copilot has no prompt-submit injection. Set `"includeCoAuthoredBy": false` in
`~/.copilot/settings.json` to drop its trailer.

### Codex

The user `AGENTS.md` loads before project instruction files. Skills live in
`~/.agents/skills/`, and subagents render to `~/.codex/agents/*.toml`.

New or changed hooks are skipped until you review and trust them through
`/hooks`; Codex prints a warning at startup if any need attention. Recent
builds add no attribution trailer.

The rendered roster loads from the global agents directory this installer
targets. Current local clients can delegate to it directly or through
applicable `AGENTS.md` and skill instructions.

To check any of this on a live session: start one, get a few messages in,
and ask *"what are your standing rules?"*
