# Semantic Error Checklist

A change that compiles, typechecks, and looks reasonable can still behave differently from what it replaced. Don't rely on superficial similarity between the old and new APIs, languages, or frameworks. Use this list as a reviewer-brief appendix (see [[migration-discipline]]'s SKILL.md) when reviewing a port, migration, or mechanical rewrite; each item is a category worth checking against the specific diff, not a checklist to tick blindly.

- **Eager versus lazy evaluation**: does the new code evaluate an expression, iterator, or generator at the same point the old code did, or has a lazy sequence become eager (or vice versa) in a way that changes when side effects fire?
- **Evaluation order and side effects**: do argument evaluation order, short-circuiting, and the order of side-effecting statements match the original, especially across a language pair with different evaluation-order guarantees?
- **Numeric rounding and overflow**: do integer division, floating-point rounding, and overflow/wraparound behavior match, especially across languages with different default integer widths or rounding modes?
- **Negative and boundary values**: does the new code handle zero, negative numbers, empty collections, and off-by-one boundaries the same way the old code did?
- **Resource ownership and cleanup**: are files, sockets, locks, and other resources acquired and released on the same paths, including error paths, as the original?
- **Async lifetimes**: do futures, promises, or tasks get awaited, cancelled, or detached the same way, and does the new code avoid dropping a still-running async operation the original relied on completing?
- **Re-entrant callbacks**: if a callback can call back into the same code path (a listener that triggers itself, a recursive handler), does the new implementation still tolerate that the way the old one did?
- **Error and early-return paths**: do all the original's early returns, exceptions, and error branches still exist and still run the same cleanup or fallback logic?
- **Reference invalidation**: can a pointer, iterator, slice, or borrowed reference the new code holds become invalid (through reallocation, resizing, or a move) in a case the old code didn't have to guard against?
- **Concurrency and races**: do shared-state accesses still hold the same locks or synchronization primitives, and does the port introduce a new interleaving the original's concurrency model prevented?
- **Debug versus release behavior**: does the new code depend on debug-only assertions, checked arithmetic, or logging that silently disappears (or changes behavior) in a release build?
- **OS differences**: do file-path handling, line endings, case sensitivity, process/signal handling, and filesystem semantics still match across the platforms the original supported?
- **FFI and library contracts**: when the new code crosses a foreign-function or library boundary, does it honor the same calling convention, memory-ownership contract, and error-signaling convention the original relied on?
