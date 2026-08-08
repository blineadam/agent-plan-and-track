#!/usr/bin/env node
'use strict';

/**
 * Regression coverage for check-split-shell-segments-parity.js's
 * hard-failure and pass paths. Free and offline: every case spawns the real
 * script against scratch fixture files (via the checker's optional
 * source-path overrides) and inspects its exit code plus a distinguishing
 * substring of stdout/stderr; nothing here calls a model or the network, and
 * nothing here touches the real hooks/ files.
 *
 * Fixtures are derived at runtime from the real hooks/claude/plan-gate.js
 * copy of splitShellSegments rather than a committed static copy, so they
 * can never drift from the source the checker actually guards.
 */

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, 'check-split-shell-segments-parity.js');
const CANONICAL_SOURCE = path.join(__dirname, '..', '..', 'hooks', 'claude', 'plan-gate.js');
const FUNCTION_START = 'function splitShellSegments(command) {';

function loadCanonicalFunctionLines() {
  const content = fs.readFileSync(CANONICAL_SOURCE, 'utf8');
  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) => line === FUNCTION_START);
  if (startIndex === -1) {
    throw new Error(
      `fixture generation failed: "${FUNCTION_START}" not found in ${CANONICAL_SOURCE} ` +
      '(splitShellSegments has drifted from what this runner expects; update this runner)'
    );
  }
  let endIndex = -1;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (lines[i] === '}') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    throw new Error(`fixture generation failed: no top-level closing brace found after "${FUNCTION_START}" in ${CANONICAL_SOURCE}`);
  }
  return lines.slice(startIndex, endIndex + 1);
}

function writeFixture(dir, name, lines) {
  const fixturePath = path.join(dir, name);
  fs.writeFileSync(fixturePath, lines.join('\n'));
  return fixturePath;
}

function runChecker(claudePath, codexPath, gitGuardPath) {
  return childProcess.spawnSync(process.execPath, [SCRIPT, claudePath, codexPath, gitGuardPath], { encoding: 'utf8' });
}

function assertExitAndSubstring(result, expectedStatus, stream, substring) {
  assert.strictEqual(
    result.status,
    expectedStatus,
    `expected exit ${expectedStatus}, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.ok(
    result[stream].includes(substring),
    `expected ${stream} to include "${substring}"\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
}

async function passWhenAllThreeMatch(ctx, dir) {
  const claudePath = writeFixture(dir, 'claude-match.js', ctx.lines);
  const codexPath = writeFixture(dir, 'codex-match.js', ctx.lines);
  const gitGuardPath = writeFixture(dir, 'git-guard-match.js', ctx.lines);
  assertExitAndSubstring(runChecker(claudePath, codexPath, gitGuardPath), 0, 'stdout', 'OK:');
}

async function failsWhenOneCopyDrifts(ctx, dir) {
  const claudePath = writeFixture(dir, 'claude-drift.js', ctx.lines);
  const codexPath = writeFixture(dir, 'codex-drift.js', ctx.lines);
  const drifted = ctx.lines.slice();
  const heredocIndex = drifted.findIndex((line) => line.includes('const pendingHeredocs = []'));
  assert.notStrictEqual(heredocIndex, -1, 'fixture generation failed: pendingHeredocs line not found in canonical source');
  drifted[heredocIndex] = '  const pendingHeredocs = [];';
  const gitGuardPath = writeFixture(dir, 'git-guard-drift.js', drifted);
  const result = runChecker(claudePath, codexPath, gitGuardPath);
  assertExitAndSubstring(result, 1, 'stderr', 'differs between');
  // The checker reports each source's fixed label (e.g. "hooks/git-guard.js"),
  // not the scratch fixture's own filename, since the label identifies which
  // of the three real copies the caller pointed the override at.
  assertExitAndSubstring(result, 1, 'stderr', 'hooks/git-guard.js');
}

async function failsWhenLengthsDiffer(ctx, dir) {
  const claudePath = writeFixture(dir, 'claude-short.js', ctx.lines);
  const codexPath = writeFixture(dir, 'codex-short.js', ctx.lines);
  const truncated = ctx.lines.slice(0, -2).concat(['}']);
  const gitGuardPath = writeFixture(dir, 'git-guard-short.js', truncated);
  assertExitAndSubstring(runChecker(claudePath, codexPath, gitGuardPath), 1, 'stderr', 'differs between');
}

async function missingFunctionThrows(ctx, dir) {
  const claudePath = writeFixture(dir, 'claude-missing.js', ctx.lines);
  const codexPath = writeFixture(dir, 'codex-missing.js', ctx.lines);
  const gitGuardPath = writeFixture(dir, 'git-guard-missing.js', ['// no splitShellSegments here']);
  const result = runChecker(claudePath, codexPath, gitGuardPath);
  assert.notStrictEqual(result.status, 0, `expected non-zero exit, got 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
}

const CASES = [
  ['pass-when-all-three-match', passWhenAllThreeMatch],
  ['fails-when-one-copy-drifts', failsWhenOneCopyDrifts],
  ['fails-when-lengths-differ', failsWhenLengthsDiffer],
  ['missing-function-throws', missingFunctionThrows],
];

async function main() {
  const ctx = { lines: loadCanonicalFunctionLines() };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-split-shell-segments-parity-fixtures-'));
  let failures = 0;
  try {
    for (const [id, handler] of CASES) {
      try {
        await handler(ctx, dir);
        process.stdout.write(`PASS ${id}\n`);
      } catch (err) {
        process.stdout.write(`FAIL ${id}: ${(err && err.stack) || err}\n`);
        failures += 1;
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write(`${CASES.length - failures}/${CASES.length} PASS\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
