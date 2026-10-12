#!/usr/bin/env node
/**
 * Plan Gate: plan-and-track enforcement for .tasks/todo.md (Claude Code only)
 *
 * A PreToolUse hook (registered for Skill|Edit|Write|MultiEdit) that denies
 * every Edit/Write/MultiEdit to `.tasks/todo.md` until the plan-and-track
 * Skill has been invoked this session. A plan written straight into
 * .tasks/todo.md skips the skill's reconcile/lessons/checklist steps, and
 * attention-based fixes (description wording, digest lines) don't reach
 * mid-session self-initiated planning, so per this repo's thesis the rule is
 * enforced by the harness: a Skill call naming plan-and-track stamps the
 * session; edits to .tasks/todo.md check for the stamp.
 *
 * UNLIKE GATEGUARD, REPEATED DENIAL IS INTENTIONAL. Gateguard marks a file
 * "checked" at deny time so the retry always passes; this gate denies every
 * todo.md write until the external unlock (the Skill invocation). The two
 * gates never double-fire: gateguard exempts .tasks/todo.md.
 *
 * CLAUDE-ONLY. Codex loads skills as instructions, so there is no Skill tool
 * event to stamp from and a hard block could never unlock; Copilot has no
 * Skill tool either and its PreToolUse is fail-closed. Those harnesses get
 * the portable skill plus the digest line instead (the same portable-skill +
 * Claude-only-hook split as suggest-compact.js), so no dialect branching.
 *
 * NO SUBAGENT CARVE-OUT: a subagent's tool call carries the same session_id
 * as its parent (verified empirically), so the stamp check resolves to the
 * same file either way. Exempting subagents (gateguard's precedent) would
 * let the main session dodge the gate entirely by delegating the todo.md
 * write to an executor/mechanic before ever invoking the Skill. Most roster
 * tiers have no Skill tool, though, so a deny inside a subagent (the same
 * four-field isSubagent() test gateguard uses) adds a line telling it to stop and
 * report the missing stamp to its caller rather than route around the gate,
 * instead of only inviting it to invoke a tool it may not have.
 *
 * FAIL OPEN everywhere else: malformed stdin exits 0, and if the state dir
 * can't be created the edit is ALLOWED with a stderr note, since the Skill
 * branch could never stamp on such a machine and a deny would loop forever.
 *
 * SCOPE GATE: a session that never touches .tasks/todo.md at all still needs
 * catching (a competing-pressure prompt like "just hack it in" can skip
 * planning and go straight to source edits). Once a session's distinct
 * edited-file count reaches PLANGATE_SCOPE_THRESHOLD (default 3, since a
 * one- or two-file fix-plus-its-test is legitimately plan-free) without a
 * plan-and-track stamp, every further Edit/Write/MultiEdit is denied the
 * same hard way as the .tasks/todo.md gate. "3+ distinct files" is the
 * observable proxy for the "3+ steps" core rule a hook can actually measure.
 * Marker files record each *allowed* edit's normalized path (sha256-keyed,
 * next to the session's stamp file) so a denied edit is never counted and
 * repeated denials can't inflate the total.
 *
 * The same count covers files written or removed through Bash, on the Bash
 * entry, so a heredoc `cat > f` is not a side door (the 2026-09-04 executor
 * used one). Counted, from literal operands only: redirect targets (`>`, `>>`,
 * `N>`, attached `>f`, `>&f`, `>|f`), `tee` operands, the files of an in-place
 * `sed`/`perl`, the `cp`/`install` destination (or `-t DIR`), every `mv`
 * operand, `rm`/`unlink`/`truncate` operands, and a string-literal path handed
 * to a write API (`open(p, 'w')`, `Path(p).write_text`, `writeFile`/
 * `appendFile`, `File.write`) in an interpreter's own program text: the -c/-e
 * argument of a python/node/ruby/perl command, or a heredoc body opened on
 * that command's line (a plain `cat > f <<EOF` body is data and is not
 * scanned). Targets resolve
 * against the hook's cwd (`~/` expands, backslashes flip) and dedupe with the
 * edit tools by absolute path, so Bash plus Write of one file counts once.
 * Never counted: read-only commands, `touch`, `mkdir`, fd dups (`2>&1`,
 * `>&2`), /dev/*, any target containing `$` or a backtick (unresolvable), and
 * temp paths (os.tmpdir(), /tmp, /private/tmp, /var/tmp) outside the cwd; a
 * project that itself lives under a temp dir is still gated. The Edit branch
 * has no temp exemption. A call that crosses the scope threshold is denied
 * with the "command" wording and records nothing; when it also crosses the
 * mutation threshold, the scope deny is the one JSON emitted.
 * ACCEPTED FALSE NEGATIVES (a regex classifier, same class as the todo.md
 * shell-write guard): a script file whose body is not in the command
 * (`python gen.py`, npm scripts, codegen, formatters), `git apply`/`checkout`/
 * `restore`/`stash`, `patch`, dynamic paths, command substitution and `eval`,
 * a `cd` before a relative write (resolved against the session cwd instead),
 * aliases, full-path binaries other than an interpreter (`/bin/rm`), and a
 * heredoc nested inside another heredoc's data.
 * No Codex mirror: plan-gate-pilot.js's scope tracker is a once-per-session
 * nonblocking warning fed by apply_patch disk deltas, with no per-call count
 * for a Bash write to join.
 *
 * MUTATION GATE: the scope gate's blind spot is a PR-shaped task that never
 * touches 3 distinct files (e.g. "push this branch, open a PR, merge it")
 * but still runs an outward, hard-to-reverse git/gh mutation without ever
 * having planned. A Bash call is classified by detectOutwardMutations() into
 * a subset of {git-push, gh-pr-create, gh-pr-merge} (conservative: a
 * full-path invocation, `env git`, or a shell alias is an accepted false
 * negative, not chased). Once a session's distinct mutation-kind count would
 * reach PLANGATE_MUTATION_THRESHOLD (default 2) without a stamp, that Bash
 * call is denied the same hard way as .tasks/todo.md and the scope gate above
 * (deny-until-stamped, not gateguard's deny-once: a bare retry of the same
 * command is denied again); only the plan-and-track stamp unlocks.
 * CLAUDE-ONLY for this file, same portable-skill + Claude-only-hook split as
 * the rest of it: plan-gate-pilot.js carries its own Bash PreToolUse mutation
 * gate on Codex, and Copilot has no Skill tool or comparable PreToolUse hook
 * wired here.
 *
 * CONTENT LINT: once a session is stamped, .tasks/todo.md writes still get a
 * lighter check: every NEW unchecked step inside a `## Plan` section (not
 * Review/Context/preamble) must end in an owner tag, e.g. `(executor)`,
 * `(researcher)`, `(mechanic)`, or a reasoned `(main: <why>)`; a bare `(main)`
 * or no tag at all is denied with a message the retry can self-correct from.
 * Legacy untagged steps already on disk, and Review-section or non-Plan
 * text, are never linted; only a step whose checkbox line is absent from the
 * on-disk baseline counts as new. Runs only after the stamp check passes, via
 * maybeLintTodoContent().
 *
 * REVIEW GOAL-LINE LINT: also once stamped, a .tasks/todo.md write that adds
 * a Review heading (H2/H3) to a `Batch N` block, where the on-disk baseline
 * block had none or the batch is new to the file, must carry `Goal met: yes`
 * or `Goal met: partial: <non-empty gap>` between that heading and the end
 * of the batch block, backing plan-and-track's closeout goal check. Denied
 * until the line is present, like the tag lint: no once-marker, the retry
 * self-corrects. Reviews already on disk, including legacy ones without the
 * line, are never linted, and a Review under no `Batch N` heading is never
 * seen (same block parsing as the in-flight batch warning below). Runs after
 * the tag lint, via maybeLintReviewGoalLine(); PLANGATE_LINT_DISABLED turns
 * it off. No Codex counterpart: plan-gate-pilot.js has no todo content lint.
 *
 * MIGRATION-STATE GUARD: also once stamped, a .tasks/todo.md write that would
 * delete an existing `## Migration State` heading (the durable cross-session
 * block the migration-discipline skill keeps there) is denied once
 * per session, gateguard-style: the marker is written at deny time so an
 * intentional retry always passes (a concurrent write racing that first
 * deny is denied too, via marker age, not mistaken for the retry).
 * PLANGATE_LINT_DISABLED does not turn this
 * off (it is a data-loss guard, not a formatting lint); PLANGATE_DISABLED
 * does, and PLANGATE_WARN demotes it like every other deny here.
 *
 * IN-FLIGHT BATCH WARNING: also once stamped, a .tasks/todo.md write that
 * removes a `Batch N` heading whose baseline block is not closed out (no
 * fully checked plan, or no Review section) gets a non-blocking warning, since
 * several sessions can share the file and that batch may be another session's
 * unfinished work. WARN-ONLY by design and with no ownership tracking: the
 * hook cannot tell whose batch it is, so it also warns on a session dropping
 * its own unfinished batch. Fires every time (no once-marker; the message
 * tells the writer to restore the batch, and a deliberate drop is cheap to
 * repeat). Like the migration-state guard, PLANGATE_LINT_DISABLED does not
 * turn it off (a data-loss signal, not a formatting lint); PLANGATE_DISABLED
 * does. Emitted only when no guard or lint above/below emitted a decision
 * (a hook run may emit at most one JSON), and fails open on any error.
 *
 * MAIN-ATTRIBUTION GUARD: also once stamped, a new `(main: <reason>)` tag
 * whose reason attributes an action to the user (e.g. "user disabled
 * subagent delegation this session") rather than stating a fact about the
 * work is denied once per session, same mark-at-deny-time pattern as the
 * migration-state guard above: an intentional retry (the user genuinely did
 * ask/confirm/decide it) passes. This is a phrasing tripwire on one common
 * fingerprint, not proof the reason is false, so unlike the migration-state
 * guard, PLANGATE_LINT_DISABLED does turn it off, alongside the tag lint
 * below. Runs after the migration-state guard and before the tag lint (a
 * hook run emits at most one decision JSON).
 *
 * TODO.MD SHELL-WRITE GUARD: the todo.md lints above only see Edit/Write/
 * MultiEdit, so a Bash call that rewrites the file (a redirect, `tee`,
 * `sed -i`, `mv`/`cp`/`install` onto it, `truncate`, or an inline
 * python/node/ruby/perl script that names the path and calls a write API) or
 * removes it (`rm`/`unlink`, `mv` away, or `rm`/`mv` of the `.tasks`
 * directory) skips every one of them. The one allowed shell write is
 * plan-and-track's legacy migration, `mv tasks/todo.md .tasks/todo.md` onto a
 * todo.md that does not exist yet (a `cd` earlier in the command or no hook
 * cwd for a relative path counts as existing). On the Bash entry, such a command is denied with a
 * message telling the caller to make the same change with the Edit/Write
 * tool. Stamped or unstamped, it REPEATS ON EVERY ATTEMPT (no once-marker;
 * the unlock is switching tools, not a session event), so a bare retry of the
 * same command is denied again. It scans the raw command text, not
 * splitShellSegments (which strips heredoc bodies, where an inline script
 * keeps its write). Read-only uses (cat, grep, sed -n, head, tail, wc, git
 * diff, an interpreter that only reads, a redirect onto a different file)
 * pass. ACCEPTED GAPS: a path built dynamically (variables, concatenation,
 * `cd .tasks` then a bare `todo.md`) and a script file whose body is not in
 * the command are not seen. PLANGATE_DISABLED turns it off and PLANGATE_WARN
 * demotes it to a warning; PLANGATE_LINT_DISABLED does NOT turn it off (it
 * would also unprotect the Migration State data-loss guard). Runs before the
 * mutation gate's early exit. Appends the subagent line like the other
 * denies and fails open on any error. No Codex counterpart: plan-gate-pilot.js
 * has no todo.md content lints.
 *
 * Config (env):
 *   PLANGATE_DISABLED        "1" turns the gate off entirely.
 *   PLANGATE_WARN            "1" demotes deny to a non-blocking warning
 *                             (including the todo.md shell-write guard).
 *   PLANGATE_SCOPE_THRESHOLD distinct-file count that trips the scope gate
 *                             (default 3).
 *   PLANGATE_MUTATION_THRESHOLD distinct-outward-mutation-kind count that
 *                             trips the mutation gate (default 2). Only 3
 *                             kinds exist (git-push, gh-pr-create,
 *                             gh-pr-merge), so a value above 3 effectively
 *                             disables this gate.
 *   PLANGATE_LINT_DISABLED   "1" turns off the .tasks/todo.md content lints
 *                             (owner tags, Review goal line) and the
 *                             main-attribution guard only (stamp gate, scope
 *                             gate, mutation gate, the migration-state
 *                             guard, the in-flight batch warning, and the
 *                             todo.md shell-write guard still apply).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.tmpdir(), 'claude-plan-gate');
const STALE_MS = 24 * 60 * 60 * 1000; // prune stamps older than a day
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// --- Per-session stamp: one empty file per session key ---

// Session-key derivation byte-identical to gateguard's sessionDir(): a
// sanitized session_id, else a hash of the transcript path / cwd. Both the
// Skill branch (stamp) and the edit branch (check) derive through this one
// helper, so they can never disagree on the key.
function stampPath(sessionId, input) {
  const sid = String(sessionId || '').trim();
  const key = /^[a-zA-Z0-9_-]{1,64}$/.test(sid)
    ? sid
    : 'k' +
      crypto
        .createHash('sha256')
        .update(String((input && input.transcript_path) || (input && input.cwd) || process.cwd()))
        .digest('hex')
        .slice(0, 24);
  return path.join(STATE_DIR, key);
}

function pruneStaleState() {
  try {
    const now = Date.now();
    for (const d of fs.readdirSync(STATE_DIR)) {
      const dp = path.join(STATE_DIR, d);
      try {
        if (now - fs.statSync(dp).mtimeMs > STALE_MS) fs.rmSync(dp, { recursive: true, force: true });
      } catch {
        /* stamp vanished between readdir and stat/rm */
      }
    }
  } catch {
    /* no state dir yet */
  }
}

// --- Skill-call recognition ---

// Does this Skill call name plan-and-track? Exact match against the field the
// Skill tool actually populates (`skill`), same convention the repo's own
// trace parser uses (skills/skill-activation/scripts/run-activation-cases.js,
// which reads only input.skill/input.name/arguments.skill). A substring or
// whole-object scan would stamp on an unrelated Skill call that merely
// mentions plan-and-track in a prompt or argument string.
function namesPlanAndTrack(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return false;
  if (toolInput.skill === 'plan-and-track') return true;
  if (toolInput.name === 'plan-and-track') return true;
  return !!(toolInput.arguments && toolInput.arguments.skill === 'plan-and-track');
}

// --- Scope gate: distinct edited-file count, same stamp, sibling markers ---

// Paths the scope count ignores: .tasks/todo.md (already gated on its own),
// .tasks/lessons.md and .claude/settings*.json (rule-forced/hook-repair
// edits, mirroring gateguard's isBuiltinExempt). Case-insensitive: NTFS
// treats these paths case-insensitively, same rationale as the todo.md gate.
function isScopeExempt(norm) {
  return (
    /(^|\/)\.tasks\/(todo|lessons)\.md$/i.test(norm) ||
    /(^|\/)\.claude\/settings(?:\.[^/]+)?\.json$/i.test(norm)
  );
}

function filesDir(sessionId, input) {
  return stampPath(sessionId, input) + '.files';
}

function fileMarkerPath(sessionId, input, norm) {
  // Lowercased: NTFS (and case-insensitive-by-default APFS) treat differently
  // cased paths as the same file; hashing the raw case would let a session
  // double-count C:/repo/a.js and c:/repo/A.js as two distinct files.
  const hash = crypto.createHash('sha256').update(norm.toLowerCase()).digest('hex').slice(0, 32);
  return path.join(filesDir(sessionId, input), hash);
}

function distinctFileCount(sessionId, input) {
  try {
    return fs.readdirSync(filesDir(sessionId, input)).length;
  } catch {
    return 0;
  }
}

// Validated PLANGATE_SCOPE_THRESHOLD: a positive integer, else the default.
// Same shape as intEnv in gateguard.js/delivery-gate.js, but with a floor of
// 1 (0 would deny before any file is ever edited, which isn't a threshold).
function scopeThreshold() {
  const raw = process.env.PLANGATE_SCOPE_THRESHOLD;
  if (raw === undefined || raw === '') return 3;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? n : 3;
}

// Serialize the count-check-write critical section per session: Claude can
// issue multiple Edit/Write tool calls whose PreToolUse hooks run
// concurrently, and a plain read-count-then-decide has a TOCTOU window where
// two racing edits each see a stale count and both cross the threshold
// unblocked. Exclusive lockfile creation is atomic at the OS level, so at
// most one PreToolUse invocation per session runs the section at a time.
// Bounded spin-wait with Atomics.wait (a real blocking sleep, not a busy
// spin); on timeout or any lock error, fail open and run unlocked rather
// than deny or hang, consistent with this file's fail-open philosophy.
function withSessionLock(sessionId, input, fn) {
  const lockPath = stampPath(sessionId, input) + '.lock';
  const deadline = Date.now() + 1000;
  let fd = null;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    for (;;) {
      try {
        fd = fs.openSync(lockPath, 'wx');
        break;
      } catch (err) {
        if (!err || err.code !== 'EEXIST') break; // unexpected error: run unlocked
        try {
          // Reclaim a lock abandoned by a crashed hook process instead of
          // waiting out the full deadline on every subsequent call.
          if (Date.now() - fs.statSync(lockPath).mtimeMs > 5000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          /* lock vanished between the failed open and this stat; retry */
        }
        if (Date.now() >= deadline) break;
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        } catch {
          /* Atomics.wait unavailable: retry immediately instead of sleeping */
        }
      }
    }
  } catch {
    /* STATE_DIR unwritable: run unlocked, same as everywhere else in this file */
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
        fs.unlinkSync(lockPath);
      } catch {
        /* best effort release */
      }
    }
  }
}

// --- Mutation gate: outward git/gh mutation counting ---

// Quote-aware split of a Bash command into command-position segments, with
// shell comments and heredoc bodies removed in the same pass so neither a
// `# ...` comment nor a `<<EOF ... EOF` body (e.g. a PR description piped to
// `gh pr create`) is ever classified. Comment, heredoc, and separator
// recognition all happen ONLY in unquoted context: a `#`, a `<<`, or a `;`
// inside quotes is literal text, not shell syntax. That is what keeps
// `git commit -m "then git push"` from splitting and `echo "text <<EOF"`
// from swallowing a real following command.
//
// Command substitutions (`$(...)`, backticks) and subshells (`(...)`) are
// deliberately NOT descended into: a mutation buried in one (`echo $(git
// push)`) is an accepted false negative, the same class as `env git push`,
// `/usr/bin/git push`, or an aliased `git`. The backstop targets the plain
// `git push` / `gh pr ...` forms a session actually uses to ship, not exotic
// nesting.
function splitShellSegments(command) {
  const text = String(command || '');
  const n = text.length;
  const segments = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  const pendingHeredocs = []; // delimiters whose bodies follow the current line
  let i = 0;

  while (i < n) {
    const ch = text[i];

    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < n) {
        current += ch + text[i + 1];
        i += 2;
        continue;
      }
      current += ch;
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }

    // Unquoted context below.
    if (ch === '\\' && i + 1 < n) {
      current += ch + text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      i += 1;
      continue;
    }

    // A `#` at a word boundary starts a comment that runs to end of line.
    if (ch === '#' && (current === '' || /\s/.test(current[current.length - 1]))) {
      while (i < n && text[i] !== '\n') i += 1;
      continue; // leave the '\n' for the separator branch to close the segment
    }

    // Heredoc operator `<<` or `<<-` (not `<<<`, a here-string): record the
    // delimiter (quoted 'X'/"X" or a bare word) and skip its body once the
    // command line ends. Multiple heredocs on one line strip in order.
    if (ch === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      let j = i + 2;
      let stripTabs = false;
      if (text[j] === '-') {
        stripTabs = true;
        j += 1;
      }
      while (j < n && (text[j] === ' ' || text[j] === '\t')) j += 1;
      let word = '';
      if (text[j] === "'" || text[j] === '"') {
        const quote = text[j];
        j += 1;
        while (j < n && text[j] !== quote) {
          word += text[j];
          j += 1;
        }
        if (j < n) j += 1; // consume the closing quote
      } else {
        while (j < n && !/[\s;&|<>()]/.test(text[j])) {
          word += text[j];
          j += 1;
        }
      }
      if (word) {
        pendingHeredocs.push({ word, stripTabs });
        i = j; // consumed the operator + delimiter; keep scanning this line
        continue;
      }
      current += ch; // no delimiter parsed: treat `<` as ordinary text
      i += 1;
      continue;
    }

    if (ch === '\n') {
      segments.push(current);
      current = '';
      i += 1;
      // Drop the bodies of any heredocs this line opened, in order.
      while (pendingHeredocs.length && i < n) {
        const { word, stripTabs } = pendingHeredocs.shift();
        for (;;) {
          let lineEnd = text.indexOf('\n', i);
          const atEnd = lineEnd === -1;
          if (atEnd) lineEnd = n;
          const line = text.slice(i, lineEnd);
          const compare = stripTabs ? line.replace(/^\t+/, '') : line;
          i = atEnd ? n : lineEnd + 1;
          if (compare === word || atEnd) break;
        }
      }
      continue;
    }

    if (ch === ';' || ch === '&' || ch === '|') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }
  segments.push(current);
  return segments;
}

// Classifies one Bash command into the (closed) set of outward, hard-to-
// reverse git/gh mutations it contains: a subset of {git-push,
// gh-pr-create, gh-pr-merge}. Conservative by design: a full-path
// invocation (`/usr/bin/git`), `env git`, or a shell alias is an accepted
// false negative, not chased.
function detectOutwardMutations(command) {
  const kinds = new Set();
  for (const rawSegment of splitShellSegments(command)) {
    const trimmed = rawSegment.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    // Leading VAR=value assignments and a leading literal `command` never
    // change which program actually runs.
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
    if (tokens[0] === 'command') tokens.shift();
    if (!tokens.length) continue;

    if (tokens[0] === 'git') {
      let i = 1;
      // Skip git global options that precede the subcommand: `-C <arg>`/
      // `-c <arg>` each consume the next token; `--git-dir=...`/`-C=...`
      // are self-contained.
      while (i < tokens.length) {
        const t = tokens[i];
        if (t === '-C' || t === '-c') {
          i += 2;
          continue;
        }
        if (/^(--git-dir=|-C=)/.test(t)) {
          i += 1;
          continue;
        }
        break;
      }
      if (tokens[i] === 'push') {
        const excluded = tokens.some((t) => t === '--help' || t === '-h' || t === '--dry-run' || t === '-n');
        if (!excluded) kinds.add('git-push');
      }
    } else if (tokens[0] === 'gh') {
      let i = 1;
      // Skip `-R <arg>`/`--repo <arg>`, the gh equivalent of git's -C.
      while (i < tokens.length) {
        const t = tokens[i];
        if (t === '-R' || t === '--repo') {
          i += 2;
          continue;
        }
        break;
      }
      const excluded = tokens.some((t) => t === '--help' || t === '--dry-run');
      if (!excluded) {
        const remaining = tokens.slice(i).filter((t) => !/^-/.test(t));
        if (remaining[0] === 'pr' && remaining[1] === 'create') kinds.add('gh-pr-create');
        if (remaining[0] === 'pr' && remaining[1] === 'merge') kinds.add('gh-pr-merge');
      }
    }
  }
  return kinds;
}

// Validated PLANGATE_MUTATION_THRESHOLD: same shape as scopeThreshold(), a
// positive integer floored at 1, else the default.
function mutationThreshold() {
  const raw = process.env.PLANGATE_MUTATION_THRESHOLD;
  if (raw === undefined || raw === '') return 2;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? n : 2;
}

function mutationsDir(sessionId, input) {
  return stampPath(sessionId, input) + '.mutations';
}

// No hashing needed here (unlike fileMarkerPath): the kind set is closed and
// small ({git-push, gh-pr-create, gh-pr-merge}), so the literal kind string
// is already a safe filename.
function mutationMarkerPath(sessionId, input, kind) {
  return path.join(mutationsDir(sessionId, input), kind);
}

function distinctMutationCount(sessionId, input) {
  try {
    return fs.readdirSync(mutationsDir(sessionId, input)).length;
  } catch {
    return 0;
  }
}

// --- Content lint: todo-step owner tags ---

// Hardcoded rather than parsed from skills/efficient-frontier/SKILL.md (that
// file is the human source of truth) at runtime: the repo checkout and the
// installed layout disagree on relative paths, so there's no one path this
// script could rely on to find it.
const ROSTER = ['planner', 'executor', 'researcher', 'mechanic', 'debugger', 'security-auditor', 'architect-reviewer', 'fable-advisor'];
const TIER_TAG_RE = new RegExp('\\((?:' + ROSTER.join('|') + ')(?::[^)]*)?\\)\\s*$', 'i');
const MAIN_OK_RE = /\(main:\s*[^)\s][^)]*\)\s*$/i; // (main: <non-empty reason>)
const MAIN_ANY_RE = /\(main(?::[^)]*)?\)\s*$/i; // any main tag, incl. bare/empty-reason

// Same anchored shape as MAIN_OK_RE, but capturing the reason text so the
// attribution check below inspects only what's inside the tag, never the
// step's surrounding prose.
const MAIN_REASON_RE = /\(main:\s*([^)\s][^)]*)\)\s*$/i;

// Tripwire for one common fingerprint: a (main: ...) reason that asserts the
// user did or expressed something ("user disabled subagent delegation this
// session") rather than stating a fact about the work. Subject (user/you),
// up to two intervening words (e.g. "the user explicitly asked"), then one
// of these verbs. Deliberately NOT exhaustive: this catches one common
// phrasing shape, not every way a reason could misattribute agency to the
// user, so a miss here isn't evidence the reason is fine.
const MAIN_USER_ATTRIBUTION_RE =
  /\b(?:user|you)\b(?:\s+\S+){0,2}\s+(?:disabled|enabled|turned on|turned off|asked|said|told|chose|requested|wanted|wants|approved|confirmed|authorized|declined|rejected|prefers|preferred|specified)\b/i;

// Simulates the post-edit .tasks/todo.md content for Edit/Write/MultiEdit
// without writing anything to disk. Returns null (skip the lint entirely) on
// anything that would make the simulation a guess rather than exact: an
// unreadable existing file, an old_string that's empty or not found in the
// text it's applied against, or a tool this hook doesn't otherwise handle.
function simulateResult(toolName, toolInput) {
  const filePath = String((toolInput && toolInput.file_path) || '');
  let baseline = '';
  if (fs.existsSync(filePath)) {
    try {
      baseline = fs.readFileSync(filePath, 'utf8');
    } catch {
      return null; // unreadable: fail open on the lint
    }
  }

  if (toolName === 'Write') {
    return { baseline, result: String((toolInput && toolInput.content) || '') };
  }

  function applyOne(text, oldStr, newStr, replaceAll) {
    if (!oldStr) return null;
    if (replaceAll) {
      if (!text.includes(oldStr)) return null;
      return text.split(oldStr).join(String(newStr || ''));
    }
    const idx = text.indexOf(oldStr);
    if (idx === -1) return null;
    return text.slice(0, idx) + String(newStr || '') + text.slice(idx + oldStr.length);
  }

  if (toolName === 'Edit') {
    const result = applyOne(baseline, toolInput.old_string, toolInput.new_string, toolInput.replace_all);
    return result === null ? null : { baseline, result };
  }

  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    let result = baseline;
    for (const edit of edits) {
      result = applyOne(result, edit && edit.old_string, edit && edit.new_string, edit && edit.replace_all);
      if (result === null) return null;
    }
    return { baseline, result };
  }

  return null;
}

// Shared traversal for both collectors below: every unchecked (`- [ ]`) step
// inside a `## Plan` section, each paired with its continuation lines (a
// wrapped step's tag can sit on the last continuation line rather than the
// checkbox line itself). Checked-off `[x]`/`[X]` steps never start a step.
// Extraction alone, no newness filtering: each caller decides "new" its own
// way against its own baseline multiset.
function extractUncheckedPlanSteps(text) {
  const lines = text.split('\n');
  const steps = [];
  let inPlan = false;
  // The heading level `## Plan` itself was opened at, so a deeper heading
  // (e.g. `### Phase 1` nested under it) doesn't leave the Plan section;
  // only a heading at the same or shallower level does.
  let planLevel = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const headerMatch = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const title = headerMatch[2];
      if (/^plan\b/i.test(title)) {
        inPlan = true;
        planLevel = level;
      } else if (planLevel === null || level <= planLevel) {
        inPlan = false;
        planLevel = null;
      }
      i += 1;
      continue;
    }
    if (inPlan && /^\s*[-*]\s+\[ \]\s/.test(line)) {
      const firstLine = line.replace(/\s+$/, '');
      const stepLines = [line];
      let j = i + 1;
      while (
        j < lines.length &&
        /^\s+\S/.test(lines[j]) &&
        !/^\s*[-*]\s+\[[ xX]\]\s/.test(lines[j]) &&
        !/^\s{0,3}#{1,6}\s+/.test(lines[j])
      ) {
        stepLines.push(lines[j]);
        j += 1;
      }
      steps.push({ firstLine, joined: stepLines.join(' ').replace(/\s+$/, '') });
      i = j;
      continue;
    }
    i += 1;
  }
  return steps;
}

// New unchecked steps inside a `## Plan` section, for the tag lint. Newness
// is decided on the checkbox line alone, right-trimmed and compared against
// the same right-trimmed set of ALL lines from the on-disk baseline (not
// just its Plan-section steps), so touching only a legacy step's
// continuation line never counts as new here.
function collectNewUncheckedPlanSteps(baseline, result) {
  // A multiset, not a Set: todo.md accumulates historical batches, so two
  // unrelated steps (old and new) can share identical checkbox text. Each
  // baseline occurrence exempts at most one matching result occurrence from
  // being "new"; a genuinely new copy beyond what the baseline had still
  // counts, even if its text collides with an old, already-tagged step.
  const baselineCounts = new Map();
  for (const l of baseline.split('\n').map((l) => l.replace(/\s+$/, ''))) {
    baselineCounts.set(l, (baselineCounts.get(l) || 0) + 1);
  }
  const steps = [];
  for (const step of extractUncheckedPlanSteps(result)) {
    const remaining = baselineCounts.get(step.firstLine) || 0;
    if (remaining > 0) {
      baselineCounts.set(step.firstLine, remaining - 1);
    } else {
      steps.push(step);
    }
  }
  return steps;
}

// Sibling to collectNewUncheckedPlanSteps for the main-attribution guard
// only: a step counts when its JOINED text (checkbox line + continuation
// lines) doesn't appear among the baseline's own joined step texts, not just
// when its checkbox line is new. That closes a gap the checkbox-line-only
// test leaves open: editing only an existing wrapped step's continuation
// line to add a `(main: ...)` tag leaves the checkbox line untouched, so
// collectNewUncheckedPlanSteps never sees it as new and the tag inside it is
// never inspected. Same multiset semantics as collectNewUncheckedPlanSteps
// (a genuinely new copy of an old step's exact text still counts), but the
// baseline multiset here is built from the baseline's own unchecked Plan
// steps (via the same extractUncheckedPlanSteps traversal), since "joined"
// text only exists once continuation lines are gathered the same way for the
// baseline that they are for the result.
function collectChangedUncheckedPlanSteps(baseline, result) {
  const baselineCounts = new Map();
  for (const step of extractUncheckedPlanSteps(baseline)) {
    baselineCounts.set(step.joined, (baselineCounts.get(step.joined) || 0) + 1);
  }
  const steps = [];
  for (const step of extractUncheckedPlanSteps(result)) {
    const remaining = baselineCounts.get(step.joined) || 0;
    if (remaining > 0) {
      baselineCounts.set(step.joined, remaining - 1);
    } else {
      steps.push(step);
    }
  }
  return steps;
}

// Tag verdict for one new step's joined (single-space-joined, right-trimmed)
// text. MAIN_OK_RE first so a reasoned `(main: ...)` always passes before the
// broader MAIN_ANY_RE gets a chance to flag it as bare.
function stepTagViolation(joined) {
  if (MAIN_OK_RE.test(joined)) return null;
  if (MAIN_ANY_RE.test(joined)) return 'bare-main';
  if (TIER_TAG_RE.test(joined)) return null;
  return 'untagged';
}

// --- Messages ---

// Same four-field subagent test as gateguard.js's isSubagent(), copied per
// script by house style. agent_type alone is deliberately not consulted: a
// whole session launched with --agent carries it on the main thread too.
function isSubagent(input) {
  const ids = [input.agent_id, input.agentId, input.parent_tool_use_id, input.parentToolUseId];
  return ids.some((v) => typeof v === 'string' && v.trim());
}

// Returns '' on the main thread. Inside a subagent, most roster tiers have
// no Skill tool, so the base message's "invoke the Skill" instruction is
// unfollowable there; this line tells the subagent to stop and report to
// its caller instead of routing around the gate.
function subagentLine(input) {
  if (!input || !isSubagent(input)) return '';
  const agentType = input.agent_type || 'unknown';
  return `This call runs inside subagent \`${agentType}\`. If you have no Skill tool, stop and report to your caller that this session has no plan-and-track stamp, so the caller can invoke the skill and resume you. Do not route around this gate with another tool (a Bash heredoc, a script) or an env override.`;
}

function gateMsg(input) {
  return [
    '[PlanGate] Writes to .tasks/todo.md are gated: invoke the plan-and-track Skill via the Skill tool first (it loads the reconcile/lessons/checklist steps), then retry this edit.',
    subagentLine(input),
    '(PLANGATE_DISABLED=1 turns this gate off; PLANGATE_WARN=1 demotes it to a warning.)',
  ]
    .filter(Boolean)
    .join('\n');
}

function scopeMsg(threshold, input, noun) {
  return [
    `[PlanGate] This session has touched ${threshold} distinct files without a plan: invoke the plan-and-track Skill via the Skill tool first (it loads the reconcile/lessons/checklist steps), then retry this ${noun}.`,
    subagentLine(input),
    '(PLANGATE_SCOPE_THRESHOLD sets the file-count trigger, default 3; PLANGATE_DISABLED=1 turns this gate off; PLANGATE_WARN=1 demotes it to a warning.)',
  ]
    .filter(Boolean)
    .join('\n');
}

function mutationMsg(threshold, input) {
  return [
    `[PlanGate] This command would bring this session to ${threshold} distinct outward git/gh mutations (push, PR create, PR merge) without a plan: invoke the plan-and-track Skill via the Skill tool first (it loads the reconcile/lessons/checklist steps), then retry this command.`,
    subagentLine(input),
    '(PLANGATE_MUTATION_THRESHOLD sets the mutation-count trigger, default 2; PLANGATE_DISABLED=1 turns this gate off; PLANGATE_WARN=1 demotes it to a warning.)',
  ]
    .filter(Boolean)
    .join('\n');
}

function lintMsg(offenders) {
  // firstLine already carries its own "- [ ]" marker, so indent only: a
  // second leading "- " here would print as a double bullet.
  const shown = offenders.slice(0, 3).map((o) => {
    const text = o.firstLine.length > 100 ? o.firstLine.slice(0, 100) + '...' : o.firstLine;
    return `  ${text}`;
  });
  if (offenders.length > 3) shown.push(`  ...and ${offenders.length - 3} more`);
  return [
    '[PlanGate] New plan steps in .tasks/todo.md need an owner tag at end of step:',
    ...shown,
    'Tag each step with who carries it out: implementation defaults to (executor), research to (researcher), mechanical tails to (mechanic); also valid: (planner), (debugger), (security-auditor), (architect-reviewer), (fable-advisor), each optionally with a reason like (executor: <why>). Tagging (main) is the exception and must carry a one-clause reason in the tag itself, e.g. (main: needs user sign-off mid-step); "main already has the context" does not qualify. Retry the same write with tags added.',
    '(PLANGATE_LINT_DISABLED=1 turns off this lint; PLANGATE_DISABLED=1 turns off the whole gate; PLANGATE_WARN=1 demotes to a warning.)',
  ].join('\n');
}

// `reason` is the text captured from inside the offending `(main: ...)` tag.
// It is shown on its own line because a wrapped step keeps its tag on a
// continuation line, so firstLine alone would name the step without ever
// showing what actually tripped the check.
function attributionMsg(offender, reason) {
  const text = offender.firstLine.length > 100 ? offender.firstLine.slice(0, 100) + '...' : offender.firstLine;
  const shownReason = reason.length > 100 ? reason.slice(0, 100) + '...' : reason;
  return [
    "[PlanGate] This step's (main: ...) reason reads as a claim about what the user did or asked, not a fact about the work itself:",
    `  ${text}`,
    `  offending reason: (main: ${shownReason})`,
    'A (main: <why>) reason should state a fact about the work (context needed, timing, low mechanical cost), not attribute an action or preference to the user. If the user genuinely did ask/confirm/decide this, retry the same write: this check denies only once per session.',
    '(PLANGATE_LINT_DISABLED=1 turns off this check along with the tag lint; PLANGATE_DISABLED=1 turns off the whole gate; PLANGATE_WARN=1 demotes to a warning.)',
  ].join('\n');
}

function migrationMsg() {
  return [
    '[PlanGate] This write would delete the `## Migration State` block from .tasks/todo.md. That block is durable cross-session migration state (frozen oracle, ladder rung, ownership) that must survive tidying, batch compression, and compaction.',
    'If ending or abandoning the migration is intentional (user-confirmed), retry the same write: the retry passes. Otherwise re-issue the write with the `## Migration State` block kept intact.',
    '(PLANGATE_DISABLED=1 turns off the whole gate; PLANGATE_WARN=1 demotes to a warning.)',
  ].join('\n');
}

function emitGateDecision(msg) {
  if (process.env.PLANGATE_WARN === '1') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: msg + '\n(Warn-only mode: the tool call proceeds.)',
        },
      })
    );
  } else {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: msg,
        },
      })
    );
  }
}

// Runs only once the stamp check has already passed. Skips outright when
// PLANGATE_LINT_DISABLED=1, and the whole body is wrapped in try/catch so any
// simulation/lint error fails open (allows the edit) rather than wedging the
// gate, consistent with this file's fail-open philosophy everywhere else.
// Returns true when a decision was emitted, so the caller skips the in-flight
// batch warning (one decision JSON per run).
function maybeLintTodoContent(toolName, toolInput) {
  if (process.env.PLANGATE_LINT_DISABLED === '1') return false;
  try {
    const sim = simulateResult(toolName, toolInput);
    if (!sim) return false;
    const steps = collectNewUncheckedPlanSteps(sim.baseline, sim.result);
    const offenders = steps.filter((s) => stepTagViolation(s.joined));
    if (!offenders.length) return false;
    emitGateDecision(lintMsg(offenders));
    return true;
  } catch {
    return false; // fail open: any simulation/lint error allows the edit
  }
}

// --- Migration-state guard ---

// The `## Migration State` block (see skills/migration-discipline) is
// durable cross-session state; a tidying sweep that deletes it is
// unrecoverable after compaction. Exact H2 title only, case-insensitive like
// the Plan-heading match above; no trailing text, so prose that merely
// mentions the phrase never counts as the heading.
const MIGRATION_HEADING_RE = /^\s{0,3}##\s+Migration State\s*$/im;

// Deny ONCE per session a .tasks/todo.md write that would delete an existing
// `## Migration State` heading. Gateguard's mark-at-deny-time pattern: the
// `.migstate` marker is claimed exclusively when the deny is emitted, so the
// intentional retry (and any later deletion this session) passes. Runs only
// after the stamp check, and deliberately ignores PLANGATE_LINT_DISABLED:
// opting out of tag formatting must not silently drop a data-loss guard.
// Returns true when a decision was emitted, so the caller exits without
// running the lint (a hook run may emit at most one decision JSON).
function maybeGuardMigrationState(toolName, toolInput, stamp) {
  try {
    const sim = simulateResult(toolName, toolInput);
    if (!sim) return false;
    if (!MIGRATION_HEADING_RE.test(sim.baseline) || MIGRATION_HEADING_RE.test(sim.result)) return false;
    try {
      // STATE_DIR exists here: the session stamp this branch requires lives in it.
      fs.writeFileSync(stamp + '.migstate', '', { flag: 'wx' });
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // EEXIST alone can't tell an intentional retry from a concurrent
        // write that lost the wx race microseconds ago (PreToolUse hooks can
        // run concurrently; see withSessionLock above). A racing loser sees
        // a marker written within the same tool batch, sub-second old; a
        // genuine retry needs a model turn after seeing the deny. So a fresh
        // marker means contention: deny this invocation too. The check never
        // touches the marker's mtime, so denied racers can't keep the window
        // open and re-deny a real retry forever.
        try {
          if (Date.now() - fs.statSync(stamp + '.migstate').mtimeMs < 2000) {
            emitGateDecision(migrationMsg());
            return true;
          }
        } catch {
          /* marker vanished or unreadable: treat as the retry and allow */
        }
        return false; // aged marker: intentional retry passes
      }
      process.stderr.write('[PlanGate] migration-state marker could not be persisted; allowing the edit.\n');
      return false; // never deny what we can't record, or the deny would repeat forever
    }
    emitGateDecision(migrationMsg());
    return true;
  } catch {
    return false; // fail open: any simulation/guard error allows the edit
  }
}

// --- Main-attribution guard ---

// Deny ONCE per session a new step's `(main: ...)` reason that trips
// MAIN_USER_ATTRIBUTION_RE. Same mark-at-deny-time pattern as
// maybeGuardMigrationState: the `.mainattr` marker is claimed exclusively
// when the deny is emitted, so an intentional retry passes. Deny-once (not
// deny-until-fixed) is deliberate: the attribution may be true, the check
// just can't tell, so the point is one conscious re-assertion, not a block.
// Runs only after the stamp check and the migration-state guard, and
// respects PLANGATE_LINT_DISABLED (unlike the migration-state guard, this is
// a phrasing lint, not a data-loss guard). Returns true when a decision was
// emitted, so the caller skips the tag lint (one decision JSON per run).
function maybeGuardMainAttribution(toolName, toolInput, stamp) {
  if (process.env.PLANGATE_LINT_DISABLED === '1') return false;
  try {
    const sim = simulateResult(toolName, toolInput);
    if (!sim) return false;
    // Broader than the tag lint's collectNewUncheckedPlanSteps: an
    // attribution can be smuggled in by editing only a wrapped step's
    // continuation line while leaving its checkbox line untouched, so this
    // guard keys off the step's whole joined text instead (see
    // collectChangedUncheckedPlanSteps). The tag lint deliberately stays on
    // the narrower, checkbox-line-only test: switching it too would re-flag
    // a legacy step's already-valid tag as untagged/bare-main whenever
    // unrelated prose on its continuation line changes, which isn't this
    // lint's job.
    const steps = collectChangedUncheckedPlanSteps(sim.baseline, sim.result);
    let offendingReason = null;
    const offender = steps.find((s) => {
      const m = MAIN_REASON_RE.exec(s.joined);
      if (m && MAIN_USER_ATTRIBUTION_RE.test(m[1])) {
        offendingReason = m[1];
        return true;
      }
      return false;
    });
    if (!offender) return false;
    try {
      // STATE_DIR exists here: the session stamp this branch requires lives in it.
      fs.writeFileSync(stamp + '.mainattr', '', { flag: 'wx' });
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Same race-vs-retry distinction as maybeGuardMigrationState: a
        // marker written within the same tool batch, sub-second old, is a
        // racing loser, not the intentional retry a model turn later, so a
        // fresh marker means contention: deny this invocation too.
        try {
          if (Date.now() - fs.statSync(stamp + '.mainattr').mtimeMs < 2000) {
            emitGateDecision(attributionMsg(offender, offendingReason));
            return true;
          }
        } catch {
          /* marker vanished or unreadable: treat as the retry and allow */
        }
        return false; // aged marker: intentional retry passes
      }
      process.stderr.write('[PlanGate] main-attribution marker could not be persisted; allowing the edit.\n');
      return false; // never deny what we can't record, or the deny would repeat forever
    }
    emitGateDecision(attributionMsg(offender, offendingReason));
    return true;
  } catch {
    return false; // fail open: any simulation/guard error allows the edit
  }
}

// --- In-flight batch warning ---

// `Batch N` heading at H1-H3, the shape the todo.md fixtures use (`## Batch N:
// title`). A line-only summary like `Batch 40: ...` is not a heading and is
// ignored on both sides. Group 1 is the batch number.
const BATCH_HEADING_RE = /^\s{0,3}#{1,3}\s+Batch\s+(\d+)\b/i;
const H1_RE = /^\s{0,3}#\s/;
const REVIEW_HEADING_RE = /^\s{0,3}#{2,3}\s+Review\b/im;
const UNCHECKED_STEP_RE = /^\s*[-*]\s+\[ \]/m;
const CHECKED_STEP_RE = /^\s*[-*]\s+\[x\]/im;

// Batch number -> { title, closed, block } for every batch heading in `text`. A
// block runs from its heading to the line before the next batch heading or
// the next H1, or EOF. "Closed out" means a Review heading plus at least one
// checked step and no unchecked one, the same signal plan-and-track's reconcile uses before compressing a
// batch. A repeated number keeps its first block.
function collectBatches(text) {
  const batches = new Map();
  let current = null;
  const finish = () => {
    if (current && !batches.has(current.num)) {
      const block = current.lines.join('\n');
      batches.set(current.num, {
        title: current.lines[0].trim().replace(/^#+\s+/, ''),
        closed: REVIEW_HEADING_RE.test(block) && CHECKED_STEP_RE.test(block) && !UNCHECKED_STEP_RE.test(block),
        block,
      });
    }
  };
  for (const line of text.split('\n')) {
    const m = BATCH_HEADING_RE.exec(line);
    if (m || H1_RE.test(line)) {
      finish();
      current = m ? { num: m[1], lines: [line] } : null;
    } else if (current) {
      current.lines.push(line);
    }
  }
  finish();
  return batches;
}

function inFlightBatchMsg(dropped) {
  const shown = dropped.slice(0, 3).map((b) => `  ${b.title.length > 100 ? b.title.slice(0, 100) + '...' : b.title}`);
  if (dropped.length > 3) shown.push(`  ...and ${dropped.length - 3} more`);
  return [
    '[PlanGate] This write removes a batch heading from .tasks/todo.md for a batch that is not closed out (no fully checked plan, or no Review section), so it may be another session\'s in-flight work:',
    ...shown,
    'The write is proceeding. If the batch is not yours, or dropping it was not intended, re-read .tasks/todo.md and put that batch back exactly as it was before your write, leaving everything else as the file now stands.',
    '(PLANGATE_DISABLED=1 turns this warning off.)',
  ].join('\n');
}

// Warn-only: a stamped .tasks/todo.md write whose result no longer has a
// `Batch N` heading that the baseline had, where that baseline batch was not
// closed out. No permissionDecision and no once-marker: it fires every time,
// and ignores PLANGATE_LINT_DISABLED like the migration-state guard (a
// data-loss signal, not a formatting lint). Cannot see whose batch it is, so
// it also fires on a session dropping its own unfinished batch. Returns true
// when a warning was emitted; any error emits nothing.
function maybeWarnInFlightBatchRemoval(toolName, toolInput) {
  try {
    const sim = simulateResult(toolName, toolInput);
    if (!sim) return false;
    const after = collectBatches(sim.result);
    const dropped = [...collectBatches(sim.baseline)]
      .filter(([num, b]) => !after.has(num) && !b.closed)
      .map(([, b]) => b);
    if (!dropped.length) return false;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: inFlightBatchMsg(dropped) },
      })
    );
    return true;
  } catch {
    return false; // fail open: any simulation/check error emits nothing
  }
}

// --- Review goal-line lint ---

// `Goal met: yes` or `Goal met: partial: <gap>` at line start, optionally as
// a list item. [ \t] rather than \s throughout, so an empty gap can never
// borrow the next line's text.
const GOAL_MET_RE = /^[ \t]*(?:[-*][ \t]+)?Goal met:[ \t]*(?:yes\b|partial:[ \t]*\S)/im;

// Batches whose Review heading is new in `result`: the same-numbered baseline
// block had no Review, or the batch is new to the file. Reviews already on
// disk never count. The section runs from the Review heading to the end of
// its collectBatches block.
function collectReviewsMissingGoalLine(baseline, result) {
  const before = collectBatches(baseline);
  const offenders = [];
  for (const [num, b] of collectBatches(result)) {
    const at = b.block.search(REVIEW_HEADING_RE);
    if (at === -1) continue;
    const prior = before.get(num);
    if (prior && REVIEW_HEADING_RE.test(prior.block)) continue;
    if (!GOAL_MET_RE.test(b.block.slice(at))) offenders.push(b);
  }
  return offenders;
}

function goalLineMsg(offenders) {
  const shown = offenders.slice(0, 3).map((b) => `  ${b.title.length > 100 ? b.title.slice(0, 100) + '...' : b.title}`);
  if (offenders.length > 3) shown.push(`  ...and ${offenders.length - 3} more`);
  return [
    '[PlanGate] A new Review section in .tasks/todo.md needs a goal line:',
    ...shown,
    "Measure the end state against the batch's stated goal before closing it out: anything short of the goal that this batch can still finish gets finished now, not parked. Then add one line to that Review: `Goal met: yes`, or `Goal met: partial: <gap>` naming what is still short. Retry the same write with the line added.",
    '(PLANGATE_LINT_DISABLED=1 turns off this lint; PLANGATE_DISABLED=1 turns off the whole gate; PLANGATE_WARN=1 demotes to a warning.)',
  ].join('\n');
}

// Deny-until-fixed like maybeLintTodoContent (no once-marker): the retry
// self-corrects, and `Goal met: partial: <gap>` is always available, so the
// deny can't wedge a session. Runs only once stamped, after the tag lint;
// respects PLANGATE_LINT_DISABLED and fails open on any error. Returns true
// when a decision was emitted, so the caller skips the in-flight warning.
function maybeLintReviewGoalLine(toolName, toolInput) {
  if (process.env.PLANGATE_LINT_DISABLED === '1') return false;
  try {
    const sim = simulateResult(toolName, toolInput);
    if (!sim) return false;
    const offenders = collectReviewsMissingGoalLine(sim.baseline, sim.result);
    if (!offenders.length) return false;
    emitGateDecision(goalLineMsg(offenders));
    return true;
  } catch {
    return false; // fail open: any simulation/lint error allows the edit
  }
}

// --- Shell writes to .tasks/todo.md ---

// The todo.md path as it appears in a raw command: optionally prefixed by any
// directory (relative or absolute), either slash, and not a longer name such
// as todo.md.bak. Case-insensitive like the edit-tool gate (NTFS).
// A quoted operand may carry spaces in its parent directories, so it gets its
// own alternative, quotes included, ahead of the unquoted form.
const TODO_PATH = String.raw`(?:"[^"\n]*[\/\\]\.tasks[\/\\]todo\.md"|'[^'\n]*[\/\\]\.tasks[\/\\]todo\.md'|(?<![\w.\-])(?:[^\s'"<>|;&()=]*[\/\\])?\.tasks[\/\\]todo\.md(?![\w.\-]))`;
const TODO_REF_RE = new RegExp(TODO_PATH, 'i');
// `>`, `>>`, `>|`, `2>`, `&>` whose target is the todo path.
const TODO_REDIRECT_RE = new RegExp(String.raw`>>?\|?[ \t]*['"]?` + TODO_PATH, 'i');
// `tee` / `tee -a` with the todo path among its arguments (same pipeline segment).
const TODO_TEE_RE = new RegExp(String.raw`\btee\b[^|;&\n]*` + TODO_PATH, 'i');
// `sed -i`, `sed --in-place`, `perl -i`, `perl -pi`, `-i.bak`, `-ni`, `-0pi`.
const IN_PLACE_EDIT_RE = /\b(?:sed|perl)\b[^|;&\n]*?[ \t](?:-[A-Za-z0-9]*i|--in-place)/i;
// mv/cp/install with the todo path as the last argument of its segment; the
// verb, the arguments before the path, and the path are captured so the one
// legal create (the legacy tasks/todo.md migration) can be told apart.
const TODO_DEST_RE = new RegExp(String.raw`\b(mv|cp|install)\b([^|;&\n]*)[ \t]['"]?(` + TODO_PATH + String.raw`)['"]?(?=[ \t]*(?:[|;&)\n]|$))`, 'i');
// The legacy source plan-and-track step 1 moves into place: tasks/todo.md not
// under .tasks.
const LEGACY_TODO_SOURCE_RE = /(?:^|[ \t'"])(?:\.\/)?tasks[\/\\]todo\.md(?=['"]?[ \t])/i;
// rm/unlink naming the todo path, or the todo path as an mv source (another
// argument follows it): both remove the file with no lint running.
const TODO_DELETE_RE = new RegExp(String.raw`\b(?:rm|unlink)\b[^|;&\n]*` + TODO_PATH, 'i');
const TODO_MOVE_AWAY_RE = new RegExp(String.raw`\bmv\b[^|;&\n]*[ \t]['"]?` + TODO_PATH + String.raw`['"]?[ \t]+[^|;&\n]*\S`, 'i');
// The .tasks directory itself as an rm or mv operand (not .tasks-old,
// .tasks/lessons-draft.md): removing or moving it takes todo.md with it.
const TASKS_DIR = String.raw`(?:"[^"\n]*[\/\\]\.tasks[\/\\]?"|'[^'\n]*[\/\\]\.tasks[\/\\]?'|(?<![\w.\-])(?:[^\s'"<>|;&()=]*[\/\\])?\.tasks[\/\\]?(?=['"]?(?:[ \t]|[|;&)\n]|$)))`;
const TASKS_DIR_REMOVE_RE = new RegExp(String.raw`\b(?:rm|mv)\b[^|;&\n]*[ \t]['"]?` + TASKS_DIR, 'i');
// truncate takes only file operands, so the path anywhere in its segment is a target.
const TODO_TRUNCATE_RE = new RegExp(String.raw`\btruncate\b[^|;&\n]*` + TODO_PATH, 'i');
// An interpreter whose program text is inline (heredoc, -c, -e) so the body is
// visible in the command, plus a write API inside it. sys.stdout/stderr
// .write( is console output, not a file write, so it is excluded.
const INLINE_INTERPRETER_RE = /\b(?:python3?(?:\.\d+)?|node|ruby|perl)\b/i;
const INLINE_BODY_RE = /<<|[ \t]-[A-Za-z]*[ce][ \t]/;
const WRITE_API_RE = new RegExp(
  [
    String.raw`\bopen\([^)]*,\s*(?:mode\s*=\s*)?['"][rbt]*[wax+][^'"]*['"]`,
    String.raw`(?<!stdout)(?<!stderr)\.write\(`,
    String.raw`\bwrite_text\b`,
    String.raw`\b(?:writeFile|appendFile)(?:Sync)?\b`,
    String.raw`\bFile\.write\b`,
  ].join('|')
);

// Does this raw Bash command write .tasks/todo.md? Scans the raw command text,
// not splitShellSegments (which strips heredoc bodies, where an inline script
// keeps its write). ACCEPTED GAPS: a path built dynamically (variables,
// concatenation, `cd .tasks && ... todo.md`, a script file whose body is not
// in the command) is not seen; a read-only command that merely shares a
// segment with a -i flag can false-positive, and the retry (Edit/Write) is
// always available.
function detectTodoShellWrite(command, cwd) {
  if (TASKS_DIR_REMOVE_RE.test(command)) return true;
  if (!TODO_REF_RE.test(command)) return false;
  if (TODO_REDIRECT_RE.test(command) || TODO_TEE_RE.test(command)) return true;
  if (IN_PLACE_EDIT_RE.test(command)) return true;
  if (TODO_TRUNCATE_RE.test(command) || TODO_DELETE_RE.test(command)) return true;
  if (TODO_MOVE_AWAY_RE.test(command)) return true;
  const dest = TODO_DEST_RE.exec(command);
  if (dest && !isLegacyTodoMigration(dest, command, cwd)) return true;
  return INLINE_INTERPRETER_RE.test(command) && INLINE_BODY_RE.test(command) && WRITE_API_RE.test(command);
}

// The one shell write allowed onto todo.md: plan-and-track step 1's
// `mv tasks/todo.md .tasks/todo.md` when .tasks/todo.md does not exist yet,
// a create carrying the project's own legacy file rather than an overwrite.
// Anything that keeps the destination from being resolved reliably (a `cd`
// earlier in the command, no cwd for a relative path) counts as an
// overwrite, so the doubt lands on the deny side.
function isLegacyTodoMigration(dest, command, cwd) {
  const [, verb, sources, rawPath] = dest;
  if (verb.toLowerCase() !== 'mv' || !LEGACY_TODO_SOURCE_RE.test(sources + ' ')) return false;
  if (/(?:^|[^\w.\-])cd\b/.test(command)) return false;
  const p = rawPath.replace(/^(['"])(.*)\1$/, '$2').replace(/\\/g, '/');
  if (!path.isAbsolute(p) && !cwd) return false;
  return !fs.existsSync(path.isAbsolute(p) ? p : path.resolve(cwd, p));
}

function todoShellWriteMsg(input) {
  return [
    "[PlanGate] This Bash command writes or removes .tasks/todo.md (or the .tasks directory holding it). plan-gate's todo.md checks (session stamp, owner tags, Review goal line, Migration State, in-flight batch warning) only see Edit/Write/MultiEdit calls, so a shell write would skip every one of them. Make the same change with the Edit or Write tool instead; to close out batches, compress them in place rather than deleting the file.",
    subagentLine(input),
    '(PLANGATE_DISABLED=1 turns off the whole gate; PLANGATE_WARN=1 demotes to a warning.)',
  ]
    .filter(Boolean)
    .join('\n');
}

// Denies on every attempt (no once-marker, no stamp check): the unlock is
// switching tools, not a session event. PLANGATE_LINT_DISABLED deliberately
// does not apply here: this also keeps the Migration State data-loss guard
// from being bypassed. Returns true when a decision was emitted. Fails open.
function maybeDenyTodoShellWrite(command, input) {
  try {
    if (!detectTodoShellWrite(command, input.cwd)) return false;
    emitGateDecision(todoShellWriteMsg(input));
    return true;
  } catch {
    return false;
  }
}

// --- Scope gate: files written through Bash ---

// Options that take their value as the NEXT word, per command family, so the
// value is not mistaken for a file operand.
const TARGET_ARG_OPTS = new Set(['-m', '-o', '-g', '-S']); // cp, install
const MOVE_ARG_OPTS = new Set(['-S']); // mv
const TRUNCATE_ARG_OPTS = new Set(['-s', '-r', '--size', '--reference']);
// `sed`/`perl` in-place flag: `-i`, `-i.bak`, a cluster of no-argument flags
// ending in i (`-pi`, `-ni`, `-0pi`, `-Ei`), or `--in-place`. The cluster
// prefix is restricted so `perl -Mstrict` (an `i` inside a module name) is
// not read as in-place.
const IN_PLACE_FLAG_RE = /^(?:-[nsErzpalwWStTuUc0-9]*i|--in-place)/;
// String-literal paths handed to a write API inside an inline interpreter
// body (group 2 is the path). A variable or computed path has no literal and
// is not matched.
const INLINE_WRITE_PATH_RES = [
  /\bopen\(\s*(['"])([^'"\n]+)\1\s*,\s*(?:mode\s*=\s*)?['"][rbt]*[wax+][^'"]*['"]/g,
  /\bPath\(\s*(['"])([^'"\n]+)\1\s*\)\s*\.\s*(?:write_text|write_bytes)\b/g,
  /\b(?:writeFile|appendFile)(?:Sync)?\(\s*(['"])([^'"\n]+)\1/g,
  /\bFile\.write\(\s*(['"])([^'"\n]+)\1/g,
];

// Quote-aware word tokenizer for ONE splitShellSegments segment (comments and
// heredoc bodies are already gone). Returns the command words, with quotes
// removed and `\ ` unescaped, plus the operand word of every unquoted `>`/`>>`
// redirect (an attached fd prefix like the `2` in `2>err.log` is dropped, and
// a `<` input redirect with its operand is skipped). A `$(...)` or backtick
// substitution stays inside its word, so it is never split into fake operands.
// `dangling` marks a segment ending in a `>` with no operand, which is what
// splitShellSegments leaves of `>&word` and `>|word`.
function tokenizeSegment(segment) {
  const text = String(segment || '');
  const n = text.length;
  const words = [];
  const redirects = [];
  let i = 0;

  // One word starting at i; stops at unquoted whitespace, `<`, or `>`.
  function readWord() {
    let word = '';
    while (i < n && !/[\s<>]/.test(text[i])) {
      const ch = text[i];
      if (ch === "'") {
        const end = text.indexOf("'", i + 1);
        const stop = end === -1 ? n : end;
        word += text.slice(i + 1, stop);
        i = Math.min(stop + 1, n);
      } else if (ch === '"') {
        i += 1;
        while (i < n && text[i] !== '"') {
          if (text[i] === '\\' && i + 1 < n && '"\\$`'.includes(text[i + 1])) i += 1;
          word += text[i];
          i += 1;
        }
        i += 1;
      } else if (ch === '`') {
        const end = text.indexOf('`', i + 1);
        const stop = end === -1 ? n : end + 1;
        word += text.slice(i, stop);
        i = stop;
      } else if (ch === '$' && text[i + 1] === '(') {
        let depth = 0;
        const from = i;
        i += 1; // past the `$`, onto the opening paren
        while (i < n) {
          if (text[i] === '(') depth += 1;
          if (text[i] === ')') depth -= 1;
          i += 1;
          if (depth === 0) break;
        }
        word += text.slice(from, i);
      } else if (ch === '\\' && i + 1 < n) {
        // An escaped space is part of the word; any other backslash is kept
        // (a Windows path separator, flipped later).
        word += /\s/.test(text[i + 1]) ? text[i + 1] : ch + text[i + 1];
        i += 2;
      } else {
        word += ch;
        i += 1;
      }
    }
    return word;
  }

  let lastWordEnd = -1;
  let dangling = false;
  while (i < n) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if ((ch === '<' || ch === '>') && text[i + 1] === '(') {
      // Process substitution `<(...)`/`>(...)` is a command, not a file:
      // skip its balanced body, as substitutions are not descended into.
      let depth = 0;
      i += 1; // onto the opening paren
      while (i < n) {
        if (text[i] === '(') depth += 1;
        if (text[i] === ')') depth -= 1;
        i += 1;
        if (depth === 0) break;
      }
    } else if (ch === '<') {
      i += 1;
      while (i < n && /\s/.test(text[i])) i += 1;
      readWord();
    } else if (ch === '>') {
      if (lastWordEnd === i && /^\d+$/.test(words[words.length - 1])) words.pop();
      i += text[i + 1] === '>' ? 2 : 1;
      while (i < n && /\s/.test(text[i])) i += 1;
      const target = readWord();
      if (target) redirects.push(target);
      else if (i >= n) dangling = true;
    } else {
      words.push(readWord());
      lastWordEnd = i;
    }
  }
  return { words, redirects, dangling };
}

// File operands of a command's words (words[0] is the command). `--` ends
// option parsing; an option listed in argOpts consumes the next word;
// `-t DIR` / `--target-directory DIR` is returned separately.
function shellOperands(words, argOpts) {
  const operands = [];
  let targetDir = null;
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i];
    if (w === '--') {
      operands.push(...words.slice(i + 1));
      break;
    }
    if (w === '-t' || w === '--target-directory') {
      if (i + 1 < words.length) targetDir = words[i + 1];
      i += 1;
    } else if (w.startsWith('--target-directory=')) {
      targetDir = w.slice('--target-directory='.length);
    } else if (w.length > 1 && w[0] === '-') {
      if (argOpts.has(w)) i += 1;
    } else {
      operands.push(w);
    }
  }
  return { operands, targetDir };
}

// File operands of an in-place `sed`/`perl`, else []. The first non-option
// word is the script unless -e/-f/--expression/--file supplied it (those
// consume the next word, which is a script, not a file).
function inPlaceTargets(words) {
  const operands = [];
  let inPlace = false;
  let scriptSupplied = false;
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i];
    if (w === '--') {
      operands.push(...words.slice(i + 1));
      break;
    }
    if (w.length < 2 || w[0] !== '-') {
      operands.push(w);
      continue;
    }
    if (IN_PLACE_FLAG_RE.test(w)) inPlace = true;
    // BSD/macOS `sed -i ''`: the empty word is the backup suffix, not the script.
    if (w === '-i' && words[i + 1] === '') {
      i += 1;
      continue;
    }
    if (w === '--expression' || w === '--file' || /^-[A-Za-z0-9]*[ef]$/.test(w)) {
      scriptSupplied = true;
      i += 1;
    } else if (/^--(?:expression|file)=/.test(w) || /^-[A-Za-z0-9]*[ef]./.test(w)) {
      scriptSupplied = true;
    }
  }
  if (!inPlace) return [];
  return scriptSupplied ? operands : operands.slice(1);
}

// Literal file operands a command writes or removes: tee, in-place sed/perl,
// the cp/install destination, every mv operand, and rm/unlink/truncate
// operands. touch and mkdir create nothing worth counting and are skipped.
function commandWriteTargets(words) {
  const cmd = words[0];
  if (cmd === 'tee') return shellOperands(words, new Set()).operands;
  if (cmd === 'sed' || cmd === 'perl') return inPlaceTargets(words);
  if (cmd === 'rm' || cmd === 'unlink') return shellOperands(words, new Set()).operands;
  if (cmd === 'truncate') return shellOperands(words, TRUNCATE_ARG_OPTS).operands;
  if (cmd === 'cp' || cmd === 'install') {
    if (cmd === 'install' && words.some((w) => w === '-d' || w === '--directory')) return [];
    const { operands, targetDir } = shellOperands(words, TARGET_ARG_OPTS);
    if (targetDir !== null) return [targetDir];
    return operands.length >= 2 ? [operands[operands.length - 1]] : [];
  }
  if (cmd === 'mv') {
    const { operands, targetDir } = shellOperands(words, MOVE_ARG_OPTS);
    const all = targetDir === null ? operands : [...operands, targetDir];
    return all.length >= 2 ? all : [];
  }
  return [];
}

// An interpreter as the invoked command (`python3`, `/usr/bin/node`), matched
// on the word's basename.
const INTERPRETER_CMD_RE = /^(?:python3?(?:\.\d+)?|node|ruby|perl)$/i;
function isInterpreterWord(word) {
  return INTERPRETER_CMD_RE.test(path.basename(String(word || '')));
}

// Bodies of heredocs whose opening line invokes an interpreter
// (`python3 - <<'EOF'`, `cat <<'EOF' | node`). splitShellSegments strips
// heredoc bodies, so these are cut from the raw text; a plain `cat > f <<EOF`
// body is data, not a script, and is never returned.
const HEREDOC_OPEN_RE = /^([^\n]*?)<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\2([^\n]*)$/gm;
function interpreterHeredocBodies(command) {
  const bodies = [];
  for (const m of command.matchAll(HEREDOC_OPEN_RE)) {
    const opening = (m[1] + ' ' + m[4]).split(/[\s|;&()]+/);
    if (!opening.some(isInterpreterWord)) continue;
    const lines = command.slice(m.index + m[0].length + 1).split('\n');
    const end = lines.findIndex((line) => line.replace(/^\t+/, '') === m[3]);
    bodies.push((end === -1 ? lines : lines.slice(0, end)).join('\n'));
  }
  return bodies;
}

// String-literal paths an interpreter body hands to a write API.
function writeApiTargets(body) {
  const targets = [];
  for (const re of INLINE_WRITE_PATH_RES) {
    for (const m of body.matchAll(re)) targets.push(m[2]);
  }
  return targets;
}

// Raw target strings a Bash command writes or removes (see the SCOPE GATE
// header paragraph for the counted shapes and accepted gaps). Skips leading
// VAR=value and `command` like detectOutwardMutations, plus the shell
// keywords that can precede a command in a segment (`then cp a b`). Only an
// interpreter's own program text is scanned for write APIs: its -c/-e
// arguments, or a heredoc body opened on its line.
const LEADING_SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time']);
function extractBashWriteTargets(command) {
  const targets = [];
  let pendingRedirect = false;
  for (const segment of splitShellSegments(command)) {
    const { words, redirects, dangling } = tokenizeSegment(segment);
    targets.push(...redirects);
    if (pendingRedirect) {
      // The split at `&` or `|` cut a `>&word` or `>|word` redirect: this
      // segment's first word is its operand unless it is an fd dup or close
      // (`2>&1`, `>&-`), and the rest still belongs to the cut command.
      pendingRedirect = dangling;
      if (words.length && !/^(?:\d+|-)$/.test(words[0])) targets.push(words[0]);
      continue;
    }
    pendingRedirect = dangling;
    while (words.length && (LEADING_SHELL_KEYWORDS.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift();
    if (words[0] === 'command') words.shift();
    if (!words.length) continue;
    targets.push(...commandWriteTargets(words));
    if (isInterpreterWord(words[0])) targets.push(...writeApiTargets(words.slice(1).join('\n')));
  }
  for (const body of interpreterHeredocBodies(command)) targets.push(...writeApiTargets(body));
  return targets;
}

// Case-insensitive "dir contains file" on slash-normalized absolute paths.
function isUnderDir(dir, file) {
  const d = dir.toLowerCase().replace(/\/+$/, '');
  const f = file.toLowerCase();
  return f === d || f.startsWith(d + '/');
}

// Raw targets to the normalized absolute paths the scope gate counts. Drops
// what cannot be resolved (`$` or a backtick), /dev/*, scope-exempt files,
// and temp scratch (os.tmpdir(), /tmp, /private/tmp, /var/tmp) that lies
// outside the cwd, so a project living under /tmp is still gated. The POSIX
// temp roots are matched on the target as written, before resolution: on
// Windows, path.resolve would put `/tmp` on a drive, and not necessarily the
// one the target lands on. No fs work.
const POSIX_TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/tmp'];
function resolveBashTargets(rawTargets, cwd) {
  const base = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const baseNorm = path.resolve(base).replace(/\\/g, '/');
  const osTemp = path.resolve(os.tmpdir()).replace(/\\/g, '/');
  const resolved = new Set();
  for (const raw of rawTargets) {
    if (!raw || /[$`]/.test(raw)) continue;
    let p = raw.replace(/\\/g, '/');
    if (p.startsWith('~/')) p = os.homedir().replace(/\\/g, '/') + p.slice(1);
    if (p.startsWith('/dev/')) continue;
    const abs = path.resolve(base, p).replace(/\\/g, '/');
    if (isScopeExempt(abs)) continue;
    const isTemp = isUnderDir(osTemp, abs) || POSIX_TEMP_ROOTS.some((root) => isUnderDir(root, p) || isUnderDir(root, abs));
    if (isTemp && !isUnderDir(baseNorm, abs)) continue;
    resolved.add(abs);
  }
  return [...resolved];
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    process.exit(0); // unparseable input: allow (Claude's PreToolUse fails open on silence)
  }

  if (process.env.PLANGATE_DISABLED === '1') process.exit(0);

  const toolName = String(input.tool_name || '');
  const toolInput = input.tool_input || {};

  // Skill branch: a plan-and-track invocation stamps the session.
  if (toolName.toLowerCase() === 'skill') {
    if (namesPlanAndTrack(toolInput)) {
      pruneStaleState();
      try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(stampPath(input.session_id, input), '');
      } catch (err) {
        process.stderr.write(`[PlanGate] could not write session stamp: ${err && err.message}\n`);
      }
    }
    process.exit(0);
  }

  // Bash branch: a Bash call is counted toward the scope gate (files it
  // writes or removes) and the mutation gate (outward git/gh mutation kinds),
  // the same way the Edit branch counts edited files. Fast path first: most
  // Bash calls classify to no targets and no kinds, so this exits before any
  // filesystem work on the hot path every Bash call hits.
  if (toolName === 'Bash') {
    const command = String(toolInput.command || '');
    // Todo shell-write guard first: it applies stamped or unstamped, and a
    // hook run emits at most one decision JSON.
    if (maybeDenyTodoShellWrite(command, input)) process.exit(0);
    const kinds = detectOutwardMutations(command);
    const targets = resolveBashTargets(extractBashWriteTargets(command), input.cwd);
    if (kinds.size === 0 && targets.length === 0) process.exit(0);
    const mstamp = stampPath(input.session_id, input);
    if (fs.existsSync(mstamp)) process.exit(0);

    withSessionLock(input.session_id, input, () => {
      const scopeLimit = scopeThreshold();
      const mutationLimit = mutationThreshold();
      // Markers dedupe by absolute path, so a file written by Bash and by an
      // edit tool (or twice in one command) counts once.
      const newMarkers = [...new Set(targets.map((t) => fileMarkerPath(input.session_id, input, t)))].filter((m) => !fs.existsSync(m));
      const newKinds = [...kinds].filter((k) => !fs.existsSync(mutationMarkerPath(input.session_id, input, k)));
      const scopeCrossed = targets.length > 0 && distinctFileCount(input.session_id, input) + newMarkers.length >= scopeLimit;
      const mutationCrossed = kinds.size > 0 && distinctMutationCount(input.session_id, input) + newKinds.length >= mutationLimit;

      // Scope wins over mutation: one decision JSON per run.
      if (scopeCrossed) emitGateDecision(scopeMsg(scopeLimit, input, 'command'));
      else if (mutationCrossed) emitGateDecision(mutationMsg(mutationLimit, input));
      // A real deny must not record any new file or kind (it would inflate
      // the count on retry, defeating deny-until-stamped). PLANGATE_WARN=1
      // lets the call proceed, so it falls through and records like any
      // other allowed call.
      if ((scopeCrossed || mutationCrossed) && process.env.PLANGATE_WARN !== '1') return;

      // Allowed (or warned-but-proceeding): record each newly seen file and
      // kind so a future call doesn't re-count it, and repeated denials of an
      // unrecorded one never inflate the total.
      try {
        if (newMarkers.length) fs.mkdirSync(filesDir(input.session_id, input), { recursive: true });
        for (const m of newMarkers) fs.writeFileSync(m, '');
      } catch {
        /* best effort: worst case a later call re-counts the same file */
      }
      try {
        if (newKinds.length) fs.mkdirSync(mutationsDir(input.session_id, input), { recursive: true });
        for (const k of newKinds) fs.writeFileSync(mutationMarkerPath(input.session_id, input, k), '');
      } catch {
        /* best effort: worst case a later call re-detects the same kind */
      }
    });
    process.exit(0);
  }

  // Edit branch. Case-insensitive throughout: install.ps1 deploys this hook
  // on Windows, where NTFS treats .tasks\todo.md and .TASKS\TODO.MD (etc.) as
  // the same file.
  if (!EDIT_TOOLS.has(toolName)) process.exit(0);
  const norm = String(toolInput.file_path || '').replace(/\\/g, '/');
  const stamp = stampPath(input.session_id, input);

  // .tasks/todo.md gate: unchanged behavior, own message.
  if (/(^|\/)\.tasks\/todo\.md$/i.test(norm)) {
    if (fs.existsSync(stamp)) {
      // Guards before lints, exclusively: at most one decision JSON per run,
      // and keeping the Migration State block and catching a misattributed
      // (main: ...) reason both outrank tag and goal-line formatting. The
      // warn-only in-flight batch check goes last so any deny above wins.
      if (maybeGuardMigrationState(toolName, toolInput, stamp)) process.exit(0);
      if (maybeGuardMainAttribution(toolName, toolInput, stamp)) process.exit(0);
      if (maybeLintTodoContent(toolName, toolInput)) process.exit(0); // emitted emitGateDecision(lintMsg(...))
      if (maybeLintReviewGoalLine(toolName, toolInput)) process.exit(0); // emitted emitGateDecision(goalLineMsg(...))
      maybeWarnInFlightBatchRemoval(toolName, toolInput);
      process.exit(0);
    }
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    } catch {
      // Unwritable state dir: the Skill branch could never stamp, so a deny
      // here would loop forever. Fail open with a note.
      process.stderr.write('[PlanGate] state dir could not be created; allowing the edit.\n');
      process.exit(0);
    }
    emitGateDecision(gateMsg(input));
    process.exit(0);
  }

  // Scope gate: deny once the session's distinct edited-file count reaches
  // the threshold without a stamp. No-op for exempt paths or once stamped.
  if (!norm || isScopeExempt(norm) || fs.existsSync(stamp)) process.exit(0);

  withSessionLock(input.session_id, input, () => {
    const threshold = scopeThreshold();
    const marker = fileMarkerPath(input.session_id, input, norm);
    const alreadyCounted = fs.existsSync(marker);
    const wouldBeCount = alreadyCounted ? distinctFileCount(input.session_id, input) : distinctFileCount(input.session_id, input) + 1;

    if (wouldBeCount >= threshold) {
      emitGateDecision(scopeMsg(threshold, input, 'edit'));
      // A real deny must not record the marker (it would inflate the count
      // on retry). PLANGATE_WARN=1 lets the edit proceed, so it falls
      // through and gets the same marker as any other allowed edit.
      if (process.env.PLANGATE_WARN !== '1') return;
    }

    // Allowed (or warned-but-proceeding): record this file so a future edit
    // doesn't re-count it, and repeated denials of an unrecorded file never
    // inflate the total.
    try {
      fs.mkdirSync(filesDir(input.session_id, input), { recursive: true });
      fs.writeFileSync(marker, '');
    } catch {
      /* best effort: worst case a later edit re-checks the same file */
    }
  });
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[PlanGate] ${err && err.message}\n`);
  process.exit(0);
}
