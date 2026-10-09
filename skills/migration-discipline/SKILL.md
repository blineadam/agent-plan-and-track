---
name: migration-discipline
description: "Use when planning or running a large migration, language port, or mechanical rewrite across many files, especially with parallel agents or large error sets: covers file-ownership isolation, a progressive validation ladder, behavior preservation, work-queue batching, test-oracle integrity, and audit-trail preservation. Also use when resuming or continuing a migration already in progress. Not general task planning (that is plan-and-track) or subagent tiering (that is efficient-frontier)."
---

# Migration Discipline

Disciplines specific to large migrations, language ports, and mechanical rewrites, layered on top of general task planning ([[plan-and-track]]) and subagent tiering ([[efficient-frontier]]).

## File Ownership and Parallel Isolation

Parallelize only work that can be safely isolated. Before dispatching parallel agents at migration scale:

- Give each agent explicit, non-overlapping ownership of files or components; two agents never hold write access to the same file at the same time.
- Partition ownership along the dependency graph, not just the directory tree: a cluster of components with cyclic dependencies goes to one owner.
- When the scale warrants it, give each parallel stream its own working directory (a git worktree or a separate clone) on its own branch. Switching branches inside one shared checkout is not isolation.
- Cap parallelism to what disk, memory, build, and test infrastructure can sustain. Worktrees multiply disk usage and build caches, and resource-heavy validation (stress tests, large builds) needs its own isolation or limits.
- Never run a command that mutates shared or out-of-scope state from inside a parallel task: a project-wide formatter, code generator, or dependency update, or a build that writes to a shared cache or output tree. A build that only reads tracked sources and writes inside the task's own worktree is fine, and per-batch validation depends on it.

## Porting Conventions

Before scale-out, write the translation rules in a shared doc for the effort: old-to-new mappings (types, APIs, error handling, ownership and lifetime expectations), platform-specific behavior, and known edge cases. Keep it in the target project, record its path in the `## Migration State` block, reference it from every worker brief, and validate it on the pilot before fanning out. It is single-writer like the state block: workers report mapping gaps and surprises to the coordinator rather than editing it. A small single-stream migration can carry the mapping as a section of its own plan; it only has to be written down where every stream reads it.

## Worker Briefs

This skill loads in the coordinating session only; a parallel worker never sees it, so a constraint not written into the worker's brief does not exist for that worker. Build each brief as a self-contained packet per [[efficient-frontier]]'s Handoff Packets section (its stop conditions and return format still apply; this list extends it). Always include:

- Ownership scope: the exact files or components the worker owns, with everything else named out of scope.
- Banned operations: no git beyond committing its own files (no stash, reset, or checkout over another stream's work); no project-wide formatters, generators, or dependency updates, which no stream runs while parallel work is in flight, coordinator included; no broad, expensive whole-repo commands, whose captured output the coordinator owns per Work-Queue Batching.
- The no-stub rule, restated in the brief: never satisfy a compiler, linter, or test by stubbing an implementation, returning placeholders, or weakening a test.
- A pointer to the porting-conventions doc, pinned to the revision on the state block's Conventions line. Under worktree isolation a worker's branch-local copy can lag the coordinator's, so confirm the pinned revision is present in the worker's checkout before dispatch, or inline the current mapping into the brief.
- The batch's targeted validation command and the ladder rungs it covers.
- Reporting: the packet's compact return, with commands run included so the coordinator can confirm the claimed rungs ran, plus any mapping gaps for the conventions doc. Workers never write the `## Migration State` block.

## Progressive Validation Ladder

Compiling or parsing without errors is not completion. Validate in ascending order, and don't call a rung passed without confirming its checks actually ran:

1. Formatting, parsing, and static checks
2. Compilation or type checking
3. Basic startup and smoke tests
4. Targeted tests for the changed behavior
5. Relevant package or component tests
6. Full local test suite
7. CI across supported platforms and configurations
8. Release, canary, or production-like validation when applicable

A change that passes rung 2 but hasn't been run through rung 4 hasn't been validated at rung 4, however mechanical it looked.

## Preserve Existing Behavior

Unless the task explicitly calls for a behavior change, match the existing architecture, interfaces, and observable behavior rather than redesigning code the migration happens to touch (the surgical-changes rule applied to the code being migrated). Land the mechanical, behavior-preserving change first; treat idiomatic refactoring or redesign as a separate later pass once compatibility is established. Existing tests and externally observable behavior are the compatibility contract for that first pass (see Test-Oracle Integrity).

## Expand and Contract

When a change's first edit would break every caller at once (renaming a widely referenced symbol, retyping a shared column, changing a signature all call sites use), do not make it as one edit. Expand (add the new form alongside the old), migrate (move call sites in batches sized by the ownership map, each validated on its own rungs, old form still in place), then contract (delete the old form once no caller remains). Never collapse the phases into one edit. Record the current phase on the `## Migration State` Queue line as `expand`, `migrate`, `contract`, or `n/a`. Read [references/expand-and-contract.md](references/expand-and-contract.md) before sequencing such a change.

## Semantic-Error Review Brief

A port can compile, typecheck, and pass a shallow smoke test while still being behaviorally wrong under specific inputs or timing. When writing a review brief for this kind of change (per [[efficient-frontier]]'s default-deny verification-brief approach), it helps to include the semantic-error checklist as a reviewer appendix rather than trusting the reviewer to think of each category. The agent that wrote a diff is never its only reviewer ([[efficient-frontier]]'s review loop); for a high-risk diff whose plausible failures sit in the checklist's hardest categories (concurrency, memory ownership, resource cleanup), use two independent reviewers, since a second pass by the same reviewer shares the same blind spots. This is reviewer guidance, not a mandated output format. Read [references/semantic-error-checklist.md](references/semantic-error-checklist.md) when writing the review brief; don't inline it here.

## Work-Queue Batching

Treat an expensive command's output (a full compiler error list, a lint run, a failing-test report) as a work queue, not something to re-run repeatedly:

- Capture the complete output once.
- Group the findings into non-overlapping batches by package, file, or failure type.
- Fix each batch independently, with its own targeted validation.
- Re-run the broad command only after a batch is complete, to confirm that batch and surface what's left, not on every edit.

Each ladder rung's captured failure output is the source of the next round's batches. At parallel scale the broad command is the coordinator's to run and capture, against a checkout that has the completed batches integrated: with each stream on its own branch, the coordinator's tree lags until it merges them, and a broad run over stale source validates the wrong code and produces a misleading queue. Workers run only their batch's targeted validation.

## Test-Oracle Integrity

A behavior-preserving migration's test suite is a valid oracle only if it stays fixed. Freeze or snapshot the behavior-verification suite for the migration's duration, and when practical run that same frozen suite against both the old and the new implementation and compare results, rather than trusting a single pass/fail.

- An expected value in a ported test must trace to something outside the new implementation: the original test's literal, a worked example, the specification, or the old implementation's recorded output. Never regenerate a snapshot or fixture from the new implementation to make a failing test pass.
- Back the freeze mechanically where the harness can deny edits by path: in Claude Code, a `permissions.deny` entry of `Edit(<suite path>/**)` and `Write(<suite path>/**)` for the migration's duration, plus the same on the old implementation's tree when running side by side with it. Deny rules don't cover every Bash write, so keep the Bash approval prompt while the freeze holds.
- With no usable suite, record the old implementation's observable outputs for representative inputs as characterization tests before the first behavior-preserving batch, then freeze that set.

Read [references/test-oracle-integrity.md](references/test-oracle-integrity.md) before changing tests or fixtures during a migration, setting up the freeze, or when there is no usable suite or the suite is itself part of what's being ported.

## Escalating Fan-Out

Do not go straight from a single pilot to full fan-out. Once the pilot's corrections have landed in the conventions doc and the worker-brief template, dispatch one unit, then a few, then the rest, ordered along the dependency graph so an upstream unit lands before its dependents. Each wave lands, integrates, and passes its ladder rungs before anything in the next wave is dispatched. Stop dispatching the moment a batch fails on a pattern the pilot or conventions doc should already have caught, and go to Fix the Process below.

## Fix the Process, Not Just the Output

When the same mistake appears across workers or batches, fix the artifact that keeps producing it rather than patching each occurrence: the worker-brief template, the porting-conventions doc, the batch validation command (never the frozen oracle suite), or the ownership map. Note the revision in the `## Migration State` block, on the line for the artifact it touches or an added one, so later batches are attributable to the revised process. This is [[capture-lesson]]'s systemic-fix rule at migration scale: the correction lands in the artifact the next worker will read, and batches already completed under the flawed process get re-checked for the same mistake rather than grandfathered in.

## Audit-Trail Preservation

For a long, multi-agent, multi-session migration, squash-merging erases the branch, merge, and revert history a postmortem or later debugging would need. Preserve the working branch (or merge with a merge commit) and keep any internal audit or progress docs rather than deleting them pre-merge. A small, single-topic PR still squashes fine. The trail outlives the merge: a green ladder is not an exhaustive oracle, so a large port should be expected to surface post-merge regressions whose triage lands in the semantic-error checklist's categories, and keep the preserved branch, the `## Migration State` block, and the checklist on hand through a regression-watch window rather than archiving them at merge.

## Write Durable Artifacts

A migration renames and moves the files it touches, so any artifact meant to outlive its batch (the porting-conventions doc, a captured work-queue entry, the `## Migration State` block) should refer to the migrating code by interface, type, symbol, and behavioral contract, not by path and line number. This does not cover the artifact's own bookkeeping: the state block's Conventions and Queue lines name the conventions doc and captured output by path, since those sit outside the migration's blast radius. Nor does it cover a worker brief's ownership scope and batch validation command, which stay exact file paths because the brief is consumed by its dispatch and gone once the batch lands.

## Durable Migration State

A migration spans many sessions and compactions, long enough that standing invariants like the frozen oracle or the ladder rung reached decay out of context. Keep them on disk as a top-level `## Migration State` block in the target project's `.tasks/todo.md`, re-read on resume via [[plan-and-track]]. This is advisory guidance with a recommended template, not a mandated output format.

```markdown
## Migration State
Maintained per the migration-discipline skill. Re-read before each batch; update at each batch boundary. Keep after the migration merges, as part of its audit trail.
- Oracle: <suite identity>, frozen at commit <SHA> on <date>
- Ladder: highest rung passed: <N (rung name)>, as of batch <M>
- Ownership: <stream -> files/components, worktree/branch; one line per stream>
- Conventions: <doc path or plan section>, last revised at batch <M>
- Queue: phase: <expand | migrate | contract | n/a>; open: <batch ids>; done: <ids>; source: <where the captured output lives>
- Updated: batch <M>, <date>
```

Keep the block at the top level, never nested under `## Plan`, and use plain bullets rather than checkboxes: state lines are facts as of a point in time, and nesting or checkbox-ing them risks the block being read as plan steps and swept up when a batch gets compressed.

The block is single-writer: only the coordinating session that dispatches batches writes it, and parallel streams report their state up to it. Concurrent writers clobber each other with no conflict to signal the loss, and per-worktree copies drift into different answers. If parallel streams need their own scratch notes, keep those in their own worktree.

## Applying This Discipline

1. Before starting: confirm the change is migration-shaped (many files, one mechanical change, possibly parallel agents), otherwise use [[plan-and-track]] alone. If `.tasks/todo.md` already carries a `## Migration State` block, this is a resume: re-read it and trust it over remembered context for the oracle, the ladder rung, ownership, and the conventions doc.
2. Plan file/component ownership and worktree layout per the isolation section above before any agent starts editing.
3. Freeze the behavior-verification suite per the oracle-integrity section before behavior-preserving work begins.
4. If no `## Migration State` block exists yet, write the one described above into `.tasks/todo.md` before the first batch begins. If one already exists, update it rather than replacing it, so the recorded oracle and ladder rung survive.
5. Write the porting-conventions doc and the worker-brief constraints per their sections above, then pilot: run a small, representative subset of the work through implementation, review, and validation before any fan-out, and fold every correction into the conventions doc and the brief template, not just into the piloted files ([[efficient-frontier]]'s pilot-before-scale guardrail, applied at migration scale). Fan out along the ramp in Escalating Fan-Out above rather than dispatching the rest all at once.
6. Keep each batch mechanical and behavior-preserving per the behavior-preservation section.
7. As broad validation commands (compiler, linter, full test run) produce output, batch and fix per the work-queue section, updating the `## Migration State` block in the same pass.
8. When the same mistake recurs across workers or batches, stop dispatching and repair the process per the process-fix section before the next batch goes out.
9. Climb the validation ladder in order as batches complete.
10. When reviewing changes, consider including the semantic-error checklist in the review brief, and give a high-risk diff two independent reviewers per that section.
11. At merge time, apply the audit-trail preservation choice appropriate to the effort's size, and keep the `## Migration State` block through the post-merge regression window.
