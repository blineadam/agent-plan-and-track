---
name: yeet
description: Commit, push, and open a GitHub PR, then drive Copilot review to resolution. Use when finished work is ready to publish, not for planning that merely ends in a PR.
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

7. Check whether the repo auto-requested a review: `gh api repos/{owner}/{repo}/pulls/<n>/requested_reviewers`, which returns `{"users": [...], "teams": [...]}`. If Copilot is absent and no Copilot review exists yet, request one: `gh api -X POST repos/{owner}/{repo}/pulls/<n>/requested_reviewers -f "reviewers[]=copilot-pull-request-reviewer[bot]"`. Confirm it stuck by re-reading that endpoint, never by parsing the POST's own response: the POST returns the pull-request object instead, so an empty read of it says nothing about whether the request landed. Use that REST call rather than `gh pr edit --add-reviewer`, which fails with "Could not resolve user with login" for both the display name and the bot login (checked on gh 2.96.0); a `@copilot review` comment is a silent no-op that still returns 201.
8. Capture the head SHA, then poll `gh api repos/{owner}/{repo}/pulls/<n>/reviews` until a review by `copilot-pull-request-reviewer[bot]` carries a matching `commit_id`, and re-check that the head has not moved before trusting the match. Bound the wait and report a timeout rather than looping forever, since a disabled or failed run never lands. The reviewer is spelled differently per surface (`Copilot` under `requested_reviewers`, `copilot-pull-request-reviewer[bot]` here), so use each surface's own spelling rather than normalizing to one. Never accept a review count as the test: your own replies post as `COMMENTED` entries in this same list.
9. Fetch the findings themselves. `/reviews` carries only the review objects, so read `gh api repos/{owner}/{repo}/pulls/<n>/comments?per_page=100` too and select entries whose `pull_request_review_id` matches that review's `id`, joining on the id rather than an author login. Read the review body as well: lower-confidence findings are listed there instead of being posted as threads.
10. Triage every finding as a hypothesis, not a verdict: confirm it's real before fixing, prefer the root-cause fix over the minimal patch, and dispute with a stated reason when it's wrong or an already-accepted tradeoff.
11. Reply on every Copilot thread with what was done (the fix and its commit, or the dispute), then resolve those threads with the GraphQL `resolveReviewThread` mutation. Leave threads opened by people alone: resolving one hides feedback nobody accepted and can wrongly satisfy a branch protection rule that requires resolution. An unresolved or reply-less Copilot thread is unfinished work.
12. After pushing fixes, re-request a review only when a fix is itself high-risk or hard to verify directly; verify mechanical fixes by running them. Each re-requested pass repeats steps 8 through 11 in full against the new head, since a fresh pass can raise fresh findings.
