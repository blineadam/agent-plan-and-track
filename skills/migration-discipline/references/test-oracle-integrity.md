# Test-Oracle Integrity: detail

Read this before changing tests or fixtures during a migration, setting up the freeze, or when there is no usable suite or the suite is itself part of what's being ported. The rules in SKILL.md's Test-Oracle Integrity section are the summary; this file carries the reasoning and the mechanics.

## Why the suite must stay fixed

A behavior-preserving migration's test suite is only a valid oracle if it stays fixed for the duration of the work. If the same suite is being edited concurrently with the migration itself, a passing run no longer proves behavior was preserved, since either side could be why it passes. Freeze or snapshot the behavior-verification suite for the migration's duration, and when practical, run that same frozen suite against both the old and the new implementation to compare results directly rather than trusting a single pass/fail.

## Expected values must not mirror the new implementation

Freezing the suite assumes the suite itself isn't part of what's being ported. When it is, an expected value can end up recomputed the way the new implementation computes it rather than carried over from somewhere independent, and a test built that way passes by construction: it can never disagree with the code it's supposed to be checking, so a suite full of them reports green on a port that changed behavior. An expected value in a ported test has to trace to something outside the new implementation: the literal the original test asserted, a worked example, the specification, or the old implementation's recorded output. Regenerating a snapshot or fixture from the new implementation to get a failing test to pass is the same mistake in miniature, converting the oracle into a mirror of the implementation.

## Back the freeze with a mechanical rule

The freeze is only as good as attention: nothing stops a worker from editing the suite anyway unless someone happens to notice. Where the harness can deny file edits by path, back it with a mechanical rule instead. Claude Code's `settings.json` accepts a `permissions.deny` list with entries like `Edit(<suite path>/**)` and `Write(<suite path>/**)`; add that deny on the frozen suite's path for the migration's duration, and the same deny on the old implementation's tree when a port is running side by side with it rather than replacing it in place.

The deny covers the file-editing tools plus whichever shell writes the harness's Bash permission analyzer can attribute to a path, and that set changes release by release, so read the current changelog rather than assuming either full or zero coverage. A write the analyzer can't attribute, a script that opens the file itself or an editor invoked through another program, still lands, so Bash keeps its approval prompt for as long as the freeze holds rather than relying on the deny alone. The freeze is the mandate in this skill that a long run is most likely to let slip, so pair it with a mechanical check wherever the harness offers one.

## No usable suite: characterization tests

The freeze also assumes there is a suite to freeze in the first place. When the code being migrated has no usable behavior suite, record the old implementation's observable outputs for a representative set of inputs as characterization tests before the first behavior-preserving batch begins, then freeze that recorded set exactly as it would freeze a suite that already existed. Its expected values trace to the old implementation's recorded output, one of the legitimate sources named above; the fallback doesn't relax that rule, it supplies the suite the rule was assuming was already there.
