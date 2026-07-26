#!/usr/bin/env node
'use strict';

/**
 * Regression coverage for check-digest-preview.js's hard-failure paths. Free
 * and offline: every case spawns the real script against a scratch fixture
 * file and inspects its exit code plus a distinguishing substring of its
 * stdout/stderr; nothing here calls a model or the network.
 *
 * Fixtures are derived at runtime from the real rules/core-rules.md rather
 * than a committed static copy, so they can never drift from the source the
 * checker actually guards. Each case starts from the real digest's lines,
 * locates the three priority-bullet lines by the same prefixes the checker
 * itself uses, and mutates a copy of the line list; if a prefix isn't found
 * in the source file, loadSourceLines() throws loudly instead of silently
 * generating an empty or wrong fixture, since that means PRIORITY_PREFIXES
 * has drifted between the checker and this runner and the runner itself
 * needs updating.
 */

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, 'check-digest-preview.js');
const SOURCE_DIGEST = path.join(__dirname, '..', '..', 'rules', 'core-rules.md');
const INLINE_THRESHOLD_CHARS = 10000;
const PRIORITY_PREFIXES = [
  '- Action-first output:',
  '- Be skimmable, not exhaustive:',
  '- Verify before done:',
];

function loadSourceLines() {
  const content = fs.readFileSync(SOURCE_DIGEST, 'utf8');
  const lines = content.split('\n');
  const indexByPrefix = {};
  for (const prefix of PRIORITY_PREFIXES) {
    const idx = lines.findIndex((line) => line.startsWith(prefix));
    if (idx === -1) {
      throw new Error(
        `fixture generation failed: priority prefix not found in ${SOURCE_DIGEST}: "${prefix}" ` +
        '(PRIORITY_PREFIXES has drifted between check-digest-preview.js and this runner; update this runner)'
      );
    }
    indexByPrefix[prefix] = idx;
  }
  return { content, lines, indexByPrefix };
}

function writeFixture(dir, name, lines) {
  const fixturePath = path.join(dir, name);
  fs.writeFileSync(fixturePath, lines.join('\n'));
  return fixturePath;
}

function runChecker(fixturePath) {
  return childProcess.spawnSync(process.execPath, [SCRIPT, fixturePath], { encoding: 'utf8' });
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

async function passUnmodifiedCopyOk(ctx, dir) {
  const fixturePath = writeFixture(dir, 'pass.md', ctx.lines);
  assertExitAndSubstring(runChecker(fixturePath), 0, 'stdout', 'OK:');
}

async function missingActionFirstHardFails(ctx, dir) {
  const lines = ctx.lines.slice();
  lines.splice(ctx.indexByPrefix['- Action-first output:'], 1);
  const fixturePath = writeFixture(dir, 'missing.md', lines);
  assertExitAndSubstring(runChecker(fixturePath), 1, 'stderr', 'missing');
}

async function overBudgetActionFirstHardFails(ctx, dir) {
  const lines = ctx.lines.slice();
  const [line] = lines.splice(ctx.indexByPrefix['- Action-first output:'], 1);
  lines.push(line);
  const fixturePath = writeFixture(dir, 'over-budget.md', lines);
  assertExitAndSubstring(runChecker(fixturePath), 1, 'stderr', 'past preview budget');
}

async function outOfOrderSwapHardFails(ctx, dir) {
  const lines = ctx.lines.slice();
  const skimIdx = ctx.indexByPrefix['- Be skimmable, not exhaustive:'];
  const verifyIdx = ctx.indexByPrefix['- Verify before done:'];
  const swap = lines[skimIdx];
  lines[skimIdx] = lines[verifyIdx];
  lines[verifyIdx] = swap;
  const fixturePath = writeFixture(dir, 'out-of-order.md', lines);
  // Both bullets stay within the preview budget after only swapping their
  // positions, so this isolates the order check from the budget check.
  assertExitAndSubstring(runChecker(fixturePath), 1, 'stderr', 'out of order');
}

async function warnConsistencyMatchesThreshold(ctx, dir) {
  const fixturePath = writeFixture(dir, 'warn-consistency.md', ctx.lines);
  const result = runChecker(fixturePath);
  const expectWarn = ctx.content.length > INLINE_THRESHOLD_CHARS;
  const hasWarn = result.stderr.includes('WARN:');
  assert.strictEqual(
    hasWarn,
    expectWarn,
    `expected WARN presence to be ${expectWarn} (source digest is ${ctx.content.length} chars vs the ` +
    `${INLINE_THRESHOLD_CHARS}-char threshold), got ${hasWarn}\nstderr: ${result.stderr}`
  );
}

const CASES = [
  ['pass-unmodified-copy-ok', passUnmodifiedCopyOk],
  ['missing-action-first-hard-fails', missingActionFirstHardFails],
  ['over-budget-action-first-hard-fails', overBudgetActionFirstHardFails],
  ['out-of-order-swap-hard-fails', outOfOrderSwapHardFails],
  ['warn-consistency-matches-threshold', warnConsistencyMatchesThreshold],
];

async function main() {
  const ctx = loadSourceLines();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-digest-preview-fixtures-'));
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
