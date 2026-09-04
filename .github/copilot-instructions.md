# Code reviews

Repository conventions live in [AGENTS.md](../AGENTS.md), in `.ai-style-rules.md`
at the repo root, and in the path-scoped files under `.github/instructions/`
(`general`, `docs`, `scripts`), which are generated from `.ai-style-rules.md`.
This file covers how to review, not what the conventions are.

Do not comment on what CI already blocks: the installer smoke test (install
layout, hook wiring, the digest-preview and shell-segment parity guards, the
script fixture runners), the PR body lint (heading set, em dashes, emoji), and
CodeQL, which runs from GitHub's default setup rather than a workflow file in
this repo. Everything else in the instruction files is enforced only by review,
so do comment on it.

Review correctness first, then readability, then maintainability. Say plainly
which findings block a merge and which are suggestions, and give the reason a
finding matters rather than asserting it.

The bar is "better", not "perfect". A PR that improves the codebase should not
be held up over style preferences no written convention supports.
