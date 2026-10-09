# Credits

Every upstream source this repo adapts from, what was taken, and on what terms. The repo-wide MIT `LICENSE` carries the copyright lines for the MIT sources below. Vendored Apache-2.0 content keeps its own attribution notice inside the file plus a sibling `LICENSE.txt`, and the root `NOTICE` lists every such file.

## Rules

- [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) (MIT) fed the action-first output principle in `rules/agent-guidelines.md` and `rules/core-rules.md`. It was folded in as a standing rule rather than its upstream form, an opt-in, explicitly-invoked skill, since the point is output that is shaped this way by default, without a per-session invocation.
- [alexgreensh/attention-span](https://github.com/alexgreensh/attention-span) (AGPL-3.0, so only ideas are shared, with no borrowed sentences) fed two ideas: the compression-targets-elaboration bullet in `rules/agent-guidelines.md` and the artifact-requests bullets in both rule files. The wording is this repo's own and was rewritten once already, because a first draft reproduced several upstream clauses closely enough that the ideas-only claim was not true. Its scanning format, arrow-marked paragraphs and skim-the-bold-only emphasis, was deliberately left behind, and `docs/out-of-scope.md` records that decision and three others from the same review.

## Hooks

- [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, `git-guardrails-claude-code` skill) fed `hooks/git-guard.js`. Only the idea, a PreToolUse gate on destructive git commands, is carried over, not the implementation.
- The `gateguard-fact-force` hook in [affaan-m/ecc](https://github.com/affaan-m/ecc) (MIT) fed `hooks/gateguard.js`, adapted lean.

## Skills

- The Bun team's public port postmortem (bun.com/blog/bun-in-rust), an independent forensic write-up of a similar large-scale migration, is what `migration-discipline` is distilled from.
- [mattpocock/skills](https://github.com/mattpocock/skills) (MIT) fed three `migration-discipline` sections (expand-contract sequencing, a tautological-expectation warning, and durability-over-precision for long-lived artifacts), and `resolving-merge-conflicts` is adapted from it. It is also the source of `context-budget`'s no-op test, `rules-distill`'s state-the-target-not-the-trap principle, and `plan-and-track`'s answerable-frontier clause on batching questions.
- The code-modernization plugin in [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) (Apache-2.0, ideas only) fed three `migration-discipline` ideas: the mechanical oracle freeze, the characterization-test fallback, and the escalating fan-out ramp.
- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT) fed `logging-practices`, adapted from the logging parts of its observability-and-instrumentation skill: the on-call questions, the levels table, the correlation ID and entry-point fields, the no-secrets rule, and verifying the telemetry itself. Its metrics, tracing, and alerting sections are out of scope here.
- `logging-practices` also takes ideas only, with no copied text, from the logging skill in boristane/agent-skills, the OWASP Logging Cheat Sheet, and Stripe's canonical log lines post. Its section on logs an LLM can use is original.
- [affaan-m/ecc](https://github.com/affaan-m/ecc) (MIT) fed `rules-distill`, `strategic-compact`, `context-budget`, `skill-comply`, `inherit-legacy-style`, and `gateguard` (adapted from the ECC `gateguard` skill).
- [BuilderIO/skills](https://github.com/BuilderIO/skills) (MIT) fed `efficient-frontier`, `read-the-damn-docs`, and `plan-and-track`'s Running autonomously section (folded from the former plow-ahead skill). The frontmatter-schema checks in `skills/skill-activation/scripts/run-activation-cases.js` are adapted from its skill-schema lint.
- The yeet skill in [openai/skills](https://github.com/openai/skills) (Apache-2.0) is the original behind `yeet`, reached by way of the port in [ben-ranford/skills](https://github.com/ben-ranford/skills), which declares no license. The text is rewritten throughout, so nothing unique to that port remains, and the skill carries the Apache-2.0 notice and `LICENSE.txt`.
- [blader/humanizer](https://github.com/blader/humanizer) (MIT) fed `humanizer`, which is based on Wikipedia's ["Signs of AI writing"](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) guide from WikiProject AI Cleanup.
- The html-plan plugin in [anthropics/claude-plugins-community](https://github.com/anthropics/claude-plugins-community) (MIT per its plugin manifest, ideas only) fed `plan-and-track`'s clause that each clarifying question names the plan step its answer would add, remove, or change, adapted from its rule that a decision sits on the claim it changes.
- [HKUDS/OpenSpace](https://github.com/HKUDS/OpenSpace) (MIT) fed `skill-comply`'s evidence non-overlap rule in trace classification, adapted from its capture contract.
- [anthropics/skills](https://github.com/anthropics/skills) (Apache-2.0, vendored with modifications) fed `frontend-design`, which also carries the folded-in theming content of the former `theme-factory` skill, and `webapp-testing`.
- `muratcankoylan/agent-skills-for-context-engineering` (MIT) fed `skill-activation` with its `activation-cases` corpus technique, rebuilt for this repo's skill set.
- `skill-activation` and `copilot-review-instructions` were otherwise built directly in this repo.

## Agents

- [mattpocock/skills](https://github.com/mattpocock/skills) (MIT) is the source of `agents/debugger.md`'s build-the-loop-before-theorizing discipline.
- [DannyMac180/fable-advisor](https://github.com/DannyMac180/fable-advisor) (MIT) fed `agents/fable-advisor.md`.
- [openai/skills](https://github.com/openai/skills) (Apache-2.0) fed the threat-model mode of `agents/security-auditor.md`, carried over when the vendored security-threat-model skill was folded into that agent.
- [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) (MIT, ideas only, rewritten) fed `agents/security-auditor.md`'s review-mode verdicts, severity anchors, required finding shape, extra attack classes, and hardening-versus-finding split.

## Docs and process

- [mattpocock/skills](https://github.com/mattpocock/skills) (MIT) is where the idea behind `docs/out-of-scope.md` comes from: a shared file recording decisions not to build something, so a later session does not re-propose ground already covered.
