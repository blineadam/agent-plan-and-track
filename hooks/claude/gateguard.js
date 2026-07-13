#!/usr/bin/env node
/**
 * GateGuard (Claude Code only)
 *
 * A PreToolUse hook on Edit/Write/MultiEdit/NotebookEdit that denies the
 * FIRST edit to each file per session with a fact demand — importers/callers,
 * blast radius, real data schemas, the user's verbatim instruction — instead
 * of letting the model guess. Self-evaluation ("are you sure?") always gets
 * "yes"; demanding facts forces a real search, and the investigation itself
 * improves the edit. Adapted (lean) from ECC's gateguard-fact-force hook.
 *
 * LOOP-FREE BY CONSTRUCTION: the file is marked "checked" in session state at
 * deny time, so the retry after presenting facts always passes. A file can
 * never be denied twice. If state can't be persisted, the edit is ALLOWED
 * with a stderr warning — never deny what we can't record, or the model would
 * be denied forever.
 *
 * Deliberately not ported from ECC: the destructive-Bash and routine-Bash
 * gates. Claude Code's own permission system already covers destructive
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
 *                           (fact demand injected as additionalContext).
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
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

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
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape metachars, keep * and ?
    .split('**')
    .map((part) => part.replace(/\*/g, '[^/]*').replace(/\?/g, '.'))
    .join('.*');
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

// --- Per-session state: one empty marker file per gated path ---
//
// A marker file is created atomically per (session, file) pair, so parallel
// first-edits to different files can never clobber each other's marks — the
// failure mode a single shared JSON has (read-modify-write race), which
// would let a file be denied twice. The denial ordinal is simply the number
// of markers already in the session dir.

function sessionDir(input) {
  const sid = String((input && input.session_id) || '').trim();
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

// Mark the path checked and return the denial ordinal (1-based), or null on
// failure — the caller must then ALLOW (fail open).
function markChecked(dir, filePath) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const ordinal = fs.readdirSync(dir).length + 1;
    fs.writeFileSync(markerPath(dir, filePath), '');
    return ordinal;
  } catch {
    return null;
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

function editGateMsg(filePath) {
  return [
    `[GateGuard] First edit of ${sanitizePath(filePath)} this session — before editing, present these facts:`,
    '',
    '1. Importers/callers: list the files that import or call this one (search the tree — Grep/Glob, not memory).',
    '2. Blast radius: the public functions/classes/exports this change affects.',
    '3. Data schemas: if this file reads/writes data, show real field names and formats (redacted or synthetic values).',
    "4. The user's current instruction, quoted verbatim.",
    '',
    'Present the facts, then retry the same edit — the retry always passes.',
    '(GATEGUARD_DISABLED=1 turns this gate off; GATEGUARD_WARN=1 demotes it to a warning.)',
  ].join('\n');
}

function createGateMsg(filePath) {
  return [
    `[GateGuard] Creating ${sanitizePath(filePath)} — before writing it, present these facts:`,
    '',
    '1. Callers: name the file(s) and line(s) that will use this new file.',
    '2. No duplicate: confirm no existing file serves the same purpose (search the tree first).',
    '3. Data schemas: if it reads/writes data, show real field names and formats (redacted or synthetic values).',
    "4. The user's current instruction, quoted verbatim.",
    '',
    'Present the facts, then retry the same write — the retry always passes.',
    '(GATEGUARD_DISABLED=1 turns this gate off; GATEGUARD_WARN=1 demotes it to a warning.)',
  ].join('\n');
}

// After the full-block budget, condense to one line carrying the denial
// ordinal so repeated denials never accumulate identical blocks in context.
function condensedMsg(filePath, ordinal) {
  return (
    `[GateGuard] (denial #${ordinal} this session) First edit of ${sanitizePath(filePath)}: ` +
    "briefly state importers/callers, blast radius, data schemas if any, and the user's instruction, then retry."
  );
}

function emitDeny(reason) {
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

function emitWarn(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: reason + '\n(Warn-only mode: the edit proceeds.)',
      },
    })
  );
}

function main() {
  if (process.env.GATEGUARD_DISABLED === '1') process.exit(0);

  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    process.exit(0); // unparseable input: allow
  }

  if (!EDIT_TOOLS.has(String(input.tool_name || ''))) process.exit(0);

  // Subagent calls: the parent session owns the gate.
  const sub = [input.agent_id, input.agentId, input.parent_tool_use_id, input.parentToolUseId];
  if (sub.some((v) => typeof v === 'string' && v.trim())) process.exit(0);

  const toolInput = input.tool_input || {};
  const filePath = String(toolInput.file_path || toolInput.notebook_path || '');
  if (!filePath || isBuiltinExempt(filePath) || isEnvExempt(filePath)) process.exit(0);

  pruneStaleState();

  const dir = sessionDir(input);
  if (fs.existsSync(markerPath(dir, filePath))) process.exit(0); // already gated once

  // Mark at deny time so the retry passes — this is what makes the gate
  // loop-free. Fail open if the mark can't be persisted.
  const denials = markChecked(dir, filePath);
  if (denials === null) {
    process.stderr.write(
      '[GateGuard] state could not be persisted; allowing the edit to avoid a deny loop.\n'
    );
    process.exit(0);
  }

  const creating = input.tool_name === 'Write' && !fs.existsSync(filePath);
  const fullBudget = intEnv('GATEGUARD_FULL_DENIALS', 3);
  const reason =
    denials > fullBudget
      ? condensedMsg(filePath, denials)
      : creating
        ? createGateMsg(filePath)
        : editGateMsg(filePath);

  if (process.env.GATEGUARD_WARN === '1') emitWarn(reason);
  else emitDeny(reason);
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[GateGuard] ${err && err.message}\n`);
  process.exit(0);
}
