---
applyTo: "**"
excludeAgent: "cloud-agent"
---

# Repository-wide review rules

These directives restate rules from `AGENTS.md`.

## Commits

Flag a commit subject that is not in the imperative mood or runs to 72 characters or more.

## Documentation

Flag a change to the command-line behavior of `ledger` that does not update the Usage section of `README.md` in the same pull request.

## Comments

Flag any new TODO comment that lacks a linked issue number, such as `TODO(#123)`.
