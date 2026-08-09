# Out of scope

## What this file holds

This file records a decision not to build something, so a later session does not re-propose it without knowing the ground was already covered. A rejected proposal has no natural home file of its own, which is exactly why it needs a shared one.

A decision about how an existing component behaves stays in that component's own header, where the code that implements it lives, not here. `hooks/gateguard.js`'s header is the exemplar: it records why the ECC destructive-Bash gate was not ported, right where a future editor of that file will hit it.

`tasks/lessons.md` is a different thing again: it holds a correction about how to work, so a mistake does not recur. It is gitignored, session-local bookkeeping, while this file is checked in.

An entry here is a starting point for re-litigation, not a permanent ban. A new argument or a changed circumstance can reopen a decision, and the entry should then be updated rather than silently contradicted.

## `codebase-onboarding` stays skipped

Re-reviewed 2026-07-13 and 2026-07-16 during the ecc port. Its two outputs duplicate `/init` and `inherit-legacy-style`, and the one genuine gap, the decision-matrix/lifecycle rendering, is thin enough for an ad hoc prompt instead of a dedicated skill.

## Five other ecc skills stay skipped as redundant

Redundant with behavior already installed here, which is not always shipped as a skill: `verification-loop` is covered by the `delivery-gate` hook plus the verify-before-done rule, `growth-log` by `capture-lesson`, `token-budget-advisor` by `context-budget`, and `agent-self-evaluation` by `skill-comply`. `continuous-learning-v2` was declined on 2026-07-13.

## Frontmatter quoting needs no migration

Settled by a 2026-07-25 audit: all 29 skill and agent files already follow quote-only-when-YAML-forces-it, with zero mismatches. Both a uniform-quoting and a uniform-unquoting migration were considered and rejected. The audit did surface two latent defects, which were fixed separately.

## No response-shape assertion kind in the behavioral-smoke harness

Decided by an `architect-reviewer` consult on 2026-07-25. The mid-work-question clause is vacuous under a headless run, since stdin is closed, and the recap clause has no finite grammar to assert against. If causal evidence for either is ever needed, the instrument is a one-off billable contrast run judged by rubric, never the free `--check` path.

## SubagentStart re-injection declined

Decided 2026-07-21. Subagents already inherit the managed block and the gateguard/plan-gate stamps through the shared `session_id`, so a dedicated `SubagentStart` re-injection hook would be redundant. If violations ever do appear, the preferred fix is an install-time per-agent trailer over a new runtime hook.

## `wizard`'s credential-provisioning walkthrough stays unadopted

The `wizard` skill from `mattpocock/skills` generates an interactive bash script that walks a human through steps only they can perform: provisioning infrastructure, setting up credentials or CI secrets, navigating an unfamiliar third-party dashboard, or running a one-off migration or cutover.

It surfaced as a candidate during the 2026-08-08 survey of that repo and was raised as one of two remaining adoption candidates. The repo owner declined it on 2026-08-09, in these words:

> i dont actually need credential provisioning

The skill's value is proportional to how often a project runs a manual provisioning procedure, and this repo installs rules and skills rather than provisioning infrastructure. Nothing stops a project that does need this kind of walkthrough from adding the skill later; this is a judgment about fit here, not about the skill's quality.

## `resolving-merge-conflicts` stays its own skill

Proposed on 2026-08-09 by the repo owner, who asked whether `yeet` should reference `resolving-merge-conflicts` and then argued the stronger form:

> resolving-merge-conflicts should just be part of yeet. No need for that extra skill in this context and typical use.

The two load on different triggers. `yeet` fires when finished work is ready to publish, which is most sessions that ship anything. `resolving-merge-conflicts` fires when a merge, rebase, or cherry-pick is already conflicted in the working tree, which publishing does not imply and which happens plenty of times that never reach a PR. Folding the second into the first would carry conflict guidance into every publish that has no conflict, and would strand the conflict procedure behind a publish trigger for the rebases and cherry-picks that end at a local commit.

What shipped instead is the overlap the proposal was pointing at. `yeet` said nothing about a rejected push or a branch that needs updating, so its push step now points at `[[resolving-merge-conflicts]]` for a reconciliation that conflicts. The owner accepted that in place of the fold on the same day.
