# Copilot review notes

Live-observed behavior behind steps 7, 8, and 14 of the yeet skill, plus the documentation to revalidate against. Read this when a GitHub call behaves differently than the step says.

## Step 7: detecting and requesting a Copilot review

- REST `GET repos/{owner}/{repo}/pulls/<n>/requested_reviewers` cannot serve the auto-request check, as observed live: it stays `{"users":[],"teams":[]}` while a Copilot request is genuinely pending, so an empty response there cannot be told apart from a request that never landed.
- Don't reason from that endpoint's two-property schema to conclude a bot is unrepresentable. The same reviewer serializes into the user-shaped `requested_reviewer` field of a `review_requested` timeline event, carrying `"type": "Bot"`. The endpoint simply omits it, and stays valid for confirming a human reviewer's request.
- A ruleset's `copilot_code_review` rule skips drafts unless its `review_draft_pull_requests` parameter is on (read the rule with `gh api repos/{owner}/{repo}/rulesets/<id>`). The docs describe that parameter as reviewing drafts "before they are marked as ready for review", so without it the automatic pass belongs to the ready flip that step 15 handles.
- A repo with no such rule can still auto-request through the account-level automatic-review setting. The docs leave its draft behavior unstated and, observed live, it requested nothing on a freshly opened draft, so the `reviewRequests` query is the test, not the config.
- `gh pr edit <n> --add-reviewer '@copilot'` is the documented alias and the only spelling that resolves: the display name `Copilot` and the raw `copilot-pull-request-reviewer[bot]` both failed with "Could not resolve user with login" (observed on gh 2.96.0).
- `gh api -X POST repos/{owner}/{repo}/pulls/<n>/requested_reviewers -f "reviewers[]=copilot-pull-request-reviewer[bot]"` is the REST equivalent where the alias is unavailable: the write side accepts the bot login even though its own read side cannot represent the result.
- A POST response returns the pull-request object and says nothing about whether the request landed, so confirm with the `reviewRequests` query.
- A `@copilot review` comment is a silent no-op that still returns 201.

## Step 8: waiting for the pass to finish

Step 8's wait polls step 7's `reviewRequests` query until Copilot drops out of it. The exit test prints `true` while Copilot is still requested and `false` once it is not, and the loop treats anything else as an error, so a malformed query or a changed response shape stops the wait at once instead of running out its bound. Comparing an `index(...)` result to `"null"` never fires, because `gh --jq` prints jq's `null` as an empty line (observed on gh 2.102.0).

```bash
pending() {
  gh api graphql -f query='query { repository(owner:"{owner}", name:"{repo}") { pullRequest(number:<n>) { reviewRequests(first:100) { nodes { requestedReviewer { ... on Bot { login } ... on User { login } } } } } } }' \
    --jq '[.data.repository.pullRequest.reviewRequests.nodes[].requestedReviewer.login] | any(. == "copilot-pull-request-reviewer")'
}
for i in $(seq 1 40); do
  case "$(pending)" in
    false) echo "Copilot finished"; exit 0 ;;
    true) sleep 30 ;;
    *) echo "unexpected reviewRequests output, stopping the wait" >&2; exit 1 ;;
  esac
done
echo "Copilot still pending after 20 minutes" >&2; exit 1
```

Before backgrounding it, run `pending` once against a PR whose Copilot pass has already finished (swap its number in for `<n>`) and see it print `false`. Then run the loop as a backgrounded command, so the session stays answerable and the harness reports when it exits. Finishing only says the pass is done: step 8's review match at the head SHA still applies.

## Step 14: CI rollup shapes

`gh pr view <n> --json statusCheckRollup` mixes two shapes with uppercase GraphQL enums. A check run passes only when its `status` is `COMPLETED` and its `conclusion` is `SUCCESS`, `NEUTRAL`, or `SKIPPED`. A status context passes only when its `state` is `SUCCESS`. A rerun replaces the failed entry, so a passing rerun clears it. The `jq` filter in step 14 encodes exactly this.

An empty rollup is ambiguous: right after a push it is a head whose checks have not registered yet, and in a repo with no CI it stays empty forever. Two observations at the head tell them apart. First, the last five merged PRs carry no checks either, which prints `0`:

```bash
gh pr list --state merged --limit 5 --json statusCheckRollup --jq '[.[].statusCheckRollup[]] | length'
```

Second, the head stays without a check suite or an Actions run for two minutes. This loop prints `ci` and exits as soon as either appears, prints `noci` once two minutes pass with neither, and exits 1 on any read that fails to answer:

```bash
ci_seen() {
  s="$(gh api repos/{owner}/{repo}/commits/<sha>/check-suites --jq .total_count)" &&
  r="$(gh api "repos/{owner}/{repo}/actions/runs?head_sha=<sha>" --jq .total_count)" &&
  jq -n --argjson s "$s" --argjson r "$r" '$s + $r > 0'
}
for i in $(seq 0 8); do
  [ "$i" -gt 0 ] && sleep 15
  case "$(ci_seen)" in
    true) echo ci; exit 0 ;;
    false) ;;
    *) echo "a CI read failed to answer" >&2; exit 1 ;;
  esac
done
echo noci; exit 0
```

Before backgrounding it, run `ci_seen` once against a head that has CI and see it print `true`. `total_count` covers every page, so neither endpoint needs `--paginate` here. On a real push, the first check suite appeared 4 seconds after the commit and the last within a minute, while a repo with no CI shows zero suites and zero runs indefinitely. Two minutes therefore covers registration with room to spare. The loop reads at 0, 15, and so on through 120 seconds, so the last read closes the window. An observation proves nothing about a later head or about checks the ready flip starts, so take both observations after `gh pr ready`, and again at the new `<sha>` after any push, before trusting `noci`.

## Sources

The endpoint shapes, bot logins, and completion behavior in the skill were observed live against the GitHub API rather than taken from memory. Revalidate against these if a call starts behaving differently:

- [Pull request reviews](https://docs.github.com/en/rest/pulls/reviews), [review comments](https://docs.github.com/en/rest/pulls/comments), and [review requests](https://docs.github.com/en/rest/pulls/review-requests) REST references
- [GraphQL mutations](https://docs.github.com/en/graphql/reference/mutations) and [GraphQL objects](https://docs.github.com/en/graphql/reference/objects) references
- [GraphQL pagination guide](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)
- [Repository rules](https://docs.github.com/en/rest/repos/rules) reference, for the `copilot_code_review` parameters
