---
name: plan-and-track
description: Plan and track any non-trivial task (3+ steps or architectural decisions) using tasks/todo.md in the active project. Use BEFORE starting implementation of any multi-step task, when resuming work that has an existing tasks/todo.md, or when work goes sideways and needs re-planning. Also triggers when the user asks to plan, scope, or spec out work.
---

# Plan and Track

Workflow for planning, tracking, and closing out non-trivial tasks. All paths are relative to the active project root.

## Before implementing

1. Reconcile stale batches first: if `tasks/todo.md` exists, scan it for any batch whose `## Plan` checklist is fully checked off (`[x]`) but is still shown at full `## Plan`/`## Review` detail. Compress each one down to one line summarizing the outcome (e.g. `Batch N — <title> — done <date>, PR #X` or, if there's no PR, `Batch N — <title> — done <date>. <one-clause summary>`). Leave any batch with an unchecked step at full detail. This needs no external system (no GitHub/PR dependency) — checklist state already in `tasks/todo.md` is the only signal, so it works the same whether or not this project uses PRs. Once a batch is compressed it's a one-liner and this scan skips it on every future run, so the check stays cheap.
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

6. Mark items `[x]` as they complete. Give a high-level, one-line summary of each change as you go. If a step's real completion depends on something outside the agent's own actions (a PR merge, a deploy, external sign-off), leave it unchecked until that's actually confirmed — not just when the agent's own part (e.g. opening the PR) is done. Step 1's reconciliation scan only compresses batches that are fully checked off, so a premature check mark compresses a batch before it's really finished.
7. If something goes sideways: STOP immediately, re-plan in `tasks/todo.md`, then continue. Don't keep pushing a failing approach.
8. Keep changes minimal — impact only the code the plan requires.

## When done

9. Verify before marking complete: run tests, check logs, demonstrate correctness. Ask "would a staff engineer approve this?"
10. Add a `## Review` section to `tasks/todo.md` summarizing what changed, why, and how it was verified.
11. Update `README.md` if the change is critical or important.
12. If the user corrected anything along the way, record it via the `capture-lesson` skill.
