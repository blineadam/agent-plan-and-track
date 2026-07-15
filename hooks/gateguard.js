#!/usr/bin/env node
/**
 * GateGuard: universal fact-forcing edit gate (Claude Code, Codex, Copilot CLI)
 *
 * A PreToolUse gate that denies the FIRST edit to each file per session with a
 * fact demand: importers/callers, blast radius, real data schemas, the user's
 * verbatim instruction, instead of letting the model guess. Self-evaluation
 * ("are you sure?") always gets "yes"; demanding facts forces a real search,
 * and the investigation itself improves the edit. Adapted (lean) from ECC's
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
 * state at deny time, so the retry after presenting facts always passes. A file
 * can never be denied twice. If state can't be persisted, the edit is ALLOWED
 * with a stderr warning: never deny what we can't record, or the model would
 * be denied forever.
 *
 * Deliberately not ported from ECC: the destructive-Bash and routine-Bash
 * gates. Each harness's own permission system already covers destructive
 * commands, and a once-per-session gate on the first Bash call is friction
 * without signal.
 *
 * Skipped: subagent tool calls (the parent session owns the gate),
 * `.claude/settings*.json` (hook repair must never be blocked), and
 * `tasks/todo.md` / `tasks/lessons.md` (our own rules force frequent edits
 * there; they have no importers or schemas to investigate).
 *
 * Config (env):
 *   GATEGUARD_DISABLED      "1" turns the gate off entirely.
 *   GATEGUARD_WARN          "1" demotes deny to a non-blocking warning
 *                           (fact demand injected as additionalContext where
 *                           the harness has a soft channel; Copilot has none,
 *                           so warn there = allow + stderr note).
 *   GATEGUARD_EXEMPT_GLOBS  comma-separated globs to exempt
 *                           (`*` within a segment, `**` across, `?` one char).
 *   GATEGUARD_FULL_DENIALS  denials per session that get the full fact block
 *                           before condensing to one line (default 3).
 */
'use strict';

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
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: reason + '\n(Warn-only mode: the edit proceeds.)',
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
    /(^|\/)tasks\/(?:todo|lessons)\.md$/.test(norm)
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

function editGateMsg(paths) {
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
    'Present the facts, then retry the same edit: the retry always passes.',
    '(GATEGUARD_DISABLED=1 turns this gate off; GATEGUARD_WARN=1 demotes it to a warning.)',
  ].join('\n');
}

function createGateMsg(paths) {
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
    'Present the facts, then retry the same write: the retry always passes.',
    '(GATEGUARD_DISABLED=1 turns this gate off; GATEGUARD_WARN=1 demotes it to a warning.)',
  ].join('\n');
}

// After the full-block budget, condense to one line carrying the denial
// ordinal so repeated denials never accumulate identical blocks in context.
function condensedMsg(paths, ordinal) {
  const what =
    paths.length === 1 ? `First edit of ${sanitizePath(paths[0])}` : `First edit of ${pathLabel(paths)}`;
  return (
    `[GateGuard] (denial #${ordinal} this session) ${what}: ` +
    "briefly state importers/callers, blast radius, data schemas if any, and the user's instruction, then retry."
  );
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

  // Subagent calls: the parent session owns the gate. (Claude only carries
  // these fields; a no-op for Codex/Copilot.)
  if (isSubagent(input)) {
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

  // Every path was already gated once this session → allow (loop-free retry).
  if (newlyGated.length === 0) {
    emitAllow(dialect);
    process.exit(0);
  }

  const paths = newlyGated.map((e) => e.path);
  const creatingAll = newlyGated.every((e) => e.create);
  const ordinal = ordinalBase + 1;
  const fullBudget = intEnv('GATEGUARD_FULL_DENIALS', 3);
  const reason =
    ordinal > fullBudget
      ? condensedMsg(paths, ordinal)
      : creatingAll
        ? createGateMsg(paths)
        : editGateMsg(paths);

  if (process.env.GATEGUARD_WARN === '1') emitWarn(dialect, reason);
  else emitDeny(dialect, reason);
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
