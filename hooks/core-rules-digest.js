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
 *   - `--copilot` (Copilot postToolUse): throttle to once per 10 minutes via a
 *     `.core-rules-last` stamp file, and when the window has elapsed print
 *     `{"additionalContext": <digest>}` as JSON. Copilot has no UserPromptSubmit
 *     event, so it refreshes off tool use instead, and the throttle keeps that
 *     from firing on every call.
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

function main() {
  if (process.argv.includes('--copilot')) {
    if (!throttleElapsed()) return; // within the window: stay quiet
    process.stdout.write(JSON.stringify({ additionalContext: digest() }));
    return;
  }
  // Claude / Codex: raw stdout is injected verbatim as prompt context.
  process.stdout.write(digest());
}

try {
  main();
} catch {
  process.exit(0); // fail open: never block a prompt or tool call
}
