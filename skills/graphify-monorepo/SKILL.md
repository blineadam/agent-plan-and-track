---
name: graphify-monorepo
description: Keep a merged multi-workspace graphify graph current on a large monorepo, and stop agents from running the corpus-wrecking `graphify update .`. Use when graphify reports a repo is over its ~500-file / 2M-word threshold, when the root graph was built by merging several workspace graphs (`graphify merge-graphs`), or when a repo's `graphify-out/graph.json` is a merged/multi-workspace graph. Portable across Claude, Copilot, and Codex.
---

# Graphify on a monorepo (merged multi-workspace graph)

Graphify's normal one-command flow assumes a single corpus. Past its ~500-file /
2M-word narrowing threshold it tells you to split: build one graph per workspace,
merge them with `graphify merge-graphs`, then cluster the merged root. The catch is
that `graphify <harness> install` still writes "after code changes, run `graphify
update .`" into your instruction files, and on a merged repo that line is wrong:
`graphify update .` rebuilds the root as one corpus and destroys the merge.

This skill ships `graphify-monorepo-sync.sh`, which does the correct refresh
(update each workspace, re-merge, re-cluster) and re-asserts an override block that
supersedes the wrong line. The script sits next to this file in the skill directory.

## When this applies

- Graphify reports the repo is over its ~500-file / 2M-word threshold.
- You have two or more code workspaces (say `server` and `ui`), each worth its own graph.
- The root `graphify-out/graph.json` was produced by `graphify merge-graphs`.

A repo that fits in one corpus does not need this. Use plain `graphify update .` there.

## One-time build

Build one graph per workspace, then hand the workspace list to `setup`. From the
monorepo root (call the script by its path in this skill's directory):

```sh
graphify extract ./server --no-cluster --max-workers 4
graphify extract ./ui --no-cluster --max-workers 4

./graphify-monorepo-sync.sh setup server ui
```

`--no-cluster` on the per-workspace builds is deliberate: only the merged root gets
queried and clustered, so clustering each workspace first is wasted work.

`setup` merges those workspace graphs into `graphify-out/graph.json`, clusters it,
scaffolds the script + a warn-only pre-push hook into the repo (when it has `.git`),
and writes a `## Graphify monorepo override` block into whichever of `CLAUDE.md`,
`AGENTS.md`, and `.github/copilot-instructions.md` already exist. Commit the
scaffolded `graphify-monorepo-sync.sh`, `graphify-monorepo.conf`, `githooks/`, and
`graphify-out/` so clones inherit the refresh.

## Day to day

After code changes, refresh the merged graph:

```sh
./graphify-monorepo-sync.sh sync
```

It updates each workspace graph (AST-only, no API cost), re-merges into the root,
re-clusters, and re-asserts the override block. With the pre-push hook installed, a
`git push` runs this for you. Query the merged graph explicitly:

```sh
graphify query "<question>" --graph graphify-out/graph.json
```

Never run `graphify update .` on a merged monorepo. It rebuilds the root as one corpus.

## Keep running graphify's own installer

Keep running `graphify <harness> install` for its query guidance and skill bundle.
The override is a separate H2 placed after graphify's `## graphify` section, and that
installer only rewrites its own section (up to the next H2), so it preserves the
override. Every `sync` re-asserts the block, so the two never drift.

## Tuning

- Sync skips LLM community naming by default (AST-only, hook/CI-safe, no API key).
  Run `sync --label`, or set `CLUSTER_NO_LABEL=0` in `graphify-monorepo.conf`, to name
  communities.
- No `.git`? The hook is skipped and agents refresh via the override instruction instead.
- Subcommands and env vars are documented in the script header.
