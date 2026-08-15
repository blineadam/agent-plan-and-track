#!/usr/bin/env node
/**
 * core-rules digest: re-inject the standing rules (Claude Code, Codex, Copilot CLI)
 *
 * Prints the core-rules digest so the harness re-surfaces the standing rules
 * mid-session, when the instruction file has decayed out of attention. Replaces
 * the inline shell commands the hook wiring used to carry (`cat ... || true` for
 * Claude/Codex, a bash throttle piped through `jq -Rs .` for Copilot), so no
 * POSIX shell, `cat`, or runtime `jq` is needed on any platform. This is what
 * makes the hook wiring work natively on Windows.
 *
 * ONE SCRIPT, TWO OUTPUT SHAPES:
 *   - Default (Claude / Codex UserPromptSubmit): print the concatenated digest
 *     as raw text on stdout. The harness injects stdout verbatim as context.
 *     When the submitted prompt is question-shaped, one extra line follows the
 *     digest: the answer-shape nudge backing the "answer the question asked"
 *     standing rule. UserPromptSubmit is the only event that fires BEFORE the
 *     reply is written, so it is the only layer that can shape the answer rather
 *     than flag it afterwards (the Stop-hook route, delivery-gate.js, sees the
 *     message only once it has already been sent).
 *   - `--copilot` (Copilot postToolUse): throttle to once per 10 minutes via a
 *     `.core-rules-last` stamp file, and when the window has elapsed print
 *     `{"additionalContext": <digest>}` as JSON. Copilot has no UserPromptSubmit
 *     event, so it refreshes off tool use instead, and the throttle keeps that
 *     from firing on every call.
 *
 * The `--copilot` path never reads stdin: Copilot has no UserPromptSubmit event,
 * and its postToolUse payload carries no prompt, so the nudge is Claude/Codex
 * only. Claude's payload was confirmed to carry `prompt` against the installed
 * CLI bundle (2.1.226); Codex's is read the same way and simply comes back empty
 * if absent, which prints the digest unchanged.
 *
 * The digest files are located relative to THIS script, never via a home-dir
 * lookup: the script installs to `<harness-config>/scripts/core-rules-digest.js`
 * and the digest to `<harness-config>/core-rules.md`, so `../core-rules.md`
 * resolves correctly for all three harnesses with no env-var expansion at
 * runtime (the exact thing Claude Code's Windows hook bugs mishandle).
 * `core-rules.local.md`, if present next to it, holds machine-specific rules and
 * is appended; a missing file is silently skipped.
 *
 * Fail-open: any error exits 0 with no output, so a broken digest never blocks a
 * prompt or a tool call.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const THROTTLE_SECONDS = 600; // Copilot: at most one refresh per 10 minutes
const DIGEST = path.join(__dirname, '..', 'core-rules.md');
const LOCAL_DIGEST = path.join(__dirname, '..', 'core-rules.local.md');
const STAMP = path.join(__dirname, '..', '.core-rules-last');

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return ''; // missing/unreadable file is skipped, matching `cat ... 2>/dev/null`
  }
}

// core-rules.md followed by the optional machine-local overrides, concatenated
// exactly as `cat core-rules.md core-rules.local.md` did.
function digest() {
  return readIfPresent(DIGEST) + readIfPresent(LOCAL_DIGEST);
}

// Copilot throttle: emit at most once per THROTTLE_SECONDS, tracked by a stamp
// file holding the last-emit unix seconds (same format the old bash hook wrote,
// so an existing stamp stays valid across the upgrade). Returns true when the
// window has elapsed (and refreshes the stamp), false to stay quiet this call.
function throttleElapsed() {
  const nowSec = Math.floor(Date.now() / 1000);
  let last = 0;
  const raw = readIfPresent(STAMP).trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n)) last = n;
  }
  if (nowSec - last <= THROTTLE_SECONDS) return false;
  try {
    fs.writeFileSync(STAMP, String(nowSec));
  } catch {
    // Can't persist the stamp: emit anyway rather than go silent forever. Worst
    // case the rules refresh a little more often than every 10 minutes.
  }
  return true;
}

const ANSWER_SHAPE_NUDGE =
  '[AnswerShape] This prompt asks a question. Lead with the answer, one explicit answer per ' +
  'proposition it contains. Do not open with "right"/"exactly"/"correct"/"yes" unless every part ' +
  'of your reply confirms that exact claim.';

// A TTY stdin means someone ran the script by hand, where readFileSync(0)
// would block waiting for EOF, so that case is skipped rather than hanging the
// terminal.
function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// The submitted prompt from the UserPromptSubmit payload, or '' when there is
// no usable prompt field.
function submittedPrompt() {
  try {
    const payload = JSON.parse(readStdin() || '{}');
    return payload && typeof payload.prompt === 'string' ? payload.prompt : '';
  } catch {
    return ''; // non-JSON payload: print the digest alone
  }
}

function stripCode(prompt) {
  let fence = '';
  return prompt
    .split('\n')
    .map((line) => {
      const fenceMatch = line.match(/^[ \t]*(`{3,}|~{3,})/);
      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
          fence = '';
        }
        return ' ';
      }
      if (fenceMatch) {
        fence = fenceMatch[1];
        return ' ';
      }
      return line.replace(/(`+)[^\n]*?\1/g, ' ');
    })
    .join('\n');
}

// A question mark ending any line, once fenced blocks and inline code spans are
// removed so a `?` inside pasted code or a quoted error message doesn't count.
// Matching per line rather than only at the end catches a question followed by
// context on a later line.
function isQuestionShaped(prompt) {
  const prose = stripCode(prompt);
  return /\?[ \t]*$/m.test(prose);
}

function main() {
  if (process.argv.includes('--copilot')) {
    if (!throttleElapsed()) return; // within the window: stay quiet
    process.stdout.write(JSON.stringify({ additionalContext: digest() }));
    return;
  }
  // Claude / Codex: raw stdout is injected verbatim as prompt context.
  const nudge = isQuestionShaped(submittedPrompt()) ? `${ANSWER_SHAPE_NUDGE}\n` : '';
  process.stdout.write(digest() + nudge);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never block a prompt or tool call
}
