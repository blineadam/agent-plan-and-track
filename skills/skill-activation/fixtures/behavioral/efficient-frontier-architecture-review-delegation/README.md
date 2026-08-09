# commit-hooks

Two small hooks wired up for the team's commit workflow, described in
`hooks/hooks.json`.

`hooks/format-lint.js` runs on `PreCommit`. It reads the proposed commit
message off stdin and checks it against a simple shape rule (capitalized
first letter, no trailing period), then writes a verdict to stdout that the
caller uses to allow or block the commit.

`hooks/session-stats.js` runs on `PostTurn`. It reads the same payload shape
and appends a line to a local log file so we can see how many turns a
session took and when it happened.

Both scripts were added at different times by different people and each
reads its own stdin payload rather than sharing a module.
