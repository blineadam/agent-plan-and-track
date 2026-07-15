---
name: copilot-review-instructions
description: Generate or refresh path-scoped .github/instructions/*.instructions.md files from .ai-style-rules.md, so GitHub Copilot's PR review enforces a project's actual conventions instead of generic defaults. Use whenever .ai-style-rules.md is created or changes and the project uses GitHub Copilot code review: after [[inherit-legacy-style]] produces it, or standalone if the style file already exists. Copilot-only: no Claude/Codex equivalent artifact exists.
---

# copilot-review-instructions

Translates an already-captured `.ai-style-rules.md` into Copilot's native
review-instruction format, so Copilot's PR review flags real convention
violations instead of applying generic defaults. Adapted from the manual
process used to write this repo's own `.github/instructions/*.instructions.md`:
three rounds of Copilot review against them caught real drift between the
style rules and the generated instructions, and the anti-patterns below come
straight from that history.

This skill only translates; it doesn't scan the codebase itself. If
`.ai-style-rules.md` doesn't exist yet, run [[inherit-legacy-style]] first and
stop here.

## Precondition

Confirm both, in one line each, before writing anything:

1. `.ai-style-rules.md` exists at the project root.
2. The project uses (or plans to use) GitHub Copilot's PR code review. If
   unclear, ask: don't generate Copilot-specific files for a project that
   doesn't use Copilot.

## Step 1: Partition into path-scoped buckets

Read `.ai-style-rules.md`'s Golden Files, Naming & State-Control Rules, and
DONTs sections. Derive buckets from what's actually there, not from an assumed
language or stack:

- **One repo-wide bucket** (`applyTo: "**"`) for rules that apply regardless
  of file type: writing voice, PR/commit hygiene, scope discipline,
  verification expectations.
- **One bucket per distinct area** evidenced by the Golden Files' own paths:
  group by shared directory prefix or file extension actually present (e.g.
  everything under a `hooks/` + `*.sh` cluster, everything under a docs/skill
  cluster). A small project may only need the repo-wide bucket; a large one
  may need several. Don't force a fixed count or names like "scripts"/"docs"
  onto a project whose structure doesn't have that shape.

## Step 2: Draft each file

Path: `.github/instructions/<bucket>.instructions.md`. Frontmatter:

```yaml
---
applyTo: "<glob or comma-separated globs>"
excludeAgent: "cloud-agent"
---
```

`excludeAgent: "cloud-agent"` is mandatory on every generated file: these are
phrased as review directives ("flag X"), not instructions for an autonomous
coding agent, and belong scoped away from Copilot's cloud coding agent.

Body: a one-line H1, a pointer back to `.ai-style-rules.md` rather than a
restatement of it, then a handful of H2 sections converting Golden
Files/Naming rules/DONTs into imperative "Flag ..." review directives.
Immediately below the frontmatter, add one HTML comment marker:

```markdown
<!-- Generated from .ai-style-rules.md by copilot-review-instructions; edits here are overwritten on the next run. -->
```

## Step 3: Verify before writing

Check every asserted rule against the real Golden File it cites. Don't
transcribe from memory or from what `.ai-style-rules.md` merely implies.
Most of the issues in this skill's own origin story (see Anti-patterns) were
instructions that sounded right but were contradicted by the actual source
they claimed to describe.

## Step 4: Regenerate, don't accumulate

Unlike `.ai-style-rules.md`'s append-only evolution log, these files have no
history worth preserving: they're a pure function of the current
`.ai-style-rules.md`. On each run, fully regenerate every file this skill
owns (identified by the marker comment from Step 2). If an existing
`.github/instructions/*.instructions.md` file lacks that marker, treat it as
hand-authored: don't overwrite it silently, flag it to the user instead.

## Anti-patterns

All of these are real issues a three-round Copilot review caught in this
skill's own origin PR:

- **Asserting a rule without checking the source it cites.** Contradicted
  claims (a "rule" the actual golden file doesn't follow) were the majority
  of findings across all three review rounds.
- **Skipping `excludeAgent: "cloud-agent"`.** These files are review
  directives, not general coding instructions.
- **Self-contradicting the project's own writing-voice rules inside the
  generated prose** (e.g. using an em dash while writing a no-em-dash rule).
- **Duplicating `.ai-style-rules.md` instead of pointing to it.** Match its
  density; don't inflate the instructions file into a second copy.
- **Hardcoding a language/stack assumption into the bucket logic.** Derive
  buckets from the Golden Files actually present in this project, not from
  what a previous project happened to have.
- **Silently overwriting a hand-edited instructions file.** Check for the
  marker comment first.

## Portability

Copilot-only. `applyTo` path scoping and `excludeAgent` are a GitHub Copilot
code-review feature with no Claude Code or Codex equivalent artifact, so this
skill has nothing to port, unlike the portable-guidance-plus-one-mechanism
split used by [[strategic-compact]] or [[skill-activation]].
