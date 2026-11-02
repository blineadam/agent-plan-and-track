#!/usr/bin/env node
/**
 * Deterministic fixtures for the repeat-edit notice in hooks/gateguard.js.
 *
 * PLACEMENT (deliberate documented variant). Same reason as
 * hooks/scripts/run-git-guard-fixtures.js: gateguard.js is one shared script
 * exercised across all three wire dialects from a single process, so its
 * fixtures sit at hooks/scripts/ rather than under a harness directory.
 *
 * NO cases.json. Unlike git-guard's declarative cases, each case here builds
 * a scratch git repository with a commit script (which files each commit
 * changed, in order) and the expected streak is read off that script, never
 * off the hook's output. That setup is imperative, so the cases live in this
 * file next to the script that builds their repos.
 *
 * This runner spawns the real hooks/gateguard.js per step and asserts on its
 * output. Every case gets its own scratch root: TMPDIR/TEMP/TMP point at
 * root/state (gateguard.js derives its state dir from os.tmpdir()), repos are
 * built under root/work, and the whole root is removed afterwards. Ambient
 * GATEGUARD_* and GIT_* variables are stripped, and git's system and global
 * config are switched off, so the dev shell can't leak into a case. Running
 * the suite twice gives identical results.
 *
 * The two cases that force a git failure with a fake `git` shell script print
 * SKIP on Windows, where a bare `git` cannot be a script; the real-git
 * unknown-extension case covers the same diagnostic there.
 *
 * Only the notice is asserted. The first-edit fact demand is gateguard's
 * existing behavior; where a step is a first edit, the notice assertions look
 * for the notice text or its absence, not for silence.
 */
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'gateguard.js');
const NOTICE = 'Repeat edit:';

function scratchEnv(root) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GATEGUARD_') || key.startsWith('GIT_')) delete env[key];
  }
  const state = path.join(root, 'state');
  fs.mkdirSync(state, { recursive: true });
  // An empty file, not os.devNull: Git for Windows can't open `\\.\nul`.
  const globalConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  return {
    ...env,
    TMPDIR: state,
    TEMP: state,
    TMP: state,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CEILING_DIRECTORIES: root,
  };
}

function git(cwd, env, ...args) {
  return childProcess.execFileSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, env, stdio: 'pipe', encoding: 'utf8' }
  );
}

// The commit script. Each entry is one commit and lists the repo-relative
// files it changes; a leading '-' deletes the file instead. `first` numbers
// the commits so every change writes distinct content. Expected streaks in
// the cases are counted from these lists.
function commit(repo, env, entries, first = 0) {
  entries.forEach((files, i) => {
    for (const f of files) {
      if (f.startsWith('-')) {
        git(repo, env, 'rm', '-q', f.slice(1));
        continue;
      }
      const abs = path.join(repo, f);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, `change ${first + i}\n`);
      git(repo, env, 'add', '--', f);
    }
    git(repo, env, 'commit', '-q', '-m', `commit ${first + i}`);
  });
}

function newRepo(root, env, name = 'repo', branch = 'main') {
  const repo = path.join(root, 'work', name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, env, 'init', '-q', '-b', branch);
  return repo;
}

// A `git` earlier on PATH than the real one, for forcing git failures. A
// shell script, so the cases that use it are POSIX only (see posixOnly).
function withFakeGit(root, env, body) {
  const bin = path.join(root, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { ...env, PATH: bin + path.delimiter + env.PATH };
}

const SKIP = 'SKIP';
function posixOnly(fn) {
  return () => (process.platform === 'win32' ? SKIP : fn());
}

// Make `main` look like a fetched default branch: origin/HEAD -> origin/main.
function setOriginHead(repo, env) {
  git(repo, env, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, env, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
}

function claudeEdit(session, file, extra = {}) {
  return {
    session_id: session,
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
    ...extra,
  };
}

function claudeWrite(session, file) {
  return { session_id: session, tool_name: 'Write', tool_input: { file_path: file, content: 'x' } };
}

function copilotTool(session, toolName, file) {
  return { sessionId: session, toolName, toolArgs: JSON.stringify({ path: file }) };
}

function spawnHook(payload, env) {
  const result = childProcess.spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env,
    input: JSON.stringify(payload),
  });
  assert.strictEqual(result.status, 0, `nonzero exit ${result.status}, stderr: ${result.stderr}`);
  return result;
}

// The model-facing text of a snake-dialect result ('' when the hook was silent).
function context(result) {
  if (result.stdout === '') return '';
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.hookSpecificOutput, `expected hookSpecificOutput, got ${result.stdout}`);
  return parsed.hookSpecificOutput.additionalContext || '';
}

function withScratch(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gateguard-fixtures-')));
  try {
    fn(root, scratchEnv(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const CASES = {
  // Commits (oldest first): [a,x] [x] [a] [a]. The newest two touch a.js and
  // the third from the top does not, so a.js has a streak of 2.
  'streak-2-warns-with-count': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js', 'x.js'], ['x.js'], ['a.js'], ['a.js']]);
      const text = context(spawnHook(claudeEdit('s1', path.join(repo, 'a.js')), env));
      assert.ok(
        text.includes('Repeat edit: the last 2 changes landed on the default branch all edited'),
        text
      );
      assert.ok(text.includes('this would be change 3 in a row'), text);
      assert.ok(text.includes(path.join(repo, 'a.js')), text);
      assert.ok(text.includes('First edit of'), `first-edit fact demand should still ride along: ${text}`);
    }),

  // Commits: [a,x] [x] [a]. Only the newest touches a.js: streak 1.
  'streak-1-silent': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js', 'x.js'], ['x.js'], ['a.js']]);
      const result = spawnHook(claudeEdit('s1', path.join(repo, 'a.js')), env);
      assert.ok(!context(result).includes(NOTICE), context(result));
    }),

  'non-repo-silent': () =>
    withScratch((root, env) => {
      const plain = path.join(root, 'work', 'plain');
      fs.mkdirSync(plain, { recursive: true });
      fs.writeFileSync(path.join(plain, 'a.js'), 'x\n');
      const result = spawnHook(claudeEdit('s1', path.join(plain, 'a.js')), env);
      assert.ok(!context(result).includes(NOTICE), context(result));
      assert.strictEqual(result.stderr, '', 'a non-repo path should fail open without a diagnostic');
    }),

  // git exists but is not on PATH for the hook: PATH points at an empty dir.
  'missing-git-binary-silent': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js'], ['a.js'], ['a.js']]);
      // Liveness: with git reachable the same edit warns.
      const live = spawnHook(claudeEdit('live', path.join(repo, 'a.js')), env);
      assert.ok(context(live).includes(NOTICE), context(live));
      const empty = path.join(root, 'empty-path');
      fs.mkdirSync(empty);
      // Windows spells the key `Path`; drop every casing before setting PATH.
      const noGitEnv = { ...env };
      for (const key of Object.keys(noGitEnv)) {
        if (/^path$/i.test(key)) delete noGitEnv[key];
      }
      noGitEnv.PATH = empty;
      const result = spawnHook(claudeEdit('nogit', path.join(repo, 'a.js')), noGitEnv);
      assert.ok(!context(result).includes(NOTICE), context(result));
      assert.strictEqual(result.stderr, '', 'a missing git binary should fail open without a diagnostic');
    }),

  // test/a.test.js and src/a.js change in the same three commits, so both
  // have a streak of 3; only the non-exempt file warns.
  'exempt-test-file-silent': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [
        ['src/a.js', 'test/a.test.js'],
        ['src/a.js', 'test/a.test.js'],
        ['src/a.js', 'test/a.test.js'],
      ]);
      const exempt = spawnHook(claudeEdit('s1', path.join(repo, 'test', 'a.test.js')), env);
      assert.ok(!context(exempt).includes(NOTICE), context(exempt));
      const live = spawnHook(claudeEdit('s1', path.join(repo, 'src', 'a.js')), env);
      assert.ok(context(live).includes('the last 3 changes'), context(live));
    }),

  // origin/HEAD is main at [a,x] [x] [a]: a.js streak 1. Two topic-branch
  // commits then edit a.js, which would make 3 if the topic commits counted.
  'topic-branch-commits-not-counted': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js', 'x.js'], ['x.js'], ['a.js']]);
      setOriginHead(repo, env);
      git(repo, env, 'switch', '-q', '-c', 'topic');
      commit(repo, env, [['a.js'], ['a.js']], 10);
      const result = spawnHook(claudeEdit('s1', path.join(repo, 'a.js')), env);
      assert.ok(!context(result).includes(NOTICE), context(result));
    }),

  // origin/HEAD is main at [a,x] [x] [a] [a]: streak 2. One topic commit on
  // a.js would make 3 if counted; the message must say 2.
  'origin-head-count-excludes-topic': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js', 'x.js'], ['x.js'], ['a.js'], ['a.js']]);
      setOriginHead(repo, env);
      git(repo, env, 'switch', '-q', '-c', 'topic');
      commit(repo, env, [['a.js']], 10);
      const text = context(spawnHook(claudeEdit('s1', path.join(repo, 'a.js')), env));
      assert.ok(text.includes('the last 2 changes'), text);
      assert.ok(!text.includes('the last 3 changes'), text);
    }),

  // Commits: [a] [a]: streak 2 at tip T1. A second edit at T1 is silent; a
  // new commit moves the tip, streak 3, and the next edit warns again.
  'second-edit-same-tip-silent-new-tip-rewarns': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js'], ['a.js']]);
      const file = path.join(repo, 'a.js');
      const first = spawnHook(claudeEdit('s1', file), env);
      assert.ok(context(first).includes('the last 2 changes'), context(first));
      const second = spawnHook(claudeEdit('s1', file), env);
      assert.strictEqual(second.stdout, '', `same tip should stay silent: ${second.stdout}`);
      commit(repo, env, [['a.js']], 10);
      const third = context(spawnHook(claudeEdit('s1', file), env));
      assert.ok(third.includes('the last 3 changes'), third);
      assert.ok(!third.includes('First edit of'), `not a first edit: ${third}`);
      const fourth = spawnHook(claudeEdit('s1', file), env);
      assert.strictEqual(fourth.stdout, '', `new tip already warned: ${fourth.stdout}`);
    }),

  // Commits: [a] [a]: streak 2. A subagent payload gets the notice and no
  // fact demand; on a file with no streak it is silent.
  'subagent-gets-notice-only': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js', 'b.js'], ['a.js']]);
      const sub = context(spawnHook(claudeEdit('s1', path.join(repo, 'a.js'), { agent_id: 'sub-1' }), env));
      assert.ok(sub.includes('the last 2 changes'), sub);
      assert.ok(sub.includes('A subagent reports this line to its caller'), sub);
      assert.ok(!sub.includes('First edit of'), sub);
      assert.ok(!sub.includes('present these facts'), sub);
      const quiet = spawnHook(claudeEdit('s1', path.join(repo, 'b.js'), { agent_id: 'sub-1' }), env);
      assert.strictEqual(quiet.stdout, '', `no streak, no fact demand for a subagent: ${quiet.stdout}`);
    }),

  // Commits: [a] [a]: streak 2. Copilot denies a first edit, so the notice
  // rides the deny reason; after a new commit a later edit degrades to stderr.
  'copilot-first-edit-deny-carries-notice': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js'], ['a.js']]);
      const file = path.join(repo, 'a.js');
      const first = spawnHook(copilotTool('c1', 'edit', file), env);
      const parsed = JSON.parse(first.stdout);
      assert.strictEqual(parsed.permissionDecision, 'deny', first.stdout);
      assert.ok(parsed.permissionDecisionReason.includes('First edit of'), parsed.permissionDecisionReason);
      assert.ok(parsed.permissionDecisionReason.includes('the last 2 changes'), parsed.permissionDecisionReason);
      const retry = spawnHook(copilotTool('c1', 'edit', file), env);
      assert.strictEqual(retry.stdout, JSON.stringify({ permissionDecision: 'allow' }));
      assert.ok(!retry.stderr.includes(NOTICE), retry.stderr);
      commit(repo, env, [['a.js']], 10);
      const later = spawnHook(copilotTool('c1', 'edit', file), env);
      assert.strictEqual(later.stdout, JSON.stringify({ permissionDecision: 'allow' }));
      assert.ok(later.stderr.includes('(warn)') && later.stderr.includes('the last 3 changes'), later.stderr);
    }),

  // Commits: [a,x] [a] [-a]: a.js was edited by the last three changes, the
  // newest deleting it. Writing it fresh is a create and never counts; an Edit
  // of the same path in another session would.
  'new-file-create-silent': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js', 'x.js'], ['a.js'], ['-a.js']]);
      const file = path.join(repo, 'a.js');
      const created = spawnHook(claudeWrite('s1', file), env);
      assert.ok(context(created).includes('Creating'), context(created));
      assert.ok(!context(created).includes(NOTICE), context(created));
      const copilotCreate = spawnHook(copilotTool('c1', 'create', file), env);
      assert.ok(!copilotCreate.stdout.includes(NOTICE), copilotCreate.stdout);
      const edited = context(spawnHook(claudeEdit('s2', file), env));
      assert.ok(edited.includes('the last 3 changes'), edited);
    }),

  // Commits: [d/f] [d/f]: streak 2 on a path with spaces in directory and file.
  'path-with-space': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['my dir/sub dir/file name.js'], ['my dir/sub dir/file name.js']]);
      const file = path.join(repo, 'my dir', 'sub dir', 'file name.js');
      const text = context(spawnHook(claudeEdit('s1', file), env));
      assert.ok(text.includes('the last 2 changes'), text);
      assert.ok(text.includes(file), text);
    }),

  // Codex sends a relative path in an apply_patch envelope plus the cwd.
  // Commits: [src/a] [src/a]: streak 2.
  'relative-path-resolved-against-cwd': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['src/a.js'], ['src/a.js']]);
      const payload = {
        session_id: 'x1',
        cwd: repo,
        tool_name: 'apply_patch',
        tool_input: { command: '*** Begin Patch\n*** Update File: src/a.js\n@@\n-a\n+b\n*** End Patch' },
      };
      const text = context(spawnHook(payload, env));
      assert.ok(text.includes('the last 2 changes'), text);
      assert.ok(text.includes('edited src/a.js'), text);
    }),

  // origin/main is main at [a,x] [x] [a] [a]: a.js streak 2. origin/HEAD is
  // unset, local main then moves on with [x] (streak 0 if it were the ref), and
  // two topic commits on a.js sit on HEAD (streak 4 if HEAD were the ref).
  'origin-main-used-when-origin-head-unset': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js', 'x.js'], ['x.js'], ['a.js'], ['a.js']]);
      git(repo, env, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      commit(repo, env, [['x.js']], 10);
      git(repo, env, 'switch', '-q', '-c', 'topic');
      commit(repo, env, [['a.js'], ['a.js']], 20);
      const text = context(spawnHook(claudeEdit('s1', path.join(repo, 'a.js')), env));
      assert.ok(text.includes('the last 2 changes'), text);
    }),

  // The only branch is `develop` and no remote refs exist: no default branch is
  // known, so nothing is counted and nothing is reported. Commits: [a] [a] [a].
  // Renaming the branch to main makes the same history count 3.
  'only-develop-branch-silent': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env, 'repo', 'develop');
      commit(repo, env, [['a.js'], ['a.js'], ['a.js']]);
      const file = path.join(repo, 'a.js');
      const result = spawnHook(claudeEdit('s1', file), env);
      assert.ok(!context(result).includes(NOTICE), context(result));
      assert.strictEqual(result.stderr, '', 'no default branch is an expected absence, not a failure');
      git(repo, env, 'branch', '-m', 'main');
      const live = context(spawnHook(claudeEdit('s2', file), env));
      assert.ok(live.includes('the last 3 changes'), live);
    }),

  // Commits: [app/i.tsx] [app/[id].tsx] [app/[id].tsx]. [id].tsx was edited by
  // the newest two changes only: streak 2. As a glob, `[id].tsx` would also
  // match i.tsx and count the oldest commit too (3). i.tsx itself was not in
  // the newest commit: no notice.
  'glob-characters-in-name-match-exactly': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['app/i.tsx'], ['app/[id].tsx'], ['app/[id].tsx']]);
      const text = context(spawnHook(claudeEdit('s1', path.join(repo, 'app', '[id].tsx')), env));
      assert.ok(text.includes('the last 2 changes'), text);
      assert.ok(!text.includes('the last 3 changes'), text);
      const plain = context(spawnHook(claudeEdit('s2', path.join(repo, 'app', 'i.tsx')), env));
      assert.ok(!plain.includes(NOTICE), plain);
    }),

  // main: C1 [a,x]; topic from C1: T1 [a]; main: C2 [x]; merge topic with a
  // merge commit M; main: C3 [a]. First-parent history is C3 [a], M, C2 [x],
  // C1. M's diff against its first parent (C2) is a.js, which only topic
  // changed, so a.js streak is 2 (C3, M). Counted against the second parent M
  // would show x.js instead and the streak would be 1.
  'merge-commit-counts-first-parent-diff': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js', 'x.js']]);
      git(repo, env, 'switch', '-q', '-c', 'topic');
      commit(repo, env, [['a.js']], 10);
      git(repo, env, 'switch', '-q', 'main');
      commit(repo, env, [['x.js']], 20);
      git(repo, env, 'merge', '--no-ff', '-q', '-m', 'merge topic', 'topic');
      commit(repo, env, [['a.js']], 30);
      const text = context(spawnHook(claudeEdit('s1', path.join(repo, 'a.js')), env));
      assert.ok(text.includes('the last 2 changes'), text);
    }),

  // Commits: [a] [a]: streak 2. A subagent's notice does not use up the
  // parent's, a second subagent has its own, and each agent is quiet at the
  // same tip afterwards.
  'subagent-claim-does-not-consume-parent': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js'], ['a.js']]);
      const file = path.join(repo, 'a.js');
      const sub1 = context(spawnHook(claudeEdit('s1', file, { agent_id: 'sub-1' }), env));
      assert.ok(sub1.includes('the last 2 changes'), sub1);
      const parent = context(spawnHook(claudeEdit('s1', file), env));
      assert.ok(parent.includes('the last 2 changes'), parent);
      assert.ok(parent.includes('First edit of'), parent);
      const sub2 = context(spawnHook(claudeEdit('s1', file, { agent_id: 'sub-2' }), env));
      assert.ok(sub2.includes('the last 2 changes'), sub2);
      assert.strictEqual(spawnHook(claudeEdit('s1', file), env).stdout, '', 'parent is quiet at the same tip');
      assert.strictEqual(
        spawnHook(claudeEdit('s1', file, { agent_id: 'sub-1' }), env).stdout,
        '',
        'sub-1 is quiet at the same tip'
      );
    }),

  // Every file changes in all three commits, so each has a streak of 3. All of
  // these are exempt wherever they sit and whatever their case, except the
  // control, which warns.
  'exemptions-match-any-depth-and-case': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      const exempt = [
        'packages/a/docs/x.md',
        'packages/a/CHANGELOG.md',
        'readme.md',
        'Tests/foo.py',
        '.github/copilot-instructions.md',
        'packages/a/.github/instructions/style.instructions.md',
        'packages/a/.github/copilot-instructions.md',
      ];
      const control = 'packages/a/src/y.js';
      const all = [...exempt, control];
      commit(repo, env, [all, all, all]);
      exempt.forEach((rel, i) => {
        const text = context(spawnHook(claudeEdit(`e${i}`, path.join(repo, rel)), env));
        assert.ok(!text.includes(NOTICE), `${rel} should be exempt: ${text}`);
      });
      const live = context(spawnHook(claudeEdit('ctl', path.join(repo, control)), env));
      assert.ok(live.includes('the last 3 changes'), live);
    }),

  // diff.relative=true would make --name-only paths relative to the file's dir.
  'diff-relative-config-does-not-hide-nested-file': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['src/a.js'], ['src/a.js'], ['src/a.js']]);
      git(repo, env, 'config', 'diff.relative', 'true');
      const text = context(spawnHook(claudeEdit('r1', path.join(repo, 'src', 'a.js')), env));
      assert.ok(text.includes('the last 3 changes'), text);
    }),

  // Git C-quotes this name in its human-readable output. Windows forbids `"`.
  'quoted-filename-matches': posixOnly(() =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a"b.js'], ['a"b.js']]);
      const text = context(spawnHook(claudeEdit('q1', path.join(repo, 'a"b.js')), env));
      assert.ok(text.includes('the last 2 changes'), text);
    })
  ),

  // Twelve landed edits against a ten-commit window: the count is a lower bound.
  'full-window-reports-lower-bound': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, Array.from({ length: 12 }, () => ['a.js']));
      const text = context(spawnHook(claudeEdit('w1', path.join(repo, 'a.js')), env));
      assert.ok(text.includes('at least the last 10 changes landed'), text);
      assert.ok(text.includes('this would be change 11 or later in a row'), text);
    }),

  // A fake git that exits 2 with a message stands in for any unexpected git
  // failure: the edit is allowed, no notice appears, and exactly one stderr
  // line says the check did not run.
  'unexpected-git-failure-writes-one-line': posixOnly(() =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js'], ['a.js']]);
      const file = path.join(repo, 'a.js');
      const failing = withFakeGit(root, env, "echo 'fatal: simulated failure' >&2\nexit 2");
      const result = spawnHook(claudeEdit('s1', file), failing);
      assert.ok(!context(result).includes(NOTICE), context(result));
      assert.strictEqual(
        result.stderr,
        `[GateGuard] repeat-edit check skipped for ${file}: git exited 2: fatal: simulated failure. The notice did not run; check that git works in that directory.\n`
      );
    })
  ),

  // A real git failure with no fake: an unknown repository extension makes
  // every git command exit 128 without saying "not a git repository".
  'unknown-repository-extension-writes-one-line': () =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js'], ['a.js']]);
      git(repo, env, 'config', 'core.repositoryformatversion', '1');
      git(repo, env, 'config', 'extensions.bogusthing', 'true');
      const file = path.join(repo, 'a.js');
      const result = spawnHook(claudeEdit('s1', file), env);
      assert.ok(!context(result).includes(NOTICE), context(result));
      const lines = result.stderr.split('\n').filter(Boolean);
      assert.strictEqual(lines.length, 1, result.stderr);
      assert.match(
        lines[0],
        /^\[GateGuard\] repeat-edit check skipped for .*a\.js: git exited 128: fatal: unknown repository extensions? found:?\. The notice did not run; check that git works in that directory\.$/
      );
    }),

  // One 3000 ms deadline covers the whole run: a git that hangs times out on
  // the first path, the other two are skipped, and a single line is written.
  'deadline-spent-skips-remaining-paths-with-one-line': posixOnly(() =>
    withScratch((root, env) => {
      const repo = newRepo(root, env);
      commit(repo, env, [['a.js', 'b.js', 'c.js'], ['a.js', 'b.js', 'c.js']]);
      const hanging = withFakeGit(root, env, 'exec sleep 30');
      const patch = ['a.js', 'b.js', 'c.js'].map((f) => `*** Update File: ${f}`).join('\n@@\n-a\n+b\n');
      const payload = {
        session_id: 'x1',
        cwd: repo,
        tool_name: 'apply_patch',
        tool_input: { command: `*** Begin Patch\n${patch}\n@@\n-a\n+b\n*** End Patch` },
      };
      const started = Date.now();
      const result = spawnHook(payload, hanging);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 6000, `three hanging paths should share one deadline, took ${elapsed} ms`);
      const lines = result.stderr.split('\n').filter(Boolean);
      assert.strictEqual(lines.length, 1, result.stderr);
      assert.ok(lines[0].includes('repeat-edit check skipped for a.js: git timed out'), lines[0]);
      assert.ok(!context(result).includes(NOTICE), context(result));
    })
  ),
};

function main() {
  let failures = 0;
  let skips = 0;
  const ids = Object.keys(CASES);
  for (const id of ids) {
    try {
      const outcome = CASES[id]();
      if (outcome === SKIP) skips += 1;
      process.stdout.write(outcome === SKIP ? `SKIP ${id}: needs a POSIX shell\n` : `PASS ${id}\n`);
    } catch (err) {
      process.stdout.write(`FAIL ${id}: ${(err && err.stack) || err}\n`);
      failures += 1;
    }
  }
  process.stdout.write(`${ids.length - failures - skips}/${ids.length} cases passed, ${skips} skipped\n`);
  process.exit(failures ? 1 : 0);
}

main();
