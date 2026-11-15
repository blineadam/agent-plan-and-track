#!/usr/bin/env node
'use strict';

/**
 * Regression coverage for the skill-coverage check in run-activation-cases.js
 * --dry-run. Free and offline: every case writes a scratch tree under
 * os.tmpdir() holding a COPY of the real script at
 * skills/skill-activation/scripts/, so its default-path logic (the fixtures
 * file, the exemptions file, and the skills/ directory it scans are all
 * resolved from its own location) runs unmodified with no test-only knob, then
 * spawns that copy with --dry-run and inspects the exit code plus
 * distinguishing substrings of stderr. Nothing here calls a model or the
 * network and the real repo files are never touched.
 *
 * Every case starts from the same clean tree (baseFiles()): an empty install.sh
 * (the source-checkout marker), skills alpha, beta, and skill-activation
 * itself, each with one case, so each failing case
 * isolates one rule. A failing case requires the FAIL line to name the skill
 * or exemption key and carry a "fix:" hint, since that line is the check's
 * whole interface.
 */

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL_SCRIPT = path.join(__dirname, 'run-activation-cases.js');
const SCRATCH_SCRIPT = path.join('skills', 'skill-activation', 'scripts', 'run-activation-cases.js');
const CASES_FILE = 'skills/skill-activation/fixtures/activation-cases.jsonl';
const EXEMPTIONS_FILE = 'skills/skill-activation/fixtures/activation-exemptions.json';

function caseLine(skill) {
  return JSON.stringify({ id: `${skill}-case`, prompt: `a prompt for ${skill}`, expect_skill: skill }) + '\n';
}

function caseLines(skills) {
  return skills.map(caseLine).join('');
}

function baseFiles() {
  return {
    'install.sh': '',
    [CASES_FILE]: caseLines(['alpha', 'beta', 'skill-activation']),
    'skills/alpha/SKILL.md': '# alpha\n',
    'skills/beta/SKILL.md': '# beta\n',
    'skills/skill-activation/SKILL.md': '# skill-activation\n',
  };
}

function writeTree(root, files) {
  fs.mkdirSync(path.join(root, path.dirname(SCRATCH_SCRIPT)), { recursive: true });
  fs.copyFileSync(REAL_SCRIPT, path.join(root, SCRATCH_SCRIPT));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function runDryRun(root, extraArgs) {
  return childProcess.spawnSync(process.execPath, [path.join(root, SCRATCH_SCRIPT), '--dry-run', ...extraArgs], {
    encoding: 'utf8',
  });
}

function assertExitAndSubstrings(result, expectedStatus, substrings) {
  const detail = `\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
  assert.strictEqual(result.status, expectedStatus, `expected exit ${expectedStatus}, got ${result.status}${detail}`);
  for (const substring of substrings) {
    assert.ok(result.stderr.includes(substring), `expected stderr to include "${substring}"${detail}`);
  }
}

// Builds the tree with the given overrides and expects a clean pass: exit 0
// and nothing on stderr beyond the existing dry-run notice.
function expectPass(dir, overrides) {
  writeTree(dir, { ...baseFiles(), ...overrides });
  const result = runDryRun(dir, []);
  assertExitAndSubstrings(result, 0, []);
  assert.ok(!result.stderr.includes('FAIL'), `expected no FAIL line\nstderr: ${result.stderr}`);
}

// Builds the tree with the given overrides and expects exit 1 with a FAIL line
// holding every given substring plus a fix hint.
function expectFail(dir, overrides, substrings) {
  writeTree(dir, { ...baseFiles(), ...overrides });
  assertExitAndSubstrings(runDryRun(dir, []), 1, ['FAIL', ...substrings, 'fix:']);
}

async function passCleanTree(dir) {
  expectPass(dir, {});
}

async function uncoveredSkillFails(dir) {
  expectFail(dir, { 'skills/gamma/SKILL.md': '# gamma\n' }, ['skill gamma']);
}

async function exemptSkillPasses(dir) {
  expectPass(dir, {
    'skills/gamma/SKILL.md': '# gamma\n',
    [EXEMPTIONS_FILE]: JSON.stringify({ gamma: 'enforced by a hook, not routing' }),
  });
}

async function blankReasonFails(dir) {
  expectFail(
    dir,
    {
      'skills/gamma/SKILL.md': '# gamma\n',
      [EXEMPTIONS_FILE]: JSON.stringify({ gamma: '   ' }),
    },
    ['exemption gamma', 'no reason']
  );
}

async function nonStringReasonFails(dir) {
  expectFail(
    dir,
    {
      'skills/gamma/SKILL.md': '# gamma\n',
      [EXEMPTIONS_FILE]: JSON.stringify({ gamma: 42 }),
    },
    ['exemption gamma', 'no reason']
  );
}

async function exemptionForCoveredSkillFails(dir) {
  expectFail(dir, { [EXEMPTIONS_FILE]: JSON.stringify({ alpha: 'was untestable once' }) }, ['exemption alpha', 'stale']);
}

async function exemptionForMissingSkillFails(dir) {
  expectFail(dir, { [EXEMPTIONS_FILE]: JSON.stringify({ ghost: 'no such skill' }) }, ['exemption ghost', 'stale']);
}

async function invalidJsonFails(dir) {
  expectFail(dir, { [EXEMPTIONS_FILE]: '{ not json' }, ['activation-exemptions.json', 'not valid JSON']);
}

async function nonObjectExemptionsFails(dir) {
  expectFail(dir, { [EXEMPTIONS_FILE]: '["gateguard"]' }, ['activation-exemptions.json', 'must be a JSON object']);
}

async function missingExemptionsFilePasses(dir) {
  writeTree(dir, baseFiles());
  assert.ok(!fs.existsSync(path.join(dir, ...EXEMPTIONS_FILE.split('/'))), 'exemptions file must be absent');
  const result = runDryRun(dir, []);
  assertExitAndSubstrings(result, 0, []);
  assert.ok(!result.stderr.includes('FAIL'), `expected no FAIL line\nstderr: ${result.stderr}`);
}

async function customFixturesSkipsGuard(dir) {
  writeTree(dir, { ...baseFiles(), 'skills/gamma/SKILL.md': '# gamma\n', 'subset.jsonl': caseLine('alpha') });
  const result = runDryRun(dir, [path.join(dir, 'subset.jsonl')]);
  assertExitAndSubstrings(result, 0, []);
  assert.ok(!result.stderr.includes('FAIL'), `expected no FAIL line\nstderr: ${result.stderr}`);
  // The same tree on the default corpus does fail, so the skip is the argument's doing.
  assertExitAndSubstrings(runDryRun(dir, []), 1, ['FAIL', 'skill gamma', 'fix:']);
}

// Without install.sh beside skills/ the tree is an installed copy: the check
// is skipped with a visible stderr line, so an uncovered skill exits 0.
async function installedCopySkipsGuard(dir) {
  writeTree(dir, { ...baseFiles(), 'skills/gamma/SKILL.md': '# gamma\n' });
  fs.rmSync(path.join(dir, 'install.sh'));
  assertExitAndSubstrings(runDryRun(dir, []), 0, ['# coverage check skipped', 'not a source checkout', 'install.sh']);
}

const CASES = [
  ['pass-clean-tree', passCleanTree],
  ['uncovered-skill-fails', uncoveredSkillFails],
  ['exempt-skill-passes', exemptSkillPasses],
  ['blank-reason-fails', blankReasonFails],
  ['non-string-reason-fails', nonStringReasonFails],
  ['exemption-for-covered-skill-fails', exemptionForCoveredSkillFails],
  ['exemption-for-missing-skill-fails', exemptionForMissingSkillFails],
  ['invalid-json-fails', invalidJsonFails],
  ['non-object-exemptions-fails', nonObjectExemptionsFails],
  ['missing-exemptions-file-passes', missingExemptionsFilePasses],
  ['custom-fixtures-skips-guard', customFixturesSkipsGuard],
  ['installed-copy-skips-guard', installedCopySkipsGuard],
];

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-coverage-fixtures-'));
  let failures = 0;
  try {
    for (const [id, handler] of CASES) {
      try {
        await handler(path.join(dir, id));
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
