#!/usr/bin/env node
/**
 * GateGuard: universal fact-forcing edit gate (Claude Code, Codex, Copilot CLI)
 *
 * A PreToolUse gate that fires on the first edit to each file per session,
 * injecting a fact demand (callers, blast radius, real data schemas, the
 * user's verbatim instruction) instead of letting the model guess. Blocks by
 * default on Copilot and warns on Claude/Codex (GATEGUARD_DENY=1 restores
 * blocking everywhere). Demanding facts forces a real search, and the
 * investigation itself improves the edit. Adapted (lean) from ECC's
 * gateguard-fact-force hook.
 *
 * ONE SCRIPT, THREE HARNESSES. The wire dialect is sniffed from stdin:
 *   - Claude / Codex ("snake"): top-level snake_case `tool_name` / `tool_input`,
 *     and Claude-style camelCase `hookSpecificOutput` on output. File edits are
 *     `Edit|Write|MultiEdit|NotebookEdit` (Claude) or `apply_patch` (Codex; one
 *     patch envelope can touch several files: all are gated).
 *   - Copilot: camelCase `toolName` / `toolArgs`, top-level `permissionDecision`
 *     on output. File edits are `create|edit`. Copilot is FAIL-CLOSED (a hook
 *     crash or non-zero exit denies the tool), so every exit path here emits an
 *     explicit `{"permissionDecision":"allow"}` for Copilot and the outer catch
 *     allows too: the gate must never accidentally block by dying.
 *
 * LOOP-FREE BY CONSTRUCTION: each gated file is marked "checked" in session
 * state when the hook fires (blocking or warning), so a file can only ever be
 * gated once per session. If state can't be persisted, the edit is ALLOWED
 * with a stderr warning: never gate what we can't record, or the model would
 * be gated forever.
 *
 * Deliberately not ported from ECC: the routine-Bash gate, a once-per-session
 * gate on the first Bash call regardless of content, is friction without
 * signal and stays rejected here.
 *
 * The destructive-command concern did NOT stay rejected: it moved to
 * hooks/git-guard.js, which inspects the command text and gates a closed,
 * named set of destructive git forms rather than gating Bash generally. The
 * earlier reasoning here ("each harness's own permission system already
 * covers destructive commands") was wrong for Claude Code specifically:
 * Anthropic's own Claude Code hooks documentation
 * (https://code.claude.com/docs/en/hooks-guide) states that PreToolUse
 * hooks fire before any permission-mode check, in every permission mode, and
 * that a hook returning permissionDecision: "deny" blocks the tool even in
 * bypassPermissions mode or with --dangerously-skip-permissions; a blocking
 * hook also takes precedence over allow rules. So a hook gate is genuinely
 * not redundant with the permission layer: it fires where no permission
 * prompt ever does. The same is NOT documented for Codex: its current hooks
 * and approvals documentation does not state whether PreToolUse hooks fire
 * under its bypass or full-auto modes, or whether a hook deny overrides
 * them, so treat that side as unverified rather than assumed to match
 * Claude.
 *
 * Skipped: subagent tool calls (the parent session owns the gate; the
 * repeat-edit notice below is the one thing a subagent still gets),
 * `.claude/settings*.json` (hook repair must never be blocked), and
 * `.tasks/todo.md` / `.tasks/lessons.md` (our own rules force frequent edits
 * there; they have no importers or schemas to investigate).
 *
 * REPEAT-EDIT NOTICE: separate from the fact demand and never blocking. When
 * 2+ of the git user's own last 5 landed changes on the default branch (first
 * parent only) edited the file being edited, the hook adds a notice telling
 * the model to report that count and any spend so far to the user and ask
 * whether to continue, before its next request for a commit, PR, or spend.
 * "Own" means the mailmapped author name or email equals the configured
 * user.name or user.email, found among the newest 100 commits; a squash merge
 * carrying a forge noreply email still matches on name, and .mailmap covers
 * any other alias. Teammates' changes neither count nor break the count, and
 * with no identity configured the check is silent. The default branch is
 * the first that exists of origin/HEAD, origin/main, origin/master, main,
 * master; with none of them the check is silent and never falls back to HEAD,
 * so a topic branch's own commits cannot count. It fires on every edit of such
 * a file, not just the first, but once per (agent, path, the user's newest
 * own change), so a long session is re-warned only after the user lands
 * another change, not after a teammate's, and a subagent's
 * notice does not consume the parent's. Subagents get the notice alone, with
 * no fact demand. Created files, tests, fixtures, docs, instruction and readme
 * files (at any depth, any case), and lockfiles never count. Git runs under
 * one 3000 ms deadline per hook run, each call getting the time remaining.
 * Expected absences allow silently: no git binary (ENOENT), or a directory
 * that is not a git repository. Any other git failure (a timeout, dubious
 * ownership, a non-zero exit) also allows, but writes one stderr line saying
 * the check did not run. It is a warning on every harness and cannot verify
 * the user was told; on Copilot it rides the deny reason of a first edit and
 * degrades to stderr afterwards, like every Copilot warn. GATEGUARD_DISABLED
 * and GATEGUARD_EXEMPT_GLOBS turn it off along with the rest of the gate.
 *
 * DEFAULT POSTURE: warn, not deny, on Claude and Codex (GATEGUARD_DENY=1
 * restores blocking). Copilot defaults to deny instead, because its
 * PreToolUse has no soft-warn channel: its documented output only supports
 * permissionDecision/permissionDecisionReason/modifiedArgs, with no
 * additionalContext-style field the way postToolUse has (GitHub Copilot
 * hooks reference, "preToolUse decision control":
 * https://docs.github.com/en/copilot/reference/hooks-reference). emitWarn
 * there degrades to allow plus a stderr note, so a warn default would make
 * the hook a silent no-op on Copilot.
 *
 * Config (env):
 *   GATEGUARD_DISABLED      "1" turns the gate off entirely.
 *   GATEGUARD_WARN          "1" forces the warn behavior (fact demand
 *                           injected as additionalContext where the harness
 *                           has a soft channel; Copilot has none, so warn
 *                           there = allow + stderr note). Already the
 *                           default on Claude/Codex; explicitly selects warn
 *                           on Copilot. Overridden by GATEGUARD_DENY when
 *                           both are set (see below).
 *   GATEGUARD_DENY          "1" forces the blocking deny behavior on any
 *                           harness, and wins over GATEGUARD_WARN=1 if both
 *                           are set. Already the default on Copilot.
 *   GATEGUARD_EXEMPT_GLOBS  comma-separated globs to exempt
 *                           (`*` within a segment, `**` across, `?` one char).
 *   GATEGUARD_FULL_DENIALS  denials per session that get the full fact block
 *                           before condensing to one line (default 3).
 */
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.tmpdir(), 'claude-gateguard');
const STALE_MS = 24 * 60 * 60 * 1000; // prune state files older than a day
const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COPILOT_EDIT_TOOLS = new Set(['create', 'edit']);

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

// --- Dialect detection & output ---
//
// Only TWO output contracts exist. Claude and Codex both take Claude-style
// camelCase `hookSpecificOutput` (verified against a live Codex apply_patch
// PreToolUse dump), so they share the "snake" dialect. Copilot alone uses a
// top-level `permissionDecision` and is fail-closed.

function detectDialect(input) {
  return input && typeof input.toolName === 'string' ? 'copilot' : 'snake';
}

// Copilot must be told "allow" explicitly (fail-closed). Claude/Codex fail
// open, so a silent exit 0 is their allow: matching the original behavior.
function emitAllow(dialect) {
  if (dialect === 'copilot') process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
}

function emitDeny(dialect, reason) {
  if (dialect === 'copilot') {
    process.stdout.write(
      JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason })
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
}

function emitWarn(dialect, reason) {
  if (dialect === 'copilot') {
    // Copilot's PreToolUse has no soft-warn channel: allow and note on stderr.
    process.stderr.write(`[GateGuard] (warn) ${reason}\n`);
    emitAllow('copilot');
    return;
  }
  // No extra suffix here: reason is already mode-aware (see closingLines)
  // and states the edit is proceeding, so appending it again would repeat
  // the same sentence.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: reason,
      },
    })
  );
}

// --- Exemptions ---

function normalizeForMatch(p) {
  return String(p || '').replace(/\\/g, '/');
}

// Built-in skips: hook-config repair and this repo's task-tracking files.
function isBuiltinExempt(filePath) {
  const norm = normalizeForMatch(filePath);
  return (
    /(^|\/)\.claude\/settings(?:\.[^/]+)?\.json$/.test(norm) ||
    /(^|\/)\.tasks\/(?:todo|lessons)\.md$/.test(norm)
  );
}

function globToRegex(glob) {
  // Tokenize on the glob operators so each converts exactly once. `**/` maps
  // to an OPTIONAL prefix - zero segments included - so `**/generated/**`
  // also matches a root-level `generated/`.
  const source = String(glob)
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((tok) => {
      if (tok === '**/') return '(?:.*/)?';
      if (tok === '**') return '.*';
      if (tok === '*') return '[^/]*';
      if (tok === '?') return '.';
      return tok.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  try {
    return new RegExp(`(^|/)${source}$`);
  } catch {
    return null; // malformed pattern: drop it, never throw
  }
}

function isEnvExempt(filePath) {
  const raw = process.env.GATEGUARD_EXEMPT_GLOBS || '';
  if (!raw) return false;
  const norm = normalizeForMatch(filePath);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(globToRegex)
    .filter(Boolean)
    .some((re) => re.test(norm));
}

// --- Edit extraction (per dialect) ---
//
// Returns { edits: [{ path, create }], recognized }: `recognized` is false
// when this tool call isn't a file edit we gate (allow it through). One call
// may carry several edits: a Codex apply_patch envelope can Add/Update/Delete/
// Move multiple files in a single patch.

// Parse an apply_patch command envelope into its file operations. The four
// file-declaring lines are the only ones that name a path:
//   *** Add File: <p>      (create)   *** Delete File: <p>  (edit: a removal)
//   *** Update File: <p>   (edit)     *** Move to: <p>      (rename target)
function parseApplyPatch(command) {
  const edits = [];
  for (const line of String(command || '').split('\n')) {
    let m;
    if ((m = /^\*\*\* Add File:\s*(.+?)\s*$/.exec(line))) edits.push({ path: m[1], create: true });
    else if ((m = /^\*\*\* Update File:\s*(.+?)\s*$/.exec(line)))
      edits.push({ path: m[1], create: false });
    else if ((m = /^\*\*\* Delete File:\s*(.+?)\s*$/.exec(line)))
      edits.push({ path: m[1], create: false });
    else if ((m = /^\*\*\* Move to:\s*(.+?)\s*$/.exec(line)))
      edits.push({ path: m[1], create: true });
  }
  return edits;
}

function copilotArgs(input) {
  let args = input.toolArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args); // Copilot may stringify the args blob
    } catch {
      args = {};
    }
  }
  return args && typeof args === 'object' ? args : {};
}

function extractEdits(input, dialect) {
  if (dialect === 'copilot') {
    const toolName = String(input.toolName || '');
    if (!COPILOT_EDIT_TOOLS.has(toolName)) return { edits: [], recognized: false };
    const args = copilotArgs(input);
    const p = args.path || args.file_path || args.filePath || args.filepath || '';
    // Unextractable path → allow, mark nothing (we can't gate what we can't name).
    if (!p || typeof p !== 'string') return { edits: [], recognized: false };
    return { edits: [{ path: p, create: toolName === 'create' }], recognized: true };
  }

  // snake: Claude edit tools or Codex apply_patch
  const toolName = String(input.tool_name || '');
  const toolInput = input.tool_input || {};
  if (toolName === 'apply_patch') {
    const edits = parseApplyPatch(toolInput.command);
    return { edits, recognized: true };
  }
  if (CLAUDE_EDIT_TOOLS.has(toolName)) {
    const p = String(toolInput.file_path || toolInput.notebook_path || '');
    if (!p) return { edits: [], recognized: false };
    // Only Claude's Write distinguishes create-vs-overwrite via the filesystem;
    // Edit/MultiEdit/NotebookEdit always target an existing file.
    const create = toolName === 'Write' && !fs.existsSync(p);
    return { edits: [{ path: p, create }], recognized: true };
  }
  return { edits: [], recognized: false };
}

function isSubagent(input) {
  const ids = [input.agent_id, input.agentId, input.parent_tool_use_id, input.parentToolUseId];
  return ids.some((v) => typeof v === 'string' && v.trim());
}

// --- Per-session state: one empty marker file per gated path ---
//
// A marker file is created atomically per (session, file) pair, so parallel
// first-edits to different files can never clobber each other's marks: the
// failure mode a single shared JSON has (read-modify-write race), which
// would let a file be denied twice. The denial ordinal is simply the number
// of markers already in the session dir.

function sessionDir(sessionId, input) {
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

function markerPath(dir, filePath) {
  return path.join(dir, crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 32));
}

function countMarkers(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

// Atomically claim the (session, file) marker with an exclusive create, so
// even two parallel edits of the SAME file can't both deny. Returns 'ok' if
// this call claimed it, 'exists' if it was already claimed (allow: this file
// was gated before), or 'fail' on any other error (allow: fail open).
function claimMarker(dir, filePath) {
  try {
    fs.writeFileSync(markerPath(dir, filePath), '', { flag: 'wx' });
    return 'ok';
  } catch (err) {
    return err && err.code === 'EEXIST' ? 'exists' : 'fail';
  }
}

function pruneStaleState() {
  try {
    const now = Date.now();
    for (const d of fs.readdirSync(STATE_DIR)) {
      const dp = path.join(STATE_DIR, d);
      try {
        if (now - fs.statSync(dp).mtimeMs > STALE_MS) fs.rmSync(dp, { recursive: true, force: true });
      } catch {
        /* dir vanished between readdir and stat/rm */
      }
    }
  } catch {
    /* no state dir yet */
  }
}

// --- Messages ---

function sanitizePath(filePath) {
  let out = '';
  for (const ch of String(filePath || '')) {
    const code = ch.codePointAt(0);
    const control = code <= 0x1f || code === 0x7f;
    const bidi =
      (code >= 0x200e && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    out += control || bidi ? ' ' : ch;
  }
  return out.trim().slice(0, 500);
}

// A single path renders exactly as the original one-file message; multiple
// paths (a Codex multi-file patch) list them together.
function pathLabel(paths) {
  return paths.map(sanitizePath).join(', ');
}

// The closing lines depend on which mode actually fired: deny blocks the
// call, so a retry is required and meaningful; warn lets the call through
// immediately, so there is nothing to retry.
function closingLines(mode, verb) {
  return mode === 'deny'
    ? [
        `Present the facts, then retry the same ${verb}: the retry always passes.`,
        '(GATEGUARD_DISABLED=1 turns this gate off; GATEGUARD_WARN=1 demotes it to a warning.)',
      ]
    : [
        `This ${verb} is proceeding; present the facts above alongside it.`,
        '(GATEGUARD_DISABLED=1 turns this gate off; GATEGUARD_DENY=1 makes it block instead.)',
      ];
}

function editGateMsg(paths, mode) {
  const head =
    paths.length === 1
      ? `[GateGuard] First edit of ${sanitizePath(paths[0])} this session: before editing, present these facts:`
      : `[GateGuard] First edit of these files this session (${pathLabel(paths)}): before editing, present these facts:`;
  return [
    head,
    '',
    '1. Importers/callers: list the files that import or call this one (search the tree: Grep/Glob, not memory).',
    '2. Blast radius: the public functions/classes/exports this change affects.',
    '3. Data schemas: if this file reads/writes data, show real field names and formats (redacted or synthetic values).',
    "4. The user's current instruction, quoted verbatim.",
    '',
    ...closingLines(mode, 'edit'),
  ].join('\n');
}

function createGateMsg(paths, mode) {
  const head =
    paths.length === 1
      ? `[GateGuard] Creating ${sanitizePath(paths[0])}: before writing it, present these facts:`
      : `[GateGuard] Creating these files (${pathLabel(paths)}): before writing them, present these facts:`;
  return [
    head,
    '',
    '1. Callers: name the file(s) and line(s) that will use this new file.',
    '2. No duplicate: confirm no existing file serves the same purpose (search the tree first).',
    '3. Data schemas: if it reads/writes data, show real field names and formats (redacted or synthetic values).',
    "4. The user's current instruction, quoted verbatim.",
    '',
    ...closingLines(mode, 'write'),
  ].join('\n');
}

// After the full-block budget, condense to one line carrying the denial
// ordinal so repeated denials never accumulate identical blocks in context.
function condensedMsg(paths, ordinal, mode) {
  const what =
    paths.length === 1 ? `First edit of ${sanitizePath(paths[0])}` : `First edit of ${pathLabel(paths)}`;
  const tail =
    mode === 'deny'
      ? "briefly state importers/callers, blast radius, data schemas if any, and the user's instruction, then retry."
      : "briefly state importers/callers, blast radius, data schemas if any, and the user's instruction alongside it.";
  const label = mode === 'deny' ? `denial #${ordinal}` : `reminder #${ordinal}`;
  return `[GateGuard] (${label} this session) ${what}: ${tail}`;
}

// --- Repeat-edit notice ---
//
// Warns when REPEAT_MIN_TOUCHES or more of the git user's own last
// REPEAT_OWN_WINDOW landed changes on the default branch edited the file being
// edited. The check fails open: any git failure yields no notice, and only an
// unexpected one (not a missing git binary or a non-repository) is reported,
// once, on stderr.

const REPEAT_MIN_TOUCHES = 2;
const REPEAT_OWN_WINDOW = 5;
// How many of the newest first-parent commits are read to find the user's
// own, so the walk stays bounded in a busy repo the user rarely commits to.
const REPEAT_SCAN = 100;
const REPEAT_DEADLINE_MS = 3000;

// First that exists wins. HEAD is deliberately not a fallback: on a topic
// branch with no origin/HEAD it would count the branch's own commits.
const DEFAULT_REFS = [
  'refs/remotes/origin/HEAD',
  'refs/remotes/origin/main',
  'refs/remotes/origin/master',
  'refs/heads/main',
  'refs/heads/master',
];

// Matched against the repo-relative path, at any depth and in any case. Churn
// in these is expected, so it is not a runaway signal. No bare `lock`
// substring: it would match block.js.
const REPEAT_EXEMPT_RES = [
  /(^|\/)(?:tests?|__tests__|fixtures?)\//i,
  /\.(?:test|spec)\.[^/]+$/i,
  /(^|\/)test_[^/]*$|_test\.[^/]+$/i,
  /(^|\/)docs\//i,
  /(^|\/)(?:AGENTS|CLAUDE|README|CHANGELOG)(?:\.[^/]*)?$/i,
  /(^|\/)\.ai-style-rules\.md$/i,
  /(^|\/)\.github\/(?:instructions\/|copilot-instructions\.md$)/i,
  /(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|composer\.lock|go\.sum)$/i,
];

// Each call gets the time left until `deadline`, so one hook run spends at
// most REPEAT_DEADLINE_MS on git however many paths it checks.
function runGit(cwd, args, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) {
    const err = new Error('time limit spent');
    err.code = 'EDEADLINE';
    throw err;
  }
  return childProcess.execFileSync('git', args, {
    cwd,
    timeout: Math.ceil(left),
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

// '' for an expected absence (no git binary, not a repository); otherwise a
// short single-line reason.
function gitFailureReason(err) {
  const stderr = String((err && err.stderr) || '');
  if ((err && err.code === 'ENOENT') || stderr.includes('not a git repository')) return '';
  let reason;
  if (err && err.code === 'EDEADLINE') reason = `the ${REPEAT_DEADLINE_MS} ms time limit was spent`;
  else if (err && err.code === 'ETIMEDOUT') reason = 'git timed out';
  else if (err && typeof err.status === 'number')
    reason = `git exited ${err.status}: ${stderr.trim().split('\n')[0] || 'no message'}`;
  else reason = String((err && err.message) || err);
  return reason.replace(/\s+/g, ' ').trim().slice(0, 200);
}

// The configured user.name and user.email, mapped through .mailmap the same
// way %aN/%aE map commit authors, then lowercased; '' for an unset one. `git
// config` exits 1 when no key matches, which is an absence, not a failure.
// Mailmap keys on email, so a name-only identity is used as configured.
function gitIdentity(cwd, deadline) {
  let out = '';
  try {
    out = runGit(cwd, ['config', '--get-regexp', '^user\\.(name|email)$'], deadline);
  } catch (err) {
    if (!(err && err.status === 1)) throw err;
  }
  const id = { name: '', email: '' };
  for (const line of out.split('\n')) {
    const m = /^user\.(name|email) (.*)$/.exec(line);
    if (m) id[m[1]] = m[2].trim();
  }
  if (id.email) {
    const ident = id.name ? `${id.name} <${id.email}>` : `<${id.email}>`;
    const m = /^(.*?)\s*<([^>]*)>$/.exec(runGit(cwd, ['check-mailmap', ident], deadline).trim());
    if (m) {
      if (m[1]) id.name = m[1];
      id.email = m[2];
    }
  }
  return { name: id.name.toLowerCase(), email: id.email.toLowerCase() };
}

// Returns { touches, seen, tip, failure, spent }: of the user's own newest
// REPEAT_OWN_WINDOW first-parent commits on the default branch (found among
// the newest REPEAT_SCAN, matched on the mailmapped author name or email),
// `seen` is how many there were and `touches` how many edited this file (exact
// repo-relative path match against one `git log --name-only`, so glob
// characters in a name never match another file). Also the sha of the user's
// newest own change (so a teammate's merge doesn't re-arm the notice), and ''
// or the reason an unexpected git failure stopped the check, plus
// `spent` when that failure was the shared deadline running out.
function ownTouches(absPath, deadline) {
  const none = { touches: 0, seen: 0, tip: '', failure: '' };
  try {
    const cwd = path.dirname(absPath);
    const rel = runGit(cwd, ['rev-parse', '--show-prefix'], deadline).trim() + path.basename(absPath);
    if (REPEAT_EXEMPT_RES.some((re) => re.test(rel))) return none;
    const me = gitIdentity(cwd, deadline);
    if (!me.name && !me.email) return none;
    const present = new Set(
      runGit(cwd, ['for-each-ref', '--format=%(refname)', ...DEFAULT_REFS], deadline)
        .split('\n')
        .filter(Boolean)
    );
    const ref = DEFAULT_REFS.find((r) => present.has(r));
    if (!ref) return none;
    const log = runGit(
      cwd,
      ['-c', 'diff.relative=false', 'log', '--first-parent', '-m', '-z', '-n', String(REPEAT_SCAN), '--format=%x01%H%x02%aN%x02%aE', '--name-only', ref],
      deadline
    );
    const commits = log
      .split('\x01')
      .slice(1)
      .map((chunk) => {
        // -z output is `<header>\0\n<file>\0<file>\0`: only the first name has the newline.
        const [header, ...files] = chunk.split('\0');
        const [hash, name, email] = header.split('\x02');
        return {
          hash,
          name: name.toLowerCase(),
          email: email.toLowerCase(),
          files: new Set(files.map((f) => f.replace(/^\n/, '')).filter(Boolean)),
        };
      });
    const own = commits
      .filter((c) => (me.name && c.name === me.name) || (me.email && c.email === me.email))
      .slice(0, REPEAT_OWN_WINDOW);
    const touches = own.filter((c) => c.files.has(rel)).length;
    return { touches, seen: own.length, tip: own.length ? own[0].hash : '', failure: '' };
  } catch (err) {
    const spent = !!err && (err.code === 'ETIMEDOUT' || err.code === 'EDEADLINE');
    return { ...none, failure: gitFailureReason(err), spent };
  }
}

function repeatEditMsg(touches, seen, filePath) {
  return `[GateGuard] Repeat edit: ${touches} of your last ${seen} changes landed on the default branch edited ${sanitizePath(filePath)}, so this would be another. Before the next request for a commit, PR, or spend yes, tell the user that count and any spend so far and ask whether to continue or stop; a yes to the single step does not answer that. A subagent reports this line to its caller. Running autonomously, put it in the recap.`;
}

// A subagent's id, else 'parent', so a subagent's claim never consumes the
// parent's notice for the same path and tip (same four fields as isSubagent).
function agentKey(input) {
  const ids = [input.agent_id, input.agentId, input.parent_tool_use_id, input.parentToolUseId];
  return ids.find((v) => typeof v === 'string' && v.trim()) || 'parent';
}

function skippedLine(filePath, reason) {
  return `[GateGuard] repeat-edit check skipped for ${sanitizePath(filePath)}: ${reason}. The notice did not run; check that git works in that directory.\n`;
}

// Returns '' or the notice lines for edits whose file is due one. Each
// (agent, path, user's newest own change) triple is claimed once in a sibling
// dir of the session dir, so countMarkers ordinals don't move, stale pruning
// still covers it, and a session is re-warned only after the user lands
// another change. All git calls share one
// REPEAT_DEADLINE_MS deadline; once it is spent the remaining paths are skipped
// with a single diagnostic.
function repeatEditNotice(edits, input, dir) {
  const base = String((input && input.cwd) || process.cwd());
  const repeatDir = `${dir}-repeat`;
  const agent = agentKey(input || {});
  const deadline = Date.now() + REPEAT_DEADLINE_MS;
  const lines = [];
  for (const e of edits) {
    if (e.create) continue;
    if (Date.now() >= deadline) {
      process.stderr.write(skippedLine(e.path, gitFailureReason({ code: 'EDEADLINE' })));
      break;
    }
    const abs = path.resolve(base, e.path);
    const { touches, seen, tip, failure, spent } = ownTouches(abs, deadline);
    if (failure) {
      process.stderr.write(skippedLine(e.path, failure));
      if (spent) break; // the shared time is gone: skip the rest
      continue;
    }
    if (touches < REPEAT_MIN_TOUCHES) continue;
    try {
      fs.mkdirSync(repeatDir, { recursive: true });
    } catch {
      /* the claim below fails and the notice is skipped */
    }
    if (claimMarker(repeatDir, `${agent}\n${abs}\n${tip}`) !== 'ok') continue;
    lines.push(repeatEditMsg(touches, seen, e.path));
  }
  return lines.join('\n');
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    // Unparseable input: allow. We don't know the dialect, so emit the
    // universally-safe explicit allow (Copilot needs it; snake ignores it).
    process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
    process.exit(0);
  }

  const dialect = detectDialect(input);

  if (process.env.GATEGUARD_DISABLED === '1') {
    emitAllow(dialect);
    process.exit(0);
  }

  const { edits, recognized } = extractEdits(input, dialect);
  if (!recognized || edits.length === 0) {
    emitAllow(dialect);
    process.exit(0);
  }

  // Drop exempt paths (built-in skips + user globs). If every path is exempt,
  // there's nothing to gate.
  const gatable = edits.filter((e) => !isBuiltinExempt(e.path) && !isEnvExempt(e.path));
  if (gatable.length === 0) {
    emitAllow(dialect);
    process.exit(0);
  }

  // Subagent calls: the parent session owns the fact gate, so a subagent gets
  // only the repeat-edit notice. (Claude only carries these fields; a no-op
  // for Codex/Copilot.)
  if (isSubagent(input)) {
    const subNotice = repeatEditNotice(
      gatable,
      input,
      sessionDir(input.session_id || input.sessionId, input)
    );
    if (subNotice) emitWarn(dialect, subNotice);
    else emitAllow(dialect);
    process.exit(0);
  }

  pruneStaleState();
  const dir = sessionDir(input.session_id || input.sessionId, input);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* claim will fail-open below if the dir truly can't be made */
  }

  // Mark at deny time so the retry passes: this is what makes the gate
  // loop-free. Claim every unchecked path; if a claim can't persist, fail open.
  const ordinalBase = countMarkers(dir);
  const newlyGated = [];
  for (const e of gatable) {
    const res = claimMarker(dir, e.path);
    if (res === 'fail') {
      process.stderr.write(
        '[GateGuard] state could not be persisted; allowing the edit to avoid a deny loop.\n'
      );
      emitAllow(dialect);
      process.exit(0);
    }
    if (res === 'ok') newlyGated.push(e);
  }

  // Computed on every edit, after the claims, so a path that could not be
  // recorded above has already allowed without a notice.
  const notice = repeatEditNotice(gatable, input, dir);

  // Every path was already gated once this session → allow (loop-free retry),
  // carrying the repeat-edit notice when one is due.
  if (newlyGated.length === 0) {
    if (notice) emitWarn(dialect, notice);
    else emitAllow(dialect);
    process.exit(0);
  }

  const paths = newlyGated.map((e) => e.path);
  const creatingAll = newlyGated.every((e) => e.create);
  const ordinal = ordinalBase + 1;
  const fullBudget = intEnv('GATEGUARD_FULL_DENIALS', 3);

  // Default is warn: the marker was claimed above whenever the hook fires,
  // in either mode, which is what makes the gate once-per-file and
  // loop-free regardless of whether this call ends up denying or warning.
  // Because the marker is claimed either way, the gate can never verify the
  // demanded facts were actually presented, only that the file was touched
  // once. A measured A/B (see docs/hooks.md) found the
  // deny-and-retry loop cost ~20% more turns for an identical edit, no
  // accuracy gain. Copilot keeps deny by default because its warn path has
  // no soft channel (emitWarn degrades to allow + stderr).
  const deny =
    process.env.GATEGUARD_DENY === '1' ||
    (dialect === 'copilot' && process.env.GATEGUARD_WARN !== '1');
  const mode = deny ? 'deny' : 'warn';
  const reason =
    ordinal > fullBudget
      ? condensedMsg(paths, ordinal, mode)
      : creatingAll
        ? createGateMsg(paths, mode)
        : editGateMsg(paths, mode);
  const full = notice ? `${reason}\n\n${notice}` : reason;

  if (deny) emitDeny(dialect, full);
  else emitWarn(dialect, full);
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[GateGuard] ${err && err.message}\n`);
  // Fail open. Emit the explicit allow so a fail-closed harness (Copilot)
  // never denies just because the gate threw; snake harnesses ignore it.
  try {
    process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
  } catch {
    /* stdout gone, nothing more we can do */
  }
  process.exit(0);
}
