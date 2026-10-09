'use strict';

// Setup for the yeet-pr-body-headings behavioral case: a git repo on main with
// one commit and a small change (a --shout flag for greet.py, plus its test)
// staged but not committed. There is deliberately no remote and the agent has
// no GitHub access, so the case measures only the PR body the skill's step 6
// has the agent write.
//
// The repo gets a local identity and a no-op editor so the agent's own
// `git commit` finishes headlessly instead of failing on a missing identity or
// hanging in an editor; neither changes what the skill has to do.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const cwd = process.cwd();

function git(args, date) {
  const env = { ...process.env };
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  const result = spawnSync('git', args, { cwd, stdio: 'inherit', env });
  if (result.status !== 0) {
    process.stderr.write(`error: git ${args.join(' ')} exited ${result.status}\n`);
    process.exit(result.status || 1);
  }
}

const GREET_AFTER = `import argparse


def greeting(name, shout=False):
    text = f"Hello, {name}!"
    return text.upper() if shout else text


def main(argv=None):
    parser = argparse.ArgumentParser(description="Print a greeting.")
    parser.add_argument("name")
    parser.add_argument("--shout", action="store_true", help="print the greeting in upper case")
    args = parser.parse_args(argv)
    print(greeting(args.name, shout=args.shout))


if __name__ == "__main__":
    main()
`;

const TEST_AFTER = `import unittest

import greet


class GreetTest(unittest.TestCase):
    def test_greeting(self):
        self.assertEqual(greet.greeting("Ada"), "Hello, Ada!")

    def test_greeting_shout(self):
        self.assertEqual(greet.greeting("Ada", shout=True), "HELLO, ADA!")


if __name__ == "__main__":
    unittest.main()
`;

git(['init', '-b', 'main']);
git(['config', 'user.email', 'fixture@example.invalid']);
git(['config', 'user.name', 'Fixture']);
git(['config', 'commit.gpgsign', 'false']);
git(['config', 'core.editor', 'true']);

// Staged by name, not `git add -A`, so the tracked set does not depend on the
// caller's global excludes.
git(['add', '--', 'README.md', 'greet.py', 'tests/test_greet.py']);
git(['commit', '-m', 'Add the greet CLI'], '2026-09-01T09:00:00+00:00');

fs.writeFileSync(path.join(cwd, 'greet.py'), GREET_AFTER);
fs.writeFileSync(path.join(cwd, 'tests', 'test_greet.py'), TEST_AFTER);
git(['add', '--', 'greet.py', 'tests/test_greet.py']);
