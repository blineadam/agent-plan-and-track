'use strict';

// Setup for the inherit-legacy-style-init-only behavioral case: commits the
// copied fixture as a baseline git repo, so the skill's first-time scan can
// count tracked files with `git ls-files` and stamp a commit fingerprint.
// The fixture's only convention docs are instruction files (an /init-style
// CLAUDE.md and an unmarked path-scoped Copilot instruction file), which is
// the shape the case pins: rules go to .ai-style-rules.md, never into either.
//
// Files are staged by name rather than with `git add -A`, so the tracked set
// doesn't depend on the caller's global excludes (see
// capture-lesson-git-repo.setup.js for the same reasoning).

const { spawnSync } = require('child_process');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write(`error: ${command} ${args.join(' ')} exited ${result.status}\n`);
    process.exit(result.status || 1);
  }
}

run('git', ['init', '-b', 'main']);
run('git', [
  'add',
  '--',
  'CLAUDE.md',
  '.github/instructions/review.instructions.md',
  'package.json',
  'src/server.js',
  'src/orders.js',
  'src/customers.js',
  'src/invoices.js',
  'src/lib/http.js',
  'src/lib/log.js',
]);
run('git', [
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'user.name=Fixture',
  '-c',
  'commit.gpgsign=false',
  'commit',
  '-m',
  'baseline',
]);
