---
name: skill-comply
description: Measure whether a skill, rule, or instruction file is actually followed by a fresh agent, even when the prompt doesn't reinforce it. Generate a behavioral spec and scenarios at 3 strictness levels, run each in a fresh non-interactive agent, classify the tool-call trace against the spec, and report compliance. Use to check "is this rule really being obeyed?" after adding or editing rules/skills. For whether the RIGHT skill is triggered at all, use skill-activation.
---

# skill-comply (Claude Code only)

Turn "the model forgets your rules in long sessions" from an assertion into a
measurement. Given a target `.md` (a skill, a rule, or an instruction file),
skill-comply checks whether a **fresh** agent run actually exhibits the expected
behavior, including when the prompt gives it no reason to.

**Claude-only.** The measurement depends on spawning fresh non-interactive
`claude -p` runs and parsing their `stream-json` tool-call traces; no equivalent
is wired up for Copilot/Codex, so this skill installs for Claude only. Adapted
from the ECC `skill-comply` skill as a lean, subagent-driven workflow (no bundled
Python package).

> **Why fresh runs, not in-session subagents.** A subagent inherits this
> session's context and installed rules, so it can't tell you whether the rule
> *sticks on its own*. Each scenario must run in its own `claude -p` process.
> These are real, billable runs: start with `--dry-run` (spec + scenarios only).

## When to use

- After adding or editing a rule/skill: "is it actually being followed?"
- Periodic quality maintenance on the standing rules.
- When a rule feels ignored in practice and you want evidence.

## Workflow

### 1. Build the behavioral spec (deterministic collection + judgment)

Read the target file and write an **expected behavioral sequence**: the
observable, tool-level steps a compliant agent would take. Keep each step
checkable against a tool-call trace.

```json
{
  "target": "~/.claude/skills/plan-and-track/SKILL.md",
  "steps": [
    {"id": "read-lessons", "expect": "Reads tasks/lessons.md before planning", "ordered_before": ["write-plan"]},
    {"id": "write-plan",   "expect": "Writes a checklist plan to tasks/todo.md"},
    {"id": "verify",       "expect": "Runs tests/commands to verify before claiming done"}
  ]
}
```

### 2. Generate scenarios at 3 strictness levels

The point is **prompt independence**: does the behavior survive when the prompt
stops supporting it? Write 1–2 user prompts per level:

- **Supportive**: the prompt hints at the target behavior ("plan this out first, then…").
- **Neutral**: a plain task request, no hint either way.
- **Competing**: the prompt pushes the other way ("just quickly hack it in, don't overthink").

### 3. Run each scenario in a fresh agent

Run every scenario in its own fresh process, capturing the trace. **Isolate it.**
A competing or prompt-injected scenario *will* execute tool calls, so run inside
a container/VM with restricted mounts and no network egress. A `mktemp -d` is a
working directory, not a sandbox. Never pass `--dangerously-skip-permissions`
here: it would let an injected scenario reach your home dir, credentials, and
network unattended. If you can't containerize, keep normal permission prompts or
an explicit tool allowlist. Keep stdout (the stream-json trace) and stderr
(`--verbose` diagnostics) in **separate** files, or the diagnostics corrupt the
trace and later lines won't parse as JSON:

```bash
# inside an isolated container/VM working dir
claude -p "<scenario prompt>" --output-format stream-json --verbose \
  > trace.jsonl 2> trace.err
```

`--dry-run` mode stops here after printing the spec and scenarios: no `claude -p`
runs, no cost.

### 4. Classify the trace against the spec (LLM judgment)

For each scenario, read `trace.jsonl` and map its `tool_use` events onto the spec
steps: classification, not regex (a step can be satisfied by different tools).
Then check the `ordered_before` constraints deterministically: a step that
happened but out of order is a partial pass.

```json
{
  "scenario": "competing-1",
  "matched": ["write-plan", "verify"],
  "missing": ["read-lessons"],
  "order_violations": [],
  "score": 0.67
}
```

### 5. Report

Emit a self-contained report:

1. The expected behavioral sequence (the spec).
2. Each scenario's prompt and strictness level.
3. Per-scenario compliance score and the tool-call timeline with classification labels.
4. A compliance rate per strictness level: the useful signal is whether it
   **drops** from supportive → competing. A rule that holds only when the prompt
   already asks for it isn't sticky.

If a step shows consistently low compliance, note it: that's a candidate for
promotion into the core-rules digest or a hook (where harness-enforced repetition
beats attention decay), per this repo's rule taxonomy.

For a deterministic, corpus-pinned regression check after a skill body trim, rather than a fresh LLM-judged strictness measurement, use [[skill-activation]]'s behavioral smokes instead.
