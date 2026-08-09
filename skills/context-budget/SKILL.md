---
name: context-budget
description: Audit the always-on context cost of the agent config (skills, instruction files, and the rules digest), estimate tokens, flag oversized components, and recommend trims (keep / lazy-load / remove). Use when the context feels bloated, after adding several skills or rules, or as periodic hygiene on the instruction surface. Not for compacting a long conversation; that's strategic-compact.
---

# Context Budget

Estimate what the agent config costs in every session and find the bloat. The
always-on surface (instruction files, the rules digest, and every skill's
frontmatter) loads into the context window on *every* turn, before the task
even starts. This skill enumerates that surface, estimates its token cost, flags
oversized components, and sorts each into **keep / lazy-load / remove**.

Adapted from the ECC `context-budget` skill for this repo's model. Same
principle as `rules-distill`: **deterministic collection + LLM judgment**: a
script enumerates and estimates exhaustively, then you (or a subagent) read the
findings and recommend trims. Pairs with [[strategic-compact]] (that manages
the *conversation* growing; this manages the *config* baseline).

## The key distinction: always-on vs on-demand

- **Always-on** (paid every turn): instruction files (CLAUDE.md / AGENTS.md /
  copilot-instructions.md), the core-rules digest (`core-rules.md` plus
  `core-rules.local.md` where present), each skill's YAML **frontmatter**
  (name + description: that's the routing text the model sees for every
  installed skill), and each agent's **routing text** (name + description).
- **On-demand** (paid only when it fires): a skill's **body**. A 900-line skill
  body costs nothing until the skill triggers: so a long body is not
  necessarily bloat. The always-on frontmatter is what silently taxes every turn.

The script reports both. Optimize the always-on total first; treat a large body
as a *lazy-load candidate* only if the skill fires constantly.

## When to use

- The instruction surface feels heavy, or sessions start slow / lose focus.
- After adding several skills or rules (frontmatter descriptions accumulate).
- Periodic hygiene: same cadence as a `rules-distill` pass.

## Phase 1: Measure (deterministic)

Run from the repo root so `./skills` is included alongside the installed dirs:

```bash
node skills/context-budget/scripts/scan-context.js ./skills
```

It scans `~/.claude/skills`, `~/.copilot/skills`, `~/.agents/skills` (whichever
exist) plus any dirs you pass, each harness's instruction file, and the
core-rules digest (`core-rules.md`, plus `core-rules.local.md` where present,
matching what the digest hook injects). Token estimate is deliberately crude: **words × 1.3**, a relative bloat signal, not a tokenizer. Output JSON fields:

- `harnesses.{claude,copilot,codex}.always_on_tokens`: **the configured-source
  number to drive down, per harness** (that harness's skill frontmatter + its
  instruction file + its digest + its agent routing text). The three harnesses
  are mutually exclusive: a session pays *one* column, never the sum. For Codex,
  this is an upper-bound estimate from the installed sources the scanner can
  see, not an exact per-session token ledger.
- `harnesses.*.skill_body_tokens`: on-demand; informational.
- `harnesses.*.agent_routing_tokens`: token cost of agent routing text (name +
  description) on that harness, folded into `always_on_tokens`.
- `agents[]`: enumeration of each installed agent (all harnesses), with `path`,
  `name`, `routing_tokens`, and `harness`.
- `repo_inventory`: skills from extra dirs you passed (e.g. the repo's own
  `./skills`). This is a pre-install *source* listing, **not** a session cost;
  it's reported separately so it never inflates a harness baseline.
- `counts.oversized_skills` / `oversized_configs`: components past size limits
  (skills > 400 lines, rules > 10000 chars, instructions > 20000 chars; override
  via `SKILL_LINE_LIMIT` / `RULES_CHAR_LIMIT` / `INSTRUCTIONS_CHAR_LIMIT`).
- `skills[]` / `configs[]`: per-component `tokens`, `lines`, `chars` (configs
  only), `over_limit` (gated on char count for configs), and the `harness` it
  was classified into.

Report a one-line summary per harness before analysis, e.g.
`claude: ~1.4k always-on / 6 skills · copilot: ~2.4k / 21 · codex: ~1.2k / 4 (2 oversized total)`.

## Phase 2: Triage (LLM judgment)

For each flagged or heavy component, assign a bucket:

| Bucket | Meaning | Typical action |
| --- | --- | --- |
| **Keep** | Earns its always-on cost; used broadly or a hard constraint | Leave it |
| **Lazy-load** | Valuable but not every-turn: long body, niche trigger | Move detail into the skill body / a `scripts/` file / a reference doc the skill points to; tighten the frontmatter description |
| **Remove** | Redundant, stale, or duplicated by another component | Delete, or fold into the component that supersedes it |

Guidance:

- **Frontmatter is prime real estate.** Optimize a skill `description` for
  routing first: front-load user intent, trigger terms, and the nearest negative
  boundary, and preserve clauses that prevent known misroutes. Aim for a few
  sentences or a short paragraph, usually about 500 decoded characters when
  every routing signal survives; shorter and evidence-backed longer descriptions
  are valid. Push "how" detail into the body, but never trim failure-scar routing
  clauses just to hit the target. The separate 1,024-character format maximum
  remains strict; the 500-character review target is informational, not a CI or
  schema cap.
- **Oversized body ≠ remove.** If a 500-line skill rarely fires, its body is
  fine: flag it lazy-load only if it also loads constantly.
- **Instruction files and the digest are the heaviest always-on items.** Trims
  there pay back the most. Cross-check against `rules-distill`: a rule that
  duplicates a skill can often move out of the always-on digest.
- **Don't optimize blindly**: a hard behavioral constraint stays even if long.
- **Apply the no-op test**: ask whether an instruction line changes behavior
  compared to having no line at all. If the model would already do it by
  default, the line buys nothing, and it should be deleted outright rather
  than trimmed: shortening a sentence that changes nothing still pays for it
  every turn. That's a **Remove**, not a **Lazy-load**, since moving a no-op
  into the body still leaves a line there that does nothing. This isn't
  "don't optimize blindly" in reverse: a rule that merely looks obvious isn't
  automatically a no-op. Some rules exist because a model demonstrably
  violated them, and this repo records those cases, so check for a recorded
  failure, a `tasks/lessons.md` entry, or a regression case before cutting;
  that evidence is what separates a load-bearing restatement from genuine
  dead weight.

For a large audit, batch the components and analyze each batch in its own
subagent (keep the main context clean; researcher-tier work, so pick the tier
per [[efficient-frontier]] where the roster is available), then merge
recommendations.

## Phase 3: Recommend & apply

Present a summary table (`Component | Always-on tok | Lines | Bucket | Action`)
sorted by always-on cost, then per-component detail for anything Lazy-load /
Remove. **Never delete or edit config automatically: the user approves each
change.** After applying trims to skills or rules, remind the user to re-run
`./install.sh all` (or `install.ps1 all` on Windows) so the changes propagate to
every harness.

## MCP servers (outside the scanner)

MCP servers add session-dependent context cost based on available tools. Inspect
`.mcp.json` / connected servers in Claude, and MCP server configuration in
`~/.codex/config.toml` or `.codex/config.toml` in Codex.

- **MCP tools** are a large, often-overlooked cost when their names,
  descriptions, and JSON schemas are available to a session. Budget **~500
  tokens per tool** only as a rough heuristic; harness configuration and whether
  tools are deferred make the actual cost session-dependent. A server exposing
  30 tools can outweigh the entire skills surface. Recommend disabling unused
  servers, or deferring tool schemas until searched where the harness supports
  it.

`scan-context.js` does **not** parse MCP servers (session cost is not
derivable from component count); estimate MCP cost separately with the rough
heuristic above. Installed plugins remain outside the scanner because only
enabled plugins cost anything, and determining enabled state requires coupling
to `installed_plugins.json` plus an undocumented enabled flag.

## Design principles

- **Measure the always-on surface, not the total**: the body you never load is free.
- **Crude but consistent**: words × 1.3 is a comparison signal; don't over-trust the absolute number.
- **Trim the description before the body**: frontmatter is paid every turn.
- **Approval-gated**: the script measures; the user decides what to cut.
