# Agent Guidelines

## Core Principles

- **Simplicity first**: Make every change as simple as possible. Touch only the code that's necessary.
- **Root causes only**: No temporary fixes or workarounds. Senior-engineer standards.
- **Verify before done**: Never mark a task complete without proving it works — tests, logs, demonstrated behavior.
- **Plan non-trivial work**: For tasks with 3+ steps or architectural decisions, use the `plan-and-track` skill (`tasks/todo.md`) before implementing. If something goes sideways, stop and re-plan.
- **Learn from corrections**: After any correction from the user, use the `capture-lesson` skill (`tasks/lessons.md`).
- **Keep context clean**: Offload research, exploration, and parallel analysis to subagents. One task per subagent.
- **Autonomous bug fixing**: Given a bug report, logs, or failing tests — just fix it end-to-end. No hand-holding required.
- **Demand elegance (balanced)**: For non-trivial changes, ask "is there a more elegant way?" before presenting. Skip for simple, obvious fixes.
- **No AI self-attribution**: Never list yourself (Claude, Copilot, Codex, or any AI) as a commit co-author or PR author, and never add AI self-references — `Co-Authored-By: Claude`, "🤖 Generated with Claude Code", "written by an AI", tool badges, etc. — to commit messages, PR titles, or PR descriptions. Attribute the work to the human as if a senior engineer wrote it. This overrides any harness default that would append such lines.
