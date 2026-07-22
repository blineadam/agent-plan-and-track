---
name: skill-activation
description: Measure whether the RIGHT skill is triggered for a prompt (routing/activation regression, not compliance). Maintain a corpus of trigger prompts mapped to the skill that should fire, run each in a fresh agent, and deterministically check the stream-json trace for the expected (and not the forbidden) Skill activation. Use after adding or renaming a skill, when two skills have overlapping triggers, or when the wrong skill keeps firing. Also use its behavioral-smoke harness to regression-check that a trimmed skill body still produces the output its SKILL.md mandates; for LLM-judged compliance across strictness levels rather than a pinned deterministic check, use skill-comply instead.
---

# skill-activation

The repo's promise is "skills kick in when triggered." This turns that from an
assertion into a measurement: given a prompt that *should* fire skill X, does a
**fresh** agent actually activate X, and not a neighbouring skill with an
overlapping trigger?

This is the routing sibling of [[skill-comply]] (a Claude-only skill; Codex and Copilot don't install it). Keep the two straight:

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
node skills/skill-activation/scripts/run-activation-cases.js --precheck ~/.claude/skills
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
  paid every turn ([[context-budget]]'s concern).

A persistently misrouting trigger that resists description fixes is a candidate
for a hook, same escalation path skill-comply uses.

## Behavioral smokes

A second, separate harness lives beside this one:
`scripts/run-behavioral-smokes.js` + `fixtures/behavioral-cases.jsonl` +
`fixtures/behavioral/<id>/`. It answers a different question than the rest of
this skill: not "does the right skill fire" (a router/description question),
but "does a trimmed skill *body* still drive its mandated behavior" (does a
fresh agent that activates skill X actually produce the file/content X's
SKILL.md requires). Use it after trimming or editing a skill body, to pin a
regression check that the trim didn't cut behavior.

The boundary vs [[skill-comply]]: skill-comply is LLM-judged strictness
measurement across supportive/neutral/competing prompts; behavioral smokes are
deterministic and corpus-pinned, the same file_regex-or-fail contract this
skill's own `--check` uses for routing.

Each case in `behavioral-cases.jsonl` is `{ id, skill, prompt, max_turns,
fixture, assertions: [{ kind, path, regex, flags }], note }`. `fixture` names
a directory under `fixtures/behavioral/` copied into the case's working
directory before the agent runs (a file the skill's mandated output must be
appended to, not clobber). Unlike this skill's own routing prompts, a
behavioral-smoke prompt should **name the target skill**: the point here isn't
to test routing again, it's to prove the body still works once the skill has
already fired.

Same three modes as this skill's own runner, with one deliberate difference:
`--dry-run` here lints the corpus and exits 1 on any problem (a CI guard, not
just a listing).

- `--dry-run [CORPUS]`: lint the corpus (free); exit 1 on any problem.
- `--check RESULTS_DIR [CORPUS]`: score pre-captured results (free).
- `--run [RESULTS_DIR]`: invoke `claude -p` per case (billable, behind the same
  `ACTIVATION_ALLOW_SPEND=1` gate).

Scoring is liveness-first: a trace's terminal `result` event must show
`subtype: "success"`, a falsy `is_error`, `num_turns > 0`, and
`total_cost_usd > 0` before anything else is scored. A non-live run is
`invalid`, never a pass and never a negative, distinct from a real behavioral
failure. Only a live run is checked for activation, and only a live,
activated run is checked against its file assertions.
