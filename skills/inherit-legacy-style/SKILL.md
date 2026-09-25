---
name: inherit-legacy-style
description: Capture a legacy codebase's implicit conventions as a standing constraint (in its existing convention docs, else .ai-style-rules.md) so AI-generated patches match the existing style instead of drifting toward mainstream idioms. Use when onboarding onto a hand-written legacy project, when the user worries AI code "doesn't look like our code", or to codify a project's unwritten rules. Language- and framework-agnostic, aligns meta-architecture, not syntax.
---

# Inherit Legacy Style

Prevents AI style drift in legacy projects: scan the codebase for implicit
conventions, resolve genuine conflicts with the user one at a time, and
record the consensus where the project already keeps its rules. A project
with no convention docs gets an enforceable `.ai-style-rules.md` at the
project root; a project that already documents its conventions gets the
uncovered ones proposed into those docs instead, so every rule has exactly
one owner. Adapted from the ECC `inherit-legacy-style` skill.

## Step 0: Detect mode

Check two things:

1. **Convention docs**: markdown that states how code here should be written
   (naming, structure, error handling, patterns), such as the instructions
   files (`CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`),
   `CONTRIBUTING.md`, style or review guides, `docs/**/*.md`, or a
   subdirectory's own `README.md`. A README that only says what the project
   is and how to run it doesn't count. Skip `.ai-style-rules.md` itself and
   anything generated from these rules: a `.github/instructions/` file
   carrying the copilot-review-instructions marker, and the marker-owned
   `# Code reviews` section of `.github/copilot-instructions.md` (the rest of
   that file still counts). Reading those back would count the rules as their
   own source.
2. **`.ai-style-rules.md`** at the project root.

| Convention docs | `.ai-style-rules.md` | Mode |
| --- | --- | --- |
| None | Missing | First-time full scan |
| None | Present | Incremental update |
| Present | Missing | Docs gap scan |
| Present | Present | Fold into docs |

Announce the detected mode and scale tier in one line, then proceed. Don't
ask the user to pick.

## First-time full scan

**1. Measure scale, pick a sampling tier**: count tracked source files
(`git ls-files` filtered to source extensions):

| Tier | Source files | Strategy |
| --- | --- | --- |
| Small | ≲ 50 | Close-read every source file |
| Medium | 50–500 | Infrastructure layer read fully; business layer sampled 2–3 files per dimension |
| Large | ≳ 500 | Strict sampling; summaries first, targeted reads after |

**2. Scan four meta-architecture dimensions** (not syntax, not tech-stack
quality):

1. **File anatomy**: in-file declaration order (imports → types → main
   logic → helpers → exports).
2. **State & control flow**: naming for async state, pagination, flags.
3. **Infrastructure placement**: where cross-cutting utilities live
   (interceptors, formatters, middleware).
4. **Error handling**: try/catch vs global handler vs Result returns;
   null-check habits.

**3. Filter noise before involving the user.** A minority pattern under 5%
of occurrences *and* fewer than 10 instances is weak signal: majority wins,
minority goes to the DONTs list. A near-even split, or a semantic fork on a
core dimension, is a strong signal; ask. Small-project exception: at ≲ 50
files, "3 vs 2" is not a majority; ask.

**4. Resolve conflicts one at a time.** For each strong-signal conflict,
present exactly one question with evidence and four options: follow style A,
follow style B, "this is deliberate evolution, record the new direction", or
"I have a different rule". Wait for the answer before the next question;
never stack questions.

**5. Write `.ai-style-rules.md`** with a commit fingerprint and scale tier in
the header, plus three mandatory sections:

- **Golden Files**: real exemplar paths, annotated with what each
  demonstrates.
- **Naming & State-Control Rules**: concrete, checkable conventions.
- **DONTs**: anti-patterns that must not propagate.

Write every rule, and the header, as the convention that holds now, never as
the story of how it got there.

**6. Offer persistence** (the user picks; never default to enforcement):

- **Soft (recommended)**: reference `.ai-style-rules.md` from the project's
  instructions file (`CLAUDE.md` / `AGENTS.md` /
  `.github/copilot-instructions.md`) so it loads every session.
- **Hard (current Claude Code implementation)**: soft, plus a `PreToolUse`
  hook on Edit/Write in `settings.json` for mechanical enforcement. Codex
  supports lifecycle hooks, but this package does not add an equivalent Codex
  enforcement hook.
- **None**: keep the file; the user references it manually.

Independent of persistence strength, if the project uses (or plans to use)
GitHub Copilot's PR code review, offer to also invoke
[[copilot-review-instructions]] to generate path-scoped
`.github/instructions/*.instructions.md` review directives. That skill draws
on the rules just written plus the rest of the project's documented
conventions (its instructions file, README, and docs), not on
`.ai-style-rules.md` alone. Skip this offer entirely for projects that don't
use Copilot review.

## Docs gap scan

The project already documents its conventions, so the docs stay the one
place rules live. Never create `.ai-style-rules.md` in this mode.

1. Read the convention docs and note which rules each one states.
2. Run first-time steps 1 to 4. A convention a doc already states is covered:
   don't ask about it or restate it. Code whose majority contradicts a
   documented rule is a strong-signal conflict (the doc or the code has
   drifted), so it goes through step 4 like any other.
3. For each uncovered convention, propose an addition to the doc that already
   owns that topic, or to the instructions file when none does: show the
   target file and the exact text, written in that doc's own voice and
   structure. Apply only what the user approves; a declined proposal is
   dropped, not parked in a new file.
4. Offer [[copilot-review-instructions]] under first-time step 6's Copilot
   gate. Offer the soft persistence reference only when the instructions
   file doesn't already point at the docs that changed.

There is no fingerprint in this mode: the docs are the record, and each run
is a fresh gap scan.

## Fold into docs

The project has convention docs and a `.ai-style-rules.md` beside them, so
some rules have two owners and others sit apart from the rest. Announce the
fold, then:

1. Drop each rule a doc already states.
2. Propose each remaining rule into the doc that owns its topic, the same way
   as docs gap scan step 3.
3. Once every remaining rule has landed in a doc, delete `.ai-style-rules.md`,
   repoint anything that references it (the instructions file, generated
   review directives), and re-offer [[copilot-review-instructions]] under the
   same gate.

If the user declines the fold, or nobody is available to approve doc edits,
keep the file and run the incremental update below, dropping from the file
any rule a doc now states and pointing to that doc instead.

## Incremental update

1. Read the existing `.ai-style-rules.md`; diff from its recorded commit
   fingerprint to HEAD (`--stat` first) to find what changed.
2. Compare new code against the recorded rules; run only *new* conflicts
   through the one-question-at-a-time protocol.
3. Record each change in place: add, revise, or remove the rule in its
   section (Golden Files / Naming & State-Control Rules / DONTs), and restamp
   the header's fingerprint to HEAD. In a git-tracked project the file keeps
   no changelog, since the commit that changes it is the change record: no
   dated entries, and no "since the last round" or "was generalized to"
   narration inside a rule. Outside git nothing else records the history, so
   also append a dated `### [YYYY-MM-DD] Style Evolution Log` entry there.
4. If this update changed any convention and the project uses (or plans to
   use) GitHub Copilot's PR code review, re-offer [[copilot-review-instructions]]
   under the same gate as first-time Step 6, so the generated review files
   refresh against the new rules instead of going stale. Skip the offer when
   nothing review-worthy changed or the project doesn't use Copilot review.
5. **Fold a leftover log.** A git-tracked file that still carries a Style
   Evolution Log from an earlier version of this skill gets it folded once,
   announced to the user first, never silent. Promote each convention that
   lives only in a log entry and is still live (not superseded or reverted by
   a later entry) into its section, drop every entry, delete the log heading,
   and rewrite any history narration in the header and sections as current
   state. Git history is the archive. A still-open deferred conflict from the
   log goes back through the one-question protocol rather than surviving in
   the file.

## Per-turn enforcement

When `.ai-style-rules.md` is loaded, open every code-writing task with a
one-line compliance declaration: which Golden File you're following and which
DONTs apply.

## Anti-patterns

- Skipping the scale measurement: sampling a 30-file project starves it;
  close-reading a 5,000-file repo blows the budget.
- Stacking conflict questions: strictly one at a time.
- Creating `.ai-style-rules.md` beside convention docs, or restating in it
  what a doc already says: a rule with two owners drifts.
- Keeping a changelog in a git-tracked project: dated entries, round-by-round
  diffs, or before-and-after narration inside a rule. The file states the
  current conventions; git records how they changed.
- Editing a hand-written doc without the user's approval of the exact text.
- Defaulting to hard enforcement: persistence strength is the user's call.
- Judging syntax or stack quality: this aligns meta-architecture only.
- Copying bugs from exemplar files: reuse structure, flag defects.
