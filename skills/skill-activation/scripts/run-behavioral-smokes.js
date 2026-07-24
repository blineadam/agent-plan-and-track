#!/usr/bin/env node
/**
 * run-behavioral-smokes.js: behavioral-regression harness for skill bodies.
 *
 * Sibling to run-activation-cases.js, answering a different question. That
 * script checks whether the RIGHT skill FIRES for a prompt (a router/description
 * question). This one checks whether a skill that already fired still drives its
 * MANDATED behavior after a body trim (a body question): does a fresh agent that
 * activates skill X actually produce the file/content that X's SKILL.md
 * requires? Deterministic and corpus-pinned, unlike [[skill-comply]], which is
 * LLM-judged strictness measurement across supportive/neutral/competing prompts.
 * Use this when a skill body was trimmed or edited and you want a pinned,
 * reproducible regression check that the trim didn't cut behavior; use
 * skill-comply when you want a broader compliance measurement.
 *
 * Left untouched: run-activation-cases.js and its activation-cases.jsonl. This
 * script is a separate, self-contained sibling (per-script self-containment is
 * this repo's house style): its own corpus (fixtures/behavioral-cases.jsonl),
 * its own fixture dirs (fixtures/behavioral/<id>/), node core modules only.
 *
 * Case schema (one JSON object per line in the corpus):
 *   { id, skill, prompt, max_turns, fixture,
 *     assertions: [ { kind: "file_regex", path, regex, flags } ], note }
 * `fixture` names a directory under fixtures/behavioral/ that is copied into
 * the case's working directory before the agent runs (a file the skill's
 * mandated output must be appended to, not clobber). Prompts should name the
 * target skill: unlike activation-cases.jsonl (which tests routing on an
 * unnamed prompt), the naming here is deliberate, since the point is to prove
 * the BODY still works once the skill has fired, not to test routing again.
 *
 * Usage:
 *   node run-behavioral-smokes.js --dry-run [CORPUS]        # lint the corpus (free); exit 1 on any problem
 *   node run-behavioral-smokes.js --check RESULTS_DIR [CORPUS]  # score pre-captured results (free)
 *   node run-behavioral-smokes.js --run [RESULTS_DIR] [CORPUS] # invoke claude -p per case (COSTS money)
 *
 * CORPUS defaults to the sibling fixtures/behavioral-cases.jsonl. Fixture dirs
 * default to fixtures/behavioral/<fixture>/.
 *
 * --check reads one trace per case at RESULTS_DIR/<id>.jsonl and evaluates
 * file_regex assertions against RESULTS_DIR/<id>/<assertion.path>. --run writes
 * those same files then scores them identically, but is a real, billable,
 * tool-executing operation: it refuses unless ACTIVATION_ALLOW_SPEND=1, and you
 * MUST run it inside an isolated container/VM with no network egress and
 * restricted mounts; a competing/injected prompt will execute tool calls. Never
 * pass --dangerously-skip-permissions here. --run uses --permission-mode
 * acceptEdits (not a read-only mode), since the whole point of a behavioral
 * smoke is that the skill under test WRITES a file; a read-only permission
 * mode would make every case a false negative. --run is Claude-only and
 * intended for a unix sandbox; --dry-run / --check are the cross-platform,
 * free modes. See SKILL.md for the full rationale.
 *
 * Scoring is LIVENESS-FIRST, in this strict order, per case:
 *   1. liveness  - the trace's terminal `result` event must show subtype
 *                  "success", a falsy is_error, num_turns > 0, and
 *                  total_cost_usd > 0. Missing or failing any of these scores
 *                  "invalid", never a pass and never a negative: it means the
 *                  run didn't execute cleanly, which is a different thing from
 *                  the skill executing and failing to behave correctly.
 *   2. activation - only scored if live: the case's `skill` must appear as a
 *                  Skill tool_use in the trace, else "fail".
 *   3. behavior  - only scored if live and activated: every file_regex
 *                  assertion must match, else "fail".
 *
 * Tuning (env):
 *   ACTIVATION_ALLOW_SPEND   set to 1 to permit --run to call claude -p (same
 *                            gate as run-activation-cases.js; same owning skill)
 *   LIVE_CASE_TIMEOUT_MS     per-case timeout for live runs (default 900000)
 *   LIVE_CLAUDE_TEST_SCRIPT  absolute fake-CLI script path used only by free fixtures
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const DEFAULT_CORPUS = path.join(SCRIPT_DIR, '..', 'fixtures', 'behavioral-cases.jsonl');
const FORCE_SETTLE_MS = 100;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_TIMER_MS = 2_147_483_647;
const TERMINATE_GRACE_MS = 1000;

let activeRun = null;
let parentInterrupted = false;
let parentSignalCount = 0;

function die(msg, code) {
  process.stderr.write(msg + '\n');
  process.exit(code === undefined ? 1 : code);
}

function liveCaseTimeout() {
  const raw = process.env.LIVE_CASE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 900000;
  if (!/^[0-9]+$/.test(raw)) {
    die(`error: LIVE_CASE_TIMEOUT_MS must be an integer from 1 to ${MAX_TIMER_MS}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    die(`error: LIVE_CASE_TIMEOUT_MS must be an integer from 1 to ${MAX_TIMER_MS}`);
  }
  return value;
}

function claudeInvocation() {
  const script = process.env.LIVE_CLAUDE_TEST_SCRIPT;
  if (script === undefined || script === '') return { command: 'claude', prefixArgs: [] };
  if (!path.isAbsolute(script) || !isFile(script)) {
    die('error: LIVE_CLAUDE_TEST_SCRIPT must name an absolute file');
  }
  return { command: process.execPath, prefixArgs: [script] };
}

// jq pretty-print parity: 2-space indent + a trailing newline.
function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// Read a JSONL file into an array of parsed objects, skipping blank lines.
function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    out.push(JSON.parse(line));
  }
  return out;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Every object in a parsed value, recursively (the `.. | objects` in jq).
function* walkObjects(value) {
  if (Array.isArray(value)) {
    for (const el of value) yield* walkObjects(el);
  } else if (value && typeof value === 'object') {
    yield value;
    for (const key of Object.keys(value)) yield* walkObjects(value[key]);
  }
}

// The set of skills a trace activated via the Skill tool. Harness-tolerant:
// matches any object whose tool name is "skill" (case-insensitive), reading
// the skill name from whichever field the harness places it in. Returns a
// sorted, de-duplicated array. Copied from run-activation-cases.js.
function activatedSkills(traceFile) {
  const set = new Set();
  let text;
  try {
    text = fs.readFileSync(traceFile, 'utf8');
  } catch {
    return [];
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a non-JSON line contributes no skill events
    }
    for (const obj of walkObjects(parsed)) {
      const name = typeof obj.name === 'string' ? obj.name.toLowerCase() : '';
      if (name !== 'skill') continue;
      let skill = null;
      if (obj.input && obj.input.skill != null && obj.input.skill !== '') skill = obj.input.skill;
      else if (obj.input && obj.input.name != null && obj.input.name !== '') skill = obj.input.name;
      else if (obj.arguments && obj.arguments.skill != null && obj.arguments.skill !== '') skill = obj.arguments.skill;
      if (skill != null && skill !== '') set.add(String(skill));
    }
  }
  return Array.from(set).sort();
}

// Reject both path separators (\ is a separator on Windows) plus `..`, so a
// case id can't escape RESULTS_DIR when interpolated into a path. Also used for
// `fixture`, which likewise names a single direct-child directory.
function idIsPathSafe(id) {
  return typeof id === 'string' && id !== '' && !id.includes('/') && !id.includes('\\') && !id.includes('..');
}

// An assertion `path` is a relative file path under the case dir (e.g.
// "tasks/lessons.md"), so unlike an id/fixture it legitimately contains
// separators. Reject absolute paths and any `..` segment so it can't escape the
// case dir and read another case's artifact.
function relPathIsContained(p) {
  if (typeof p !== 'string' || p === '') return false;
  const segments = p.split(/[\\/]/);
  if (segments[0] === '') return false; // leading separator: absolute
  if (/^[A-Za-z]:/.test(p)) return false; // Windows drive-absolute
  return !segments.includes('..');
}

// Ids appearing more than once in the corpus. Duplicates collide on the same
// <id>.jsonl / <id>/ paths, so at --run time the later case overwrites the
// earlier and both would then score against the last writer's artifacts.
function duplicateIds(cases) {
  const counts = new Map();
  for (const c of cases) {
    if (typeof c.id === 'string' && c.id !== '') counts.set(c.id, (counts.get(c.id) || 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([id]) => id));
}

// ---- --dry-run: static corpus lint (free) -----------------------------------
function modeDryRun(args) {
  const corpus = args[0] || DEFAULT_CORPUS;
  if (!isFile(corpus)) die(`error: no corpus at ${corpus}`);
  const cases = readJsonl(corpus);
  const fixturesDir = path.join(path.dirname(corpus), 'behavioral');
  const linted = cases.map((c) => lintCase(c, fixturesDir));
  const dups = duplicateIds(cases);
  linted.forEach((entry, i) => {
    const id = cases[i].id;
    if (dups.has(id)) {
      entry.problems.push(`duplicate id '${id}': ids must be unique across the corpus`);
      entry.problem_count = entry.problems.length;
    }
  });
  const problemCount = linted.reduce((sum, c) => sum + c.problem_count, 0);
  printJson({
    case_count: cases.length,
    problem_count: problemCount,
    cases: linted,
  });
  process.exit(problemCount > 0 ? 1 : 0);
}

function lintCase(c, fixturesDir) {
  const problems = [];

  if (!idIsPathSafe(c.id)) {
    problems.push(c.id === undefined || c.id === '' ? 'missing id' : `invalid id '${c.id}': path syntax not allowed`);
  }

  if (typeof c.skill !== 'string' || c.skill === '') problems.push('missing skill');
  if (typeof c.prompt !== 'string' || c.prompt === '') problems.push('missing prompt');

  if (!(Number.isInteger(c.max_turns) && c.max_turns > 0)) {
    problems.push(`invalid max_turns: ${JSON.stringify(c.max_turns)}`);
  }

  if (typeof c.fixture !== 'string' || c.fixture === '') {
    problems.push('missing fixture');
  } else if (!idIsPathSafe(c.fixture)) {
    problems.push(`invalid fixture '${c.fixture}': must be a direct-child dir name, no path syntax`);
  } else if (!isDir(path.join(fixturesDir, c.fixture))) {
    problems.push(`fixture dir not found: ${c.fixture}`);
  }

  if (!Array.isArray(c.assertions) || c.assertions.length === 0) {
    problems.push('missing assertions');
  } else {
    c.assertions.forEach((a, i) => {
      if (!a || a.kind !== 'file_regex') problems.push(`assertions[${i}]: kind must be file_regex`);
      if (!a || typeof a.path !== 'string' || a.path === '') {
        problems.push(`assertions[${i}]: missing path`);
      } else if (!relPathIsContained(a.path)) {
        problems.push(`assertions[${i}]: unsafe path '${a.path}': must stay inside the case dir`);
      }
      if (!a || typeof a.regex !== 'string' || a.regex === '') {
        problems.push(`assertions[${i}]: missing regex`);
      } else {
        try {
          new RegExp(a.regex, a.flags);
        } catch (e) {
          problems.push(`assertions[${i}]: regex does not compile: ${e.message}`);
        }
      }
    });
  }

  return { id: c.id ?? null, problem_count: problems.length, problems };
}

function readRunMetadata(metaPath) {
  if (!isFile(metaPath)) return { present: false, clean: true, reason: '' };
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return { present: true, clean: false, reason: 'invalid run metadata' };
  }
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
  const valid =
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
    metadata.duration_ms >= 0;
  if (!valid) return { present: true, clean: false, reason: 'invalid run metadata' };
  if (metadata.interrupted) {
    return { present: true, clean: false, reason: 'live run interrupted', metadata };
  }
  if (metadata.timed_out) return { present: true, clean: false, reason: 'live run timed out', metadata };
  if (metadata.spawn_error !== null) {
    return { present: true, clean: false, reason: `live run spawn error: ${metadata.spawn_error}`, metadata };
  }
  if (metadata.stdout_truncated || metadata.stderr_truncated) {
    return { present: true, clean: false, reason: 'live run output truncated', metadata };
  }
  if (metadata.signal !== null) {
    return { present: true, clean: false, reason: `live run ended by signal ${metadata.signal}`, metadata };
  }
  if (metadata.exit_code !== 0) {
    return { present: true, clean: false, reason: `live run exited ${metadata.exit_code}`, metadata };
  }
  return { present: true, clean: true, reason: '', metadata };
}

// ---- Liveness ----------------------------------------------------------------
// Scans a trace for its terminal `result` event (the last object seen with
// type==="result") and checks the four liveness conditions against it. These
// field names (type/subtype/is_error/num_turns/total_cost_usd) are the Claude
// Code stream-json result-event contract, confirmed against a real captured
// trace.
function checkLiveness(traceFile) {
  let text;
  try {
    text = fs.readFileSync(traceFile, 'utf8');
  } catch {
    return { ok: false, reason: 'no trace file' };
  }
  let resultEvent = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const obj of walkObjects(parsed)) {
      if (obj.type === 'result') resultEvent = obj; // last one wins: the terminal event
    }
  }
  if (!resultEvent) return { ok: false, reason: 'no result event' };
  if (resultEvent.subtype !== 'success') {
    return { ok: false, reason: `subtype not success (got ${JSON.stringify(resultEvent.subtype)})` };
  }
  if (resultEvent.is_error) return { ok: false, reason: 'is_error is truthy' };
  if (!(typeof resultEvent.num_turns === 'number' && resultEvent.num_turns > 0)) {
    return { ok: false, reason: `num_turns not > 0 (got ${JSON.stringify(resultEvent.num_turns)})` };
  }
  if (!(typeof resultEvent.total_cost_usd === 'number' && resultEvent.total_cost_usd > 0)) {
    return { ok: false, reason: `total_cost_usd not > 0 (got ${JSON.stringify(resultEvent.total_cost_usd)})` };
  }
  return { ok: true };
}

// ---- Scoring (shared by --check and --run) ------------------------------------
function scoreCase(c, resultsDir, dups, runState) {
  const id = c.id;
  if (!idIsPathSafe(id)) {
    return { id: id ?? null, status: 'invalid', reason: `invalid id '${id}': path syntax not allowed`, activated: [] };
  }
  if (dups.has(id)) {
    return { id, status: 'invalid', reason: `duplicate id '${id}': ids must be unique across the corpus`, activated: [] };
  }
  if (runState && !runState.attempted.has(id)) {
    return {
      id,
      status: 'invalid',
      reason: runState.interrupted ? 'interrupted before start' : 'not attempted during this run',
      activated: [],
    };
  }

  const trace = path.join(resultsDir, `${id}.jsonl`);
  const activated = activatedSkills(trace);

  const metadata = readRunMetadata(path.join(resultsDir, `${id}.meta.json`));
  if (!metadata.clean) {
    return { id, status: 'invalid', reason: metadata.reason, activated };
  }

  const liveness = checkLiveness(trace);
  if (!liveness.ok) {
    return { id, status: 'invalid', reason: liveness.reason, activated };
  }

  if (!activated.includes(c.skill)) {
    return { id, status: 'fail', reason: `skill ${c.skill} not activated`, activated };
  }

  const caseDir = path.join(resultsDir, id);
  for (const a of c.assertions) {
    if (!relPathIsContained(a.path)) {
      return { id, status: 'invalid', reason: `unsafe assertion path '${a.path}'`, activated };
    }
    const filePath = path.join(caseDir, a.path);
    if (!isFile(filePath)) {
      return { id, status: 'fail', reason: `missing file: ${a.path}`, activated };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const re = new RegExp(a.regex, a.flags);
    if (!re.test(content)) {
      return { id, status: 'fail', reason: `assertion failed: ${a.path} !~ /${a.regex}/${a.flags}`, activated };
    }
  }

  return { id, status: 'pass', reason: 'ok', activated };
}

function scoreCases(cases, resultsDir, runState) {
  const dups = duplicateIds(cases);
  const cs = cases.map((c) => scoreCase(c, resultsDir, dups, runState));
  return {
    total: cs.length,
    passed: cs.filter((r) => r.status === 'pass').length,
    failed: cs.filter((r) => r.status === 'fail').length,
    invalid: cs.filter((r) => r.status === 'invalid').length,
    cases: cs,
  };
}

// ---- --check: score pre-captured results (free) -------------------------------
function modeCheck(args) {
  if (args.length < 1) die('error: --check needs RESULTS_DIR');
  const resultsDir = args[0];
  const corpus = args[1] || DEFAULT_CORPUS;
  if (!isDir(resultsDir)) die(`error: no results dir at ${resultsDir}`);
  if (!isFile(corpus)) die(`error: no corpus at ${corpus}`);
  const cases = readJsonl(corpus);
  const report = scoreCases(cases, resultsDir);
  printJson(report);
  if (report.failed > 0 || report.invalid > 0) process.exitCode = 1;
}

// ---- --run: billable, invokes claude -p per case -------------------------------
function hasClaude(invocation) {
  if (invocation.prefixArgs.length > 0) return true;
  if (process.platform === 'win32') {
    return spawnSync('where.exe', ['claude'], { encoding: 'utf8' }).status === 0;
  }
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(entry || process.cwd(), 'claude');
    try {
      if (isFile(candidate)) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      }
    } catch {}
  }
  return false;
}

function terminateChildTree(child, force) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
      const taskkill = systemRoot ? path.join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
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
    const remaining = Math.max(0, MAX_OUTPUT_BYTES - seen);
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
      child = spawn(command, args, {
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

async function modeRun(args) {
  if (process.env.ACTIVATION_ALLOW_SPEND !== '1') {
    process.stderr.write('refusing: --run invokes claude -p (billable, executes tool calls).\n');
    die('Run inside an isolated container/VM, then set ACTIVATION_ALLOW_SPEND=1.', 2);
  }
  const timeoutMs = liveCaseTimeout();
  const invocation = claudeInvocation();
  if (!hasClaude(invocation)) die('error: claude CLI not found');

  const resultsDir = args[0] || fs.mkdtempSync(path.join(os.tmpdir(), 'behavioral-'));
  if (!isDir(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  const corpus = args[1] || DEFAULT_CORPUS;
  if (!isFile(corpus)) die(`error: no corpus at ${corpus}`);
  const cases = readJsonl(corpus);
  const dups = duplicateIds(cases);
  const fixturesDir = path.join(path.dirname(corpus), 'behavioral');
  const attempted = new Set();

  for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
    if (parentInterrupted) break;
    const c = cases[caseIndex];
    // Scored as invalid below; never touch the filesystem (or spend) on an
    // unsafe id/fixture or a duplicate id that would collide on <id> paths.
    if (!idIsPathSafe(c.id) || !idIsPathSafe(c.fixture) || dups.has(c.id)) continue;
    attempted.add(c.id);
    const fixtureDir = path.join(fixturesDir, c.fixture);
    const caseDir = path.join(resultsDir, c.id);
    fs.rmSync(caseDir, { recursive: true, force: true });
    for (const suffix of ['.jsonl', '.err', '.meta.json']) {
      fs.rmSync(path.join(resultsDir, `${c.id}${suffix}`), { force: true });
    }
    fs.cpSync(fixtureDir, caseDir, { recursive: true });

    const run = await runChildCase(
      caseIndex + 1,
      cases.length,
      c.id,
      invocation.command,
      [
        ...invocation.prefixArgs,
        '-p',
        c.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        '--max-turns',
        String(c.max_turns),
      ],
      { cwd: caseDir, input: '' },
      timeoutMs
    );
    fs.writeFileSync(path.join(resultsDir, `${c.id}.jsonl`), run.stdout);
    fs.writeFileSync(path.join(resultsDir, `${c.id}.err`), run.stderr);
    fs.writeFileSync(
      path.join(resultsDir, `${c.id}.meta.json`),
      JSON.stringify(run.metadata, null, 2) + '\n'
    );
  }

  // Retained (not deleted) so a failing case's trace/working dir can be
  // inspected; rm it when done.
  process.stderr.write(`# results retained at ${resultsDir}: inspect failing cases, then rm\n`);
  const report = scoreCases(cases, resultsDir, { attempted, interrupted: parentInterrupted });
  printJson(report);
  if (report.failed > 0 || report.invalid > 0 || parentInterrupted) {
    process.exitCode = process.exitCode || 1;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = argv[0] || '';
  if (flag === '--dry-run') {
    modeDryRun(argv.slice(1));
  } else if (flag === '--check') {
    modeCheck(argv.slice(1));
  } else if (flag === '--run') {
    await modeRun(argv.slice(1));
  } else if (flag.startsWith('-')) {
    die(`error: unknown flag ${flag}`);
  } else {
    modeDryRun(argv);
  }
}

main().catch((err) => die(`error: ${err && err.message}`));
