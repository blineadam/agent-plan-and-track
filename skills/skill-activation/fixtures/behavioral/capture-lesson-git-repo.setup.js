'use strict';

// Setup shared by the two capture-lesson routing behavioral cases
// (capture-lesson-routes-project-fact and
// capture-lesson-keeps-process-lesson-local): commits the copied fixture as
// a baseline git repo so `git rev-parse --is-inside-work-tree` and
// `git ls-files --error-unmatch AGENTS.md` both succeed, letting the skill's
// routing step confirm AGENTS.md is a tracked file. No post-commit file
// rewrite: unlike plan-and-track-risk-classification-normal.setup.js, these
// cases need only a clean, fully committed repo, not an uncommitted diff.

const { spawnSync } = require('child_process');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write(`error: ${command} ${args.join(' ')} exited ${result.status}\n`);
    process.exit(result.status || 1);
  }
}

run('git', ['init', '-b', 'main']);
run('git', ['add', '-A']);
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
