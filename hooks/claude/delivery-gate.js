#!/usr/bin/env node
/**
 * Delivery Gate (Claude Code only)
 *
 * A Stop hook that runs deterministic pre-finish checks at the harness layer —
 * the "verify before done" + "capture-lesson" + "checkpoint state" standing
 * rules, enforced where the model can't skip them. It is the Claude-native
 * counterpart to those rules; Copilot/Codex have no "block finish" event, so
 * they rely on the guidance in the rules digest instead.
 *
 * DEFAULT: WARN-ONLY. It surfaces a `systemMessage` and always allows the stop.
 * A Stop hook that traps the user in a loop is worse than the problem it solves,
 * so blocking is strictly opt-in (DELIVERY_GATE_BLOCK=1) and self-limiting: it
 * blocks at most once per turn (honoring `stop_hook_active`), never repeatedly.
 *
 * Checks (heuristic — all WARN):
 *  - Complex session (>= EDIT_THRESHOLD edits) that never checkpointed to
 *    tasks/todo.md.
 *  - Rationalization language in recent assistant text ("good enough", "should
 *    work", "didn't run", ...) → nudge to actually verify.
 *  - Low free disk on the working directory.
 *
 * Self-contained: Node core only (Claude Code ships Node). Two transcript reads,
 * each matched to what the signal needs — Stop fires once per turn-end, so both
 * are affordable:
 *  - Edit count + tasks/todo.md checkpoint: a full streaming pass over the whole
 *    JSONL. These are session-wide facts; a bounded tail would miss edits (or a
 *    real checkpoint) that scrolled past it in a long session and misjudge the
 *    session as simple / un-checkpointed.
 *  - Rationalization: a bounded tail only — we deliberately want *recent* text,
 *    so an early phrase later resolved doesn't trip the gate at finish time.
 *
 * Config (env):
 *   DELIVERY_GATE_BLOCK        "1" to block (opt-in). Default: warn-only.
 *   DELIVERY_GATE_EDIT_THRESHOLD   edits before "complex session" (default 3).
 *   DELIVERY_GATE_TAIL_BYTES   recent-text tail for rationalization
 *                              (default 2097152 = 2MB).
 *   DELIVERY_GATE_MIN_DISK_MB  warn under this many MB free (default 500; 0 off).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');

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

// Bounded tail of the transcript, split into parsed JSONL objects. Drops a
// leading partial line when we started mid-file.
function readTranscriptTail(transcriptPath, maxTail) {
  if (!transcriptPath) return [];
  let text;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const readBytes = Math.min(size, maxTail);
    const buf = Buffer.alloc(readBytes);
    if (readBytes > 0) fs.readSync(fd, buf, 0, readBytes, size - readBytes);
    text = buf.toString('utf8');
    if (readBytes < size) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip partial/non-JSON line */
    }
  }
  return out;
}

// Stream a file line-by-line, synchronously, without loading it all at once.
// StringDecoder carries partial multibyte UTF-8 sequences across chunk reads.
function forEachLine(filePath, fn) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return;
  }
  const decoder = new StringDecoder('utf8');
  const buf = Buffer.alloc(1 << 20); // 1 MB chunks
  let leftover = '';
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      leftover += decoder.write(buf.subarray(0, bytes));
      let nl;
      while ((nl = leftover.indexOf('\n')) >= 0) {
        fn(leftover.slice(0, nl));
        leftover = leftover.slice(nl + 1);
      }
    }
    leftover += decoder.end();
    if (leftover) fn(leftover);
  } catch {
    /* partial read — use what we got */
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const RATIONALIZATION = [
  /\bgood enough\b/i,
  /\bshould (?:work|be fine)\b/i,
  /\bprobably (?:works|fine|correct)\b/i,
  /\bi'?ll assume\b/i,
  /\b(?:skip|skipping) (?:the )?tests?\b/i,
  /\b(?:without|didn'?t|haven'?t) (?:run|running|test|testing|verif)/i,
  /\bcan'?t (?:verify|test)\b/i,
  /\bassuming (?:it|this|that) works\b/i,
];

// Full streaming pass over the whole transcript: session-wide edit count and
// whether tasks/todo.md was ever checkpointed. Must see the entire session, so
// it can't rely on a bounded tail.
function scanEditsAndCheckpoint(transcriptPath) {
  let edits = 0;
  let touchedTodo = false;
  if (!transcriptPath) return { edits, touchedTodo };
  forEachLine(transcriptPath, (line) => {
    const t = line.trim();
    if (!t) return;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      return;
    }
    const msg = obj && obj.message;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return;
    for (const block of msg.content) {
      if (!block || block.type !== 'tool_use' || !EDIT_TOOLS.has(block.name)) continue;
      edits++;
      const fp =
        (block.input && (block.input.file_path || block.input.notebook_path)) || '';
      if (typeof fp === 'string' && /tasks\/todo\.md$/.test(fp)) touchedTodo = true;
    }
  });
  return { edits, touchedTodo };
}

// Rationalization scan over recent assistant text only (the bounded tail) — a
// phrase early in a long session that was later resolved shouldn't trip the gate.
function scanRationalization(entries) {
  const texts = [];
  for (const obj of entries) {
    const msg = obj && obj.message;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      }
    }
  }
  const recent = texts.slice(-6).join('\n');
  return RATIONALIZATION.some((re) => re.test(recent));
}

function freeDiskMB(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Math.floor((st.bavail * st.bsize) / (1024 * 1024));
  } catch {
    return null; // statfsSync is newer Node; skip the check if unavailable.
  }
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    input = {};
  }

  // Already fired once this turn → allow the stop through (never trap the user).
  if (input && input.stop_hook_active === true) {
    process.exit(0);
  }

  const transcriptPath =
    input && typeof input.transcript_path === 'string' ? input.transcript_path : '';
  const cwd = (input && typeof input.cwd === 'string' && input.cwd) || process.cwd();

  const editThreshold = intEnv('DELIVERY_GATE_EDIT_THRESHOLD', 3) || 3;
  const tailBytes = intEnv('DELIVERY_GATE_TAIL_BYTES', 2 * 1024 * 1024) || 2 * 1024 * 1024;
  const minDiskMB = intEnv('DELIVERY_GATE_MIN_DISK_MB', 500);

  // Session-wide facts from the full transcript; recent text from a bounded tail.
  const { edits, touchedTodo } = scanEditsAndCheckpoint(transcriptPath);
  const rationalized = scanRationalization(readTranscriptTail(transcriptPath, tailBytes));

  const warnings = [];
  if (edits >= editThreshold && !touchedTodo) {
    warnings.push(
      `Complex session (${edits} edits) but tasks/todo.md was never updated — checkpoint your plan/state before finishing (plan-and-track).`
    );
  }
  if (rationalized) {
    warnings.push(
      `Recent text reads like an unverified claim ("good enough"/"should work"/"didn't test") — verify before done: run it, show the output.`
    );
  }
  if (minDiskMB > 0) {
    const free = freeDiskMB(cwd);
    if (free !== null && free < minDiskMB) {
      warnings.push(`Low free disk on the working directory (~${free} MB) — builds/tests may fail.`);
    }
  }

  if (warnings.length === 0) {
    process.exit(0);
  }

  const body =
    '[DeliveryGate] Pre-finish checks:\n' + warnings.map((w) => `  • ${w}`).join('\n');

  if (process.env.DELIVERY_GATE_BLOCK === '1') {
    // Opt-in blocking: block THIS stop once. Because stop_hook_active is set on
    // the retry, the next stop attempt passes straight through — override by
    // simply stopping again.
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: body + '\n(Address these, or stop again to override.)',
      })
    );
    process.exit(0);
  }

  // Default: warn-only. Surface a message, allow the stop.
  process.stdout.write(JSON.stringify({ systemMessage: body }));
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[DeliveryGate] ${err && err.message}\n`);
  process.exit(0);
}
