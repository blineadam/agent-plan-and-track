---
name: logging-practices
description: "Use when building a new service, endpoint, background job, CLI, script, or external integration, when adding error handling, retries, fallbacks, or external calls, or when adding, reviewing, or fixing logging. Covers reusing the project's logger, which events to log, event shape, levels, secret safety, logs a person or an LLM can diagnose from, and forcing one failure to check the line. Not for diagnosing a live failure (the debugger agent) or an agent's own run logs."
---

# Logging Practices

Disciplines for adding logging that a human or an LLM agent can diagnose a failure from, layered on top of the project's own logging conventions. This skill is adapted from the structured-logging parts of the observability-and-instrumentation skill in [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT, Copyright (c) 2025 Addy Osmani): the on-call questions, the levels table, the correlation ID and entry-point fields, the no-secrets rule, and verifying the telemetry itself. Its metrics, tracing, and alerting sections are out of scope here. The wide summary event, the log-injection rule, and the canonical-log-line idea come from public writing on those topics and are restated in this skill's own words, and the section on logs an LLM can use is original.

Verification below is mandatory rather than advisory for a measured reason. One study found coding agents failed to comply with 67% of constructive logging requests (arXiv 2604.09409, whose authors suggest deterministic guardrails), and another found agent-built systems exposed fault-specific signals in at most 13.99% of failures even when they had logs (arXiv 2607.05785). Logging that was merely asked for or merely present is not logging that works, so each new code path gets a forced failure and a look at the real line.

## 1. Reuse first

Before writing a log call, find what the project already has: the logger, where it is configured, its field names, how levels are used, and how a correlation ID is carried. Then follow it.

- Logging rules in `.ai-style-rules.md` or another convention doc win over anything in this skill. The one exception is a convention the requested change cannot keep and still work: a doc mandating prose-only messages has nowhere to put the correlation ID and the timings someone just asked for. That is a convention change, not a quiet judgment call. Name the rule you are breaking and what forces it, update the convention doc in the same change so the next session inherits the new rule instead of the old one, and leave every convention the change does not actually block alone.
- Never add a second logging library, and never rename or reshape the field names, event names, or message text that existing dashboards, queries, or tests may depend on. A test asserting on a log line is a consumer like any other, so changing the line and updating the test to match is a breaking change rather than a test fix: when the work needs it anyway, say so in your report instead of letting the green suite imply nothing broke. Where many tests assert on log output, give them one shared fake logger that records level, event name, and fields, so they assert on a field instead of a formatted string; that is one edit rather than a hundred, and it stops the next reshape from breaking them again.
- Scattered print or console calls with no shared module count as no logger, even when a logging library sits unused in the dependencies.
- A thin homemade wrapper around print or console (no level control, no structured fields, no context binding) still gets used inside a feature change, so one change does not split the codebase across two loggers. Unless a convention doc records the wrapper as deliberate, say in your report that an established library would replace it, as its own change, naming the library.
- Keeping that wrapper stops being the smaller change the moment this skill's own requirements need machinery it does not have: a level switch (section 5), a rotating file sink (section 6), or field redaction (section 7). Needing one of those is the trigger to adopt the library in this change, not to build the missing piece around the wrapper. Hand-rolled rotation, level filtering, or serialization is more new code, and more untested code, than the dependency it avoids, and it is the one part of a logging change nobody reviews closely. A convention doc that blesses the wrapper settles which logger the call sites use; it does not oblige you to reimplement a log rotator.
- With no logger at all, use the standard library's leveled logging module, or a well-established logging library when the standard library offers none, preferring one already installed. A print or console primitive is not a logging module, and serializing JSON into one by hand is still hand-rolling. Where only print or console ships with the language, adding the ecosystem's most widely used logging library is a dependency worth taking.
- Writing straight to stdout or stderr is fine only where that output is the program's interface: a shell script, or a CLI whose output a person reads at a terminal or another program consumes through a pipe. A script that runs unattended, such as a sync job, a cron task, or a CI step, is a unit of work and gets a logger.
- A logger's own sink may legitimately be stdout or stderr (containers and twelve-factor apps do this). The rule is about not bypassing a logger, not about where the logger writes.
- An existing bespoke log transport, a shipper to a hosted collector or a custom sink, is rewired rather than replaced: it becomes one of the new logger's outputs instead of a second way out of the process. Check what it now receives, since a wrapper that used to be handed a message and a level is now handed a rendered line, and a shipper fed the wrong shape fails quietly in production where nobody is reading its own errors.

## 2. Name the questions

Logging without a question is noise. Before adding any event, write down two to four questions that an on-call human or agent will ask about this code, and make every event serve one of them.

```
CODE: nightly import job
QUESTIONS:
1. Did last night's run finish, and how many records did it load or reject?
2. When it failed, which step failed, on which input, and why?
3. Is the upstream API slower or flakier than usual?
```

If you cannot name the questions, you are not ready to log, and you will write a lot of lines that answer nothing.

## 3. Where to log

Failure points come first: error branches, retries, fallbacks, external-call boundaries, and state transitions. A silent fallback is the most common way a system hides its own failures, so each one gets a line.

- Emit one wide summary event per unit of work (a request, a job run, a CLI invocation) when it ends, carrying the outcome, the duration, the identifiers, and the version. One line then answers most questions about that run, and it is the first thing to grep. When the process has no version to report, plumbing a build identifier such as a commit SHA or an image tag through to the entry point is usually a one-line change and worth making; where it truly is not available, leave the field out and say so, rather than stamping a placeholder that a reader will believe.
- Add per-item lines only for failures. A successful item does not need its own line.
- Log nothing inside hot loops. Count there and report the count in the summary event.
- Log an error once, at the layer that handles it. A line at every layer it passes through turns one failure into a dozen interchangeable lines.
- Code running on someone else's machine (a browser page, a mobile or desktop client, a CLI the user installed) logs to its own console and stops there. The same event shape and the same safety rules apply, more strictly if anything, since the user and everything else on that machine can read every line. Shipping those lines back to a server is a separate feature carrying its own endpoint, abuse surface, retention period, and consent question, so propose it as its own change rather than folding it into the one in front of you. Until it exists, the client's retries and fallbacks are invisible from the server, which makes it the server's job to log every boundary the client crosses on the way in: the refused upload, the re-issued URL, the session that never completed.

## 4. Event shape

Log events, not prose. Each line has a stable snake_case event name and structured fields in whatever format the project already uses.

```
# prose: unqueryable, and every instance reads differently
msg="could not load customer 4821 after 3 tries, giving up"

# event: stable name, structured fields
level=error event=customer_load_failed run_id=r-7f3a entry_point=nightly_import customer_id=4821 attempts=3 error_type=timeout error_msg="upstream read timed out after 30s" next_action="check upstream status, then rerun with --only 4821"
```

Include, where they apply:

- A correlation ID created or accepted where the work starts and attached to every line of that unit of work, plus the entry point that started it. When one log sink is written by several entry points (a scheduler, a replay endpoint, a manual CLI run), the correlation ID alone does not say which path produced a line. Stamp the entry point next to the ID and carry both across every boundary the ID crosses, such as queue metadata or request headers. The boundary most often dropped is the one inside the process: work that outlives the response that started it, a detached task, a background promise, a worker callback, where nothing in the signature forces the ID through. Carry it with the runtime's own context mechanism (`AsyncLocalStorage` in Node, `contextvars` in Python, an MDC in the JVM) rather than threading a parameter down every intervening function, which is the version that gets dropped at the first call site someone forgets to update.
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

- A caller's bad input, such as a validation failure or a 4xx response, is warn or info, not error. Nothing in this system broke.
- An expected, handled upstream failure is warn. Each retry is warn. When retries run out and the operation fails for good, that is one error line, logged where it is handled; when a fallback then succeeds, the outcome stays warn.
- At info, emit the unit-of-work summary plus real state changes, such as a job starting or a config reload. Step-by-step and per-item detail is debug, which stays off in production.
- A health check or a polling endpoint is the exception to that summary. A client asking the same question every two seconds is not a unit of work worth a line each time, so its successful call goes to debug and only its failures stay at warn or above. Otherwise one poller buries every other event in the sink.
- Each call site picks its event's level, but the threshold that filters them comes from the level switch, never a hardcoded value. Never ship debug on by default, and remove temporary troubleshooting lines before the work is done.

## 6. Where logs go

One logger, two outputs, both configured where the logger is set up.

- The console is for the person running the code: readable, and colored only when the output is a terminal.
- When a service or job runs in local development, also write structured one-event-per-line output to a file at a stable path such as `logs/app.log`. Use the library's own rotating file handler with a size cap (when nothing in the project provides one, that is section 1's trigger to adopt a logging library, not a reason to write a rotator), and gitignore the whole log directory so rotated backups such as `app.log.1` are covered too. Record the path in the project's instructions file (AGENTS.md, CLAUDE.md) so an agent reads the file instead of asking for pasted terminal output, and confirm that path is the one the logger really produces: a rotating handler that appends its own suffix leaves nothing at the name you documented, so point the docs at a stable name the handler maintains. Decide what counts as local development from the signal the project already uses (`NODE_ENV`, a config profile, a deployment flag) rather than inventing one; if the server side has none, adding it is part of this change and belongs in the deployment config too.
- A deployed service writes to stdout and lets the platform collect it, because a container's or a function's disk is short-lived or read-only and anything written there is lost with the instance. Where the deployment genuinely has durable storage and no collector, such as a single host with a mounted volume, a rotating file with a size cap and a retention limit is a reasonable second sink rather than a violation. What this rules out is an unbounded file on a disk that nothing reads and nothing keeps.

The safety rules in section 7 apply to the local file as much as to production output.

## 7. Safety

Logs outlive the code that wrote them and travel to systems with wider access than the service had, so treat every field as something that will be read by someone who was not meant to see it.

- Never log secrets, tokens, passwords, session IDs, connection strings, or full personal data. Build each event from an allowlist of fields rather than dumping an object or a whole request or response body.
- Treat error messages, stack traces, and URLs as untrusted text. A database or validation error often quotes the offending value, such as an email address, and a URL's query string can carry a token. Log the error type and code, strip query strings, and keep a raw message only after checking what it can contain.
- When events about one person need correlating, log an opaque ID the system already has, such as the internal user ID, or a keyed HMAC whose key stays out of the logs. Never log a plain hash: anyone can hash candidate emails or phone numbers and match the digest. Mask a value only when the visible part cannot identify the person, and treat any derived identifier as sensitive data too.
- Turn on the logging library's own redaction for known sensitive field names (password, token, authorization, cookie, email) as a backstop. The allowlist is still the primary control, since redaction only catches the names it knows. Match those names on whole word segments rather than as substrings: a pattern that fires on `token` anywhere also eats `input_tokens` and `token_count`, and a field quietly replaced by `[REDACTED]` is a diagnostic you will not notice losing. Check the backstop against the field names you actually emit, not only against the ones it is meant to catch.
- Scrub the secret values as well as the field names. Read the credentials the process already holds, its API keys, tokens, and connection strings, when the logger is configured, and strip any occurrence of them from the rendered line. Name-based rules only cover fields someone labelled correctly; this is the layer that catches a key quoted back inside an upstream error message, embedded in a URL, or passed by a call site that did not know what it was holding.
- Neutralize newlines and other control characters in any value a user controls. A value that contains a line break can forge a second, fake log line. Escape the break (write `\n` as two characters) or encode the value, rather than trusting the input to be a single line.
- Bound the length of every free-text field and mark the cut, for example a trailing `...[truncated 4096 bytes]`, so one oversized value cannot bury the line or blow the sink's size limit.

## 8. Logs an LLM can use

An agent debugging a failure reads the log the way a person does with a search tool and a short attention span. These choices help a human reader equally.

- One event per line, with any stack trace kept inside a single field of that line (newlines escaped) rather than spilling across many lines that a line-based search cuts apart.
- Stable, greppable keys and event names, so one search finds every occurrence of an event and a later rename does not silently strand old queries.
- The same field name for the same thing everywhere in the codebase. `customer_id` in one module and `cust` in another forces an agent to guess that they match.
- A bounded line size, so one line cannot swamp a reader's context.
- The cause and the next action in the line itself, not only in a stack trace the reader has to decode.
- No ANSI color codes or spinner redraws when the output is not a terminal, since they arrive as escape garbage in a captured log.
- Timestamps in UTC ISO-8601, so lines from different hosts order correctly without a timezone guess.

## 9. Verify

Logging is code and can be wrong, so check the output rather than the call.

1. For each new or changed code path, force one real failure: a bad input, a stubbed timeout, a blocked dependency.
2. Capture the real emitted line, not the logging call as written.
3. Check that the line alone tells you what failed, where, which identifiers were involved, and what to do next, without opening the source.
4. Spot-check the captured output for secrets, personal data, and unescaped user input, including inside error messages.

When a plan adds a new entry point or a new failure path, the plan step carries this as its verify clause (see [[plan-and-track]]), so completion is judged on the forced-failure line.

## 10. Red flags

- A new retry, queue, fallback, or external call with no new log line.
- Log messages built by string interpolation instead of structured fields.
- A second logging library, or print and echo calls where a logger already exists.
- Hand-rolled log rotation, level filtering, or event serialization written around a thin wrapper, where adopting the logging library would have supplied all three.
- No correlation ID, so each line is an orphan.
- One sink fed by several entry points with no field naming which one wrote the line.
- A catch that swallows an error, or turns it into a null or a bare status code, without a line carrying the cause.
- The same error logged at every layer it propagates through.
- Secrets, tokens, or whole request bodies in output.
- A deployed service writing log files with no rotation, no retention limit, or no reader, or a local log file that git would commit.
- A raw user-supplied value written into a line without escaping.
- Logging that was never exercised: no forced failure and no captured line.

Diagnosing a failure that is happening now is the debugger agent's job, covered by [[efficient-frontier]]'s roster, not this skill's. This skill is about making that diagnosis possible next time.
