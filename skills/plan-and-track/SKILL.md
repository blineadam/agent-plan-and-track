---
name: plan-and-track
description: Plan and track any non-trivial task (3+ steps or architectural decisions) using tasks/todo.md in the active project. Use BEFORE starting implementation of any multi-step task, when resuming work that has an existing tasks/todo.md, or when work goes sideways and needs re-planning. Also triggers when the user asks to plan, scope, or spec out work.
---

# Plan and Track

All paths are relative to the active project root.

## Before implementing

1. Reconcile stale batches first: if `tasks/todo.md` exists, compress any batch that has BOTH a fully checked-off (`[x]`) `## Plan` checklist AND an existing `## Review` section but is still shown at full detail, down to one line summarizing the outcome (e.g. `Batch N: <title>: done <date>, PR #X` or, with no PR, `Batch N: <title>: done <date>. <one-clause summary>`). A checked Plan alone only proves implementation (step 6); the Review section proves verification/closeout (steps 10-11), so leave any batch missing either signal at full detail. The only signal is checklist and Review state in `tasks/todo.md` itself, never an external system (GitHub, PRs, a CI), so this works the same in projects that use none of them.
2. Read `tasks/lessons.md` if it exists and apply any relevant lessons to the plan.
3. Enter plan mode if not already in it. Write a detailed spec upfront to reduce ambiguity:
   - **Hard-to-reverse bets first**: sequence the decisions that are costly to undo ahead of everything else.
   - **Reuse before addition**: for each step, name what it reuses before what it adds.
   - **No padding, no fake plans**: never pad a plan to look thorough; never ship a single-step "plan".
   - **Pilot before scale**: when the plan applies the same change across many files or targets, make the first implementation step (after the hard-to-reverse decisions above are settled) a small representative subset plus a review of its results, and only then the full sweep.
   - **Batch clarifying questions**: ask 2-4 high-leverage questions together, not one at a time.

   When the tiered subagent roster is available, delegate per [[efficient-frontier]], which owns the roster and the tier-matching rules. On Claude Code, plan mode's own workflow suggests a generic `Plan` agent for its design phase: launch the roster's `planner` there instead (Agent tool, `subagent_type: "planner"`). It reads the real tree and returns the spec as text (it has no write tools); that returned spec is what goes into the plan file and step 4. Codex renders the same roster natively, and named-agent invocation works on standalone Codex CLI as of v0.138.0 (June 2026); it is still unavailable in tool-backed/SDK sessions (see the Codex note in docs/models.md). This repo installs no roster for Copilot, so plan inline there.
4. Write the plan to `tasks/todo.md` as a checklist, tagging each step with who carries it out and naming how the step will be verified: a short `verify:` clause (the command to run or the observable check that proves the step landed), placed before the owner tag so the tag still ends the line. Default the tags, don't deliberate them: implementation steps get `executor`, research steps `researcher`, mechanical tails `mechanic` (per [[efficient-frontier]]). Tagging a step `main` is the exception and must carry a one-clause reason in the tag itself; "the main session already has the context" doesn't qualify, since delegation pays in context preservation even when the delegate runs the same model tier. Decide this at plan time, not mid-implementation:

   ```markdown
   # <Task name>

   ## Plan
   - [ ] Step 1 ...; verify: <check> (researcher)
   - [ ] Step 2 ...; verify: <command and expected output> (executor)
   - [ ] Step 3 ...; verify: <check> (main: needs user sign-off mid-step)
   ```

5. Check in with the user on the plan before starting implementation (skip only if running autonomously).

## During implementation

6. Dispatch contiguous same-tier steps as one batch to the tier their tag names, per [[efficient-frontier]]; handle a step in the main session only when it's tagged `main` or the roster is unavailable. Steps the plan marks as independent of each other can be dispatched together in the background per [[efficient-frontier]]; write any independence marker inside the step text before the `verify:` clause and owner tag, so the tag still ends the line. The spec is already on disk, so point an `executor` at it ("implement steps X-Y of Batch N in tasks/todo.md", plus the repo path, what's out of scope, and stop conditions) rather than re-serializing the plan into the prompt. Mark items `[x]` as they complete; for an executor-tagged batch, that happens only after the review step below. When a commit lands covering a checked step, append its short SHA in square brackets after the owner tag on the now-`[x]` line, e.g. `- [x] Step 2 ...; verify: ... (executor) [abc1234]`; this is opportunistic only, it never forces a commit or a request to commit just to mint a SHA, and a SHA must never appear on a still-unchecked `[ ]` line, since plan-gate's owner-tag lint anchors the tag at end-of-line only on unchecked steps. Give a high-level, one-line summary of each change as you go. If a step's real completion depends on something outside the agent's own actions (a PR merge, a deploy, external sign-off), leave it unchecked until that's actually confirmed, not just when the agent's own part (e.g. opening the PR) is done.
7. For an executor-tagged batch, don't check its boxes yet when the report comes back: first review just that batch's diff (the uncommitted working-tree changes, or the batch's commit range if commits already landed). On Claude Code, use the bundled `code-review` skill, self-invocable via the Skill tool at its default effort. On Codex, use the bundled `$review-agent` skill scoped to the batch: `codex review --commit <sha>` or `--base <branch>` when the batch's commits landed, or `--uncommitted` only when the batch owns the entire working-tree diff (concurrent batches share the tree); where the sandbox blocks running it, have the user type `/review`; the model can't self-trigger a structured review otherwise (openai/codex#6432 open). On Copilot, where this repo installs no roster, and anywhere no batch-scoped native review can run, review the diff directly in the main session instead: reread it fresh for correctness bugs first, then reuse/simplification. Either way, the review works from the diff and the plan's requirements, not the implementer's report or reasoning, and starts from the assumption the change is wrong, looking for how it fails; a pass that only confirms the implementer's summary isn't a review. Fix or explicitly triage/defer every finding, with a one-line reason appended directly to the relevant Plan item(s), not the `## Review` section (that heading's presence is step 1's proof that closeout already ran, so writing there early risks a premature compression), before checking any boxes; silence on a finding is not triage. Scope: executor-tagged batches only, not researcher (no diff), mechanic (fully pre-specified), or main (already under the main session's own judgment).
8. If something goes sideways: STOP immediately, re-plan in `tasks/todo.md`, then continue. Don't keep pushing a failing approach.
9. Keep changes minimal: impact only the code the plan requires.

## When done

10. Verify before marking complete: run tests, check logs, demonstrate correctness. Ask "would a staff engineer approve this?"
11. Add a `## Review` section to `tasks/todo.md` summarizing what changed, why, and how it was verified; record the batch's first and last commit SHAs or PR when one exists (e.g. `Commits: abc1234 through def5678` or `PR #X`).
12. Update `README.md` if the change is critical or important.
13. If the user corrected anything along the way, record it via the `capture-lesson` skill.
