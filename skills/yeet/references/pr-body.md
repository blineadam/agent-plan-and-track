# PR body shape

Formatting rules for the body written in step 6 of the yeet skill. The required heading set and the current-state rule stay in SKILL.md; this file covers how to shape the body for a reader skimming it, not for density.

- One idea per paragraph, one to three sentences each, with `Closes #N` alone on its own line. Unpack colon-chained clauses and parenthetical asides into their own sentences, and spell statuses out (`401 Unauthorized`, not "a 401").
- Three or more parallel items become a bulleted list, never clauses packed into one sentence. In the verification section, group related results as nested bullets under one lead-in ("Testing on real hardware confirmed:") and give still-unverified items their own short list under a plain lead-in ("Still to verify:").
- An `## Implementation` covering more than one distinct topic splits into `###` subsections named for the topic (a rebuilt binary, a schema change), so a reader can jump straight to the part they care about. Never a known-limits or review-history subsection; residual risk belongs in the verification section's still-to-verify list.
- Identifiers, filenames, flags, and endpoints ride in backticks; a run of literal technical values (cipher names, config lines) goes in a fenced block; a UI label the reader clicks is bold.
