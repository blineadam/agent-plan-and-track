# Threat modeling prompt template

A disciplined, repo-grounded prompt that produces an AppSec-usable threat
model with a consistent output contract.

## Evidence and grounding rules

- Do not invent components, data stores, endpoints, flows, or controls.
- Every architectural claim needs at least one evidence anchor: a repo path,
  plus a symbol name, config key, or short quoted snippet where available.
- If information is missing, state the assumption explicitly and list the
  open question needed to validate it.
- Never output secrets. Redact any token/key/password encountered and only
  describe its presence and location.
- Separate production/runtime behavior from CI/build/dev tooling and from
  tests/examples. Separate attacker-controlled input from operator- and
  developer-controlled input. If a vulnerability class needs attacker
  control that likely doesn't exist for this repo's real usage, say so and
  downgrade severity.

## Mermaid diagram requirements

Produce one compact Mermaid flowchart of primary components and trust
boundaries, in a conservative subset that's guaranteed to render:

- `flowchart TD` or `flowchart LR`, `-->` arrows only.
- Simple node IDs (letters/numbers/underscores) with quoted labels, e.g.
  `A["Label"]`; avoid `A(Label)` shape syntax.
- No `title` lines or `style` directives.
- Edge labels are plain words/spaces only via `-->|label|`; avoid
  `{}`, `[]`, `()`, or quotes in edge labels, or drop the label.
- Keep node labels short: no file paths, URLs, or socket paths (put those
  details in prose outside the diagram).
- Wrap the diagram in a fenced ```mermaid``` block.

## Repository summary prompt

Use this to gather the inputs the threat model needs before writing it:

```text
Produce a security-oriented summary of {repo_directory/path} (branch
{branch_name}) that helps a follow-on security engineer build an initial
threat model and investigate potential security hypotheses.

1. Project overview: languages, frameworks, build system; core purpose and
   high-level architecture; major components/services/modules and how they
   interact.
2. Security posture and entry points: likely user entry points and trust
   boundaries; existing security layers (authn/authz, validation, sandboxing,
   isolation, privilege boundaries); security-critical components and the
   assumptions that must hold for the system to stay secure.

Answer: where does user input originate, how is untrusted data parsed and
handled, what assumptions must not be violated, and where are the likely
choke points for security bugs? Adapt to the project type (web app, CLI,
network daemon, OS/low-level component). If ripgrep is available, use it
with -I to skip binary files.
```

## Required output format (exact)

Before the final report, give an assumption-validation check-in: list the
key assumptions (3-6 bullets), ask 1-3 targeted context questions, and wait
for the user's response before writing the report below with the clarified
context.

Produce valid Markdown with these sections, in this order:

```
## Executive summary
One short paragraph on the top risk themes and highest-risk areas.

## Scope and assumptions
In-scope paths, out-of-scope items, explicit assumptions, and the open
questions that would materially change the risk ranking.

## System model
### Primary components
### Data flows and trust boundaries
Arrow-style bullets (Internet -> API Server, User Input -> Application
Logic, ...). Per boundary: data types crossing it, channel/protocol,
security guarantees (auth, origin checks, encryption, rate limiting), and
input validation/normalization/schema enforcement.
#### Diagram
The Mermaid flowchart described above.

## Assets and security objectives
Table: Asset | Why it matters | Security objective (C/I/A)

## Attacker model
### Capabilities
### Non-capabilities

## Entry points and attack surfaces
Table: Surface | How reached | Trust boundary | Notes | Evidence (repo path/symbol)

## Top abuse paths
5-10 short abuse paths, each a numbered sequence (attacker goal -> steps -> impact).

## Threat model table
Table columns: Threat ID | Threat source | Prerequisites | Threat action |
Impact | Impacted assets | Existing controls (evidence) | Gaps | Recommended
mitigations | Detection ideas | Likelihood | Impact severity | Priority.
Threat IDs are stable (TM-001, TM-002, ...); priority is one of
critical/high/medium/low; keep prerequisites to 1-2 sentences and
recommendations concrete.

## Criticality calibration
What critical/high/medium/low mean for this repo and context, with 2-3
examples per level tailored to its assets and exposure.

## Focus paths for security review
Table: Path | Why it matters | Related Threat IDs
```

Include 1-2 repo-path anchors per major claim rather than dumping every
match, and fill in known context while letting the model infer and mark
the rest as assumptions.
