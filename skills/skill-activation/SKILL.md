---
name: skill-activation
description: Use after adding or renaming a skill, when triggers overlap or misroute, or after trimming a skill body. Tests routing and trimmed-body behavior; use skill-comply for broader compliance.
---

# skill-activation

The repo's promise is "skills kick in when triggered." This turns that from an
assertion into a measurement: given a prompt that *should* fire skill X, does a
**fresh** agent actually activate X, and not a neighbouring skill with an
overlapping trigger?

This is the routing sibling of [[skill-comply]], which is supported on Claude Code and Codex and is not installed on Copilot. Keep the two straight:

- **skill-activation**: is the **right skill picked**? Tests the `description`
  frontmatter (the router signal).
- **skill-comply**: is a **picked skill followed**? Tests the skill *body*.
  skill-comply needs LLM judgment; this stays deterministic: the skill's name
  is in the trace or it isn't.

## Portability

The two phases port differently (same shape as [[strategic-compact]]:
portable guidance, one Claude-specific mechanism):

- **Phase 0 (static pre-check): all 3 harnesses.** It only reads `SKILL.md`
  descriptions, so aim it at `~/.claude/skills`, `~/.copilot/skills`, or
  `~/.agents/skills` for Codex.
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

Also use it when re-describing a skill, and as a periodic regression check that
the installed corpus still routes correctly.

## Phase 0: Static router-signal pre-check (free)

Before spending anything on live runs, lint the descriptions. Route first:
front-load user intent, trigger terms, and the nearest negative boundary, while
preserving clauses that prevent known misroutes. A missing or thin
`description`, or one with no trigger clause, is the usual root cause of a
routing miss:

```bash
# portable: swap the path for ~/.copilot/skills or ~/.agents/skills on Codex
node skills/skill-activation/scripts/run-activation-cases.js --precheck ~/.claude/skills

# repository subagent definitions
node skills/skill-activation/scripts/run-activation-cases.js --precheck-agents agents

# also compare installed Claude, Codex, and Copilot description semantics
node skills/skill-activation/scripts/run-activation-cases.js \
  --precheck-agents agents "$HOME"
```

Flags each skill with `weak_router_signal: true` (description under
`DESC_TOKEN_FLOOR` words, default 12, or no "use / when / after / before /
trigger" clause) and `desc_overlong: true` when the decoded description exceeds
`DESC_CHAR_CEILING`, default 500. The latter is an informational authoring
target, not a schema issue or exit-code condition: aim for a few sentences or a
short paragraph around that length when every routing signal survives, but
shorter and evidence-backed longer descriptions are both valid. The separate
1,024-character format maximum remains a strict schema limit. Plain legal YAML
scalars are fine; quote only when YAML requires it, especially for colon-space
(`: `), using double quotes by default and single quotes only when their
contents can be represented safely. The agent precheck also enforces the
repo's fixed key order, model/effort pairs, and closed source-tool vocabulary.
Fix weak signals first; often the runtime failure disappears without a single
billed run. (Body length and always-on cost are [[context-budget]]'s job, not
this skill's.)

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
- Don't add a plain user-correction case for `capture-lesson`: on Claude Code
  the built-in [auto memory](https://code.claude.com/docs/en/memory.md) ("notes
  Claude writes itself based on your corrections and preferences") can
  legitimately absorb that prompt with no Skill tool_use, and on Codex runtime
  activation isn't detectable at all (see Portability above), so the
  deterministic checker can't reliably score it on every harness.
  `capture-self-recurrence` covers the territory a harness memory feature
  doesn't (self-observed recurrence, no user correction).

## Phase 2: Run the cases

List without spending (default):

```bash
node skills/skill-activation/scripts/run-activation-cases.js --dry-run
```

Then either capture traces yourself and verify them (free, reproducible), or let
the script drive the runs:

```bash
# free: one stream-json trace per case id at TRACE_DIR/<id>.jsonl
node skills/skill-activation/scripts/run-activation-cases.js --check TRACE_DIR

# billable: invoke claude -p per case, then check
ACTIVATION_ALLOW_SPEND=1 \
  node skills/skill-activation/scripts/run-activation-cases.js --run
```

**Isolate `--run`.** Each case is a real, tool-executing `claude -p` process, so
run inside a container/VM with restricted mounts and never pass
`--dangerously-skip-permissions`. The script refuses `--run` unless
`ACTIVATION_ALLOW_SPEND=1`. Restrict egress to the model provider's API through
an allowlisting proxy; do not seal it off, since a sealed sandbox exits at zero
turns, an invalid run rather than a passing negative. Read
[references/live-run-isolation.md](references/live-run-isolation.md) before
setting up any live run (permission posture, egress rationale, the
`LIVE_CASE_TIMEOUT_MS` override, run metadata) and
[references/live-run-egress-proxy.md](references/live-run-egress-proxy.md) for
the working Squid recipe; don't inline either here.

A case passes iff `expect_skill` activated and `forbid_skill` did not; the check
itself is deterministic (a name is in the trace or not), so `--check` is free
and repeatable.

## Phase 3: Report & act

The runner emits `{total, passed, accuracy, cases:[{id, expect_skill,
forbid_skill, activated, pass, reason}]}`. For each failure, the fix is almost
always upstream of a rerun:

- **Expected skill didn't fire** → its `description` trigger is too weak or too
  narrow. Tighten the trigger clause (Phase 0 usually flagged it).
- **Forbidden skill fired** → two descriptions claim the same territory. Add a
  terse ownership boundary to each (this vs. that), as skill-comply and
  skill-activation do for one another. Keep it to one clause: frontmatter is
  paid every turn ([[context-budget]]'s concern).
- **Right substance, no Skill invocation** → the installed agent roster's
  always-visible Agent-tool descriptions can route some asks (an explicit
  threat model, a design review) straight to the right agent, and an agent
  can also grep a skill's own file and apply its content, without the
  governing skill ever firing either way. A measurement limit of this
  corpus, not a description defect: Skill invocation is the only signal the
  checker reads, so move such a case to the behavioral smokes or remove it
  rather than tuning descriptions against it. The same signal limit makes a
  forbid between companion skills a false dichotomy: where the expected
  skill and the forbidden one cross-reference each other's procedures (as
  plan-and-track's dispatch and handback-review steps do with
  efficient-frontier), a compliant co-fire is indistinguishable from a
  misroute, so don't forbid a skill the expected one defers to.

A persistently misrouting trigger that resists description fixes is a candidate
for a hook, same escalation path skill-comply uses.

## Behavioral smokes

A separate harness (`scripts/run-behavioral-smokes.js`,
`fixtures/behavioral-cases.jsonl`, `fixtures/behavioral/<id>/`) asks whether a
trimmed skill *body* still drives its mandated behavior, not whether the right
skill fires. Read [references/behavioral-smokes.md](references/behavioral-smokes.md)
after trimming or editing a skill body, and before adding, running, or scoring
a behavioral smoke case.

The smoke runner's `--run` is billable and tool-executing: it sits behind the
same `ACTIVATION_ALLOW_SPEND=1` gate and needs the same isolation as Phase 2
(install the agent roster with `PT_BYPASS_PERMISSIONS=1 HOME=<sandbox>` only
inside that sandbox). It never runs a case with a bypass or skip-permissions
posture.

Run the free process-control fixtures after changing either live runner:

```bash
node skills/skill-activation/scripts/run-live-runner-fixtures.js
```
