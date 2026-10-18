'use strict';

// Setup for the yeet-commit-area-convention behavioral case: a git repo whose
// log mixes two commit-subject conventions with no documented rule anywhere.
// Commits touching parser/ (and its tokenizer test) use a `parser: <subject>`
// prefix; every other commit uses Conventional Commits. The parser is a stable
// subsystem in an otherwise active repo: twenty commits elsewhere have landed
// since it was last touched, so a repo-wide read of the recent log (`git log
// -20` or shorter) shows only the off-area convention, and only a path-scoped
// read finds the area's own. A tokenizer change is then staged but not
// committed. The case measures whether the agent's commit subject follows the
// touched area's convention rather than the newest repo-wide one.
//
// The fixture dir holds every file at its final committed state, except the
// small files the twenty recent commits add, which this script writes itself.
// It commits them in stages, writing an earlier version first where a file
// changes over the history. The repo gets the fixture author's identity (the
// same author as most parser/ commits), no signing, and a no-op editor so the
// agent's own `git commit` finishes headlessly.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const cwd = process.cwd();

const AUTHORS = {
  ana: ['Ana Lima', 'ana.lima@example.invalid'],
  ben: ['Ben Ortiz', 'ben.ortiz@example.invalid'],
  cara: ['Cara Novak', 'cara.novak@example.invalid'],
  dev: ['Dev Rao', 'dev.rao@example.invalid'],
};

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

function read(rel) {
  return fs.readFileSync(path.join(cwd, rel), 'utf8');
}

function write(rel, text) {
  fs.writeFileSync(path.join(cwd, rel), text);
}

function commit(author, date, subject, files) {
  const [name, email] = AUTHORS[author];
  // Staged by name, not `git add -A`, so the tracked set does not depend on
  // the caller's global excludes.
  git(['add', '--', ...files]);
  git(['commit', '-q', '-m', subject], {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: `${date}T10:00:00+00:00`,
    GIT_COMMITTER_DATE: `${date}T10:00:00+00:00`,
  });
}

const README_FINAL = read('README.md');
const USAGE_FINAL = read('docs/usage.md');
const PARSE_FINAL = read('parser/parse.py');
const EMPTY_CHECK = '    if not tokens:\n        raise ParseError("empty expression")\n';
if (!PARSE_FINAL.includes(EMPTY_CHECK)) fail('parser/parse.py lost its empty-expression check');

git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', AUTHORS.ana[0]]);
git(['config', 'user.email', AUTHORS.ana[1]]);
git(['config', 'commit.gpgsign', 'false']);
git(['config', 'core.editor', 'true']);

write('README.md', README_FINAL.split('\n## Installation')[0]);
commit('ana', '2026-06-28', 'Initial commit', ['README.md']);
commit('ana', '2026-07-01', 'parser: add a tokenizer for integer expressions', ['parser/__init__.py', 'parser/tokenize.py']);
write('parser/parse.py', PARSE_FINAL.replace(EMPTY_CHECK, ''));
commit('ben', '2026-07-03', 'parser: parse binary expressions into a tree', ['parser/parse.py']);
commit('ana', '2026-07-06', 'parser: cover the tokenizer with unit tests', ['tests/test_tokenize.py']);
commit('cara', '2026-07-20', 'feat(cli): add the calc command-line entry point', ['cli.py']);
write('docs/usage.md', USAGE_FINAL.split('\n## Operator precedence')[0]);
commit('ben', '2026-08-02', 'docs: add a usage guide', ['docs/usage.md']);
write('parser/parse.py', PARSE_FINAL);
commit('ana', '2026-08-15', 'parser: reject an empty expression with a clear error', ['parser/parse.py']);
// The twenty commits since the parser was last touched, all elsewhere.
function added(author, date, subject, rel, text) {
  fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  write(rel, text);
  commit(author, date, subject, [rel]);
}
const example = (title, expr, result) => `# ${title}\n\n    python3 cli.py "${expr}"\n    ${result}\n`;

added('dev', '2026-08-17', 'docs: add an addition example', 'docs/examples/addition.md', example('Addition', '2 + 3', '5'));
added('ben', '2026-08-18', 'ci: run the unit tests on push', '.github/workflows/test.yml',
  'name: test\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: python3 -m unittest discover -s tests\n');
commit('cara', '2026-08-20', 'test(cli): cover the exit codes', ['tests/test_cli.py']);
added('cara', '2026-08-22', 'build: add a test target to the Makefile', 'Makefile', 'test:\n\tpython3 -m unittest discover -s tests\n');
added('dev', '2026-08-25', 'docs: add a division example', 'docs/examples/division.md', example('Division', '7 / 2', '3'));
write('README.md', README_FINAL);
commit('dev', '2026-08-28', 'docs(readme): describe installation', ['README.md']);
added('ben', '2026-09-01', 'chore: add an editorconfig', '.editorconfig', 'root = true\n\n[*.py]\nindent_style = space\nindent_size = 4\n');
write('.gitignore', '__pycache__/\n*.pyc\n');
commit('ana', '2026-09-05', 'chore: ignore Python bytecode', ['.gitignore']);
added('cara', '2026-09-08', 'docs: describe the error messages', 'docs/errors.md',
  '# Errors\n\n`error: empty expression` means no expression was given.\n`error: expected a number` means an operator appeared where a number belongs.\n');
added('dev', '2026-09-11', 'docs: add a precedence example', 'docs/examples/precedence.md', example('Precedence', '2 + 3 * 4', '14'));
write('docs/usage.md', USAGE_FINAL);
commit('dev', '2026-09-16', 'docs: document operator precedence', ['docs/usage.md']);
added('ben', '2026-09-19', 'feat(scripts): add a REPL helper', 'scripts/repl.py',
  'import cli\n\nwhile True:\n    line = input("calc> ")\n    if not line:\n        break\n    cli.main([line])\n');
added('cara', '2026-09-23', 'ci: lint with ruff on push', '.github/workflows/lint.yml',
  'name: lint\non: [push]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pipx run ruff check .\n');
added('cara', '2026-09-26', 'build: pin ruff in a dev requirements file', 'requirements-dev.txt', 'ruff==0.6.9\n');
commit('cara', '2026-09-30', 'build: add a pyproject.toml', ['pyproject.toml']);
added('dev', '2026-10-02', 'docs: add a subtraction example', 'docs/examples/subtraction.md', example('Subtraction', '8 - 3 - 1', '4'));
added('ben', '2026-10-05', 'test(scripts): add a smoke script for the CLI', 'scripts/smoke.sh',
  '#!/bin/sh\nset -e\n[ "$(python3 cli.py "1 + 1")" = 2 ]\necho ok\n');
added('dev', '2026-10-07', 'docs: add a multiplication example', 'docs/examples/multiplication.md', example('Multiplication', '6 * 7', '42'));
added('cara', '2026-10-09', 'chore: add a license file', 'LICENSE', 'MIT License\n\nCopyright (c) 2026 the calc authors\n');
added('ben', '2026-10-12', 'docs: add a security policy', 'SECURITY.md', '# Security\n\nReport a vulnerability by email to security@example.invalid.\n');

// The staged change: the tokenizer learns parentheses, with a test.
const tokenize = read('parser/tokenize.py');
const TOKENIZE_FROM = '        elif op in OPERATORS:\n            tokens.append(("OP", op))\n';
if (!tokenize.includes(TOKENIZE_FROM)) fail('parser/tokenize.py no longer has the operator branch');
write(
  'parser/tokenize.py',
  tokenize
    .replace('OPERATORS = "+-*/"\n', 'OPERATORS = "+-*/"\nPARENS = "()"\n')
    .replace(TOKENIZE_FROM, `${TOKENIZE_FROM}        elif op in PARENS:\n            tokens.append(("PAREN", op))\n`)
);
const test = read('tests/test_tokenize.py');
const TEST_ANCHOR = '    def test_rejects_unknown_character(self):\n';
if (!test.includes(TEST_ANCHOR)) fail('tests/test_tokenize.py lost its anchor test');
write(
  'tests/test_tokenize.py',
  test.replace(
    TEST_ANCHOR,
    '    def test_parentheses(self):\n' +
      '        self.assertEqual(\n' +
      '            tokenize("(1)"),\n' +
      '            [("PAREN", "("), ("NUM", 1), ("PAREN", ")")],\n' +
      '        )\n\n' +
      TEST_ANCHOR
  )
);
git(['add', '--', 'parser/tokenize.py', 'tests/test_tokenize.py']);

// Preconditions the case depends on, asserted rather than assumed.
const tracked = git(['ls-files']).trim().split('\n').sort().join(' ');
const expected = [
  '.editorconfig', '.github/workflows/lint.yml', '.github/workflows/test.yml', '.gitignore', 'LICENSE',
  'Makefile', 'README.md', 'SECURITY.md', 'cli.py', 'docs/errors.md', 'docs/examples/addition.md',
  'docs/examples/division.md', 'docs/examples/multiplication.md', 'docs/examples/precedence.md',
  'docs/examples/subtraction.md', 'docs/usage.md', 'parser/__init__.py', 'parser/parse.py',
  'parser/tokenize.py', 'pyproject.toml', 'requirements-dev.txt', 'scripts/repl.py', 'scripts/smoke.sh',
  'tests/test_cli.py', 'tests/test_tokenize.py',
].join(' ');
if (tracked !== expected) fail(`tracked files are "${tracked}", expected "${expected}"`);
const staged = git(['diff', '--cached', '--name-only']).trim().split('\n').sort().join(' ');
if (staged !== 'parser/tokenize.py tests/test_tokenize.py') fail(`staged files are "${staged}"`);
if (/^parser: /m.test(git(['log', '-20', '--format=%s']))) fail('a parser: subject is among the twenty newest commits');
if (!/^parser: /.test(git(['log', '-21', '--format=%s']).trim().split('\n')[20])) fail('the 21st newest commit is not the last parser: commit');
if (/^parser: /.test(read('.git/COMMIT_EDITMSG'))) fail('COMMIT_EDITMSG already holds a parser: subject');
