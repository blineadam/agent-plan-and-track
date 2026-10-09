# Expand and Contract: detail

Read this before sequencing a change whose first edit would break every caller at once (renaming a symbol every caller references, retyping a shared column, changing a signature every call site depends on). SKILL.md carries the three-phase summary; this file carries the mechanics.

Batching and behavior preservation both assume a change can be sliced into batches that each land green on their own. These edits cannot: the first edit breaks every caller at once, leaving no batch boundary that stays green. Sequence them in three phases instead of one edit:

1. Expand: add the new form alongside the old, so both work and nothing breaks.
2. Migrate: move call sites over in batches sized by the existing ownership map (see File Ownership and Parallel Isolation in SKILL.md), each batch validated on its own ladder rungs. The old form stays in place through this phase, which is exactly what lets every batch land green.
3. Contract: once every migrate batch is in and no caller of the old form remains, delete it.

The overlap during the migrate phase is the mechanism, not an untidy side effect to clean up early: keeping both forms live is what buys per-batch validation. Collapsing expand and contract back into a single edit reintroduces the all-at-once break the three phases exist to avoid. Where even one migrate batch genuinely cannot stay green on its own, keep the three-phase sequence but land the migrate batches on a shared integration branch and validate at the integration point.

Which phase the effort is currently in is a resume-critical fact, so record it on the `## Migration State` block's Queue line alongside the open and done batch ids, rather than leaving it to whoever remembers. The values are `expand`, `migrate`, and `contract`, or `n/a` for a migration that needed no expand-contract sequencing at all.
