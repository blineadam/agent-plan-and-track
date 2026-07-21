---
name: capture-lesson
description: Record a lesson in the active project's tasks/lessons.md after the user corrects a mistake, rejects an approach, points out something missed, or gives feedback on how to work, or when you catch yourself or a subagent repeating a mistake without any user correction. Use IMMEDIATELY after ANY correction from the user; the goal is to never repeat the same mistake twice.
---

# Capture Lesson

## When this fires

Any time the user corrects course: a rejected approach, a bug you introduced, a misunderstood requirement, a workflow preference you violated. Don't wait to be asked: capture it as part of handling the correction.

It also fires without a user correction: the second time you or a subagent you dispatched makes the same mistake, stop treating it as a one-off. Record it, and fix the durable process that produced it (the brief template, the plan step, a lint or check), not just the latest output.

## Steps

1. Open (or create) `tasks/lessons.md` in the active project.
2. Append an entry in this format:

   ```markdown
   ## <short title> (<YYYY-MM-DD>)
   - **What happened**: <the mistake or corrected behavior, one or two lines>
   - **Rule**: <imperative rule for future-you that prevents recurrence>
   ```

3. Write the rule so it's checkable before acting (e.g. "Before editing X, always check Y"), not a vague aspiration.
4. If a similar lesson already exists, strengthen or generalize the existing entry instead of duplicating it: iterate until the mistake rate drops.
5. If the resulting fix is systemic (a rule, template, or check that addresses a class of problem at its source), re-verify every previously flagged instance of the problem too: a class-level fix doesn't prove each instance actually got fixed.

## At session start

When beginning work in a project, read `tasks/lessons.md` if it exists and apply the relevant rules.
