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
 * FAIL OPEN everywhere else: subagent tool calls skip the gate (the parent
 * session owns it), malformed stdin exits 0, and if the state dir can't be
 * created the edit is ALLOWED with a stderr note, since the Skill branch
 * could never stamp on such a machine and a deny would loop forever.
 *
 * Config (env):
 *   PLANGATE_DISABLED  "1" turns the gate off entirely.
 *   PLANGATE_WARN      "1" demotes deny to a non-blocking warning.
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

function isSubagent(input) {
  const ids = [input.agent_id, input.agentId, input.parent_tool_use_id, input.parentToolUseId];
  return ids.some((v) => typeof v === 'string' && v.trim());
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

// Does this Skill call name plan-and-track? Check the likely fields first (no
// captured Skill PreToolUse payload existed when this was written), then fall
// back to scanning every string value of tool_input: over-stamping merely
// un-gates one session, while under-recognition would deadlock the gate.
function namesPlanAndTrack(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return false;
  for (const field of [toolInput.skill, toolInput.name, toolInput.command]) {
    if (typeof field === 'string' && field.includes('plan-and-track')) return true;
  }
  return Object.values(toolInput).some((v) => typeof v === 'string' && v.includes('plan-and-track'));
}

// --- Messages ---

function gateMsg() {
  return [
    '[PlanGate] Writes to tasks/todo.md are gated: invoke the plan-and-track Skill via the Skill tool first (it loads the reconcile/lessons/checklist steps), then retry this edit.',
    '(PLANGATE_DISABLED=1 turns this gate off; PLANGATE_WARN=1 demotes it to a warning.)',
  ].join('\n');
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    process.exit(0); // unparseable input: allow (Claude's PreToolUse fails open on silence)
  }

  if (process.env.PLANGATE_DISABLED === '1') process.exit(0);

  // Subagent calls: the parent session owns the gate (gateguard's precedent).
  // A delegated executor without the Skill tool must never be deadlocked here.
  if (isSubagent(input)) process.exit(0);

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

  // Edit branch: gate tasks/todo.md writes on the stamp.
  if (!EDIT_TOOLS.has(toolName)) process.exit(0);
  const norm = String(toolInput.file_path || '').replace(/\\/g, '/');
  if (!/(^|\/)tasks\/todo\.md$/.test(norm)) process.exit(0);

  if (fs.existsSync(stampPath(input.session_id, input))) process.exit(0);

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    // Unwritable state dir: the Skill branch could never stamp, so a deny
    // here would loop forever. Fail open with a note.
    process.stderr.write('[PlanGate] state dir could not be created; allowing the edit.\n');
    process.exit(0);
  }

  if (process.env.PLANGATE_WARN === '1') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: gateMsg() + '\n(Warn-only mode: the edit proceeds.)',
        },
      })
    );
  } else {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: gateMsg(),
        },
      })
    );
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[PlanGate] ${err && err.message}\n`);
  process.exit(0);
}
