# Security Policy

## Reporting a vulnerability

Please use GitHub's [private vulnerability reporting](https://github.com/blineadam/agent-plan-and-track/security/advisories/new)
(Security tab → "Report a vulnerability") instead of opening a public issue.
That gives us a private channel to discuss and fix the problem before any
details are public.

There's no fixed SLA, but expect an initial response within a few days.

## Supported versions

This repo is installed by checking it out and running `install.sh` /
`install.ps1` directly, not by pulling a versioned package. Only the latest
commit on `main` (and the latest tagged release, if you pinned one with
`git checkout vX.Y.Z`) is supported. If you're on an older checkout, pull
`main` before reporting.

## Scope

This repo generates and installs local configuration for AI coding harnesses
(Claude Code, GitHub Copilot, Codex): instruction files, skills, and Node
hook scripts copied into `~/.claude`, `~/.copilot`, and `~/.codex`. There's no
server, no network service, and no user data collected or transmitted by the
repo itself. Security issues here look different from a typical web app.
Things worth reporting:

- A hook script (`hooks/*.js`) that could be made to execute unintended
  commands, escape its working directory, or run with more privilege than
  the harness's own tool-call permissions grant.
- An installer path (`install.sh` / `install.ps1`) that writes outside the
  intended `~/.claude`, `~/.copilot`, or `~/.codex` directories, or that
  clobbers user content outside the managed marker blocks it's supposed to
  be scoped to.
- Content injected into the always-on context (`rules/core-rules.md`, a
  skill's `SKILL.md`) in a way that could smuggle instructions past the
  user's intent, i.e. a prompt-injection supply-chain issue, as opposed to
  an ordinary bug in the rule's wording.
- Secrets or credentials committed to the repo, or a code path that could
  cause them to be logged or exfiltrated.

Not in scope: vulnerabilities in Claude Code, GitHub Copilot, or Codex
themselves (report those to Anthropic, GitHub, or OpenAI respectively), or
in third-party projects this repo credits/adapts from (see `README.md`).

## Dependencies

The hook scripts under `hooks/` use only Node.js built-in modules, no npm
dependencies. `install.sh` needs `jq`; `install.ps1` needs nothing beyond
PowerShell 5.1. `.github/dependabot.yml` covers the GitHub Actions used in
`.github/workflows/`.
