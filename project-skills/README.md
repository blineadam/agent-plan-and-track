# project-skills

Opt-in, project-scoped skills. Unlike everything under `skills/`, nothing here is ever deployed by `install.sh` or `install.ps1`: their `copy_skills` step only globs `skills/*/`, and `project-skills/` is deliberately a sibling directory outside that glob.

## Why opt-in

The disciplines in this directory apply to a specific kind of work, large migrations, language ports, mechanical rewrites, not to every project. Making them always-on shared rules across every session would add standing weight most projects never need. Instead, copy a skill's folder into the one project that's actually doing that kind of work.

## The contract

Copy the skill's whole folder into your target project at the destination your harness expects (below). There's no installer step: to pick up an update, re-copy the folder over the old one.

## Catalog

- **migration-discipline**: file-ownership isolation for parallel agents, a progressive validation ladder, a semantic-error review checklist, work-queue batching for large error sets, test-oracle integrity, and audit-trail preservation for large migrations and ports.

## Per-harness copy destinations

- **Claude Code**: copy the folder to `<project>/.claude/skills/migration-discipline/`. Loaded automatically just-in-time when its description matches the task; also invocable directly as `/migration-discipline`. 
- **Codex**: copy the folder to `<project>/.agents/skills/migration-discipline/`. Committed to the repo, it's team-shared; loaded just-in-time by description, or invoke `$migration-discipline` or the `/skills` command.
- **GitHub Copilot CLI**: copy the folder to `<project>/.github/skills/migration-discipline/`. Copilot CLI also auto-discovers skills already in `<project>/.claude/skills/` or `<project>/.agents/skills/`, so if you copied it there for Claude or Codex, Copilot picks it up too with no second copy. Loaded just-in-time by description, or invoke `/migration-discipline`. 
