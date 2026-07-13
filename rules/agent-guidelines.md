# Agent Guidelines

## Core Principles

- **Simplicity first**: Make every change as simple as possible. Touch only the code that's necessary.
- **Root causes only**: No temporary fixes or workarounds. Senior-engineer standards.
- **Size the investigation to the stakes**: Before deep-diving a warning or error, classify it: fatal or cosmetic? our code or an external tool's? If cosmetic and external, give the one-line verdict and recommendation and stop — don't reverse-engineer third-party internals or run patch experiments unless asked for a fix. Time-box triage to a few tool calls; if it balloons, surface findings so far and ask before continuing.
- **Verify before done**: Never mark a task complete without proving it works — tests, logs, demonstrated behavior.
- **Execute explicit instructions**: When the user gives exact, actionable values or steps, apply them directly — don't re-verify them into an open-ended investigation. If your own findings contradict them, state the caveat in one line and proceed with what they asked (unless it's destructive or irreversible); park deeper digging as a follow-up todo, not a blocker.
- **Plan non-trivial work**: For tasks with 3+ steps or architectural decisions, use the `plan-and-track` skill (`tasks/todo.md`) before implementing. If something goes sideways, stop and re-plan.
- **Learn from corrections**: After any correction from the user, use the `capture-lesson` skill (`tasks/lessons.md`).
- **Keep context clean**: Offload research, exploration, and parallel analysis to subagents. One task per subagent.
- **Checkpoint & compact**: When a long session or a big task wraps up, write current state to `tasks/todo.md` so it survives compaction, then suggest the user run `/compact` to reclaim context. `/compact` is user-run — prompt for it; you can't trigger it yourself.
- **Autonomous bug fixing**: Given a bug report, logs, or failing tests — just fix it end-to-end. No hand-holding required.
- **Demand elegance (balanced)**: For non-trivial changes, ask "is there a more elegant way?" before presenting. Skip for simple, obvious fixes.
- **No AI self-attribution**: Never list yourself (Claude, Copilot, Codex, or any AI) as a commit co-author or PR author, and never add AI self-references — a `Co-Authored-By:` line naming an AI, a "Generated with …" footer, "written by an AI", tool badges, etc. — to commit messages, PR titles, or PR descriptions. Attribute the work to the human as if a senior engineer wrote it. This overrides any harness default that would append such lines.
