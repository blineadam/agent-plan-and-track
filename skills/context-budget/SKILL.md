---
name: context-budget
description: Audit the always-on context cost of the agent config (skills, instruction files, and the rules digest), estimate tokens, flag oversized components, and recommend trims (keep / lazy-load / remove). Use when the context feels bloated, after adding several skills or rules, or as periodic hygiene on the instruction surface. Not for compacting a long conversation; that's strategic-compact.
---

# Context Budget

Estimate what the agent config costs in every session and find the bloat. The
always-on surface (instruction files, the rules digest, every skill's
frontmatter, and every agent's routing text) loads into the context window on
*every* turn, before the task even starts. This skill enumerates that surface,
estimates its token cost, flags oversized components, and sorts each into
**keep / lazy-load / remove**.

Method: **deterministic collection + LLM judgment**. A script enumerates and
estimates exhaustively, then you (or a subagent) read the findings and
recommend trims. [[strategic-compact]] manages the *conversation* growing; this
manages the *config* baseline.

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

## Phase 1: Measure (deterministic)

Run the script (execute it; read only its header comment for the output fields) from the repo root so
`./skills` is included alongside the installed dirs:

```bash
node skills/context-budget/scripts/scan-context.js ./skills
```

It scans `~/.claude/skills`, `~/.copilot/skills`, `~/.agents/skills` (whichever
exist) plus any dirs you pass, each harness's instruction file, and the
core-rules digest (`core-rules.md`, plus `core-rules.local.md` where present).
The token estimate is crude (**words x 1.3**), a relative bloat signal, not a
tokenizer. Output is JSON, fields documented in the script's header. The ones
to use:

- `harnesses.{claude,copilot,codex}.always_on_tokens`: **the number to drive
  down, per harness** (skill frontmatter + instruction file + digest + agent
  routing text). The harnesses are mutually exclusive: a session pays *one*
  column, never the sum. For Codex it is an upper-bound estimate.
- `counts.oversized_skills` / `oversized_configs`, with per-component entries in
  `skills[]` / `configs[]`.
- `harnesses.*.skill_body_tokens` is on-demand and informational; `repo_inventory`
  is a pre-install source listing, never a session cost.

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
  routing first and never trim failure-scar routing clauses just to hit a
  length target; the length rules (about 500 decoded characters informational,
  1,024 hard maximum) are in [[skill-activation]].
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
  failure, a `.tasks/lessons.md` entry, or a regression case before cutting;
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
