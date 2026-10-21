'use strict';

// Setup for the copilot-review-instructions-keeps-hand-edit behavioral case:
// commits the copied fixture as a two-commit git repo, so the skill can read
// `git blame` on the existing path-scoped instruction file. The first commit
// (Dana) adds the project with a general.instructions.md whose directives all
// restate AGENTS.md; the second (Sam) adds only the "## Comments" section, a
// TODO-needs-an-issue directive that no source in the repo backs. The fixture
// dir holds the final state, so this script writes the earlier version of that
// file first by cutting the section, then restores it for the second commit.
//
// Files are staged by name rather than with `git add -A`, so the tracked set
// doesn't depend on the caller's global excludes (see
// capture-lesson-git-repo.setup.js for the same reasoning).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const GENERAL = '.github/instructions/general.instructions.md';
const FILES = [
  'AGENTS.md',
  'README.md',
  '.github/copilot-instructions.md',
  GENERAL,
  'src/ledger/__init__.py',
  'src/ledger/__main__.py',
  'src/ledger/cli.py',
  'src/ledger/totals.py',
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

const generalPath = path.join(cwd, GENERAL);
const finalText = fs.readFileSync(generalPath, 'utf8');
const cut = finalText.indexOf('\n## Comments\n');
if (cut < 0) fail(`${GENERAL} has no "## Comments" section to split off`);

git(['init', '-q', '-b', 'main']);
fs.writeFileSync(generalPath, finalText.slice(0, cut + 1));
commit('Dana Whitfield', 'dana.whitfield@example.invalid', '2026-08-04T10:00:00Z', 'Add ledger CLI and Copilot review rules', FILES);
fs.writeFileSync(generalPath, finalText);
commit('Sam Okafor', 'sam.okafor@example.invalid', '2026-09-15T14:30:00Z', 'Ask reviewers to flag TODOs without an issue', [GENERAL]);
git(['config', 'user.name', 'Fixture']);
git(['config', 'user.email', 'fixture@example.invalid']);

const tracked = git(['ls-files']).trim().split('\n').sort();
if (JSON.stringify(tracked) !== JSON.stringify([...FILES].sort())) {
  fail(`tracked set is ${JSON.stringify(tracked)}`);
}
if (git(['status', '--porcelain']).trim() !== '') fail('working tree is not clean after setup');
if (!/^\^?[0-9a-f]+ .*Sam Okafor.*Flag any new TODO comment/m.test(git(['blame', '--', GENERAL]))) {
  fail('git blame does not attribute the TODO directive to the second commit');
}
