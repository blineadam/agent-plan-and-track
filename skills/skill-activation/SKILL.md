---
name: skill-activation
description: Measure whether the RIGHT skill is triggered for a prompt (routing/activation regression, not compliance). Maintain a corpus of trigger prompts mapped to the skill that should fire, run each in a fresh agent, and deterministically check the stream-json trace for the expected (and not the forbidden) Skill activation. Use after adding or renaming a skill, when two skills have overlapping triggers, or when the wrong skill keeps firing. For whether an already-fired skill is FOLLOWED, use skill-comply instead.
---

# skill-activation

The repo's promise is "skills kick in when triggered." This turns that from an
assertion into a measurement: given a prompt that *should* fire skill X, does a
**fresh** agent actually activate X, and not a neighbouring skill with an
overlapping trigger?

This is the routing sibling of [[skill-comply]]. Keep the two straight:

- **skill-activation**: is the **right skill picked**? Tests the `description`
  frontmatter (the router signal).
- **skill-comply**: is a **picked skill followed**? Tests the skill *body*.
  skill-comply needs LLM judgment; this stays deterministic: the skill's name
  is in the trace or it isn't.

Technique borrowed from `muratcankoylan/agent-skills-for-context-engineering`
(its `activation-cases` corpus), rebuilt for this repo's skill set.

## Portability

The two phases port differently (same shape as [[strategic-compact]]:
portable guidance, one Claude-specific mechanism):

- **Phase 0 (static pre-check): all 3 harnesses.** It only reads `SKILL.md`
  descriptions, so aim it at `~/.claude/skills`, `~/.copilot/skills`, or
  `~/.codex/skills`.
- **Phase 2 (runtime activation): Claude verified · Copilot likely · Codex
  no.** Claude Code emits a `Skill` tool_use in its `stream-json` trace
  (verified). Copilot exposes a `skill` tool plus `--output-format=json`, so the
  same parse should work (the checker already reads both shapes), but verify
  empirically first. Codex `exec --json` has no skill event, so runtime
  activation isn't detectable there; run Phase 0 only on Codex.

> **Only Skill-tool skills are testable this way.** A skill that fires via the
> Skill tool (plan-and-track, capture-lesson, context-budget, gateguard, …) shows
> up in the trace and is eligible for the corpus. `delivery-gate` is hook-only
> (no SKILL.md): it fires from the harness Stop event, never via the Skill tool,
> so it never appears; exercise its hook instead. gateguard is hook-*enforced*
> too, but it also ships as a skill, so its *routing* is testable here even though
> its *enforcement* isn't.

## When to use

- After adding, renaming, or re-describing a skill, did routing shift?
- When two skills have overlapping triggers and the wrong one keeps firing.
- Periodic regression check that the installed corpus still routes correctly.

## Phase 0: Static router-signal pre-check (free)

Before spending anything on live runs, lint the descriptions: a missing or
thin `description`, or one with no trigger clause, is the usual root cause of a
routing miss:

```bash
# portable: swap the path for ~/.copilot/skills or ~/.codex/skills
bash skills/skill-activation/scripts/run-activation-cases.sh --precheck ~/.claude/skills
```

Flags each skill with `weak_router_signal: true` (description under
`DESC_TOKEN_FLOOR` words, default 12, or no "use / when / after / before /
trigger" clause). Fix those first; often the runtime failure disappears without
a single billed run. (Body length and always-on cost are [[context-budget]]'s
job, not this skill's.)

## Phase 1: Maintain the corpus

Cases live in `fixtures/activation-cases.jsonl`, one JSON object per line:

```json
{"id": "budget-vs-compact", "prompt": "My agent config feels heavy and sessions start slow. Which skills cost the most tokens every turn?", "expect_skill": "context-budget", "forbid_skill": "strategic-compact", "note": "boundary case"}
```

- `expect_skill`: the skill that *should* fire. `forbid_skill` (optional): a
  confusable neighbour that must *not*. Boundary cases (both fields set) are the
  highest-value entries; they're what catch trigger overlap.
- Keep `prompt` realistic and **don't name the skill**: a prompt that says
  "plan this" tests nothing. Phrase it as a user actually would.
- Add a case whenever you add a skill or discover a real misroute.

## Phase 2: Run the cases

List without spending (default):

```bash
bash skills/skill-activation/scripts/run-activation-cases.sh --dry-run
```

Then either capture traces yourself and verify them (free, reproducible), or let
the script drive the runs:

```bash
# free: one stream-json trace per case id at TRACE_DIR/<id>.jsonl
bash skills/skill-activation/scripts/run-activation-cases.sh --check TRACE_DIR

# billable: invoke claude -p per case, then check
ACTIVATION_ALLOW_SPEND=1 \
  bash skills/skill-activation/scripts/run-activation-cases.sh --run
```

**Isolate `--run`.** Each case is a real, tool-executing `claude -p` process, and
a `forbid`/competing prompt *will* run tool calls, so run inside a container/VM
with restricted mounts and no network egress, and never pass
`--dangerously-skip-permissions`. The script refuses `--run` unless
`ACTIVATION_ALLOW_SPEND=1`. A case passes iff `expect_skill` activated and
`forbid_skill` did not; the check itself is deterministic (a name is in the
trace or not), so `--check` is free and repeatable.

## Phase 3: Report & act

The runner emits `{total, passed, accuracy, cases:[{id, expect_skill,
forbid_skill, activated, pass, reason}]}`. For each failure, the fix is almost
always upstream of a rerun:

- **Expected skill didn't fire** → its `description` trigger is too weak or too
  narrow. Tighten the trigger clause (Phase 0 usually flagged it).
- **Forbidden skill fired** → two descriptions claim the same territory. Add a
  terse ownership boundary to each (this vs. that), as skill-comply and
  skill-activation do for one another. Keep it to one clause: frontmatter is
  paid every turn ([[context-budget]]).

A persistently misrouting trigger that resists description fixes is a candidate
for a hook, same escalation path skill-comply uses.
