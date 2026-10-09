---
name: copilot-review-instructions
description: Use to generate or refresh GitHub Copilot review instructions, both the path-scoped files and the repo-wide code-review section, when a Copilot-reviewed project's conventions or directory/language layout change, after inherit-legacy-style or standalone. Only the output is Copilot-specific.
---

# copilot-review-instructions

Collects the review-worthy conventions a project already documents (or that
[[inherit-legacy-style]] inferred from its code) and translates the union into
Copilot's native review-instruction format, so its PR review flags real
convention violations instead of applying generic defaults.

Boundary with [[inherit-legacy-style]]: that skill infers *unwritten*
conventions from code and records them in the project's on-demand convention
docs (`CONTRIBUTING.md`, style guides, `docs/`), or in `.ai-style-rules.md`
when it has none, never in an instructions file. This skill
collects *all* review-worthy material, both written (instructions files, README,
docs, a writing skill's prohibitions on its output file) and inferred (`.ai-style-rules.md`), and converts the combined set into
Copilot's format. Run [[inherit-legacy-style]] first when you also want the
implicit-convention layer; it isn't required if the project already documents
its rules elsewhere.

## Precondition

Confirm both, in one line each, before writing anything:

1. At least one real source of conventions exists: `.ai-style-rules.md`, a
   project instructions file (`CLAUDE.md` / `AGENTS.md` /
   `.github/copilot-instructions.md`), `README.md`, `CONTRIBUTING.md`, a
   `docs/` directory, or a nested `**/README.md`. If none exist, run
   [[inherit-legacy-style]] first for the implicit-convention layer, then stop
   here.
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
   usually live nowhere near `.ai-style-rules.md`. Skip the marker-owned
   `# Code reviews` section of `.github/copilot-instructions.md`, since Step 6
   generates it from this gathering: reading it back would let one run's output
   become the next run's input and drift away from the real sources.
3. **`README.md`, `CONTRIBUTING.md`, `docs/`, and any nested `**/README.md`**:
   human-written guidance already in the repo (layout conventions,
   contribution rules), including a subdirectory's own README explaining that
   folder's conventions, not just the repo root's. For a large documentation
   tree (root docs plus many nested READMEs), apply the same scale-tiered
   sampling as the source scan below: index first, read fully only within the
   tier's budget, so this step can't blow the context budget on a large repo.
4. **A skill that writes a file the buckets cover**: when a skill checked into
   the repo (for example [[inherit-legacy-style]], which maintains
   `.ai-style-rules.md`) writes or maintains a tracked file Step 2's buckets will cover,
   read its body for prohibitions on that output file's content, wherever they
   appear: what the file must not contain. Its layout rules and a line about how
   the skill itself works (its steps, modes, prompts) aren't one. The skill body
   is then a source like any other, and the bucket's pointer names it.
5. **A bounded scan of source itself**, scaled to repo size the way
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
bucket's rules (`.ai-style-rules.md`, the instructions file, the README, a writing skill's `SKILL.md`, or a
combination) rather than a restatement of them, then a handful of H2 sections
converting those rules into imperative "Flag ..." review directives.
Immediately below the frontmatter, add one HTML comment marker:

```markdown
<!-- Generated by copilot-review-instructions; edits here are overwritten on the next run. -->
```

## Step 4: Verify before writing

Check every asserted rule against the real source it cites: the actual Golden
File, the exact line in the instructions file, the README section. Don't
transcribe from memory or from what a source merely implies. For a convention
taken from a skill body, quote the line in the current `SKILL.md` that states
it as a requirement on the output file; drop it if the line only describes the
skill's own procedure.

## Step 5: Regenerate, don't accumulate

Unlike an append-only style log, these files have no history worth preserving:
they're a pure function of the current sources. On each run, fully regenerate
every file this skill owns (identified by the marker comment from Step 3), and
delete any marker-owned file whose bucket is no longer in the current set, so a
dropped language or directory can't leave stale directives behind. If an
existing `.github/instructions/*.instructions.md` file lacks that marker, treat
it as hand-authored: don't overwrite it silently, flag it to the user instead.

## Step 6: Own the `# Code reviews` section of `.github/copilot-instructions.md`

Copilot documents no inclusion directive for this file, so an `@path` line
importing conventions into it is inert text: never use one. Instead this skill
owns a `# Code reviews` section that points the reviewer at the sources and says
how to review. Read [references/code-reviews-section.md](references/code-reviews-section.md)
before generating or refreshing it. Obligations that hold regardless:

- Create the file if missing; append the section when the file has no
  `# Code reviews` H1.
- Write the Step 3 marker as the section's first line under the
  `# Code reviews` heading.
- Regenerate an existing section in place only when its first line under the
  heading is the Step 3 marker. An unmarked section is possibly hand-authored:
  confirm its provenance with the user before replacing anything, never adopt it
  silently.
- Leave everything outside the section alone: the heading and the next H1 (or
  end of file) bound what this skill owns.

## Anti-patterns

- **Self-contradicting the project's own writing-voice rules inside the
  generated prose** (e.g. using an em dash while writing a no-em-dash rule).
- **A directive about a path its bucket's `applyTo` doesn't match.** Copilot
  loads a bucket only for files its globs cover, so the directive never fires.
  Widen the glob to that path or move the directive to a bucket that covers it.

## Portability

Installs on all three harnesses with an identical body; the generated output is
Copilot-specific (`applyTo` and `excludeAgent` are GitHub Copilot code-review
features). For Codex, put project review constraints under `## Code Review
Rules` in the closest applicable `AGENTS.md`; this skill does not generate that.
