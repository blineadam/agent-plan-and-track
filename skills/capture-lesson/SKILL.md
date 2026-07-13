---
name: capture-lesson
description: Record a lesson in the active project's tasks/lessons.md after the user corrects a mistake, rejects an approach, points out something missed, or gives feedback on how to work. Use IMMEDIATELY after ANY correction from the user — the goal is to never repeat the same mistake twice.
---

# Capture Lesson

Self-improvement loop: turn every user correction into a rule that prevents the same mistake.

## When this fires

Any time the user corrects course: a rejected approach, a bug you introduced, a misunderstood requirement, a workflow preference you violated. Don't wait to be asked — capture it as part of handling the correction.

## Steps

1. Open (or create) `tasks/lessons.md` in the active project.
2. Append an entry in this format:

   ```markdown
   ## <short title> (<YYYY-MM-DD>)
   - **What happened**: <the mistake or corrected behavior, one or two lines>
   - **Rule**: <imperative rule for future-you that prevents recurrence>
   ```

3. Write the rule so it's checkable before acting (e.g. "Before editing X, always check Y"), not a vague aspiration.
4. If a similar lesson already exists, strengthen or generalize the existing entry instead of duplicating it — iterate until the mistake rate drops.

## At session start

When beginning work in a project, read `tasks/lessons.md` if it exists and apply the relevant rules.
