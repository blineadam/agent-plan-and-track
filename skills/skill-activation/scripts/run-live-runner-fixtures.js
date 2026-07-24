#!/usr/bin/env node
/**
 * run-live-runner-fixtures.js: free process-control fixtures for live runners.
 *
 * Invokes the real activation, behavioral-smoke, and Codex skill-comply entry
 * points against generated fake claude/codex executables. Node core only,
 * cross-platform, no network or model calls.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT_DIR = __dirname;
const ACTIVATION_RUNNER = path.join(SCRIPT_DIR, 'run-activation-cases.js');
const BEHAVIORAL_RUNNER = path.join(SCRIPT_DIR, 'run-behavioral-smokes.js');
const TEST_PROCESS_TIMEOUT_MS = 8000;

let scratchRoot = null;
let fakeScripts = null;
const extraCleanup = new Set();
const running = new Set();

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function findCodexRunner() {
  const skillsRoots = [
    path.resolve(SCRIPT_DIR, '..', '..'),
    path.join(os.homedir(), '.agents', 'skills'),
    path.join(os.homedir(), '.claude', 'skills'),
  ];
  for (const root of skillsRoots) {
    const candidate = path.join(root, 'skill-comply', 'scripts', 'run-codex-cases.js');
    if (fs.existsSync(candidate)) return candidate;
  }
  fail(
    `skill-comply runner not found under source or installed skills roots: ${skillsRoots.join(', ')}`
  );
}

function writeJsonl(file, values) {
  fs.writeFileSync(file, values.map((value) => JSON.stringify(value)).join('\n') + '\n');
}

function writeFakeExecutables(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const fakeCli = path.join(binDir, 'fake-cli.js');
  fs.writeFileSync(
    fakeCli,
    [
      "'use strict';",
      "const { spawn } = require('child_process');",
      "const fs = require('fs');",
      "const path = require('path');",
      "const kind = process.env.FAKE_CLI_KIND || path.basename(process.argv[1]).replace(/\\.(cmd|exe)$/i, '');",
      "const args = process.argv.slice(2);",
      "const promptIndex = args.indexOf('-p');",
      "const prompt = promptIndex >= 0 ? String(args[promptIndex + 1] || '') : String(args[args.length - 1] || '');",
      "if (process.env.FAKE_SPAWN_MARKER) fs.appendFileSync(process.env.FAKE_SPAWN_MARKER, kind + '\\n');",
      "const activityMatch = /activity64=([A-Za-z0-9+/=]+)/.exec(prompt);",
      "const activity = activityMatch ? Buffer.from(activityMatch[1], 'base64').toString('utf8') : '';",
      "const emitClaude = () => {",
      "  process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Skill',input:{skill:'fixture-skill'}}]}}) + '\\n');",
      "  process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,num_turns:1,total_cost_usd:0.01}) + '\\n');",
      "  if (process.env.FAKE_WRITE_ARTIFACT === '1') {",
      "    try { fs.writeFileSync(path.join(process.cwd(), 'artifact.txt'), 'fixture output\\n'); } catch {}",
      "  }",
      "};",
      "const emitCodex = () => process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}) + '\\n');",
      "const emit = kind === 'codex' ? emitCodex : emitClaude;",
      "if (prompt.includes('truncate-stdout')) {",
      "  emit();",
      "  process.stdout.write(Buffer.alloc(33 * 1024 * 1024, 120), () => process.exit(0));",
      "} else if (prompt.includes('timeout') || prompt.includes('signal-case')) {",
      "  emit();",
      "  if (activity) {",
      "    const code = \"const fs=require('fs');const p=process.argv[1];process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(p,'x'),20);\";",
      "    spawn(process.execPath, ['-e', code, activity], { stdio: 'ignore' });",
      "  }",
      "  if (!prompt.includes('parent-default-sigterm')) process.on('SIGTERM', () => {});",
      "  setInterval(() => {}, 1000);",
      "} else {",
      "  const delay = prompt.includes('slow-success') ? 180 : 10;",
      "  setTimeout(() => { emit(); process.exit(prompt.includes('nonzero') ? 7 : 0); }, delay);",
      "}",
      '',
    ].join('\n')
  );

  const scripts = {};
  for (const kind of ['claude', 'codex']) {
    const launcher = path.join(binDir, `fake-${kind}.js`);
    fs.writeFileSync(
      launcher,
      `'use strict';\nprocess.env.FAKE_CLI_KIND=${JSON.stringify(kind)};\nrequire('./fake-cli.js');\n`
    );
    scripts[kind] = launcher;
  }
  return scripts;
}

function terminateTree(child, force) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
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

function runNode(script, args, env, onStderr) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      detached: process.platform !== 'win32',
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    running.add(child);
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      terminateTree(child, true);
      if (!settled) reject(new Error(`${path.basename(script)} fixture process timed out`));
    }, TEST_PROCESS_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      if (onStderr) onStderr(chunk.toString('utf8'), child);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      settled = true;
      clearTimeout(timer);
      running.delete(child);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function parseReport(run, label) {
  try {
    return JSON.parse(run.stdout);
  } catch (err) {
    fail(`${label}: stdout was not JSON: ${err.message}\n${run.stdout}`);
  }
}

function makeDescription(length) {
  const prefix = 'Use when testing. ';
  assert(length >= prefix.length, `description fixture length ${length} is too short`);
  return prefix + 'x'.repeat(length - prefix.length);
}

function writeSkillFixture(root, name, description) {
  const skillDir = path.join(root, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n`
  );
}

async function testPrecheckLengths(binDir) {
  const softRoot = path.join(scratchRoot, 'precheck-soft');
  writeSkillFixture(softRoot, 'soft-target', makeDescription(501));
  const softRun = await runNode(ACTIVATION_RUNNER, ['--precheck', softRoot], baseEnv(binDir));
  const softReport = parseReport(softRun, 'precheck soft target');
  assert(softRun.code === 0, `precheck soft target exited ${softRun.code}, expected 0`);
  assert(softReport.schema_issue_count === 0, '501 characters counted as a schema issue');
  assert(softReport.skills[0].desc_overlong === true, '501 characters was not flagged overlong');
  assert(
    softReport.skills[0].description_length_ok === true,
    '501 characters failed the 1-1024 schema range'
  );

  const schemaRoot = path.join(scratchRoot, 'precheck-schema');
  writeSkillFixture(schemaRoot, 'schema-limit', makeDescription(1025));
  const schemaRun = await runNode(ACTIVATION_RUNNER, ['--precheck', schemaRoot], baseEnv(binDir));
  const schemaReport = parseReport(schemaRun, 'precheck schema maximum');
  assert(schemaRun.code === 1, `precheck schema maximum exited ${schemaRun.code}, expected 1`);
  assert(schemaReport.schema_issue_count === 1, '1025 characters did not count as a schema issue');
  assert(
    schemaReport.skills[0].description_length_ok === false,
    '1025 characters passed the 1-1024 schema range'
  );
}

function retainedActivationDir(stderr) {
  const match = /# traces retained at (.+): inspect failing cases, then rm/.exec(stderr);
  assert(match, `activation runner did not disclose its retained trace dir:\n${stderr}`);
  extraCleanup.add(match[1]);
  return match[1];
}

function baseEnv(binDir, additions) {
  return {
    ...process.env,
    ...additions,
    LIVE_CLAUDE_TEST_SCRIPT: fakeScripts.claude,
    LIVE_CODEX_TEST_SCRIPT: fakeScripts.codex,
    PATH: binDir,
  };
}

function makeBehavioralCorpus(root, cases) {
  const corpus = path.join(root, 'behavioral-cases.jsonl');
  const fixtures = path.join(root, 'behavioral');
  for (const fixture of new Set(cases.map((entry) => entry.fixture))) {
    fs.mkdirSync(path.join(fixtures, fixture), { recursive: true });
  }
  writeJsonl(corpus, cases);
  return corpus;
}

function makeCodexCorpus(root, scenarios) {
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, 'seed.txt'), 'seed\n');
  const corpus = path.join(root, 'codex-cases.json');
  fs.writeFileSync(
    corpus,
    JSON.stringify(
      {
        target: 'fixture',
        spec: { steps: [] },
        scenarios: scenarios.map((scenario) => ({ ...scenario, fixture: 'fixture' })),
      },
      null,
      2
    ) + '\n'
  );
  return corpus;
}

async function assertActivityStopped(activity, label) {
  await new Promise((resolve) => setTimeout(resolve, 120));
  const before = fs.existsSync(activity) ? fs.statSync(activity).size : 0;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const after = fs.existsSync(activity) ? fs.statSync(activity).size : 0;
  assert(before === after, `${label}: descendant activity continued after runner exit (${before} -> ${after})`);
}

async function testActivation(binDir) {
  const root = path.join(scratchRoot, 'activation');
  fs.mkdirSync(root, { recursive: true });
  const slowCorpus = path.join(root, 'slow.jsonl');
  writeJsonl(slowCorpus, [
    { id: 'slow-success', prompt: 'slow-success', expect_skill: 'fixture-skill' },
  ]);
  const slow = await runNode(
    ACTIVATION_RUNNER,
    ['--run', slowCorpus],
    baseEnv(binDir, { ACTIVATION_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '2000' })
  );
  const slowReport = parseReport(slow, 'activation slow success');
  assert(slow.code === 0 && slowReport.passed === 1, 'activation slow success did not pass');
  assert(
    slow.stderr.indexOf('[1/1] slow-success start') < slow.stderr.indexOf('[1/1] slow-success complete'),
    'activation start progress was not exposed before completion'
  );
  const slowResults = retainedActivationDir(slow.stderr);
  const slowMetaPath = path.join(slowResults, 'slow-success.meta.json');
  const slowMeta = JSON.parse(fs.readFileSync(slowMetaPath, 'utf8'));
  assert(slowMeta.exit_code === 0 && !slowMeta.timed_out, 'activation success metadata was not clean');
  fs.rmSync(slowMetaPath);
  const legacyCheck = await runNode(
    ACTIVATION_RUNNER,
    ['--check', slowResults, slowCorpus],
    baseEnv(binDir, {})
  );
  assert(
    legacyCheck.code === 0 && parseReport(legacyCheck, 'activation legacy check').passed === 1,
    'activation check rejected a legacy trace without metadata'
  );

  const continueCorpus = path.join(root, 'continue.jsonl');
  writeJsonl(continueCorpus, [
    { id: 'valid-looking-nonzero', prompt: 'nonzero', expect_skill: 'fixture-skill' },
    { id: 'after-failure', prompt: 'success', expect_skill: 'fixture-skill' },
  ]);
  const continued = await runNode(
    ACTIVATION_RUNNER,
    ['--run', continueCorpus],
    baseEnv(binDir, { ACTIVATION_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '2000' })
  );
  const continueReport = parseReport(continued, 'activation ordinary failure');
  assert(continued.code === 1, 'activation nonzero child did not fail the runner');
  assert(
    continueReport.total === 2 && continueReport.passed === 1,
    'activation ordinary failure did not preserve scoring or continue'
  );
  assert(
    continued.stderr.includes('[2/2] after-failure start'),
    'activation stopped before the case after an ordinary failure'
  );
  retainedActivationDir(continued.stderr);

  const marker = path.join(root, 'invalid-timeout-spawned');
  const invalidTimeout = await runNode(
    ACTIVATION_RUNNER,
    ['--run', slowCorpus],
    baseEnv(binDir, {
      ACTIVATION_ALLOW_SPEND: '1',
      LIVE_CASE_TIMEOUT_MS: '12x',
      FAKE_SPAWN_MARKER: marker,
    })
  );
  assert(invalidTimeout.code !== 0, 'activation accepted a malformed timeout');
  assert(!fs.existsSync(marker), 'activation spawned a live case before rejecting its timeout');

  const timeoutRoot = path.join(root, 'timeout');
  fs.mkdirSync(timeoutRoot, { recursive: true });
  const activity = path.join(timeoutRoot, 'descendant-activity');
  const activity64 = Buffer.from(activity).toString('base64');
  const timeoutCorpus = path.join(timeoutRoot, 'timeout.jsonl');
  writeJsonl(timeoutCorpus, [
    {
      id: 'timeout-case',
      prompt: `timeout parent-default-sigterm activity64=${activity64}`,
      expect_skill: 'fixture-skill',
    },
  ]);
  const timeout = await runNode(
    ACTIVATION_RUNNER,
    ['--run', timeoutCorpus],
    baseEnv(binDir, { ACTIVATION_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '200' })
  );
  const timeoutReport = parseReport(timeout, 'activation timeout');
  assert(timeout.code === 1 && timeoutReport.passed === 0, 'activation timeout did not fail');
  retainedActivationDir(timeout.stderr);
  await assertActivityStopped(activity, 'activation timeout');
}

async function testBehavioral(binDir) {
  const root = path.join(scratchRoot, 'behavioral');
  fs.mkdirSync(root, { recursive: true });
  const corpus = makeBehavioralCorpus(root, [
    {
      id: 'slow-success',
      skill: 'fixture-skill',
      prompt: 'slow-success',
      max_turns: 2,
      fixture: 'slow-success',
      assertions: [{ kind: 'file_regex', path: 'artifact.txt', regex: 'fixture output', flags: '' }],
    },
  ]);
  const results = path.join(root, 'results');
  const slow = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', results, corpus],
    baseEnv(binDir, {
      ACTIVATION_ALLOW_SPEND: '1',
      LIVE_CASE_TIMEOUT_MS: '2000',
      FAKE_WRITE_ARTIFACT: '1',
    })
  );
  const report = parseReport(slow, 'behavioral slow success');
  assert(slow.code === 0 && report.passed === 1, 'behavioral slow success did not pass');
  assert(
    slow.stderr.indexOf('[1/1] slow-success start') < slow.stderr.indexOf('[1/1] slow-success complete'),
    'behavioral start progress was not exposed before completion'
  );
  fs.rmSync(path.join(results, 'slow-success.meta.json'));
  const legacyCheck = await runNode(
    BEHAVIORAL_RUNNER,
    ['--check', results, corpus],
    baseEnv(binDir, {})
  );
  assert(
    legacyCheck.code === 0 && parseReport(legacyCheck, 'behavioral legacy check').passed === 1,
    'behavioral check rejected legacy results without metadata'
  );

  const timeoutRoot = path.join(root, 'timeout');
  fs.mkdirSync(timeoutRoot, { recursive: true });
  const activity = path.join(timeoutRoot, 'descendant-activity');
  const activity64 = Buffer.from(activity).toString('base64');
  const timeoutCorpus = makeBehavioralCorpus(timeoutRoot, [
    {
      id: 'timeout-case',
      skill: 'fixture-skill',
      prompt: `timeout parent-default-sigterm activity64=${activity64}`,
      max_turns: 2,
      fixture: 'timeout-case',
      assertions: [{ kind: 'file_regex', path: 'artifact.txt', regex: 'fixture output', flags: '' }],
    },
  ]);
  const timeout = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', path.join(timeoutRoot, 'results'), timeoutCorpus],
    baseEnv(binDir, {
      ACTIVATION_ALLOW_SPEND: '1',
      LIVE_CASE_TIMEOUT_MS: '200',
      FAKE_WRITE_ARTIFACT: '1',
    })
  );
  const timeoutReport = parseReport(timeout, 'behavioral timeout');
  assert(timeout.code === 1 && timeoutReport.invalid === 1, 'behavioral timeout did not fail as invalid');
  const timeoutMeta = JSON.parse(
    fs.readFileSync(path.join(timeoutRoot, 'results', 'timeout-case.meta.json'), 'utf8')
  );
  assert(timeoutMeta.timed_out === true, 'behavioral timeout metadata did not record timed_out');
  await assertActivityStopped(activity, 'behavioral timeout');
}

async function testCodex(binDir, codexRunner) {
  const root = path.join(scratchRoot, 'codex');
  fs.mkdirSync(root, { recursive: true });
  const corpus = makeCodexCorpus(root, [
    { id: 'valid-looking-nonzero', strictness: 'supportive', prompt: 'nonzero' },
    { id: 'after-failure', strictness: 'neutral', prompt: 'success' },
  ]);
  const results = path.join(root, 'results');
  const continued = await runNode(
    codexRunner,
    ['--run', results, corpus],
    baseEnv(binDir, { COMPLY_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '2000' })
  );
  const report = parseReport(continued, 'Codex ordinary failure');
  assert(continued.code === 1, 'Codex nonzero child did not fail the runner');
  assert(
    report.cases.length === 2 && report.cases[0].live === false && report.cases[1].live === true,
    'Codex ordinary failure did not preserve liveness scoring or continue'
  );
  assert(
    continued.stderr.includes('[2/2] after-failure start'),
    'Codex stopped before the case after an ordinary failure'
  );
  const meta = JSON.parse(
    fs.readFileSync(path.join(results, 'valid-looking-nonzero', 'meta.json'), 'utf8')
  );
  assert(meta.exit_code === 7, 'Codex metadata did not preserve the nonzero exit code');
  fs.rmSync(path.join(results, 'after-failure', 'meta.json'));
  const legacyCheck = await runNode(
    codexRunner,
    ['--check', results, corpus],
    baseEnv(binDir, {})
  );
  const legacyReport = parseReport(legacyCheck, 'Codex legacy check');
  assert(
    legacyCheck.code === 1 && legacyReport.cases[1].live === true,
    'Codex check rejected a legacy trace without metadata'
  );

  const timeoutRoot = path.join(root, 'timeout');
  fs.mkdirSync(timeoutRoot, { recursive: true });
  const activity = path.join(timeoutRoot, 'descendant-activity');
  const activity64 = Buffer.from(activity).toString('base64');
  const timeoutCorpus = makeCodexCorpus(timeoutRoot, [
    {
      id: 'timeout-case',
      strictness: 'supportive',
      prompt: `timeout parent-default-sigterm activity64=${activity64}`,
    },
  ]);
  const timeout = await runNode(
    codexRunner,
    ['--run', path.join(timeoutRoot, 'results'), timeoutCorpus],
    baseEnv(binDir, { COMPLY_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '200' })
  );
  const timeoutReport = parseReport(timeout, 'Codex timeout');
  assert(timeout.code === 1 && timeoutReport.cases[0].live === false, 'Codex timeout did not fail');
  await assertActivityStopped(activity, 'Codex timeout');

  const truncatedRoot = path.join(root, 'truncated');
  fs.mkdirSync(truncatedRoot, { recursive: true });
  const truncatedCorpus = makeCodexCorpus(truncatedRoot, [
    {
      id: 'truncated-case',
      strictness: 'supportive',
      prompt: 'truncate-stdout',
    },
  ]);
  const truncatedResults = path.join(truncatedRoot, 'results');
  const truncated = await runNode(
    codexRunner,
    ['--run', truncatedResults, truncatedCorpus],
    baseEnv(binDir, { COMPLY_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '5000' })
  );
  const truncatedReport = parseReport(truncated, 'Codex truncated stdout');
  const truncatedMeta = JSON.parse(
    fs.readFileSync(path.join(truncatedResults, 'truncated-case', 'meta.json'), 'utf8')
  );
  assert(
    truncated.code === 1 &&
      truncatedReport.cases[0].live === false &&
      truncatedMeta.stdout_truncated === true,
    'Codex truncated stdout was not normalized as non-live'
  );
}

function writeStaleBehavioralResult(resultsDir, id) {
  fs.mkdirSync(path.join(resultsDir, id), { recursive: true });
  fs.writeFileSync(path.join(resultsDir, id, 'artifact.txt'), 'fixture output\n');
  fs.writeFileSync(
    path.join(resultsDir, `${id}.jsonl`),
    [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'fixture-skill' } }],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.01,
      }),
      '',
    ].join('\n')
  );
}

function writeStaleCodexResult(resultsDir, id) {
  const caseDir = path.join(resultsDir, id);
  fs.mkdirSync(path.join(caseDir, 'workspace'), { recursive: true });
  fs.writeFileSync(
    path.join(caseDir, 'trace.jsonl'),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n'
  );
}

async function testParentSignal(binDir) {
  if (process.platform === 'win32') return;
  const root = path.join(scratchRoot, 'signal');
  fs.mkdirSync(root, { recursive: true });
  const activity = path.join(root, 'descendant-activity');
  const activity64 = Buffer.from(activity).toString('base64');
  const corpus = makeBehavioralCorpus(root, [
    {
      id: 'signal-case',
      skill: 'fixture-skill',
      prompt: `signal-case activity64=${activity64}`,
      max_turns: 2,
      fixture: 'signal-case',
      assertions: [{ kind: 'file_regex', path: 'artifact.txt', regex: 'fixture output', flags: '' }],
    },
    {
      id: 'must-not-start',
      skill: 'fixture-skill',
      prompt: 'success',
      max_turns: 2,
      fixture: 'must-not-start',
      assertions: [{ kind: 'file_regex', path: 'artifact.txt', regex: 'fixture output', flags: '' }],
    },
  ]);
  const resultsDir = path.join(root, 'results');
  writeStaleBehavioralResult(resultsDir, 'must-not-start');
  let sent = false;
  const run = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', resultsDir, corpus],
    baseEnv(binDir, {
      ACTIVATION_ALLOW_SPEND: '1',
      LIVE_CASE_TIMEOUT_MS: '5000',
      FAKE_WRITE_ARTIFACT: '1',
    }),
    (chunk, child) => {
      if (!sent && chunk.includes('[1/2] signal-case start')) {
        sent = true;
        setTimeout(() => child.kill('SIGTERM'), 120);
      }
    }
  );
  assert(sent, 'POSIX signal fixture never observed case start progress');
  assert(run.code === 143, `POSIX behavioral signal exited ${run.code}, expected 143`);
  assert(!run.stderr.includes('[2/2] must-not-start start'), 'runner launched a later case after interruption');
  const report = parseReport(run, 'POSIX behavioral signal');
  assert(
    report.cases[1].status === 'invalid',
    'behavioral interrupted run scored a stale later case as current'
  );
  await assertActivityStopped(activity, 'POSIX parent signal');

  const activationRoot = path.join(scratchRoot, 'activation-signal');
  fs.mkdirSync(activationRoot, { recursive: true });
  const activationActivity = path.join(activationRoot, 'descendant-activity');
  const activationActivity64 = Buffer.from(activationActivity).toString('base64');
  const activationCorpus = path.join(activationRoot, 'activation.jsonl');
  writeJsonl(activationCorpus, [
    {
      id: 'signal-case',
      prompt: `signal-case parent-default-sigterm activity64=${activationActivity64}`,
      expect_skill: 'fixture-skill',
    },
  ]);
  let activationSent = false;
  const activationRun = await runNode(
    ACTIVATION_RUNNER,
    ['--run', activationCorpus],
    baseEnv(binDir, { ACTIVATION_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '5000' }),
    (chunk, child) => {
      if (!activationSent && chunk.includes('[1/1] signal-case start')) {
        activationSent = true;
        setTimeout(() => child.kill('SIGTERM'), 120);
      }
    }
  );
  assert(activationSent, 'POSIX activation signal fixture never observed case start progress');
  assert(
    activationRun.code === 143,
    `POSIX activation signal exited ${activationRun.code}, expected 143`
  );
  retainedActivationDir(activationRun.stderr);
  await assertActivityStopped(activationActivity, 'POSIX activation parent signal');

  const codexRoot = path.join(scratchRoot, 'codex-signal');
  fs.mkdirSync(codexRoot, { recursive: true });
  const codexActivity = path.join(codexRoot, 'descendant-activity');
  const codexActivity64 = Buffer.from(codexActivity).toString('base64');
  const codexCorpus = makeCodexCorpus(codexRoot, [
    {
      id: 'signal-case',
      strictness: 'supportive',
      prompt: `signal-case parent-default-sigterm activity64=${codexActivity64}`,
    },
    { id: 'must-not-start', strictness: 'neutral', prompt: 'success' },
  ]);
  const codexResults = path.join(codexRoot, 'results');
  writeStaleCodexResult(codexResults, 'must-not-start');
  let codexSent = false;
  const codexRun = await runNode(
    findCodexRunner(),
    ['--run', codexResults, codexCorpus],
    baseEnv(binDir, { COMPLY_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '5000' }),
    (chunk, child) => {
      if (!codexSent && chunk.includes('[1/2] signal-case start')) {
        codexSent = true;
        setTimeout(() => child.kill('SIGTERM'), 120);
      }
    }
  );
  assert(codexSent, 'POSIX Codex signal fixture never observed case start progress');
  assert(codexRun.code === 143, `POSIX Codex signal exited ${codexRun.code}, expected 143`);
  assert(
    !codexRun.stderr.includes('[2/2] must-not-start start'),
    'Codex runner launched a later case after interruption'
  );
  const codexReport = parseReport(codexRun, 'POSIX Codex signal');
  assert(codexReport.cases[1].live === false, 'Codex interrupted run scored a stale later case as live');
  await assertActivityStopped(codexActivity, 'POSIX Codex parent signal');
}

function cleanup() {
  for (const child of running) terminateTree(child, true);
  for (const dir of extraCleanup) fs.rmSync(dir, { recursive: true, force: true });
  if (scratchRoot) fs.rmSync(scratchRoot, { recursive: true, force: true });
}

async function main() {
  const codexRunner = findCodexRunner();
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-runner-fixtures-'));
  const binDir = path.join(scratchRoot, 'bin');
  fakeScripts = writeFakeExecutables(binDir);
  await testPrecheckLengths(binDir);
  await testActivation(binDir);
  await testBehavioral(binDir);
  await testCodex(binDir, codexRunner);
  await testParentSignal(binDir);
  process.stdout.write('OK: live runner fixtures passed\n');
}

main()
  .catch((err) => {
    process.stderr.write(`FAIL: ${err && err.message}\n`);
    process.exitCode = 1;
  })
  .finally(cleanup);
