---
name: copilot-review-instructions
description: Generate or refresh path-scoped .github/instructions/*.instructions.md files so GitHub Copilot's PR review enforces a project's actual conventions instead of generic defaults. Gathers review-worthy rules from every source the project already has, including .ai-style-rules.md, the project's own instructions file (CLAUDE.md / AGENTS.md / .github/copilot-instructions.md), README, CONTRIBUTING, docs, plus a bounded source scan. Use whenever those conventions are created or change, or the project's directory/language layout changes (buckets and globs derive from it), and the project uses GitHub Copilot code review, either right after [[inherit-legacy-style]] captures implicit conventions or standalone. The generated artifact is Copilot-only, since no Claude or Codex equivalent exists.
---

# copilot-review-instructions

Collects the review-worthy conventions a project already documents (or that
[[inherit-legacy-style]] inferred from its code) and translates the union into
Copilot's native review-instruction format, so its PR review flags real
convention violations instead of applying generic defaults. Adapted from the
manual process used to write this repo's own
`.github/instructions/*.instructions.md`: three rounds of Copilot review against
them caught real drift between the documented rules and the generated
instructions, and the anti-patterns below come straight from that history.

Boundary with [[inherit-legacy-style]]: that skill infers *unwritten*
conventions from code and records them in `.ai-style-rules.md`. This skill
collects *all* review-worthy material, both written (instructions files, README,
docs) and inferred (`.ai-style-rules.md`), and converts the combined set into
Copilot's format. Run [[inherit-legacy-style]] first when you also want the
implicit-convention layer; it isn't required if the project already documents
its rules elsewhere.

## Precondition

Confirm both, in one line each, before writing anything:

1. At least one real source of conventions exists: `.ai-style-rules.md`, a
   project instructions file (`CLAUDE.md` / `AGENTS.md` /
   `.github/copilot-instructions.md`), `README.md`, `CONTRIBUTING.md`, or a
   `docs/` directory. If none exist, run [[inherit-legacy-style]] first for the
   implicit-convention layer, then stop here.
2. The project uses (or plans to use) GitHub Copilot's PR code review. If
   unclear, ask: don't generate Copilot-specific files for a project that
   doesn't use Copilot.

## Step 1: Gather sources

Read every convention source the project already has, in this order, and note
which rules each one carries:

1. **`.ai-style-rules.md`** if present: implicit code conventions (Golden
   Files, Naming & State-Control, DONTs) from [[inherit-legacy-style]].
2. **The project's instructions file(s)** such as `CLAUDE.md`, `AGENTS.md`,
   `.github/copilot-instructions.md`, or a `rules/` directory of shared rule
   files: explicit standing rules (writing voice, git/PR hygiene, scope
   discipline, verification). These are prime review-directive material and
   usually live nowhere near `.ai-style-rules.md`.
3. **`README.md`, `CONTRIBUTING.md`, `docs/`**: human-written guidance already
   in the repo (layout conventions, contribution rules). For a large
   documentation tree, apply the same scale-tiered sampling as the source scan
   below: index first, read fully only within the tier's budget, so this step
   can't blow the context budget on a large repo.
4. **A bounded scan of source itself**, scaled to repo size the way
   [[inherit-legacy-style]] tiers its sampling, to ground the documented rules
   in real examples and to derive the actual directory/extension globs Step 2
   needs. If the scan surfaces an apparently review-worthy convention that no
   source documents, don't promote it here: route it through
   [[inherit-legacy-style]] so its majority and conflict checks decide whether
   it's a real rule. Inferring new conventions from code is that skill's job,
   not this one's.

Treat any lint/CI config as context only, don't transcribe it: a review
instruction shouldn't restate a rule a linter already blocks mechanically, since
flagging it in review adds nothing the pipeline doesn't already enforce.

## Step 2: Partition into path-scoped buckets

From the union of everything gathered (not just `.ai-style-rules.md`'s
sections), group rules by the files they govern. Derive buckets from what's
actually present, not from an assumed language or stack.

Before bucketing, resolve same-scope conflicts: if two sources give
contradictory directives for the same files (e.g. the README says X, the
instructions file says not-X), that's a conflict, not a union. Surface it the
same one-question-at-a-time way [[inherit-legacy-style]] resolves conflicts,
and drop the losing directive rather than folding both into the same bucket.

- **One repo-wide bucket** (`applyTo: "**"`), only if at least one genuinely
  repo-wide rule was gathered, for rules that apply regardless of file type:
  writing voice, PR/commit hygiene, scope discipline, verification
  expectations. These usually come from the instructions file, not
  `.ai-style-rules.md`. Skip this bucket for a project whose gathered rules
  are exclusively path-scoped, rather than emitting an empty or invented
  repo-wide file.
- **One bucket per distinct area** evidenced by the sources: group by shared
  directory prefix or file extension actually present (e.g. a scripts cluster
  from `.ai-style-rules.md`'s Golden Files, a docs/skill cluster from the
  README's layout and the instructions file's doc rules). A small project may
  only need the repo-wide bucket; a large one may need several. Don't force a
  fixed count or names like "scripts"/"docs" onto a project whose structure
  doesn't have that shape.

## Step 3: Draft each file

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

Body: a one-line H1, a pointer back to whichever source(s) actually back the
bucket's rules (`.ai-style-rules.md`, the instructions file, the README, or a
combination) rather than a restatement of them, then a handful of H2 sections
converting those rules into imperative "Flag ..." review directives.
Immediately below the frontmatter, add one HTML comment marker:

```markdown
<!-- Generated by copilot-review-instructions; edits here are overwritten on the next run. -->
```

## Step 4: Verify before writing

Check every asserted rule against the real source it cites: the actual Golden
File, the exact line in the instructions file, the README section. Don't
transcribe from memory or from what a source merely implies. Most of the issues
in this skill's own origin story (see Anti-patterns) were instructions that
sounded right but were contradicted by the actual source they claimed to
describe.

## Step 5: Regenerate, don't accumulate

Unlike an append-only style log, these files have no history worth preserving:
they're a pure function of the current sources. On each run, fully regenerate
every file this skill owns (identified by the marker comment from Step 3), and
delete any marker-owned file whose bucket is no longer in the current set, so a
dropped language or directory can't leave stale directives behind. If an
existing `.github/instructions/*.instructions.md` file lacks that marker, treat
it as hand-authored: don't overwrite it silently, flag it to the user instead.

## Anti-patterns

All of these are real issues a three-round Copilot review caught in this
skill's own origin PR:

- **Treating `.ai-style-rules.md` as the only input.** The project's own
  instructions file, README, or docs usually carry review-worthy rules (writing
  voice, git hygiene, verification) that `.ai-style-rules.md` never covers.
  Gather from every source in Step 1, not just the style file.
- **Restating a lint/CI-enforced rule.** If a linter or CI check already blocks
  something mechanically, a review directive repeating it adds nothing Copilot
  can act on differently. Keep review instructions to what needs human-style
  judgment.
- **Asserting a rule without checking the source it cites.** Contradicted
  claims (a "rule" the actual source doesn't follow) were the majority of
  findings across all three review rounds.
- **Skipping `excludeAgent: "cloud-agent"`.** These files are review
  directives, not general coding instructions.
- **Self-contradicting the project's own writing-voice rules inside the
  generated prose** (e.g. using an em dash while writing a no-em-dash rule).
- **Duplicating a source instead of pointing to it.** Match its density; don't
  inflate the instructions file into a second copy.
- **Hardcoding a language/stack assumption into the bucket logic.** Derive
  buckets from the files actually present in this project, not from what a
  previous project happened to have.
- **Silently overwriting a hand-edited instructions file.** Check for the
  marker comment first.

## Portability

Installs and runs on all three harnesses: any agent can generate these files for
a repo that uses Copilot's PR review, and [[inherit-legacy-style]] (portable)
offers to invoke it. Only the output is Copilot-specific, since `applyTo` path
scoping and `excludeAgent` are GitHub Copilot code-review features with no Claude
Code or Codex equivalent. There's no harness-specific mechanism to gate, so the
skill body is identical everywhere, unlike the guidance-plus-one-mechanism split
in [[strategic-compact]] or [[skill-activation]].
