# Model defaults and subagents

## Model defaults

The installer sets a sensible model default for each harness so routine
work doesn't run at top-tier cost. These are repo-owned: every install
restores the intended default, even on a machine that's drifted. What the
default actually does differs by harness:

| Harness | Default | Effect |
| --- | --- | --- |
| Claude Code | `model: opusplan` | Opus in Plan mode, Sonnet for execution: a real per-phase model swap |
| Claude Code | `switchModelsOnFlag: true` | Switches to another model on a safety-flagged message instead of stopping the session |
| Codex | `plan_mode_reasoning_effort: xhigh` | More reasoning in Plan mode only; the execution model and effort stay yours |
| Copilot | `model: auto` | Copilot routes each task to a fitting model (no fixed plan/execute split) |

Install with `PT_KEEP_MODEL=1` to keep a machine's existing Claude and
Copilot model settings (the model and `switchModelsOnFlag`) instead of
overwriting them; the Codex plan-mode effort still updates.

## Tiered subagents

Tiered subagents (Claude and Codex) install to `~/.claude/agents/` and,
rendered into Codex's native TOML format, `~/.codex/agents/`. Each is
pinned to a model and effort that fits what the work needs: cheaper for
routine delegation, stronger for judgment calls a same-topic skill can't
guarantee a model tier for.

- **`architect-reviewer`** (Fable, read-only) weighs a non-trivial design
  decision before it's locked in: coupling, blast radius, simpler
  alternatives. Never implements.
- **`security-auditor`** (Fable, read-only) reviews security-sensitive code
  (auth, injection, secrets) and reports exploit scenarios ranked by
  severity. Never patches.
- **`fable-advisor`** (Fable, read-only) gives an independent gut-check on a
  decision at a commitment boundary, in under 300 words. Never implements.
- **`planner`** (Fable, read-only) turns a non-trivial task into an ordered
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

If your account doesn't have Fable access, agents pinned to it just fall
back to your normal model. Codex gets the same eight agents, but only the
effort level and permissions carry over there, not the model tier.

Claude picks the right agent for the job automatically, or you can call
one by name ("use the researcher agent to..."). Copilot has no concept of
subagents, so these only install to Claude and Codex.

## Per-tool notes

- **Claude** (`~/.claude`): the digest gets injected every turn via a
  `UserPromptSubmit` hook, so edits to `core-rules.md` take effect
  immediately. Set `"includeCoAuthoredBy": false` in `settings.json` to
  drop the co-author trailer.
- **Copilot** (`~/.copilot`): reads instructions at session start, so
  restart after edits. The digest rides a throttled `postToolUse` hook
  (once per 10 minutes, since Copilot has no prompt-submit injection).
  `"includeCoAuthoredBy": false` drops its trailer too.
- **Codex** (`~/.codex`): the user `AGENTS.md` loads before project ones;
  skills live in `~/.agents/skills/`, and subagents render to
  `~/.codex/agents/*.toml`. Run `codex` and press `2` to accept new hooks.
  Recent builds add no attribution trailer. Unverified: named-agent
  invocation via `spawn_agent` is unreliable everywhere as of this
  writing, not only in SDK/MCP-driven sessions. Recent reports
  (openai/codex#15250) reproduce it on standalone Codex CLI and Codex
  Desktop too, where a requested custom agent silently falls back to the
  parent's own model, effort, and sandbox instead of loading its TOML.
  Treat the rendered roster as forward-looking until upstream fixes this;
  don't count on it picking the right profile on its own.

To check any of this on a live session: start one, get a few messages in,
and ask *"what are your standing rules?"*
