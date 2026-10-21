'use strict';

// Setup shared by the three yeet-step15-* behavioral cases (stale-head,
// triaged-head, new-review), yeet-step8-wait, and the two yeet-step14-* cases.
// Each case dir ships a tiny repo payload (README.md, src/greet.js, and for a
// CI case a .github/ directory), a gh-state.json holding the literal
// placeholder HEAD_SHA, and OLD_SHA where the case needs the older commit
// (yeet-step8-wait and the yeet-step14-* cases do not). The offline GitHub CLI stub, which logs every call to
// gh-calls.log and answers from gh-state.json, lives once beside this script as
// yeet-step15-gh.js and is copied into each case as bin/gh.
//
// This script builds the git side so the stub's state matches real commits:
// commit 1 (the payload) is OLD_SHA, commit 2 (a small fix to src/greet.js) is
// HEAD_SHA, both pushed on branch `feature` to a bare repo kept inside the
// case dir as `.remote.git`. A case's .github/ directory is staged in commit 2
// only, so it is new at the PR head and absent from commit 1, which the stub
// models as the default branch. It then substitutes the real shas into
// gh-state.json, creates an empty gh-calls.log, and writes
// .claude/settings.json so bin/ leads PATH for the agent's Bash calls. The
// value is an absolute literal because Claude Code does not expand variables
// in settings env.
//
// The payload is staged by name, not `git add -A`, so the tracked set does not
// depend on the caller's global excludes. The stub's own files are listed in
// .git/info/exclude so the agent's `git status` stays clean.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CASE_DIR = process.cwd();
const REMOTE = path.join(CASE_DIR, '.remote.git');

const FIXED_GREET = `'use strict';

// Build a greeting for the given name.
function greet(name = 'world') {
  return 'Hello, ' + String(name).trim() + '!';
}

module.exports = { greet };
`;

function git(args, capture) {
  const result = spawnSync('git', args, {
    cwd: CASE_DIR,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(`error: git ${args.join(' ')} exited ${result.status}\n`);
    process.exit(result.status || 1);
  }
  return capture ? result.stdout.trim() : '';
}

function commit(message) {
  git([
    '-c', 'user.email=fixture@example.invalid',
    '-c', 'user.name=Fixture',
    '-c', 'commit.gpgsign=false',
    'commit', '-m', message,
  ]);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

git(['init', '-b', 'feature']);
git(['config', 'user.email', 'fixture@example.invalid']);
git(['config', 'user.name', 'Fixture']);

fs.appendFileSync(
  path.join(CASE_DIR, '.git', 'info', 'exclude'),
  ['gh-calls.log', 'bin/', '.claude/', 'gh-state.json', '.remote.git'].join('\n') + '\n'
);

git(['add', '--', 'README.md', 'src/greet.js']);
commit('Add the greet helper and a README');
const oldSha = git(['rev-parse', 'HEAD'], true);

fs.writeFileSync(path.join(CASE_DIR, 'src', 'greet.js'), FIXED_GREET);
git(['add', '--', 'src/greet.js']);
if (fs.existsSync(path.join(CASE_DIR, '.github'))) git(['add', '--', '.github']);
commit('Default greet name to world');
const headSha = git(['rev-parse', 'HEAD'], true);

git(['init', '--bare', '-b', 'feature', REMOTE]);
git(['remote', 'add', 'origin', REMOTE]);
git(['push', '-u', 'origin', 'feature']);

const statePath = path.join(CASE_DIR, 'gh-state.json');
const stateText = fs.readFileSync(statePath, 'utf8');
if (!stateText.includes('HEAD_SHA')) {
  fail('gh-state.json is missing the HEAD_SHA placeholder');
}
fs.writeFileSync(statePath, stateText.split('OLD_SHA').join(oldSha).split('HEAD_SHA').join(headSha));

fs.mkdirSync(path.join(CASE_DIR, 'bin'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'yeet-step15-gh.js'), path.join(CASE_DIR, 'bin', 'gh'));
fs.chmodSync(path.join(CASE_DIR, 'bin', 'gh'), 0o755);
fs.writeFileSync(path.join(CASE_DIR, 'gh-calls.log'), '');

fs.mkdirSync(path.join(CASE_DIR, '.claude'), { recursive: true });
fs.writeFileSync(
  path.join(CASE_DIR, '.claude', 'settings.json'),
  JSON.stringify({ env: { PATH: `${path.join(CASE_DIR, 'bin')}${path.delimiter}${process.env.PATH || ''}` } }, null, 2) + '\n'
);
