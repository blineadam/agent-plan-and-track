# Out of scope

## What this file holds

This file records a decision not to build something, so a later session does not re-propose it without knowing the ground was already covered. A rejected proposal has no natural home file of its own, which is exactly why it needs a shared one.

A decision about how an existing component behaves stays in that component's own header, where the code that implements it lives, not here. `hooks/gateguard.js`'s header is the exemplar: it records why the ECC destructive-Bash gate was not ported, right where a future editor of that file will hit it.

`.tasks/lessons.md` is a different thing again: it holds a correction about how to work, so a mistake does not recur. It is gitignored, session-local bookkeeping, while this file is checked in.

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

## The AI-native SDLC playbook's heavier machinery stays unadopted

Reviewed 2026-09-06 against [the playbook](https://claude.com/blog/the-ai-native-sdlc-playbook) and its linked case studies. Four narrow changes came out of that review and shipped. The rest is recorded here because the playbook is the kind of document a later session will find again and read as a to-do list.

Four things were declined because this repo already has the mechanism:

- An SDLC orchestrator layer. `plan-and-track` plus the agent roster already sequences the work, and the ruflo entry above rejects a heavier orchestration runtime on the same grounds.
- Mandatory `intent.md`, `spec.md`, and `plan.md` files. A batch in the local task file already carries the goal, scope, ordered steps, per-step verification, and owner tags. Three more files per change would duplicate that record and split it across four places.
- A generic verifier skill or a fourth verifier agent. Verification is per-step in the plan and backed by the verify-before-done rule and the `delivery-gate` hook. A dedicated verifier would inherit no evidence the step does not already name.
- Automatic test quarantine. Quarantining a failing test on a schedule is the mechanized form of the weakened green that the never-fake-a-green-result rule exists to forbid.

Enterprise telemetry as an audit trail was declined on a factual ground instead. Claude Code's [monitoring redacts content by default](https://code.claude.com/docs/en/monitoring-usage#security-and-privacy) and hook completion records carry aggregate counts, so default telemetry is neither a transcript nor a per-hook approval ledger. The playbook's environment-variable release-approval example has the matching problem: it tests ambient state rather than authenticating a named approver, so it is not an independent-approval mechanism and should not be adopted as one.

## A repo-root `REVIEW.md` would be inert here

Decided 2026-09-06, alongside the entry above. Claude Code reads `REVIEW.md` only in the hosted GitHub Code Review service. The local `/code-review` command does not: "The review follows your `CLAUDE.md` like any Claude Code session, but it doesn't read `REVIEW.md`" ([docs](https://code.claude.com/docs/en/code-review#what-the-review-reads-and-edits)). This repo is reviewed by Copilot on its PRs and by the local command in-session, and the hosted service is not enabled on it, so a `REVIEW.md` here would be read by nothing.

The instruction channels that do reach a reviewer are already owned: `.github/instructions/*.instructions.md` and the `# Code reviews` section of `.github/copilot-instructions.md`, both generated by `copilot-review-instructions`. A third file with no consumer would only invite drift against those two. Enabling the hosted service on this repo would reopen the question.

## attention-span's scanning format and output style stay unadopted

Reviewed 2026-09-06 against [alexgreensh/attention-span](https://github.com/alexgreensh/attention-span), which ships three Claude Code output styles built around answer-first, ADHD-friendly delivery. Two of its ideas were adopted as rule bullets, compression-targets-elaboration and artifact-requests-get-the-artifact-alone, and are credited in `AGENTS.md`. Only the second earned a place in the digest; the entry below records why the first did not. The rest is recorded here because most of the project restates rules this repo already carries, and the parts that do not conflict with rules it carries deliberately.

Four things were declined:

- The scanning format itself: `→` markers as standalone paragraphs, and bolding chosen so that reading only the bold text yields the whole answer. This is the mechanism the project's measured gains rest on, so declining it means declining most of its value. It contradicts the writing-voice rule's ban on lists and bold-lead bullets for a one-or-two-concept answer, and the be-skimmable rule's preference for plain prose over dense bullets. Adopting it is a change to those rules, not an addition alongside them.
- Rundown's status board, which tags rows with checkbox and traffic-light emoji. The writing-voice rule bans emoji everywhere, including tables and docs.
- Replacing the installed `outputStyle: Concise` with one of the three styles. Concise is built into Claude Code, `install.sh` already asserts it as a managed default, and it covers answer-first and cut-the-narration on its own. Swapping it in would import the format conflict above and add a per-harness file the installers would then have to manage.
- A third candidate bullet, placing a blocking question last with nothing after it. Presented with the digest measurements for both options, the owner asked:

> what do you suggest given the size and need 1+2 or 1+2+3

and then approved the two-bullet recommendation by instructing that it be implemented. The recommendation was this session's, not a preference the owner stated: the action-first rule already requires surfacing what needs the user once at the end, so a third bullet would add placement only, and the digest had roughly 1,000 characters of headroom left against a 10,000-character inline-persistence ceiling that a previous trim already had to claw back under.

What would reopen this: a decision to relax the writing-voice rule's bold and list constraints, which is the real blocker on the format, or evidence that blocking-question placement is a recurring problem in practice, in which case it belongs in `rules/agent-guidelines.md` only, where there is no character ceiling.

## The compression-targets-elaboration rule stays out of the digest

Decided 2026-09-06, in the same round that adopted the rule itself into `rules/agent-guidelines.md`. The rule states an obligation no other rule here carried, that shortening takes examples and background rather than figures, bounds, disputed points, and safety-critical detail. It is worth stating. It has not earned the digest.

The measurement is the reason, and it is worth recording precisely because it is easy to misread. Four contrast cells ran with the bullet appended as the only variable. Two put mild brevity pressure on the reply, and in both the control arm preserved every figure, bound, and dissenting detail unaided, so neither cell had room to show a benefit. Two applied a hard word cap. One favored the treatment arm slightly, which kept an explicit scope marker the control dropped. The other favored the control, which kept a secondary figure the treatment shed.

That is one informative cell out of four, and it split. The honest reading is that the rule is unmeasured, not that it was disproven, which is the distinction `.tasks/lessons.md` draws when it warns that a ceiling control arm is a cost result rather than evidence of no benefit. The ASD-STE100 entry above is not the governing precedent either: that decision turned on rewording an existing rule, where this one adds an obligation that was never stated.

The digest is the scarce channel. It sits under a 10,000-character inline-persistence ceiling that an earlier trim already had to claw back under, and this bullet would have taken roughly 300 of the 1,000 characters remaining. An unmeasured rule does not get that on every prompt, forever, ahead of a rule that measures. The instruction file has no such ceiling and is also the only rules channel a subagent ever sees, so nothing is lost by keeping it there.

A design flaw surfaced alongside the measurement and is fixed in the surviving copy rather than carried. The rule originally said the facts survive every cut, which a hard word cap can make impossible, so it gave no way to tell a compliant reply from a failing one. It now fixes the triage order under a cap and requires naming what was left out.

That hard-cap contrast was then run, three cells against the revised wording, and it did not settle anything either. The control arm preserved every figure, bound, and safety-critical fact in all three, once leading with the irreversible-corruption warning unprompted. No treatment cell named what it had cut, so the new triage clause produced no observable difference. Seven cells in, no scenario yet written makes the control fail, which is a fact about the scenarios rather than about the rule.

Two things would reopen this: a contrast whose control arm actually fails, which means finding a prompt shape that induces lossy compression in the first place, or evidence that over-compression is a late-session decay failure rather than a prompt-shape one. The second matters more than it looks. Late decay is the digest's actual admission criterion, and if over-compression is instead driven by the shape of a single prompt, re-injecting the rule every turn would not fix it no matter what a contrast run showed.
