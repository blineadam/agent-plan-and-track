---
applyTo: "**"
excludeAgent: "cloud-agent"
---

# General review instructions

This repo is a portable set of agent rules/skills/hooks for Claude Code,
Copilot, and Codex. Full conventions live in `.ai-style-rules.md` at the repo
root: read it before reviewing. Flag anything below as a review comment, not
just a suggestion.

## Writing voice

- No emoji anywhere: chat, docs, tables, commit messages, PR descriptions.
- No em dash character in prose. Use a comma, colon, or a separate sentence.
- Natural, human tone. Not combative, not overly corrective, no listicle
  cadence unless a short list is genuinely the clearest format.
- Avoid canned phrases like "this means X," "inflection point," or "here's
  the takeaway."

## Git and PR hygiene

- No AI self-attribution in commits or PRs: no `Co-Authored-By:` trailer
  naming an AI/tool, no "Generated with ..." footer, no other AI/tool
  self-reference in commit messages, PR titles, or PR bodies.

## Scope discipline

- Simplicity first: flag the smallest change that solves the problem: touch
  only necessary code.
- Root causes only: flag temporary fixes, workarounds, or unrequested
  refactors riding along with the real change.
- Flag scope creep: new abstractions, config knobs, or features the task
  didn't ask for.
- Flag unnecessarily complex implementations where a simpler one would
  clearly do (skip this for trivial, obvious fixes).

## Verification

- Flag a behavioral change with no demonstrated verification: tests, logs,
  or a described manual check.
- Flag a bug fix with no regression test, when a test harness already
  exists in the repo.
