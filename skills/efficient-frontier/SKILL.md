---
name: efficient-frontier
description: "Use when a piece of work fits a tiered subagent instead of the main session: implementing or executing an already-written plan, spec, or todo batch; delegating the drafting of an implementation plan or spec to the planner tier (for starting a task's own tasks/todo.md workflow, use plan-and-track instead); research or codebase mapping across many files; reproducing a bug; a fully-specified mechanical edit; or a high-stakes security or architecture judgment. Also use before spawning any subagent (planner, executor, researcher, mechanic, debugger, security-auditor, architect-reviewer, fable-advisor), when picking which tier fits a piece of delegated work, or when reviewing what a subagent handed back."
---

# Efficient Frontier

Use the main session's own reasoning where its judgment actually matters: architecture, prioritization, ambiguity resolution, risk calls, synthesis, and final review. Push repeatable, bounded, or token-heavy work down to whichever subagent fits the work, so the main session's context and attention stay reserved for what only it can do.

## The Roster

Eight subagents, each pinned to a model tier that matches the cost of a missed judgment call (see `agents/*.md`):

- **planner** (read-only): drafts the spec or plan before any code is touched and returns it as text; the caller persists it (e.g. to tasks/todo.md).
- **executor**: implements a spec that's already been decided; not for open design decisions. An `executor`-tagged batch in `tasks/todo.md` is a valid spec shape: point executor at the file instead of inlining the plan.
- **researcher** (read-only): gathers facts across many files, maps how something works, answers a bounded question.
- **mechanic**: makes a mechanical edit that's already fully specified, no judgment calls.
- **debugger** (read-only): reproduces a failure and hands back a root cause plus a failing regression test; never fixes it.
- **security-auditor** (read-only): reviews security-sensitive changes for exploitable weakness; never patches.
- **architect-reviewer** (read-only): reviews a non-trivial design decision for tradeoffs and coupling; never implements. A design with high churn cost, not just high reversal cost, counts too: state machinery inside automation (checkpoints, external state stores, self-referential loops where the output feeds the next input) is one shape of it, even when each individual change looks small.
- **fable-advisor**: a quick, under-300-word second opinion when a decision needs one more independent read, not a full review.

## Workflow

1. Identify the main-session-only decisions: architecture, prioritization, ambiguity resolution, risk, synthesis, and final review.
2. Identify delegable work: research scans, repo inventory, search, docs extraction, log reduction, test-failure clustering, narrow coding against an already-decided spec, and mechanical edits.
3. Pick the subagent whose tier matches the work's judgment cost, not the cheapest one that could technically do it.
4. Spawn subagents for independent slices with clear ownership, bounded scope, and expected evidence, in parallel when the slices don't depend on each other. Dispatch each slice as soon as its inputs exist and keep doing main-session work while it runs: the wall-clock win comes from overlap, not just fan-out.
5. Require compact returns: findings, changed files, commands run, residual risk, stop conditions hit, and anything the main session must decide.
6. Integrate and review the returns centrally before presenting the result.

## Handoff Packets

Write delegated prompts as self-contained packets. Assume the receiving agent has no memory of this conversation. Include: the repo path, the objective, the scope and what's explicitly out of scope, the relevant files or search targets, the expected return format, verification commands, stop conditions, and any decision the plan already closed, especially "accepted tradeoff" or "deliberately not fixed" lines, carried verbatim. In a brief for review triage, frame each such line as: dispute this specific finding with the plan's own rationale, don't fix it; a finding that brings evidence the plan never weighed is a stop condition to report back, not something to fix or dispute on the spot. A brief whose deliverable is verification or confirmation is default-deny: instruct the agent to report not-confirmed unless it can cite concrete evidence (e.g. file and line, command output, logs, or demonstrated behavior).

Useful stop conditions:

- The live code doesn't match the assumption in the handoff.
- A verification command fails twice after a reasonable fix or retry.
- The work appears to need files outside the assigned scope.
- The agent can't produce concrete evidence for its claim.

## Review Loop

Treat delegated output as evidence to weigh, not a verdict to rubber-stamp. Reopen the cited files that matter, skim high-risk diffs, and rerun or spot-check the verification before calling the work done. If two agents disagree, resolve it at the main-session layer instead of just taking the more confident-sounding answer. For an executor-tagged todo batch, this loop has a concrete mandatory form: the independent diff review step in [[plan-and-track]], dispatched before the batch's boxes are checked. The same restraint applies to external review: after the first external review (e.g. Copilot) lands on a PR, re-request review only for fixes that are themselves high-risk or hard to verify directly, and verify a mechanical fix by running the thing itself (a local repro or the real CI run) rather than another review pass. An external reviewer usually has much less context than you do (an agentic reviewer can explore the repo, a human may know some history, but neither reliably sees the plan, the test results, or the prior attempts), so it can flag a real defect you missed and equally re-litigate a decision it never saw: triage each finding against that fuller context before fixing, disputing, or reframing it: a finding rooted in state-dependent or special-cased wording often dissolves under a more general rewrite, needing neither a patch nor a dispute. For a high-risk diff (concurrency, security-sensitive surfaces, hard-to-reverse operations), use two independent reviewers rather than a second pass by the same one: one reviewer's blind spots repeat across its own passes ([[migration-discipline]] applies the same rule to port reviews). When review findings arrive after a batch's boxes are already checked (a late external review, a post-merge report), give them the same triage as pre-check findings and put any accepted fix or reframe back on the plan as unchecked work; a checked box records that verification happened, it doesn't close the case against later evidence.

## Worked Example: Planner to Executor to Mechanic

The default ladder for a spec-shaped task: `planner` writes the spec after reading the real code, then `executor` implements it end to end, then `mechanic` sweeps whatever small, already-decided mechanical tail is left (renames, doc updates, repeated small edits) once the shape of the change is settled.

## Guardrails

- Don't reach for the harness's generic catch-all agent when a roster tier fits; the catch-all is the fallback for work no tier covers, not the default.
- Don't delegate objective blockers such as fact checks, file lookups, or quick reads; resolve them in the main session. Exception: consult the appropriate roster advisor for design, architecture, security, or judgment calls, even when they block the next step. 
- Don't send two agents to edit the same files at the same time.
- Don't fan a repetitive change out across the full target set on the first pass. Pilot the brief on a small representative subset, review those results, fold the corrections into the brief, then scale to the rest.
- Don't assume delegation always saves time. It pays off when the work is genuinely parallelizable or genuinely bounded, not as a reflex for everything.

## Beyond Claude Code

Copilot CLI has its own custom-agent system, and this repo's installer renders the roster there too, as native Copilot custom agents (`~/.copilot/agents/*.agent.md`): name-based delegation works via `/agent`, `--agent`, or naming the agent in a prompt, but only tool permissions carry over, not the model tier or effort. Codex has native subagent workflows in its desktop app, CLI, and IDE extension; the installer renders the roster as `~/.codex/agents/*.toml`, and current local clients can delegate to named roles directly or when applicable `AGENTS.md` and skill instructions request it.
