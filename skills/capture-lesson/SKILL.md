---
name: capture-lesson
description: Record a lesson in the active project's .tasks/lessons.md, or route a project-level correction to a git-tracked instruction file with approval, after the user corrects a mistake, rejects an approach, points out something missed, or gives feedback on how to work, or when you catch yourself or a subagent repeating a mistake without any user correction. Use IMMEDIATELY after ANY correction from the user; the goal is to never repeat the same mistake twice. Not for a question or displeasure with no established mistake, which calls for re-deriving rather than recording.
---

# Capture Lesson

## When this fires

Any time the user corrects course: a rejected approach, a bug you introduced, a misunderstood requirement, a workflow preference you violated. Don't wait to be asked: capture it as part of handling the correction.

A question, or displeasure without an established mistake, is not a correction: if no mistake is actually on record, re-derive from the artifact instead of recording (and internalizing) a lesson that never happened.

It also fires without a user correction: the second time you or a subagent you dispatched makes the same mistake, stop treating it as a one-off. Record it, and fix the durable process that produced it (the brief template, the plan step, a lint or check), not just the latest output.

## Steps

1. Migrate a legacy scratch folder first, once: if `.tasks/` does not exist and `tasks/todo.md` or `tasks/lessons.md` does, run `mkdir -p .tasks`, then `mv tasks/todo.md .tasks/todo.md` and `mv tasks/lessons.md .tasks/lessons.md` (skipping whichever is absent, and leaving in place any that git tracks, checked with `git ls-files --error-unmatch <path>`, since a tracked file is the project's own rather than scratch), and report in one line what is still in `tasks/` so the user decides whether to move, delete, or keep the rest as the project's own folder. Never rename or delete `tasks/` itself. Once `.tasks/` exists, do not inspect `tasks/` again. Open (or create) `.tasks/lessons.md` in the active project.
2. Read the full index before writing. If an applicable standing rule or skill already fully encodes the correction, do not add a local lesson.
3. Route the lesson before writing it. Run `git rev-parse --is-inside-work-tree`. Outside a repo, or when the correction is about how you work (a verification you skipped, a scope you overran, a preference of this user), the local index is the home and this step is done. Inside a repo, a correction that any contributor or agent would need without ever having seen this conversation (a command that must be run a particular way, a tooling quirk, a constraint, a decision) is a project fact, not a personal lesson, and belongs in a file the project ships. Pick the narrowest tracked home, confirming each candidate with `git ls-files --error-unmatch <path>` rather than by its presence, since an ignored `CLAUDE.local.md` is local too: a code-shape convention (naming, file anatomy, error handling, where things live) goes to `.ai-style-rules.md` through [[inherit-legacy-style]]'s incremental update, never a hand edit; any other project fact goes to the tracked agent instructions file (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, choosing the one that carries the content over a stub that only includes it) or to a decision record the project already keeps. A tracked file is shared config: present the target and the drafted line, and write it only on the user's approval. Declined, or no tracked home exists: record it in the local index and say so in one line; never create a new checked-in file for a single lesson. One home per lesson, never both. A local bullet that later proves to be a project fact (it recurs, or a second agent trips on it) is promoted the same way at the next capture: moved, not copied.
4. If a matching bullet exists, strengthen it in place. Otherwise, when the home is the local index, insert exactly one concise, checkable imperative bullet under the closest topical H2, creating one topical H2 only when none fits. Scope it to the correction actually covered: a correction about one file, register, or situation becomes a global rule only when the user says so or the same mistake recurs elsewhere. Preserve a narrower scope unless the correction itself broadens it. Over-generalizing a scoped correction is itself a mistake the user then has to correct.
5. Do not add dates, incident-field labels, duplicate lessons, unrelated rewrites, or periodic compaction. Normalize each capture when you write it; this index holds durable rules, not incident narratives.
6. If the resulting fix is systemic (a rule, template, or check that addresses a class of problem at its source), re-verify every previously flagged instance of the problem too: a class-level fix doesn't prove each instance actually got fixed.

## At session start

When beginning work in a project, if `.tasks/` does not exist, apply step 1's migration first; then read `.tasks/lessons.md` if it exists and apply the relevant rules.
