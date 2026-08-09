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
 *   { id, skill, prompt, max_turns, fixture, setup?, allowed_tools?,
 *     assertions: [
 *       { kind: "file_regex", path, regex, flags } |
 *       { kind: "response_regex", regex, flags } |
 *       { kind: "trace_agent_dispatch_count", min, max? } |
 *       { kind: "trace_agent_dispatch_names", expect?, forbid? }
 *     ], note }
 * `fixture` names a directory under fixtures/behavioral/ that is copied into
 * the case's working directory before the agent runs (a file the skill's
 * mandated output must be appended to, not clobber). Prompts should name the
 * target skill: unlike activation-cases.jsonl (which tests routing on an
 * unnamed prompt), the naming here is deliberate, since the point is to prove
 * the BODY still works once the skill has fired, not to test routing again.
 * A `response_regex` assertion hard-fails the case when its regex does not
 * match assistant text (assistant `text` blocks plus the terminal result's
 * `result` string): a match only proves the marker appears at the start of
 * SOME LINE of assistant text, not that it was the review's first line. A
 * `trace_agent_dispatch_count` assertion hard-fails the case when the
 * trace's Task/Agent tool_use count (de-duplicated by id) falls outside
 * [min, max]: it only proves HOW MANY Task/Agent tool_use objects the trace
 * carries, not that the dispatched agents were the two independent
 * reviewers a rule names. A `trace_agent_dispatch_names` assertion
 * hard-fails the case on WHICH agents were dispatched rather than how many:
 * `forbid` fails the case when any listed name matches a dispatched agent's
 * identity (checked first, since a forbidden dispatch is the more specific
 * failure), and `expect` is any-of (fails unless at least one listed name
 * matches; not all-of). Identity is read from the same Task/Agent tool_use
 * objects `trace_agent_dispatch_count` counts, so it proves identity
 * PRESENCE in the trace only, never that the dispatched agent ran, returned,
 * or produced anything useful; a dispatch whose identity field the harness
 * doesn't expose is invisible to both directions, so `forbid` can only prove
 * "no *readable* forbidden dispatch", not true absence. At least one of
 * `expect`/`forbid` is required (neither present is rejected as vacuous, the
 * same rejection the `trace_agent_dispatch_count` bare min:0 case gets);
 * each present array must be non-empty and match /^[a-z][a-z0-9-]*$/, and
 * the same name is rejected if it names both `expect` and `forbid`. Any
 * trace_agent_dispatch_count or trace_agent_dispatch_names case run via
 * --run needs the roster entries those assertions actually depend on
 * installed first, or the measurement would measure the sandbox, not the
 * skill: the required set is derived from the corpus, always
 * ~/.claude/agents/architect-reviewer.md and
 * ~/.claude/agents/security-auditor.md for a trace_agent_dispatch_count
 * case, plus ~/.claude/agents/<name>.md for every name in both a
 * trace_agent_dispatch_names case's expect and its forbid (both
 * directions: an uninstalled forbidden agent would otherwise satisfy a
 * forbid trivially); --run dies up front, before spending, when the corpus
 * needs the roster and any required entry is missing.
 * response_regex and file_regex both compile an operator-supplied pattern and
 * run it over trace/file text this runner caps at 64 MB, so a catastrophic
 * pattern can hang the single-threaded scorer while the per-case timeout only
 * bounds child processes, not scoring, accepted since the corpus and results
 * dir are both operator-supplied local input and CI only runs --dry-run,
 * which compiles patterns but never executes them.
 * `setup` optionally names a sibling .js file in fixtures/behavioral/, run
 * only by --run (never by --check or --dry-run) with cwd set to the case
 * dir, before the agent spawns; a nonzero exit, a timeout, or any other
 * unclean run scores the case invalid and suppresses the agent spawn
 * entirely. A hand-assembled results dir missing `<id>.setup.meta.json` is
 * tolerated as if setup ran cleanly, the same legacy tolerance the agent-run
 * metadata already gets. `allowed_tools` optionally widens --run's tool
 * allowlist beyond its fixed `acceptEdits` posture: an array of bare tool
 * names (e.g. "Bash"; no parenthesised scoping, which is unverified against
 * the current CLI), each matching /^[A-Za-z][A-Za-z0-9_]*$/, appended to the
 * child's --allowedTools flag.
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
 * each case's assertions: file_regex against RESULTS_DIR/<id>/<assertion.path>,
 * response_regex and trace_agent_dispatch_count against the parsed trace
 * itself. --run writes those same files then scores them identically, but is
 * a real, billable, tool-executing operation: it refuses unless
 * ACTIVATION_ALLOW_SPEND=1, and you MUST run it inside an isolated
 * container/VM with restricted mounts and egress
 * allowed only to the model provider's API; a competing/injected prompt will
 * execute tool calls. Sealing egress off entirely is not the safer setting: the
 * case then cannot reach the API, exits at zero turns, and scores invalid.
 * Every case runs --run's fixed --permission-mode acceptEdits (not a
 * read-only mode: the whole point of a behavioral smoke is that the skill
 * under test WRITES a file, so a read-only mode would make every case a
 * false negative); a case may widen the tool allowlist via `allowed_tools`,
 * and no bypass or skip-permissions flag is ever passed.
 * --run is Claude-only and
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
const DISPATCH_TOOL_NAMES = new Set(['task', 'agent']);
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
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

// Count of Task/Agent tool_use objects in a trace, de-duplicated by id so a
// harness that repeats a tool_use across events cannot inflate the count past
// the number of real dispatches.
function agentDispatchCount(traceFile) {
  const ids = new Set();
  let idless = 0;
  let text;
  try {
    text = fs.readFileSync(traceFile, 'utf8');
  } catch {
    return 0;
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const obj of walkObjects(parsed)) {
      if (obj.type !== 'tool_use' || typeof obj.name !== 'string') continue;
      if (!DISPATCH_TOOL_NAMES.has(obj.name.toLowerCase())) continue;
      if (typeof obj.id === 'string' && obj.id !== '') ids.add(obj.id);
      else idless++;
    }
  }
  return ids.size + idless;
}

// The set of agent identities a trace dispatched via the Task/Agent tool,
// harness-tolerant in the same shape as activatedSkills(): identity is read
// from input.subagent_type (confirmed against a real captured Claude Code
// trace), falling back to input.agent_type, input.agent, then
// arguments.subagent_type. Returns a sorted, de-duplicated array. A dispatch
// whose identity isn't exposed in any of these fields contributes nothing:
// this function can under-report a dispatch, never invent one, which means a
// `forbid` assertion built on it can only prove "no *readable* forbidden
// dispatch", not true absence.
function agentDispatchNames(traceFile) {
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
      continue;
    }
    for (const obj of walkObjects(parsed)) {
      if (obj.type !== 'tool_use' || typeof obj.name !== 'string') continue;
      if (!DISPATCH_TOOL_NAMES.has(obj.name.toLowerCase())) continue;
      let agent = null;
      const input = obj.input;
      const args = obj.arguments;
      if (input && input.subagent_type != null && input.subagent_type !== '') agent = input.subagent_type;
      else if (input && input.agent_type != null && input.agent_type !== '') agent = input.agent_type;
      else if (input && input.agent != null && input.agent !== '') agent = input.agent;
      else if (args && args.subagent_type != null && args.subagent_type !== '') agent = args.subagent_type;
      if (agent != null && agent !== '') set.add(String(agent));
    }
  }
  return Array.from(set).sort();
}

// Text a response_regex assertion may match: assistant `text` blocks scoped
// to assistant-type events only, plus the terminal result's `result` string
// when it is a string. This scoping is what stops a prompt echo or a tool
// result from satisfying a response_regex.
function assistantText(traceFile) {
  const out = [];
  let text;
  try {
    text = fs.readFileSync(traceFile, 'utf8');
  } catch {
    return '';
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
    if (parsed.type === 'assistant') {
      for (const obj of walkObjects(parsed)) {
        if (obj.type === 'text' && typeof obj.text === 'string') out.push(obj.text);
      }
    }
    for (const obj of walkObjects(parsed)) {
      if (obj.type === 'result') resultEvent = obj; // last one wins: the terminal event
    }
  }
  if (resultEvent && typeof resultEvent.result === 'string') out.push(resultEvent.result);
  return out.join('\n');
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

// A case's optional `setup` names a direct-child .js file under
// fixtures/behavioral/, run only by --run. Shared by lintCase, the modeRun
// pre-spawn guard, and scoreCase so the three sites can't drift apart.
function setupIsSafe(setup) {
  return idIsPathSafe(setup) && setup.endsWith('.js');
}

// A case's optional `allowed_tools` widens --run's fixed acceptEdits posture
// with an explicit tool allowlist instead of a bypass mode: a non-empty
// array of bare tool names (no parenthesised scoping, unverified against the
// current CLI), each matching /^[A-Za-z][A-Za-z0-9_]*$/. Shared by lintCase,
// the modeRun pre-spawn guard, and scoreCase so the three sites can't drift
// apart.
function allowedToolsIsValid(tools) {
  return (
    Array.isArray(tools) &&
    tools.length > 0 &&
    tools.every((t) => typeof t === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(t))
  );
}

// A trace_agent_dispatch_names assertion's `expect`/`forbid` are each a
// non-empty array of agent names matching AGENT_NAME_PATTERN. Shared by
// lintCase, scoreCase, and the modeRun roster preflight so the three sites
// can't drift apart. The grammar matters beyond shape: these names get
// interpolated into a `<name>.md` path under ~/.claude/agents by the
// preflight, so a name outside this pattern could escape that directory.
function agentNameListIsValid(names) {
  return (
    Array.isArray(names) &&
    names.length > 0 &&
    names.every((n) => typeof n === 'string' && AGENT_NAME_PATTERN.test(n))
  );
}

// Validates the assertions COLLECTION itself (missing, null, not an array, or
// empty), shared by lintCase, the modeRun pre-spawn guard, and scoreCase so
// the three sites can't disagree about what a well-formed collection is. Must
// run before any code iterates `assertions`: a missing/null/non-array value
// would otherwise throw on the first `for...of`. Returns a problem string, or
// '' when the collection is at least structurally iterable.
function assertionCollectionProblems(assertions) {
  if (!Array.isArray(assertions) || assertions.length === 0) return 'missing assertions';
  return '';
}

// Per-assertion shape validation, shared by lintCase (corpus lint) and
// scoreCase (--check/--run scoring), so the two can never drift apart: a
// restated copy of this condition in scoreCase's own words would leave the
// exact hole this predicate exists to close. Returns an array of problem
// descriptions (empty when the assertion is structurally well-formed); an
// empty array does not vouch for the assertion's semantic outcome, only its
// shape.
function assertionShapeProblems(a) {
  const problems = [];
  const kind = a && a.kind;
  if (kind === 'file_regex') {
    if (!a || typeof a.path !== 'string' || a.path === '') {
      problems.push('missing path');
    } else if (!relPathIsContained(a.path)) {
      problems.push(`unsafe path '${a.path}': must stay inside the case dir`);
    }
    if (!a || typeof a.regex !== 'string' || a.regex === '') {
      problems.push('missing regex');
    } else {
      try {
        new RegExp(a.regex, a.flags);
      } catch (e) {
        problems.push(`regex does not compile: ${e.message}`);
      }
    }
  } else if (kind === 'response_regex') {
    if (!a || typeof a.regex !== 'string' || a.regex === '') {
      problems.push('missing regex');
    } else {
      try {
        new RegExp(a.regex, a.flags);
      } catch (e) {
        problems.push(`regex does not compile: ${e.message}`);
      }
    }
  } else if (kind === 'trace_agent_dispatch_count') {
    // A min of 0 asserts nothing UNLESS max is also given: {min:0,max:0}
    // is a real assertion ("no dispatches"), so only a bare min:0 with no
    // max is the vacuous case.
    if (!(Number.isInteger(a.min) && a.min >= 0)) {
      problems.push('min must be an integer >= 0');
    } else if (a.min === 0 && a.max === undefined) {
      problems.push('a min of 0 asserts nothing unless max is also given');
    }
    if (a.max !== undefined && !(Number.isInteger(a.max) && a.max >= a.min)) {
      problems.push('max must be an integer >= min');
    }
  } else if (kind === 'trace_agent_dispatch_names') {
    if (a.expect === undefined && a.forbid === undefined) {
      problems.push('needs expect, forbid, or both: an assertion with neither asserts nothing');
    } else {
      let expectValid = true;
      let forbidValid = true;
      if (a.expect !== undefined && !agentNameListIsValid(a.expect)) {
        expectValid = false;
        problems.push('expect must be a non-empty array of agent names matching /^[a-z][a-z0-9-]*$/');
      }
      if (a.forbid !== undefined && !agentNameListIsValid(a.forbid)) {
        forbidValid = false;
        problems.push('forbid must be a non-empty array of agent names matching /^[a-z][a-z0-9-]*$/');
      }
      if (a.expect !== undefined && a.forbid !== undefined && expectValid && forbidValid) {
        const sharedNames = a.expect.filter((n) => a.forbid.includes(n));
        if (sharedNames.length > 0) {
          problems.push(`expect and forbid must not name the same agent: ${sharedNames.join(', ')}`);
        }
      }
    }
  } else {
    problems.push('kind must be file_regex, response_regex, trace_agent_dispatch_count, or trace_agent_dispatch_names');
  }
  return problems;
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

  if (c.setup !== undefined) {
    if (!setupIsSafe(c.setup)) {
      problems.push(`invalid setup '${c.setup}': must be a direct-child .js file, no path syntax`);
    } else if (!isFile(path.join(fixturesDir, c.setup))) {
      problems.push(`setup script not found: ${c.setup}`);
    }
  }

  if (c.allowed_tools !== undefined && !allowedToolsIsValid(c.allowed_tools)) {
    problems.push(
      `invalid allowed_tools ${JSON.stringify(c.allowed_tools)}: must be a non-empty array of bare ` +
        'tool names matching /^[A-Za-z][A-Za-z0-9_]*$/'
    );
  }

  const assertionsProblem = assertionCollectionProblems(c.assertions);
  if (assertionsProblem) {
    problems.push(assertionsProblem);
  } else {
    c.assertions.forEach((a, i) => {
      for (const problem of assertionShapeProblems(a)) {
        problems.push(`assertions[${i}]: ${problem}`);
      }
    });
  }

  return { id: c.id ?? null, problem_count: problems.length, problems };
}

// Whether a run's metadata indicates a clean run: no interruption, timeout,
// spawn error, truncation, non-null signal, or nonzero exit code. Factored
// out so readRunMetadata (disk-backed, used by scoreCase/--check) and
// modeRun's in-memory setup-artifact buffering (below) share one judgment of
// "clean" rather than restating it.
function metadataIsClean(metadata) {
  if (metadata.interrupted) return { clean: false, reason: 'live run interrupted' };
  if (metadata.timed_out) return { clean: false, reason: 'live run timed out' };
  if (metadata.spawn_error !== null) {
    return { clean: false, reason: `live run spawn error: ${metadata.spawn_error}` };
  }
  if (metadata.stdout_truncated || metadata.stderr_truncated) {
    return { clean: false, reason: 'live run output truncated' };
  }
  if (metadata.signal !== null) return { clean: false, reason: `live run ended by signal ${metadata.signal}` };
  if (metadata.exit_code !== 0) return { clean: false, reason: `live run exited ${metadata.exit_code}` };
  return { clean: true, reason: '' };
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
  const outcome = metadataIsClean(metadata);
  return { present: true, clean: outcome.clean, reason: outcome.reason, metadata };
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

  // Parity with the unsafe-assertion-path guard below: a hand-assembled
  // corpus can carry an unsafe setup value that modeRun's pre-spawn guard
  // never saw.
  if (c.setup !== undefined && !setupIsSafe(c.setup)) {
    return { id, status: 'invalid', reason: `invalid setup '${c.setup}': path syntax not allowed`, activated };
  }

  // Same parity concern for allowed_tools: a hand-assembled corpus can carry
  // a malformed value that modeRun's pre-spawn guard never saw.
  if (c.allowed_tools !== undefined && !allowedToolsIsValid(c.allowed_tools)) {
    return {
      id,
      status: 'invalid',
      reason: `invalid allowed_tools: does not match the required grammar`,
      activated,
    };
  }

  // Absent setup metadata (no `<id>.setup.meta.json`) is tolerated as if
  // setup ran cleanly, same legacy tolerance as the agent-run metadata below.
  const setupMetadata = readRunMetadata(path.join(resultsDir, `${id}.setup.meta.json`));
  if (!setupMetadata.clean) {
    return { id, status: 'invalid', reason: `setup: ${setupMetadata.reason}`, activated };
  }

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

  // Validate the COLLECTION before iterating it: a missing/null/non-array
  // `assertions` would otherwise throw in the loop below instead of scoring
  // this one case invalid.
  const assertionsProblem = assertionCollectionProblems(c.assertions);
  if (assertionsProblem) {
    return { id, status: 'invalid', reason: assertionsProblem, activated };
  }

  const caseDir = path.join(resultsDir, id);
  for (const a of c.assertions) {
    // Same shape predicate lintCase uses: a malformed assertion (missing
    // min/max, missing regex, etc.) is scored invalid here, never coerced
    // into a pass by the comparisons below and never an uncaught throw.
    const shapeProblems = assertionShapeProblems(a);
    if (shapeProblems.length > 0) {
      return {
        id,
        status: 'invalid',
        reason: `malformed assertion (${a && a.kind}): ${shapeProblems.join('; ')}`,
        activated,
      };
    }
    if (a.kind === 'trace_agent_dispatch_count') {
      const count = agentDispatchCount(trace);
      const suffix = a.max !== undefined ? ` max ${a.max}` : '';
      if (count < a.min || (a.max !== undefined && count > a.max)) {
        return {
          id,
          status: 'fail',
          reason: `assertion failed: ${count} subagent dispatches, expected min ${a.min}${suffix}`,
          activated,
        };
      }
      continue;
    }
    if (a.kind === 'trace_agent_dispatch_names') {
      const names = agentDispatchNames(trace);
      const seen = new Set(names.map((n) => n.toLowerCase()));
      if (a.forbid !== undefined) {
        const hit = a.forbid.find((n) => seen.has(n.toLowerCase()));
        if (hit !== undefined) {
          return {
            id,
            status: 'fail',
            reason: `assertion failed: dispatched forbidden agent ${hit}, from [${names.join(', ')}]`,
            activated,
          };
        }
      }
      if (a.expect !== undefined && !a.expect.some((n) => seen.has(n.toLowerCase()))) {
        return {
          id,
          status: 'fail',
          reason: `assertion failed: dispatched [${names.join(', ')}], expected one of [${a.expect.join(', ')}]`,
          activated,
        };
      }
      continue;
    }
    if (a.kind === 'response_regex') {
      const re = new RegExp(a.regex, a.flags);
      if (!re.test(assistantText(trace))) {
        return {
          id,
          status: 'fail',
          reason: `assertion failed: assistant text !~ /${a.regex}/${a.flags}`,
          activated,
        };
      }
      continue;
    }
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

// The setup child runs git init/add/commit inside the case dir. If GIT_DIR
// (or a sibling GIT_* var) happens to be exported in the calling shell, an
// inherited copy would point those commands at the operator's real
// repository instead, staging and committing a mass deletion there. A
// denylist of individual names must be kept in sync with git's own variable
// set, which is the wrong shape: git also reads GIT_CONFIG_COUNT plus its
// GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> pairs and GIT_CONFIG_SYSTEM, either
// of which can set core.worktree (making `git add -A` read outside the
// fixture) or core.hooksPath (making `git commit` execute an
// operator-supplied hook), and a fixed list would miss them. Strip every
// inherited variable whose name starts with GIT_ instead. The fixture setup
// scripts under fixtures/behavioral/ set GIT_AUTHOR_DATE/GIT_COMMITTER_DATE
// themselves on their own git invocations (spread from this child's own
// process.env, then overridden), so sweeping the INHERITED environment here
// does not break them.
function setupChildEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

// Setup-artifact writes buffered until flushSetupArtifacts runs (below): the
// agent's cwd is resultsDir/<id>, so writing these to resultsDir before the
// agent spawns would let it `ls ..` and see setup output a hand-assembled
// results dir never presents.
function flushSetupArtifacts(resultsDir, id, artifacts) {
  fs.writeFileSync(path.join(resultsDir, `${id}.setup.out`), artifacts.out);
  fs.writeFileSync(path.join(resultsDir, `${id}.setup.err`), artifacts.err);
  fs.writeFileSync(path.join(resultsDir, `${id}.setup.meta.json`), artifacts.meta);
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

  // A trace_agent_dispatch_count or trace_agent_dispatch_names assertion
  // measures what the real installed roster dispatches; without the agents
  // those assertions actually depend on, the measurement would only reflect
  // the sandbox, not the skill. The required set is derived from the corpus:
  // any trace_agent_dispatch_count assertion needs the two reviewer-capable
  // agents, and any trace_agent_dispatch_names assertion needs <name>.md for
  // every name in BOTH its expect and its forbid, since an uninstalled
  // forbidden agent would satisfy a forbid trivially. Checked once, up
  // front, so a whole run doesn't spend on a foregone-invalid case.
  const requiredAgents = new Set();
  if (
    cases.some(
      (c) => Array.isArray(c.assertions) && c.assertions.some((a) => a && a.kind === 'trace_agent_dispatch_count')
    )
  ) {
    requiredAgents.add('architect-reviewer.md');
    requiredAgents.add('security-auditor.md');
  }
  for (const c of cases) {
    if (!Array.isArray(c.assertions)) continue;
    for (const a of c.assertions) {
      if (!a || a.kind !== 'trace_agent_dispatch_names') continue;
      for (const n of Array.isArray(a.expect) ? a.expect : []) requiredAgents.add(`${n}.md`);
      for (const n of Array.isArray(a.forbid) ? a.forbid : []) requiredAgents.add(`${n}.md`);
    }
  }
  if (requiredAgents.size > 0) {
    const agentsDir = path.join(os.homedir(), '.claude', 'agents');
    const requiredList = Array.from(requiredAgents).sort();
    let present = new Set();
    if (isDir(agentsDir)) {
      try {
        present = new Set(fs.readdirSync(agentsDir));
      } catch {}
    }
    const missing = requiredList.filter((entry) => !present.has(entry));
    if (missing.length > 0) {
      die(
        `error: a trace_agent_dispatch_count or trace_agent_dispatch_names assertion needs the roster ` +
          `entries ${requiredList.join(', ')} installed at ${agentsDir}; missing: ${missing.join(', ')} ` +
          '(fix: PT_BYPASS_PERMISSIONS=1 HOME=<sandbox> ./install.sh claude); without them a dispatch ' +
          'assertion measures the sandbox, not the skill.'
      );
    }
  }

  for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
    if (parentInterrupted) break;
    const c = cases[caseIndex];
    // Scored as invalid below; never touch the filesystem (or spend) on an
    // unsafe id/fixture/setup, an invalid allowed_tools, a malformed
    // assertion collection or assertion, or a duplicate id that would
    // collide on <id> paths. Mirrors the existing rule that a failed setup
    // suppresses the agent spawn: a malformed corpus entry must never spend
    // either.
    if (
      !idIsPathSafe(c.id) ||
      !idIsPathSafe(c.fixture) ||
      dups.has(c.id) ||
      (c.setup !== undefined && !setupIsSafe(c.setup)) ||
      (c.allowed_tools !== undefined && !allowedToolsIsValid(c.allowed_tools)) ||
      assertionCollectionProblems(c.assertions) !== '' ||
      c.assertions.some((a) => assertionShapeProblems(a).length > 0)
    ) {
      continue;
    }
    attempted.add(c.id);
    const fixtureDir = path.join(fixturesDir, c.fixture);
    const caseDir = path.join(resultsDir, c.id);
    fs.rmSync(caseDir, { recursive: true, force: true });
    for (const suffix of ['.jsonl', '.err', '.meta.json', '.setup.out', '.setup.err', '.setup.meta.json']) {
      fs.rmSync(path.join(resultsDir, `${c.id}${suffix}`), { force: true });
    }
    fs.cpSync(fixtureDir, caseDir, { recursive: true });

    let setupArtifacts = null;
    if (c.setup !== undefined) {
      const setupRun = await runChildCase(
        caseIndex + 1,
        cases.length,
        `${c.id}:setup`,
        process.execPath,
        // Absolute: the child's cwd is caseDir, not wherever CORPUS was
        // resolved from, so a relative CORPUS would otherwise hand the
        // child a script path Node resolves from the wrong directory.
        [path.resolve(fixturesDir, c.setup)],
        { cwd: caseDir, input: '', env: setupChildEnv() },
        timeoutMs
      );
      setupArtifacts = {
        out: setupRun.stdout,
        err: setupRun.stderr,
        meta: JSON.stringify(setupRun.metadata, null, 2) + '\n',
      };
      if (!metadataIsClean(setupRun.metadata).clean) {
        // Suppress-spawn path: no agent will run to see these, so nothing is
        // gained by holding them back further.
        flushSetupArtifacts(resultsDir, c.id, setupArtifacts);
        continue; // never spend on a broken fixture
      }
    }

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
        ...(c.allowed_tools !== undefined ? ['--allowedTools', ...c.allowed_tools] : []),
      ],
      { cwd: caseDir, input: '' },
      timeoutMs
    );
    // Flushed only now that the agent run has completed (success path).
    if (setupArtifacts) flushSetupArtifacts(resultsDir, c.id, setupArtifacts);
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
