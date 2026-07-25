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
  const env = { ...process.env, TEMP: root, TMP: root, TMPDIR: root };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PLANGATE_')) delete env[key];
  }
  return { env, root };
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

function bashEvent(root, command, session, toolUseId) {
  return {
    cwd: root,
    session_id: session || 'fixture-session',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: toolUseId || `bash-${String(command).replace(/[^a-z0-9]/gi, '-').slice(0, 40)}`,
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

function denial(stdout) {
  assert.notStrictEqual(stdout, '');
  const parsed = JSON.parse(stdout);
  assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.deepStrictEqual(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.deepStrictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /^\[PlanGate\] /);
  return parsed.hookSpecificOutput.permissionDecisionReason;
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

function replacementPatch(file, baseline, result) {
  const removed = baseline.replace(/\n$/, '').split('\n').map((line) => `-${line}`).join('\n');
  const added = result.replace(/\n$/, '').split('\n').map((line) => `+${line}`).join('\n');
  return `*** Begin Patch\n*** Update File: ${file}\n@@\n${removed}\n${added}\n*** End Patch`;
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

async function newTodoPlan() {
  const f = fixture();
  const input = event(f.root, 'tasks/todo.md');
  run('--pre', input, f.env);
  source(f.root, 'tasks/todo.md', validPlan('New'));
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
  assert.deepStrictEqual(scope(f.root, input), { mutations: [], paths: [], stamped: true, warned: false });
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
  const result = 'outside-secret-marker\n\n## Plan\n- [ ] Implement guard; verify: node check.js (main: user asked for direct implementation)\n';
  const input = event(f.root, 'tasks/todo.md', 'symlink-escape', {
    tool_input: { command: replacementPatch('tasks/todo.md', 'outside-secret-marker\n', result) },
  });
  assert.strictEqual(run('--pre', input, f.env), '');
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
  assert.deepStrictEqual(scope(f.root, event(f.root, 'one.js', 'shared-session')), { mutations: [], paths: ['one.js', 'two.js', 'three.js'], stamped: false, warned: true });
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function expiredScopePrune() {
  const f = fixture();
  const expired = event(f.root, 'old.js', 'expired-session');
  fs.mkdirSync(path.dirname(scopeFile(f.root, expired)), { recursive: true });
  fs.writeFileSync(scopeFile(f.root, expired), JSON.stringify({ paths: ['old.js'], stamped: false, warned: false }), 'utf8');
  const staleTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(scopeFile(f.root, expired), staleTime, staleTime);
  fs.writeFileSync(scopeFile(f.root, expired) + '.lock', '', 'utf8');
  fs.utimesSync(scopeFile(f.root, expired) + '.lock', staleTime, staleTime);
  source(f.root, 'new.js', 'old\n');
  const input = event(f.root, 'new.js');
  run('--pre', input, f.env);
  assert.strictEqual(fs.existsSync(scopeFile(f.root, expired)), false);
  assert.strictEqual(fs.existsSync(scopeFile(f.root, expired) + '.lock'), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function mutationClassifier() {
  const f = fixture();
  const silent = [
    'npm test',
    'git push --help',
    'git push --dry-run',
    'gh pr view 123',
    'git commit -m "then git push"',
    'echo done # then git push origin main',
  ];
  for (let i = 0; i < silent.length; i += 1) {
    const input = bashEvent(f.root, silent[i], `silent-${i}`);
    assert.strictEqual(run('--pre', input, f.env), '');
    assert.strictEqual(fs.existsSync(scopeFile(f.root, input)), false);
  }

  const heredoc = bashEvent(f.root, 'gh pr create --body-file - <<\'END-PR\'\nremember to git push\nEND-PR', 'heredoc');
  assert.strictEqual(run('--pre', heredoc, f.env), '');
  assert.deepStrictEqual(scope(f.root, heredoc).mutations, ['gh-pr-create']);

  const gitGlobal = bashEvent(f.root, 'git -C /tmp/x push', 'git-global');
  assert.strictEqual(run('--pre', gitGlobal, f.env), '');
  assert.deepStrictEqual(scope(f.root, gitGlobal).mutations, ['git-push']);

  const ghGlobal = bashEvent(f.root, 'gh -R o/r pr merge', 'gh-global');
  assert.strictEqual(run('--pre', ghGlobal, f.env), '');
  assert.deepStrictEqual(scope(f.root, ghGlobal).mutations, ['gh-pr-merge']);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function mutationDistinctDenialRetry() {
  const f = fixture();
  const session = 'mutation-denial';
  const first = bashEvent(f.root, 'git push origin main', session, 'push-first');
  assert.strictEqual(run('--pre', first, f.env), '');
  assert.deepStrictEqual(scope(f.root, first).mutations, ['git-push']);
  const second = bashEvent(f.root, 'gh pr create --fill', session, 'create-second');
  assert.match(denial(run('--pre', second, f.env)), /2 distinct outward git\/gh mutations/);
  assert.deepStrictEqual(scope(f.root, first).mutations, ['git-push']);
  assert.match(denial(run('--pre', second, f.env)), /2 distinct outward git\/gh mutations/);
  assert.deepStrictEqual(scope(f.root, first).mutations, ['git-push']);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function mutationSingleCallUnion() {
  const f = fixture();
  const input = bashEvent(f.root, 'git push && gh pr create && gh pr merge', 'mutation-union');
  assert.match(denial(run('--pre', input, f.env)), /3 distinct outward git\/gh mutations.*configured limit of 2/);
  assert.strictEqual(fs.existsSync(scopeFile(f.root, input)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function mutationOldScopeCompatibility() {
  const f = fixture();
  const input = bashEvent(f.root, 'git push origin main', 'old-scope');
  fs.mkdirSync(path.dirname(scopeFile(f.root, input)), { recursive: true });
  fs.writeFileSync(scopeFile(f.root, input), JSON.stringify({ paths: ['one.js'], stamped: false, warned: false }), 'utf8');
  assert.strictEqual(run('--pre', input, f.env), '');
  assert.deepStrictEqual(scope(f.root, input), { mutations: ['git-push'], paths: ['one.js'], stamped: false, warned: false });
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function mutationConcurrent() {
  const f = fixture();
  const session = 'mutation-concurrent';
  const outputs = await Promise.all([
    runAsync('--pre', bashEvent(f.root, 'git push origin main', session, 'concurrent-push'), f.env),
    runAsync('--pre', bashEvent(f.root, 'gh pr create --fill', session, 'concurrent-create'), f.env),
  ]);
  assert.strictEqual(outputs.filter(Boolean).length, 1);
  denial(outputs.find(Boolean));
  const saved = scope(f.root, bashEvent(f.root, 'git status', session));
  assert.strictEqual(saved.mutations.length, 1);
  assert.strictEqual(['git-push', 'gh-pr-create'].includes(saved.mutations[0]), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function mutationPlanUnlock() {
  const f = fixture();
  const session = 'mutation-plan-unlock';
  source(f.root, 'tasks/todo.md', '# Start\n');
  const first = bashEvent(f.root, 'git push origin main', session, 'unlock-push');
  assert.strictEqual(run('--pre', first, f.env), '');
  const plan = event(f.root, 'tasks/todo.md', session, { tool_use_id: 'unlock-plan' });
  run('--pre', plan, f.env);
  source(f.root, 'tasks/todo.md', validPlan('Unlock'));
  assert.strictEqual(run('--post', plan, f.env), '');
  assert.strictEqual(scope(f.root, first).stamped, true);
  assert.strictEqual(run('--pre', bashEvent(f.root, 'gh pr create --fill', session, 'unlock-create'), f.env), '');
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function mutationThresholdValidation() {
  const f = fixture();
  const invalidEnv = { ...f.env, PLANGATE_MUTATION_THRESHOLD: 'invalid' };
  const first = bashEvent(f.root, 'git push origin main', 'invalid-threshold', 'invalid-first');
  assert.strictEqual(run('--pre', first, invalidEnv), '');
  assert.match(denial(run('--pre', bashEvent(f.root, 'gh pr merge 1', 'invalid-threshold', 'invalid-second'), invalidEnv)), /2 distinct outward git\/gh mutations/);

  const disabledEnv = { ...f.env, PLANGATE_MUTATION_THRESHOLD: '4' };
  for (const [id, command] of [['push', 'git push'], ['create', 'gh pr create'], ['merge', 'gh pr merge']]) {
    assert.strictEqual(run('--pre', bashEvent(f.root, command, 'threshold-four', id), disabledEnv), '');
  }
  assert.deepStrictEqual(scope(f.root, bashEvent(f.root, 'git status', 'threshold-four')).mutations, ['git-push', 'gh-pr-create', 'gh-pr-merge']);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function attributionDenialBeforeMutation() {
  const f = fixture();
  const baseline = '# Start\n';
  const result = '# Start\n\n## Plan\n- [ ] Implement guard; verify: node check.js (main: user asked for direct implementation)\n';
  source(f.root, 'tasks/todo.md', baseline);
  const input = event(f.root, 'tasks/todo.md', 'attribution-denial', {
    tool_input: { command: replacementPatch('tasks/todo.md', baseline, result) },
  });
  const message = denial(run('--pre', input, f.env));
  assert.match(message, /claim about what the user did or asked/);
  assert.match(message, /offending reason: \(main: user asked for direct implementation\)/);
  assert.strictEqual(fs.readFileSync(path.join(f.root, 'tasks', 'todo.md'), 'utf8'), baseline);
  assert.strictEqual(fs.existsSync(transaction(f.root, input)), false);
  assert.strictEqual(typeof scope(f.root, input).mainAttributionAt, 'number');
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function attributionEnvironmentId() {
  const f = fixture();
  const baseline = '# Start\n';
  const result = '# Start\n\n## Plan\n- [ ] Implement guard; verify: node check.js (main: user asked for direct implementation)\n';
  source(f.root, 'tasks/todo.md', baseline);
  const command = replacementPatch('tasks/todo.md', baseline, result).replace(
    '*** Begin Patch\n',
    '*** Begin Patch\n*** Environment ID: remote-123\n',
  );
  const input = event(f.root, 'tasks/todo.md', 'attribution-environment-id', {
    tool_input: { command },
  });
  assert.match(denial(run('--pre', input, f.env)), /claim about what the user did or asked/);
  assert.strictEqual(fs.existsSync(transaction(f.root, input)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function attributionAgedRetry() {
  const f = fixture();
  const baseline = '# Start\n';
  const result = '# Start\n\n## Plan\n- [ ] Implement guard; verify: node check.js (main: user confirmed the approach)\n';
  source(f.root, 'tasks/todo.md', baseline);
  const first = event(f.root, 'tasks/todo.md', 'attribution-retry', {
    tool_input: { command: replacementPatch('tasks/todo.md', baseline, result) },
    tool_use_id: 'attribution-retry-first',
  });
  denial(run('--pre', first, f.env));
  const state = scope(f.root, first);
  state.mainAttributionAt = Date.now() - 3000;
  fs.writeFileSync(scopeFile(f.root, first), JSON.stringify(state), 'utf8');
  const retry = event(f.root, 'tasks/todo.md', 'attribution-retry', {
    tool_input: { command: replacementPatch('tasks/todo.md', baseline, result) },
    tool_use_id: 'attribution-retry-aged',
  });
  assert.strictEqual(run('--pre', retry, f.env), '');
  assert.strictEqual(fs.existsSync(transaction(f.root, retry)), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function attributionConcurrentFirstCalls() {
  const f = fixture();
  const baseline = '# Start\n';
  const result = '# Start\n\n## Plan\n- [ ] Implement guard; verify: node check.js (main: user confirmed the approach)\n';
  source(f.root, 'tasks/todo.md', baseline);
  const command = replacementPatch('tasks/todo.md', baseline, result);
  const one = event(f.root, 'tasks/todo.md', 'attribution-concurrent', {
    tool_input: { command },
    tool_use_id: 'attribution-concurrent-one',
  });
  const two = event(f.root, 'tasks/todo.md', 'attribution-concurrent', {
    tool_input: { command },
    tool_use_id: 'attribution-concurrent-two',
  });
  const outputs = await Promise.all([runAsync('--pre', one, f.env), runAsync('--pre', two, f.env)]);
  assert.strictEqual(outputs.filter(Boolean).length, 2);
  for (const output of outputs) assert.match(denial(output), /claim about what the user did or asked/);
  assert.strictEqual(fs.existsSync(transaction(f.root, one)), false);
  assert.strictEqual(fs.existsSync(transaction(f.root, two)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function attributionLegitimateMainReason() {
  const f = fixture();
  const baseline = '# Start\n';
  const result = '# Start\n\n## Plan\n- [ ] Review the diff; verify: node check.js (main: cross-file synthesis needs current context)\n';
  source(f.root, 'tasks/todo.md', baseline);
  const input = event(f.root, 'tasks/todo.md', 'attribution-legitimate', {
    tool_input: { command: replacementPatch('tasks/todo.md', baseline, result) },
  });
  assert.strictEqual(run('--pre', input, f.env), '');
  assert.strictEqual(fs.existsSync(transaction(f.root, input)), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function attributionNonMainTag() {
  const f = fixture();
  const baseline = '# Start\n';
  const result = '# Start\n\n## Plan\n- [ ] Implement guard; verify: node check.js (executor: user asked for direct implementation)\n';
  source(f.root, 'tasks/todo.md', baseline);
  const input = event(f.root, 'tasks/todo.md', 'attribution-non-main', {
    tool_input: { command: replacementPatch('tasks/todo.md', baseline, result) },
  });
  assert.strictEqual(run('--pre', input, f.env), '');
  assert.strictEqual(fs.existsSync(transaction(f.root, input)), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function attributionLintDisabled() {
  const f = fixture();
  const baseline = '# Start\n';
  const result = '# Start\n\n## Plan\n- [ ] Implement guard; verify: node check.js (main: user disabled delegation)\n';
  source(f.root, 'tasks/todo.md', baseline);
  const input = event(f.root, 'tasks/todo.md', 'attribution-disabled', {
    tool_input: { command: replacementPatch('tasks/todo.md', baseline, result) },
  });
  assert.strictEqual(run('--pre', input, { ...f.env, PLANGATE_LINT_DISABLED: '1' }), '');
  assert.strictEqual(fs.existsSync(transaction(f.root, input)), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function attributionContinuationLine() {
  const f = fixture();
  const baseline = '## Plan\n- [ ] Implement guard; verify: node check.js\n  (main: current context spans the hook and fixtures)\n';
  const result = '## Plan\n- [ ] Implement guard; verify: node check.js\n  (main: the user explicitly asked for direct implementation)\n';
  source(f.root, 'tasks/todo.md', baseline);
  const input = event(f.root, 'tasks/todo.md', 'attribution-continuation', {
    tool_input: { command: replacementPatch('tasks/todo.md', baseline, result) },
  });
  assert.match(denial(run('--pre', input, f.env)), /the user explicitly asked/);
  assert.strictEqual(fs.existsSync(transaction(f.root, input)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function attributionAmbiguousContextFailOpen() {
  const f = fixture();
  const baseline = 'repeat\nrepeat\n';
  source(f.root, 'tasks/todo.md', baseline);
  const command = '*** Begin Patch\n*** Update File: tasks/todo.md\n@@\n-repeat\n+repeat\n+\n+## Plan\n+- [ ] Implement guard; verify: node check.js (main: user asked for direct implementation)\n*** End Patch';
  const input = event(f.root, 'tasks/todo.md', 'attribution-ambiguous', { tool_input: { command } });
  assert.strictEqual(run('--pre', input, f.env), '');
  assert.strictEqual(fs.existsSync(transaction(f.root, input)), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function attributionFuzzyContextFailOpen() {
  const f = fixture();
  const baseline = '# Start\n';
  source(f.root, 'tasks/todo.md', baseline);
  const command = '*** Begin Patch\n*** Update File: tasks/todo.md\n@@\n-#  Start\n+# Start\n+\n+## Plan\n+- [ ] Implement guard; verify: node check.js (main: user asked for direct implementation)\n*** End Patch';
  const input = event(f.root, 'tasks/todo.md', 'attribution-fuzzy', { tool_input: { command } });
  assert.strictEqual(run('--pre', input, f.env), '');
  assert.strictEqual(fs.existsSync(transaction(f.root, input)), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function attributionUnsupportedSyntaxFailOpen() {
  const f = fixture();
  const result = '## Plan\n- [ ] Implement guard; verify: node check.js (main: user asked for direct implementation)\n';
  const command = `*** Begin Patch\n*** Add File: tasks/todo.md\n${result.replace(/\n$/, '').split('\n').map((line) => `+${line}`).join('\n')}\n*** End Patch`;
  const input = event(f.root, 'tasks/todo.md', 'attribution-unsupported', { tool_input: { command } });
  assert.strictEqual(run('--pre', input, f.env), '');
  assert.strictEqual(fs.existsSync(transaction(f.root, input)), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function attributionMultiFileFailOpen() {
  const f = fixture();
  const baseline = '# Start\n';
  source(f.root, 'tasks/todo.md', baseline);
  source(f.root, 'one.js', 'old\n');
  const command = '*** Begin Patch\n*** Update File: tasks/todo.md\n@@\n-# Start\n+# Start\n+\n+## Plan\n+- [ ] Implement guard; verify: node check.js (main: user asked for direct implementation)\n*** Update File: one.js\n@@\n-old\n+new\n*** End Patch';
  const input = event(f.root, 'tasks/todo.md', 'attribution-multi-file', { tool_input: { command } });
  assert.strictEqual(run('--pre', input, f.env), '');
  assert.strictEqual(fs.existsSync(transaction(f.root, input)), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function attributionUnreadableStateFailOpen() {
  const f = fixture();
  const baseline = '# Start\n';
  const result = '# Start\n\n## Plan\n- [ ] Implement guard; verify: node check.js (main: user asked for direct implementation)\n';
  source(f.root, 'tasks/todo.md', baseline);
  const input = event(f.root, 'tasks/todo.md', 'attribution-unreadable-state', {
    tool_input: { command: replacementPatch('tasks/todo.md', baseline, result) },
  });
  fs.mkdirSync(path.dirname(scopeFile(f.root, input)), { recursive: true });
  fs.writeFileSync(scopeFile(f.root, input), '{bad', 'utf8');
  assert.strictEqual(run('--pre', input, f.env), '');
  assert.strictEqual(fs.existsSync(transaction(f.root, input)), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

const HANDLERS = { fresh, 'new-todo-plan': newTodoPlan, stale, malformed, 'no-op': noOp, 'non-todo-snapshot-redacted': nonTodoSnapshotRedacted, 'plan-plus-source': planPlusSource, 'concurrent-post': concurrentPost, subagents, migration, 'deleted-migration': deletedMigration, 'symlink-escape': symlinkEscape, 'parent-symlink-swap': parentSymlinkSwap, 'corrupt-duplicate-missing': corruptDuplicateMissing, 'concurrent-unrelated-todo': concurrentUnrelatedTodo, 'scope-warning-once': scopeWarningOnce, 'expired-scope-prune': expiredScopePrune, 'mutation-classifier': mutationClassifier, 'mutation-distinct-denial-retry': mutationDistinctDenialRetry, 'mutation-single-call-union': mutationSingleCallUnion, 'mutation-old-scope-compatibility': mutationOldScopeCompatibility, 'mutation-concurrent': mutationConcurrent, 'mutation-plan-unlock': mutationPlanUnlock, 'mutation-threshold-validation': mutationThresholdValidation, 'attribution-denial-before-mutation': attributionDenialBeforeMutation, 'attribution-environment-id': attributionEnvironmentId, 'attribution-aged-retry': attributionAgedRetry, 'attribution-concurrent-first-calls': attributionConcurrentFirstCalls, 'attribution-legitimate-main-reason': attributionLegitimateMainReason, 'attribution-non-main-tag': attributionNonMainTag, 'attribution-lint-disabled': attributionLintDisabled, 'attribution-continuation-line': attributionContinuationLine, 'attribution-ambiguous-context-fail-open': attributionAmbiguousContextFailOpen, 'attribution-fuzzy-context-fail-open': attributionFuzzyContextFailOpen, 'attribution-unsupported-syntax-fail-open': attributionUnsupportedSyntaxFailOpen, 'attribution-multi-file-fail-open': attributionMultiFileFailOpen, 'attribution-unreadable-state-fail-open': attributionUnreadableStateFailOpen };

async function main() {
  const fixtureCases = JSON.parse(fs.readFileSync(CASES, 'utf8')).cases;
  assert.strictEqual(fixtureCases.length, 37, 'expected the complete thirty-seven-case matrix');
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
