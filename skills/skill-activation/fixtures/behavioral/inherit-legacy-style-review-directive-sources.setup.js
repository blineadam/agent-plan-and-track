'use strict';

// Setup for the inherit-legacy-style-review-directive-sources behavioral case:
// commits the copied fixture as a four-commit git repo in fold-into-docs shape
// (an on-demand CONTRIBUTING.md beside a .ai-style-rules.md).
//   1. Dana adds the shipcalc package, its tests, AGENTS.md, and CONTRIBUTING.md.
//   2. Dana adds .ai-style-rules.md, fingerprinted at commit 1. The fixture file
//      holds the literal FINGERPRINT, which this script replaces with commit
//      1's short hash before committing it.
//   3. Sam adds an unmarked .github/instructions/review.instructions.md with a
//      money directive restating the .ai-style-rules.md integer-cents rule (and
//      pointing back to it) plus an errors directive no other file states.
//   4. Lee adds src/shipcalc/insurance.py and its test, following both
//      conventions, so the diff since the fingerprint has new code to scan.
//
// Files are staged by name rather than with `git add -A`, so the tracked set
// doesn't depend on the caller's global excludes (see
// capture-lesson-git-repo.setup.js for the same reasoning).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const cwd = process.cwd();
const RULES = '.ai-style-rules.md';
const REVIEW = '.github/instructions/review.instructions.md';
const LATER = ['src/shipcalc/insurance.py', 'tests/test_insurance.py'];
const BASE = [
  'AGENTS.md',
  'CONTRIBUTING.md',
  'src/shipcalc/__init__.py',
  'src/shipcalc/errors.py',
  'src/shipcalc/money.py',
  'src/shipcalc/quote.py',
  'src/shipcalc/rates.py',
  'tests/test_money.py',
  'tests/test_quote.py',
  'tests/test_rates.py',
];

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function git(args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) fail(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function commit(name, email, date, subject, files) {
  git(['add', '--', ...files]);
  git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', subject], {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date,
  });
}

git(['init', '-q', '-b', 'main']);
commit('Dana Whitfield', 'dana.whitfield@example.invalid', '2026-08-04T10:00:00Z', 'Add shipcalc quoting package', BASE);
const base = git(['rev-parse', '--short', 'HEAD']).trim();

const rulesPath = path.join(cwd, RULES);
const rulesText = fs.readFileSync(rulesPath, 'utf8');
if (!rulesText.includes('`FINGERPRINT`')) fail(`${RULES} has no FINGERPRINT placeholder`);
fs.writeFileSync(rulesPath, rulesText.replace('`FINGERPRINT`', `\`${base}\``));
commit('Dana Whitfield', 'dana.whitfield@example.invalid', '2026-08-05T09:00:00Z', 'Record shipcalc style rules', [RULES]);
commit('Sam Okafor', 'sam.okafor@example.invalid', '2026-09-10T14:30:00Z', 'Add Copilot review rules for src', [REVIEW]);
commit('Lee Park', 'lee.park@example.invalid', '2026-10-01T11:15:00Z', 'Add declared-value insurance surcharge', LATER);
git(['config', 'user.name', 'Fixture']);
git(['config', 'user.email', 'fixture@example.invalid']);

const tracked = git(['ls-files']).trim().split('\n').sort();
const expected = [...BASE, RULES, REVIEW, ...LATER].sort();
if (JSON.stringify(tracked) !== JSON.stringify(expected)) fail(`tracked set is ${JSON.stringify(tracked)}`);
if (git(['status', '--porcelain']).trim() !== '') fail('working tree is not clean after setup');
if (git(['rev-list', '--count', `${base}..HEAD`]).trim() !== '3') fail('expected three commits after the fingerprint');
if (!fs.readFileSync(rulesPath, 'utf8').includes(`Commit fingerprint: \`${base}\``)) fail('fingerprint not stamped');
