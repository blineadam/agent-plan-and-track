# AGENTS.md

This file provides guidance to LLMs when working with code in this repository.

## What this repo is

Portable, user-scoped agent rules/skills/hooks for Claude Code, GitHub Copilot, and Codex. This is meta-architecture, not application code: markdown skill files plus Node hook and utility scripts that `install.sh` (or its Windows PowerShell sibling `install.ps1`) deploys into `~/.claude`, `~/.copilot`, `~/.codex` (Codex's own skills go to `~/.agents/skills`, not `~/.codex`).

## Style conventions

This repo's implicit conventions are captured in `.ai-style-rules.md` at the project root. Read it before writing or editing code here, and follow its Golden Files, naming/state-control rules, and DONTs.

## Out of scope

Before proposing something this repo does not already have, whether that is a skill, a hook, a rule, a new check, or a migration across existing files, and before adopting one from another repo, read [docs/out-of-scope.md](docs/out-of-scope.md).

It holds this repo's decisions not to build something, so a later session does not re-propose ground already covered. It does not hold decisions about how an existing component behaves, which live in that component's own header, or corrections about how to work, which live in `.tasks/lessons.md`.

## PR body convention

A PR body describes the change as it stands, not the review history that produced it, and is structured as `## Summary` (required, first), then an optional `## Implementation`, then either `## Test plan` or `## Verification` (exactly one required).

Both halves apply in every project, not just here, and both ship through the `yeet` skill's step 6 rather than the always-on rule files: a PR body is written only when finished work is being published, which is exactly `yeet`'s trigger, so carrying the convention in every session's always-on context would pay for a rule that applies in a small fraction of turns, and a session that never publishes loads neither half.

`.github/scripts/lint-pr-body.js`, wired into `.github/workflows/pr-body-lint.yml`, hard-fails the heading-shaped violations plus the em dash and emoji checks, and only warns on any other level-2 heading; its own header enumerates the exact split. It cannot see the same narration written as ordinary prose under an allowed heading, which `.github/instructions/general.instructions.md` assigns to review judgment, so a green lint means the body isn't that shape, not that it complies. That blind spot is why `yeet` carries the prose obligation: the lint gates the shape, the skill carries the judgment, and neither is a portable always-on rule.

The voice checks read prose only, skipping fenced blocks and inline code, because a body routinely quotes output it did not write: that is the same carve-out the `humanizer` skill already makes for secondhand text. For the body's own prose, this doesn't add a second rule: `rules/core-rules.md`'s writing-voice rule already points PR descriptions at the `humanizer` skill.

## Local additions

If this checkout has an `AGENTS.local.md` next to this file, read it too: it holds machine-local tooling instructions that aren't checked in because not every checkout has that tooling installed.

## Commands

There is no build/lint/test suite in the traditional sense. The relevant commands:

- `./install.sh all` (or `claude` | `copilot` | `codex`): deploy this repo's rules/skills/hooks to the target harness(es); on Windows run `powershell -ExecutionPolicy Bypass -File install.ps1 all` instead (same targets, same idempotency). Idempotent. The Unix installer needs `jq`; `install.ps1` is jq-free (native `ConvertFrom-Json`/`ConvertTo-Json`). Hooks need only `node` at runtime on every platform: the digest hook runs `core-rules-digest.js`, so no harness, Copilot included, needs `jq` at runtime. Re-run after editing anything under `rules/`, `skills/`, `hooks/`, or `agents/` to propagate the change.
- `node skills/skill-activation/scripts/run-activation-cases.js --dry-run`: list routing-regression cases (free). `--precheck [SKILLS_DIR]` lints skill frontmatter; `--precheck-agents [AGENTS_DIR] [INSTALLED_HOME]` lints agent frontmatter and optionally compares installed render semantics (both free). `--run` invokes `claude -p` per case and costs money: it needs `ACTIVATION_ALLOW_SPEND=1` and an isolated, network-restricted sandbox (see script header).
- `node skills/skill-activation/scripts/run-behavioral-smokes.js --dry-run`: lint the behavioral-smoke corpus (free; exits 1 on any problem). `--check RESULTS_DIR` scores pre-captured results (free). `--run` invokes `claude -p` per case and costs money: same `ACTIVATION_ALLOW_SPEND=1` gate and isolated-sandbox requirement as `run-activation-cases.js` (see script header).
- `node skills/skill-activation/scripts/run-live-runner-fixtures.js`: exercise all three live-runner entry points with generated fake CLIs, including progress, failure, timeout, interruption, and process-tree cleanup (free).
- `node skills/skill-activation/scripts/run-activation-coverage-fixtures.js`: exercise the `--dry-run` coverage guard's failure paths (a skill with no routing case and no exemption, a blank or stale exemption, an unreadable exemptions file) against scratch skill trees (free).
- `node skills/publish-visual-pr/scripts/run-smoke-fixtures.js`: drive the visual-PR capture runner end to end against generated base and head checkouts of a static page (permitted change passes, leaked change fails, missing control and missing font are reported, crops written). Free, but needs the `playwright` npm package resolvable (set `NODE_PATH` to a node_modules directory that contains it) plus its Chromium build; both CI jobs run it.
- `node skills/context-budget/scripts/scan-context.js`: estimate always-on context cost (skill frontmatter + instruction files + rules digest + agent-roster routing text) and flag oversized components.
- `node skills/rules-distill/scripts/scan-rules.js` / `scan-skills.js`: index this repo's rules and inventory installed skills, feeding a `rules-distill` run.
- `node .github/scripts/check-digest-preview.js`: verify `rules/core-rules.md` still satisfies CI's digest-packing rules (the three priority bullets present, in order, inside the inline-preview budget, and the whole file under the inline-persistence ceiling) before pushing an edit to it (free).
- `node .github/scripts/check-split-shell-segments-parity.js`: verify the three standalone `splitShellSegments` copies (`hooks/claude/plan-gate.js`, `hooks/codex/plan-gate-pilot.js`, `hooks/git-guard.js`) are still byte-identical before pushing an edit to any of them (free).
- `node .github/scripts/check-doc-links.js`: verify that every `[[name]]` wiki-link resolves to a skill or agent, every relative markdown link points at an existing file, and every skill is named in `docs/skills.md` before pushing a doc or skill edit (free).
- To sanity-check a change by hand: install it, start a fresh session in the target harness, and ask "what are your standing rules?"
- `./install-office-skills.sh [install|uninstall]` (or `install-office-skills.ps1` on Windows; install by default): opt-in, detects which of Claude Code, Codex, and Copilot are present and installs the `docx`/`pdf`/`pptx`/`xlsx` skills via `npx skills add`, or removes them (install needs network/npx). Separate from `install.sh` because these 4 skills' upstream license forbids vendoring them in this repo.
- `./install-mcp-servers.sh [install|uninstall]` (or `install-mcp-servers.ps1` on Windows; install by default): opt-in, installs the chrome-devtools MCP server (github.com/ChromeDevTools/chrome-devtools-mcp) for whichever of Claude Code, Codex, and Copilot are present and removes it again, skipping any harness that already has a server by that name (install needs Node.js and Chrome). Separate from `install.sh` because this script drives each harness through its own CLI (`mcp add`/`mcp get`/`mcp remove`) rather than the shared JSON/TOML merge machinery.

## Architecture

### Rule delivery, by mechanism

Before changing anything under `rules/` or the hooks that deliver the digest, read [docs/rule-delivery.md](docs/rule-delivery.md). `rules/core-rules.md` is a deliberate subset of `rules/agent-guidelines.md`, not a mirror.

`rules/` is the single source of truth. Installed per-harness copies (an `~/.claude/CLAUDE.md` managed block, `~/.claude/core-rules.md`, etc.) are generated by `install.sh` and overwritten on every install: never hand-edit an installed copy, edit the repo copy and reinstall.

### install.sh / install.ps1

Before changing either installer, read [docs/installers.md](docs/installers.md).

### Hooks

Before changing anything under `hooks/`, read [docs/hooks.md](docs/hooks.md).

### Skills

Three groups under `skills/<name>/SKILL.md`: the everyday workflow (`plan-and-track`, `gateguard`, `capture-lesson`, `efficient-frontier`, `read-the-damn-docs`, `humanizer`) hit every session; maintenance skills maintain the rules/skills themselves; a third group covers design, document-creation, and browser-testing guidance (`frontend-design`, `webapp-testing`), used on demand rather than every session. `migration-discipline` sits with the workflow group thematically but is situational, loading only for migration-shaped work (many files, one mechanical change, possibly parallel agents). `logging-practices` is situational too, loading only when a new entry point, failure path, or external call is built, or logging is added or reviewed: it reuses the project's existing logger and ends in a forced-failure check of the emitted line rather than a hook. `yeet` sits with the workflow group too but loads only when work is ready to publish: the end-to-end git-to-PR flow (topic branch, attribution-clean commit, push, a draft PR with a `--body-file` body carrying the standing heading set, a Copilot review requested explicitly when the repo does not auto-request one, every Copilot review thread replied to and resolved, leaving human-authored threads for their authors, and only then the PR marked ready for review). `publish-visual-pr` extends `yeet` for a UI change: it captures deterministic before/after screenshots of the base and head revisions with a bundled Playwright runner, gates the draft on that visual check, and uploads the settled-head crops into the PR body before the ready flip. Cross-skill references use `[[skill-name]]` wiki-link syntax rather than duplicating content.

When a skill mandates an output convention, such as an owner tag, a required trailer, or a section format, pair that mandate with a mechanical check (a hook lint or a CI assertion) rather than trusting session attention alone to enforce it over a long run; `plan-gate.js`'s owner-tag lint on `.tasks/todo.md` is the in-repo exemplar.

### Credits and provenance

Upstream credits live in [docs/credits.md](docs/credits.md), and adapting anything from an external source (a skill, a section, a rule, an agent, a hook idea) adds or extends its entry there in the same change. Wholesale-vendored content keeps an in-file attribution comment naming the source and the exact edits, plus a sibling `LICENSE.txt` and an entry in the root `NOTICE`, and the copyright line for an MIT source goes in the root `LICENSE`. When the source's license is incompatible with MIT (AGPL-3.0, for example), only ideas may be shared, never a borrowed sentence, so diff the draft against the source. Evidence drawn from a private or employer-internal repository, including a pull request on one, is used for its findings only: the repo, the PR, and the employer are never named in this repo, a commit message, or a PR description, even when that evidence is why a rule exists, and it gets no credit, since no license obliges one and naming it discloses someone else's code for nothing.

### Style enforcement loop

Before changing `.ai-style-rules.md`, `.github/instructions/`, the `# Code reviews` section of `.github/copilot-instructions.md`, the `inherit-legacy-style` or `copilot-review-instructions` skills, or `.github/workflows/nightly-style-refresh.yml`, read [docs/style-enforcement.md](docs/style-enforcement.md).

### Releases

Before tagging a release, read [docs/tag-and-release.md](docs/tag-and-release.md): how the version number and the release notes are chosen, both by hand.
