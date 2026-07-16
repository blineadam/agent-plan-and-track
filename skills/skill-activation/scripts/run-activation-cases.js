#!/usr/bin/env node
/**
 * run-activation-cases.js: routing-regression harness for skills.
 *
 * Tests whether the RIGHT skill fires for a given prompt (a description/router
 * question): the static + runtime complement to skill-comply, which tests
 * whether a fired skill is FOLLOWED (a body question).
 *
 * Activation is checked DETERMINISTICALLY: a case passes iff the expected skill
 * appears as a `Skill` tool_use in the fresh agent's stream-json trace, and any
 * forbidden skill does not. No LLM judgment, so --precheck and --check cost
 * nothing and are fully reproducible.
 *
 * Node port of the original bash script, so it runs on Windows too (no jq, awk,
 * find, or grep). Node built-ins only.
 *
 * Usage:
 *   node run-activation-cases.js [--dry-run] [FIXTURES]        # list cases (default; free)
 *   node run-activation-cases.js --precheck [SKILLS_DIR]       # static router-signal lint (free)
 *   node run-activation-cases.js --check TRACE_DIR [FIXTURES]  # verify pre-captured traces (free)
 *   node run-activation-cases.js --run [FIXTURES]              # invoke claude -p per case (COSTS money)
 *
 * FIXTURES defaults to the sibling fixtures/activation-cases.jsonl.
 * SKILLS_DIR defaults to ~/.claude/skills (the installed set the agent routes on).
 *
 * --check reads one trace per case at TRACE_DIR/<id>.jsonl (id = each case's
 * "id" field). --run writes those same files then checks them, but is a real,
 * billable, tool-executing operation: it refuses unless ACTIVATION_ALLOW_SPEND=1,
 * and you MUST run it inside an isolated container/VM with no network egress and
 * restricted mounts; a competing/injected prompt will execute tool calls. Never
 * pass --dangerously-skip-permissions here. --run is Claude-only and intended for
 * a unix sandbox; --dry-run / --precheck / --check are the cross-platform modes.
 * See SKILL.md for the full rationale.
 *
 * Tuning (env):
 *   DESC_TOKEN_FLOOR         words below which a description is a weak router signal (default 12)
 *   ACTIVATION_ALLOW_SPEND   set to 1 to permit --run to call claude -p
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const DEFAULT_FIXTURES = path.join(SCRIPT_DIR, '..', 'fixtures', 'activation-cases.jsonl');
const DESC_TOKEN_FLOOR = intEnv('DESC_TOKEN_FLOOR', 12);

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) ? n : fallback;
}

function die(msg, code) {
  process.stderr.write(msg + '\n');
  process.exit(code === undefined ? 1 : code);
}

// jq -r '.<field>': raw string for a string, "null" for a missing/null value.
function jqRaw(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

// jq -r '.<field> // empty': "" for a missing/null/false value, else the string.
function jqRawOrEmpty(v) {
  if (v === null || v === undefined || v === false) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

// jq pretty-print parity: 2-space indent + a trailing newline.
function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// Read a JSONL file into an array of parsed objects, skipping blank lines (the
// `[[ -n "$line" ]] || continue` guard in the bash loop).
function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    out.push(JSON.parse(line));
  }
  return out;
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

// The set of skills a trace activated via the skill tool. Harness-tolerant:
// matches any object whose tool name is "skill" (case-insensitive, e.g. Claude's
// `Skill`, Copilot's `skill`), reading the skill name from whichever field the
// harness places it in. Returns a sorted, de-duplicated array (jq's sort -u).
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

// ---- Static router-signal lint (free) ---------------------------------------
function modePrecheck(args) {
  const skillsDir = args[0] || path.join(os.homedir(), '.claude', 'skills');
  if (!isDir(skillsDir)) die(`error: no skills dir at ${skillsDir}`);
  const files = findSkillMd(skillsDir).sort();
  if (files.length === 0) {
    printJson({ skills: [], weak_count: 0 });
    return;
  }
  const skills = files.map((f) => {
    const name = path.basename(path.dirname(f));
    const desc = frontmatterDescription(f);
    const words = desc.trim() === '' ? 0 : desc.trim().split(/\s+/).length;
    // A trigger clause is what drives routing: look for use/when/after/before/trigger.
    const hasTrigger = /(^|[^a-zA-Z])(use|when|after|before|trigger)([^a-zA-Z]|$)/i.test(desc);
    const weak = words < DESC_TOKEN_FLOOR || !hasTrigger;
    return { skill: name, desc_words: words, has_trigger: hasTrigger, weak_router_signal: weak };
  });
  printJson({ skills, weak_count: skills.filter((s) => s.weak_router_signal).length });
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Recursively collect every SKILL.md file under dir (the `find -name SKILL.md`).
function findSkillMd(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name === 'SKILL.md') out.push(full);
    }
  };
  walk(dir);
  return out;
}

// The first `description:` value inside the YAML frontmatter (between the first
// two `---` lines), with the `description:` prefix stripped. Single-line only,
// matching the original awk (no YAML folding).
function frontmatterDescription(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let fm = 0;
  for (const line of lines) {
    if (line === '---') {
      fm++;
      if (fm >= 2) break;
      continue;
    }
    if (fm === 1 && /^description:/.test(line)) {
      return line.replace(/^description:[ \t]*/, '');
    }
  }
  return '';
}

// ---- Case-driven modes ------------------------------------------------------
function modeDryRun(args) {
  const fixtures = args[0] || DEFAULT_FIXTURES;
  if (!isFile(fixtures)) die(`error: no fixtures at ${fixtures}`);
  const cases = readJsonl(fixtures);
  printJson({
    case_count: cases.length,
    cases: cases.map((c) => ({
      id: c.id ?? null,
      expect_skill: c.expect_skill ?? null,
      forbid_skill: c.forbid_skill ?? null,
      prompt: c.prompt ?? null,
    })),
  });
  process.stderr.write('# dry-run: no claude -p runs, no cost. Use --check TRACE_DIR or --run.\n');
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// check + run share the per-case verification loop.
function modeCheckOrRun(mode, traceDirArg, fixturesArg) {
  const fixtures = fixturesArg || DEFAULT_FIXTURES;
  if (!isFile(fixtures)) die(`error: no fixtures at ${fixtures}`);

  let traceDir = traceDirArg;
  if (mode === 'run') {
    if (process.env.ACTIVATION_ALLOW_SPEND !== '1') {
      process.stderr.write('refusing: --run invokes claude -p (billable, executes tool calls).\n');
      die('Run inside an isolated container/VM, then set ACTIVATION_ALLOW_SPEND=1.', 2);
    }
    if (!hasClaude()) die('error: claude CLI not found');
    traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-'));
  }

  const cases = readJsonl(fixtures);
  const results = [];
  for (const c of cases) {
    const id = jqRaw(c.id);
    const prompt = jqRaw(c.prompt);
    const expect = jqRawOrEmpty(c.expect_skill);
    const forbid = jqRawOrEmpty(c.forbid_skill);

    // Validate before touching the filesystem: the id is interpolated into a
    // trace path (reject path syntax so a case can't escape the trace dir), and
    // expect_skill is required (a case with no expect and no forbidden hit would
    // "pass" while testing nothing, a false negative).
    let invalid = '';
    if (id === '' || id.includes('/') || id.includes('..')) {
      invalid = `invalid id '${id}': path syntax not allowed`;
    } else if (expect === '') {
      invalid = `invalid case '${id}': missing required expect_skill`;
    }
    if (invalid) {
      results.push({ id, expect_skill: expect, forbid_skill: forbid, activated: [], pass: false, reason: invalid });
      continue;
    }

    const trace = path.join(traceDir, `${id}.jsonl`);
    if (mode === 'run') {
      const res = spawnSync('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose'], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 64,
      });
      fs.writeFileSync(trace, res.stdout || '');
      fs.writeFileSync(path.join(traceDir, `${id}.err`), res.stderr || '');
    }
    if (!isFile(trace)) {
      results.push({ id, expect_skill: expect, forbid_skill: forbid, activated: [], pass: false, reason: 'no trace file' });
      continue;
    }

    const acts = activatedSkills(trace);
    let pass = true;
    let reason = 'ok';
    if (expect !== '' && !acts.includes(expect)) {
      pass = false;
      reason = `expected '${expect}' not activated`;
    }
    if (forbid !== '' && acts.includes(forbid)) {
      pass = false;
      reason = `forbidden '${forbid}' activated`;
    }
    results.push({ id, expect_skill: expect, forbid_skill: forbid, activated: acts, pass, reason });
  }

  // In --run we created traceDir with mkdtemp; disclose it rather than silently
  // leaving prompts and tool-call transcripts in the temp dir. Kept (not deleted)
  // so a failing case's trace can be inspected; rm it when done.
  if (mode === 'run') {
    process.stderr.write(`# traces retained at ${traceDir}: inspect failing cases, then rm\n`);
  }

  // accuracy stays present (null) on the empty-corpus path so the report shape
  // never varies for consumers.
  if (results.length === 0) {
    printJson({ total: 0, passed: 0, accuracy: null, cases: [] });
    return;
  }
  const passed = results.filter((r) => r.pass).length;
  printJson({
    total: results.length,
    passed,
    accuracy: passed / results.length,
    cases: results,
  });
}

// Is the claude CLI on PATH? (Only relevant to --run.)
function hasClaude() {
  const isWin = process.platform === 'win32';
  const probe = isWin
    ? spawnSync('where', ['claude'], { encoding: 'utf8' })
    : spawnSync('command', ['-v', 'claude'], { encoding: 'utf8', shell: true });
  return probe.status === 0;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = argv[0] || '';
  if (flag === '--precheck') {
    modePrecheck(argv.slice(1));
  } else if (flag === '--check') {
    if (argv.length < 2) die('error: --check needs TRACE_DIR');
    modeCheckOrRun('check', argv[1], argv[2]);
  } else if (flag === '--run') {
    modeCheckOrRun('run', null, argv[1]);
  } else if (flag === '--dry-run') {
    modeDryRun(argv.slice(1));
  } else if (flag.startsWith('-')) {
    die(`error: unknown flag ${flag}`);
  } else {
    modeDryRun(argv);
  }
}

main();
