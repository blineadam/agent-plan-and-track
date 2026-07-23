#!/usr/bin/env node
/** Deterministic disk-delta fixtures for the non-installed Codex pilot. */
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'plan-gate-pilot.js');
const CASES = path.join(__dirname, '..', 'fixtures', 'plan-gate-pilot', 'cases.json');

function run(phase, input, env) {
  const result = childProcess.spawnSync(process.execPath, [SCRIPT, phase], {
    encoding: 'utf8',
    env,
    input: typeof input === 'string' ? input : JSON.stringify(input),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}

function runAsync(phase, input, env) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [SCRIPT, phase], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`))));
    child.stdin.end(JSON.stringify(input));
  });
}

function hash(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-gate-pilot-'));
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  return { env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root }, root };
}

function event(root, id, session, extra) {
  return {
    cwd: root,
    session_id: session || 'fixture-session',
    tool_name: 'apply_patch',
    tool_input: { command: `*** Update File: ${id}` },
    tool_use_id: extra && extra.tool_use_id ? extra.tool_use_id : `tool-${id.replace(/[^a-z0-9]/gi, '-')}`,
    ...(extra || {}),
  };
}

function source(root, file, text) {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text, 'utf8');
}

function warning(stdout) {
  assert.notStrictEqual(stdout, '');
  const parsed = JSON.parse(stdout);
  assert.deepStrictEqual(Object.keys(parsed), ['systemMessage']);
  assert.match(parsed.systemMessage, /^\[PlanGate\] /);
  return parsed.systemMessage;
}

function scopeFile(root, input) {
  const cwd = fs.realpathSync(root);
  return path.join(root, 'codex-plan-gate-pilot', 'scopes', hash([input.session_id, cwd]) + '.json');
}

function scope(root, input) {
  return JSON.parse(fs.readFileSync(scopeFile(root, input), 'utf8'));
}

function transaction(root, input) {
  const cwd = fs.realpathSync(root);
  return path.join(root, 'codex-plan-gate-pilot', 'transactions', hash([input.session_id, cwd, input.tool_use_id]) + '.json');
}

function validPlan(label) {
  return `# ${label}\n\n## Plan\n- [ ] ${label}; verify: node check.js (executor)\n`;
}

async function fresh() {
  const f = fixture();
  source(f.root, 'tasks/todo.md', '# Start\n');
  const input = event(f.root, 'tasks/todo.md');
  run('--pre', input, f.env);
  source(f.root, 'tasks/todo.md', validPlan('Fresh'));
  assert.strictEqual(run('--post', input, f.env), '');
  assert.strictEqual(scope(f.root, input).stamped, true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function stale() {
  const f = fixture();
  source(f.root, 'tasks/todo.md', validPlan('Old'));
  const input = event(f.root, 'tasks/todo.md');
  run('--pre', input, f.env);
  source(f.root, 'tasks/todo.md', validPlan('Old'));
  assert.strictEqual(run('--post', input, f.env), '');
  assert.strictEqual(fs.existsSync(transaction(f.root, input)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function malformed() {
  const f = fixture();
  assert.strictEqual(run('--pre', '{bad', f.env), '');
  assert.strictEqual(run('--post', { tool_name: 'apply_patch' }, f.env), '');
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function noOp() {
  const f = fixture();
  source(f.root, 'one.js', 'one\n');
  const input = event(f.root, 'one.js');
  run('--pre', input, f.env);
  assert.strictEqual(run('--post', input, f.env), '');
  assert.strictEqual(fs.existsSync(scopeFile(f.root, input)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function nonTodoSnapshotRedacted() {
  const f = fixture();
  source(f.root, 'secret.txt', 'do-not-retain-this-value\n');
  const input = event(f.root, 'secret.txt');
  run('--pre', input, f.env);
  const saved = fs.readFileSync(transaction(f.root, input), 'utf8');
  assert.doesNotMatch(saved, /do-not-retain-this-value/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function planPlusSource() {
  const f = fixture();
  source(f.root, 'tasks/todo.md', '# Start\n');
  source(f.root, 'one.js', 'one\n');
  const input = event(f.root, 'tasks/todo.md', 'fixture-session', {
    tool_input: { command: '*** Update File: tasks/todo.md\n*** Update File: one.js' },
  });
  run('--pre', input, f.env);
  source(f.root, 'tasks/todo.md', validPlan('Together'));
  source(f.root, 'one.js', 'two\n');
  assert.strictEqual(run('--post', input, f.env), '');
  assert.deepStrictEqual(scope(f.root, input), { paths: [], stamped: true, warned: false });
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function concurrentPost() {
  const f = fixture();
  for (const file of ['one.js', 'two.js', 'three.js']) source(f.root, file, 'old\n');
  for (const file of ['one.js', 'two.js']) {
    const input = event(f.root, file);
    run('--pre', input, f.env);
    source(f.root, file, 'new\n');
    assert.strictEqual(run('--post', input, f.env), '');
  }
  const input = event(f.root, 'three.js');
  run('--pre', input, f.env);
  source(f.root, 'three.js', 'new\n');
  const outputs = await Promise.all([runAsync('--post', input, f.env), runAsync('--post', input, f.env)]);
  assert.strictEqual(outputs.filter(Boolean).length, 1);
  warning(outputs.find(Boolean));
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function subagents() {
  const f = fixture();
  for (const file of ['one.js', 'two.js', 'three.js']) source(f.root, file, 'old\n');
  let last = '';
  for (const file of ['one.js', 'two.js', 'three.js']) {
    const input = event(f.root, file, 'shared-session', { agent_id: `agent-${file}` });
    run('--pre', input, f.env);
    source(f.root, file, 'new\n');
    last = run('--post', input, f.env);
  }
  warning(last);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function migration() {
  const f = fixture();
  source(f.root, 'tasks/todo.md', '## Migration State\nkeep\n\n## Plan\n- [ ] old\n');
  const input = event(f.root, 'tasks/todo.md');
  run('--pre', input, f.env);
  source(f.root, 'tasks/todo.md', validPlan('Replacement'));
  assert.match(warning(run('--post', input, f.env)), /Migration State/);
  assert.strictEqual(fs.existsSync(scopeFile(f.root, input)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function deletedMigration() {
  const f = fixture();
  source(f.root, 'tasks/todo.md', '## Migration State\nkeep\n');
  const input = event(f.root, 'tasks/todo.md');
  run('--pre', input, f.env);
  fs.unlinkSync(path.join(f.root, 'tasks', 'todo.md'));
  assert.match(warning(run('--post', input, f.env)), /Migration State/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function symlinkEscape() {
  const f = fixture();
  const outside = path.join(f.root, '..', `plan-gate-outside-${process.pid}.txt`);
  fs.writeFileSync(outside, 'outside-secret-marker\n', 'utf8');
  fs.symlinkSync(outside, path.join(f.root, 'tasks', 'todo.md'));
  const input = event(f.root, 'tasks/todo.md');
  run('--pre', input, f.env);
  assert.strictEqual(fs.existsSync(transaction(f.root, input)), false);
  fs.unlinkSync(outside);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function parentSymlinkSwap() {
  const f = fixture();
  source(f.root, 'tasks/todo.md', '# Start\n');
  const input = event(f.root, 'tasks/todo.md');
  run('--pre', input, f.env);
  const outside = path.join(f.root, '..', `plan-gate-outside-dir-${process.pid}`);
  fs.mkdirSync(outside);
  source(outside, 'todo.md', '## Migration State\noutside\n');
  fs.renameSync(path.join(f.root, 'tasks'), path.join(f.root, 'tasks-real'));
  fs.symlinkSync(outside, path.join(f.root, 'tasks'));
  assert.strictEqual(run('--post', input, f.env), '');
  assert.strictEqual(fs.existsSync(transaction(f.root, input)), false);
  fs.unlinkSync(path.join(f.root, 'tasks'));
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function corruptDuplicateMissing() {
  const f = fixture();
  source(f.root, 'one.js', 'old\n');
  const input = event(f.root, 'one.js');
  run('--pre', input, f.env);
  fs.writeFileSync(transaction(f.root, input), '{bad', 'utf8');
  source(f.root, 'one.js', 'new\n');
  assert.strictEqual(run('--post', input, f.env), '');
  assert.strictEqual(run('--post', input, f.env), '');
  const missing = event(f.root, 'missing.js');
  assert.strictEqual(run('--post', missing, f.env), '');
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function concurrentUnrelatedTodo() {
  const f = fixture();
  source(f.root, 'tasks/todo.md', '# Start\n');
  const one = event(f.root, 'tasks/todo.md', 'shared-session', { tool_use_id: 'todo-one' });
  const two = event(f.root, 'tasks/todo.md', 'shared-session', { tool_use_id: 'todo-two' });
  run('--pre', one, f.env);
  run('--pre', two, f.env);
  source(f.root, 'tasks/todo.md', validPlan('First'));
  assert.strictEqual(run('--post', one, f.env), '');
  source(f.root, 'tasks/todo.md', validPlan('Second'));
  assert.strictEqual(run('--post', two, f.env), '');
  assert.strictEqual(scope(f.root, one).stamped, true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function scopeWarningOnce() {
  const f = fixture();
  for (const file of ['one.js', 'two.js', 'three.js', 'four.js']) source(f.root, file, 'old\n');
  const outputs = [];
  for (const file of ['one.js', 'two.js', 'three.js', 'four.js']) {
    const input = event(f.root, file, 'shared-session');
    run('--pre', input, f.env);
    source(f.root, file, 'new\n');
    outputs.push(run('--post', input, f.env));
  }
  assert.deepStrictEqual(outputs.slice(0, 2), ['', '']);
  assert.match(warning(outputs[2]), /3 distinct source paths/);
  assert.strictEqual(outputs[3], '');
  assert.deepStrictEqual(scope(f.root, event(f.root, 'one.js', 'shared-session')), { paths: ['one.js', 'two.js', 'three.js'], stamped: false, warned: true });
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function expiredScopePrune() {
  const f = fixture();
  const expired = event(f.root, 'old.js', 'expired-session');
  fs.mkdirSync(path.dirname(scopeFile(f.root, expired)), { recursive: true });
  fs.writeFileSync(scopeFile(f.root, expired), JSON.stringify({ paths: ['old.js'], stamped: false, warned: false }), 'utf8');
  const staleTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(scopeFile(f.root, expired), staleTime, staleTime);
  source(f.root, 'new.js', 'old\n');
  const input = event(f.root, 'new.js');
  run('--pre', input, f.env);
  assert.strictEqual(fs.existsSync(scopeFile(f.root, expired)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

const HANDLERS = { fresh, stale, malformed, 'no-op': noOp, 'non-todo-snapshot-redacted': nonTodoSnapshotRedacted, 'plan-plus-source': planPlusSource, 'concurrent-post': concurrentPost, subagents, migration, 'deleted-migration': deletedMigration, 'symlink-escape': symlinkEscape, 'parent-symlink-swap': parentSymlinkSwap, 'corrupt-duplicate-missing': corruptDuplicateMissing, 'concurrent-unrelated-todo': concurrentUnrelatedTodo, 'scope-warning-once': scopeWarningOnce, 'expired-scope-prune': expiredScopePrune };

async function main() {
  const fixtureCases = JSON.parse(fs.readFileSync(CASES, 'utf8')).cases;
  assert.strictEqual(fixtureCases.length, 16, 'expected the complete sixteen-case matrix');
  for (const fixtureCase of fixtureCases) {
    assert.strictEqual(typeof HANDLERS[fixtureCase.id], 'function', `no handler for ${fixtureCase.id}`);
    await HANDLERS[fixtureCase.id]();
    process.stdout.write(`PASS ${fixtureCase.id}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
