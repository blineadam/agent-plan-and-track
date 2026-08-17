# Out of scope

## What this file holds

This file records a decision not to build something, so a later session does not re-propose it without knowing the ground was already covered. A rejected proposal has no natural home file of its own, which is exactly why it needs a shared one.

A decision about how an existing component behaves stays in that component's own header, where the code that implements it lives, not here. `hooks/gateguard.js`'s header is the exemplar: it records why the ECC destructive-Bash gate was not ported, right where a future editor of that file will hit it.

`tasks/lessons.md` is a different thing again: it holds a correction about how to work, so a mistake does not recur. It is gitignored, session-local bookkeeping, while this file is checked in.

An entry here is a starting point for re-litigation, not a permanent ban. A new argument or a changed circumstance can reopen a decision, and the entry should then be updated rather than silently contradicted.

## `codebase-onboarding` stays skipped

Re-reviewed 2026-07-13 and 2026-07-16 during the ecc port. Its two outputs duplicate `/init` and `inherit-legacy-style`, and the one genuine gap, the decision-matrix/lifecycle rendering, is thin enough for an ad hoc prompt instead of a dedicated skill.

## Five other ecc skills stay skipped as redundant

Redundant with behavior already installed here, which is not always shipped as a skill: `verification-loop` is covered by the `delivery-gate` hook plus the verify-before-done rule, `growth-log` by `capture-lesson`, `token-budget-advisor` by `context-budget`, and `agent-self-evaluation` by `skill-comply`. `continuous-learning-v2` was declined on 2026-07-13.

## Frontmatter quoting needs no migration

Settled by a 2026-07-25 audit: all 29 skill and agent files already follow quote-only-when-YAML-forces-it, with zero mismatches. Both a uniform-quoting and a uniform-unquoting migration were considered and rejected. The audit did surface two latent defects, which were fixed separately.

## No response-shape assertion kind in the behavioral-smoke harness

Decided by an `architect-reviewer` consult on 2026-07-25. The mid-work-question clause is vacuous under a headless run, since stdin is closed, and the recap clause has no finite grammar to assert against. If causal evidence for either is ever needed, the instrument is a one-off billable contrast run judged by rubric, never the free `--check` path.

## SubagentStart re-injection declined

Decided 2026-07-21. Subagents already inherit the managed block and the gateguard/plan-gate stamps through the shared `session_id`, so a dedicated `SubagentStart` re-injection hook would be redundant. If violations ever do appear, the preferred fix is an install-time per-agent trailer over a new runtime hook.

## `wizard`'s credential-provisioning walkthrough stays unadopted

The `wizard` skill from `mattpocock/skills` generates an interactive bash script that walks a human through steps only they can perform: provisioning infrastructure, setting up credentials or CI secrets, navigating an unfamiliar third-party dashboard, or running a one-off migration or cutover.

It surfaced as a candidate during the 2026-08-08 survey of that repo and was raised as one of two remaining adoption candidates. The repo owner declined it on 2026-08-09, in these words:

> i dont actually need credential provisioning

The skill's value is proportional to how often a project runs a manual provisioning procedure, and this repo installs rules and skills rather than provisioning infrastructure. Nothing stops a project that does need this kind of walkthrough from adding the skill later; this is a judgment about fit here, not about the skill's quality.

## ASD-STE100 stays unadopted for rule text

Proposed on 2026-08-09 by the repo owner, who opened with the observation that this repo has many writing rules "which have had issues holding up", and then:

> I saw a suggestion to just put in the core-rules something similar to "Use ASD-STE100 Simplified Technical English (STE) for all prose and user responses"

They pointed at `danyuchn/asd-ste100-skill` as a possible scoring companion and asked whether the change would simplify things.

Three measurements settled it against adoption.

The digest cannot carry it. On the day of the measurement `rules/core-rules.md` sat six characters under the 10,000-character inline-persistence ceiling that `.github/scripts/check-digest-preview.js` enforces, counted in characters because that is the unit the guard enforces. Rewriting the writing-voice bullet in STE style added 130 characters and took the file to 10,124, which the guard rejects. Both bullets rewritten for this evaluation grew, one by 35 percent and one by 17 percent, which is what STE's one-instruction-per-sentence and keep-every-word-explicit rules would predict, though two rewrites establish a direction rather than a general rate. Crossing that ceiling reverts the digest to a roughly 2KB inline preview plus a file pointer, which is the delivery failure the character budget exists to prevent.

Applied anyway, it changed no behavior. An A/B compared the writing-voice bullet's current wording against an STE rewrite, with an identical offsetting cut in both arms so the wording was the only variable, over four prose scenarios in fresh isolated sessions. Both arms scored identically on every scenario, passing both neutral prompts and failing both prompts that pushed toward bulleted output. The control arm failed twice, so the measurement had room to show an improvement and showed none.

The clearest available restatement still did not hold. The STE arm states the em dash ban as its own short dedicated sentence rather than a parenthetical aside, and both arms emitted an em dash under formatting pressure regardless. This round found no sign that clearer rule text helps, on the strength of one run per scenario against a single model, which is enough to withhold the change and not enough to rule the effect out.

One assumption behind the proposal does not hold. The upstream skill ships no scoring script, producing a qualitative before-and-after table instead, so it cannot serve as the mechanical check the proposal imagined. Its stated scope is otherwise a fit here, since it explicitly targets prompts, system messages, tool descriptions, and inter-agent instructions, and excludes only creative or persuasive copy. That exclusion is where the `humanizer` skill governs instead, and it does not argue against the rule-text use evaluated above.

Two things would reopen this: evidence that rule wording measurably affects compliance, which this round looked for and did not find, or a digest with enough headroom to absorb STE's expansion without losing inline delivery. The evidence here is directional rather than statistical, at one run per scenario per arm and on Claude only.

## Knowledge-graph memory stays unadopted

Proposed on 2026-08-16 by the repo owner, pointing at [Glitch-Cat-Club/graph-memory-starter](https://github.com/Glitch-Cat-Club/graph-memory-starter) and a companion artifact, and asking:

> does it make sense to add a skill to build a knowledge graph, or maybe roll some of this into the /inherit-legacy-style skill or something similiar?

Both halves were declined, and the owner approved recording the decision here.

The fold into `inherit-legacy-style` fails the same way the `yeet` fold below did: the two load on different triggers. `inherit-legacy-style` captures coding conventions into `.ai-style-rules.md` when onboarding onto a legacy codebase; graph memory builds a SQLite entity/relationship store from a document corpus and recalls from it at prompt time through a hook. Different artifact, different trigger, different consumer.

A standalone skill was declined on redundancy and cost. Session recall is already served by three installed channels: the harness memory directory, whose `[[wiki-link]]` cross-references already give it a lightweight graph shape with recall built into the harness, `tasks/lessons.md` via `capture-lesson`, and checked-in decision records like this file. What the starter genuinely adds, multi-hop traversal over an entity-rich corpus with typed relations, injected at a fixed ~400 tokens per prompt via a UserPromptSubmit hook, has had no triggering use case in this repo's workflow, and per-prompt injection is exactly the always-on cost `context-budget` exists to police. Adopting it would also mean a Python/SQLite build step and a hand-modeled entity and relation vocabulary per corpus, since the starter's link types are domain-specific rather than universal.

One gap in the record: the companion artifact was not readable at decision time (it is served to non-members as a public artifact, which the reading path does not yet support), so its argument is inferred from the repo and the anchor name rather than read directly.

Two things would reopen this: a real need for multi-hop recall over an entity-rich document corpus in a project this setup serves, or the artifact's argument turning out to make a case the repo itself does not.

## `ruvnet/ruflo` stays unadopted

Proposed on 2026-08-16 by the repo owner, who pointed at [ruvnet/ruflo](https://github.com/ruvnet/ruflo) and asked whether anything in it should improve or expand this repo's subagents, parallel work, or anything else.

A `researcher` survey found ruflo (npm `claude-flow`) to be a much heavier thing than a rules/skills/hooks set: a 540MB npm/Rust monorepo that reimplements a multi-agent orchestration runtime, a vector memory store, and swarm-coordinator personas on top of Claude Code. It is actively maintained, but carries a high marketing-to-mechanism ratio, including inconsistent, unbenchmarked performance claims for the same feature (its README claims AgentDB's HNSW index is "1.9x-4.7x faster than brute force," its own memory-management skill doc claims "150x-12,500x faster" for the same mechanism).

Four things ruled out adoption:

- Its swarm/coordinator apparatus (`swarm init`, `task orchestrate --strategy parallel`, eight coordinator personas) duplicates what this repo already gets for free from Claude Code's own Agent and Workflow tools; the queen/scout/hive framing reads as persona dressing over that same underlying mechanism.
- Its AgentDB vector memory store is the same category of thing as the knowledge-graph memory proposal declined earlier the same day, above: no triggering use case, redundant with the harness memory directory, `tasks/lessons.md`, and checked-in decision records.
- Its Jujutsu-based lock-free worktree isolation (a `jj` wrapper letting concurrent agents commit/rebase without git's lock contention) is a genuinely different primitive, but disproportionate here: a new binary dependency for a marginal, unverified win on a problem this repo's `migration-discipline` skill and the `Workflow` tool's `isolation: "worktree"` already solve with git worktrees.
- Its one hook that looked structurally novel, a `PreCompact` hook injecting an agent/strategy reminder right before compaction, doesn't hold up on verification: [Claude Code's own hook docs](https://code.claude.com/docs/en/hooks-reference#exit-code-2-behavior-per-event) confirm `PreCompact` is output/observation-only and can only block via exit code 2, not inject content that survives into the compacted summary. The mechanism doesn't do what ruflo's own doc claims, at least not through the contract Claude Code exposes today.

A fifth item, a SHA256 checksum manifest over ruflo's security-critical config files, is real and independently verifiable rather than marketing, but has no fit here: this repo already regenerates installed copies idempotently from source via `install.sh`, and there is no multi-tenant trust boundary for a tamper-detection layer to protect.

Two things would reopen this: a concrete case where the harness's native Agent/Workflow tools fall short of a parallel-work need this repo actually has, or evidence that a `PreCompact`-timed mechanism can do more than Claude Code's current hook contract allows.

## `resolving-merge-conflicts` stays its own skill

Proposed on 2026-08-09 by the repo owner, who asked whether `yeet` should reference `resolving-merge-conflicts` and then argued the stronger form:

> resolving-merge-conflicts should just be part of yeet. No need for that extra skill in this context and typical use.

The two load on different triggers. `yeet` fires when finished work is ready to publish, which is most sessions that ship anything. `resolving-merge-conflicts` fires when a merge, rebase, or cherry-pick is already conflicted in the working tree, which publishing does not imply and which happens plenty of times that never reach a PR. Folding the second into the first would carry conflict guidance into every publish that has no conflict, and would strand the conflict procedure behind a publish trigger for the rebases and cherry-picks that end at a local commit.

What shipped instead is the overlap the proposal was pointing at. `yeet` said nothing about a rejected push or a branch that needs updating, so its push step now points at `[[resolving-merge-conflicts]]` for a non-fast-forward rejection whose reconciliation conflicts. The owner accepted that over the fold the same day, answering "yes" and quoting back the recommendation they were agreeing with: that a one-line pointer at the push step covers the typical case at almost no context cost.
