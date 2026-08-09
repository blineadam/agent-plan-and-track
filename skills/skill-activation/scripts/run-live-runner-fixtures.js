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
      "if (process.env.FAKE_ARGV_MARKER) fs.writeFileSync(process.env.FAKE_ARGV_MARKER, JSON.stringify(args));",
      "const activityMatch = /activity64=([A-Za-z0-9+/=]+)/.exec(prompt);",
      "const activity = activityMatch ? Buffer.from(activityMatch[1], 'base64').toString('utf8') : '';",
      "const emitClaude = () => {",
      "  const content = [{type:'tool_use',name:'Skill',input:{skill:'fixture-skill'}}];",
      "  if (prompt.includes('dispatch2')) {",
      "    content.push({type:'tool_use',id:'d1',name:'Task',input:{}});",
      "    content.push({type:'tool_use',id:'d1',name:'Task',input:{}});",
      "    content.push({type:'tool_use',id:'d2',name:'Agent',input:{}});",
      "  }",
      "  if (prompt.includes('risk-line')) {",
      "    content.push({type:'text',text:'Risk: high (concurrency)'});",
      "  }",
      "  process.stdout.write(JSON.stringify({type:'assistant',message:{content}}) + '\\n');",
      "  const resultEvent = {type:'result',subtype:'success',is_error:false,num_turns:1,total_cost_usd:0.01};",
      "  if (prompt.includes('risk-line')) resultEvent.result = 'final-answer-marker';",
      "  process.stdout.write(JSON.stringify(resultEvent) + '\\n');",
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
  // Both agents now carry an issue: \q is invalid YAML AND uninstallable;
  // \e is valid YAML (decodes to the right length) but is still uninstallable,
  // since the installers only know how to render \" and \\. Pinning each flag
  // separately below is what actually proves that distinction, not the count.
  assert(agentReport.schema_issue_count === 2, 'agent scalar-escape issue count drifted from the expected 2');
  const invalidAgent = agentReport.agents.find((agent) => agent.agent === 'invalid-escape');
  assert(
    invalidAgent.frontmatter_invalid_yaml === true,
    'invalid agent escape: frontmatter_invalid_yaml should be true'
  );
  assert(
    invalidAgent.frontmatter_uninstallable_escape === true,
    'invalid agent escape: frontmatter_uninstallable_escape should be true'
  );
  const validAgent = agentReport.agents.find((agent) => agent.agent === 'valid-escape');
  assert(
    validAgent.frontmatter_invalid_yaml === false,
    'valid YAML agent escape: frontmatter_invalid_yaml should be false'
  );
  assert(
    validAgent.frontmatter_uninstallable_escape === true,
    'valid YAML agent escape: frontmatter_uninstallable_escape should be true (installers cannot render \\e)'
  );
  assert(
    validAgent.description_chars === validDecoded.length,
    'valid YAML agent escape decoded to the wrong length'
  );
}

// agents/*.md only: a double-quoted description whose backslash escapes
// something the installers cannot decode (frontmatter_field/decode_dq only
// know \" and \\) is valid YAML that would still abort ./install.sh, so
// --precheck-agents must flag it even when frontmatter_invalid_yaml does not.
async function testAgentUninstallableEscape(binDir) {
  const root = path.join(scratchRoot, 'precheck-agent-uninstallable-escape');
  fs.mkdirSync(root, { recursive: true });
  const mustFlag = {
    'tab-escape': 'description: "Use \\t when testing a tab escape"',
    'newline-escape': 'description: "Use \\n when testing a newline escape"',
    'unicode-escape': 'description: "Use \\u00e9 when testing a unicode escape"',
    'trailing-backslash': 'description: "Use this when testing a trailing backslash\\"',
  };
  const mustNotFlag = {
    'escaped-quote': 'description: "Use \\"quoted\\" wording when testing an escaped quote"',
    'escaped-backslash': 'description: "Use a backslash \\\\ when testing an escaped backslash"',
    'escaped-backslash-then-t':
      'description: "Use a\\\\tb when testing an escaped backslash before a literal t"',
    'plain-value': 'description: Use a plain unquoted value when testing',
    'single-quoted': "description: 'Use it''s escaped quote when testing single quotes'",
  };
  for (const [name, descriptionLine] of Object.entries({ ...mustFlag, ...mustNotFlag })) {
    fs.writeFileSync(
      path.join(root, `${name}.md`),
      [
        '---',
        `name: ${name}`,
        descriptionLine,
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
  const run = await runNode(ACTIVATION_RUNNER, ['--precheck-agents', root], baseEnv(binDir));
  const report = parseReport(run, 'precheck agent uninstallable escape');
  for (const name of Object.keys(mustFlag)) {
    const agent = report.agents.find((a) => a.agent === name);
    assert(
      agent && agent.frontmatter_uninstallable_escape === true,
      `uninstallable escape case '${name}' was not flagged`
    );
  }
  for (const name of Object.keys(mustNotFlag)) {
    const agent = report.agents.find((a) => a.agent === name);
    assert(
      agent && agent.frontmatter_uninstallable_escape === false,
      `installable escape case '${name}' was incorrectly flagged`
    );
  }
  assert(run.code === 1, `agent uninstallable escapes exited ${run.code}, expected 1`);
}

async function testPlainScalarIndicators(binDir) {
  const invalidCases = [
    ['leading-bracket', '[oops] use this when testing plain scalar indicators'],
    ['leading-asterisk', '*oops use this when testing plain scalar indicators'],
    ['bare-dash', '-'],
    ['leading-dash-space', '- oops use this when testing plain scalar indicators'],
    ['trailing-colon', 'Use this when testing plain scalar indicators oops:'],
    ['mid-value-hash', 'Use this when testing plain scalar indicators oops #comment'],
  ];
  const validCases = [
    ['leading-dash-word', '-foo use this when testing plain scalar indicators'],
    ['mid-value-url', 'Use this when testing http://example.com plain scalar indicators'],
    ['mid-value-hash-no-space', 'Use this when testing foo#bar plain scalar indicators'],
    ['mid-value-comma-bracket', 'Use this when testing foo, bar] plain scalar indicators'],
  ];

  const root = path.join(scratchRoot, 'precheck-plain-scalar-indicators');
  for (const [name, description] of [...invalidCases, ...validCases]) {
    const skillDir = path.join(root, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      ['---', `name: ${name}`, `description: ${description}`, '---', '', `# ${name}`, ''].join(
        '\n'
      )
    );
  }
  const run = await runNode(ACTIVATION_RUNNER, ['--precheck', root], baseEnv(binDir));
  const report = parseReport(run, 'precheck plain scalar indicators');
  assert(run.code === 1, `plain scalar indicator cases exited ${run.code}, expected 1`);
  assert(
    report.schema_issue_count === invalidCases.length,
    `plain scalar indicator invalid cases were not all flagged (schema_issue_count=${report.schema_issue_count})`
  );
  for (const [name] of invalidCases) {
    assert(
      report.skills.find((skill) => skill.skill === name).frontmatter_invalid_yaml === true,
      `${name} was not flagged as invalid frontmatter`
    );
  }
  for (const [name] of validCases) {
    assert(
      report.skills.find((skill) => skill.skill === name).frontmatter_invalid_yaml === false,
      `${name} was incorrectly flagged as invalid frontmatter`
    );
  }
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

async function testActivationPermissionMode(binDir) {
  const root = path.join(scratchRoot, 'activation-permission-mode');
  fs.mkdirSync(root, { recursive: true });
  const corpus = path.join(root, 'permission-mode.jsonl');
  writeJsonl(corpus, [
    { id: 'permission-mode-case', prompt: 'success', expect_skill: 'fixture-skill' },
  ]);
  const argvFile = path.join(root, 'argv.json');
  const run = await runNode(
    ACTIVATION_RUNNER,
    ['--run', corpus],
    baseEnv(binDir, {
      ACTIVATION_ALLOW_SPEND: '1',
      LIVE_CASE_TIMEOUT_MS: '2000',
      FAKE_ARGV_MARKER: argvFile,
    })
  );
  const report = parseReport(run, 'activation permission mode');
  assert(run.code === 0 && report.passed === 1, 'activation permission mode case did not pass');
  const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  const modeIndex = argv.indexOf('--permission-mode');
  assert(
    modeIndex !== -1 && argv[modeIndex + 1] === 'default',
    `--permission-mode default did not reach the child argv: ${JSON.stringify(argv)}`
  );
  assert(
    !argv.includes('--dangerously-skip-permissions'),
    `--dangerously-skip-permissions must never reach the child argv: ${JSON.stringify(argv)}`
  );
  assert(
    argv.indexOf('--permission-mode') === argv.lastIndexOf('--permission-mode'),
    `--permission-mode must appear exactly once in the child argv: ${JSON.stringify(argv)}`
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

async function testBehavioralAssertionsAndSetup(binDir) {
  const root = path.join(scratchRoot, 'behavioral-assertions');
  fs.mkdirSync(root, { recursive: true });

  // --- 1: dispatch + response pass, two cases exercising both assistant-text
  // sources (a `text` block and the terminal result's `result` string). ------
  const passRoot = path.join(root, 'pass');
  fs.mkdirSync(passRoot, { recursive: true });
  const passCorpus = makeBehavioralCorpus(passRoot, [
    {
      id: 'dispatch-response-pass',
      skill: 'fixture-skill',
      prompt: 'dispatch2 risk-line',
      max_turns: 2,
      fixture: 'dispatch-response-pass',
      assertions: [
        { kind: 'trace_agent_dispatch_count', min: 2, max: 4 },
        { kind: 'response_regex', regex: 'Risk: high' },
      ],
    },
    {
      id: 'result-text-pass',
      skill: 'fixture-skill',
      prompt: 'risk-line',
      max_turns: 2,
      fixture: 'result-text-pass',
      assertions: [{ kind: 'response_regex', regex: 'final-answer-marker' }],
    },
  ]);
  const passResults = path.join(passRoot, 'results');
  const passRun = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', passResults, passCorpus],
    baseEnv(binDir, { ACTIVATION_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '2000' })
  );
  const passReport = parseReport(passRun, 'behavioral assertion pass');
  assert(
    passRun.code === 0 && passReport.passed === 2,
    'dispatch-count and response-regex assertions did not both pass'
  );

  // --- 2: dispatch fail: same corpus shape, no dispatch2 in the prompt. ------
  const failRoot = path.join(root, 'fail');
  fs.mkdirSync(failRoot, { recursive: true });
  const failCorpus = makeBehavioralCorpus(failRoot, [
    {
      id: 'dispatch-fail',
      skill: 'fixture-skill',
      prompt: 'risk-line',
      max_turns: 2,
      fixture: 'dispatch-fail',
      assertions: [{ kind: 'trace_agent_dispatch_count', min: 2, max: 4 }],
    },
  ]);
  const failResults = path.join(failRoot, 'results');
  const failRun = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', failResults, failCorpus],
    baseEnv(binDir, { ACTIVATION_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '2000' })
  );
  const failReport = parseReport(failRun, 'behavioral dispatch-count fail');
  assert(failRun.code === 1, 'a missing dispatch did not fail the runner');
  assert(
    failReport.cases[0].status === 'fail' && failReport.cases[0].reason.includes('0 subagent dispatches'),
    'dispatch-count fail reason did not name the observed count'
  );

  // --- 3: setup success: setup writes seeded.txt in the case dir before the
  // agent spawns. --------------------------------------------------------------
  const setupOkRoot = path.join(root, 'setup-ok');
  fs.mkdirSync(setupOkRoot, { recursive: true });
  const setupOkCorpus = makeBehavioralCorpus(setupOkRoot, [
    {
      id: 'setup-success',
      skill: 'fixture-skill',
      prompt: 'success',
      max_turns: 2,
      fixture: 'setup-success',
      setup: 'seed-ok.setup.js',
      assertions: [{ kind: 'file_regex', path: 'seeded.txt', regex: 'seeded-ok' }],
    },
  ]);
  fs.writeFileSync(
    path.join(setupOkRoot, 'behavioral', 'seed-ok.setup.js'),
    "'use strict';\nrequire('fs').writeFileSync('seeded.txt', 'seeded-ok\\n');\n"
  );
  const setupOkResults = path.join(setupOkRoot, 'results');
  const setupOkRun = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', setupOkResults, setupOkCorpus],
    baseEnv(binDir, { ACTIVATION_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '2000' })
  );
  const setupOkReport = parseReport(setupOkRun, 'behavioral setup success');
  assert(
    setupOkRun.code === 0 && setupOkReport.passed === 1,
    'a setup script that seeds a file did not let its case pass'
  );

  // --- 4: setup failure: setup exits 7, case invalid, no agent spawn. --------
  const setupFailRoot = path.join(root, 'setup-fail');
  fs.mkdirSync(setupFailRoot, { recursive: true });
  const setupFailCorpus = makeBehavioralCorpus(setupFailRoot, [
    {
      id: 'setup-failure',
      skill: 'fixture-skill',
      prompt: 'success',
      max_turns: 2,
      fixture: 'setup-failure',
      setup: 'seed-fail.setup.js',
      assertions: [{ kind: 'file_regex', path: 'seeded.txt', regex: 'seeded-ok' }],
    },
  ]);
  fs.writeFileSync(path.join(setupFailRoot, 'behavioral', 'seed-fail.setup.js'), 'process.exit(7);\n');
  const setupFailResults = path.join(setupFailRoot, 'results');
  const setupFailMarker = path.join(setupFailRoot, 'spawned');
  const setupFailRun = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', setupFailResults, setupFailCorpus],
    baseEnv(binDir, {
      ACTIVATION_ALLOW_SPEND: '1',
      LIVE_CASE_TIMEOUT_MS: '2000',
      FAKE_SPAWN_MARKER: setupFailMarker,
    })
  );
  const setupFailReport = parseReport(setupFailRun, 'behavioral setup failure');
  assert(setupFailRun.code === 1, 'a failing setup script did not fail the runner');
  assert(
    setupFailReport.cases[0].status === 'invalid',
    'a failing setup script did not invalidate its case'
  );
  const setupFailMeta = JSON.parse(
    fs.readFileSync(path.join(setupFailResults, 'setup-failure.setup.meta.json'), 'utf8')
  );
  assert(setupFailMeta.exit_code === 7, 'setup failure metadata did not record exit_code 7');
  assert(!fs.existsSync(setupFailMarker), 'a broken setup did not suppress the agent spawn');

  // --- 5: setup timeout + orphaned descendant. --------------------------------
  const setupTimeoutRoot = path.join(root, 'setup-timeout');
  fs.mkdirSync(setupTimeoutRoot, { recursive: true });
  const setupTimeoutCorpus = makeBehavioralCorpus(setupTimeoutRoot, [
    {
      id: 'setup-timeout',
      skill: 'fixture-skill',
      prompt: 'success',
      max_turns: 2,
      fixture: 'setup-timeout',
      setup: 'hang.setup.js',
      assertions: [{ kind: 'file_regex', path: 'seeded.txt', regex: 'seeded-ok' }],
    },
  ]);
  fs.writeFileSync(
    path.join(setupTimeoutRoot, 'behavioral', 'hang.setup.js'),
    [
      "'use strict';",
      "const { spawn } = require('child_process');",
      "const code = \"const fs=require('fs');const p=process.argv[1];setInterval(()=>fs.appendFileSync(p,'x'),20);\";",
      "spawn(process.execPath, ['-e', code, 'descendant-activity'], { stdio: 'ignore' });",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n')
  );
  const setupTimeoutResults = path.join(setupTimeoutRoot, 'results');
  const setupTimeoutMarker = path.join(setupTimeoutRoot, 'spawned');
  const setupTimeoutRun = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', setupTimeoutResults, setupTimeoutCorpus],
    baseEnv(binDir, {
      ACTIVATION_ALLOW_SPEND: '1',
      LIVE_CASE_TIMEOUT_MS: '200',
      FAKE_SPAWN_MARKER: setupTimeoutMarker,
    })
  );
  const setupTimeoutReport = parseReport(setupTimeoutRun, 'behavioral setup timeout');
  assert(
    setupTimeoutRun.code === 1 && setupTimeoutReport.cases[0].status === 'invalid',
    'a hung setup script did not invalidate its case'
  );
  const setupTimeoutMeta = JSON.parse(
    fs.readFileSync(path.join(setupTimeoutResults, 'setup-timeout.setup.meta.json'), 'utf8')
  );
  assert(setupTimeoutMeta.timed_out === true, 'setup timeout metadata did not record timed_out');
  assert(!fs.existsSync(setupTimeoutMarker), 'a hung setup did not suppress the agent spawn');
  await assertActivityStopped(
    path.join(setupTimeoutResults, 'setup-timeout', 'descendant-activity'),
    'behavioral setup timeout'
  );

  // --- 6: roster preflight: no .claude/agents blocks up front, then a seeded
  // roster lets the case be attempted. -----------------------------------------
  const rosterRoot = path.join(root, 'roster');
  fs.mkdirSync(rosterRoot, { recursive: true });
  const rosterCorpus = makeBehavioralCorpus(rosterRoot, [
    {
      id: 'roster-case',
      skill: 'fixture-skill',
      prompt: 'dispatch2',
      max_turns: 2,
      fixture: 'roster-case',
      assertions: [{ kind: 'trace_agent_dispatch_count', min: 1 }],
    },
  ]);
  const noRosterHome = path.join(rosterRoot, 'home');
  fs.mkdirSync(noRosterHome, { recursive: true });
  const noRosterMarker = path.join(rosterRoot, 'no-roster-spawned');
  const noRosterRun = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', path.join(rosterRoot, 'no-roster-results'), rosterCorpus],
    baseEnv(binDir, {
      ACTIVATION_ALLOW_SPEND: '1',
      LIVE_CASE_TIMEOUT_MS: '2000',
      FAKE_SPAWN_MARKER: noRosterMarker,
      HOME: noRosterHome,
      USERPROFILE: noRosterHome,
    })
  );
  assert(noRosterRun.code !== 0, 'a dispatch-count assertion ran without an installed roster');
  assert(!fs.existsSync(noRosterMarker), 'a missing roster did not suppress the agent spawn');

  // An unrelated agent is not enough: the preflight names the reviewer-capable
  // entries the dispatch assertion actually depends on, so a stale or partial
  // roster must still block rather than buy a billable run that then fails its
  // assertion for the wrong reason.
  const rosterAgentsDir = path.join(noRosterHome, '.claude', 'agents');
  fs.mkdirSync(rosterAgentsDir, { recursive: true });
  fs.writeFileSync(path.join(rosterAgentsDir, 'planner.md'), '# planner\n');
  const partialRosterMarker = path.join(rosterRoot, 'partial-roster-spawned');
  const partialRosterRun = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', path.join(rosterRoot, 'partial-roster-results'), rosterCorpus],
    baseEnv(binDir, {
      ACTIVATION_ALLOW_SPEND: '1',
      LIVE_CASE_TIMEOUT_MS: '2000',
      FAKE_SPAWN_MARKER: partialRosterMarker,
      HOME: noRosterHome,
      USERPROFILE: noRosterHome,
    })
  );
  assert(
    partialRosterRun.code !== 0,
    'a roster missing the reviewer entries did not block the dispatch-count case'
  );
  assert(
    !fs.existsSync(partialRosterMarker),
    'a roster missing the reviewer entries did not suppress the agent spawn'
  );

  fs.writeFileSync(path.join(rosterAgentsDir, 'architect-reviewer.md'), '# architect-reviewer\n');
  fs.writeFileSync(path.join(rosterAgentsDir, 'security-auditor.md'), '# security-auditor\n');
  const withRosterMarker = path.join(rosterRoot, 'with-roster-spawned');
  const withRosterRun = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', path.join(rosterRoot, 'with-roster-results'), rosterCorpus],
    baseEnv(binDir, {
      ACTIVATION_ALLOW_SPEND: '1',
      LIVE_CASE_TIMEOUT_MS: '2000',
      FAKE_SPAWN_MARKER: withRosterMarker,
      HOME: noRosterHome,
      USERPROFILE: noRosterHome,
    })
  );
  assert(
    fs.existsSync(withRosterMarker),
    'a seeded roster did not let the dispatch-count case attempt its agent spawn'
  );

  // --- 7: response_regex fail: no risk-line in the prompt, so neither the
  // assistant text nor the terminal result string carries the pattern. -------
  const regexFailRoot = path.join(root, 'regex-fail');
  fs.mkdirSync(regexFailRoot, { recursive: true });
  const regexFailCorpus = makeBehavioralCorpus(regexFailRoot, [
    {
      id: 'response-regex-fail',
      skill: 'fixture-skill',
      prompt: 'success',
      max_turns: 2,
      fixture: 'response-regex-fail',
      assertions: [{ kind: 'response_regex', regex: 'Risk: high' }],
    },
  ]);
  const regexFailResults = path.join(regexFailRoot, 'results');
  const regexFailRun = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', regexFailResults, regexFailCorpus],
    baseEnv(binDir, { ACTIVATION_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '2000' })
  );
  const regexFailReport = parseReport(regexFailRun, 'behavioral response_regex fail');
  assert(regexFailRun.code === 1, 'a non-matching response_regex did not fail the runner');
  assert(
    regexFailReport.cases[0].status === 'fail' && regexFailReport.cases[0].reason.includes('Risk: high'),
    'response_regex fail reason did not name the pattern'
  );

  // --- 8: response_regex scoping: the target string appears only in a
  // user/prompt event and a tool result, never in assistant text or the
  // terminal result string, so a future broadening of assistantText() would
  // turn this red. --------------------------------------------------------
  const scopeRoot = path.join(root, 'regex-scope');
  fs.mkdirSync(scopeRoot, { recursive: true });
  const scopeCorpus = path.join(scopeRoot, 'behavioral-cases.jsonl');
  writeJsonl(scopeCorpus, [
    {
      id: 'response-regex-scope',
      skill: 'fixture-skill',
      prompt: 'success',
      max_turns: 2,
      fixture: 'response-regex-scope',
      assertions: [{ kind: 'response_regex', regex: 'Risk: high' }],
    },
  ]);
  const scopeResults = path.join(scopeRoot, 'results');
  fs.mkdirSync(scopeResults, { recursive: true });
  writeJsonl(path.join(scopeResults, 'response-regex-scope.jsonl'), [
    { type: 'user', message: { content: [{ type: 'text', text: 'Risk: high (from the prompt echo)' }] } },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'fixture-skill' } }] },
    },
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Risk: high (from a tool result)' }] },
        ],
      },
    },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: 'done' },
  ]);
  const scopeCheck = await runNode(BEHAVIORAL_RUNNER, ['--check', scopeResults, scopeCorpus], baseEnv(binDir));
  const scopeReport = parseReport(scopeCheck, 'behavioral response_regex scoping');
  assert(scopeCheck.code === 1, 'a response_regex matched text outside assistant scope');
  assert(
    scopeReport.cases[0].status === 'fail' && scopeReport.cases[0].reason.includes('Risk: high'),
    'response_regex scoping fail reason did not name the pattern'
  );
}

async function testBehavioralAllowedTools(binDir) {
  const root = path.join(scratchRoot, 'allowed-tools');
  fs.mkdirSync(root, { recursive: true });

  // --- 1: allowed_tools present reaches the child argv, in order. -----------
  const withRoot = path.join(root, 'with');
  const withCorpus = makeBehavioralCorpus(withRoot, [
    {
      id: 'with-allowed-tools',
      skill: 'fixture-skill',
      prompt: 'success',
      max_turns: 2,
      fixture: 'with-allowed-tools',
      allowed_tools: ['Bash', 'Read'],
      // Empty assertions now scores invalid (Finding 1); this test is about
      // argv forwarding, not scoring, so give it a trivially-true assertion.
      assertions: [{ kind: 'trace_agent_dispatch_count', min: 0, max: 999 }],
    },
  ]);
  const withArgvFile = path.join(root, 'with-argv.json');
  const withRun = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', path.join(withRoot, 'results'), withCorpus],
    baseEnv(binDir, {
      ACTIVATION_ALLOW_SPEND: '1',
      LIVE_CASE_TIMEOUT_MS: '2000',
      FAKE_ARGV_MARKER: withArgvFile,
    })
  );
  assert(withRun.code === 0, `allowed_tools case exited ${withRun.code}, expected 0`);
  const withArgv = JSON.parse(fs.readFileSync(withArgvFile, 'utf8'));
  const toolsIndex = withArgv.indexOf('--allowedTools');
  assert(
    toolsIndex !== -1 && withArgv[toolsIndex + 1] === 'Bash' && withArgv[toolsIndex + 2] === 'Read',
    `allowed_tools did not reach the child argv in order: ${JSON.stringify(withArgv)}`
  );
  const withModeIndex = withArgv.indexOf('--permission-mode');
  assert(
    withModeIndex !== -1 && withArgv[withModeIndex + 1] === 'acceptEdits',
    `behavioral runner's --permission-mode acceptEdits did not reach the child argv: ${JSON.stringify(withArgv)}`
  );
  assert(
    !withArgv.includes('--dangerously-skip-permissions'),
    `--dangerously-skip-permissions must never reach the behavioral child argv: ${JSON.stringify(withArgv)}`
  );
  assert(
    withArgv.indexOf('--permission-mode') === withArgv.lastIndexOf('--permission-mode'),
    `--permission-mode must appear exactly once, since a later duplicate would win: ${JSON.stringify(withArgv)}`
  );

  // --- 2: absent allowed_tools never adds the flag. --------------------------
  const withoutRoot = path.join(root, 'without');
  const withoutCorpus = makeBehavioralCorpus(withoutRoot, [
    {
      id: 'without-allowed-tools',
      skill: 'fixture-skill',
      prompt: 'success',
      max_turns: 2,
      fixture: 'without-allowed-tools',
      // Empty assertions now scores invalid (Finding 1); this test is about
      // argv forwarding, not scoring, so give it a trivially-true assertion.
      assertions: [{ kind: 'trace_agent_dispatch_count', min: 0, max: 999 }],
    },
  ]);
  const withoutArgvFile = path.join(root, 'without-argv.json');
  const withoutRun = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', path.join(withoutRoot, 'results'), withoutCorpus],
    baseEnv(binDir, {
      ACTIVATION_ALLOW_SPEND: '1',
      LIVE_CASE_TIMEOUT_MS: '2000',
      FAKE_ARGV_MARKER: withoutArgvFile,
    })
  );
  assert(withoutRun.code === 0, `no-allowed_tools case exited ${withoutRun.code}, expected 0`);
  const withoutArgv = JSON.parse(fs.readFileSync(withoutArgvFile, 'utf8'));
  assert(
    !withoutArgv.includes('--allowedTools'),
    `--allowedTools appeared in argv with no allowed_tools set: ${JSON.stringify(withoutArgv)}`
  );

  // --- 3: the lint rejects a malformed allowed_tools. -------------------------
  const lintRoot = path.join(root, 'lint');
  const lintCorpus = makeBehavioralCorpus(lintRoot, [
    {
      id: 'bad-allowed-tools',
      skill: 'fixture-skill',
      prompt: 'success',
      max_turns: 2,
      fixture: 'bad-allowed-tools',
      allowed_tools: ['Bash(git diff:*)'],
      assertions: [],
    },
  ]);
  const lintRun = await runNode(BEHAVIORAL_RUNNER, ['--dry-run', lintCorpus], baseEnv(binDir));
  const lintReport = parseReport(lintRun, 'behavioral allowed_tools lint');
  assert(lintRun.code === 1, `malformed allowed_tools dry-run exited ${lintRun.code}, expected 1`);
  assert(
    lintReport.cases[0].problems.some((p) => p.includes('allowed_tools')),
    'malformed allowed_tools was not flagged by --dry-run'
  );
}

async function testBehavioralZeroMaxDispatchCount(binDir) {
  const root = path.join(scratchRoot, 'zero-max-dispatch');
  fs.mkdirSync(root, { recursive: true });

  // --- pass: {min:0,max:0} against a trace with zero dispatches. ------------
  const passRoot = path.join(root, 'pass');
  const passCorpus = makeBehavioralCorpus(passRoot, [
    {
      id: 'zero-dispatch-pass',
      skill: 'fixture-skill',
      prompt: 'success',
      max_turns: 2,
      fixture: 'zero-dispatch-pass',
      assertions: [{ kind: 'trace_agent_dispatch_count', min: 0, max: 0 }],
    },
  ]);
  const passRun = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', path.join(passRoot, 'results'), passCorpus],
    baseEnv(binDir, { ACTIVATION_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '2000' })
  );
  const passReport = parseReport(passRun, 'zero-max dispatch pass');
  assert(passRun.code === 0 && passReport.passed === 1, '{min:0,max:0} did not pass on zero dispatches');

  // --- fail: {min:0,max:0} against a trace with a nonzero dispatch count. ---
  const failRoot = path.join(root, 'fail');
  const failCorpus = makeBehavioralCorpus(failRoot, [
    {
      id: 'zero-dispatch-fail',
      skill: 'fixture-skill',
      prompt: 'dispatch2',
      max_turns: 2,
      fixture: 'zero-dispatch-fail',
      assertions: [{ kind: 'trace_agent_dispatch_count', min: 0, max: 0 }],
    },
  ]);
  const failRun = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', path.join(failRoot, 'results'), failCorpus],
    baseEnv(binDir, { ACTIVATION_ALLOW_SPEND: '1', LIVE_CASE_TIMEOUT_MS: '2000' })
  );
  const failReport = parseReport(failRun, 'zero-max dispatch fail');
  assert(failRun.code === 1, '{min:0,max:0} did not fail the runner on a nonzero dispatch');
  assert(
    failReport.cases[0].status === 'fail' && failReport.cases[0].reason.includes('subagent dispatches'),
    '{min:0,max:0} fail reason did not name the observed count'
  );
}

async function testBehavioralSetupEnvScrub(binDir) {
  const root = path.join(scratchRoot, 'setup-env-scrub');
  fs.mkdirSync(root, { recursive: true });
  const corpus = makeBehavioralCorpus(root, [
    {
      id: 'env-scrub-case',
      skill: 'fixture-skill',
      prompt: 'success',
      max_turns: 2,
      fixture: 'env-scrub-case',
      setup: 'record-env.setup.js',
      assertions: [
        { kind: 'file_regex', path: 'env.json', regex: '"GIT_DIR":null' },
        { kind: 'file_regex', path: 'env.json', regex: '"GIT_CONFIG_COUNT":null' },
        { kind: 'file_regex', path: 'env.json', regex: '"GIT_CONFIG_KEY_0":null' },
        { kind: 'file_regex', path: 'env.json', regex: '"GIT_CONFIG_VALUE_0":null' },
      ],
    },
  ]);
  fs.writeFileSync(
    path.join(root, 'behavioral', 'record-env.setup.js'),
    "'use strict';\nrequire('fs').writeFileSync('env.json', JSON.stringify({ " +
      'GIT_DIR: process.env.GIT_DIR || null, ' +
      'GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT || null, ' +
      'GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0 || null, ' +
      'GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 || null ' +
      "}));\n"
  );
  const results = path.join(root, 'results');
  const run = await runNode(
    BEHAVIORAL_RUNNER,
    ['--run', results, corpus],
    baseEnv(binDir, {
      ACTIVATION_ALLOW_SPEND: '1',
      LIVE_CASE_TIMEOUT_MS: '2000',
      GIT_DIR: '/nonexistent/should-not-leak',
      // The scrub was widened from a fixed denylist to a GIT_ prefix sweep
      // precisely because a denylist misses this dynamic configuration
      // family (git also reads these to set core.worktree/core.hooksPath);
      // seed them so this fixture actually covers that regression rather
      // than only re-proving the original named-variable case.
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: '/nonexistent/should-not-leak',
    })
  );
  const report = parseReport(run, 'setup env scrub');
  assert(run.code === 0 && report.passed === 1, 'the setup child leaked an inherited GIT_ variable');
  const env = JSON.parse(fs.readFileSync(path.join(results, 'env-scrub-case', 'env.json'), 'utf8'));
  assert(
    env.GIT_DIR === null &&
      env.GIT_CONFIG_COUNT === null &&
      env.GIT_CONFIG_KEY_0 === null &&
      env.GIT_CONFIG_VALUE_0 === null,
    `setup child observed GIT env leakage: ${JSON.stringify(env)}, expected all scrubbed`
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
  await testAgentUninstallableEscape(binDir);
  await testPlainScalarIndicators(binDir);
  await testTimeoutMaximum(binDir);
  await testMalformedInstalledToml(binDir);
  await testActivation(binDir);
  await testActivationPermissionMode(binDir);
  await testBehavioral(binDir);
  await testBehavioralAssertionsAndSetup(binDir);
  await testBehavioralAllowedTools(binDir);
  await testBehavioralZeroMaxDispatchCount(binDir);
  await testBehavioralSetupEnvScrub(binDir);
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
