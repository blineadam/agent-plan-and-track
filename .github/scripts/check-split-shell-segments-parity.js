#!/usr/bin/env node
'use strict';

/**
 * Guards the byte-for-byte contract between the three standalone copies of
 * splitShellSegments: hooks/claude/plan-gate.js, hooks/codex/plan-gate-
 * pilot.js, and hooks/git-guard.js. Each hook installs standalone into a
 * harness's own scripts/ directory with no shared module root, so the
 * tokenizer is copied rather than imported; git-guard.js's own header
 * ("splitShellSegments is copied BYTE-FOR-BYTE from hooks/claude/plan-
 * gate.js ... and must stay that way") states the contract this script
 * enforces mechanically instead of leaving it to attention alone.
 *
 * Invocation: node .github/scripts/check-split-shell-segments-parity.js
 * [claude-plan-gate-path] [codex-plan-gate-pilot-path] [git-guard-path]
 * With no arguments, resolves the three real repo copies relative to this
 * script's own location. The three optional positional args (in that order)
 * override individual sources with scratch fixtures, used by
 * run-check-split-shell-segments-parity-fixtures.js to prove the checker can
 * actually fail without touching the real files.
 *
 * Exit 1 if the extracted function bodies are not all identical, naming
 * which pair differs and the first line at which they diverge. Exit 0
 * otherwise.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCES = [
  { label: 'hooks/claude/plan-gate.js', file: path.join(__dirname, '..', '..', 'hooks', 'claude', 'plan-gate.js') },
  { label: 'hooks/codex/plan-gate-pilot.js', file: path.join(__dirname, '..', '..', 'hooks', 'codex', 'plan-gate-pilot.js') },
  { label: 'hooks/git-guard.js', file: path.join(__dirname, '..', '..', 'hooks', 'git-guard.js') },
];

const SOURCES = DEFAULT_SOURCES.map((source, i) =>
  process.argv[2 + i] ? { label: source.label, file: process.argv[2 + i] } : source
);

const FUNCTION_START = 'function splitShellSegments(command) {';

// Extracts the splitShellSegments function body (start line through its
// matching top-level closing brace, a line that is exactly '}') as an array
// of lines. Throws loudly if the function or its closing brace can't be
// found, since that means the function was renamed or restructured and this
// script needs updating, not a silent pass.
function extractFunction(label, file) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) => line === FUNCTION_START);
  if (startIndex === -1) {
    throw new Error(`${label}: could not find "${FUNCTION_START}"`);
  }
  let endIndex = -1;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (lines[i] === '}') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    throw new Error(`${label}: found "${FUNCTION_START}" but no top-level closing brace after it`);
  }
  return lines.slice(startIndex, endIndex + 1);
}

// Compares two line arrays and returns the 1-based line number (relative to
// the extracted function, line 1 == the `function ...` line) of the first
// divergence, along with the two differing lines, or null if identical.
function firstDivergence(linesA, linesB) {
  const max = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < max; i += 1) {
    const a = i < linesA.length ? linesA[i] : undefined;
    const b = i < linesB.length ? linesB[i] : undefined;
    if (a !== b) {
      return { lineNumber: i + 1, a, b };
    }
  }
  return null;
}

function main() {
  const extracted = SOURCES.map(({ label, file }) => ({
    label,
    lines: extractFunction(label, file),
  }));

  const findings = [];
  for (let i = 0; i < extracted.length; i += 1) {
    for (let j = i + 1; j < extracted.length; j += 1) {
      const divergence = firstDivergence(extracted[i].lines, extracted[j].lines);
      if (divergence) {
        findings.push(
          `splitShellSegments differs between ${extracted[i].label} and ${extracted[j].label} ` +
          `at function line ${divergence.lineNumber}:\n` +
          `  ${extracted[i].label}: ${JSON.stringify(divergence.a)}\n` +
          `  ${extracted[j].label}: ${JSON.stringify(divergence.b)}`
        );
      }
    }
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(`FAIL: ${finding}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(
    `OK: splitShellSegments is byte-for-byte identical across ${SOURCES.map((s) => s.label).join(', ')} ` +
    `(${extracted[0].lines.length} lines)\n`
  );
  process.exit(0);
}

main();
