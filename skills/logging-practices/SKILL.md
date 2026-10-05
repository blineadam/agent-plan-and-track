---
name: logging-practices
description: "Use when building a new service, endpoint, background job, CLI, script, or external integration, when adding error handling, retries, fallbacks, or external calls, or when adding, reviewing, or fixing logging. Covers reusing the project's logger, which events to log, event shape, levels, secret safety, logs a person or an LLM can diagnose from, and forcing one failure to check the line. Not for diagnosing a live failure (the debugger agent) or an agent's own run logs."
---

# Logging Practices

Disciplines for adding logging that a human or an LLM agent can diagnose a failure from, layered on top of the project's own logging conventions. This skill is adapted from the structured-logging parts of the observability-and-instrumentation skill in [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT, Copyright (c) 2025 Addy Osmani): the on-call questions, the levels table, the correlation ID and entry-point fields, the no-secrets rule, and verifying the telemetry itself. Its metrics, tracing, and alerting sections are out of scope here. The wide summary event, the log-injection rule, and the canonical-log-line idea come from public writing on those topics and are restated in this skill's own words, and the section on logs an LLM can use is original.

Verification below is mandatory rather than advisory for a measured reason. One study found coding agents failed to comply with 67% of constructive logging requests (arXiv 2604.09409, whose authors suggest deterministic guardrails), and another found agent-built systems exposed fault-specific signals in at most 13.99% of failures even when they had logs (arXiv 2607.05785). Logging that was merely asked for or merely present is not logging that works, so each new code path gets a forced failure and a look at the real line.

## 1. Reuse first

Before writing a log call, find what the project already has: the logger, where it is configured, its field names, how levels are used, and how a correlation ID is carried. Then follow it.

- Logging rules in `.ai-style-rules.md` or another convention doc win over anything in this skill.
- Never add a second logging library, and never rename or reshape fields that existing dashboards, queries, or tests may depend on.
- Scattered print or console calls with no shared module count as no logger, even when a logging library sits unused in the dependencies.
- A thin homemade wrapper around print or console (no level control, no structured fields, no context binding) still gets used inside a feature change, so one change does not split the codebase across two loggers. Unless a convention doc records the wrapper as deliberate, say in your report that an established library would replace it, as its own change, naming the library.
- With no logger at all, use the language's standard logging facility or a well-established logging library, preferring one already installed. Do not hand-roll print or echo calls.
- Writing straight to stdout or stderr is fine only where that is the accepted convention, such as a shell script or a small CLI whose stdout is its output contract. Diagnostics then go to stderr so they never corrupt the output.
- A logger's own sink may legitimately be stdout or stderr (containers and twelve-factor apps do this). The rule is about not bypassing a logger, not about where the logger writes.

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

- Emit one wide summary event per unit of work (a request, a job run, a CLI invocation) when it ends, carrying the outcome, the duration, the identifiers, and the version. One line then answers most questions about that run, and it is the first thing to grep.
- Add per-item lines only for failures. A successful item does not need its own line.
- Log nothing inside hot loops. Count there and report the count in the summary event.
- Log an error once, at the layer that handles it. A line at every layer it passes through turns one failure into a dozen interchangeable lines.

## 4. Event shape

Log events, not prose. Each line has a stable snake_case event name and structured fields in whatever format the project already uses.

```
# prose: unqueryable, and every instance reads differently
msg="could not load customer 4821 after 3 tries, giving up"

# event: stable name, structured fields
level=error event=customer_load_failed run_id=r-7f3a entry_point=nightly_import customer_id=4821 attempts=3 error_type=timeout error_msg="upstream read timed out after 30s" next_action="check upstream status, then rerun with --only 4821"
```

Include, where they apply:

- A correlation ID created or accepted where the work starts and attached to every line of that unit of work, plus the entry point that started it. When one log sink is written by several entry points (a scheduler, a replay endpoint, a manual CLI run), the correlation ID alone does not say which path produced a line. Stamp the entry point next to the ID and carry both across every boundary the ID crosses, such as queue metadata or request headers.
- The error type or code and a short message.
- Identifiers of the inputs involved, not their raw values.
- What was being attempted when it failed.
- A next-action hint when one is known.

## 5. Levels

Use the project's level scheme. When it has none written down, this is a sound default.

| Level | Meaning | Action |
|---|---|---|
| error | An invariant broke or an operation failed for good; someone may need to act | Investigate |
| warn | Degraded but handled: a retry succeeded, a fallback was used | Watch for trends |
| info | A significant business event, such as a job finishing or an order placed | None |
| debug | Diagnostic detail | Off by default in production |

## 6. Safety

Logs outlive the code that wrote them and travel to systems with wider access than the service had, so treat every field as something that will be read by someone who was not meant to see it.

- Never log secrets, tokens, passwords, session IDs, connection strings, or full personal data. Build each event from an allowlist of fields rather than dumping an object or a whole request or response body.
- Neutralize newlines and other control characters in any value a user controls. A value that contains a line break can forge a second, fake log line. Escape the break (write `\n` as two characters) or encode the value, rather than trusting the input to be a single line.
- Bound the length of every free-text field and mark the cut, for example a trailing `...[truncated 4096 bytes]`, so one oversized value cannot bury the line or blow the sink's size limit.

## 7. Logs an LLM can use

An agent debugging a failure reads the log the way a person does with a search tool and a short attention span. These choices help a human reader equally.

- One event per line, with any stack trace kept inside a single field of that line (newlines escaped) rather than spilling across many lines that a line-based search cuts apart.
- Stable, greppable keys and event names, so one search finds every occurrence of an event and a later rename does not silently strand old queries.
- The same field name for the same thing everywhere in the codebase. `customer_id` in one module and `cust` in another forces an agent to guess that they match.
- A bounded line size, so one line cannot swamp a reader's context.
- The cause and the next action in the line itself, not only in a stack trace the reader has to decode.
- No ANSI color codes or spinner redraws when the output is not a terminal, since they arrive as escape garbage in a captured log.
- Timestamps in UTC ISO-8601, so lines from different hosts order correctly without a timezone guess.

## 8. Verify

Logging is code and can be wrong, so check the output rather than the call.

1. For each new or changed code path, force one real failure: a bad input, a stubbed timeout, a blocked dependency.
2. Capture the real emitted line, not the logging call as written.
3. Check that the line alone tells you what failed, where, which identifiers were involved, and what to do next, without opening the source.
4. Spot-check the captured output for secrets and for unescaped user input.

When a plan adds a new entry point or a new failure path, the plan step carries this as its verify clause (see [[plan-and-track]]), so completion is judged on the forced-failure line.

## 9. Red flags

- A new retry, queue, fallback, or external call with no new log line.
- Log messages built by string interpolation instead of structured fields.
- A second logging library, or print and echo calls where a logger already exists.
- No correlation ID, so each line is an orphan.
- One sink fed by several entry points with no field naming which one wrote the line.
- A catch that swallows an error, or turns it into a null or a bare status code, without a line carrying the cause.
- The same error logged at every layer it propagates through.
- Secrets, tokens, or whole request bodies in output.
- A raw user-supplied value written into a line without escaping.
- Logging that was never exercised: no forced failure and no captured line.

Diagnosing a failure that is happening now is the debugger agent's job, covered by [[efficient-frontier]]'s roster, not this skill's. This skill is about making that diagnosis possible next time.
