---
name: efficient-frontier
description: Use when a piece of work fits a tiered subagent instead of the main session: implementing or executing an already-written plan, spec, or todo batch; delegating the drafting of an implementation plan or spec to the planner tier (for starting a task's own tasks/todo.md workflow, use plan-and-track instead); research or codebase mapping across many files; reproducing a bug; a fully-specified mechanical edit; or a high-stakes security or architecture judgment. Also use before spawning any subagent (planner, executor, researcher, mechanic, debugger, security-auditor, architect-reviewer, fable-advisor), when picking which tier fits a piece of delegated work, or when reviewing what a subagent handed back.
---

# Efficient Frontier

Use the main session's own reasoning where its judgment actually matters: architecture, prioritization, ambiguity resolution, risk calls, synthesis, and final review. Push repeatable, bounded, or token-heavy work down to whichever subagent fits the work, so the main session's context and attention stay reserved for what only it can do.

## The Roster

Eight subagents, each pinned to a model tier that matches the cost of a missed judgment call (see `agents/*.md`):

- **planner** (read-only): drafts the spec or plan before any code is touched and returns it as text; the caller persists it (e.g. to tasks/todo.md).
- **executor**: implements a spec that's already been decided; not for open design decisions. A tier-tagged batch in `tasks/todo.md` is a valid spec shape: point executor at the file instead of inlining the plan.
- **researcher** (read-only): gathers facts across many files, maps how something works, answers a bounded question.
- **mechanic**: makes a mechanical edit that's already fully specified, no judgment calls.
- **debugger** (read-only): reproduces a failure and hands back a root cause plus a failing regression test; never fixes it.
- **security-auditor** (read-only): reviews security-sensitive changes for exploitable weakness; never patches.
- **architect-reviewer** (read-only): reviews a non-trivial design decision for tradeoffs and coupling; never implements.
- **fable-advisor**: a quick, under-300-word second opinion when a decision needs one more independent read, not a full review.

## Workflow

1. Identify the main-session-only decisions: architecture, prioritization, ambiguity resolution, risk, synthesis, and final review.
2. Identify delegable work: research scans, repo inventory, search, docs extraction, log reduction, test-failure clustering, narrow coding against an already-decided spec, and mechanical edits.
3. Pick the subagent whose tier matches the work's judgment cost, not the cheapest one that could technically do it.
4. Spawn subagents for independent slices with clear ownership, bounded scope, and expected evidence, in parallel when the slices don't depend on each other.
5. Require compact returns: findings, changed files, commands run, residual risk, stop conditions hit, and anything the main session must decide.
6. Integrate and review the returns centrally before presenting the result.

## Handoff Packets

Write delegated prompts as self-contained packets. Assume the receiving agent has no memory of this conversation. Include: the repo path, the objective, the scope and what's explicitly out of scope, the relevant files or search targets, the expected return format, verification commands, and stop conditions.

Useful stop conditions:

- The live code doesn't match the assumption in the handoff.
- A verification command fails twice after a reasonable fix or retry.
- The work appears to need files outside the assigned scope.
- The agent can't produce concrete evidence for its claim.

## Review Loop

Treat delegated output as evidence to weigh, not a verdict to rubber-stamp. Reopen the cited files that matter, skim high-risk diffs, and rerun or spot-check the verification before calling the work done. If two agents disagree, resolve it at the main-session layer instead of just taking the more confident-sounding answer.

## Worked Example: Planner to Executor to Mechanic

The default ladder for a spec-shaped task: `planner` writes the spec after reading the real code, then `executor` implements it end to end, then `mechanic` sweeps whatever small, already-decided mechanical tail is left (renames, doc updates, repeated small edits) once the shape of the change is settled. Each tier only does the part its cost is suited for: judgment goes into the plan, competence goes into building it, speed goes into the mop-up.

## Guardrails

- Don't reach for the harness's generic catch-all agent when a roster tier fits; the catch-all is the fallback for work no tier covers, not the default.
- Don't delegate the work that's actually the immediate blocker; if the next step depends on an answer, get it directly instead of waiting on a round trip.
- Don't send two agents to edit the same files at the same time.
- Don't trust a subagent's conclusion blindly when the stakes are high; inspect the evidence that matters yourself.
- Don't assume delegation always saves time. It pays off when the work is genuinely parallelizable or genuinely bounded, not as a reflex for everything.

## Beyond Claude Code

Copilot has no named-subagent concept: the equivalent is an ad hoc delegation prompt, or its generic `Agent`-style tool if one is available in that session. Codex has native subagents (its own `agents/*.md`-equivalent TOML files), so name-based delegation by role works there too, once that support lands.
