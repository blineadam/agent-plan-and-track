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

7. Check whether the repo auto-requested a review: `gh api repos/{owner}/{repo}/pulls/<n>/requested_reviewers`, which returns `{"users": [...], "teams": [...]}`. If Copilot is absent and no Copilot review exists yet, request one with `gh pr edit <n> --add-reviewer '@copilot'`, the documented alias and the only spelling that resolves: the display name `Copilot` and the raw `copilot-pull-request-reviewer[bot]` both fail with "Could not resolve user with login" (gh 2.96.0). `gh api -X POST repos/{owner}/{repo}/pulls/<n>/requested_reviewers -f "reviewers[]=copilot-pull-request-reviewer[bot]"` is the REST equivalent where that alias is unavailable. Confirm the request stuck by re-reading the endpoint, never by parsing a POST response, which returns the pull-request object and so says nothing about whether the request landed. A `@copilot review` comment is a silent no-op that still returns 201.
8. Capture the head SHA, then poll `gh api --paginate repos/{owner}/{repo}/pulls/<n>/reviews` until a review by `copilot-pull-request-reviewer[bot]` carries a matching `commit_id`, and re-check that the head has not moved before trusting the match. A review object can appear before the pass has finished writing its comments, so wait for a completion signal too: the reviewer drops out of `requested_reviewers` when it finishes, and where Actions runs are visible a successful `dynamic/agents/copilot-pull-request-reviewer` run at the same SHA says the same thing. Bound the wait and report a timeout rather than looping forever, since a disabled or failed run never lands. The reviewer is spelled differently per surface (`Copilot` under `requested_reviewers`, `copilot-pull-request-reviewer[bot]` here), so use each surface's own spelling rather than normalizing to one. Never accept a review count as the test: your own replies post as `COMMENTED` entries in this same list.
9. Fetch the findings themselves. `/reviews` carries only the review objects, so read `gh api --paginate repos/{owner}/{repo}/pulls/<n>/comments` too and select entries whose `pull_request_review_id` matches that review's `id`, joining on the id rather than an author login. `--paginate` is load-bearing on both calls: each endpoint returns 30 results per page by default (100 is the maximum page size, not the default), and a silently short page reads exactly like a clean review. Read the review body as well: lower-confidence findings are listed there instead of being posted as threads.
10. Triage every finding as a hypothesis, not a verdict: confirm it's real before fixing, prefer the root-cause fix over the minimal patch, and dispute with a stated reason when it's wrong or an already-accepted tradeoff.
11. Commit and push accepted fixes before answering anything, so the PR holds the new code by the time a thread is marked resolved. Then reply on each thread with what was done (the fix and its commit, or the dispute) via `gh api -X POST repos/{owner}/{repo}/pulls/<n>/comments/<comment-id>/replies -f body=...`.
12. Resolving needs a different id than replying. `resolveReviewThread` takes a GraphQL thread node id (`PRRT_...`), which no REST response carries, so query the `reviewThreads` connection for each thread's `id`, `isResolved`, and `comments(first: 1) { nodes { databaseId author { login } } }`. That root comment's `databaseId` is the REST comment id from step 9, so it is the join key back to your triage. This connection paginates too and caps at 100 nodes per page, so walk it with `pageInfo { hasNextPage endCursor }` and aggregate every page before filtering or counting: a thread past the first page is never replied to, never resolved, and never counted by step 14. Resolve only threads that are unresolved, whose root author is `copilot-pull-request-reviewer`, and whose root `databaseId` matches a finding you actually triaged and replied to: a thread that clears the first two tests but not the third belongs to a pass that landed mid-loop, so return to step 9 and triage it rather than resolving a finding nobody read. Leave threads opened by people alone: resolving one hides feedback nobody accepted and can wrongly satisfy a branch protection rule that requires resolution. An unresolved or reply-less Copilot thread is unfinished work.
13. Re-request a review only when a fix is itself high-risk or hard to verify directly; verify mechanical fixes by running them. Each re-requested pass repeats steps 8 through 12 in full against the new head, since a fresh pass can raise fresh findings.
14. Before calling the loop closed, and again immediately before anything irreversible like a merge, re-read `requested_reviewers`, the unresolved-thread count, and the set of Copilot review ids at the current head. All three matter: a pass whose findings sit only in the review body leaves no unresolved thread and no pending reviewer, so the first two signals read clean while an unread review exists. Compare the review ids against the ones you have already triaged and read any new one before acting. A check taken before a wait proves nothing about the state after it, so recheck at the moment you act, not once at the end of triage.

## Sources

The endpoint shapes, bot logins, and completion behavior above were observed live against the GitHub API rather than taken from memory. Revalidate against the [pull request reviews](https://docs.github.com/en/rest/pulls/reviews) and [review comments](https://docs.github.com/en/rest/pulls/comments) REST references, the [GraphQL mutations](https://docs.github.com/en/graphql/reference/mutations) reference, and the [GraphQL pagination guide](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api) if a call starts behaving differently.
