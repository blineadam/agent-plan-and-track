---
name: security-threat-model
description: "Repo-grounded threat modeling: enumerates trust boundaries, assets, attacker capabilities, abuse paths, and mitigations, then writes a concise Markdown threat model. Trigger only when the user explicitly asks to threat-model a codebase or path, enumerate threats/abuse paths, or do AppSec threat modeling. Do not trigger for general architecture summaries, code review, or non-security design work."
---

<!-- Adapted from the Apache-2.0 licensed original at https://github.com/openai/skills
(skills/.curated/security-threat-model). Modified: retitled the H1 to match
this skill's registered name, added the security-auditor subagent routing
paragraph below, collapsed the upstream's "### N)" workflow subsections into
a single flat numbered list under one Workflow heading, removed a duplicated
assets bullet between what were upstream steps 2 and 3, reordered the
reference sections ahead of Workflow per this repo's own skill-anatomy
convention, and trimmed prose throughout. Full license text: LICENSE.txt in
this directory. -->

# Security Threat Model

Deliver an AppSec-grade threat model specific to the repo or path in scope,
not a generic checklist. Anchor every architectural claim to repo evidence,
keep assumptions explicit, and prioritize realistic attacker goals and
concrete impacts over generic checklists.

When the tiered subagent roster is available, route the actual
trust-boundary mapping and threat-ranking analysis to the `security-auditor`
subagent per [[efficient-frontier]] (it's pinned to the roster's
strongest-judgment tier for exactly this kind of call); fall back to inline
analysis only when the roster isn't available.

## Risk prioritization guidance (illustrative, not exhaustive)

- High: pre-auth RCE, auth bypass, cross-tenant access, sensitive data
  exfiltration, key/token theft, model or config integrity compromise,
  sandbox escape.
- Medium: targeted DoS of critical components, partial data exposure,
  rate-limit bypass with measurable impact, log/metrics poisoning that
  affects detection.
- Low: low-sensitivity info leaks, easily-mitigated noisy DoS, issues that
  need unlikely preconditions.

## References

- `references/prompt-template.md`: the output contract and full prompt
  template. Follow it closely, especially the evidence-anchor and
  Mermaid-diagram rules.
- `references/security-controls-and-assets.md`: an optional
  controls/asset checklist.

Load only the reference files you need. Keep the final result concise,
grounded, and reviewable.

## Workflow

Before starting, collect the repo root and any in-scope paths, plus intended
usage, deployment model, internet exposure, and auth expectations if known.
Use `references/prompt-template.md`'s repo-summary and output-contract
prompts throughout, and follow that output contract closely.

1. **Scope and extract the system model.** Identify primary components, data
   stores, integrations, how the system runs (server/CLI/library/worker),
   and its entrypoints. Separate runtime behavior from CI/build/dev tooling
   and tests. Map in-scope locations to components and exclude out-of-scope
   items explicitly. Never claim a component, flow, or control without
   evidence.
2. **Derive boundaries, assets, and entry points.** Enumerate trust
   boundaries as concrete edges (protocol, auth, encryption, validation,
   rate limiting). List the assets that drive risk (data, credentials,
   models, config, compute, audit logs). Identify entry points (endpoints,
   upload surfaces, parsers/decoders, job triggers, admin tooling,
   logging/error sinks).
3. **Calibrate attacker capabilities.** Describe realistic attacker
   capabilities given exposure and intended usage, and note explicit
   non-capabilities to avoid inflated severity.
4. **Enumerate threats as abuse paths.** Prefer attacker goals mapped to
   assets and boundaries (exfiltration, privilege escalation, integrity
   compromise, denial of service). Keep the threat count small but high
   quality.
5. **Prioritize with likelihood x impact.** Qualitative low/medium/high for
   both, with a short justification each; set overall priority
   critical/high/medium/low, adjusted for existing controls. State which
   assumptions most influence the ranking.
6. **Pause to validate assumptions with the user.** Summarize the
   assumptions that materially affect scope or ranking, ask 1-3 targeted
   questions (service owner/environment, scale, deployment model,
   authn/authz, internet exposure, data sensitivity, multi-tenancy), then
   wait for the user's answer before producing the final report. If the
   user can't answer, state which assumptions remain and how they affect
   priority.
7. **Recommend mitigations.** Distinguish existing mitigations (with
   evidence) from recommended ones, tied to a concrete component, boundary,
   or entry point and control type. Prefer specific hints ("enforce schema
   at the upload gateway") over generic advice. Mark a recommendation
   conditional if it rests on an unresolved assumption.
8. **Run a quality check and write the report.** Confirm every discovered
   entrypoint and trust boundary is covered, runtime vs CI/dev is
   separated, user clarifications (or explicit non-responses) are
   reflected, and the report matches `references/prompt-template.md`'s
   output contract, including its Mermaid diagram constraints (a single
   compact `flowchart TD`/`LR`, `-->` only, quoted short node labels, no
   paths/URLs/`title`/`style`, plain-word edge labels). Write the result to
   `<repo-or-dir-name>-threat-model.md`.
