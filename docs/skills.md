# Skills reference

The full catalog of skills this repo installs, grouped by what they're for.
For the ones you'll actually hit every session, see the short tour in the
main [README](../README.md#what-you-get).

## Everyday workflow

These follow the rough order of a session: plan and investigate, finish the
work, then publish or capture what the session taught you.

### Plan and investigate

- **`plan-and-track`** (skill) kicks in on multi-step work: a feature, a
  refactor, a 3+ step fix, or picking a repo back up that already has a
  `.tasks/todo.md`. Writes a checklist, tracks it, and verifies before
  closing out. A Claude-only hook backs it up: it blocks writes to
  `.tasks/todo.md` until the skill has actually run that session, and checks
  that new plan steps carry an owner tag (implementation defaults to
  executor; `main` needs a stated reason), and speed-bumps any write that
  would delete an existing `## Migration State` block (deny once, retry
  passes).

  Its Running autonomously section kicks in when you are told to proceed:
  "plow ahead," "use your best judgment," or "don't stop." It turns ordinary
  ambiguity into stated assumptions, stops only for a real blocker, and ends
  with its decisions and residual risk.
- **gateguard** (skill + enforcing hook, Claude/Codex/Copilot) wants the
  facts first: before the first edit to a file, it wants to know who calls
  this code, what breaks, and what the data actually looks like. One script
  runs on all three harnesses. It warns by default on Claude and Codex, blocks
  by default on Copilot, and can be tuned or disabled with environment
  variables. Either way, it marks the file when it fires, so later edits to
  that file are not gated again in the same session.
- **`read-the-damn-docs`** (skill) fires before leaning on memory for how a
  third-party API, library, or provider actually behaves right now. Forces
  a web search for the real docs first, complementing gateguard's local
  digging with an external check.
- **`efficient-frontier`** (skill) steps in before handing research, coding,
  or testing off to one of this repo's tiered subagents. Picks the tier
  that actually fits the work, so delegation doesn't burn the main
  session's judgment on something a cheaper agent could do.
- **`migration-discipline`** (skill) kicks in on migration-shaped work: many
  files, one mechanical change, possibly parallel agents. Layers on
  `plan-and-track` and `efficient-frontier`, and keeps a durable
  `## Migration State` block in the project's `.tasks/todo.md`.

### Finish, learn, and publish

- **delivery-gate** (enforcing hook only, Claude/Codex) is a warn-only check
  right before you finish: did you verify, did you checkpoint? Backs up
  the verify-before-done and capture-lesson rules at the harness level. An
  env var can make it block instead of warn.
- **`capture-lesson`** (skill) kicks in whenever the user corrects the agent
  or the agent notices a repeated error. It turns the correction into a durable
  rule in `.tasks/lessons.md`.
- **`humanizer`** (skill, adapted from
  [blader/humanizer](https://github.com/blader/humanizer)) kicks in before
  finalizing longer user-facing writing: README sections, docs, PR
  descriptions, blog-style prose. Strips the usual AI writing tells (em
  dashes, promotional puffery, filler, rule-of-three, chatbot artifacts)
  while preserving the intended meaning and register.
- **`yeet`** (skill) kicks in once work is done and ready to ship: commits,
  pushes, and opens a GitHub PR with the standing PR-body heading set via
  `--body-file`, requests a Copilot review when the repo doesn't
  auto-request one, then triages, replies to, and resolves every Copilot
  thread before calling it done. Threads people opened are left for them.
- **`resolving-merge-conflicts`** (skill) covers an in-progress merge,
  rebase, or cherry-pick conflict: read both sides' intent before choosing,
  resolve hunk by hunk without inventing behavior neither side had, then
  check the callers of anything either side renamed or changed the contract
  of, since a semantic conflict leaves no textual marker. Finishes the
  operation rather than aborting out of it.

A harness that can't run a given hook still gets the rule as a skill.
That's why Copilot gets gateguard but not delivery-gate: its `agentStop`
event exists, but the only output it accepts is a block-or-allow decision,
with no warn-only lever, and its stderr warn path didn't reach the user in
testing. Tuning knobs for these hooks live in their script headers under
`hooks/`.

## Security

Threat modeling lives in the `security-auditor` agent rather than a skill.
`agents/security-auditor.md` defines its threat-model mode, adapted from
[openai/skills](https://github.com/openai/skills), answers an explicit
threat-modeling request with trust boundaries, abuse paths, and prioritized
mitigations instead of the usual finding-ranked security review.

## Maintenance skills

These maintain the rules and skills themselves, rather than the everyday
coding workflow above. Portable where that's safe, Claude-and-Codex-only where
Copilot lacks the needed mechanism. Most are adapted from
[affaan-m/ecc](https://github.com/affaan-m/ecc); `skill-activation` and
`copilot-review-instructions` were built here.

### Building and testing skills

For writing a new skill or rule and checking that it actually works:

| Skill | What it does | Where |
| --- | --- | --- |
| **`rules-distill`** | Promotes recurring skill principles to rules. | All 3 |
| **`skill-comply`** | Checks whether a fresh agent follows a rule. | Claude + Codex |
| **`skill-activation`** | Checks skill routing. | All 3; runtime is Claude-only |

`skill-activation` is the routing counterpart to `skill-comply`.

### Session and context upkeep

For keeping a live session, and the always-on config behind it, healthy:

| Skill | What it does | Where |
| --- | --- | --- |
| **`strategic-compact`** | Guides manual `/compact` timing. | All 3 |
| **`context-budget`** | Audits always-on context and flags oversized input. | All 3 |

`strategic-compact` uses logical boundaries; its auto-suggest hook is
Claude-only. The Codex context number from `context-budget` is a source upper
bound, not an exact session total.

### Generated docs for agents

For turning a project's conventions into documentation other agents can read:

| Skill | What it does | Where |
| --- | --- | --- |
| **`inherit-legacy-style`** | Captures legacy conventions in `.ai-style-rules.md`. | All 3 |
| **`copilot-review-instructions`** | Writes path-scoped review directives and the repo-wide review section. | All 3 |

`inherit-legacy-style` captures enforceable conventions; its hard
implementation is Claude-only.
`copilot-review-instructions` writes Copilot-only output from style rules,
instruction files, the README, and other docs: the path-scoped
`.github/instructions/*.instructions.md` files, plus the `# Code reviews`
section of `.github/copilot-instructions.md`, which points Copilot's reviewer
at those sources and names what CI already blocks. It owns only that section
of that file, not the whole file. For Codex, review rules belong under
`## Code Review Rules` in the closest applicable `AGENTS.md`.

## Design, document, and browser-testing skills

Adapted from [anthropics/skills](https://github.com/anthropics/skills), for
design, document-creation, and browser-testing work rather than the everyday
coding workflow above:

- **`frontend-design`** (all 3) gives distinctive, opinionated direction for
  palette, typography, and layout in new or reshaped UI. It can also apply one
  of ten curated color/font themes, or a generated theme, to an existing
  artifact.
- **`webapp-testing`** (all 3) drives a local web app in a real browser with
  Playwright to verify behavior, debug UI, capture screenshots, and read
  console logs.

[anthropics/skills](https://github.com/anthropics/skills) also has `docx`,
`pdf`, `pptx`, and `xlsx` skills, but their license doesn't allow vendoring
them here, so they're not in the table above. Run the separate installer
under [Install](../README.md#install) if you want them too.
