#!/usr/bin/env node
/**
 * Deterministic fixtures for hooks/git-guard.js.
 *
 * PLACEMENT (deliberate documented variant). The written convention in
 * .github/instructions/scripts.instructions.md places a hook's fixture
 * runner and cases at hooks/<harness>/scripts/ and hooks/<harness>/fixtures/
 * (e.g. hooks/claude/scripts/run-plan-gate-fixtures.js next to
 * hooks/claude/plan-gate.js). That convention reflects every hook tested so
 * far being harness-specific. git-guard.js is not: it is one shared script
 * exercised across all three wire dialects from a single process, so its
 * fixtures sit one level up, at hooks/scripts/ and hooks/fixtures/git-guard/,
 * mirroring git-guard.js's own placement one level up from hooks/<harness>/.
 * Same spirit as core-rules-digest.js's documented --copilot branch: a
 * shared script gets a placement variant recorded here rather than forced
 * into a harness-specific slot it doesn't fit.
 *
 * Each case in fixtures/git-guard/cases.json is fully declarative: a list of
 * steps, each naming a wire dialect (or a raw/custom payload for malformed-
 * input cases), a command, optional env overrides, an optional
 * backdateMarkersMs (see below), and the expected decision. This runner
 * spawns the real hooks/git-guard.js process per step (never calls its
 * internals directly) and asserts the resulting decision shape. Every case
 * gets its own scratch TMPDIR (git-guard.js derives its state dir from
 * os.tmpdir()), so cases never leak session state into each other and a
 * case's own steps (e.g. a deny-then-retry pair) share one session
 * deliberately. Because each invocation of this runner creates fresh,
 * uniquely-named scratch directories (mkdtempSync) and removes them when
 * done, running the suite twice in a row is expected to produce identical
 * results.
 *
 * backdateMarkersMs (step field, number): before this step's payload is
 * spawned, every marker file that already exists in this case's session
 * directory has its mtime/atime pushed back by this many milliseconds via
 * fs.utimesSync, ported from hooks/claude/scripts/run-plan-gate-fixtures.js's
 * own back-dating (see its attributionDenyOnceRetryAllowed). It exists
 * because git-guard.js's deny-once posture only lets a retry pass once its
 * marker is older than RACE_MS (2000ms), and this runner's steps spawn real
 * subprocesses back-to-back (single-digit milliseconds apart): a real sleep
 * long enough to clear that threshold would make the suite slow and, on a
 * loaded machine, flaky, where back-dating is instant and deterministic.
 */
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'git-guard.js');
const CASES = path.join(__dirname, '..', 'fixtures', 'git-guard', 'cases.json');

function defaultSession(id) {
  return 'gg-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 58);
}

// Fresh, isolated TMPDIR per case: git-guard.js's STATE_DIR is derived from
// os.tmpdir(), which reads TMPDIR/TEMP/TMP, so overriding those for the
// spawned child gives each case its own state root. Any ambient GITGUARD_*
// env var is stripped so a dev shell's exported flags can't leak into a case
// that didn't ask for them.
function scratchEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GITGUARD_')) delete env[key];
  }
  return env;
}

function buildPayload(caseId, stepIndex, step, session) {
  if (typeof step.rawStdin === 'string') return step.rawStdin;
  if (step.input) return JSON.stringify(step.input);

  switch (step.dialect) {
    case 'snake':
      return JSON.stringify({
        session_id: session,
        tool_name: step.toolName || 'Bash',
        tool_input: { command: step.command },
      });
    case 'snake-non-bash':
      return JSON.stringify({
        session_id: session,
        tool_name: step.toolName || 'Read',
        tool_input: {},
      });
    case 'copilot-bash':
      return JSON.stringify({
        sessionId: session,
        toolName: 'bash',
        toolArgs: JSON.stringify({ command: step.command }),
      });
    case 'copilot-powershell':
      return JSON.stringify({
        sessionId: session,
        toolName: 'powershell',
        toolArgs: JSON.stringify({ command: step.command }),
      });
    case 'copilot-object-args':
      return JSON.stringify({
        sessionId: session,
        toolName: step.toolName || 'bash',
        toolArgs: { command: step.command },
      });
    case 'copilot-non-gated':
      return JSON.stringify({
        sessionId: session,
        toolName: step.toolName || 'view',
        toolArgs: JSON.stringify({}),
      });
    default:
      throw new Error(`case ${caseId} step ${stepIndex}: unknown dialect ${step.dialect}`);
  }
}

function isCopilotDialect(step) {
  return typeof step.dialect === 'string' && step.dialect.indexOf('copilot') === 0;
}

// Mirrors git-guard.js's sessionDir() key derivation for the plain-id
// branch only: every session this runner generates (defaultSession's
// sanitized 'gg-<id>' form, and any case-level "session" override) is
// expected to already match git-guard.js's own /^[a-zA-Z0-9_-]{1,64}$/ test,
// which is the branch that uses the session id verbatim as the state-dir
// key. If a case ever needs a session id that fails that test, this throws
// rather than silently reimplementing git-guard.js's sha256 hash fallback.
function sessionKey(session) {
  const sid = String(session || '').trim();
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(sid)) return sid;
  throw new Error(
    `session id "${session}" needs git-guard.js's hash fallback, not implemented in this runner`
  );
}

// See the backdateMarkersMs header doc above for why this exists. Ages every
// marker file already present in this case's session directory; throws if
// the directory doesn't exist yet, since a backdateMarkersMs step with
// nothing to age is a case-authoring mistake, not a silent no-op.
function backdateMarkers(caseId, stepIndex, root, session, ms) {
  const dir = path.join(root, 'claude-git-guard', sessionKey(session));
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    throw new Error(
      `case ${caseId} step ${stepIndex}: backdateMarkersMs requested but no marker directory at ${dir} (${err.message})`
    );
  }
  const aged = new Date(Date.now() - ms);
  for (const entry of entries) {
    fs.utimesSync(path.join(dir, entry), aged, aged);
  }
}

function checkExpectation(caseId, stepIndex, step, result) {
  const label = `case ${caseId} step ${stepIndex}`;
  const stdout = result.stdout;
  const copilot = isCopilotDialect(step);

  if (step.expect === 'deny') {
    const parsed = JSON.parse(stdout);
    let reason;
    if (copilot) {
      assert.strictEqual(parsed.permissionDecision, 'deny', `${label}: expected copilot deny, got ${stdout}`);
      reason = parsed.permissionDecisionReason;
    } else {
      assert.ok(parsed.hookSpecificOutput, `${label}: expected hookSpecificOutput, got ${stdout}`);
      assert.strictEqual(
        parsed.hookSpecificOutput.permissionDecision,
        'deny',
        `${label}: expected snake deny, got ${stdout}`
      );
      reason = parsed.hookSpecificOutput.permissionDecisionReason;
    }
    for (const needle of step.expectContains || []) {
      assert.ok(reason.includes(needle), `${label}: reason missing "${needle}": ${reason}`);
    }
    for (const needle of step.expectExcludes || []) {
      assert.ok(!reason.includes(needle), `${label}: reason should not contain "${needle}": ${reason}`);
    }
    return;
  }

  if (step.expect === 'warn') {
    if (copilot) {
      assert.strictEqual(
        stdout,
        JSON.stringify({ permissionDecision: 'allow' }),
        `${label}: copilot warn should degrade to explicit allow, got ${stdout}`
      );
      assert.ok(result.stderr.includes('(warn)'), `${label}: expected a (warn) stderr note, got: ${result.stderr}`);
      for (const needle of step.expectContains || []) {
        assert.ok(result.stderr.includes(needle), `${label}: stderr missing "${needle}": ${result.stderr}`);
      }
    } else {
      const parsed = JSON.parse(stdout);
      assert.ok(parsed.hookSpecificOutput, `${label}: expected hookSpecificOutput, got ${stdout}`);
      assert.strictEqual(
        typeof parsed.hookSpecificOutput.additionalContext,
        'string',
        `${label}: expected additionalContext, got ${stdout}`
      );
      assert.strictEqual(
        parsed.hookSpecificOutput.permissionDecision,
        undefined,
        `${label}: warn must not carry a permissionDecision, got ${stdout}`
      );
      for (const needle of step.expectContains || []) {
        assert.ok(
          parsed.hookSpecificOutput.additionalContext.includes(needle),
          `${label}: additionalContext missing "${needle}": ${parsed.hookSpecificOutput.additionalContext}`
        );
      }
    }
    return;
  }

  if (step.expect === 'allow') {
    const style = step.allowStyle || (copilot ? 'explicit' : 'silent');
    if (style === 'silent') {
      assert.strictEqual(stdout, '', `${label}: expected silent allow, got ${stdout}`);
    } else {
      assert.strictEqual(
        stdout,
        JSON.stringify({ permissionDecision: 'allow' }),
        `${label}: expected explicit allow, got ${stdout}`
      );
    }
    return;
  }

  throw new Error(`${label}: unknown expect "${step.expect}"`);
}

function runCase(fixtureCase) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-guard-fixtures-'));
  const baseEnv = { ...scratchEnv(), TEMP: root, TMP: root, TMPDIR: root };
  const session = fixtureCase.session || defaultSession(fixtureCase.id);
  try {
    fixtureCase.steps.forEach((step, stepIndex) => {
      if (typeof step.backdateMarkersMs === 'number') {
        backdateMarkers(fixtureCase.id, stepIndex, root, session, step.backdateMarkersMs);
      }
      const env = { ...baseEnv, ...(fixtureCase.env || {}), ...(step.env || {}) };
      const payload = buildPayload(fixtureCase.id, stepIndex, step, session);
      const result = childProcess.spawnSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        env,
        input: payload,
      });
      assert.strictEqual(
        result.status,
        0,
        `case ${fixtureCase.id} step ${stepIndex}: nonzero exit (${result.status}), stderr: ${result.stderr}`
      );
      checkExpectation(fixtureCase.id, stepIndex, step, result);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const fixtureCases = JSON.parse(fs.readFileSync(CASES, 'utf8')).cases;
  let failures = 0;
  for (const fixtureCase of fixtureCases) {
    try {
      runCase(fixtureCase);
      process.stdout.write(`PASS ${fixtureCase.id}\n`);
    } catch (err) {
      process.stdout.write(`FAIL ${fixtureCase.id}: ${(err && err.stack) || err}\n`);
      failures += 1;
    }
  }
  process.stdout.write(`${fixtureCases.length - failures}/${fixtureCases.length} cases passed\n`);
  process.exit(failures ? 1 : 0);
}

main();
