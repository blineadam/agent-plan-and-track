# Tag and release

How this repo's GitHub releases get their version number and their notes. Both are decided by hand, not generated: `.github/workflows/release.yml`'s own header documents that releases always carry hand-written notes, and there's no version-consuming artifact (no `package.json`, no installed-version check) to compute a number from.

## Choosing the version

Releases follow semver (`MAJOR.MINOR.PATCH`):

* **PATCH** - a fix or doc/wording cleanup with no new capability and no behavior change an installed user would notice (v2.3.0 -> v2.3.1).
* **MINOR** - a new skill, hook, or capability, or a meaningful addition to an existing one, staying backward compatible (most releases).
* **MAJOR** - a change to how already-installed rules or hooks behave for existing users, something they'd want to know about before reinstalling. v2.0.0 (enforcement parity added across all three harnesses, plus a digest re-architecture) and v3.0.0 (the git-guard blocking hook, a new mechanical check behind the writing-voice rule, eleven rules relocated off the always-on surface) are the precedents.

## Writing the notes

When preparing a GitHub release, review all changes since the previous tag and write concise release notes using this template:

```markdown
## agent-plan-and-track <new-tag>

A 1-2 sentence high level summary of the release.

### What’s new

Focus only on the main user-facing or workflow-level changes. Include new capabilities, meaningful behavior changes, major new skills, and notable documentation or automation changes.

Do not include:

* implementation details
* internal refactors
* fixes made only to support or stabilize a larger feature
* test, lint, installer, parsing, or CI changes unless they are themselves a major feature
* every individual commit or file changed

Combine related work into a single bullet. Each bullet should have a short **bold heading** followed by one or two plain-language sentences explaining what changed and why it matters.

Aim for roughly 3 to 6 bullets. Keep the tone clear, natural, and suitable for GitHub release notes. Avoid marketing language, excessive technical detail, and repeating commit messages.

### Where this is useful

Add a short section describing where the release has already been useful, when the commit history or PR context provides evidence, or where the new capabilities are likely to be useful.

Keep this practical and specific. Focus on the types of projects, workflows, or situations that benefit from the release. Do not invent usage claims or imply that a feature has been used when the repository history does not show that.

Use 1 to 3 short paragraphs or bullets.

End the release notes with:

**Full Changelog**: https://github.com/blineadam/agent-plan-and-track/compare/<previous-tag>...<new-tag>
```

Replace `<previous-tag>` and `<new-tag>` with the actual release tags.

Before publishing, verify that:

* every item represents a distinct high-level change
* lower-level supporting work has been omitted
* the usefulness section does not make unsupported claims
* the changelog comparison URL uses the correct tags
* the drafted notes have been run through the `humanizer` skill, using the most recent previous release's notes as the voice-calibration sample, with any flagged patterns fixed
* the version bump (patch/minor/major) matches the Choosing the version guidance above

Then publish with `gh release create <new-tag> --target <sha> --notes-file <file>`, which mints the tag and the release together in one call, and report the tag and release URL. Don't push the tag separately first: `.github/workflows/release.yml` fires on any `v*.*.*` tag push and fails if no release exists yet for it, by design, so it can't be beaten to a bare tag with a placeholder changelog.
