---
name: logging-practices
description: "Use when building a new service, endpoint, background job, CLI, script, or external integration, when adding error handling, retries, fallbacks, or external calls, or when adding, reviewing, or fixing logging. Covers reusing the project's logger, which events to log, event shape, levels, secret safety, logs a person or an LLM can diagnose from, and forcing one failure to check the line. Not for diagnosing a live failure (the debugger agent) or an agent's own run logs."
---

# Logging Practices

Disciplines for adding logging that a human or an LLM agent can diagnose a failure from, layered on top of the project's own logging conventions.

Verification (section 9) is mandatory, not advisory: one study found coding agents failed to comply with 67% of constructive logging requests (arXiv 2604.09409), and another found agent-built systems exposed fault-specific signals in at most 13.99% of failures even with logs (arXiv 2607.05785). Each new code path gets a forced failure and a look at the real line.

## 1. Reuse first

Before writing a log call, find what the project already has: the logger, where it is configured, its field names, how levels are used, and how a correlation ID is carried. Then follow it.

- Logging rules in the project's convention docs (its AGENTS.md or CLAUDE.md, a CONTRIBUTING file or style guide, or `.ai-style-rules.md` where [[inherit-legacy-style]] has run) win over this skill, except a convention the requested change cannot keep and still work, and except the library proposal below. Then name the rule you are breaking and what forces it, update that doc in the same change (the instructions file when no doc covers logging), and leave every other convention alone.
- Never add a second logging library, and never rename or reshape field names, event names, or message text that dashboards, queries, or tests may depend on. A test asserting on a log line is a consumer: changing the line and the test together is a breaking change, so say so in your report. Where many tests assert on log output, give them one shared fake logger that records level, event name, and fields.
- Logging with no library behind it, meaning scattered print or console calls or a thin homemade wrapper (no level control, no structured fields, no context binding), gets a library proposal before the first call site, even where a doc describes or blesses the current logging. First search the instructions file and convention docs for `logging library: declined`; a match ends the proposal for good. Otherwise research the choice per [[read-the-damn-docs]]: the standard library's leveled logging module, or the ecosystem's most widely used maintained library where it has none or lacks rotation, preferring one already installed, checked against current docs for the project's runtime. Name it and why, and ask the user. A request that already says to proceed without checking in, or asks for a library, counts as acceptance; approving the feature alone does not. Hand-serializing JSON into print is hand-rolling, not a library.
- Accepted: adopt it and migrate every existing log call in this change, as its own commit. Put the library behind a wrapper the call sites already use, so they keep calling it; replace scattered print calls. List each test touched, per the consumer rule above.
- Declined: append `logging library: declined <library> <YYYY-MM-DD>, keep <current logging>` to the doc that governs logging, else the instructions file, so no later run proposes it again. Keep the current logging and do what it can express; never hand-roll rotation, level filtering, or serialization around it. Name each section 5 to 7 requirement left unmet as a residual risk in your report, and still run section 9.
- A library already in use gets its setup checked against sections 5 to 7 (a level switch, the local rotating file, the deployed sink, redaction), and each gap is filled with the library's own features in this change.
- Write straight to stdout or stderr only where that output is the program's interface (a shell script, or a CLI read at a terminal or through a pipe). A script that runs unattended (a sync job, a cron task, a CI step) gets a logger, which may itself write to stdout or stderr.
- Rewire an existing bespoke log transport (a shipper to a hosted collector, a custom sink) as one of the new logger's outputs rather than replacing it or leaving a second way out. Check the contract the logger's transports receive (rendered line, structured record, or raw bytes), adapt the shipper to it, and verify one real delivery.

Read [references/reuse-first-cases.md](references/reuse-first-cases.md) when the project's logging has no library behind it, has a bespoke transport, has tests that assert on log output, or has a convention that conflicts with the change.

## 2. Name the questions

Before adding any event, write down two to four questions an on-call human or agent will ask about this code, and make every event serve one of them. If you cannot name the questions, you are not ready to log.

```
CODE: nightly import job
QUESTIONS:
1. Did last night's run finish, and how many records did it load or reject?
2. When it failed, which step failed, on which input, and why?
3. Is the upstream API slower or flakier than usual?
```

## 3. Where to log

Failure points come first: error branches, retries, fallbacks, external-call boundaries, and state transitions. A silent fallback is the most common way a system hides its own failures, so each one gets a line.

- Emit one wide summary event per unit of work (a request, a job run, a CLI invocation) when it ends, carrying the outcome, the duration, the identifiers, and the version. If no version is available, plumb a build identifier (commit SHA, image tag) to the entry point (usually a one-line change and worth making); where it truly is not available, leave the field out and say so, never a placeholder.
- Add per-item lines only for failures.
- Log nothing inside hot loops. Count there and report the count in the summary event.
- Log an error once, at the layer that handles it.
- Code on someone else's machine (browser, mobile or desktop client, installed CLI) logs to its own console and stops there, under the same event shape and safety rules. Shipping those lines to a server is a separate feature to propose as its own change. Until then, the server logs every boundary the client crosses on the way in.

Read [references/event-context-details.md](references/event-context-details.md) when writing client-side logging, or before the first log line that follows work across an async, queue, or cross-process handoff (detached task, background promise, worker callback, executor).

## 4. Event shape

Log events, not prose. Each line has a stable snake_case event name and structured fields in whatever format the project already uses.

```
# prose: unqueryable, and every instance reads differently
msg="could not load customer 4821 after 3 tries, giving up"

# event: stable name, structured fields
level=error event=customer_load_failed run_id=r-7f3a entry_point=nightly_import customer_id=4821 attempts=3 error_type=timeout error_msg="upstream read timed out after 30s" next_action="check upstream status, then rerun with --only 4821"
```

Include, where they apply:

- A correlation ID created or accepted where the work starts, attached to every line of that unit of work, plus the entry point that started it, carried across every boundary the ID crosses (queue metadata, request headers, detached tasks, worker callbacks). Use the runtime's own context mechanism rather than threading a parameter, check what it does at the handoff (a JVM MDC is thread-local and does not follow the work), and prove it by reading a line emitted on the far side of the boundary. Details are in the event-context reference above.
- The error type or code and a short message.
- Identifiers of the inputs involved, not their raw values.
- What was being attempted when it failed.
- A next-action hint when one is known.

## 5. Levels and volume

Use the project's level scheme and its existing level switch, such as a `LOG_LEVEL` environment variable or a config setting. When it has none written down, pick the level by who has to act.

| Level | Meaning | Action |
|---|---|---|
| error | An invariant broke or an operation failed for good; someone may need to act | Investigate |
| warn | Degraded but handled: a retry succeeded, a fallback was used | Watch for trends |
| info | A significant business event, such as a job finishing or an order placed | None |
| debug | Diagnostic detail | Off by default in production |

- A caller's bad input, such as a validation failure or a 4xx response, is warn or info, not error.
- An expected, handled upstream failure is warn. Each retry is warn. When retries run out and the operation fails for good, that is one error line, logged where it is handled; when a fallback then succeeds, the outcome stays warn.
- At info, emit the unit-of-work summary plus real state changes, such as a job starting or a config reload. Step-by-step and per-item detail is debug.
- A health check or polling endpoint is not a unit of work worth a line each time: its successful call goes to debug and only its failures stay at warn or above.
- The threshold that filters levels comes from the level switch, never a hardcoded value. Never ship debug on by default, and remove temporary troubleshooting lines before the work is done.

## 6. Where logs go

One logger, two outputs, both configured where the logger is set up.

- The console is for the person running the code: readable, and colored only when the output is a terminal.
- In local development, also write structured one-event-per-line output to a file at a stable path such as `logs/app.log`, using the library's own rotating file handler with a size cap (never a hand-written rotator), with the whole log directory gitignored. Record the path in the project's instructions file (AGENTS.md, CLAUDE.md) and confirm it is the name the handler really maintains. Detect local development from the signal the project already uses.
- A deployed service writes to stdout and lets the platform collect it. Where the deployment has durable storage and no collector, a rotating file with a size cap and a retention limit is an acceptable second sink; an unbounded file on a disk nothing reads is not.

Read [references/sinks-and-safety-details.md](references/sinks-and-safety-details.md) before configuring a log file or deployed sink. Section 7's safety rules apply to the local file as much as to production output.

## 7. Safety

Logs outlive the code that wrote them and travel to systems with wider access than the service had, so treat every field as something someone not meant to see it will read.

- Never log secrets, tokens, passwords, session IDs, connection strings, or full personal data. Build each event from an allowlist of fields rather than dumping an object or a whole request or response body.
- Treat error messages, stack traces, and URLs as untrusted text: log the error type and code, strip query strings, and keep a raw message only after checking what it can contain.
- To correlate events about one person, log an opaque ID the system already has or a keyed HMAC whose key stays out of the logs. Never log a plain hash.
- Turn on the library's own redaction for known sensitive field names as a backstop, configured with the exact field names or paths the project emits, and check it against the fields you actually emit. The allowlist remains the primary control.
- Scrub the secret values the process holds (read when the logger is configured) from the rendered line, as well as the field names.
- Neutralize newlines and other control characters in any user-controlled value, since a line break can forge a second log line.
- Bound the length of every free-text field and mark the cut, for example `...[truncated 4096 bytes]`.

Read [references/sinks-and-safety-details.md](references/sinks-and-safety-details.md) before configuring redaction, hashing, masking, or deriving identifiers, or logging user-controlled values.

## 8. Logs an LLM can use

An agent debugging a failure reads the log with a search tool and a short attention span. These choices help a human reader equally.

- One event per line, with any stack trace kept inside a single field of that line (newlines escaped).
- Stable, greppable keys and event names, so a later rename does not silently strand old queries.
- The same field name for the same thing everywhere in the codebase (`customer_id`, not `cust` in another module).
- A bounded line size, so one line cannot swamp a reader's context.
- The cause and the next action in the line itself, not only in a stack trace.
- No ANSI color codes or spinner redraws when the output is not a terminal.
- Timestamps in UTC ISO-8601.

## 9. Verify

Logging is code and can be wrong, so check the output rather than the call.

1. For each new or changed code path, force one real failure: a bad input, a stubbed timeout, a blocked dependency.
2. Capture the real emitted line, not the logging call as written.
3. Check that the line alone tells you what failed, where, which identifiers were involved, and what to do next, without opening the source.
4. Spot-check the captured output for secrets, personal data, and unescaped user input, including inside error messages.

When a plan adds a new entry point or a new failure path, the plan step carries this as its verify clause (see [[plan-and-track]]), so completion is judged on the forced-failure line.

## 10. Red flags

- A new retry, queue, fallback, or external call with no new log line.
- Print or echo calls where a logger already exists.
- A catch that swallows an error, or turns it into a null or a bare status code, without a line carrying the cause.
- Hand-rolled log rotation, level filtering, or event serialization written around a thin wrapper, where adopting the logging library would have supplied the missing piece.
- Print calls or a homemade wrapper left in place with no library proposed, or a library proposed again after a recorded `logging library: declined` line.
- One sink fed by several entry points with no field naming which one wrote the line.
- A deployed service writing log files with no rotation, retention limit, or reader, or a local log file that git would commit.
- Logging that was never exercised: no forced failure and no captured line.

Diagnosing a failure happening now is the debugger agent's job ([[efficient-frontier]]'s roster), not this skill's; this skill makes that diagnosis possible next time.
