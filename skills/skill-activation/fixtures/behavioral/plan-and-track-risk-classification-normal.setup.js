'use strict';

// Setup for the plan-and-track-risk-classification-normal behavioral case:
// commits the fixture dir as a baseline repo, then rewrites src/format.js
// with a corrected version and leaves it uncommitted, so the case's prompt
// (which asks the agent to review Batch 1's uncommitted work) has a real,
// low-stakes diff to review.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const POST_CHANGE_FORMAT = `'use strict';

// Wraps a single line of plain text so no printed line exceeds 80
// characters, breaking only at whitespace.

const MAX_LINE_WIDTH = 80;

function wrapLine(text) {
  const words = text.split(/\\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    // Stay under the 80-character limit before starting a new line.
    const candidate = current ? \`\${current} \${word}\` : word;
    if (candidate.length > MAX_LINE_WIDTH) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

module.exports = { wrapLine, MAX_LINE_WIDTH };
`;

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

fs.writeFileSync(path.join(process.cwd(), 'src', 'format.js'), POST_CHANGE_FORMAT);
