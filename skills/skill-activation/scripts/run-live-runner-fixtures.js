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
const TEST_PROCESS_TIMEOUT_MS = 20000;

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

function writeReorderedJson(file, value) {
  const reordered = {};
  for (const key of Object.keys(value).reverse()) reordered[key] = value[key];
  fs.writeFileSync(file, JSON.stringify(reordered, null, 2) + '\n');
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
      "  const mib = prompt.includes('truncate-stdout-large') ? 65 : 33;",
      "  process.stdout.write(Buffer.alloc(mib * 1024 * 1024, 120), () => process.exit(0));",
      "} else if (prompt.includes('timeout') || prompt.includes('signal-case')) {",
      "  emit();",
      "  if (activity) {",
      "    const code = \"const fs=require('fs');const p=process.argv[1];process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(p,'x'),20);\";",
      "    spawn(process.execPath, ['-e', code, activity], { stdio: 'ignore' });",
      "  }",
      "  if (prompt.includes('parent-clean-sigterm')) process.on('SIGTERM', () => process.exit(0));",
      "  else if (!prompt.includes('parent-default-sigterm')) process.on('SIGTERM', () => {});",
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

  const whitespaceRoot = path.join(scratchRoot, 'precheck-schema-whitespace');
  writeSkillFixture(whitespaceRoot, 'whitespace-limit', ` ${makeDescription(1024)}`);
  const whitespaceRun = await runNode(
    ACTIVATION_RUNNER,
    ['--precheck', whitespaceRoot],
    baseEnv(binDir)
  );
  const whitespaceReport = parseReport(whitespaceRun, 'precheck whitespace maximum');
  assert(
    whitespaceRun.code === 1 &&
      whitespaceReport.skills[0].desc_chars === 1025 &&
      whitespaceReport.skills[0].description_length_ok === false,
    'leading whitespace hid a decoded description over the schema maximum'
  );
}

async function testAgentSchema(binDir) {
  const root = path.join(scratchRoot, 'precheck-agent-schema');
  const cases = [
    {
      name: 'bad-pair',
      model: 'haiku',
      effort: 'xhigh',
      tools: 'Read, Grep, Glob',
    },
    {
      name: 'bad-tool',
      model: 'sonnet',
      effort: 'high',
      tools: 'Read, UnknownTool',
    },
  ];
  fs.mkdirSync(root, { recursive: true });
  for (const agent of cases) {
    fs.writeFileSync(
      path.join(root, `${agent.name}.md`),
      [
        '---',
        `name: ${agent.name}`,
        'description: Use when testing invalid agent schemas.',
        `model: ${agent.model}`,
        `effort: ${agent.effort}`,
        `tools: ${agent.tools}`,
        '---',
        '',
        'Test agent.',
        '',
      ].join('\n')
    );
  }
  const run = await runNode(
    ACTIVATION_RUNNER,
    ['--precheck-agents', root],
    baseEnv(binDir)
  );
  const report = parseReport(run, 'precheck agent schema');
  assert(run.code === 1, `invalid agent schemas exited ${run.code}, expected 1`);
  assert(report.schema_issue_count === 2, 'invalid agent schemas did not both count');
  assert(
    report.agents.find((agent) => agent.agent === 'bad-pair').model_effort_ok === false,
    'invalid model/effort pair passed'
  );
  const badTool = report.agents.find((agent) => agent.agent === 'bad-tool');
  assert(
    badTool.tool_vocabulary_ok === false &&
      badTool.unknown_tools.length === 1 &&
      badTool.unknown_tools[0] === 'UnknownTool',
    'unknown agent tool passed'
  );
}

async function testQuotedScalarEscapes(binDir) {
  const invalidDescription = 'description: "Use ' + '\\' + 'q when testing"';
  const validDescription = 'description: "Use ' + '\\' + 'e when testing"';
  const validDecoded = 'Use \u001b when testing';

  const skillsRoot = path.join(scratchRoot, 'precheck-scalar-escapes');
  for (const [name, description] of [
    ['invalid-escape', invalidDescription],
    ['valid-escape', validDescription],
  ]) {
    const skillDir = path.join(skillsRoot, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      ['---', `name: ${name}`, description, '---', '', `# ${name}`, ''].join('\n')
    );
  }
  const skillRun = await runNode(
    ACTIVATION_RUNNER,
    ['--precheck', skillsRoot],
    baseEnv(binDir)
  );
  const skillReport = parseReport(skillRun, 'precheck skill scalar escapes');
  assert(skillRun.code === 1, `invalid skill escape exited ${skillRun.code}, expected 1`);
  assert(skillReport.schema_issue_count === 1, 'invalid skill escape was not isolated');
  assert(
    skillReport.skills.find((skill) => skill.skill === 'invalid-escape')
      .frontmatter_invalid_yaml === true,
    'invalid skill escape passed'
  );
  const validSkill = skillReport.skills.find((skill) => skill.skill === 'valid-escape');
  assert(
    validSkill.frontmatter_invalid_yaml === false &&
      validSkill.desc_chars === validDecoded.length,
    'valid YAML skill escape was rejected or decoded incorrectly'
  );

  const agentsRoot = path.join(scratchRoot, 'precheck-agent-scalar-escapes');
  fs.mkdirSync(agentsRoot, { recursive: true });
  for (const [name, description] of [
    ['invalid-escape', invalidDescription],
    ['valid-escape', validDescription],
  ]) {
    fs.writeFileSync(
      path.join(agentsRoot, `${name}.md`),
      [
        '---',
        `name: ${name}`,
        description,
        'model: fable',
        'effort: xhigh',
        'tools: Read',
        '---',
        '',
        'Test agent.',
        '',
      ].join('\n')
    );
  }
  const agentRun = await runNode(
    ACTIVATION_RUNNER,
    ['--precheck-agents', agentsRoot],
    baseEnv(binDir)
  );
  const agentReport = parseReport(agentRun, 'precheck agent scalar escapes');
  assert(agentRun.code === 1, `invalid agent escape exited ${agentRun.code}, expected 1`);
  assert(agentReport.schema_issue_count === 1, 'invalid agent escape was not isolated');
  assert(
    agentReport.agents.find((agent) => agent.agent === 'invalid-escape')
      .frontmatter_invalid_yaml === true,
    'invalid agent escape passed'
  );
  const validAgent = agentReport.agents.find((agent) => agent.agent === 'valid-escape');
  assert(
    validAgent.frontmatter_invalid_yaml === false &&
      validAgent.description_chars === validDecoded.length,
    'valid YAML agent escape was rejected or decoded incorrectly'
  );
}

async function testTimeoutMaximum(binDir) {
  const root = path.join(scratchRoot, 'timeout-maximum');
  fs.mkdirSync(root, { recursive: true });
  const activationCorpus = path.join(root, 'activation.jsonl');
  writeJsonl(activationCorpus, [
    { id: 'must-not-start', prompt: 'success', expect_skill: 'fixture-skill' },
  ]);
  const behavioralCorpus = makeBehavioralCorpus(root, [
    {
      id: 'must-not-start',
      skill: 'fixture-skill',
      prompt: 'success',
      max_turns: 2,
      fixture: 'must-not-start',
      assertions: [],
    },
  ]);
  const codexCorpus = makeCodexCorpus(root, [
    { id: 'must-not-start', strictness: 'supportive', prompt: 'success' },
  ]);
  const cases = [
    {
      label: 'activation',
      runner: ACTIVATION_RUNNER,
      args: ['--run', activationCorpus],
      gate: { ACTIVATION_ALLOW_SPEND: '1' },
    },
    {
      label: 'behavioral',
      runner: BEHAVIORAL_RUNNER,
      args: ['--run', path.join(root, 'behavioral-results'), behavioralCorpus],
      gate: { ACTIVATION_ALLOW_SPEND: '1' },
    },
    {
      label: 'Codex',
      runner: findCodexRunner(),
      args: ['--run', path.join(root, 'codex-results'), codexCorpus],
      gate: { COMPLY_ALLOW_SPEND: '1' },
    },
  ];
  for (const entry of cases) {
    const marker = path.join(root, `${entry.label}-spawned`);
    const run = await runNode(
      entry.runner,
      entry.args,
      baseEnv(binDir, {
        ...entry.gate,
        LIVE_CASE_TIMEOUT_MS: '2147483648',
        FAKE_SPAWN_MARKER: marker,
      })
    );
    assert(run.code !== 0, `${entry.label} accepted a timeout above Node's timer limit`);
    assert(!fs.existsSync(marker), `${entry.label} spawned before rejecting an over-limit timeout`);
  }
}

async function testMalformedInstalledToml(binDir) {
  const root = path.join(scratchRoot, 'precheck-agent-toml');
  const agentsDir = path.join(root, 'agents');
  const installedHome = path.join(root, 'installed');
  const description = 'Use when testing malformed installed output.';
  const source = [
    '---',
    'name: malformed-render',
    `description: ${description}`,
    'model: fable',
    'effort: xhigh',
    'tools: Read',
    '---',
    '',
    'Inspect malformed installed output.',
    '',
  ].join('\n');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'malformed-render.md'), source);
  for (const relative of [
    path.join('.claude', 'agents', 'malformed-render.md'),
    path.join('.copilot', 'agents', 'malformed-render.agent.md'),
  ]) {
    const installed = path.join(installedHome, relative);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, source);
  }
  const codexAgent = path.join(installedHome, '.codex', 'agents', 'malformed-render.toml');
  fs.mkdirSync(path.dirname(codexAgent), { recursive: true });
  fs.writeFileSync(codexAgent, `description = "${'\\!'.repeat(40)}\n`);

  const run = await runNode(
    ACTIVATION_RUNNER,
    ['--precheck-agents', agentsDir, installedHome],
    baseEnv(binDir)
  );
  const report = parseReport(run, 'precheck malformed installed TOML');
  assert(run.code === 1, `malformed installed TOML exited ${run.code}, expected 1`);
  assert(report.schema_issue_count === 1, 'malformed installed TOML was not a schema mismatch');
  assert(
    report.agents[0].claude_description_matches === true &&
      report.agents[0].copilot_description_matches === true &&
      report.agents[0].codex_description_matches === false,
    'malformed installed TOML did not isolate the Codex renderer mismatch'
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
    PATH: [binDir, process.env.PATH].filter(Boolean).join(path.delimiter),
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
  writeReorderedJson(slowMetaPath, slowMeta);
  const reorderedCheck = await runNode(
    ACTIVATION_RUNNER,
    ['--check', slowResults, slowCorpus],
    baseEnv(binDir, {})
  );
  assert(
    reorderedCheck.code === 0 &&
      parseReport(reorderedCheck, 'activation reordered metadata check').passed === 1,
    'activation check treated metadata key order as semantic'
  );
  const invalidMeta = { ...slowMeta, unexpected: true };
  delete invalidMeta.duration_ms;
  fs.writeFileSync(slowMetaPath, JSON.stringify(invalidMeta, null, 2) + '\n');
  const invalidCheck = await runNode(
    ACTIVATION_RUNNER,
    ['--check', slowResults, slowCorpus],
    baseEnv(binDir, {})
  );
  assert(
    invalidCheck.code === 1 &&
      parseReport(invalidCheck, 'activation invalid metadata check').passed === 0,
    'activation check accepted a missing key replaced by an unknown key'
  );
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

  const truncatedRoot = path.join(root, 'truncated');
  fs.mkdirSync(truncatedRoot, { recursive: true });
  const truncatedCorpus = path.join(truncatedRoot, 'truncated.jsonl');
  writeJsonl(truncatedCorpus, [
    {
      id: 'truncated-case',
      prompt: 'truncate-stdout-large',
      expect_skill: 'fixture-skill',
    },
  ]);
  const truncated = await runNode(
    ACTIVATION_RUNNER,
    ['--run', truncatedCorpus],
    baseEnv(binDir, { ACTIVATION_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '10000' })
  );
  const truncatedReport = parseReport(truncated, 'activation truncated stdout');
  const truncatedResults = retainedActivationDir(truncated.stderr);
  const truncatedMeta = JSON.parse(
    fs.readFileSync(path.join(truncatedResults, 'truncated-case.meta.json'), 'utf8')
  );
  assert(
    truncated.code === 1 &&
      truncatedReport.passed === 0 &&
      truncatedMeta.stdout_truncated === true,
    'activation truncated stdout did not fail with metadata'
  );
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
  const slowMetaPath = path.join(results, 'slow-success.meta.json');
  const slowMeta = JSON.parse(fs.readFileSync(slowMetaPath, 'utf8'));
  writeReorderedJson(slowMetaPath, slowMeta);
  const reorderedCheck = await runNode(
    BEHAVIORAL_RUNNER,
    ['--check', results, corpus],
    baseEnv(binDir, {})
  );
  assert(
    reorderedCheck.code === 0 &&
      parseReport(reorderedCheck, 'behavioral reordered metadata check').passed === 1,
    'behavioral check treated metadata key order as semantic'
  );
  const invalidMeta = { ...slowMeta, unexpected: true };
  delete invalidMeta.duration_ms;
  fs.writeFileSync(slowMetaPath, JSON.stringify(invalidMeta, null, 2) + '\n');
  const invalidCheck = await runNode(
    BEHAVIORAL_RUNNER,
    ['--check', results, corpus],
    baseEnv(binDir, {})
  );
  assert(
    invalidCheck.code === 1 &&
      parseReport(invalidCheck, 'behavioral invalid metadata check').invalid === 1,
    'behavioral check accepted a missing key replaced by an unknown key'
  );
  fs.rmSync(slowMetaPath);
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

  const truncatedRoot = path.join(root, 'truncated');
  fs.mkdirSync(truncatedRoot, { recursive: true });
  const truncatedCorpus = makeBehavioralCorpus(truncatedRoot, [
    {
      id: 'truncated-case',
      skill: 'fixture-skill',
      prompt: 'truncate-stdout-large',
      max_turns: 2,
      fixture: 'truncated-case',
      assertions: [{ kind: 'file_regex', path: 'artifact.txt', regex: 'fixture output', flags: '' }],
    },
  ]);
  const truncatedResults = path.join(truncatedRoot, 'results');
  const truncated = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', truncatedResults, truncatedCorpus],
    baseEnv(binDir, {
      ACTIVATION_ALLOW_SPEND: '1',
      LIVE_CASE_TIMEOUT_MS: '10000',
      FAKE_WRITE_ARTIFACT: '1',
    })
  );
  const truncatedReport = parseReport(truncated, 'behavioral truncated stdout');
  const truncatedMeta = JSON.parse(
    fs.readFileSync(path.join(truncatedResults, 'truncated-case.meta.json'), 'utf8')
  );
  assert(
    truncated.code === 1 &&
      truncatedReport.invalid === 1 &&
      truncatedMeta.stdout_truncated === true,
    'behavioral truncated stdout did not fail as invalid with metadata'
  );
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
  const cleanMetaPath = path.join(results, 'after-failure', 'meta.json');
  const cleanMeta = JSON.parse(fs.readFileSync(cleanMetaPath, 'utf8'));
  writeReorderedJson(cleanMetaPath, cleanMeta);
  const reorderedCheck = await runNode(
    codexRunner,
    ['--check', results, corpus],
    baseEnv(binDir, {})
  );
  const reorderedReport = parseReport(reorderedCheck, 'Codex reordered metadata check');
  assert(
    reorderedCheck.code === 1 && reorderedReport.cases[1].live === true,
    'Codex check treated metadata key order as semantic'
  );
  const invalidMeta = { ...cleanMeta, unexpected: true };
  delete invalidMeta.duration_ms;
  fs.writeFileSync(cleanMetaPath, JSON.stringify(invalidMeta, null, 2) + '\n');
  const invalidCheck = await runNode(
    codexRunner,
    ['--check', results, corpus],
    baseEnv(binDir, {})
  );
  assert(
    invalidCheck.code === 1 && invalidCheck.stderr.includes('after-failure: invalid meta.json'),
    'Codex check accepted a missing key replaced by an unknown key'
  );
  fs.writeFileSync(cleanMetaPath, 'null\n');
  const nullCheck = await runNode(
    codexRunner,
    ['--check', results, corpus],
    baseEnv(binDir, {})
  );
  assert(
    nullCheck.code === 1 && nullCheck.stderr.includes('after-failure: invalid meta.json'),
    'Codex check treated present null metadata as a missing legacy file'
  );
  fs.rmSync(cleanMetaPath);
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
      prompt: `signal-case parent-clean-sigterm activity64=${activity64}`,
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
    report.cases[0].status === 'invalid' &&
      report.cases[0].reason === 'live run interrupted' &&
    report.cases[1].status === 'invalid',
    'behavioral interrupted run scored an attempted or stale case as current'
  );
  const behavioralMeta = JSON.parse(
    fs.readFileSync(path.join(resultsDir, 'signal-case.meta.json'), 'utf8')
  );
  assert(
    behavioralMeta.exit_code === 0 && behavioralMeta.interrupted === true,
    'behavioral runner did not persist a clean-exit parent interruption'
  );
  const behavioralCheck = await runNode(
    BEHAVIORAL_RUNNER,
    ['--check', resultsDir, corpus],
    baseEnv(binDir, {})
  );
  assert(
    behavioralCheck.code === 1 &&
      parseReport(behavioralCheck, 'POSIX behavioral interrupted check').cases[0].status ===
        'invalid',
    'behavioral check accepted persisted interrupted metadata'
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
      prompt: `signal-case parent-clean-sigterm activity64=${activationActivity64}`,
      expect_skill: 'fixture-skill',
    },
    {
      id: 'must-not-start',
      prompt: 'success',
      expect_skill: 'fixture-skill',
    },
  ]);
  let activationSent = false;
  const activationRun = await runNode(
    ACTIVATION_RUNNER,
    ['--run', activationCorpus],
    baseEnv(binDir, { ACTIVATION_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '5000' }),
    (chunk, child) => {
      if (!activationSent && chunk.includes('[1/2] signal-case start')) {
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
  assert(
    !activationRun.stderr.includes('[2/2] must-not-start start'),
    'activation runner launched a later case after interruption'
  );
  const activationReport = parseReport(activationRun, 'POSIX activation signal');
  assert(
    activationReport.total === 2 &&
      activationReport.passed === 0 &&
      activationReport.cases[1].reason === 'interrupted before start',
    'activation interrupted run omitted or passed an unstarted case'
  );
  const activationResults = retainedActivationDir(activationRun.stderr);
  const activationMeta = JSON.parse(
    fs.readFileSync(path.join(activationResults, 'signal-case.meta.json'), 'utf8')
  );
  assert(
    activationMeta.exit_code === 0 && activationMeta.interrupted === true,
    'activation runner did not persist a clean-exit parent interruption'
  );
  const activationCheck = await runNode(
    ACTIVATION_RUNNER,
    ['--check', activationResults, activationCorpus],
    baseEnv(binDir, {})
  );
  assert(
    activationCheck.code === 1 &&
      parseReport(activationCheck, 'POSIX activation interrupted check').passed === 0,
    'activation check accepted persisted interrupted metadata'
  );
  await assertActivityStopped(activationActivity, 'POSIX activation parent signal');

  const codexRoot = path.join(scratchRoot, 'codex-signal');
  fs.mkdirSync(codexRoot, { recursive: true });
  const codexActivity = path.join(codexRoot, 'descendant-activity');
  const codexActivity64 = Buffer.from(codexActivity).toString('base64');
  const codexCorpus = makeCodexCorpus(codexRoot, [
    {
      id: 'signal-case',
      strictness: 'supportive',
      prompt: `signal-case parent-clean-sigterm activity64=${codexActivity64}`,
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
  assert(
    codexReport.cases[0].live === false &&
      codexReport.cases[0].interrupted === true &&
      codexReport.cases[1].live === false,
    'Codex interrupted run scored an attempted or stale case as live'
  );
  const codexMeta = JSON.parse(
    fs.readFileSync(path.join(codexResults, 'signal-case', 'meta.json'), 'utf8')
  );
  assert(
    codexMeta.exit_code === 0 && codexMeta.interrupted === true,
    'Codex runner did not persist a clean-exit parent interruption'
  );
  const codexCheck = await runNode(
    findCodexRunner(),
    ['--check', codexResults, codexCorpus],
    baseEnv(binDir, {})
  );
  assert(
    codexCheck.code === 1 &&
      parseReport(codexCheck, 'POSIX Codex interrupted check').cases[0].live === false,
    'Codex check accepted persisted interrupted metadata'
  );
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
  await testAgentSchema(binDir);
  await testQuotedScalarEscapes(binDir);
  await testTimeoutMaximum(binDir);
  await testMalformedInstalledToml(binDir);
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
