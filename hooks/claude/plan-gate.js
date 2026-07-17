#!/usr/bin/env node
/**
 * Plan Gate: plan-and-track enforcement for tasks/todo.md (Claude Code only)
 *
 * A PreToolUse hook (registered for Skill|Edit|Write|MultiEdit) that denies
 * every Edit/Write/MultiEdit to `tasks/todo.md` until the plan-and-track
 * Skill has been invoked this session. A plan written straight into
 * tasks/todo.md skips the skill's reconcile/lessons/checklist steps, and
 * attention-based fixes (description wording, digest lines) don't reach
 * mid-session self-initiated planning, so per this repo's thesis the rule is
 * enforced by the harness: a Skill call naming plan-and-track stamps the
 * session; edits to tasks/todo.md check for the stamp.
 *
 * UNLIKE GATEGUARD, REPEATED DENIAL IS INTENTIONAL. Gateguard marks a file
 * "checked" at deny time so the retry always passes; this gate denies every
 * todo.md write until the external unlock (the Skill invocation). The two
 * gates never double-fire: gateguard exempts tasks/todo.md.
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
 * write to an executor/mechanic before ever invoking the Skill.
 *
 * FAIL OPEN everywhere else: malformed stdin exits 0, and if the state dir
 * can't be created the edit is ALLOWED with a stderr note, since the Skill
 * branch could never stamp on such a machine and a deny would loop forever.
 *
 * SCOPE GATE: a session that never touches tasks/todo.md at all still needs
 * catching (a competing-pressure prompt like "just hack it in" can skip
 * planning and go straight to source edits). Once a session's distinct
 * edited-file count reaches PLANGATE_SCOPE_THRESHOLD (default 3, since a
 * one- or two-file fix-plus-its-test is legitimately plan-free) without a
 * plan-and-track stamp, every further Edit/Write/MultiEdit is denied the
 * same hard way as the tasks/todo.md gate. "3+ distinct files" is the
 * observable proxy for the "3+ steps" core rule a hook can actually measure.
 * Marker files record each *allowed* edit's normalized path (sha256-keyed,
 * next to the session's stamp file) so a denied edit is never counted and
 * repeated denials can't inflate the total.
 *
 * Config (env):
 *   PLANGATE_DISABLED        "1" turns the gate off entirely.
 *   PLANGATE_WARN            "1" demotes deny to a non-blocking warning.
 *   PLANGATE_SCOPE_THRESHOLD distinct-file count that trips the scope gate
 *                             (default 3).
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

// Paths the scope count ignores: tasks/todo.md (already gated on its own),
// tasks/lessons.md and .claude/settings*.json (rule-forced/hook-repair
// edits, mirroring gateguard's isBuiltinExempt). Case-insensitive: NTFS
// treats these paths case-insensitively, same rationale as the todo.md gate.
function isScopeExempt(norm) {
  return (
    /(^|\/)tasks\/(todo|lessons)\.md$/i.test(norm) ||
    /(^|\/)\.claude\/settings(?:\.[^/]+)?\.json$/i.test(norm)
  );
}

function filesDir(sessionId, input) {
  return stampPath(sessionId, input) + '.files';
}

function fileMarkerPath(sessionId, input, norm) {
  const hash = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 32);
  return path.join(filesDir(sessionId, input), hash);
}

function distinctFileCount(sessionId, input) {
  try {
    return fs.readdirSync(filesDir(sessionId, input)).length;
  } catch {
    return 0;
  }
}

// --- Messages ---

function gateMsg() {
  return [
    '[PlanGate] Writes to tasks/todo.md are gated: invoke the plan-and-track Skill via the Skill tool first (it loads the reconcile/lessons/checklist steps), then retry this edit.',
    '(PLANGATE_DISABLED=1 turns this gate off; PLANGATE_WARN=1 demotes it to a warning.)',
  ].join('\n');
}

function scopeMsg(threshold) {
  return [
    `[PlanGate] This session has touched ${threshold} distinct files without a plan: invoke the plan-and-track Skill via the Skill tool first (it loads the reconcile/lessons/checklist steps), then retry this edit.`,
    '(PLANGATE_SCOPE_THRESHOLD sets the file-count trigger, default 3; PLANGATE_DISABLED=1 turns this gate off; PLANGATE_WARN=1 demotes it to a warning.)',
  ].join('\n');
}

function emitGateDecision(msg) {
  if (process.env.PLANGATE_WARN === '1') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: msg + '\n(Warn-only mode: the edit proceeds.)',
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

  // Edit branch. Case-insensitive throughout: install.ps1 deploys this hook
  // on Windows, where NTFS treats tasks\todo.md and TASKS\TODO.MD (etc.) as
  // the same file.
  if (!EDIT_TOOLS.has(toolName)) process.exit(0);
  const norm = String(toolInput.file_path || '').replace(/\\/g, '/');
  const stamp = stampPath(input.session_id, input);

  // tasks/todo.md gate: unchanged behavior, own message.
  if (/(^|\/)tasks\/todo\.md$/i.test(norm)) {
    if (fs.existsSync(stamp)) process.exit(0);
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    } catch {
      // Unwritable state dir: the Skill branch could never stamp, so a deny
      // here would loop forever. Fail open with a note.
      process.stderr.write('[PlanGate] state dir could not be created; allowing the edit.\n');
      process.exit(0);
    }
    emitGateDecision(gateMsg());
    process.exit(0);
  }

  // Scope gate: deny once the session's distinct edited-file count reaches
  // the threshold without a stamp. No-op for exempt paths or once stamped.
  if (!norm || isScopeExempt(norm) || fs.existsSync(stamp)) process.exit(0);

  const threshold = Number(process.env.PLANGATE_SCOPE_THRESHOLD) || 3;
  const marker = fileMarkerPath(input.session_id, input, norm);
  const alreadyCounted = fs.existsSync(marker);
  const wouldBeCount = alreadyCounted ? distinctFileCount(input.session_id, input) : distinctFileCount(input.session_id, input) + 1;

  if (wouldBeCount >= threshold) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    } catch {
      process.stderr.write('[PlanGate] state dir could not be created; allowing the edit.\n');
      process.exit(0);
    }
    emitGateDecision(scopeMsg(threshold));
    process.exit(0);
  }

  // Allowed: record this file so a future edit doesn't re-count it, and
  // repeated denials of an unrecorded file never inflate the total.
  try {
    fs.mkdirSync(filesDir(input.session_id, input), { recursive: true });
    fs.writeFileSync(marker, '');
  } catch {
    /* best effort: worst case a later edit re-checks the same file */
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[PlanGate] ${err && err.message}\n`);
  process.exit(0);
}
