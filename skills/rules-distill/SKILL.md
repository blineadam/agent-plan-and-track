---
name: rules-distill
description: Scan installed skills and this repo's rule files, extract cross-cutting principles that recur across skills or lessons, and distill them into rules, appending, revising, or adding sections with user approval. Use for periodic rules maintenance, after adding skills, or when promoting a recurring lessons.md pattern into a standing rule.
---

# Rules Distill

Scan the skills installed across every harness plus this repo's rule files,
find principles that recur in **2+ skills** (or repeatedly in `tasks/lessons.md`)
but aren't yet a rule, and distill them into `rules/`, with the user approving
every change. This mechanizes the manual "promote a `lessons.md` entry into
`core-rules.md`" move (e.g. PRs #6/#7).

Principle: **deterministic collection + LLM judgment**: scripts enumerate the
facts exhaustively, then a subagent cross-reads the full context and proposes
verdicts. Adapted from the ECC `rules-distill` skill for this repo's model:
the rules are two files (`rules/agent-guidelines.md`, `rules/core-rules.md`),
this repo is their source of truth, and skills live across three harness dirs.

## When to use

- Periodic rules maintenance (after installing or writing new skills)
- When `tasks/lessons.md` has a pattern that keeps recurring and belongs in the
  standing rules instead
- When the rules feel incomplete relative to the skills in use

## Phase 1: Inventory (deterministic)

Run from the repo root so `scan-rules.sh` finds `rules/`:

```bash
bash skills/rules-distill/scripts/scan-skills.sh ./skills   # installed skills + this repo's
bash skills/rules-distill/scripts/scan-rules.sh             # indexes ./rules
```

`scan-skills.sh` scans `~/.claude/skills`, `~/.copilot/skills`, and
`~/.agents/skills` (whichever exist) plus any dirs you pass. `scan-rules.sh`
indexes the H2 headings of `rules/*.md`. Report a one-line summary
(`Skills: N | Rules: M files, K headings`) before analysis.

## Phase 2: Cross-read & verdict (LLM judgment)

The rule files are small: pass their **full text** to the analysis; no grep
pre-filtering. Group the skills into thematic clusters and analyze each cluster
in its own subagent (keep the main context clean). After all clusters return,
merge candidates: dedupe overlapping principles, and re-check the "2+ skills"
bar using evidence pooled across **all** clusters.

Launch a general-purpose subagent per cluster with this prompt:

> You cross-read skills to find principles that should be promoted to standing rules.
>
> **Input**: Skills in this batch (full text); the full text of `rules/agent-guidelines.md` and `rules/core-rules.md`; and, if present, `tasks/lessons.md`.
>
> **Include a candidate only if ALL hold:**
> 1. **Recurs**: appears in 2+ skills (or repeatedly in lessons.md). One-skill principles stay in that skill.
> 2. **Actionable**: expressible as "do X" / "don't do Y", not "X matters".
> 3. **Clear violation risk**: one sentence on what breaks if ignored.
> 4. **Not already covered**: check the full rules text, including the same idea in different words.
>
> **Assign a verdict** per candidate: `Append` (to an existing section), `Revise` (existing rule is wrong/insufficient; give before/after), `New Section`, `New File`, `Already Covered`, or `Too Specific` (stays in the skill).
>
> **Output** JSON per candidate: `{principle, evidence:[skill §section], violation_risk, verdict, target ("agent-guidelines.md §… / core-rules.md / new"), confidence, draft (for Append/New), revision:{reason,before,after} (for Revise)}`.
>
> **Exclude**: principles already in rules; language/framework-specific knowledge; code examples and commands (those stay in skills).

Remember this repo's own top lesson: **keep rule content tool-agnostic**: no
harness names in a shared rule. And respect the taxonomy: a constant
behavioral constraint belongs in the instructions file + digest, not a skill.

## Phase 3: User review & execution

Present a summary table (`# | Principle | Verdict | Target | Confidence`)
followed by per-candidate details (evidence, violation risk, draft, or
before/after for revisions). Then:

- The user approves / modifies / skips each candidate by number.
- **Never edit the rules automatically: always require approval.**
- When editing `rules/core-rules.md`, keep the matching one-liner in sync with
  the fuller bullet in `rules/agent-guidelines.md` (they mirror each other).
- After applying, remind the user to re-run `./install.sh all` so the digest and
  instruction managed blocks propagate to every harness (and to restart
  Copilot/Codex sessions for instruction-file changes).

## Design principles

- **What, not how**: extract principles (rules territory); code and commands stay in skills.
- **Link back**: draft rule text can reference the source skill so readers find the detailed how.
- **Anti-abstraction filter**: the 3 gates (2+ evidence, actionable test, violation risk) keep vague abstractions out of the rules.
