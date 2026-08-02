# AGENTS.md

This file provides guidance to LLMs when working with code in this repository.

## What this repo is

Portable, user-scoped agent rules/skills/hooks for Claude Code, GitHub Copilot, and Codex. This is meta-architecture, not application code: markdown skill files plus Node hook and utility scripts that `install.sh` (or its Windows PowerShell sibling `install.ps1`) deploys into `~/.claude`, `~/.copilot`, `~/.codex` (Codex's own skills go to `~/.agents/skills`, not `~/.codex`).

## Style conventions

This repo's implicit conventions are captured in `.ai-style-rules.md` at the project root. Read it before writing or editing code here, and follow its Golden Files, naming/state-control rules, and DONTs.

## PR body convention

A PR body describes the change as it stands, not the review history that produced it, and is structured as `## Summary` (required, first), then an optional `## Implementation`, then either `## Test plan` or `## Verification` (exactly one required).

Both halves ship in the portable rules (`rules/core-rules.md` and `rules/agent-guidelines.md`), so they apply in every project, not just here. `.github/scripts/lint-pr-body.js`, wired into `.github/workflows/pr-body-lint.yml`, hard-fails the heading-shaped violations plus the em dash and emoji checks, and only warns on any other level-2 heading; its own header enumerates the exact split. It cannot see the same narration written as ordinary prose under an allowed heading, which `.github/instructions/general.instructions.md` assigns to review judgment, so a green lint means the body isn't that shape, not that it complies.

The voice checks read prose only, skipping fenced blocks and inline code, because a body routinely quotes output it did not write: that is the same carve-out the `humanizer` skill already makes for secondhand text. For the body's own prose, this doesn't add a second rule: `rules/core-rules.md`'s writing-voice rule already points PR descriptions at the `humanizer` skill.

## Local additions

If this checkout has an `AGENTS.local.md` next to this file, read it too: it holds machine-local tooling instructions that aren't checked in because not every checkout has that tooling installed.

## Commands

There is no build/lint/test suite in the traditional sense. The relevant commands:

- `./install.sh all` (or `claude` | `copilot` | `codex`): deploy this repo's rules/skills/hooks to the target harness(es); on Windows run `powershell -ExecutionPolicy Bypass -File install.ps1 all` instead (same targets, same idempotency). Idempotent. The Unix installer needs `jq`; `install.ps1` is jq-free (native `ConvertFrom-Json`/`ConvertTo-Json`). Hooks need only `node` at runtime on every platform: the digest hook runs `core-rules-digest.js`, so there is no runtime `jq` anymore, not even for Copilot. Re-run after editing anything under `rules/`, `skills/`, `hooks/`, or `agents/` to propagate the change.
- `node skills/skill-activation/scripts/run-activation-cases.js --dry-run`: list routing-regression cases (free). `--precheck [SKILLS_DIR]` lints skill frontmatter; `--precheck-agents [AGENTS_DIR] [INSTALLED_HOME]` lints agent frontmatter and optionally compares installed render semantics (both free). `--run` invokes `claude -p` per case and costs money: it needs `ACTIVATION_ALLOW_SPEND=1` and an isolated, network-restricted sandbox (see script header).
- `node skills/skill-activation/scripts/run-behavioral-smokes.js --dry-run`: lint the behavioral-smoke corpus (free; exits 1 on any problem). `--check RESULTS_DIR` scores pre-captured results (free). `--run` invokes `claude -p` per case and costs money: same `ACTIVATION_ALLOW_SPEND=1` gate and isolated-sandbox requirement as `run-activation-cases.js` (see script header).
- `node skills/skill-activation/scripts/run-live-runner-fixtures.js`: exercise all three live-runner entry points with generated fake CLIs, including progress, failure, timeout, interruption, and process-tree cleanup (free).
- `node skills/context-budget/scripts/scan-context.js`: estimate always-on context cost (skills + instruction files + rules digest) and flag oversized components.
- `node skills/rules-distill/scripts/scan-rules.js` / `scan-skills.js`: index this repo's rules and inventory installed skills, feeding a `rules-distill` run.
- To sanity-check a change by hand: install it, start a fresh session in the target harness, and ask "what are your standing rules?"
- `./install-office-skills.sh` (or `install-office-skills.ps1` on Windows): opt-in, detects which of Claude Code, Codex, and Copilot are present and fetches the `docx`/`pdf`/`pptx`/`xlsx` skills live from anthropics/skills for those only, via `npx skills add` (needs network/npx). Separate from `install.sh` because these 4 skills' upstream license forbids vendoring them in this repo.

## Architecture

### Rule delivery, by mechanism

Three kinds of rules use three different mechanisms, chosen because each survives attention decay in a long session differently:

- **Instruction file** (`rules/agent-guidelines.md`): short, constant constraints, always loaded, kept tiny so it isn't buried by its own bulk.
- **Skills** (`skills/*/SKILL.md`): procedures, loaded just-in-time when triggered by the `description` frontmatter. That description is load-bearing: it must front-load the trigger clause ("Use when X" / "Use BEFORE Y"), since it's the only part loaded into every session.
- **Hooks re-injecting a digest** (`rules/core-rules.md`, delivered via `hooks/`): the core rules themselves, repeated by harness enforcement rather than left to the model's attention.

`rules/core-rules.md` is a deliberate subset of `rules/agent-guidelines.md`, not a mirror. The digest keeps the rules whose violations occur late in long sessions (output shape, process discipline) and the rules with no mechanical backup; rules consumed at session start or backed by a hard gate are dropped or compressed there and carried at full force only by the instruction file, which stays complete because it is also a subagent's only rules channel (Claude's UserPromptSubmit hook never fires inside a Task-tool turn). Dropped from the digest: pilot-before-scale, size-the-investigation-to-the-stakes, scale-investigation-depth, investigate-before-editing (gateguard-gated), and the PR-body heading set (CI-gated). Compressed: reversibility-first, plan-non-trivial-work, never-fake-a-green-result, never-fabricate-user-attribution, learn-from-corrections, and PR-body-describes-the-current-state. A parity sweep of the pair must treat these as deliberate asymmetries, not drift.

Delivery order inside the digest is load-bearing too: Claude Code persists hook stdout above 10,000 characters to a file and shows the model only a small inline preview, measured live at 1,998 cumulative bytes (upstream issue #44086), so on any given prompt only the digest's first bullets arrive inline. The first 1,998 bytes deliberately carry the three priority rules with no or warn-only mechanical backup (action-first output, be-skimmable, verify-before-done), and CI enforces that packing: `.github/scripts/check-digest-preview.js` hard-fails an edit that leaves any of the three missing, past the preview budget, or out of order, with `run-check-digest-preview-fixtures.js` covering the guard's own failure paths. The digest's total size still exceeds the 10,000-character threshold; trimming below it is a deliberately open decision, so the guard only warns on that.

`rules/` is the single source of truth. Installed per-harness copies (an `~/.claude/CLAUDE.md` managed block, `~/.claude/core-rules.md`, etc.) are generated by `install.sh` and overwritten on every install: never hand-edit an installed copy, edit the repo copy and reinstall.

The action-first output-shaping principle in both files is adapted from [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd), folded in as a standing rule rather than its upstream form (an opt-in, explicitly-invoked skill) since the point is output that's shaped this way by default, without a per-session invocation.

### install.sh / install.ps1

Before changing either installer, read [docs/installers.md](docs/installers.md).

### Hooks

Before changing anything under `hooks/`, read [docs/hooks.md](docs/hooks.md).

### Skills

Three groups under `skills/<name>/SKILL.md`: the everyday workflow (`plan-and-track`, `gateguard`, `capture-lesson`, `plow-ahead`, `efficient-frontier`, `read-the-damn-docs`, `humanizer`) hit every session; maintenance skills maintain the rules/skills themselves; a third group covers design, document-creation, and browser-testing guidance (`canvas-design`, `frontend-design`, `theme-factory`, `webapp-testing`), used on demand rather than every session. `migration-discipline` sits with the workflow group thematically but is situational, loading only for migration-shaped work (many files, one mechanical change, possibly parallel agents); it is distilled from the Bun team's public port postmortem (bun.com/blog/bun-in-rust) plus an independent forensic write-up of a similar large-scale migration. `security-threat-model` sits with the workflow group thematically too but is also situational, loading only for an explicit threat-modeling request (enumerate threats/abuse paths, AppSec threat model of a repo or path). `yeet` sits with the workflow group too but loads only when work is ready to publish: the end-to-end git-to-PR flow (topic branch, attribution-clean commit, push, a `--body-file` PR body with the standing heading set, a Copilot review requested explicitly when the repo does not auto-request one, and every Copilot review thread replied to and resolved, leaving human-authored threads for their authors). Of those, `rules-distill`, `strategic-compact`, `context-budget`, `skill-comply`, and `inherit-legacy-style` are adapted from [affaan-m/ecc](https://github.com/affaan-m/ecc); `skill-activation` and `copilot-review-instructions` were built directly in this repo. `plow-ahead`, `efficient-frontier`, and `read-the-damn-docs` are adapted from [BuilderIO/skills](https://github.com/BuilderIO/skills), `agents/fable-advisor.md` is adapted from [DannyMac180/fable-advisor](https://github.com/DannyMac180/fable-advisor), `yeet` is adapted from [ben-ranford/skills](https://github.com/ben-ranford/skills), and `humanizer` is adapted from [blader/humanizer](https://github.com/blader/humanizer). `canvas-design`, `frontend-design`, `theme-factory`, and `webapp-testing` are adapted from [anthropics/skills](https://github.com/anthropics/skills), and `security-threat-model` is adapted from [openai/skills](https://github.com/openai/skills). Cross-skill references use `[[skill-name]]` wiki-link syntax rather than duplicating content.

When a skill mandates an output convention, such as an owner tag, a required trailer, or a section format, pair that mandate with a mechanical check (a hook lint or a CI assertion) rather than trusting session attention alone to enforce it over a long run; `plan-gate.js`'s owner-tag lint on `tasks/todo.md` is the in-repo exemplar.

### Style enforcement loop

`.ai-style-rules.md` (maintained by the `inherit-legacy-style` skill) captures this repo's own implicit conventions, and `copilot-review-instructions` regenerates `.github/instructions/*.instructions.md` (path-scoped Copilot PR-review directives) from it. A file carrying the `<!-- Generated by copilot-review-instructions; ... -->` marker is fully skill-owned and safe to regenerate; one without it needs provenance confirmed with the user before overwriting, since absence of the marker doesn't necessarily mean hand-authored.

A nightly workflow (`.github/workflows/nightly-style-refresh.yml`) re-runs this loop unattended against `main` and merges the result through a Copilot-reviewed PR, so `.ai-style-rules.md` and the generated instruction files can change without a human commit.
