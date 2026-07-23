#!/usr/bin/env node
/**
 * Live smoke for the Codex plan gate.
 *
 * Default mode is free and prints the exact command shape. --run is billable,
 * guarded by PLANGATE_PILOT_ALLOW_SPEND=1. Every live case is invalid unless
 * its JSONL trace shows apply_patch and the hook log captures matching
 * PreToolUse/PostToolUse correlation triples.
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

function runCase(root, codexHome, name, prompt) {
  const workspace = path.join(root, name);
  const eventFile = path.join(root, `${name}-events.jsonl`);
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
    env: { ...process.env, CODEX_HOME: codexHome, PLANGATE_PILOT_EVENT_LOG: eventFile, TMPDIR: root },
  });
  fs.writeFileSync(trace, result.stdout || '', 'utf8');
  if (result.status !== 0) fail(`${name} Codex exited ${result.status}: ${result.stderr}`);
  if (!fs.existsSync(eventFile)) fail(`${name} captured no hook events`);
  if (!correlationEvidence(eventFile)) fail(`${name} did not capture both hook events and a full correlation triple`);
  if (!fs.readFileSync(trace, 'utf8').includes('apply_patch')) fail(`${name} trace did not show an apply_patch tool event`);
  return { eventFile, trace, workspace };
}

function setup(root) {
  const codexHome = path.join(root, 'codex-home');
  const scripts = path.join(codexHome, 'scripts');
  const auth = path.join(CODEX_HOME_SOURCE, 'auth.json');
  if (!fs.existsSync(auth)) fail(`no auth.json at ${auth}`);
  fs.mkdirSync(scripts, { recursive: true, mode: 0o700 });
  fs.symlinkSync(auth, path.join(codexHome, 'auth.json'));
  fs.copyFileSync(RUNTIME, path.join(scripts, 'plan-gate.js'));
  const hooks = fs.readFileSync(TEMPLATE, 'utf8').replaceAll('__SCRIPTS__', scripts.replace(/\\/g, '/'));
  fs.writeFileSync(path.join(codexHome, 'hooks.json'), hooks, { mode: 0o600 });
  return codexHome;
}

function main() {
  try {
    if (process.argv.length === 2) return usage();
    if (process.argv.length !== 3 || process.argv[2] !== '--run') fail('expected --run');
    if (process.env.PLANGATE_PILOT_ALLOW_SPEND !== '1') fail('set PLANGATE_PILOT_ALLOW_SPEND=1 before --run');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-gate-pilot-live-'));
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
      process.stdout.write('PASS live smoke\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } catch (err) {
    process.stderr.write(`${err.message || err}\n`);
    process.exitCode = 1;
  }
}

main();
