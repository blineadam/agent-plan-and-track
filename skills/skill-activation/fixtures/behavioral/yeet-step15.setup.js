'use strict';

// Setup shared by the three yeet-step15-* behavioral cases (stale-head,
// triaged-head, new-review). Each case dir ships a tiny repo payload
// (README.md, src/greet.js), a gh-state.json holding the literal placeholders
// OLD_SHA and HEAD_SHA, and bin/gh, an offline stub of the GitHub CLI that logs
// every call to gh-calls.log and answers from gh-state.json.
//
// This script builds the git side so the stub's state matches real commits:
// commit 1 (the payload) is OLD_SHA, commit 2 (a small fix to src/greet.js) is
// HEAD_SHA, both pushed on branch `feature` to a bare repo kept inside the
// case dir as `.remote.git`. It then substitutes the real shas into
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
commit('Default greet name to world');
const headSha = git(['rev-parse', 'HEAD'], true);

git(['init', '--bare', '-b', 'feature', REMOTE]);
git(['remote', 'add', 'origin', REMOTE]);
git(['push', '-u', 'origin', 'feature']);

const statePath = path.join(CASE_DIR, 'gh-state.json');
const stateText = fs.readFileSync(statePath, 'utf8');
if (!stateText.includes('OLD_SHA') || !stateText.includes('HEAD_SHA')) {
  fail('gh-state.json is missing the OLD_SHA/HEAD_SHA placeholders');
}
fs.writeFileSync(statePath, stateText.split('OLD_SHA').join(oldSha).split('HEAD_SHA').join(headSha));

fs.chmodSync(path.join(CASE_DIR, 'bin', 'gh'), 0o755);
fs.writeFileSync(path.join(CASE_DIR, 'gh-calls.log'), '');

fs.mkdirSync(path.join(CASE_DIR, '.claude'), { recursive: true });
fs.writeFileSync(
  path.join(CASE_DIR, '.claude', 'settings.json'),
  JSON.stringify({ env: { PATH: `${path.join(CASE_DIR, 'bin')}${path.delimiter}${process.env.PATH || ''}` } }, null, 2) + '\n'
);
