---
name: rules-distill
description: Scan installed skills and this repo's rule files, extract cross-cutting principles that recur across skills or lessons, and distill them into rules, appending, revising, or adding sections with user approval. Use for periodic rules maintenance, after adding skills, or when promoting a recurring lessons.md pattern into a standing rule.
---

# Rules Distill

Scan the skills installed across every harness plus this repo's rule files,
find principles that recur in **2+ skills** (or repeatedly in `.tasks/lessons.md`)
but aren't yet a rule, and distill them into `rules/`, with the user approving
every change.

Method: **deterministic collection + LLM judgment**. Scripts enumerate the
facts exhaustively, then a subagent cross-reads the full context and proposes
verdicts. The rules are two files (`rules/agent-guidelines.md`,
`rules/core-rules.md`); this repo is their source of truth, and skills live
across three harness dirs. Use it for periodic rules maintenance, when
`.tasks/lessons.md` has a recurring pattern that belongs in the standing rules,
or when the rules feel incomplete relative to the skills in use.

## Phase 1: Inventory (deterministic)

Run from the repo root so `scan-rules.js` finds `rules/`:

```bash
node skills/rules-distill/scripts/scan-skills.js ./skills   # installed skills + this repo's
node skills/rules-distill/scripts/scan-rules.js             # indexes ./rules
```

`scan-skills.js` scans `~/.claude/skills`, `~/.copilot/skills`, and
`~/.agents/skills` (whichever exist) plus any dirs you pass. `scan-rules.js`
indexes the H2 headings of `rules/*.md`. Report a one-line summary
(`Skills: N | Rules: M files, K headings`) before analysis.

## Phase 2: Cross-read & verdict (LLM judgment)

The rule files are small: pass their **full text** to the analysis; no grep
pre-filtering. Group the skills into thematic clusters and analyze each cluster
in its own subagent (keep the main context clean; this is researcher-tier work,
so pick the tier per [[efficient-frontier]] where the roster is available).
After all clusters return, merge candidates: dedupe overlapping principles,
and re-check the "2+ skills" bar using evidence pooled across **all**
clusters.

Launch a general-purpose subagent per cluster with this prompt:

> You cross-read skills to find principles that should be promoted to standing rules.
>
> **Input**: Skills in this batch (full text); the full text of `rules/agent-guidelines.md` and `rules/core-rules.md`; and, if present, `.tasks/lessons.md`.
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

Keep rule content tool-agnostic: no harness names in a shared rule. Respect
the taxonomy: a constant behavioral constraint belongs in the instructions
file rather than a skill. Whether it also belongs in the digest is a separate
question, answered by the selection criteria in AGENTS.md's rule-delivery
section, since the digest is a deliberate subset of the instruction file.

## Phase 3: User review & execution

Present a summary table (`# | Principle | Verdict | Target | Confidence`)
followed by per-candidate details (evidence, violation risk, draft, or
before/after for revisions). Then:

- The user approves / modifies / skips each candidate by number.
- Draft rule text can reference the source skill so readers find the detailed how.
- **Never edit the rules automatically: always require approval.**
- When editing `rules/core-rules.md`, keep any bullet the digest carries in sync
  with the fuller bullet in `rules/agent-guidelines.md`. The digest is a
  deliberate subset, not a mirror (see AGENTS.md's rule-delivery section): some
  rules live at full force only in `rules/agent-guidelines.md`, and re-adding
  one of those to the digest is drift, not a gap to close.
- After applying, remind the user to re-run `./install.sh all` (or `install.ps1 all` on Windows) so the digest and
  instruction managed blocks propagate to every harness (and to restart
  Copilot/Codex sessions for instruction-file changes).

When drafting new rule text, state the target rather than the trap: prefer
"do X" over "never Y" where either works, since naming the forbidden behavior
keeps it in context. This does not license rewriting existing "never X" rules:
a prohibition backed by a hook or CI gate, or written to name a specific
recorded failure, stays as it is.
