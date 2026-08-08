---
name: resolving-merge-conflicts
description: "Use when resolving an in-progress merge, rebase, or cherry-pick conflict in the working tree: covers identifying the operation type, researching both sides' intent before choosing, resolving hunk by hunk without inventing new behavior, checking for semantic conflicts that leave no textual marker, running the project's own checks, and finishing rather than aborting the operation. Not for planning or executing a large migration or mechanical rewrite across many files, which is migration-discipline, and not for general task planning."
---

# Resolving Merge Conflicts

1. **Assess the state before touching anything.** Determine whether this is a merge, a rebase, or a cherry-pick, since the finishing move differs. Identify every conflicted path.
2. **Research the intent behind both sides.** Read the commit messages, the PR discussion, and any linked issue for each side before choosing. A conflict is two intentions colliding, and you cannot preserve an intention you have not read.
3. **Resolve hunk by hunk, preserving both intentions where they are compatible.** Where they genuinely conflict, take the side that serves the merge's purpose and record why. The hard rule: never invent new behavior that was in neither side, since a conflict resolution is not the place to slip in a third design.
4. **Check for semantic conflicts with no textual marker.** A rename or a changed contract on one side that the other side still calls produces no conflict marker at all; git has nothing to report there. After the textual conflicts are resolved, check the callers of anything either side changed.
5. **Run the project's own checks afterward.** A conflict resolution can produce code that merges cleanly and compiles while behaving like neither side. Typecheck, tests, and linters are the oracle.
6. **Finish the operation.** Stage and commit for a merge; continue the rebase or cherry-pick until it completes. `git merge --abort`, `git rebase --abort`, `git reset --hard`, and `git checkout .` all discard work; per the standing protect-the-working-tree rule, none of them is the way out of a difficult conflict unless the user explicitly asks for that exact operation.
