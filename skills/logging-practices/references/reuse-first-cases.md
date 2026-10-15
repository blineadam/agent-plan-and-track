# Reuse first: cases in detail

Read this when the project's logging has no library behind it (scattered print calls or a thin homemade wrapper), has a bespoke log transport, has tests that assert on log output, or has a convention doc that conflicts with what the change needs. SKILL.md section 1 carries the rules in short form; this file carries the full text.

## A convention the change cannot keep

Logging rules in the project's convention docs win over anything in this skill. Which docs those are varies by project: its AGENTS.md or CLAUDE.md, a CONTRIBUTING file, a style guide under docs/, or `.ai-style-rules.md` where the inherit-legacy-style skill has run; none of them is guaranteed to exist. There are two exceptions. The first is a convention the requested change cannot keep and still work: a doc mandating prose-only messages has nowhere to put the correlation ID and the timings someone just asked for. That is a convention change, not a quiet judgment call. Name the rule you are breaking and what forces it, update the doc in the same change (the instructions file when no doc covers logging) so the next session inherits the new rule instead of the old one, and leave every convention the change does not actually block alone. The second is the library proposal below, which a doc blessing the current logging does not suppress.

## Field names, event names, and tests that assert on logs

Never add a second logging library, and never rename or reshape the field names, event names, or message text that existing dashboards, queries, or tests may depend on. A test asserting on a log line is a consumer like any other, so changing the line and updating the test to match is a breaking change rather than a test fix: when the work needs it anyway, say so in your report instead of letting the green suite imply nothing broke. Where many tests assert on log output, give them one shared fake logger that records level, event name, and fields, so they assert on a field instead of a formatted string; that is one edit rather than a hundred, and it stops the next reshape from breaking them again.

## No library yet: propose, then migrate or record the decline

Logging with no library behind it covers two shapes. Scattered print or console calls with no shared module count as no logger, even when a logging library sits unused in the dependencies. A thin homemade wrapper around print or console (no level control, no structured fields, no context binding) is a logger in name only. A print or console primitive is not a logging module, and serializing JSON into one by hand is still hand-rolling.

Both get a library proposal before the first call site is written, and a doc that describes or blesses the current logging does not suppress it: a doc records what the project does, not that someone weighed a library and turned it down. Only a recorded decline does that, so search the instructions file and convention docs for the marker `logging library: declined` first, and when it matches, skip the proposal for good.

Research the choice rather than recalling it, per [[read-the-damn-docs]]: the standard library's leveled logging module, or the ecosystem's most widely used maintained library where the standard library has none or lacks rotation, preferring one already installed. Check it against current docs for the project's runtime version, for built-in level filtering and rotation (directly or through a maintained companion package), and for redaction. Then name the library and the reason in one or two sentences, and ask. A request that already says to proceed without checking in, or that asks for a library, counts as acceptance; approval of the feature alone does not, since a new dependency is a decision of its own.

On acceptance, adopt the library and migrate every existing log call in this change, as its own commit, so the feature's diff stays readable. Where call sites go through a wrapper, put the library behind it so they keep calling it as the convention requires; replace scattered print calls directly. Tests that assert on log lines are consumers, so list each one the migration touched.

On a decline, append one line to the doc that already governs logging, or to the instructions file (AGENTS.md, CLAUDE.md) when none does: `logging library: declined <library> <YYYY-MM-DD>, keep <current logging>`. That fixed phrase is what the next run searches for, wherever the line ends up; only the user removing it reopens the question. Keep the current logging and do what it can express. Never build rotation, level filtering, or serialization around it, since that is more new and less reviewed code than the dependency it avoids. Name each section 5 to 7 requirement it cannot meet as a residual risk in your report, and still force a failure and read the line per section 9.

## A library already in use

A library already in place is reused, and its setup is checked against sections 5 to 7: the threshold read from a level switch, a rotating file with a size cap in local development, the deployed sink, and redaction for the field names the project emits. Fill each gap in this change with the library's own features or a maintained companion package for it, never a hand-written piece, and say in your report which gaps you filled.

## Direct stdout and stderr

Writing straight to stdout or stderr is fine only where that output is the program's interface: a shell script, or a CLI whose output a person reads at a terminal or another program consumes through a pipe. A script that runs unattended, such as a sync job, a cron task, or a CI step, is a unit of work and gets a logger. A logger's own sink may legitimately be stdout or stderr (containers and twelve-factor apps do this); the rule is about not bypassing a logger, not about where the logger writes.

## Existing bespoke transport

An existing bespoke log transport, a shipper to a hosted collector or a custom sink, is rewired rather than replaced: it becomes one of the new logger's outputs instead of a second way out of the process. Read the contract the chosen logger's transports actually get, since it varies: some are handed a rendered line, others a structured record, others raw bytes. Adapt the shipper to that shape and check one real delivery, because a shipper fed the wrong shape flattens its fields or fails quietly in production, where nobody is reading its own errors.
