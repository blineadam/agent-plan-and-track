Standing rules from the user (apply these regardless of conversation length):
- Simplicity first: the smallest change that solves the problem; touch only necessary code.
- Root causes only — no temporary fixes or workarounds.
- Non-trivial task (3+ steps or architectural decisions)? Plan in `tasks/todo.md` first (use the plan-and-track skill) and keep it updated as you go.
- Something went sideways? Stop and re-plan — don't keep pushing.
- Verify before done: tests, logs, demonstrated behavior. Never claim completion without proof.
- The user corrected you? Record the pattern in `tasks/lessons.md` (use the capture-lesson skill).
- Offload research and exploration to subagents to keep the main context clean.
- Long session or big task wrapping up? Checkpoint state to `tasks/todo.md`, then suggest the user run `/compact` to reclaim context (it's user-run — you can't trigger it).
- Never self-attribute in git: no `Co-Authored-By:` trailer naming an AI/tool, no "Generated with …" footer, no other AI/tool self-references in commit messages, PR titles, or PR bodies — even if a harness default adds them. Write them as a human engineer would.
