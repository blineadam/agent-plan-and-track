---
name: yeet
description: Commit, push, and open a GitHub PR, then drive Copilot review to resolution. Use when asked to publish local git changes, open a PR, or run an end-to-end git-to-PR workflow.
---

# Yeet

Publish local work with `git` + `gh`, then see the PR through Copilot review.

## Context to gather first

- Current branch: `git branch --show-current`
- Working tree: `git status -sb`
- Recent history: `git log --oneline -5`

## Prerequisites

1. `gh --version`; if missing, tell the user to install GitHub CLI and stop.
2. `gh auth status`; if unauthenticated, tell the user to run `gh auth login` and stop.

## Naming

- Branch: short kebab-case description of the change when starting from the default branch.
- Commit message and PR title: a plain sentence describing the change; follow the target repo's own convention (e.g. Conventional Commits) where one exists.

## Publish

1. On the default branch, create a topic branch: `git checkout -b <description>`. Already on one: stay.
2. Stage and commit the task's files; don't sweep in unrelated changes with a blanket `git add -A`.
3. Check the commit message for AI self-attribution (a `Co-Authored-By:` trailer naming an AI tool, a "Generated with ..." footer) and amend it away if present.
4. Run the project's checks if not already run.
5. Push with tracking: `git push -u origin <branch>`.
6. Write the PR body to a temp file with real newlines, then `gh pr create --title "..." --body-file <file>`; never inline `--body` with `\n` escapes. Absent the repo's own PR template: `## Summary` first, an optional `## Implementation`, then exactly one of `## Test plan` or `## Verification`. Describe the change as it stands, never the review history, and run the prose through [[humanizer]].

## Copilot review

7. Check whether the repo auto-requested a review: `gh api repos/{owner}/{repo}/pulls/<n>/requested_reviewers`. If Copilot is absent and no Copilot review exists yet, request one: `gh api -X POST repos/{owner}/{repo}/pulls/<n>/requested_reviewers -f "reviewers[]=copilot-pull-request-reviewer[bot]"`, then re-read the endpoint to confirm it stuck. `gh pr edit --add-reviewer Copilot` fails to resolve the login, and a `@copilot review` comment is a silent no-op.
8. Poll `gh api repos/{owner}/{repo}/pulls/<n>/reviews` until a review by `copilot-pull-request-reviewer[bot]` exists whose `commit_id` equals the current head SHA. Never poll a review count: your own thread replies land in the same list.
9. Triage every comment as a hypothesis, not a verdict: confirm it's real before fixing, prefer the root-cause fix over the minimal patch, and dispute with a stated reason when it's wrong or an already-accepted tradeoff.
10. Reply on every thread with what was done (the fix and its commit, or the dispute), then resolve all threads via GraphQL `resolveReviewThread`. An unresolved or reply-less thread is unfinished work.
11. After pushing fixes, re-request a review only when a fix is itself high-risk or hard to verify directly; verify mechanical fixes by running them. A re-requested pass completes on step 8's head-SHA test, same as the first.
