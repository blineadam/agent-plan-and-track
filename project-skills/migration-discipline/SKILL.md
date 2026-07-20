---
name: migration-discipline
description: "Use when planning or running a large migration, language port, or mechanical rewrite across many files, especially with parallel agents or large error sets: covers file-ownership isolation, a progressive validation ladder, work-queue batching, test-oracle integrity, and audit-trail preservation. Also use when resuming or continuing a migration already in progress. Not general task planning (that is plan-and-track) or subagent tiering (that is efficient-frontier)."
---

# Migration Discipline

Disciplines specific to large migrations, language ports, and mechanical rewrites, layered on top of general task planning ([[plan-and-track]]) and subagent tiering ([[efficient-frontier]]). Distilled from a public postmortem of a large agentic language port (bun.com/blog/bun-in-rust) plus an independent forensic write-up of a similar large-scale multi-agent migration effort. Reach for this skill once a task's shape is "many files, one mechanical change, possibly many agents," not for a single-file or single-topic change.

## File Ownership and Parallel Isolation

Parallelize only work that can be safely isolated. Before dispatching parallel agents at migration scale:

- Assign each agent explicit, non-overlapping ownership of files or components; two agents must never hold write access to the same file at the same time.
- Give each parallel stream its own working directory, a git worktree or a separate clone, each on its own branch, when the scale warrants it. Switching branches inside one shared checkout is not isolation: every agent still mutates the same files and index.
- Cap parallelism to what disk, memory, build, and test infrastructure can actually sustain; more agents than the build/test system can absorb turns into contention, not throughput.
- Never run a command that mutates shared or out-of-scope state from inside a parallel task: a project-wide formatter, code generator, or dependency update, or a build that writes to a shared cache or output tree. Those race with every other agent's edits. A build that only reads tracked sources and writes outputs inside the task's own worktree is fine, and is what the per-batch validation below depends on.

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

A port or rewrite can compile, typecheck, and even pass a shallow smoke test while still being behaviorally wrong in ways that only show up under specific inputs or timing. When writing a review brief for this kind of change (per [[efficient-frontier]]'s default-deny verification-brief approach), it helps to include the semantic-error checklist as a reviewer appendix rather than trusting the reviewer to think of each category unprompted. This is reviewer guidance, not a mandated output format. See [references/semantic-error-checklist.md](references/semantic-error-checklist.md) for the full list; don't inline it here.

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

## Durable Migration State

A migration runs across many sessions and compactions, long enough that standing invariants like the frozen oracle or the ladder rung reached decay out of context between sessions. Move them onto disk instead, as a top-level `## Migration State` block in the target project's `tasks/todo.md`, re-read on resume via [[plan-and-track]]. This is advisory guidance with a recommended template, not a mandated output format.

```markdown
## Migration State
Maintained per the migration-discipline skill. Re-read before each batch; update at each batch boundary. Keep until the migration merges.
- Oracle: <suite identity>, frozen at commit <SHA> on <date>
- Ladder: highest rung passed: <N (rung name)>, as of batch <M>
- Ownership: <stream -> files/components, worktree/branch; one line per stream>
- Queue: open: <batch ids>; done: <ids>; source: <where the captured output lives>
- Updated: batch <M>, <date>
```

Keep the block at the top level, never nested under `## Plan`, and use plain bullets rather than checkboxes. State lines describe a fact as of a point in time, not a step to complete; nesting them under a plan heading or checkbox-ing them risks the block being read as plan steps and swept up when a batch gets compressed.

The block is a single-writer file under the same ownership rule as any other: only the coordinating session that dispatches batches writes it, and parallel streams report their state up to that session instead of editing it themselves. Two sessions writing it concurrently would clobber each other with no conflict to signal the loss, and per-worktree copies would each drift into a different answer with no authoritative one. If parallel streams need their own scratch notes, keep those in their own worktree and leave this block to the coordinator.

## Applying This Discipline

1. Before starting: confirm the change is migration-shaped (many files, one mechanical change, possibly parallel agents), otherwise use [[plan-and-track]] alone. If `tasks/todo.md` already carries a `## Migration State` block, this is a resume: re-read it and trust it over remembered context for the oracle, the ladder rung, and ownership.
2. Plan file/component ownership and worktree layout per the isolation section above before any agent starts editing.
3. Freeze the behavior-verification suite per the oracle-integrity section before behavior-preserving work begins.
4. If no `## Migration State` block exists yet, write the one described above into `tasks/todo.md` before the first batch begins. If one already exists, update it rather than replacing it, so the recorded oracle and ladder rung survive.
5. As broad validation commands (compiler, linter, full test run) produce output, batch and fix per the work-queue section instead of re-running them after each edit, updating the `## Migration State` block in the same pass.
6. Climb the validation ladder in order as batches complete; don't skip a rung because an earlier one passed.
7. When reviewing changes, consider including the semantic-error checklist in the review brief.
8. At merge time, apply the audit-trail preservation choice appropriate to the effort's size, and keep the `## Migration State` block, since it is part of that trail.
