# AGENTS.md

Guidance for coding agents working in this repository.

## Project

`slugkit` turns titles into URL slugs. The code is in `src/`, tests are in `test/`, and `npm test` runs them with `node --test`.

## Conventions

- Keep `src/slugify.js` dependency-free; Node core modules only.
- Add or update a test in `test/` for every behavior change.
- Every code change adds a one-line entry to `CHANGELOG.md` under `## Unreleased`.
