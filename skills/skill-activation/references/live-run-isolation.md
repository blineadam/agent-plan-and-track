# Live-run isolation and limits

Covers the billable `--run` modes of `run-activation-cases.js` and
`run-behavioral-smokes.js`; [[skill-comply]] reaches it through this skill's
isolation section. The Squid proxy recipe is the separate reference that
SKILL.md names.

## Isolation

Each live case is a real, tool-executing agent process, and a forbid,
competing, or prompt-injected scenario will run tool calls. Run inside a
container/VM with restricted mounts, and never pass
`--dangerously-skip-permissions`: it would let an injected scenario reach the
home dir, credentials, and network unattended. A `mktemp -d` is a working
directory, not a sandbox.

`run-activation-cases.js --run` refuses to start unless
`ACTIVATION_ALLOW_SPEND=1`. It also fixes `--permission-mode default` in its
own argv, which overrides `defaultMode` from settings files (short of a
Managed-scope `managed-settings.json`, which the documented setup path never
creates), so the `PT_BYPASS_PERMISSIONS=1` sandbox-HOME install used for
behavioral-smoke roster cases cannot silently escalate this run's posture.

Any other `claude -p` loop (skill-comply's, for example) pins
`--permission-mode default` in the command itself. Without it a sandbox HOME's
own `defaultMode` governs, which could be a bypass posture. Under `default` an
ask-gated call is denied outright rather than queued for approval, which is
the wanted outcome; don't reach for `--permission-prompt-tool` to soften that,
since it hands the approval decision to an MCP server an injected scenario is
trying to reach in the first place. If you can't containerize, fall back on an
explicit tool allowlist rather than on approving prompts by hand: print mode
cannot show a permission prompt at all.

## Egress

Restrict egress to the model provider's API rather than sealing it off. A
sealed sandbox is not the stricter choice: the case cannot reach the API, so
it exits at zero turns having activated nothing, which is an invalid run
rather than a passing negative. An allowlisting forward proxy gives the
isolation without that failure mode. Point the sandbox's
`HTTPS_PROXY`/`HTTP_PROXY` at it and keep the credential mounted in the
sandbox rather than baked into the proxy.

## Timeout and run metadata

Live runs of both runners default to a 900000 ms per-case timeout; set
`LIVE_CASE_TIMEOUT_MS` to an integer from 1 to 2,147,483,647 to override it.

For `run-activation-cases.js`, each run writes `<id>.meta.json` beside the
trace, and a nonzero exit, signal, timeout, parent interruption, spawn error,
or truncated capture always fails. Checks also accept legacy trace directories
without metadata.
