# Behavioral smokes

## Contents

- What it measures
- Case format
- Assertion kinds
- Modes and roster install
- Scoring
- The efficient-frontier cases

## What it measures

A second, separate harness lives beside the routing one:
`scripts/run-behavioral-smokes.js` + `fixtures/behavioral-cases.jsonl` +
`fixtures/behavioral/<id>/`. It answers a different question than routing: not
"does the right skill fire" (a router/description question), but "does a
trimmed skill *body* still drive its mandated behavior" (does a fresh agent
that activates skill X actually produce the file/content X's SKILL.md
requires). Use it after trimming or editing a skill body, to pin a regression
check that the trim didn't cut behavior.

The boundary vs [[skill-comply]]: skill-comply is LLM-judged strictness
measurement across supportive/neutral/competing prompts; behavioral smokes are
deterministic and corpus-pinned, the same file_regex-or-fail contract the
routing runner's `--check` uses.

## Case format

Each case in `behavioral-cases.jsonl` is `{ id, skill, prompt, max_turns,
fixture, setup?, allowed_tools?, assertions: [{ kind: file_regex |
response_regex | trace_agent_dispatch_count | trace_agent_dispatch_names,
... }], note }`. `fixture` names
a directory under `fixtures/behavioral/` copied into the case's working
directory before the agent runs (a file the skill's mandated output must be
appended to, not clobber). Unlike the routing corpus's prompts, a
behavioral-smoke prompt should **name the target skill**: the point here isn't
to test routing again, it's to prove the body still works once the skill has
already fired.

An optional `setup` names a sibling `.js` file beside the fixture dir, run
only by `--run` (never `--dry-run` or `--check`) with the case dir as its
cwd, before the agent spawns; a nonzero exit, a timeout, or any other unclean
run scores the case `invalid` and suppresses the agent spawn entirely. An
optional `allowed_tools` widens `--run`'s fixed `acceptEdits` posture with an
explicit tool allowlist, for a case whose assertions need a tool beyond
editing (a `trace_agent_dispatch_count` case reading `git diff` via Bash to
review a batch, for instance): a non-empty array of bare tool names (e.g.
`"Bash"`; no parenthesised scoping, which is unverified against the current
CLI), each matching `/^[A-Za-z][A-Za-z0-9_]*$/`. No case is ever run with a
bypass or skip-permissions posture.

A case that needs a CLI the sandbox lacks (`gh`, say) keeps a stub beside its
`setup`, which copies it into the case dir and puts it on the agent's PATH by
writing
`.claude/settings.json` with an `env.PATH` that is an absolute literal (the
case dir's `bin` prepended to the setup process's own PATH, since settings
values are not shell-expanded). The `yeet-step15-*` cases do this: their stub
answers from a state file and appends each argv to a log the assertions read,
and a live run confirmed the Bash tool resolves it.

## Assertion kinds

A `file_regex` may set `ref_exists: true` when the file it reads only names
an artifact, such as a state line pointing at a test file. The regex's first
capture group, from its first match, must then name an existing file inside
the case dir, checked on its resolved real path so a symlink out of the case
dir fails, and a run that names an artifact it never wrote fails. It proves
the file exists, not what it contains, and the lint rejects it on a regex
with no capture group.

`response_regex`, `trace_agent_dispatch_count`, and `trace_agent_dispatch_names`
each hard-fail only what they literally measure, per the narrower-than-its-rule
disclosure this repo's checks carry: `response_regex` hard-fails when its regex
doesn't match assistant text, proving only that the marker starts some line,
not that it was the review's first line; `trace_agent_dispatch_count`
hard-fails when the trace's de-duplicated Task/Agent tool_use count falls
outside `[min, max]`, proving only how many dispatches happened, not the
identity or independence of the agents dispatched. `min` must be an integer
>= 0; a bare `min: 0` with no `max` asserts nothing (any count satisfies it)
and is rejected, but `{min: 0, max: 0}` is a real, useful assertion ("no
dispatches happened") and is accepted. A single case asserting either "always
high risk, always two dispatches" or "always normal risk, never dispatches"
can pass by ignoring the diff entirely: `plan-and-track-risk-classification`
and its `-normal` counterpart are a deliberate discriminating pair for exactly
this reason, and only make sense scored together. `trace_agent_dispatch_names`
hard-fails when a listed `forbid` name matches a dispatched agent's identity
(checked first, the more specific failure) or when no listed `expect` name
matches (any-of, not all-of); it proves identity presence in the trace only,
never that the dispatched agent ran, returned anything usable, or produced a
particular result, and a dispatch whose identity field isn't exposed is
invisible to both directions, so `forbid` can only prove no readable forbidden
dispatch, not true absence. Neither direction is required alone, but an
assertion with neither is rejected as vacuous, the same rejection the bare
`min: 0` count case gets above; each present array must be non-empty and match
`/^[a-z][a-z0-9-]*$/`, and naming the same agent in both `expect` and `forbid`
is rejected too.

## Modes and roster install

Same three modes as the routing runner, with one deliberate difference:
`--dry-run` here lints the corpus and exits 1 on any problem (a CI guard, not
just a listing).

- `--dry-run [CORPUS]`: lint the corpus (free); exit 1 on any problem.
- `--check RESULTS_DIR [CORPUS]`: score pre-captured results (free).
- `--run [RESULTS_DIR] [CORPUS]`: invoke `claude -p` per case (billable, behind
  the same `ACTIVATION_ALLOW_SPEND=1` gate).

A `trace_agent_dispatch_count` or `trace_agent_dispatch_names` case needs the
roster installed before `--run` does anything else: `PT_BYPASS_PERMISSIONS=1
HOME=<sandbox> ./install.sh claude` installs it into a sandbox `HOME` with a
bypass posture that avoids an interactive confirmation stalling a headless
run. The required set is derived from the whole corpus, not one fixed list:
the existing fixed pair, architect-reviewer.md and security-auditor.md, for
any `trace_agent_dispatch_count` case, plus every agent named in either
`expect` or `forbid` of any `trace_agent_dispatch_names` case. Both
directions matter: skipping `forbid` names would let an uninstalled
forbidden agent satisfy a forbid trivially, since a dispatch that can't
happen never appears in the trace either. `--run` refuses up front, before
spending, when the corpus needs a roster and any required entry is missing.

## Scoring

Scoring is liveness-first: a trace's terminal `result` event must show
`subtype: "success"`, a falsy `is_error`, `num_turns > 0`, and
`total_cost_usd > 0` before anything else is scored. A non-live run is
`invalid`, never a pass and never a negative, distinct from a real behavioral
failure. Only a live run is checked for activation, and only a live,
activated run is checked against its file assertions.

## The efficient-frontier cases

The `efficient-frontier-threat-model-delegation`,
`efficient-frontier-architecture-review-delegation`,
`efficient-frontier-advisor-consult`, and
`efficient-frontier-user-decision-no-consult` cases live in this corpus rather
than the routing one for the reason SKILL.md's Phase 3 "Right substance, no
Skill invocation" bullet gives: the routing checker reads Skill invocation
only.
