#!/usr/bin/env node
/**
 * Delivery Gate (Claude Code + Codex)
 *
 * A Stop hook that runs deterministic pre-finish checks at the harness layer:
 * the "verify before done" + "capture-lesson" + "checkpoint state" standing
 * rules, enforced where the model can't skip them. Both Claude Code and Codex
 * expose a Stop event with a Claude-shaped payload (`stop_hook_active`,
 * `transcript_path`, `last_assistant_message`) and accept the same output
 * contract, so one script serves both. Copilot's `agentStop` event does exist
 * and was smoke-verified (CLI 1.0.73): it delivers a documented payload
 * (camelCase, `transcriptPath`, `stop_hook_active`) plus a parseable typed
 * JSONL transcript, so those claims aren't the blocker. The blocker is the
 * output contract: no `systemMessage`/`additionalContext`, only
 * `{"decision":"block"|"allow","reason"}`, and `block` forces a full extra
 * agent turn. The documented soft-warn path (exit 2, stderr surfaced to the
 * user) was observed landing only in `~/.copilot/logs` in headless mode, not
 * visible to the user (interactive TUI untested), so warn-only has no working
 * surface there. It isn't ported to Copilot until a smoke shows that exit-2
 * stderr warning actually reaching the user.
 *
 * DEFAULT: WARN-ONLY. It surfaces a `systemMessage` and always allows the stop.
 * A Stop hook that traps the user in a loop is worse than the problem it solves,
 * so blocking is strictly opt-in (DELIVERY_GATE_BLOCK=1) and self-limiting: it
 * blocks at most once per turn (honoring `stop_hook_active`), never repeatedly.
 *
 * Checks (heuristic: all WARN):
 *  - Complex session (>= EDIT_THRESHOLD edits) that never checkpointed to
 *    .tasks/todo.md.
 *  - Rationalization language in recent assistant text ("good enough", "should
 *    work", "didn't run", ...) → nudge to actually verify.
 *  - Agreement opener + self-blame in recent assistant text -> evidence-free
 *    capitulation nudge (re-derive, then state the fact, no meta-narration).
 *  - Writing-voice violation (em dash, emoji, or a "Let me"/"I'll" opening) in
 *    the model's own final message, backing the writing-voice standing rule.
 *    Checked on that one message only (last_assistant_message, falling back to
 *    the transcript tail's own most recent assistant text block), not the
 *    multi-message rationalization/capitulation window, since "opens with X"
 *    is a property of a single message. Fenced code, inline code, and quoted
 *    spans are stripped first via stripSecondhand() so a quoted example or a
 *    code comment is never mistaken for the model's own voice, the same
 *    carve-out lint-pr-body.js makes for secondhand PR-body text. In
 *    WARN-ONLY mode this can only ever surface after the message it flags,
 *    since a Stop hook fires once the message is already sent: it has no way
 *    to make the model revise that same message. Only DELIVERY_GATE_BLOCK=1
 *    forces the corrective extra turn where the model can see the reason and
 *    fix its own output before actually stopping.
 *  - Low free disk on the working directory.
 *
 * Two transcript formats are read in one pass, keyed off record shape:
 *  - Claude JSONL: `{message:{role:"assistant",content:[{type:"tool_use",
 *    name:"Edit"|"Write"|...}]}}`: count edit tool_use blocks.
 *  - Codex rollout: `{payload:{type:"patch_apply_end",success,changes:{<abs
 *    path>:{type:"add"|"update"|...}}}}`: count changed files per applied
 *    patch. (Verified against a live ~/.codex/sessions rollout.)
 *  Rationalization is scanned on a bounded transcript tail (recent Claude text)
 *  AND on the Stop payload's `last_assistant_message` (Codex's recent text,
 *  which isn't in Claude JSONL shape).
 *
 * Self-contained: Node core only (both harnesses ship Node).
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
    /* partial read, use what we got */
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
const TODO_RE = /\.tasks\/todo\.md$/;

// Evidence-free capitulation: an agreement opener plus self-blame narration in
// the same recent text window. Either alone is often genuine; the combo is the
// "You're right, and I over-corrected" reflex the standing rules forbid.
// The agreement half is anchored to the start of a line or sentence (one
// optional interjection word allowed, "Ah, you're right"), so prose ABOUT the
// phrase reads as discussion rather than concession.
const AGREEMENT =
  /(?:^|[\n.!?]\s*)(?:[a-z]+,\s*)?you(?:'|’)?re (?:absolutely |completely |totally )?right\b/i;
const SELF_BLAME = /\b(?:i (?:over-?corrected|over-?reacted|was wrong)|my (?:mistake|error|apologies)|i apologi[sz]e)\b/i;

// Fenced blocks, inline code, and double-quoted spans are quoting someone
// else's words, so they come out before the capitulation scan. Same carve-out
// the PR-body lint makes for secondhand text. Single quotes are left alone:
// the apostrophes in "you're" and "didn't" would swallow whole sentences.
// Fence and inline-code matching use a backreference to the opening
// delimiter's exact text rather than a hardcoded ``` or single backtick, so a
// `~~~` fence and a double-backtick inline span (Markdown's way of quoting
// text that itself contains a backtick) are stripped too, not just the
// triple-backtick/single-backtick cases.
function stripSecondhand(text) {
  return text
    .replace(/(`{3,}|~{3,})[\s\S]*?\1/g, ' ')
    .replace(/(`+)[^\n]*?\1/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/“[^”\n]*”/g, ' ');
}

// Writing-voice violations in the model's own final message: an em dash, an
// emoji, or a "Let me"/"I'll" opening. Detection mirrors
// .github/scripts/lint-pr-body.js's em-dash/emoji checks (duplicated rather
// than imported: the two scripts install standalone into different targets
// with no shared module root, the same reasoning scripts.instructions.md
// already applies to the plan-gate/git-guard tokenizer duplication).
const EM_DASH = '\u2014';
const EXCLUDED_PICTOGRAPHS = new Set(['\u00A9', '\u00AE', '\u2122']); // (c) (r) (tm)
const EMOJI_RE = /\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}\uFE0F?/gu;
// Anchored to the very start of the (stripped, trimmed) message: "Let me know
// if..." at the end of a reply is fine, only the opening filler is the
// violation.
const PREAMBLE_OPENER_RE = /^(?:let me\b|i(?:'|’)ll\b)/i;

function findEmoji(text) {
  EMOJI_RE.lastIndex = 0;
  let m = EMOJI_RE.exec(text);
  while (m !== null) {
    if (!EXCLUDED_PICTOGRAPHS.has(m[0])) return m[0];
    m = EMOJI_RE.exec(text);
  }
  return null;
}

// Returns a short human-readable label for the first violation found, or null.
// Runs on stripSecondhand() output so a quoted example or code comment is
// never mistaken for the model's own voice.
function voiceViolation(text) {
  if (!text) return null;
  const prose = stripSecondhand(text).trimStart();
  if (!prose) return null;
  if (prose.includes(EM_DASH)) return 'an em dash';
  if (findEmoji(prose)) return 'an emoji';
  if (PREAMBLE_OPENER_RE.test(prose)) return `a "Let me"/"I'll" opening`;
  return null;
}

// The single most recent assistant message's own text, as opposed to
// recentAssistantText()'s multi-message window: "opens with X" is a property
// of one message, so concatenating several would test the wrong message's
// start.
function lastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const msg = entries[i] && entries[i].message;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const texts = msg.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text);
    if (texts.length) return texts.join('\n');
  }
  return '';
}

// Full streaming pass over the whole transcript: session-wide edit count and
// whether .tasks/todo.md was ever checkpointed. Handles both the Claude JSONL
// and the Codex rollout shapes; the two record forms are disjoint, so one pass
// covers either transcript. Must see the entire session, so it can't rely on a
// bounded tail.
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
    // Claude: assistant message with tool_use blocks.
    const msg = obj && obj.message;
    if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || block.type !== 'tool_use' || !EDIT_TOOLS.has(block.name)) continue;
        edits++;
        const fp = (block.input && (block.input.file_path || block.input.notebook_path)) || '';
        if (typeof fp === 'string' && TODO_RE.test(fp)) touchedTodo = true;
      }
      return;
    }
    // Codex: an applied patch. Each changed file counts as an edit.
    const payload = obj && obj.payload;
    if (payload && payload.type === 'patch_apply_end' && payload.success !== false) {
      const changes = payload.changes && typeof payload.changes === 'object' ? payload.changes : {};
      for (const fp of Object.keys(changes)) {
        edits++;
        if (TODO_RE.test(fp)) touchedTodo = true;
      }
    }
  });
  return { edits, touchedTodo };
}

// Assembles recent assistant text (bounded tail) from the transcript entries,
// which both the rationalization and capitulation scans test.
function recentAssistantText(entries) {
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
  return texts.slice(-6).join('\n');
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

  // Session-wide facts from the full transcript; recent text from a bounded tail
  // (Claude) plus the Stop payload's last_assistant_message (Codex).
  const { edits, touchedTodo } = scanEditsAndCheckpoint(transcriptPath);
  const lastMsg =
    input && typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  const tailEntries = readTranscriptTail(transcriptPath, tailBytes);
  const tailText = recentAssistantText(tailEntries);
  const rationalized = [tailText, lastMsg].some(
    (t) => !!t && RATIONALIZATION.some((re) => re.test(t))
  );
  const capitulated = [tailText, lastMsg].some((t) => {
    if (!t) return false;
    const prose = stripSecondhand(t);
    return AGREEMENT.test(prose) && SELF_BLAME.test(prose);
  });
  const finalMessage = lastMsg || lastAssistantText(tailEntries);
  const voiceIssue = voiceViolation(finalMessage);

  const warnings = [];
  if (edits >= editThreshold && !touchedTodo) {
    warnings.push(
      `Complex session (${edits} edits) but .tasks/todo.md was never updated: checkpoint your plan/state before finishing (plan-and-track).`
    );
  }
  if (rationalized) {
    warnings.push(
      `Recent text reads like an unverified claim ("good enough"/"should work"/"didn't test"); verify before done: run it, show the output.`
    );
  }
  if (capitulated) {
    warnings.push(
      `Recent text pairs an agreement opener ("you're right") with self-blame ("over-corrected"/"my mistake"): if that concession wasn't re-derived from the artifact, re-check and state the conclusion; if it was, state the corrected fact without the meta-narration.`
    );
  }
  if (voiceIssue) {
    warnings.push(
      `Final message contains ${voiceIssue}, which the writing-voice rule forbids in prose (see the humanizer skill).`
    );
  }
  if (minDiskMB > 0) {
    const free = freeDiskMB(cwd);
    if (free !== null && free < minDiskMB) {
      warnings.push(`Low free disk on the working directory (~${free} MB); builds/tests may fail.`);
    }
  }

  if (warnings.length === 0) {
    process.exit(0);
  }

  const body =
    '[DeliveryGate] Pre-finish checks:\n' + warnings.map((w) => `  • ${w}`).join('\n');

  if (process.env.DELIVERY_GATE_BLOCK === '1') {
    // Opt-in blocking: block THIS stop once. Because stop_hook_active is set on
    // the retry, the next stop attempt passes straight through: override by
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
