# Reuse first: cases in detail

Read this when the project has a thin homemade wrapper, a bespoke log transport, tests that assert on log output, no logger at all, or a convention doc that conflicts with what the change needs. SKILL.md section 1 carries the rules in short form; this file carries the full text.

## A convention the change cannot keep

Logging rules in `.ai-style-rules.md` or another convention doc win over anything in this skill. The one exception is a convention the requested change cannot keep and still work: a doc mandating prose-only messages has nowhere to put the correlation ID and the timings someone just asked for. That is a convention change, not a quiet judgment call. Name the rule you are breaking and what forces it, update the convention doc in the same change so the next session inherits the new rule instead of the old one, and leave every convention the change does not actually block alone.

## Field names, event names, and tests that assert on logs

Never add a second logging library, and never rename or reshape the field names, event names, or message text that existing dashboards, queries, or tests may depend on. A test asserting on a log line is a consumer like any other, so changing the line and updating the test to match is a breaking change rather than a test fix: when the work needs it anyway, say so in your report instead of letting the green suite imply nothing broke. Where many tests assert on log output, give them one shared fake logger that records level, event name, and fields, so they assert on a field instead of a formatted string; that is one edit rather than a hundred, and it stops the next reshape from breaking them again.

## Thin homemade wrapper

A thin homemade wrapper around print or console (no level control, no structured fields, no context binding) still gets used inside a feature change, so one change does not split the codebase across two loggers. Unless a convention doc records the wrapper as deliberate, say in your report that an established library would replace it, as its own change, naming the library.

Keeping that wrapper stops being the smaller change the moment this skill's own requirements need machinery it does not have: a level switch (section 5), a rotating file sink (section 6), or field redaction (section 7). Needing one of those is the trigger to adopt the library in this change, not to build the missing piece around the wrapper. Hand-rolled rotation, level filtering, or serialization is more new code, and more untested code, than the dependency it avoids, and it is the one part of a logging change nobody reviews closely. A convention doc that blesses the wrapper settles which logger the call sites use; it does not oblige you to reimplement a log rotator.

## No logger, or print-only ecosystems

Scattered print or console calls with no shared module count as no logger, even when a logging library sits unused in the dependencies. With no logger at all, use the standard library's leveled logging module, or a well-established logging library when the standard library offers none, preferring one already installed. A print or console primitive is not a logging module, and serializing JSON into one by hand is still hand-rolling. Where only print or console ships with the language, adding the ecosystem's most widely used logging library is a dependency worth taking.

## Direct stdout and stderr

Writing straight to stdout or stderr is fine only where that output is the program's interface: a shell script, or a CLI whose output a person reads at a terminal or another program consumes through a pipe. A script that runs unattended, such as a sync job, a cron task, or a CI step, is a unit of work and gets a logger. A logger's own sink may legitimately be stdout or stderr (containers and twelve-factor apps do this); the rule is about not bypassing a logger, not about where the logger writes.

## Existing bespoke transport

An existing bespoke log transport, a shipper to a hosted collector or a custom sink, is rewired rather than replaced: it becomes one of the new logger's outputs instead of a second way out of the process. Read the contract the chosen logger's transports actually get, since it varies: some are handed a rendered line, others a structured record, others raw bytes. Adapt the shipper to that shape and check one real delivery, because a shipper fed the wrong shape flattens its fields or fails quietly in production, where nobody is reading its own errors.
