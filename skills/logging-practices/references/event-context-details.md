# Where to log and event shape: details

Read this when the code runs on someone else's machine (browser, mobile or desktop client, an installed CLI), when work crosses a boundary inside or between processes (queues, detached tasks, background promises, worker callbacks, executors), or when one log sink is written by several entry points. SKILL.md sections 3 and 4 carry the rules in short form; this file carries the full text.

## Wide summary event: version field

When the process has no version to report, plumbing a build identifier such as a commit SHA or an image tag through to the entry point is usually a one-line change and worth making; where it truly is not available, leave the field out and say so, rather than stamping a placeholder that a reader will believe.

## Client-side code

Code running on someone else's machine (a browser page, a mobile or desktop client, a CLI the user installed) logs to its own console and stops there. The same event shape and the same safety rules apply, more strictly if anything, since the user and everything else on that machine can read every line. Shipping those lines back to a server is a separate feature carrying its own endpoint, abuse surface, retention period, and consent question, so propose it as its own change rather than folding it into the one in front of you. Until it exists, the client's retries and fallbacks are invisible from the server, which makes it the server's job to log every boundary the client crosses on the way in: the refused upload, the re-issued URL, the session that never completed.

## Correlation ID and entry point

A correlation ID is created or accepted where the work starts and attached to every line of that unit of work, plus the entry point that started it. When one log sink is written by several entry points (a scheduler, a replay endpoint, a manual CLI run), the correlation ID alone does not say which path produced a line. Stamp the entry point next to the ID and carry both across every boundary the ID crosses, such as queue metadata or request headers.

The boundary most often dropped is the one inside the process: work that outlives the response that started it, a detached task, a background promise, a worker callback, where nothing in the signature forces the ID through. Carry it with the runtime's own context mechanism rather than threading a parameter down every intervening function, which is the version that gets dropped at the first call site someone forgets to update. Check what that mechanism does at the handoff itself: Node's `AsyncLocalStorage` and Python's `contextvars` follow the work across it, while a JVM MDC is thread-local and does not, so an executor or worker handoff needs the map captured and restored around it, or a context-propagating executor. Prove it by reading a line emitted on the far side of the boundary and confirming the ID is on it.
