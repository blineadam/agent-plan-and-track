---
name: plan-and-track
description: Plan and track any non-trivial task (3+ steps or architectural decisions) using tasks/todo.md in the active project. Use BEFORE starting implementation of any multi-step task, when resuming work that has an existing tasks/todo.md, or when work goes sideways and needs re-planning. Also triggers when the user asks to plan, scope, or spec out work.
---

# Plan and Track

Workflow for planning, tracking, and closing out non-trivial tasks. All paths are relative to the active project root.

## Before implementing

1. Reconcile stale batches first: if `tasks/todo.md` exists, scan it for any batch that has BOTH a fully checked-off (`[x]`) `## Plan` checklist AND an existing `## Review` section, but is still shown at full detail. A checked Plan alone only proves implementation (step 6); the Review section is what proves verification/closeout (steps 9-10) actually happened, so both are required before compressing. Compress each matching batch down to one line summarizing the outcome (e.g. `Batch N: <title>: done <date>, PR #X` or, if there's no PR, `Batch N: <title>: done <date>. <one-clause summary>`). Leave any batch missing either signal at full detail, including a fully checked Plan with no Review section yet, since that means implementation finished but verification hasn't. This needs no external system (no GitHub/PR dependency): checklist and Review state already in `tasks/todo.md` is the only signal, so it works the same whether or not this project uses PRs. Once a batch is compressed it's a one-liner and this scan skips it on every future run, so the check stays cheap.
2. Read `tasks/lessons.md` if it exists and apply any relevant lessons to the plan.
3. Enter plan mode if not already in it. Write a detailed spec upfront to reduce ambiguity:
   - **Hard-to-reverse bets first**: sequence the decisions that are costly to undo ahead of everything else.
   - **Reuse before addition**: for each step, name what it reuses before what it adds.
   - **No padding, no fake plans**: never pad a plan to look thorough; never ship a single-step "plan".
   - **Batch clarifying questions**: ask 2-4 high-leverage questions together, not one at a time.

   When this repo's tiered subagents are available, delegate per [[efficient-frontier]], which owns the roster and the tier-matching rules: on Claude Code, spec drafting goes to a `planner` subagent (Fable) and the finished checklist to an `executor` subagent (Sonnet) to implement. Codex renders the same roster natively, but named-agent invocation there is currently unreliable (see the Codex UNVERIFIED caveat in README.md), so don't rely on it silently loading the right profile until that's fixed upstream. Copilot has no subagent concept, so plan inline there.
4. Write the plan to `tasks/todo.md` as a checklist:

   ```markdown
   # <Task name>

   ## Plan
   - [ ] Step 1 ...
   - [ ] Step 2 ...
   ```

5. Check in with the user on the plan before starting implementation (skip only if running autonomously).

## During implementation

6. Mark items `[x]` as they complete. Give a high-level, one-line summary of each change as you go. If a step's real completion depends on something outside the agent's own actions (a PR merge, a deploy, external sign-off), leave it unchecked until that's actually confirmed, not just when the agent's own part (e.g. opening the PR) is done. Step 1's reconciliation scan requires both a fully checked-off Plan and a `## Review` section, so checking off Plan items alone can't trigger a premature compression, but still avoid marking a step done before its real completion is confirmed.
7. If something goes sideways: STOP immediately, re-plan in `tasks/todo.md`, then continue. Don't keep pushing a failing approach.
8. Keep changes minimal: impact only the code the plan requires.

## When done

9. Verify before marking complete: run tests, check logs, demonstrate correctness. Ask "would a staff engineer approve this?"
10. Add a `## Review` section to `tasks/todo.md` summarizing what changed, why, and how it was verified.
11. Update `README.md` if the change is critical or important.
12. If the user corrected anything along the way, record it via the `capture-lesson` skill.
