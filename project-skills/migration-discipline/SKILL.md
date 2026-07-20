---
name: migration-discipline
description: Use when planning or running a large migration, language port, or mechanical rewrite across many files, especially with parallel agents or large error sets: covers file-ownership isolation, a progressive validation ladder, work-queue batching, test-oracle integrity, and audit-trail preservation. Not general task planning (that is plan-and-track) or subagent tiering (that is efficient-frontier).
---

# Migration Discipline

Disciplines specific to large migrations, language ports, and mechanical rewrites, layered on top of general task planning ([[plan-and-track]]) and subagent tiering ([[efficient-frontier]]). Distilled from a public postmortem of a large agentic language port (bun.com/blog/bun-in-rust) plus an independent forensic write-up of a similar large-scale multi-agent migration effort. Reach for this skill once a task's shape is "many files, one mechanical change, possibly many agents," not for a single-file or single-topic change.

## File Ownership and Parallel Isolation

Parallelize only work that can be safely isolated. Before dispatching parallel agents at migration scale:

- Assign each agent explicit, non-overlapping ownership of files or components; two agents must never hold write access to the same file at the same time.
- Use separate worktrees or branches per parallel stream when the scale warrants it, not just separate prompts against one working tree.
- Cap parallelism to what disk, memory, build, and test infrastructure can actually sustain; more agents than the build/test system can absorb turns into contention, not throughput.
- Never run a project-wide formatter, generator, build, or dependency update from inside a parallel task. Those touch files outside any single agent's assigned ownership and will race with every other agent's edits.

## Progressive Validation Ladder

Compiling or parsing without errors is not completion. Validate a migration in ascending, ordered rungs, and don't call a rung passed without confirming its checks actually ran (per the standing verify-before-done rule, not restated here):

1. Formatting, parsing, and static checks
2. Compilation or type checking
3. Basic startup and smoke tests
4. Targeted tests for the changed behavior
5. Relevant package or component tests
6. Full local test suite
7. CI across supported platforms and configurations
8. Release, canary, or production-like validation when applicable

Climb the ladder in order. A change that passes rung 2 but hasn't been run through rung 4 hasn't been validated at rung 4, regardless of how mechanical the change looked.

## Semantic-Error Review Brief

A port or rewrite can compile, typecheck, and even pass a shallow smoke test while still being behaviorally wrong in ways that only show up under specific inputs or timing. When writing a review brief for this kind of change (per [[efficient-frontier]]'s default-deny verification-brief approach), attach the semantic-error checklist as a reviewer appendix rather than trusting the reviewer to think of each category unprompted. See [references/semantic-error-checklist.md](references/semantic-error-checklist.md) for the full list; don't inline it here.

## Work-Queue Batching

Treat an expensive command's output (a full compiler error list, a lint run, a failing-test report) as a work queue, not something to re-run repeatedly:

- Capture the complete output once.
- Group the findings into non-overlapping batches by package, file, or failure type.
- Fix each batch independently, with its own targeted validation.
- Re-run the broad, expensive command only after a batch is complete, to confirm that batch's fixes and surface what's left, not on every individual edit.

Re-running the full command after every small fix burns time the batching structure already avoids.

## Test-Oracle Integrity

A behavior-preserving migration's test suite is only a valid oracle if it stays fixed for the duration of the work. If the same suite is being edited concurrently with the migration itself, a passing run no longer proves behavior was preserved, since either side could be why it passes. Freeze or snapshot the behavior-verification suite for the migration's duration, and when practical, run that same frozen suite against both the old and the new implementation to compare results directly rather than trusting a single pass/fail.

## Audit-Trail Preservation

For a long, multi-agent, multi-session migration, squash-merging the final result erases the branch, merge, and revert history that a postmortem or a later debugging session would need to reconstruct what actually happened during the effort. Preserve the working branch (or merge with a merge commit instead of squashing) and keep any internal audit or progress docs the effort produced rather than deleting them pre-merge. This is specific to large multi-session efforts: a small, single-topic PR still squashes fine, and this discipline shouldn't be read as a blanket objection to squash-merging in general.

## Applying This Discipline

1. Before starting: confirm the change is migration-shaped (many files, one mechanical change, possibly parallel agents), otherwise use [[plan-and-track]] alone.
2. Plan file/component ownership and worktree layout per the isolation section above before any agent starts editing.
3. Freeze the behavior-verification suite per the oracle-integrity section before behavior-preserving work begins.
4. As broad validation commands (compiler, linter, full test run) produce output, batch and fix per the work-queue section instead of re-running them after each edit.
5. Climb the validation ladder in order as batches complete; don't skip a rung because an earlier one passed.
6. When reviewing changes, attach the semantic-error checklist to the review brief.
7. At merge time, apply the audit-trail preservation choice appropriate to the effort's size.
