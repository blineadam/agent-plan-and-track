# Copilot review notes

Live-observed behavior behind steps 7 and 14 of the yeet skill, plus the documentation to revalidate against. Read this when a GitHub call behaves differently than the step says.

## Step 7: detecting and requesting a Copilot review

- REST `GET repos/{owner}/{repo}/pulls/<n>/requested_reviewers` cannot serve the auto-request check, as observed live: it stays `{"users":[],"teams":[]}` while a Copilot request is genuinely pending, so an empty response there cannot be told apart from a request that never landed.
- Don't reason from that endpoint's two-property schema to conclude a bot is unrepresentable. The same reviewer serializes into the user-shaped `requested_reviewer` field of a `review_requested` timeline event, carrying `"type": "Bot"`. The endpoint simply omits it, and stays valid for confirming a human reviewer's request.
- A ruleset's `copilot_code_review` rule skips drafts unless its `review_draft_pull_requests` parameter is on (read the rule with `gh api repos/{owner}/{repo}/rulesets/<id>`). The docs describe that parameter as reviewing drafts "before they are marked as ready for review", so without it the automatic pass belongs to the ready flip that step 15 handles.
- A repo with no such rule can still auto-request through the account-level automatic-review setting. The docs leave its draft behavior unstated and, observed live, it requested nothing on a freshly opened draft, so the `reviewRequests` query is the test, not the config.
- `gh pr edit <n> --add-reviewer '@copilot'` is the documented alias and the only spelling that resolves: the display name `Copilot` and the raw `copilot-pull-request-reviewer[bot]` both failed with "Could not resolve user with login" (observed on gh 2.96.0).
- `gh api -X POST repos/{owner}/{repo}/pulls/<n>/requested_reviewers -f "reviewers[]=copilot-pull-request-reviewer[bot]"` is the REST equivalent where the alias is unavailable: the write side accepts the bot login even though its own read side cannot represent the result.
- A POST response returns the pull-request object and says nothing about whether the request landed, so confirm with the `reviewRequests` query.
- A `@copilot review` comment is a silent no-op that still returns 201.

## Step 14: CI rollup shapes

`gh pr view <n> --json statusCheckRollup` mixes two shapes with uppercase GraphQL enums. A check run passes only when its `status` is `COMPLETED` and its `conclusion` is `SUCCESS`, `NEUTRAL`, or `SKIPPED`. A status context passes only when its `state` is `SUCCESS`. An empty rollup is not a pass. A rerun replaces the failed entry, so a passing rerun clears it. The `jq` filter in step 14 encodes exactly this.

## Sources

The endpoint shapes, bot logins, and completion behavior in the skill were observed live against the GitHub API rather than taken from memory. Revalidate against these if a call starts behaving differently:

- [Pull request reviews](https://docs.github.com/en/rest/pulls/reviews), [review comments](https://docs.github.com/en/rest/pulls/comments), and [review requests](https://docs.github.com/en/rest/pulls/review-requests) REST references
- [GraphQL mutations](https://docs.github.com/en/graphql/reference/mutations) and [GraphQL objects](https://docs.github.com/en/graphql/reference/objects) references
- [GraphQL pagination guide](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)
- [Repository rules](https://docs.github.com/en/rest/repos/rules) reference, for the `copilot_code_review` parameters
