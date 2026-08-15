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
 * Exit 1 on any HARD finding (missing bullet, past-budget bullet,
 * out-of-order bullets, or a total character count over
 * INLINE_THRESHOLD_CHARS less the answer-shape nudge the hook appends after
 * the digest on a question-shaped prompt), with a message naming the
 * offense. The size check reserves that nudge because the threshold applies
 * to what the hook prints, not to the digest file alone. The digest
 * was deliberately trimmed under the threshold on 2026-08-02 so the whole
 * file arrives inline; an edit that pushes it back over loses that
 * delivery property, so the threshold is a hard failure, not a warning.
 * Exit 0 otherwise.
 */

const fs = require('fs');
const path = require('path');

const PREVIEW_BUDGET_BYTES = 1998;
const INLINE_THRESHOLD_CHARS = 10000;
const HOOK_PATH = path.join(__dirname, '..', '..', 'hooks', 'core-rules-digest.js');
const PRIORITY_PREFIXES = [
  '- Action-first output:',
  '- Be skimmable, not exhaustive:',
  '- Verify before done:',
];

// What the hook actually prints on a question-shaped prompt is the digest plus
// the answer-shape nudge, so the digest alone is not what Claude measures
// against the persistence threshold. Read the nudge's literal out of the hook
// rather than restating its length here, and throw if it can't be found, so
// renaming or removing the constant fails CI loudly instead of silently
// reserving nothing.
function nudgeChars() {
  const source = fs.readFileSync(HOOK_PATH, 'utf8');
  const declaration = source.match(/const ANSWER_SHAPE_NUDGE =([\s\S]*?);\n/);
  const parts = declaration && declaration[1].match(/'[^']*'/g);
  if (!parts) {
    throw new Error(
      `ANSWER_SHAPE_NUDGE not found as a single-quoted literal in ${HOOK_PATH}; ` +
      'this checker reserves its length against the inline persistence threshold and must be updated with it'
    );
  }
  // + 1 for the newline main() writes after the nudge.
  return parts.map((part) => part.slice(1, -1)).join('').length + 1;
}

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

  const reserved = nudgeChars();
  const budget = INLINE_THRESHOLD_CHARS - reserved;
  const totalChars = content.length;
  if (totalChars > budget) {
    findings.push(
      `digest is ${totalChars} chars, over the ${budget}-char budget: the ` +
      `${INLINE_THRESHOLD_CHARS}-char inline persistence threshold less the ${reserved} chars ` +
      'core-rules-digest.js appends as the answer-shape nudge'
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
