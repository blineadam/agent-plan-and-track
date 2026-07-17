---
name: plow-ahead
description: Use when the user explicitly wants autonomous progress without routine clarification stops, phrases like "plow ahead", "do not stop", "use your best judgment", "keep going until done", "finish while I am away", or "do not ask questions unless truly blocked": convert ordinary ambiguity into stated assumptions, proceed through implementation and validation, stop only for true blockers, and end with a clear recap of decisions, changes, verification, and residual risk.
---

# Plow Ahead

Proceed through ordinary ambiguity. Make reasonable assumptions, keep momentum, validate as you go, and make the final recap strong enough that the user can see what decisions were made while they were away.

This skill elaborates the "Autonomous bug fixing" rule already in `rules/agent-guidelines.md` ("Given a bug report, logs, or failing tests, just fix it end-to-end. No hand-holding required.") into a full autonomy contract that applies to any explicitly-autonomous task, not just bug fixes.

## Autonomy Contract

Treat the user's instruction as permission to continue through normal uncertainty:

- Turn routine questions into explicit assumptions.
- Prefer the smallest reversible choice that satisfies the request.
- Use repo conventions, nearby patterns, local docs, tests, and existing product behavior as the decision source.
- Keep working through normal test failures, missing context, implementation choices, and minor ambiguity.
- Use subagents for independent research, implementation, or verification when parallel work can reduce idle time or improve coverage; pick which tier per [[efficient-frontier]] when the tiered subagent roster is available.
- Do not pause merely to ask which reasonable option the user prefers. Pick one, record why, and keep going. When a judgment call feels close enough to want a second opinion and the tiered subagent roster is available (per [[efficient-frontier]]), delegate it to the `fable-advisor` subagent for an independent gut-check, weigh it, and continue; without the roster, apply the Decision Rules below inline and continue.

## Stop Conditions

Stop and hand back to the user only for true blockers that need their authorization or private input, the calls `fable-advisor` cannot unblock:

- Required credentials, secrets, accounts, paid services, or private data are unavailable.
- The next step would be destructive, irreversible, or production-mutating.
- The task requires an explicit branch operation, history rewrite, force push, or deletion that the user did not directly request.
- Legal, safety, privacy, or security risk is high and cannot be reduced by a conservative local choice.
- The user explicitly reserved a decision for themselves.

A verification failure that repeats after reasonable investigation, where the next fix would be speculative or broad, is a judgment call, not a user-authorization blocker. When the tiered subagent roster is available (per [[efficient-frontier]]), delegate it to the `fable-advisor` subagent for an independent read on whether to proceed, narrow scope, or stop, and follow that read; without the roster, make the same call inline using the Decision Rules below. A read of proceed or narrow scope means keep going; a read of stop means treat it as a stop condition and hand back to the user below. `fable-advisor` advises only; it cannot itself authorize continuing past any of the blockers above.

If blocked, leave a self-contained handoff: what was done, what blocks progress, what exact input is needed, and the next command or file to inspect.

## Decision Rules

When choosing without the user:

1. Reuse existing patterns before inventing new ones.
2. Prefer local, reversible, low-blast-radius changes.
3. Keep scope tight to the user's request.
4. Choose correctness and maintainability over cleverness.
5. Validate with the smallest meaningful test first, then broaden only when the risk justifies it.
6. If two options are close, choose the one that is easier for the user or a reviewer to understand later.

Maintain a lightweight decision log while working. It can live in notes, the plan, or the final answer, but don't create a new repo artifact unless the task needs one.

## Work Loop

1. Restate the goal internally and identify likely acceptance criteria.
2. Inspect the real files, docs, issue, PR, screenshots, or runtime behavior before editing.
3. Make assumptions explicit, then act on them.
4. Implement in small coherent steps.
5. Run targeted validation and fix issues found by validation.
6. Repeat until the requested work is complete or a stop condition applies.
7. Before the final response, review the diff and verification evidence against the original request.

## Final Recap

End with a recap that makes autonomous decisions auditable:

```md
Goal
- What you completed.

Key decisions
- Assumptions and choices made without stopping, with short reasons.

Changes
- Files, behavior, docs, or configuration changed.

Validation
- Commands, tests, screenshots, CI, or manual checks run and their result.

Remaining risk
- Anything not verified, deferred, or blocked.
```

Keep the recap factual. Don't hide uncertainty, skipped validation, or judgment calls.
