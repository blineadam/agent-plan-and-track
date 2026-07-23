---
name: inherit-legacy-style
description: Capture a legacy codebase's implicit conventions as a standing constraint (.ai-style-rules.md) so AI-generated patches match the existing style instead of drifting toward mainstream pretrained idioms. Use when onboarding onto a hand-written legacy project, when the user worries AI code "doesn't look like our code", or to codify a project's unwritten rules. Language- and framework-agnostic, aligns meta-architecture, not syntax.
---

# Inherit Legacy Style

Prevents AI style drift in legacy projects: scan the codebase for implicit
conventions, resolve genuine conflicts with the user one at a time, and
crystallize the consensus into an enforceable `.ai-style-rules.md` at the
project root. Adapted from the ECC `inherit-legacy-style` skill.

## Step 0: Detect mode

Check for `.ai-style-rules.md` at the project root. Missing → **first-time
full scan**. Present → **incremental update**. Announce the detected mode and
scale tier in one line, then proceed. Don't ask the user to pick.

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

## Incremental update

1. Read the existing `.ai-style-rules.md`; diff from its recorded commit
   fingerprint to HEAD (`--stat` first) to find what changed.
2. Compare new code against the recorded rules; run only *new* conflicts
   through the one-question-at-a-time protocol.
3. Append a dated `### [YYYY-MM-DD] Style Evolution Log` entry; never
   rewrite existing rules.
4. If this update changed any convention and the project uses (or plans to
   use) GitHub Copilot's PR code review, re-offer [[copilot-review-instructions]]
   under the same gate as first-time Step 6, so the generated review files
   refresh against the new rules instead of going stale. Skip the offer when
   nothing review-worthy changed or the project doesn't use Copilot review.

## Per-turn enforcement

When `.ai-style-rules.md` is loaded, open every code-writing task with a
one-line compliance declaration: which Golden File you're following and which
DONTs apply.

## Anti-patterns

- Skipping the scale measurement: sampling a 30-file project starves it;
  close-reading a 5,000-file repo blows the budget.
- Stacking conflict questions: strictly one at a time.
- Overwriting rules in incremental mode: always append the evolution log.
- Defaulting to hard enforcement: persistence strength is the user's call.
- Judging syntax or stack quality: this aligns meta-architecture only.
- Copying bugs from exemplar files: reuse structure, flag defects.
