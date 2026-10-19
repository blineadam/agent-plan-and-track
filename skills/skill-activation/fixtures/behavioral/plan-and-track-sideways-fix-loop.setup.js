'use strict';

// Setup for the plan-and-track-sideways-fix-loop behavioral case: a git repo
// whose history shows two earlier fixes to the same unit, each for a different
// URL edge case in slack_format.py's regexes. The fixture dir holds every file
// at its final state; this script writes the two earlier states of
// slack_format.py and tests/test_slack_format.py itself, commits them in
// order, and leaves the final state as the working tree. The third review
// finding (review-round-3.md) and .tasks/ stay untracked.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const cwd = process.cwd();

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function git(args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) {
    fail(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

const read = (rel) => fs.readFileSync(path.join(cwd, rel), 'utf8');
const write = (rel, text) => fs.writeFileSync(path.join(cwd, rel), text);

function commit(date, subject, files) {
  git(['add', '--', ...files]);
  git(['commit', '-q', '-m', subject], {
    GIT_AUTHOR_DATE: `${date}T10:00:00+00:00`,
    GIT_COMMITTER_DATE: `${date}T10:00:00+00:00`,
  });
}

const MODULE_FINAL = read('slack_format.py');
const TESTS_FINAL = read('tests/test_slack_format.py');

// Stage 1 differs from the final module only in the bare-URL pattern.
const PATTERN_FINAL = 'BARE_URL = re.compile(r"https?://[^\\s)]+")';
const PATTERN_STAGE1 = 'BARE_URL = re.compile(r"https?://\\S+")';
if (!MODULE_FINAL.includes(PATTERN_FINAL)) fail('slack_format.py lost its BARE_URL pattern');
const MODULE_STAGE1 = MODULE_FINAL.replace(PATTERN_FINAL, PATTERN_STAGE1);

// Stage 0 has no URL handling: links and emphasis convert in place.
const MODULE_STAGE0 = `"""Convert the Markdown our summarizer emits into Slack mrkdwn."""
import re

LINK = re.compile(r"\\[([^\\]]+)\\]\\((https?://[^)\\s]+)\\)")
BOLD = re.compile(r"\\*\\*(.+?)\\*\\*|__(.+?)__")
HEADING = re.compile(r"^#{1,6}\\s+(.*)$", re.MULTILINE)


def markdown_to_slack(text):
    """Return text with bold, headings, and links rewritten as Slack mrkdwn."""
    text = LINK.sub(r"<\\2|\\1>", text)
    text = BOLD.sub(lambda m: f"*{m.group(1) or m.group(2)}*", text)
    return HEADING.sub(lambda m: f"*{m.group(1)}*", text)
`;

// The final test file ends with the two regression tests, in this order.
const FIX1_TEST = '\n    def test_keeps_underscores_in_bare_url(self):';
const FIX2_TEST = '\n    def test_bare_url_stops_at_closing_paren(self):';
const MAIN_GUARD = '\n\nif __name__ == "__main__":\n    unittest.main()\n';
const i1 = TESTS_FINAL.indexOf(FIX1_TEST);
const i2 = TESTS_FINAL.indexOf(FIX2_TEST);
if (i1 < 0 || i2 < i1) fail('tests/test_slack_format.py lost its regression tests or their order');
if (!TESTS_FINAL.endsWith(MAIN_GUARD)) fail('tests/test_slack_format.py lost its main guard');
const TESTS_STAGE0 = TESTS_FINAL.slice(0, i1).replace(/\n+$/, '\n') + MAIN_GUARD;
const TESTS_STAGE1 = TESTS_FINAL.slice(0, i2).replace(/\n+$/, '\n') + MAIN_GUARD;

git(['init', '-q', '-b', 'url-edge-cases']);
git(['config', 'user.name', 'Ana Lima']);
git(['config', 'user.email', 'ana.lima@example.invalid']);
git(['config', 'commit.gpgsign', 'false']);
git(['config', 'core.editor', 'true']);

write('slack_format.py', MODULE_STAGE0);
write('tests/test_slack_format.py', TESTS_STAGE0);
commit('2026-09-14', 'Add a Markdown to Slack mrkdwn converter', [
  'AGENTS.md', 'README.md', 'requirements.txt', 'slack_format.py', 'tests/test_slack_format.py',
]);

write('slack_format.py', MODULE_STAGE1);
write('tests/test_slack_format.py', TESTS_STAGE1);
commit('2026-09-21', 'Keep underscores inside bare URLs through emphasis conversion', [
  'slack_format.py', 'tests/test_slack_format.py',
]);

write('slack_format.py', MODULE_FINAL);
write('tests/test_slack_format.py', TESTS_FINAL);
commit('2026-09-28', 'Stop a bare URL at a closing parenthesis', [
  'slack_format.py', 'tests/test_slack_format.py',
]);

// Preconditions the case depends on, asserted rather than assumed.
const tracked = git(['ls-files']).trim().split('\n').sort().join(' ');
const expected = 'AGENTS.md README.md requirements.txt slack_format.py tests/test_slack_format.py';
if (tracked !== expected) fail(`tracked files are "${tracked}", expected "${expected}"`);
const subjects = git(['log', '--format=%s']).trim().split('\n');
if (subjects.length !== 3) fail(`expected 3 commits, found ${subjects.length}`);
if (git(['status', '--porcelain', '--untracked-files=no']).trim() !== '') fail('tracked files are dirty after setup');
