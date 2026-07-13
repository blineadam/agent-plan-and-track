---
name: plan-and-track
description: Plan and track any non-trivial task (3+ steps or architectural decisions) using tasks/todo.md in the active project. Use BEFORE starting implementation of any multi-step task, when resuming work that has an existing tasks/todo.md, or when work goes sideways and needs re-planning. Also triggers when the user asks to plan, scope, or spec out work.
---

# Plan and Track

Workflow for planning, tracking, and closing out non-trivial tasks. All paths are relative to the active project root.

## Before implementing

1. Read `tasks/lessons.md` if it exists and apply any relevant lessons to the plan.
2. Enter plan mode if not already in it. Write a detailed spec upfront to reduce ambiguity.
3. Write the plan to `tasks/todo.md` as a checklist:

   ```markdown
   # <Task name>

   ## Plan
   - [ ] Step 1 ...
   - [ ] Step 2 ...
   ```

4. Check in with the user on the plan before starting implementation (skip only if running autonomously).

## During implementation

5. Mark items `[x]` as they complete. Give a high-level, one-line summary of each change as you go.
6. If something goes sideways: STOP immediately, re-plan in `tasks/todo.md`, then continue. Don't keep pushing a failing approach.
7. Keep changes minimal — impact only the code the plan requires.

## When done

8. Verify before marking complete: run tests, check logs, demonstrate correctness. Ask "would a staff engineer approve this?"
9. Add a `## Review` section to `tasks/todo.md` summarizing what changed, why, and how it was verified.
10. Update `README.md` if the change is critical or important.
11. If the user corrected anything along the way, record it via the `capture-lesson` skill.
12. Once this batch's PR has merged and its branch is cleaned up, compress that batch's `## Plan`/`## Review` block in `tasks/todo.md` down to one line pointing at the PR (e.g. `Batch N — <title> — merged <sha>, PR #X. <one-clause summary>`). Leave any still-open or in-progress batch at full detail — a merged PR already has the full history on GitHub, so nothing is lost.
