#!/usr/bin/env node
'use strict';

/**
 * Guards the ordering of three priority bullets inside rules/core-rules.md,
 * the digest a UserPromptSubmit hook (core-rules-digest.js) prints on every
 * prompt. Claude Code persists hook stdout above INLINE_THRESHOLD_CHARS
 * characters to a file and shows only a small inline preview measured live
 * at PREVIEW_BUDGET_BYTES cumulative bytes; anything past that budget never
 * reaches the model inline. This script fails CI if any of the three
 * priority bullets is missing, ends past the preview budget, or appears out
 * of the required order, so a future edit can't silently push one of them
 * out of the preview without CI catching it.
 *
 * Invocation: node .github/scripts/check-digest-preview.js [path-to-digest]
 * Resolves the digest at ../../rules/core-rules.md relative to this script
 * by default (same convention the hooks use), or the single CLI arg when
 * given (used to check a draft file before it lands).
 *
 * Exit 1 on any HARD finding (missing bullet, past-budget bullet, or
 * out-of-order bullets), with a message naming the offending bullet and its
 * end offset. Exit 0 otherwise, with a WARN-only stderr line if the file's
 * total character count exceeds INLINE_THRESHOLD_CHARS: the trim decision
 * for that is deliberately still open, so it never fails the check.
 */

const fs = require('fs');
const path = require('path');

const PREVIEW_BUDGET_BYTES = 1998;
const INLINE_THRESHOLD_CHARS = 10000;
const PRIORITY_PREFIXES = [
  '- Action-first output:',
  '- Be skimmable, not exhaustive:',
  '- Verify before done:',
];

function main() {
  const digestPath = process.argv[2]
    ? process.argv[2]
    : path.join(__dirname, '..', '..', 'rules', 'core-rules.md');
  const content = fs.readFileSync(digestPath, 'utf8');
  const lines = content.split('\n');

  // Cumulative byte offset where each line ENDS, counting the line's own
  // UTF-8 bytes plus one for its trailing newline; this is what the inline
  // preview budget is measured against.
  let cumulative = 0;
  const lineEndOffsets = new Array(lines.length);
  for (let i = 0; i < lines.length; i += 1) {
    cumulative += Buffer.byteLength(lines[i], 'utf8') + 1;
    lineEndOffsets[i] = cumulative;
  }

  const findings = [];
  const found = [];

  for (const prefix of PRIORITY_PREFIXES) {
    let lineIndex = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith(prefix)) {
        lineIndex = i;
        break;
      }
    }
    if (lineIndex === -1) {
      findings.push(`priority bullet missing from digest: "${prefix}"`);
      continue;
    }
    const endOffset = lineEndOffsets[lineIndex];
    found.push({ prefix, lineIndex, endOffset });
    if (endOffset > PREVIEW_BUDGET_BYTES) {
      findings.push(`priority bullet past preview budget: "${prefix}" ends at byte ${endOffset}, budget is ${PREVIEW_BUDGET_BYTES}`);
    }
  }

  // Order check only makes sense once every bullet was actually found.
  if (found.length === PRIORITY_PREFIXES.length) {
    for (let i = 1; i < found.length; i += 1) {
      if (found[i].lineIndex < found[i - 1].lineIndex) {
        findings.push(
          `priority bullets out of order: "${found[i].prefix}" (ends at byte ${found[i].endOffset}) appears before ` +
          `"${found[i - 1].prefix}" (ends at byte ${found[i - 1].endOffset}); required order is Action-first output, ` +
          'Be skimmable not exhaustive, Verify before done'
        );
      }
    }
  }

  const totalChars = content.length;
  if (totalChars > INLINE_THRESHOLD_CHARS) {
    process.stderr.write(
      `WARN: digest is ${totalChars} chars, over the ${INLINE_THRESHOLD_CHARS}-char inline persistence threshold\n`
    );
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(`FAIL: ${finding}\n`);
    }
    process.exit(1);
  }

  const last = found[found.length - 1];
  process.stdout.write(
    `OK: Action-first output, Be skimmable not exhaustive, and Verify before done are present and in order; ` +
    `last bullet ends at byte ${last.endOffset} of ${PREVIEW_BUDGET_BYTES} preview budget\n`
  );
  process.exit(0);
}

main();
