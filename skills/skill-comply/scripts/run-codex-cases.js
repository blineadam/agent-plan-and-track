#!/usr/bin/env node
/**
 * run-codex-cases.js: capture fresh Codex exec JSONL traces for skill-comply.
 *
 * Usage:
 *   run-codex-cases.js --dry-run [CASES_JSON]
 *   run-codex-cases.js --run RESULTS_DIR [CASES_JSON]
 *   run-codex-cases.js --check RESULTS_DIR [CASES_JSON]
 *
 * --run is billable and refuses to start unless COMPLY_ALLOW_SPEND=1. It runs
 * each case in a disposable workspace with `codex exec --ephemeral --json`,
 * normal sandboxing, and user config ignored. Run it from an isolated HOME and
 * CODEX_HOME whose auth.json points at valid credentials; the script never
 * copies credentials or relaxes the sandbox.
 *
 * The adapter deliberately does not score compliance. skill-comply remains an
 * LLM-judged measurement: this script only validates liveness and normalizes
 * observable command, file, plan-artifact, and terminal events. It never treats
 * hidden reasoning, assistant prose, or a skill-activation event as evidence.
 */
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL_DIR = path.resolve(__dirname, '..');
const DEFAULT_CASES = path.join(SKILL_DIR, 'fixtures', 'codex-cases.json');
const MAX_OUTPUT_CHARS = 16000;
const MAX_PLAN_CHARS = 64000;

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    fail(`cannot read ${filePath}: ${err && err.message}`);
  }
}

function safeId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function loadCases(casesPath) {
  const corpus = readJson(casesPath);
  if (!corpus || !Array.isArray(corpus.scenarios) || corpus.scenarios.length === 0) {
    fail('cases file needs a non-empty scenarios array');
  }
  const seen = new Set();
  for (const scenario of corpus.scenarios) {
    if (!scenario || !safeId(scenario.id)) fail('every scenario needs a safe id');
    if (seen.has(scenario.id)) fail(`duplicate scenario id: ${scenario.id}`);
    seen.add(scenario.id);
    if (!['supportive', 'neutral', 'competing'].includes(scenario.strictness)) {
      fail(`${scenario.id}: invalid strictness`);
    }
    if (typeof scenario.prompt !== 'string' || !scenario.prompt.trim()) {
      fail(`${scenario.id}: prompt is required`);
    }
    if (typeof scenario.fixture !== 'string' || !scenario.fixture.trim()) {
      fail(`${scenario.id}: fixture is required`);
    }
    const fixture = path.resolve(path.dirname(casesPath), scenario.fixture);
    if (!inside(path.dirname(casesPath), fixture) || !fs.statSync(fixture).isDirectory()) {
      fail(`${scenario.id}: fixture escapes the cases directory or is not a directory`);
    }
  }
  return corpus;
}

function parseTrace(tracePath) {
  const events = [];
  for (const line of fs.readFileSync(tracePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      fail(`${tracePath}: non-JSON trace line`);
    }
  }
  return events;
}

function bounded(value, max) {
  const text = typeof value === 'string' ? value : '';
  return text.length <= max ? text : text.slice(0, max) + '\n[truncated]';
}

function summarize(id, strictness, exitCode, events, workspace) {
  const terminal = events.filter((event) => event && /^turn\.(completed|failed)$/.test(event.type));
  const completed = terminal.length === 1 && terminal[0].type === 'turn.completed';
  const failed = events.some((event) => event && event.type === 'turn.failed');
  const observable = [];
  for (const event of events) {
    if (!event || event.type !== 'item.completed' || !event.item) continue;
    const item = event.item;
    if (item.type === 'command_execution') {
      observable.push({
        kind: 'command',
        command: String(item.command || ''),
        exit_code: item.exit_code,
        output: bounded(item.aggregated_output, MAX_OUTPUT_CHARS),
      });
    } else if (item.type === 'file_change') {
      observable.push({
        kind: 'file',
        changes: Array.isArray(item.changes)
          ? item.changes.map((change) => ({
              path: String((change && change.path) || ''),
              change_kind: String((change && change.kind) || ''),
            }))
          : [],
      });
    } else if (item.type === 'todo_list') {
      observable.push({ kind: 'plan', items: item.items || [] });
    }
  }
  const todoPath = path.join(workspace, 'tasks', 'todo.md');
  let planArtifact = null;
  try {
    planArtifact = bounded(fs.readFileSync(todoPath, 'utf8'), MAX_PLAN_CHARS);
  } catch {
    planArtifact = null;
  }
  observable.push({
    kind: 'terminal',
    event: terminal.length === 1 ? terminal[0].type : null,
    usage: completed ? terminal[0].usage || {} : {},
  });
  return {
    scenario: id,
    strictness,
    live: exitCode === 0 && completed && !failed,
    exit_code: exitCode,
    observable_events: observable,
    plan_artifact: planArtifact,
  };
}

function checkScenario(resultsDir, scenario) {
  const caseDir = path.join(resultsDir, scenario.id);
  const tracePath = path.join(caseDir, 'trace.jsonl');
  const metaPath = path.join(caseDir, 'meta.json');
  if (!fs.existsSync(tracePath) || !fs.existsSync(metaPath)) {
    fail(`${scenario.id}: missing trace.jsonl or meta.json`);
  }
  const meta = readJson(metaPath);
  const workspace = path.join(caseDir, 'workspace');
  const summary = summarize(
    scenario.id,
    scenario.strictness,
    Number(meta.exit_code),
    parseTrace(tracePath),
    workspace
  );
  fs.writeFileSync(path.join(caseDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

function runScenario(resultsDir, casesPath, scenario) {
  const fixture = path.resolve(path.dirname(casesPath), scenario.fixture);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `skill-comply-${scenario.id}-`));
  const workspace = path.join(scratch, 'workspace');
  const caseDir = path.join(resultsDir, scenario.id);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.cpSync(fixture, workspace, { recursive: true });
  childProcess.spawnSync('git', ['init', '-q'], { cwd: workspace, stdio: 'inherit' });
  const run = childProcess.spawnSync(
    'codex',
    [
      'exec',
      '--ephemeral',
      '--json',
      '--ignore-user-config',
      '--sandbox',
      'workspace-write',
      '-C',
      workspace,
      scenario.prompt,
    ],
    { cwd: workspace, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  fs.writeFileSync(path.join(caseDir, 'trace.jsonl'), run.stdout || '');
  fs.writeFileSync(path.join(caseDir, 'trace.err'), run.stderr || '');
  fs.writeFileSync(
    path.join(caseDir, 'meta.json'),
    JSON.stringify({ exit_code: run.status === null ? 1 : run.status }, null, 2) + '\n'
  );
  const capturedWorkspace = path.join(caseDir, 'workspace');
  fs.rmSync(capturedWorkspace, { recursive: true, force: true });
  fs.cpSync(workspace, capturedWorkspace, {
    recursive: true,
    filter: (source) => path.basename(source) !== '.git',
  });
  fs.rmSync(scratch, { recursive: true, force: true });
}

function main() {
  const mode = process.argv[2] || '--dry-run';
  if (!['--dry-run', '--run', '--check'].includes(mode)) fail('expected --dry-run, --run, or --check');
  let resultsDir = null;
  let casesPath = DEFAULT_CASES;
  if (mode === '--run' || mode === '--check') {
    if (!process.argv[3]) fail(`${mode} requires RESULTS_DIR`);
    resultsDir = path.resolve(process.argv[3]);
    if (process.argv[4]) casesPath = path.resolve(process.argv[4]);
  } else if (process.argv[3]) {
    casesPath = path.resolve(process.argv[3]);
  }
  const corpus = loadCases(casesPath);
  if (mode === '--dry-run') {
    process.stdout.write(JSON.stringify(corpus, null, 2) + '\n');
    return;
  }
  fs.mkdirSync(resultsDir, { recursive: true });
  if (mode === '--run') {
    if (process.env.COMPLY_ALLOW_SPEND !== '1') {
      fail('--run is billable; set COMPLY_ALLOW_SPEND=1 after isolating HOME, CODEX_HOME, and the workspace');
    }
    for (const scenario of corpus.scenarios) runScenario(resultsDir, casesPath, scenario);
  }
  const summaries = corpus.scenarios.map((scenario) => checkScenario(resultsDir, scenario));
  process.stdout.write(JSON.stringify({ target: corpus.target, spec: corpus.spec, cases: summaries }, null, 2) + '\n');
  if (summaries.some((summary) => !summary.live)) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  process.stderr.write(`error: ${err && err.message}\n`);
  process.exit(1);
}
