---
name: plan-and-track
description: Plan and track any non-trivial task (3+ steps or architectural decisions) using tasks/todo.md in the active project. Use BEFORE starting implementation of any multi-step task, when resuming work that has an existing tasks/todo.md, or when work goes sideways and needs re-planning. Also triggers when the user asks to plan, scope, or spec out work.
---

# Plan and Track

Workflow for planning, tracking, and closing out non-trivial tasks. All paths are relative to the active project root.

## Before implementing

1. Reconcile stale batches first: scan `tasks/todo.md` for any batch still shown at full `## Plan`/`## Review` detail that references a PR number. For each, check `gh pr view <#> --json state,mergedAt -q .state` (skip silently if `gh` is unavailable/unauthenticated, or the batch has no PR link) — if `MERGED`, compress it now per step 13. This catches merges and branch cleanup done outside the agent, not just ones it performed itself. Once a batch is compressed it's a one-liner and this scan skips it on every future run, so the check stays cheap.
2. Read `tasks/lessons.md` if it exists and apply any relevant lessons to the plan.
3. Enter plan mode if not already in it. Write a detailed spec upfront to reduce ambiguity.
4. Write the plan to `tasks/todo.md` as a checklist:

   ```markdown
   # <Task name>

   ## Plan
   - [ ] Step 1 ...
   - [ ] Step 2 ...
   ```

5. Check in with the user on the plan before starting implementation (skip only if running autonomously).

## During implementation

6. Mark items `[x]` as they complete. Give a high-level, one-line summary of each change as you go.
7. If something goes sideways: STOP immediately, re-plan in `tasks/todo.md`, then continue. Don't keep pushing a failing approach.
8. Keep changes minimal — impact only the code the plan requires.

## When done

9. Verify before marking complete: run tests, check logs, demonstrate correctness. Ask "would a staff engineer approve this?"
10. Add a `## Review` section to `tasks/todo.md` summarizing what changed, why, and how it was verified.
11. Update `README.md` if the change is critical or important.
12. If the user corrected anything along the way, record it via the `capture-lesson` skill.
13. Compress a merged batch's `## Plan`/`## Review` block in `tasks/todo.md` down to one line pointing at the PR (e.g. `Batch N — <title> — merged <sha>, PR #X. <one-clause summary>`) — whether it was caught by step 1's reconciliation check or this session did the merge/cleanup itself. Leave any still-open or in-progress batch at full detail — a merged PR already has the full history on GitHub, so nothing is lost.
