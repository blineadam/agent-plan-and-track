#!/usr/bin/env node
/**
 * Live smoke for the Codex plan gate.
 *
 * Default mode is free and prints the exact command shape. --run is billable,
 * guarded by PLANGATE_PILOT_ALLOW_SPEND=1. Every live case is invalid unless
 * its JSONL trace shows completed file-change events, the plan gate records
 * its own SessionStart baseline, and the hook log captures matching
 * PreToolUse/PostToolUse correlation triples. Failed runs preserve their
 * trace, stderr, hook config, event log, and workspace for diagnosis. The
 * mutation case uses only a scratch local Git remote and a stub gh executable,
 * never GitHub.
 */
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CODEX_HOME_SOURCE = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const RUNTIME = path.join(__dirname, '..', 'plan-gate-pilot.js');
const TEMPLATE = path.join(__dirname, '..', 'plan-gate-pilot-hooks.json');
const SCOPE_WARNING = '[PlanGate] This session has changed 3 distinct source paths without a new valid `## Plan` item. The edits still proceed.';
const MUTATION_COMMAND = 'gh pr create --fill';

function fail(message) {
  throw new Error(`INVALID live smoke: ${message}`);
}

function usage() {
  process.stdout.write('Dry run. To spend, run PLANGATE_PILOT_ALLOW_SPEND=1 node hooks/codex/scripts/run-plan-gate-pilot-live-smoke.js --run\n');
}

function readJsonLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function correlationEvidence(eventFile) {
  const events = readJsonLines(eventFile);
  const groups = new Map();
  for (const event of events) {
    if (event.tool_name !== 'apply_patch' || !event.session_id || !event.cwd || !event.tool_use_id) continue;
    const key = JSON.stringify([event.session_id, event.cwd, event.tool_use_id]);
    const current = groups.get(key) || new Set();
    current.add(event.phase);
    groups.set(key, current);
  }
  return [...groups.values()].some((phases) => phases.has('PreToolUse') && phases.has('PostToolUse'));
}

function warningEvidence(eventFile, message) {
  return readJsonLines(eventFile).some((event) => event.phase === 'Warning' && event.message === message);
}

function sessionStartEvidence(eventFile) {
  return readJsonLines(eventFile).some(
    (event) => event.phase === 'SessionStart' && typeof event.session_id === 'string' && typeof event.cwd === 'string',
  );
}

function traceEvidence(trace) {
  const events = readJsonLines(trace);
  const completed = events.filter((event) => event.type === 'item.completed' && event.item);
  const types = [...new Set(completed.map((event) => event.item.type).filter(Boolean))];
  return {
    fileChanges: completed.filter((event) => event.item.type === 'file_change').length,
    types,
  };
}

function rawHookEvidence(rawFile, toolName) {
  if (!fs.existsSync(rawFile)) return false;
  const events = readJsonLines(rawFile).filter((event) => event.tool_name === toolName);
  const groups = new Map();
  for (const event of events) {
    if (!event.session_id || !event.cwd || !event.tool_use_id) continue;
    const key = JSON.stringify([event.session_id, event.cwd, event.tool_use_id]);
    const current = groups.get(key) || new Set();
    current.add(event.hook_event_name);
    groups.set(key, current);
  }
  return [...groups.values()].some((phases) => phases.has('PreToolUse') && phases.has('PostToolUse'));
}

function mutationEvidence(eventFile) {
  const events = readJsonLines(eventFile);
  const allowedPush = events.findIndex((event) => event.phase === 'Allowed' && event.tool_name === 'Bash' && event.command === 'git push origin main');
  const deniedCreate = events.findIndex((event) => event.phase === 'Denied' && event.tool_name === 'Bash' && event.command === MUTATION_COMMAND && /2 distinct outward git\/gh mutations/.test(event.message || ''));
  const stamped = events.findIndex((event) => event.phase === 'Stamped' && event.tool_name === 'apply_patch');
  const allowedCreate = events.findIndex((event, index) => index > stamped && event.phase === 'Allowed' && event.tool_name === 'Bash' && event.command === MUTATION_COMMAND);
  return allowedPush >= 0 && deniedCreate > allowedPush && stamped > deniedCreate && allowedCreate > stamped;
}

function runCase(root, codexHome, name, prompt) {
  const workspace = path.join(root, name);
  const eventFile = path.join(root, `${name}-events.jsonl`);
  const rawFile = path.join(root, `${name}-raw-hooks.jsonl`);
  const trace = path.join(root, `${name}-trace.jsonl`);
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'tasks'), { recursive: true });
  childProcess.execFileSync('git', ['init', '-q'], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, 'tasks', 'todo.md'), '# Smoke\n', 'utf8');
  for (const file of ['one.js', 'two.js', 'three.js', 'planned.js']) fs.writeFileSync(path.join(workspace, 'src', file), 'export default 0;\n', 'utf8');
  const command = ['exec', '--ephemeral', '--ignore-user-config', '--dangerously-bypass-hook-trust', '--sandbox', 'workspace-write', '--json', prompt];
  const result = childProcess.spawnSync('codex', command, {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: codexHome, PLANGATE_PILOT_EVENT_LOG: eventFile, PLANGATE_PILOT_RAW_LOG: rawFile, TMPDIR: root },
  });
  fs.writeFileSync(trace, result.stdout || '', 'utf8');
  fs.writeFileSync(path.join(root, `${name}-stderr.log`), result.stderr || '', 'utf8');
  if (result.status !== 0) fail(`${name} Codex exited ${result.status}: ${result.stderr}`);
  const evidence = traceEvidence(trace);
  if (!evidence.fileChanges) fail(`${name} trace had no completed file_change event; completed item types: ${JSON.stringify(evidence.types)}`);
  if (!fs.existsSync(eventFile)) fail(`${name} captured no hook events; completed trace item types: ${JSON.stringify(evidence.types)}`);
  if (!sessionStartEvidence(eventFile)) fail(`${name} did not capture the plan gate's SessionStart baseline`);
  if (!rawHookEvidence(rawFile, 'apply_patch')) fail(`${name} did not capture raw apply_patch PreToolUse/PostToolUse correlation`);
  if (!correlationEvidence(eventFile)) fail(`${name} did not capture both hook events and a full correlation triple`);
  return { eventFile, trace, workspace };
}

function runMutationCase(root, codexHome) {
  const name = 'mutation-deny-unlock';
  const workspace = path.join(root, name);
  const eventFile = path.join(root, `${name}-events.jsonl`);
  const rawFile = path.join(root, `${name}-raw-hooks.jsonl`);
  const trace = path.join(root, `${name}-trace.jsonl`);
  const stubBin = path.join(workspace, '.stub-bin');
  const stubLog = path.join(workspace, 'gh-stub.log');
  const remote = path.join(workspace, '.remote.git');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'tasks'), { recursive: true });
  fs.mkdirSync(stubBin, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'seed.js'), 'export default 0;\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'tasks', 'todo.md'), '# Smoke\n', 'utf8');
  fs.writeFileSync(path.join(stubBin, 'gh'), '#!/usr/bin/env bash\nprintf \'%s\\n\' \"$*\" >> \"$PLANGATE_GH_STUB_LOG\"\n', { mode: 0o700 });
  childProcess.execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  childProcess.execFileSync('git', ['config', 'user.name', 'Plan Gate Smoke'], { cwd: workspace });
  childProcess.execFileSync('git', ['config', 'user.email', 'plan-gate-smoke@example.invalid'], { cwd: workspace });
  childProcess.execFileSync('git', ['add', '-f', 'src/seed.js', 'tasks/todo.md'], { cwd: workspace });
  childProcess.execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: workspace });
  childProcess.execFileSync('git', ['init', '--bare', '-q', remote], { cwd: workspace });
  childProcess.execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: workspace });

  const prompt = 'Run these actions in order and use each exact command or tool named. First run `git push origin main` as one shell call. Second run `gh pr create --fill` as a separate shell call. The second command will be blocked by a hook; after that denial, use apply_patch to add this exact unchecked item under a new exact ## Plan heading in tasks/todo.md: `- [ ] Create smoke PR; verify: inspect gh-stub.log (executor)`. Then retry the exact separate shell command `gh pr create --fill`. Do not use any other git or gh command. Finish only after the retry succeeds.';
  const command = ['exec', '--ephemeral', '--ignore-user-config', '--dangerously-bypass-hook-trust', '--sandbox', 'workspace-write', '--json', prompt];
  const result = childProcess.spawnSync('codex', command, {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      PATH: `${stubBin}${path.delimiter}${process.env.PATH || ''}`,
      PLANGATE_GH_STUB_LOG: stubLog,
      PLANGATE_MUTATION_THRESHOLD: '2',
      PLANGATE_PILOT_EVENT_LOG: eventFile,
      PLANGATE_PILOT_RAW_LOG: rawFile,
      TMPDIR: root,
    },
  });
  fs.writeFileSync(trace, result.stdout || '', 'utf8');
  fs.writeFileSync(path.join(root, `${name}-stderr.log`), result.stderr || '', 'utf8');
  if (result.status !== 0) fail(`${name} Codex exited ${result.status}: ${result.stderr}`);
  const evidence = traceEvidence(trace);
  if (!evidence.fileChanges) fail(`${name} trace had no completed plan file_change event; completed item types: ${JSON.stringify(evidence.types)}`);
  if (!fs.existsSync(eventFile)) fail(`${name} captured no hook events; completed trace item types: ${JSON.stringify(evidence.types)}`);
  if (!sessionStartEvidence(eventFile)) fail(`${name} did not capture the plan gate's SessionStart baseline`);
  if (!rawHookEvidence(rawFile, 'apply_patch')) fail(`${name} did not capture raw apply_patch PreToolUse/PostToolUse correlation`);
  if (!mutationEvidence(eventFile)) fail(`${name} did not capture ordered allow, deny, stamp, and retry-allow hook evidence`);
  if (!fs.existsSync(stubLog)) fail(`${name} never reached the gh stub after the stamp`);
  const stubCalls = fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean);
  if (stubCalls.length !== 1 || stubCalls[0] !== 'pr create --fill') fail(`${name} gh stub calls were ${JSON.stringify(stubCalls)}, expected one post-stamp retry`);
  try {
    childProcess.execFileSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/main'], { cwd: remote });
  } catch {
    fail(`${name} first git push did not reach the scratch local remote`);
  }
}

function setup(root) {
  const codexHome = path.join(root, 'codex-home');
  const scripts = path.join(codexHome, 'scripts');
  const sentinel = path.join(scripts, 'session-start-sentinel.js');
  const auth = path.join(CODEX_HOME_SOURCE, 'auth.json');
  if (!fs.existsSync(auth)) fail(`no auth.json at ${auth}`);
  fs.mkdirSync(scripts, { recursive: true, mode: 0o700 });
  fs.symlinkSync(auth, path.join(codexHome, 'auth.json'));
  fs.copyFileSync(RUNTIME, path.join(scripts, 'plan-gate.js'));
  fs.writeFileSync(
    sentinel,
    "'use strict';\nconst fs = require('fs');\nconst path = require('path');\nconst input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');\nconst file = input.hook_event_name === 'SessionStart' ? process.env.PLANGATE_PILOT_EVENT_LOG : process.env.PLANGATE_PILOT_RAW_LOG;\nif (file) {\n  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });\n  fs.appendFileSync(file, JSON.stringify(input.hook_event_name === 'SessionStart' ? { phase: 'SessionStartSentinel' } : input) + '\\n', { mode: 0o600 });\n}\n",
    { mode: 0o700 }
  );
  const hooks = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8').replaceAll('__SCRIPTS__', scripts.replace(/\\/g, '/')));
  for (const event of ['PreToolUse', 'PostToolUse']) {
    for (const entry of hooks.hooks[event]) {
      entry.hooks.push({ type: 'command', command: `node "${sentinel.replace(/\\/g, '/')}"`, timeout: 10 });
    }
  }
  hooks.hooks.SessionStart.push(
    {
      matcher: 'startup',
      hooks: [{ type: 'command', command: `node "${sentinel.replace(/\\/g, '/')}"`, timeout: 10 }],
    },
  );
  fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify(hooks, null, 2) + '\n', { mode: 0o600 });
  return codexHome;
}

function main() {
  try {
    if (process.argv.length === 2) return usage();
    if (process.argv.length !== 3 || process.argv[2] !== '--run') fail('expected --run');
    if (process.env.PLANGATE_PILOT_ALLOW_SPEND !== '1') fail('set PLANGATE_PILOT_ALLOW_SPEND=1 before --run');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-gate-pilot-live-'));
    let passed = false;
    try {
      const codexHome = setup(root);
      const source = runCase(
        root,
        codexHome,
        'three-source-edits',
        'Use apply_patch exactly three times, once each, to change src/one.js, src/two.js, and src/three.js from 0 to 1. Do not edit tasks/todo.md. After each patch, continue normally and finish.'
      );
      if (!warningEvidence(source.eventFile, SCOPE_WARNING)) fail('three-source-edits did not record the exact nonblocking PlanGate warning');
      const planned = runCase(
        root,
        codexHome,
        'plan-plus-source',
        'Use one apply_patch call to add this exact unchecked item under a new exact ## Plan heading in tasks/todo.md: - [ ] Update planned source; verify: inspect src/planned.js (executor). In that same apply_patch call, change src/planned.js from 0 to 1. Finish after that.'
      );
      if (warningEvidence(planned.eventFile, SCOPE_WARNING)) fail('plan-plus-source unexpectedly recorded a PlanGate warning');
      runMutationCase(root, codexHome);
      passed = true;
      process.stdout.write('PASS live smoke\n');
    } catch (err) {
      err.message = `${err.message || err}\nArtifacts preserved at ${root}`;
      throw err;
    } finally {
      if (passed) fs.rmSync(root, { recursive: true, force: true });
    }
  } catch (err) {
    process.stderr.write(`${err.message || err}\n`);
    process.exitCode = 1;
  }
}

main();
