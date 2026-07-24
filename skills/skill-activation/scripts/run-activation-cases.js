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
 *   node run-activation-cases.js --precheck-agents [AGENTS_DIR] [INSTALLED_HOME]
 *                                                               # agent schema/render lint (free)
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
 *   DESC_CHAR_CEILING        chars past which a description is flagged overlong, informational only (default 500)
 *   ACTIVATION_ALLOW_SPEND   set to 1 to permit --run to call claude -p
 *   LIVE_CASE_TIMEOUT_MS     per-case timeout for live runs (default 900000)
 *   LIVE_CLAUDE_TEST_SCRIPT  absolute fake-CLI script path used only by free fixtures
 *
 * --precheck per-skill flags:
 *   weak_router_signal        description under DESC_TOKEN_FLOOR words, or no use/when/after/before/trigger clause
 *   desc_overlong              description over DESC_CHAR_CEILING chars, informational only
 *   description_length_ok      description is 1-1024 decoded characters (counts into schema_issue_count)
 *   name_matches_folder        frontmatter `name` equals the containing folder name
 *   name_pattern_ok            frontmatter `name` is lowercase-kebab-case
 *   extra_frontmatter_keys     any top-level frontmatter key besides name/description
 *   frontmatter_invalid_yaml   a frontmatter key: value line YAML would reject: an unquoted value
 *                              containing a colon-space, or a quoted value containing an unescaped
 *                              copy of its own delimiter (counts into schema_issue_count)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const DEFAULT_FIXTURES = path.join(SCRIPT_DIR, '..', 'fixtures', 'activation-cases.jsonl');
const DESC_TOKEN_FLOOR = intEnv('DESC_TOKEN_FLOOR', 12);
const DESC_CHAR_CEILING = intEnv('DESC_CHAR_CEILING', 500);
// This repo's skill frontmatter convention is exactly `name` + `description`, nothing else.
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const AGENT_FRONTMATTER_KEYS = ['name', 'description', 'model', 'effort', 'tools'];
const FORCE_SETTLE_MS = 100;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const TERMINATE_GRACE_MS = 1000;

let activeRun = null;
let parentInterrupted = false;
let parentSignalCount = 0;

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

function liveCaseTimeout() {
  const raw = process.env.LIVE_CASE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 900000;
  if (!/^[0-9]+$/.test(raw)) die('error: LIVE_CASE_TIMEOUT_MS must be a positive integer');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    die('error: LIVE_CASE_TIMEOUT_MS must be a positive integer');
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
    printJson({ skills: [], weak_count: 0, schema_issue_count: 0 });
    return;
  }
  const skills = files.map((f) => {
    const folder = path.basename(path.dirname(f));
    const desc = frontmatterDescription(f);
    const words = desc.trim() === '' ? 0 : desc.trim().split(/\s+/).length;
    // A trigger clause is what drives routing: look for use/when/after/before/trigger.
    const hasTrigger = /(^|[^a-zA-Z])(use|when|after|before|trigger)([^a-zA-Z]|$)/i.test(desc);
    const weak = words < DESC_TOKEN_FLOOR || !hasTrigger;
    // Frontmatter-schema checks (adapted from BuilderIO's skill-schema lint): the
    // `name` value should match its folder and be lowercase-kebab, and no key
    // besides name/description should be present.
    const meta = frontmatterMeta(f);
    const nameMatchesFolder = meta.name === folder;
    const namePatternOk = SKILL_NAME_PATTERN.test(meta.name);
    const extraFrontmatterKeys = meta.keys.filter((k) => k !== 'name' && k !== 'description');
    const frontmatterInvalidYaml = hasInvalidFrontmatterValue(f);
    return {
      skill: folder,
      desc_words: words,
      has_trigger: hasTrigger,
      weak_router_signal: weak,
      desc_chars: desc.trim().length,
      desc_overlong: desc.trim().length > DESC_CHAR_CEILING,
      description_length_ok: desc.trim().length >= 1 && desc.trim().length <= 1024,
      name_matches_folder: nameMatchesFolder,
      name_pattern_ok: namePatternOk,
      extra_frontmatter_keys: extraFrontmatterKeys,
      frontmatter_invalid_yaml: frontmatterInvalidYaml,
    };
  });
  const schemaIssueCount = skills.filter(
    (s) =>
      !s.description_length_ok ||
      !s.name_matches_folder ||
      !s.name_pattern_ok ||
      s.extra_frontmatter_keys.length > 0 ||
      s.frontmatter_invalid_yaml
  ).length;
  printJson({
    skills,
    weak_count: skills.filter((s) => s.weak_router_signal).length,
    schema_issue_count: schemaIssueCount,
  });
  if (schemaIssueCount > 0) process.exitCode = 1;
}

function modePrecheckAgents(args) {
  const agentsDir = args[0] || path.join(process.cwd(), 'agents');
  const installedHome = args[1] ? path.resolve(args[1]) : null;
  if (!isDir(agentsDir)) die(`error: no agents dir at ${agentsDir}`);
  if (installedHome && !isDir(installedHome)) die(`error: no installed home at ${installedHome}`);
  const files = fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(agentsDir, entry.name))
    .sort();
  const agents = files.map((file) => {
    const expectedName = path.basename(file, '.md');
    const meta = frontmatterMeta(file);
    const description = frontmatterScalar(file, 'description');
    const keysInOrder = arraysEqual(meta.keys, AGENT_FRONTMATTER_KEYS);
    const nameMatchesFile = meta.name === expectedName;
    const namePatternOk = SKILL_NAME_PATTERN.test(meta.name);
    const descriptionChars = description.length;
    const descriptionLengthOk = descriptionChars >= 1 && descriptionChars <= 1024;
    const frontmatterInvalidYaml = hasInvalidFrontmatterValue(file);
    const result = {
      agent: expectedName,
      description_chars: descriptionChars,
      keys_in_order: keysInOrder,
      name_matches_file: nameMatchesFile,
      name_pattern_ok: namePatternOk,
      description_length_ok: descriptionLengthOk,
      frontmatter_invalid_yaml: frontmatterInvalidYaml,
    };
    if (installedHome) {
      result.claude_description_matches =
        installedFrontmatterDescription(
          path.join(installedHome, '.claude', 'agents', `${expectedName}.md`)
        ) === description;
      result.codex_description_matches =
        installedTomlDescription(
          path.join(installedHome, '.codex', 'agents', `${expectedName}.toml`)
        ) === description;
      result.copilot_description_matches =
        installedFrontmatterDescription(
          path.join(installedHome, '.copilot', 'agents', `${expectedName}.agent.md`)
        ) === description;
    }
    return result;
  });
  const schemaIssueCount = agents.filter(
    (agent) =>
      !agent.keys_in_order ||
      !agent.name_matches_file ||
      !agent.name_pattern_ok ||
      !agent.description_length_ok ||
      agent.frontmatter_invalid_yaml ||
      (installedHome &&
        (!agent.claude_description_matches ||
          !agent.codex_description_matches ||
          !agent.copilot_description_matches))
  ).length;
  printJson({ agents, schema_issue_count: schemaIssueCount });
  if (schemaIssueCount > 0) process.exitCode = 1;
}

function installedFrontmatterDescription(file) {
  if (!isFile(file)) return null;
  return frontmatterScalar(file, 'description');
}

function installedTomlDescription(file) {
  if (!isFile(file)) return null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^description[ \t]*=[ \t]*("(?:\\.|[^"])*")[ \t]*$/.exec(line);
    if (!match) continue;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
  return null;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
  return frontmatterScalar(file, 'description');
}

function frontmatterScalar(file, key) {
  // Split on \r?\n so a CRLF-authored SKILL.md (common on Windows) still has its
  // "---" fences and `description:` line recognized, not flagged weak with an
  // empty description.
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let fm = 0;
  for (const line of lines) {
    if (line === '---') {
      fm++;
      if (fm >= 2) break;
      continue;
    }
    if (fm === 1 && line.startsWith(`${key}:`)) {
      const value = line.replace(new RegExp(`^${key}:[ \\t]*`), '');
      // Strip YAML quoting so the word/char metrics measure the string the
      // router actually sees, not its on-disk encoding. A description is
      // quoted whenever its text contains a colon-space.
      return decodeScalar(value);
    }
  }
  return '';
}

function decodeScalar(value) {
  const q = value.length >= 2 && (value[0] === '"' || value[0] === "'") ? value[0] : '';
  if (!q || value[value.length - 1] !== q) return value;
  const inner = value.slice(1, -1);
  if (q === "'") return inner.replace(/''/g, "'");
  try {
    return JSON.parse(value);
  } catch {
    return inner;
  }
}

// The frontmatter `name:` value plus every top-level key present, single-line
// `key:` pairs only (same no-YAML-folding assumption as frontmatterDescription).
// Feeds the (a)/(b)/(c) schema checks in modePrecheck.
function frontmatterMeta(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let fm = 0;
  let name = '';
  const keys = [];
  for (const line of lines) {
    if (line === '---') {
      fm++;
      if (fm >= 2) break;
      continue;
    }
    if (fm === 1) {
      const m = /^([A-Za-z0-9_-]+):/.exec(line);
      if (m) {
        keys.push(m[1]);
        if (m[1] === 'name') name = decodeScalar(line.replace(/^name:[ \t]*/, '').trim());
      }
    }
  }
  return { name, keys };
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
    'duration_ms',
  ];
  const valid =
    metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    arraysEqual(Object.keys(metadata), expectedKeys) &&
    (metadata.exit_code === null || Number.isInteger(metadata.exit_code)) &&
    (metadata.signal === null || typeof metadata.signal === 'string') &&
    typeof metadata.timed_out === 'boolean' &&
    (metadata.spawn_error === null || typeof metadata.spawn_error === 'string') &&
    typeof metadata.stdout_truncated === 'boolean' &&
    typeof metadata.stderr_truncated === 'boolean' &&
    Number.isInteger(metadata.duration_ms) &&
    metadata.duration_ms >= 0;
  if (!valid) return { present: true, clean: false, reason: 'invalid run metadata' };
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

function terminateChildTree(child, force) {
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

function handleParentSignal(signal) {
  parentSignalCount++;
  parentInterrupted = true;
  if (activeRun) activeRun.terminate(parentSignalCount > 1);
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  if (parentSignalCount > 1) process.exit(process.exitCode);
}

process.on('SIGINT', () => handleParentSignal('SIGINT'));
process.on('SIGTERM', () => handleParentSignal('SIGTERM'));

async function runChildCase(index, total, id, command, args, options, timeoutMs) {
  const started = Date.now();
  process.stderr.write(`[${index}/${total}] ${id} start elapsed=0ms outcome=running\n`);
  let child;
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
    activeRun = { terminate };
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
    duration_ms: Date.now() - started,
  };
  let outcome = 'success';
  if (metadata.timed_out) outcome = 'timeout';
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

// Whether the frontmatter contains a `key: value` line YAML would reject. This
// repo's convention is single-line name/description pairs only, never YAML
// folding, so a targeted per-line check covers it; no general YAML parser.
// A value opening with a quote is a quoted scalar (a plain scalar may not start
// with one), so it is judged by the quoted rules; anything else is plain.
//   plain scalar    -> a colon-space (": ") sequence, which YAML reads as a
//                      nested mapping key, invalidating the whole block
//   quoted scalar   -> no matching closing delimiter, or an unescaped instance
//                      of its own delimiter inside the quotes, either of which
//                      ends the scalar somewhere YAML does not expect. YAML
//                      escapes these as \" inside "..." and as '' inside '...',
//                      and \" only counts as escaped after an even-length run
//                      of backslashes, since \\ is itself an escaped backslash.
// The unescaped-delimiter case is the one that bites when a value is
// single-quoted to avoid escaping embedded double quotes: adding an apostrophe
// later breaks it.
function hasInvalidFrontmatterValue(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let fm = 0;
  for (const line of lines) {
    if (line === '---') {
      fm++;
      if (fm >= 2) break;
      continue;
    }
    if (fm !== 1) continue;
    const m = /^[A-Za-z0-9_-]+:[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[1];
    const q = value[0] === '"' || value[0] === "'" ? value[0] : '';
    if (!q) {
      if (value.includes(': ')) return true;
      continue;
    }
    if (value.length < 2 || value[value.length - 1] !== q) return true;
    const inner = value.slice(1, -1);
    const unescaped =
      q === '"' ? /(?:^|[^\\])(?:\\\\)*"/.test(inner) : inner.replace(/''/g, '').includes("'");
    if (unescaped) return true;
  }
  return false;
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
async function modeCheckOrRun(mode, traceDirArg, fixturesArg) {
  const fixtures = fixturesArg || DEFAULT_FIXTURES;
  if (!isFile(fixtures)) die(`error: no fixtures at ${fixtures}`);

  let traceDir = traceDirArg;
  let timeoutMs = null;
  let invocation = null;
  if (mode === 'run') {
    if (process.env.ACTIVATION_ALLOW_SPEND !== '1') {
      process.stderr.write('refusing: --run invokes claude -p (billable, executes tool calls).\n');
      die('Run inside an isolated container/VM, then set ACTIVATION_ALLOW_SPEND=1.', 2);
    }
    timeoutMs = liveCaseTimeout();
    invocation = claudeInvocation();
    if (!hasClaude(invocation)) die('error: claude CLI not found');
    traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-'));
  }

  const cases = readJsonl(fixtures);
  const results = [];
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
    if (parentInterrupted) break;
    const c = cases[caseIndex];
    const id = jqRaw(c.id);
    const prompt = jqRaw(c.prompt);
    const expect = jqRawOrEmpty(c.expect_skill);
    const forbid = jqRawOrEmpty(c.forbid_skill);

    // Validate before touching the filesystem: the id is interpolated into a
    // trace path (reject path syntax so a case can't escape the trace dir), and
    // expect_skill is required (a case with no expect and no forbidden hit would
    // "pass" while testing nothing, a false negative).
    let invalid = '';
    // Reject both path separators (\ is a separator on Windows) plus `..`, so a
    // case id can't escape the trace dir when interpolated into a trace path.
    if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) {
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
      const run = await runChildCase(
        caseIndex + 1,
        cases.length,
        id,
        invocation.command,
        [...invocation.prefixArgs, '-p', prompt, '--output-format', 'stream-json', '--verbose'],
        {},
        timeoutMs
      );
      fs.writeFileSync(trace, run.stdout);
      fs.writeFileSync(path.join(traceDir, `${id}.err`), run.stderr);
      fs.writeFileSync(
        path.join(traceDir, `${id}.meta.json`),
        JSON.stringify(run.metadata, null, 2) + '\n'
      );
    }
    if (!isFile(trace)) {
      results.push({ id, expect_skill: expect, forbid_skill: forbid, activated: [], pass: false, reason: 'no trace file' });
      continue;
    }

    const metadata = readRunMetadata(path.join(traceDir, `${id}.meta.json`));
    const acts = activatedSkills(trace);
    let pass = true;
    let reason = 'ok';
    if (!metadata.clean) {
      pass = false;
      reason = metadata.reason;
    } else if (expect !== '' && !acts.includes(expect)) {
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
  if (passed !== results.length || parentInterrupted) process.exitCode = process.exitCode || 1;
}

// Is the claude CLI on PATH? (Only relevant to --run.)
function hasClaude(invocation) {
  if (invocation.prefixArgs.length > 0) return true;
  const isWin = process.platform === 'win32';
  const probe = isWin
    ? spawnSync('where.exe', ['claude'], { encoding: 'utf8' })
    : spawnSync('which', ['claude'], { encoding: 'utf8' });
  return probe.status === 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = argv[0] || '';
  if (flag === '--precheck') {
    modePrecheck(argv.slice(1));
  } else if (flag === '--precheck-agents') {
    modePrecheckAgents(argv.slice(1));
  } else if (flag === '--check') {
    if (argv.length < 2) die('error: --check needs TRACE_DIR');
    await modeCheckOrRun('check', argv[1], argv[2]);
  } else if (flag === '--run') {
    await modeCheckOrRun('run', null, argv[1]);
  } else if (flag === '--dry-run') {
    modeDryRun(argv.slice(1));
  } else if (flag.startsWith('-')) {
    die(`error: unknown flag ${flag}`);
  } else {
    modeDryRun(argv);
  }
}

main().catch((err) => die(`error: ${err && err.message}`));
