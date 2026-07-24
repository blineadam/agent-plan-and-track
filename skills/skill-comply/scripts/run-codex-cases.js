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
 * LIVE_CASE_TIMEOUT_MS sets the per-case live timeout in milliseconds
 * (default 900000).
 * LIVE_CODEX_TEST_SCRIPT may name an absolute fake-CLI script for free fixtures.
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
const FORCE_SETTLE_MS = 100;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 16000;
const MAX_PLAN_CHARS = 64000;
const MAX_TIMER_MS = 2_147_483_647;
const TERMINATE_GRACE_MS = 1000;

let activeRun = null;
let parentInterrupted = false;
let parentSignalCount = 0;

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function liveCaseTimeout() {
  const raw = process.env.LIVE_CASE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 900000;
  if (!/^[0-9]+$/.test(raw)) {
    fail(`LIVE_CASE_TIMEOUT_MS must be an integer from 1 to ${MAX_TIMER_MS}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    fail(`LIVE_CASE_TIMEOUT_MS must be an integer from 1 to ${MAX_TIMER_MS}`);
  }
  return value;
}

function codexInvocation() {
  const script = process.env.LIVE_CODEX_TEST_SCRIPT;
  if (script === undefined || script === '') return { command: 'codex', prefixArgs: [] };
  if (!path.isAbsolute(script) || !fs.existsSync(script) || !fs.statSync(script).isFile()) {
    fail('LIVE_CODEX_TEST_SCRIPT must name an absolute file');
  }
  return { command: process.execPath, prefixArgs: [script] };
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

function summarize(id, strictness, metadata, events, workspace) {
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
    live: metadataIsClean(metadata) && completed && !failed,
    exit_code: metadata.exit_code,
    signal: metadata.signal,
    timed_out: metadata.timed_out,
    spawn_error: metadata.spawn_error,
    stdout_truncated: metadata.stdout_truncated,
    stderr_truncated: metadata.stderr_truncated,
    duration_ms: metadata.duration_ms,
    interrupted: metadata.interrupted,
    observable_events: observable,
    plan_artifact: planArtifact,
  };
}

function metadataIsClean(metadata) {
  return (
    metadata.exit_code === 0 &&
    metadata.signal === null &&
    metadata.timed_out === false &&
    metadata.spawn_error === null &&
    metadata.stdout_truncated === false &&
    metadata.stderr_truncated === false &&
    metadata.interrupted === false
  );
}

function validMetadata(metadata) {
  const expectedKeys = [
    'exit_code',
    'signal',
    'timed_out',
    'spawn_error',
    'stdout_truncated',
    'stderr_truncated',
    'interrupted',
    'duration_ms',
  ];
  return (
    metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    Object.keys(metadata).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(metadata, key)) &&
    (metadata.exit_code === null || Number.isInteger(metadata.exit_code)) &&
    (metadata.signal === null || typeof metadata.signal === 'string') &&
    typeof metadata.timed_out === 'boolean' &&
    (metadata.spawn_error === null || typeof metadata.spawn_error === 'string') &&
    typeof metadata.stdout_truncated === 'boolean' &&
    typeof metadata.stderr_truncated === 'boolean' &&
    typeof metadata.interrupted === 'boolean' &&
    Number.isInteger(metadata.duration_ms) &&
    metadata.duration_ms >= 0
  );
}

function normalizeMetadata(metadata) {
  if (metadata === undefined) {
    return {
      exit_code: 0,
      signal: null,
      timed_out: false,
      spawn_error: null,
      stdout_truncated: false,
      stderr_truncated: false,
      interrupted: false,
      duration_ms: 0,
    };
  }
  if (
    metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    Object.keys(metadata).length === 1 &&
    Object.keys(metadata)[0] === 'exit_code' &&
    (metadata.exit_code === null || Number.isInteger(metadata.exit_code))
  ) {
    return {
      exit_code: metadata.exit_code,
      signal: null,
      timed_out: false,
      spawn_error: null,
      stdout_truncated: false,
      stderr_truncated: false,
      interrupted: false,
      duration_ms: 0,
    };
  }
  return metadata;
}

function checkScenario(resultsDir, scenario) {
  const caseDir = path.join(resultsDir, scenario.id);
  const tracePath = path.join(caseDir, 'trace.jsonl');
  const metaPath = path.join(caseDir, 'meta.json');
  if (!fs.existsSync(tracePath)) fail(`${scenario.id}: missing trace.jsonl`);
  const meta = normalizeMetadata(fs.existsSync(metaPath) ? readJson(metaPath) : undefined);
  if (!validMetadata(meta)) fail(`${scenario.id}: invalid meta.json`);
  const workspace = path.join(caseDir, 'workspace');
  const events = meta.stdout_truncated ? [] : parseTrace(tracePath);
  const summary = summarize(
    scenario.id,
    scenario.strictness,
    meta,
    events,
    workspace
  );
  fs.writeFileSync(path.join(caseDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

function interruptedSummary(scenario) {
  return {
    scenario: scenario.id,
    strictness: scenario.strictness,
    live: false,
    exit_code: null,
    signal: null,
    timed_out: false,
    spawn_error: null,
    stdout_truncated: false,
    stderr_truncated: false,
    duration_ms: 0,
    interrupted: true,
    observable_events: [{ kind: 'terminal', event: null, usage: {} }],
    plan_artifact: null,
  };
}

function terminateChildTree(child, force) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
      const taskkill = systemRoot ? path.join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
      const killer = childProcess.spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {
        try {
          child.kill();
        } catch {}
      });
    } catch {
      try {
        child.kill();
      } catch {}
    }
    return;
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {}
  }
}

function handleParentSignal(signal) {
  parentSignalCount++;
  parentInterrupted = true;
  if (activeRun) activeRun.interrupt(parentSignalCount > 1);
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  if (parentSignalCount > 1) process.exit(process.exitCode);
}

process.on('SIGINT', () => handleParentSignal('SIGINT'));
process.on('SIGTERM', () => handleParentSignal('SIGTERM'));

async function runChildCase(index, total, id, command, args, options, timeoutMs) {
  const started = Date.now();
  process.stderr.write(`[${index}/${total}] ${id} start elapsed=0ms outcome=running\n`);
  let child;
  let interrupted = false;
  let spawnError = null;
  let timedOut = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const stdoutChunks = [];
  const stderrChunks = [];

  const capture = (chunk, chunks, seen, truncated) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, MAX_CAPTURE_BYTES - seen);
    if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
    return {
      seen: seen + buffer.length,
      truncated: truncated || buffer.length > remaining,
    };
  };

  const result = await new Promise((resolve) => {
    let closeResult = null;
    let forceSettleTimer = null;
    let forceStageStarted = false;
    let graceTimer = null;
    let timeoutTimer = null;
    let terminationStarted = false;
    let settled = false;
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      clearTimeout(forceSettleTimer);
      activeRun = null;
      resolve({ exitCode, signal });
    };
    try {
      child = childProcess.spawn(command, args, {
        ...options,
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      spawnError = err && err.message ? err.message : String(err);
      finish(null, null);
      return;
    }
    const startForceStage = () => {
      if (forceStageStarted) return;
      forceStageStarted = true;
      clearTimeout(graceTimer);
      terminateChildTree(child, true);
      forceSettleTimer = setTimeout(() => {
        finish(
          closeResult ? closeResult.exitCode : null,
          closeResult ? closeResult.signal : null
        );
      }, FORCE_SETTLE_MS);
    };
    const terminate = (force) => {
      if (force) {
        terminationStarted = true;
        startForceStage();
        return;
      }
      if (terminationStarted) return;
      terminationStarted = true;
      terminateChildTree(child, false);
      graceTimer = setTimeout(startForceStage, TERMINATE_GRACE_MS);
    };
    const interrupt = (force) => {
      interrupted = true;
      terminate(force);
    };
    activeRun = { interrupt, terminate };
    child.stdout.on('data', (chunk) => {
      const captured = capture(chunk, stdoutChunks, stdoutBytes, stdoutTruncated);
      stdoutBytes = captured.seen;
      stdoutTruncated = captured.truncated;
    });
    child.stderr.on('data', (chunk) => {
      const captured = capture(chunk, stderrChunks, stderrBytes, stderrTruncated);
      stderrBytes = captured.seen;
      stderrTruncated = captured.truncated;
    });
    child.on('error', (err) => {
      spawnError = err && err.message ? err.message : String(err);
    });
    child.on('close', (exitCode, signal) => {
      closeResult = { exitCode, signal };
      if (!terminationStarted) finish(exitCode, signal);
    });
    child.stdin.end(options.input || '');
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate(false);
    }, timeoutMs);
  });

  const metadata = {
    exit_code: result.exitCode,
    signal: result.signal,
    timed_out: timedOut,
    spawn_error: spawnError,
    stdout_truncated: stdoutTruncated,
    stderr_truncated: stderrTruncated,
    interrupted,
    duration_ms: Date.now() - started,
  };
  let outcome = 'success';
  if (metadata.interrupted) outcome = 'interrupted';
  else if (metadata.timed_out) outcome = 'timeout';
  else if (metadata.spawn_error) outcome = 'spawn_error';
  else if (metadata.stdout_truncated || metadata.stderr_truncated) outcome = 'truncated';
  else if (metadata.signal) outcome = `signal:${metadata.signal}`;
  else if (metadata.exit_code !== 0) outcome = `exit:${metadata.exit_code}`;
  process.stderr.write(
    `[${index}/${total}] ${id} complete elapsed=${metadata.duration_ms}ms outcome=${outcome}\n`
  );
  return {
    stdout: Buffer.concat(stdoutChunks),
    stderr: Buffer.concat(stderrChunks),
    metadata,
  };
}

async function runScenario(resultsDir, casesPath, scenario, index, total, timeoutMs, invocation) {
  const fixture = path.resolve(path.dirname(casesPath), scenario.fixture);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `skill-comply-${scenario.id}-`));
  const workspace = path.join(scratch, 'workspace');
  const caseDir = path.join(resultsDir, scenario.id);
  fs.rmSync(caseDir, { recursive: true, force: true });
  fs.mkdirSync(caseDir, { recursive: true });
  fs.cpSync(fixture, workspace, { recursive: true });
  childProcess.spawnSync('git', ['init', '-q'], { cwd: workspace, stdio: 'inherit' });
  try {
    const run = await runChildCase(
      index,
      total,
      scenario.id,
      invocation.command,
      [
        ...invocation.prefixArgs,
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
      { cwd: workspace },
      timeoutMs
    );
    fs.writeFileSync(path.join(caseDir, 'trace.jsonl'), run.stdout);
    fs.writeFileSync(path.join(caseDir, 'trace.err'), run.stderr);
    fs.writeFileSync(
      path.join(caseDir, 'meta.json'),
      JSON.stringify(run.metadata, null, 2) + '\n'
    );
    const capturedWorkspace = path.join(caseDir, 'workspace');
    fs.rmSync(capturedWorkspace, { recursive: true, force: true });
    fs.cpSync(workspace, capturedWorkspace, {
      recursive: true,
      filter: (source) => path.basename(source) !== '.git',
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
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
  let attempted = null;
  if (mode === '--run') {
    if (process.env.COMPLY_ALLOW_SPEND !== '1') {
      fail('--run is billable; set COMPLY_ALLOW_SPEND=1 after isolating HOME, CODEX_HOME, and the workspace');
    }
    const timeoutMs = liveCaseTimeout();
    const invocation = codexInvocation();
    attempted = new Set();
    for (let index = 0; index < corpus.scenarios.length; index++) {
      if (parentInterrupted) break;
      attempted.add(corpus.scenarios[index].id);
      await runScenario(
        resultsDir,
        casesPath,
        corpus.scenarios[index],
        index + 1,
        corpus.scenarios.length,
        timeoutMs,
        invocation
      );
    }
  }
  const summaries = corpus.scenarios.map((scenario) =>
    attempted && !attempted.has(scenario.id)
      ? interruptedSummary(scenario)
      : checkScenario(resultsDir, scenario)
  );
  process.stdout.write(JSON.stringify({ target: corpus.target, spec: corpus.spec, cases: summaries }, null, 2) + '\n');
  if (summaries.some((summary) => !summary.live) || parentInterrupted) {
    process.exitCode = process.exitCode || 1;
  }
}

try {
  main().catch((err) => {
    process.stderr.write(`error: ${err && err.message}\n`);
    process.exit(1);
  });
} catch (err) {
  process.stderr.write(`error: ${err && err.message}\n`);
  process.exit(1);
}
