#!/usr/bin/env node
/**
 * Deterministic fixtures for the Claude-only suggest-compact.js nudge hook.
 * Mirrors run-plan-gate-fixtures.js's spawnSync + per-case TMPDIR isolation:
 * suggest-compact.js derives its session-keyed state files from os.tmpdir(),
 * which reads TMPDIR/TEMP/TMP, so a fresh scratch root per case keeps cases
 * from leaking state into each other.
 *
 * Each case in fixtures/suggest-compact/cases.json is a sequence of
 * PreToolUse calls against one session. A call group's `tokens` is the
 * context size written to the transcript's latest assistant usage record
 * (null means no transcript_path at all), and `repeat` is how many calls
 * share it. `nudgeCalls` lists the 1-based call numbers expected to emit a
 * nudge; every other call must emit nothing. `match` is a regex the last
 * nudge's text must satisfy, and `noToolCountState` asserts the removed
 * tool-call counter's state file is never written. The cases cover the context-size signal (fires above
 * its threshold, silent below, re-fires per interval, proven-1M scaling,
 * env overrides) and that the tool-call count alone, however high, never
 * nudges.
 */
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'suggest-compact.js');
const CASES = path.join(__dirname, '..', 'fixtures', 'suggest-compact', 'cases.json');
const SESSION = 'sess-suggest-compact';

function run(input, env) {
  const result = childProcess.spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env,
    input: JSON.stringify(input),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stderr, '', 'hook wrote to stderr');
  return result.stdout;
}

// Fresh scratch root per case; any ambient COMPACT_* or session env var is
// stripped so a dev shell's exports can't leak into a case that didn't ask.
function fixture(extraEnv) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suggest-compact-'));
  const env = { ...process.env, TEMP: root, TMP: root, TMPDIR: root };
  for (const key of Object.keys(env)) {
    if (key.startsWith('COMPACT_') || key === 'CLAUDE_SESSION_ID') delete env[key];
  }
  return { env: { ...env, ...extraEnv }, root };
}

function writeTranscript(root, tokens) {
  const file = path.join(root, 'transcript.jsonl');
  const record = { message: { role: 'assistant', usage: { input_tokens: tokens } } };
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user' })}\n${JSON.stringify(record)}\n`);
  return file;
}

function runCase(c) {
  const f = fixture(c.env);
  let callNumber = 0;
  const nudged = [];
  let lastText = '';
  for (const group of c.calls) {
    for (let i = 0; i < group.repeat; i++) {
      callNumber += 1;
      const input = { session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'true' } };
      if (group.tokens !== null) input.transcript_path = writeTranscript(f.root, group.tokens);
      if (c.subagent) input.agent_id = 'agent-1';
      const out = run(input, f.env);
      if (out === '') continue;
      nudged.push(callNumber);
      const parsed = JSON.parse(out);
      const text = parsed.systemMessage;
      assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.strictEqual(parsed.hookSpecificOutput.additionalContext, text);
      assert.match(text, /^\[StrategicCompact\] /);
      lastText = text;
    }
  }
  if (c.match) assert.match(lastText, new RegExp(c.match));
  assert.deepStrictEqual(nudged, c.nudgeCalls, `nudged on calls ${JSON.stringify(nudged)}`);
  if (c.noToolCountState) {
    // The tool-call counter is gone; no state file for it may be written.
    const leftovers = fs.readdirSync(f.root).filter((name) => name.startsWith('claude-tool-count-'));
    assert.deepStrictEqual(leftovers, [], 'tool-count state file written');
  }
  fs.rmSync(f.root, { recursive: true, force: true });
}

function main() {
  const cases = JSON.parse(fs.readFileSync(CASES, 'utf8')).cases;
  let failures = 0;
  for (const c of cases) {
    try {
      runCase(c);
      process.stdout.write(`PASS ${c.id}\n`);
    } catch (err) {
      process.stdout.write(`FAIL ${c.id}: ${(err && err.message) || err}\n`);
      failures += 1;
    }
  }
  process.exit(failures ? 1 : 0);
}

main();
