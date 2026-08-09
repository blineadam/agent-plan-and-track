#!/usr/bin/env node
/**
 * Deterministic fixtures for hooks/delivery-gate.js.
 *
 * PLACEMENT (deliberate documented variant, matching
 * hooks/scripts/run-git-guard-fixtures.js's own header note). The written
 * convention in .github/instructions/scripts.instructions.md places a hook's
 * fixture runner one level below wherever the hook itself lives:
 * hooks/<harness>/scripts/ for a harness-specific hook, or hooks/scripts/ for
 * a hook shared across all harnesses and installed from hooks/ itself.
 * delivery-gate.js is the latter (one script, Claude and Codex both wire it
 * as a Stop hook), so its fixtures sit at hooks/scripts/ and
 * hooks/fixtures/delivery-gate/cases.json.
 *
 * Scope: this is the first fixture suite for delivery-gate.js, and it covers
 * only the writing-voice checks added to back the em-dash/emoji/"Let me"-"I'll"
 * standing rule (em dash, emoji, and a preamble opener, each once in plain
 * prose and once behind the fenced-code/inline-code carve-out stripSecondhand()
 * implements), plus the transcript-tail fallback path when
 * last_assistant_message is absent. The pre-existing rationalization,
 * capitulation, edit-count, and disk checks have no fixtures yet; adding them
 * is out of scope for the batch that added this runner.
 *
 * Each case in cases.json supplies either `input` (spawned verbatim as the
 * Stop hook's stdin JSON) or `transcript` (an array of JSONL records written
 * to a scratch file first, with `input.transcript_path` pointed at it), plus
 * an optional `env` map and an `expect` of "warn" | "allow" | "block".
 * DELIVERY_GATE_MIN_DISK_MB=0 is forced in every case's env so a
 * constrained CI runner's free-disk number can never inject an unrelated
 * warning into a case that isn't testing that check.
 */
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'delivery-gate.js');
const CASES = path.join(__dirname, '..', 'fixtures', 'delivery-gate', 'cases.json');

function runCase(fixtureCase) {
  const label = fixtureCase.id;
  let scratchDir = null;
  const input = { ...(fixtureCase.input || {}) };

  if (Array.isArray(fixtureCase.transcript)) {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-gate-fixtures-'));
    const transcriptPath = path.join(scratchDir, 'transcript.jsonl');
    const lines = fixtureCase.transcript.map((record) => JSON.stringify(record)).join('\n') + '\n';
    fs.writeFileSync(transcriptPath, lines, 'utf8');
    input.transcript_path = transcriptPath;
  }

  const env = { ...process.env, DELIVERY_GATE_MIN_DISK_MB: '0', ...(fixtureCase.env || {}) };

  try {
    const result = childProcess.spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env,
      input: JSON.stringify(input),
    });
    assert.strictEqual(
      result.status,
      0,
      `${label}: nonzero exit (${result.status}), stderr: ${result.stderr}`
    );
    const stdout = result.stdout;

    if (fixtureCase.expect === 'allow') {
      assert.strictEqual(stdout, '', `${label}: expected silent allow, got ${stdout}`);
      return;
    }

    if (fixtureCase.expect === 'warn') {
      const parsed = JSON.parse(stdout);
      assert.strictEqual(
        typeof parsed.systemMessage,
        'string',
        `${label}: expected a systemMessage, got ${stdout}`
      );
      assert.strictEqual(parsed.decision, undefined, `${label}: warn must not carry a decision, got ${stdout}`);
      if (fixtureCase.expectContains) {
        assert.ok(
          parsed.systemMessage.includes(fixtureCase.expectContains),
          `${label}: systemMessage missing "${fixtureCase.expectContains}": ${parsed.systemMessage}`
        );
      }
      return;
    }

    if (fixtureCase.expect === 'block') {
      const parsed = JSON.parse(stdout);
      assert.strictEqual(parsed.decision, 'block', `${label}: expected decision block, got ${stdout}`);
      if (fixtureCase.expectContains) {
        assert.ok(
          parsed.reason.includes(fixtureCase.expectContains),
          `${label}: reason missing "${fixtureCase.expectContains}": ${parsed.reason}`
        );
      }
      return;
    }

    throw new Error(`${label}: unknown expect "${fixtureCase.expect}"`);
  } finally {
    if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

function main() {
  const fixtureCases = JSON.parse(fs.readFileSync(CASES, 'utf8')).cases;
  let failures = 0;
  for (const fixtureCase of fixtureCases) {
    try {
      runCase(fixtureCase);
      process.stdout.write(`PASS ${fixtureCase.id}\n`);
    } catch (err) {
      process.stdout.write(`FAIL ${fixtureCase.id}: ${(err && err.stack) || err}\n`);
      failures += 1;
    }
  }
  process.stdout.write(`${fixtureCases.length - failures}/${fixtureCases.length} cases passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
