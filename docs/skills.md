# Skills reference

The full catalog of skills this repo installs, grouped by what they're for.
For the ones you'll actually hit every session, see the short tour in the
main [README](../README.md#what-you-get).

## Everyday workflow

Roughly the order you'd hit these in a session: plan the work, implement
under a fact-forcing gate, get checked before calling it done, and turn any
correction into a rule for next time.

- **`plan-and-track`** (skill) kicks in on multi-step work: a feature, a
  refactor, a 3+ step fix, or picking a repo back up that already has a
  `tasks/todo.md`. Writes a checklist, tracks it, and verifies before
  closing out. A Claude-only hook backs it up: it blocks writes to
  `tasks/todo.md` until the skill has actually run that session, and checks
  that new plan steps carry an owner tag (implementation defaults to
  executor; `main` needs a stated reason).
- **`plow-ahead`** (skill) kicks in when you're told to just proceed: "plow
  ahead," "use your best judgment," "don't stop." Turns ordinary ambiguity
  into stated assumptions, keeps moving, and only stops for a real blocker.
  Ends with a recap of what it decided and any residual risk.
- **gateguard** (skill + enforcing hook, Claude/Codex/Copilot) wants the
  facts first: before the first edit to a file, it wants to know who calls
  this code, what breaks, what the data actually looks like. The hook
  blocks that first edit until you've laid them out; the retry always
  passes. One script runs on all three harnesses, and an env var can
  soften or turn it off.
- **`read-the-damn-docs`** (skill) fires before leaning on memory for how a
  third-party API, library, or provider actually behaves right now. Forces
  a web search for the real docs first, complementing gateguard's local
  digging with an external check.
- **`efficient-frontier`** (skill) steps in before handing research, coding,
  or testing off to one of this repo's tiered subagents. Picks the tier
  that actually fits the work, so delegation doesn't burn the main
  session's judgment on something a cheaper agent could do.
- **delivery-gate** (enforcing hook only, Claude/Codex) is a warn-only check
  right before you finish: did you verify, did you checkpoint? Backs up
  the verify-before-done and capture-lesson rules at the harness level. An
  env var can make it block instead of warn.
- **`capture-lesson`** (skill) kicks in whenever you get corrected or I
  notice the same repeated error, and turns the correction into a durable 
  rule in `tasks/lessons.md`.
- **`humanizer`** (skill, adapted from
  [blader/humanizer](https://github.com/blader/humanizer)) kicks in before
  finalizing longer user-facing writing: README sections, docs, PR
  descriptions, blog-style prose. Strips the usual AI writing tells (em
  dashes, promotional puffery, filler, rule-of-three, chatbot artifacts)
  and restores something closer to a real voice.

A harness that can't run a given hook still gets the rule as a skill.
That's why Copilot, which has no Stop event, gets gateguard but not
delivery-gate. Tuning knobs for these hooks live in their script headers
under `hooks/`.

## Maintenance skills

These maintain the rules and skills themselves, rather than the everyday
coding workflow above. Portable where that's safe, Claude-only where the
mechanism genuinely only exists in Claude. Most are adapted from
[affaan-m/ecc](https://github.com/affaan-m/ecc); `skill-activation` and
`copilot-review-instructions` were built here.

### Building and testing skills

For writing a new skill or rule and checking that it actually works:

| Skill | What it does | Where |
| --- | --- | --- |
| **`rules-distill`** | Finds principles that show up across your skills but aren't rules yet, and proposes promoting them. | All 3 |
| **`skill-comply`** | Checks whether a fresh agent actually follows a given rule. | Claude only |
| **`skill-activation`** | Checks whether the *right* skill fires for a prompt, a routing check that's a sibling to `skill-comply`. | All 3 (the runtime check itself is Claude-only) |

### Session and context upkeep

For keeping a live session, and the always-on config behind it, healthy:

| Skill | What it does | Where |
| --- | --- | --- |
| **`strategic-compact`** | Nudges you to `/compact` at logical boundaries instead of mid-task; a Claude-only hook backs this up. | All 3 |
| **`context-budget`** | Audits always-on context cost and flags what's too big. | All 3 |

### Generated docs for agents

For turning a project's conventions into documentation other agents can read:

| Skill | What it does | Where |
| --- | --- | --- |
| **`inherit-legacy-style`** | Captures a legacy codebase's conventions into an enforceable `.ai-style-rules.md`. | All 3 |
| **`copilot-review-instructions`** | Generates path-scoped `.github/instructions/*.instructions.md` PR-review directives from a project's documented conventions (style rules, instructions file, README, docs). | All 3 (Copilot-only output) |

## Design and document skills

Adapted from [anthropics/skills](https://github.com/anthropics/skills), for
design and document-creation work rather than the coding workflow above:

| Skill | What it does | Where |
| --- | --- | --- |
| **`canvas-design`** | Produces original visual art (a poster, piece, or static design) as a PDF or PNG, built from an explicit design philosophy rather than a template. | All 3 |
| **`frontend-design`** | Gives distinctive, opinionated visual direction (palette, typography, layout) for new or reshaped UI, instead of templated defaults. | All 3 |
| **`theme-factory`** | Applies one of ten curated color/font themes (or generates a new one) to a slide deck or other artifact for consistent styling. | All 3 |

[anthropics/skills](https://github.com/anthropics/skills) also has `docx`,
`pdf`, `pptx`, and `xlsx` skills, but their license doesn't allow vendoring
them here, so they're not in the table above. Run the separate installer
under [Install](../README.md#install) if you want them too.
