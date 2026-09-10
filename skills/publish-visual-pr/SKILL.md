---
name: publish-visual-pr
description: Prepare and publish GitHub UI pull requests using the installed yeet skill and browser MCP, with deterministic main-vs-head screenshots uploaded after Copilot review settles. Use when reviewers need visual proof in a polished PR body. Do not use for nonvisual PRs or as authorization to push or publish.
---

# Publish a visual PR

Make the PR easy to review without asking the reviewer to reconstruct the change locally. The body
should explain the behavior, show trustworthy before/after evidence, and name what has not been
verified.

Preparing the body and screenshots does not authorize a push, review request, or PR mutation. Only
perform those actions when the user has asked to publish or update the PR.

Assume `git`, GitHub CLI, [[yeet]], Node with the `playwright` package and its Chromium build, and
the browser or computer-use MCP are already installed. Use their existing commands and flows. Do not
install substitutes or replace the upload workflow with a different GitHub API or CLI path.

## 1. Authenticate and define the evidence

Invoke [[yeet]] and use its context and preflight checks. Run `gh auth status`. If
the CLI is not authenticated, run `gh auth login`, let the user complete GitHub's browser, SSO,
passkey, or two-factor prompts, then rerun `gh auth status`. Never ask the user to paste a password,
token, or one-time code into chat.

The screenshot upload uses a logged-in GitHub browser session through the installed browser MCP.
Select an existing authenticated GitHub tab when one exists. Otherwise open GitHub's login page and
pause while the user completes authentication. Confirm the PR page loads as the signed-in user
before relying on its file input.

Read the repository's contribution guide, PR template, and release instructions. Use the PR's base
branch, defaulting to `main`, and record the comparison revisions:

```bash
git fetch origin <base-branch>
git rev-parse HEAD
git merge-base HEAD origin/<base-branch>
git rev-parse origin/<base-branch>
```

The merge base is the default Before revision because it isolates the current branch's changes and
matches the PR comparison. Record the fetched base-branch SHA too. If they differ, do not describe
the merge base as the latest base branch; label its exact SHA, and update the branch through the
repository's normal workflow before capture when the review requires the latest base branch.

Identify:

- the exact base revision and proposed head revision;
- each changed visual surface and the state needed to display it;
- behavior and controls that must remain present;
- feature flags, viewport sizes, input modes, or embedded contexts that materially change the UI;
- checks required before publication.

Take the expected behavior from requirements, the base implementation, or an independent test
oracle. Never build the oracle by transcribing what the changed page happens to render.

## 2. Write and publish the draft

Use the repository's PR template when it has one. Otherwise start from
[assets/pr-body-template.md](assets/pr-body-template.md).

Keep the body readable:

- Open with a short summary of the user-visible change and its main boundary.
- Group implementation details by topic under `## Implementation`. Do not narrate the commit or
  review history.
- Name behavior that the change deliberately preserves, especially for a visual-only change.
- Record exact verification commands and results under `## Verification`. Put unverified hardware
  or environment cases in a separate list under a plain "Still to verify:" lead-in.
- Explain how to reach a flag-gated or input-specific path.

Write the body to a temporary Markdown file. Continue the [[yeet]] workflow through its
checks, scoped commit, push, `gh pr create --draft --body-file <file>`, and Copilot request. Keep the
PR in draft. If the PR already has uploaded images, begin with its current body and edit that copy.
Rebuilding the body from an older draft can drop attachment markup.

## 3. Capture comparable images

Render the recorded base revision and current head in separate clean worktrees or checkouts. Install
dependencies in each checkout rather than sharing a dependency directory whose paths can change
asset loading. Do not rely on mutable branch names after recording the SHAs.

Create a repository-specific manifest from [references/manifest.md](references/manifest.md), then
run the bundled runner from this skill's installed copy (Claude Code shown; Codex installs it under
`~/.agents/skills/`, Copilot under `~/.copilot/skills/`):

```bash
node ~/.claude/skills/publish-visual-pr/scripts/smoke.js --manifest /absolute/path/to/visual-proof.json
```

It uses headless Playwright only for capture and reports. It does not log into GitHub, edit a pull
request, or replace the authenticated browser-MCP upload sequence below.

Use the same conditions on both sides:

- viewport, device scale factor, browser, color theme, fonts, and reduced-motion setting;
- frozen clock and seeded application state;
- feature flags, permissions, device capabilities, and active-session state;
- API or network stubs;
- actions, transition waits, scroll position, and crop bounds.

Capture a full viewport image for diagnosis and a focused crop for the PR. Wait for fonts,
animations, scrolling, and DOM replacement to settle before each capture. When an interaction only
exists on the head, mark it as head-only and explain why the base cannot perform it.

Label every pair with short revision identifiers. Use the recorded base revision for Before and the
current branch or PR head for After. Do not substitute a design-reference branch for the Before
side.

## 4. Gate Copilot review with the visual check

Before publishing an image, check:

- unexpected console and page errors;
- loaded font families and weights;
- required controls by accessible role and name;
- pixel changes outside the declared surface;
- identical seeded state and capture settings on both sides.

Keep any console allow-list small and trace each entry to a known offline dependency. A new error,
missing control, font failure, or leaked pixel region is a finding. Investigate it against source
before changing the manifest, crop, expected-control list, or allow-list.

Run this visual check on the draft before Copilot triage. If the head is wrong, fix it and run the
capture again. If another planned PR owns the root cause, name that PR in the body and tracking
record, then recapture once the owner lands. Do not widen the capture rules merely to produce a
green report.

Continue [[yeet]] through Copilot review, triage, accepted fixes, replies, and thread resolution.
Keep the PR in draft. Do not publish the preliminary crops while review fixes can still change the UI.
The head is settled only when the review request is no longer pending, every review body has been
read, every Copilot thread has been answered and resolved, and the head SHA has not changed during
that final check.

## 5. Finalize at the settled head

After Copilot review and its fix rounds settle:

1. Confirm the current head SHA and rerun the visual capture at that head.
2. Use the installed browser MCP to open the draft PR page. Upload the final before/after crops
   through the comment form's "Paste, drop, or click to add files" button: the real file input is
   hidden, so the upload tool needs the visible button. The MCP only accepts files inside its
   workspace roots, so stage the crops under the project first (a gitignored scratch directory).
   Wait until the comment editor holds one `<img>` per file with a `user-attachments` URL and no
   "Uploading" placeholder.
3. Copy the generated image markup, then clear the comment editor without posting it. Retrieve the
   PR's current body, insert a `### Screenshots` section at the end of `## Verification` using
   two-column Before/After tables, and preserve all existing body content and attachment markup.
   Give paired images descriptive alt text and the same displayed dimensions: GitHub fills
   `width`/`height` with device pixels, so a scale-2 crop needs them halved to the CSS size. Update
   the body through `gh pr edit <number> --body-file <file>`.
4. Reload the PR page and confirm every image renders, the labels name the recorded base and settled
   head SHAs, required checks pass, review findings are answered, and no automated-review result is
   unread.
5. Continue [[yeet]] with `gh pr ready <number>`. Recheck the actual review request, reviews, and
   unresolved threads. If no post-ready Copilot pass was requested, use [[yeet]]'s existing manual
   Copilot request and triage that pass before calling the PR finished.

Do not assume that moving a draft to ready triggers an automated review. Check the repository's
actual review request and review state after the transition, and request the review manually when it
did not fire. If the head or the recorded base revision changes after the final capture, rerun
affected checks, recapture changed surfaces, and update the body before merge.
