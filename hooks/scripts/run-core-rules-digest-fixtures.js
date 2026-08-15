#!/usr/bin/env node
/**
 * Deterministic fixtures for hooks/core-rules-digest.js.
 *
 * PLACEMENT follows the same reasoning run-delivery-gate-fixtures.js's header
 * spells out: core-rules-digest.js installs from hooks/ itself to all three
 * harnesses, so its runner sits at hooks/scripts/ and its data at
 * hooks/fixtures/core-rules-digest/cases.json.
 *
 * Scope: the answer-shape nudge only. Each case asserts whether the nudge
 * follows the digest for a given UserPromptSubmit payload, plus that the digest
 * itself is always printed and the --copilot path never reads the prompt. The
 * Copilot throttle, the core-rules.local.md append, and the missing-digest
 * fail-open path have no fixtures yet.
 *
 * Every case runs against a scratch copy of the INSTALLED layout
 * (<dir>/scripts/core-rules-digest.js next to <dir>/core-rules.md), not the repo
 * tree, because the script resolves its digest at ../core-rules.md: in the repo
 * that path does not exist, so a repo-rooted run would silently test an empty
 * digest and could not tell "digest printed" from "digest missing". The scratch
 * digest holds a sentinel line every case asserts on.
 */
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'core-rules-digest.js');
const CASES = path.join(__dirname, '..', 'fixtures', 'core-rules-digest', 'cases.json');
const SENTINEL = '- SENTINEL standing rule line, fixture only.';
const NUDGE_MARKER = '[AnswerShape]';

function runCase(fixtureCase) {
  const label = fixtureCase.id;
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-rules-digest-fixtures-'));
  try {
    fs.mkdirSync(path.join(scratchDir, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(scratchDir, 'scripts', 'core-rules-digest.js'));
    fs.writeFileSync(path.join(scratchDir, 'core-rules.md'), `${SENTINEL}\n`, 'utf8');

    const result = childProcess.spawnSync(
      process.execPath,
      [path.join(scratchDir, 'scripts', 'core-rules-digest.js'), ...(fixtureCase.argv || [])],
      { encoding: 'utf8', input: fixtureCase.stdin === undefined ? '' : fixtureCase.stdin }
    );
    assert.strictEqual(
      result.status,
      0,
      `${label}: nonzero exit (${result.status}), stderr: ${result.stderr}`
    );

    const stdout = result.stdout;
    const digestText = fixtureCase.expectJson ? JSON.parse(stdout).additionalContext : stdout;
    assert.ok(
      typeof digestText === 'string' && digestText.includes(SENTINEL),
      `${label}: digest missing from output: ${stdout}`
    );

    const hasNudge = stdout.includes(NUDGE_MARKER);
    assert.strictEqual(
      hasNudge,
      fixtureCase.expectNudge,
      `${label}: expected nudge ${fixtureCase.expectNudge}, got ${hasNudge}: ${stdout}`
    );

    if (fixtureCase.expectNudge) {
      assert.ok(
        stdout.indexOf(NUDGE_MARKER) > stdout.indexOf(SENTINEL),
        `${label}: nudge must follow the digest, not precede it: ${stdout}`
      );
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
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
