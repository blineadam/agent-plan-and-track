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

Technique borrowed from `muratcankoylan/agent-skills-for-context-engineering`
(its `activation-cases` corpus), rebuilt for this repo's skill set.

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

## When to use

- After adding, renaming, or re-describing a skill, did routing shift?
- When two skills have overlapping triggers and the wrong one keeps firing.
- Periodic regression check that the installed corpus still routes correctly.

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

**Isolate `--run`.** Each case is a real, tool-executing `claude -p` process, and
a `forbid`/competing prompt *will* run tool calls, so run inside a container/VM
with restricted mounts, and never pass `--dangerously-skip-permissions`. The
script refuses `--run` unless `ACTIVATION_ALLOW_SPEND=1`.

Restrict egress to the model provider's API rather than sealing it off. A sealed
sandbox is not the stricter choice here: the case cannot reach the API, so it
exits at zero turns having activated nothing, which is an invalid run rather than
a passing negative. An allowlisting forward proxy gives the isolation without
that failure mode. Point the sandbox's `HTTPS_PROXY`/`HTTP_PROXY` at it and keep
the credential mounted in the sandbox rather than baked into the proxy.

Enforcing this by TLS SNI, not by the CONNECT line's hostname, needs Squid built
against OpenSSL: Debian and Ubuntu's default `squid` package is built against
GnuTLS and refuses this config, so install `squid-openssl` instead (it conflicts
with, and replaces, `squid`). The `tls-cert=` file below is a throwaway
self-signed certificate that the port requires to start but never presents to
anything, since this ruleset only peeks and splices, never decrypts:

```squid
# squid.conf: destination-allowlisted forward proxy for billable live runs.
# Host list: https://code.claude.com/docs/en/network-config is the source of
# truth. Re-check it; hosts change. Also set
# CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 in the sandbox so optional
# telemetry never hits the deny wall.

# Bind only the interface the sandbox reaches, never 0.0.0.0: the proxy has
# exactly one legitimate client. Give the sandbox its own user-defined Docker
# network rather than the default bridge (that bridge's /16 is shared by
# every container on the host) and match its single address here, not a CIDR
# range. Both addresses below belong to such a network; substitute the ones
# your own network hands out.
#
# ssl-bump plus tls-cert is required by the parser to start this port at all.
# Never change splice to bump below: that would MITM provider traffic and
# expose the credential and every prompt to the proxy.
http_port 172.20.0.1:3128 ssl-bump tls-cert=/etc/squid/dummy.pem
acl sandbox src 172.20.0.2/32

# api.anthropic.com carries inference. platform.claude.com carries OAuth token
# refresh for claude.ai accounts, so a long corpus dies mid-run without it;
# drop it from both lines only if the sandbox authenticates with an API key.
#
# Two ACLs on purpose. The CONNECT line decides which names Squid will even
# resolve and dial; the SNI check below decides what the TLS session may then
# ask for. Keep both: on SNI alone, a crafted CONNECT hostname reaches the
# attacker's own DNS server carrying whatever it encodes, long before the
# handshake that would have been terminated.
acl provider_host dstdomain api.anthropic.com platform.claude.com
acl provider_sni ssl::server_name api.anthropic.com platform.claude.com

# TLS only: no CONNECT tunnel to an arbitrary port on an allowed host.
acl tls_port port 443

# Reject IP-literal CONNECT targets outright, v4 and bracketed v6: dstdomain
# and dstdom_regex both fall back to a reverse PTR lookup for a non-matching
# literal, and that PTR record is the destination's own to set, not ours to
# trust. This deny has to precede the allow below, which is why it sits here.
acl ip_literal dstdom_regex ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$|^\[

# A CONNECT tunnel only tells Squid the hostname the client typed, so peek at
# the real ClientHello SNI instead of trusting that line, terminate anything
# that doesn't match, then splice the rest through unmodified. A spliced
# connection is never decrypted; the client's TLS session runs end to end.
acl step1 at_step SslBump1
ssl_bump peek step1
ssl_bump terminate !provider_sni
ssl_bump splice all

http_access deny ip_literal
http_access allow sandbox provider_host tls_port
http_access deny all

# Pin the proxy's own resolver; don't let the sandbox's resolv.conf pick it.
dns_nameservers 1.1.1.1 9.9.9.9

# Prompt and completion content never reach proxy state under CONNECT anyway;
# this is defense in depth against a future terminating config, not a fix for
# a present exposure.
cache deny all
# Denied and terminated lines are the audit channel: a denied CONNECT is a
# rejected destination and a terminated bump is an SNI mismatch. An allowed
# line only records the hostname the client asked for, so it can be a
# rotated provider host or stray tooling just as easily as an adversary.
access_log stdio:/var/log/squid/access.log
```

Swap the hostnames per that provider's own allowlist doc when a case targets a
different provider.

The proxy is the permitted door, not the wall. Deny all other egress at the
network layer, including port 53: an adversarial case can open raw sockets, and
a CONNECT proxy means the sandbox needs no direct DNS of its own. On the Docker
topology this config assumes, a host `iptables -A OUTPUT` rule does not do that:
container traffic is forwarded rather than host-originated, so it never reaches
that chain, and Docker's own chains take precedence regardless. Use the
`DOCKER-USER` chain, or an internal user-defined network with the proxy as the
sandbox's only route out, and prove the wall exists with a curl to an unrelated
host from inside the sandbox before spending anything.

The allowlist governs destinations the proxy can observe, and three stay
unobservable by construction. Inside the request body: the mounted credential
lets an injected case ship data out to the provider itself, so the allowlist
contains destinations, not payloads. Inside the tunnel: splicing enforces the
TLS SNI, not the encrypted HTTP Host header, so a frontend serving other
tenants by inner Host on the same address stays reachable in principle. Inside
the ClientHello: the SNI check reads that name in the clear, so an encrypted
ClientHello would move the real destination out of view entirely. The last two
are the frontend operator's control rather than this config's, and today
`dig HTTPS api.anthropic.com` advertises no `ech=` parameter; re-check that
rather than assume it.

A case passes iff `expect_skill` activated and
`forbid_skill` did not; the check itself is deterministic (a name is in the
trace or not), so `--check` is free and repeatable. Live runs default to a
900000 ms per-case timeout; set `LIVE_CASE_TIMEOUT_MS` to an integer from 1 to
2,147,483,647 to override it. Each run writes `<id>.meta.json` beside the trace,
and a nonzero exit, signal, timeout, parent interruption, spawn error, or
truncated capture always fails. Checks also accept legacy trace directories
without metadata.

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
- `--run [RESULTS_DIR] [CORPUS]`: invoke `claude -p` per case (billable, behind
  the same `ACTIVATION_ALLOW_SPEND=1` gate).

Scoring is liveness-first: a trace's terminal `result` event must show
`subtype: "success"`, a falsy `is_error`, `num_turns > 0`, and
`total_cost_usd > 0` before anything else is scored. A non-live run is
`invalid`, never a pass and never a negative, distinct from a real behavioral
failure. Only a live run is checked for activation, and only a live,
activated run is checked against its file assertions.

Run the free process-control fixtures after changing either live runner:

```bash
node skills/skill-activation/scripts/run-live-runner-fixtures.js
```
