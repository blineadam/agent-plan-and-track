---
name: context-budget
description: Audit the always-on context cost of the agent config — skills, instruction files, and the rules digest — estimate tokens, flag oversized components, and recommend trims (keep / lazy-load / remove). Use when the context feels bloated, after adding several skills or rules, or as periodic hygiene on the instruction surface.
---

# Context Budget

Estimate what the agent config costs in every session and find the bloat. The
always-on surface — instruction files, the rules digest, and every skill's
frontmatter — loads into the context window on *every* turn, before the task
even starts. This skill enumerates that surface, estimates its token cost, flags
oversized components, and sorts each into **keep / lazy-load / remove**.

Adapted from the ECC `context-budget` skill for this repo's model. Same
principle as `rules-distill`: **deterministic collection + LLM judgment** — a
script enumerates and estimates exhaustively, then you (or a subagent) read the
findings and recommend trims. Pairs with [[strategic-compact]] (that manages
the *conversation* growing; this manages the *config* baseline).

## The key distinction: always-on vs on-demand

- **Always-on** (paid every turn): instruction files (CLAUDE.md / AGENTS.md /
  copilot-instructions.md), the `core-rules.md` digest, and each skill's YAML
  **frontmatter** (name + description — that's the routing text the model sees
  for every installed skill).
- **On-demand** (paid only when it fires): a skill's **body**. A 900-line skill
  body costs nothing until the skill triggers — so a long body is not
  necessarily bloat. The always-on frontmatter is what silently taxes every turn.

The script reports both. Optimize the always-on total first; treat a large body
as a *lazy-load candidate* only if the skill fires constantly.

## When to use

- The instruction surface feels heavy, or sessions start slow / lose focus.
- After adding several skills or rules (frontmatter descriptions accumulate).
- Periodic hygiene — same cadence as a `rules-distill` pass.

## Phase 1 — Measure (deterministic)

Run from the repo root so `./skills` is included alongside the installed dirs:

```bash
bash skills/context-budget/scripts/scan-context.sh ./skills
```

It scans `~/.claude/skills`, `~/.copilot/skills`, `~/.agents/skills` (whichever
exist) plus any dirs you pass, each harness's instruction file, and the
`core-rules.md` digest. Token estimate is deliberately crude — **words × 1.3** —
a relative bloat signal, not a tokenizer. Output JSON fields:

- `always_on_tokens` — the number to drive down (instruction files + digest +
  all skill frontmatter).
- `skill_body_tokens_total` — on-demand; informational.
- `counts.oversized_skills` / `oversized_configs` — components past the line
  limits (skills > 400 lines, rules > 100, instructions > 300; override via
  `SKILL_LINE_LIMIT` / `RULES_LINE_LIMIT` / `INSTRUCTIONS_LINE_LIMIT`).
- `skills[]` / `configs[]` — per-component `tokens`, `lines`, `over_limit`.

Report a one-line summary before analysis, e.g.
`Always-on: ~5.3k tok | 36 skills | 2 oversized | 6 config files`.

## Phase 2 — Triage (LLM judgment)

For each flagged or heavy component, assign a bucket:

| Bucket | Meaning | Typical action |
| --- | --- | --- |
| **Keep** | Earns its always-on cost; used broadly or a hard constraint | Leave it |
| **Lazy-load** | Valuable but not every-turn — long body, niche trigger | Move detail into the skill body / a `scripts/` file / a reference doc the skill points to; tighten the frontmatter description |
| **Remove** | Redundant, stale, or duplicated by another component | Delete, or fold into the component that supersedes it |

Guidance:

- **Frontmatter is prime real estate.** A verbose skill `description` is paid
  every turn across every session. Tighten it to the trigger + one-line purpose;
  push the "how" into the body.
- **Oversized body ≠ remove.** If a 500-line skill rarely fires, its body is
  fine — flag it lazy-load only if it also loads constantly.
- **Instruction files and the digest are the heaviest always-on items.** Trims
  there pay back the most. Cross-check against `rules-distill`: a rule that
  duplicates a skill can often move out of the always-on digest.
- **Don't optimize blindly** — a hard behavioral constraint stays even if long.

For a large audit, batch the components and analyze each batch in its own
subagent (keep the main context clean), then merge recommendations.

## Phase 3 — Recommend & apply

Present a summary table (`Component | Always-on tok | Lines | Bucket | Action`)
sorted by always-on cost, then per-component detail for anything Lazy-load /
Remove. **Never delete or edit config automatically — the user approves each
change.** After applying trims to skills or rules, remind the user to re-run
`./install.sh all` so the changes propagate to every harness.

## Claude-only addendum — MCP servers & agents

These live only in the Claude harness; gate any advice on them behind a
"Claude only" note.

- **MCP tools** (`.mcp.json` / connected servers) are a large, often-overlooked
  always-on cost: every tool's name + description + JSON schema loads up front —
  budget **~500 tokens per tool** as a rough default. A server exposing 30 tools
  can outweigh the entire skills surface. Recommend disabling unused servers, or
  harnesses that defer tool schemas until searched (see the deferred-tool
  mechanism) so only fetched tools cost their schema.
- **Subagent definitions** (`~/.claude/agents/*.md`) add always-on routing text
  much like skill frontmatter — audit their descriptions the same way.

`scan-context.sh` does **not** parse `.mcp.json` (schema cost isn't derivable
from line count); estimate MCP cost separately with the ~500 tok/tool heuristic.

## Design principles

- **Measure the always-on surface, not the total** — the body you never load is free.
- **Crude but consistent** — words × 1.3 is a comparison signal; don't over-trust the absolute number.
- **Trim the description before the body** — frontmatter is paid every turn.
- **Approval-gated** — the script measures; the user decides what to cut.
