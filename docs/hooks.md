# Hooks reference

What each hook script does, which harnesses it runs on, and the wiring contract behind it.

## Shared script architecture

`hooks/core-rules-digest.js`, `hooks/gateguard.js`, `hooks/git-guard.js`, and
`hooks/delivery-gate.js` are shared Node scripts, not one fork per harness.
Each handles harness differences at the point where they matter:

- `gateguard.js` sniffs the wire dialect at runtime (`detectDialect`) and
  branches between Copilot's shape and the shared Claude/Codex shape. Its
  payload differs by harness.
- `git-guard.js` sniffs the wire dialect at runtime the same way gateguard
  does, with one extra wrinkle on its Copilot leg: it has to parse `toolArgs`
  as a JSON-encoded string rather than an object.
- `core-rules-digest.js` branches on a `--copilot` argv flag baked into its
  wiring at install time. Copilot needs a 10-minute throttle, tracked via a
  `.core-rules-last` stamp file, plus `{"additionalContext": ...}` JSON
  wrapping. This is why the old inline bash+jq throttle in `core-rules.json`
  is gone.
- `delivery-gate.js` needs no branching because Claude and Codex expose the
  same `Stop` payload contract.

The `hooks/<harness>/*.json` files carry no logic, only a plain
`node "<scripts>/<name>.js"` command with the `__SCRIPTS__` path baked in at
install time. Each uses its harness's hook contract:

- Claude and Codex use a PascalCase `matcher` plus `hooks[].command`.
- Copilot uses `version:1`, `bash`, and `timeoutSec`.

Those keys come from the wire contracts. Do not normalize one shape to match
the other.

All seven Node hook scripts fail open, wrapped in a top-level
`try { main() } catch { ...; process.exit(0) }`. Only `gateguard.js` and
`git-guard.js` need to emit an explicit allow decision because Copilot's
`PreToolUse` is fail-closed. `core-rules-digest.js`, `delivery-gate.js`,
`suggest-compact.js`, `plan-gate.js`, and `plan-gate-pilot.js` simply exit 0
on failure. A hook that produces no output is already a no-op on every
harness.

## core-rules-digest.js

- Hook event: `UserPromptSubmit` on Claude/Codex, `postToolUse` on Copilot.
  Runs on all 3 harnesses.
- Prints the `core-rules.md` plus `core-rules.local.md` digest so the standing
  rules get re-injected mid-session.
- The `--copilot` flag adds the 10-minute throttle via the `.core-rules-last`
  stamp and the `additionalContext` JSON wrapping described above.
- On Claude/Codex it also reads the payload's `prompt` and, when that prompt is
  question-shaped, appends the answer-shape nudge after the digest, backing the
  "answer the question asked" standing rule at the only event that fires before
  the reply is written. Question detection ignores `?` inside fenced blocks and
  inline code. Unreadable stdin, a non-JSON payload, or a missing `prompt` all
  fail open to the digest alone, so the Copilot path (no prompt in a
  `postToolUse` payload) is unaffected. Fixtures:
  `hooks/scripts/run-core-rules-digest-fixtures.js`.
- Locates the digest via `../core-rules.md` relative to itself, so it needs no
  runtime home-directory lookup.

## gateguard.js

- Hook event: `PreToolUse`. Runs on all 3 harnesses.
- On the first edit to a file per session, injects a fact demand covering
  callers, blast radius, and schemas.
- Defaults to a non-blocking warning on Claude and Codex, and a blocking deny
  on Copilot because Copilot's `PreToolUse` has no soft-warn channel.

### Configuration

- `GATEGUARD_WARN=1` selects warn behavior. On Copilot, where there is no true
  warn channel, this becomes allow plus a stderr note.
- `GATEGUARD_DENY=1` restores blocking behavior on Claude and Codex.
- If both variables are set, `GATEGUARD_DENY` wins on every harness.

### Why warn by default on Claude and Codex

The file was marked "checked" at deny time, so a denied-then-retried edit
always passed. The gate could not verify that the demanded facts were ever
presented. A measured A/B found that the deny-and-retry loop cost about 20%
more turns for an identical edit.

## git-guard.js

- Hook event: `PreToolUse`. Runs on all 3 harnesses.
- Gates a closed, named set of destructive git command forms, matched against
  the actual command text rather than gating Bash generally.
- Denies the first occurrence of a blocked kind per session, quoting the
  standing protect-the-working-tree rule; a retry of the same kind then
  passes.

### Why deny-once rather than hard deny or warn

The hook cannot observe whether the user actually asked for the operation, so
it cannot tell a deliberate destructive command from an accidental one.
Hard-denying forever would block a legitimate, intentional use with no way
through. Warning would let an accidental destructive command straight
through. Deny-once forces one conscious re-assertion instead: the same
epistemic position, and the same fix, that `plan-gate.js`'s attribution guard
already uses for its own unverifiable claim.

Four of the five blocked kinds are strictly destructive. `stage-env-file` is
different: it is a disclosure tripwire on an explicitly-named `.env`-pattern
path, not a backstop. `git add .` and `git add -A` are unclosable from
argv, the common accident vector, since the hook sees only the tokens typed,
not what the sweep would actually stage; `.gitignore` plus the standing
never-commit-secrets rule text remain the primary protection, and this hook
is a second check on the narrower explicit-path case, not a substitute for
either. Do not over-trust it as a complete backstop.

### Blocked set

- `reset-hard`: `git reset --hard`.
- `clean-force`: `git clean` with a force flag: `-f`, `--force`, or `-f`
  inside a combined short cluster (`-fd`, `-fdx`, `-xdf`), excluding
  `-n`/`--dry-run` (including `-n` inside a combined short cluster like
  `-fdn`).
- `force-push`: `git push` with `--force`, `-f`, `--force-with-lease`,
  `--force-if-includes`, or `--mirror` (bare, `=value` form, or `-f` inside a
  combined short cluster like `-uf`), or a leading `+` on a refspec argument
  (`git push origin +main`). `--mirror` force-updates every remote ref and
  propagates deletions, a forced rewrite of remote history.
- `discard-worktree`: `git checkout .`, `git checkout -- <path>`,
  `git checkout -f`/`--force` (bare or with a branch), `git switch -f` /
  `--discard-changes`, and `git restore <path>` unless `--staged`/`-S` is
  present without `--worktree`/`-W` (a staged-only restore unstages but never
  touches the worktree).
- `stage-env-file`: `git add` naming a `.env`-pattern file by basename: `.env`
  exactly, or `.env.<suffix>` for any suffix except the conventionally-
  committed template variants (`example`, `sample`, `template`, `dist`,
  `default`, `defaults`), backing the standing never-commit-secrets rule with
  a mechanical check. Scoped to `add` only, not `commit`: see the hook's own
  STAGE-ENV-FILE IS A DISCLOSURE TRIPWIRE header note in `git-guard.js`, and
  the `git commit <pathspec>` entry under Deliberate exclusions below.

`--help`/`-h` on any of the above suppresses the match for that git
invocation. The `git` executable token itself is matched case-insensitively
with an optional `.exe` suffix (`Git`, `GIT`, `git.exe` all match), since this
hook also gates Copilot's `powershell` tool, where those spellings are valid.

### Deliberate exclusions

- Plain `git push`: not destructive, and `yeet` needs it.
- `git push --delete`: removes a named ref rather than rewriting history, so
  it sits outside the closed set this hook's standing rule enumerates.
- `git stash`, `stash pop`, `stash drop`, and `stash clear`: the standing rule
  scopes these by "over work you don't own," which no hook can observe;
  approximating it would risk blocking a session's own stash.
- `git rebase` and `commit --amend`: destructive only against shared history,
  which is also unobservable from the command text, and routine locally.
- `git branch -D`: in upstream's blocked list but not in our rule, and
  reflog-recoverable.
- `git commit <pathspec>` naming a `.env`-pattern file with no prior `git add`
  of that file this session: `stage-env-file` is scoped to `add` only, so a
  bare `commit` naming a path directly is an accepted false negative,
  alongside the `git add .` / `-A` bare-sweep gap below.
- `git restore --staged <path>` (unstages only, worktree untouched) and a
  bare `git checkout <branchname>` / `git checkout -b <name>` (branch
  checkout, not a worktree discard; branch-vs-path ambiguity from the command
  text alone makes this an accepted false negative).
- Indirection such as `bash -c`, `/usr/bin/git`, `env git`, aliases, and
  command substitution: accepted false negatives, matching `plan-gate.js`'s
  documented conservative posture.
- Quote-wrapped flags (`git reset '--hard'`): the tokenizer keeps the quote
  characters as part of the token, so a quoted flag never equals the bare
  token the classifier matches on. `stage-env-file`'s own `add` branch reads
  its pathspecs with a real quote-aware word splitter (`shellWords`) instead,
  which strips quote characters wherever they appear in a word (`git add
  .e"nv"`, `git add config/".env"`, `git add ".env"`, `git add '.env'`, and
  `git add "config dir/.env"` all deny), so this exclusion no longer applies
  there; it still applies to every other kind's flag matching.
- Backslash ambiguity in `stage-env-file`'s own `add` branch: a backslash
  outside single quotes means two different things depending on which shell
  produced the command text, bash's escape-the-next-character rule or
  PowerShell's ordinary path-separator rule, and this hook cannot know which
  one from the command text alone (it gates Copilot's `powershell` tool too,
  see the PowerShell-specific-syntax entry below). `shellWords` takes a
  `backslashEscapes` parameter for this, and the `add` branch reads pathspecs
  under BOTH conventions, matching if either yields a `.env`-pattern
  basename: `git add .\env`, `git add config\.env`, and `git add .\.env` all
  deny under at least one parse. This deliberately over-matches rather than
  under-matches, not chased: a bash command staging a file literally named
  `.\env` (an escaped backslash) also denies. For a secrets tripwire this is
  the correct error direction: an extra deny costs one confirmation, a missed
  one puts a credential in history.
- `git add .` or `git add -A` with no explicit path: the hook sees only argv
  and cannot know what the sweep would actually stage, so it cannot be gated;
  git's own `.gitignore` handling is the real protection there. `git add -f
  .env` IS caught, since the path is explicit.
- An environment-assignment prefix whose value is itself quoted and contains
  a space (`GIT_AUTHOR_NAME="John Doe" git reset --hard`): whitespace token
  splitting breaks the assignment into two tokens before the leading-
  assignment strip runs, so `git` is never seen as the first token.
- The two-token form of an unrecognized git global option
  (`git --git-dir .git reset --hard`, value in a separate token): resolving
  this needs a full global-option table this classifier doesn't carry; the
  self-contained forms (`--git-dir=...`, `--no-pager`, `-C.`) are still
  caught.
- PowerShell-specific syntax: this hook also gates Copilot's `powershell`
  tool but tokenizes every dialect with bash quoting/separator rules, so a
  PowerShell backtick line continuation splits wrong and can let a
  multi-line command escape the gate. The common single-line case is still
  gated correctly.

### Configuration (git-guard.js)

- `GITGUARD_DISABLED=1` turns the gate off entirely.
- `GITGUARD_WARN=1` demotes the gate to warn on Claude and Codex. Copilot has
  no soft-warn channel, so there it degrades to allow plus a stderr note.

### Fail-open guarantee

Like every other Node hook script here, it is wrapped in a top-level
`try { main() } catch { ...; process.exit(0) }`, so any unexpected failure
allows the command through rather than blocking it.

## delivery-gate.js

- Hook event: `Stop`. Claude and Codex only.
- Runs warn-only pre-finish checks backing verify-before-done and
  capture-lesson. It also nudges when recent assistant text pairs an agreement
  opener with self-blame, and when the final message itself carries an em
  dash, an emoji, or a "Let me"/"I'll" opening, backing the writing-voice
  rule. Because a Stop hook fires after the flagged message is already sent,
  that last check only surfaces mid-loop under `DELIVERY_GATE_BLOCK=1`
  (see the hook's own header); in the default warn-only mode it can flag the
  violation but not undo it.

Copilot's `agentStop` exists, but its output contract is block/allow only. The
documented exit-2 stderr warning was observed only in `~/.copilot/logs`, not in
the user-visible output, on headless CLI 1.0.73. The warn-only design does not
port there yet.

## hooks/claude/suggest-compact.js

Claude-only nudge toward `/compact` at logical boundaries.

## hooks/claude/plan-gate.js

- Hook event: `PreToolUse`. Claude only. Codex uses its own disk-delta plan
  stamp and Bash gate (`plan-gate-pilot.js`, below). Copilot has no Skill tool
  and a fail-closed `PreToolUse`, so this hook is not installed there.
- Wired through two `PreToolUse` entries that share a command. One matches
  `Skill|Edit|Write|MultiEdit`; the other matches `Bash` for the mutation gate.

It implements several independent gates in one file:

### Stamp gate

Denies `Edit`/`Write`/`MultiEdit` to `tasks/todo.md` until a `plan-and-track`
Skill invocation stamps the session. The Skill tool call writes the stamp.

### Scope gate

Once a session's distinct edited-file count reaches
`PLANGATE_SCOPE_THRESHOLD` (default `3`) without a stamp, every further
`Edit`/`Write`/`MultiEdit` is denied. This catches a prompt that skips planning
and edits source directly without touching `tasks/todo.md`.

`tasks/todo.md`, `tasks/lessons.md`, and `.claude/settings*.json` are exempt
from the file count.

### Mutation gate

On the `Bash` entry, counts distinct outward git/gh mutation kinds toward
`PLANGATE_MUTATION_THRESHOLD` (default `2`): `git push`, `gh pr create`, and
`gh pr merge`, classified conservatively with quote awareness.

Once a session would cross that count without a stamp, the Bash call is
denied. This catches a PR-shaped task that never touches enough files to trip
the scope gate.

The stamp, scope, and mutation gates share one deny-until-stamped model. Unlike
gateguard's once-per-file gate, a bare retry never passes. Only the
`plan-and-track` stamp unlocks the session.

There is no subagent carve-out. A subagent's tool call shares its parent's
`session_id`, so the same stamp check covers delegated writes.

### Content lint

Once a session is stamped, writes to `tasks/todo.md` are content-linted. A new
unchecked `## Plan` step must carry a trailing owner tag, and `(main)` needs a
colon-separated reason. `PLANGATE_LINT_DISABLED=1` turns off only this lint.

### Migration-state deletion guard

A stamped `tasks/todo.md` write that would delete an existing
`## Migration State` heading is denied once per session, gateguard-style. This
is the durable block that `migration-discipline` keeps in a target project's
todo file. The marker is written at deny time, so an intentional retry passes.

`PLANGATE_LINT_DISABLED` does not cover this guard.

### Attribution guard

A separate guard fires once per session when an unchecked `## Plan` step's
`(main: <reason>)` tag reads as a claim about what the user did or asked rather
than a fact about the work. It also marks at deny time.

Deny-once is deliberate because the attribution may be true and the hook
cannot tell. The point is to force one conscious re-assertion, not to block it
outright.

It inspects steps that are new or whose text changed. A wrapped step carries
its owner tag on a continuation line, which a first-line-only newness test
would miss. The older content lint still looks only at new steps.

Unlike the migration-state guard, `PLANGATE_LINT_DISABLED=1` does cover this
one. It is a phrasing tripwire on a common fingerprint, not a data-loss guard.

## hooks/codex/plan-gate-pilot.js

Installed as `~/.codex/scripts/plan-gate.js`, wired for `apply_patch`
`PreToolUse`/`PostToolUse` plus `Bash` `PreToolUse`.

### Scope tracking

It snapshots declared patch paths, then assesses their disk delta after the
tool runs. It emits one nonblocking `systemMessage` after three distinct
unstamped source paths or a deleted `## Migration State` block.

### Attribution guard (Codex)

Before snapshotting, a narrow exact simulation of single-file structured
`apply_patch` Update File hunks denies once when a new or changed unchecked
`## Plan` step's `(main: <reason>)` tag reads as a claim about what the user
did or asked.

The denial timestamp is stored in the existing session-and-cwd scope record
before the denial completes. Concurrent first calls deny, while an aged,
intentional retry passes.

Multi-file patches, ambiguous context, fuzzy-only or unsupported patch syntax,
unreadable state, and path failures all fail open.
`PLANGATE_LINT_DISABLED=1` disables this attribution check.

### Mutation gate (Codex)

The same session state counts allowed mutation kinds from the closed set
`git push`, `gh pr create`, and `gh pr merge`. The second distinct kind is
denied before execution until the session is stamped. Native `apply_patch`
events stamp from their disk delta. At startup or resume, a `SessionStart` hook
records hashes of the unchecked plan items already on disk, ignoring only the
Markdown list prefix on each first line. If a wrapper hides later patch events,
the Bash gate accepts only a valid unchecked item absent from that baseline,
using the same identity, `verify:`, and owner-tag validation as the native path.

Denied kinds are not recorded, so a bare retry is denied again.

### State handling

It rejects symlinked and outside-cwd paths, while accepting relative or
absolute paths whose canonical parent stays inside the cwd. It retains text
only for `tasks/todo.md`, stores other paths and the SessionStart plan inventory
as hashes, and stops retaining source paths once it warns. Session-and-cwd
scopes are retained so another session cannot prune a live baseline.

Missing or malformed state fails open. Completed transaction state is removed,
and stale transaction state is bounded by pruning.
