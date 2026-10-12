#!/usr/bin/env node
/**
 * Deterministic classifier fixtures for the Claude-only plan-gate.js
 * mutation gate. Mirrors hooks/codex/scripts/run-plan-gate-pilot-fixtures.js's
 * spawnSync + per-case TMPDIR isolation, but each case here is one PreToolUse
 * event (plan-gate.js has no --pre/--post phases).
 *
 * Every case exercises detectOutwardMutations()/splitShellSegments() through
 * the real hook process (not the functions in isolation), and every allow
 * case proves the hook actually classified/recorded something (a marker
 * file, or a subsequent call's count) rather than a silent no-op scoring as
 * a passing allow.
 */
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'plan-gate.js');
const CASES = path.join(__dirname, '..', 'fixtures', 'plan-gate', 'cases.json');

function run(input, env) {
  const result = childProcess.spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env,
    input: typeof input === 'string' ? input : JSON.stringify(input),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}

// Fresh, isolated STATE_DIR per case: plan-gate.js derives its state dir from
// os.tmpdir(), which reads TMPDIR/TEMP/TMP, so a fresh scratch root per case
// guarantees no cross-case state leakage. Any ambient PLANGATE_* env var is
// stripped so a dev shell's exported flags can't leak into a case that
// didn't ask for them.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-gate-'));
  const env = { ...process.env, TEMP: root, TMP: root, TMPDIR: root };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PLANGATE_')) delete env[key];
  }
  return { env, root };
}

function bashEvent(command, session, cwd) {
  const event = { session_id: session, tool_name: 'Bash', tool_input: { command } };
  if (cwd) event.cwd = cwd;
  return event;
}

function skillEvent(session) {
  return { session_id: session, tool_name: 'Skill', tool_input: { skill: 'plan-and-track' } };
}

function writeEvent(session, filePath, content) {
  return { session_id: session, tool_name: 'Write', tool_input: { file_path: filePath, content } };
}

// Real on-disk .tasks/todo.md under the case's own scratch root: the
// main-attribution guard's simulateResult() reads the baseline off disk, so
// there is no shortcut around writing one.
function todoPath(root) {
  return path.join(root, '.tasks', 'todo.md');
}

function writeTodo(root, content) {
  const p = todoPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function mainAttrMarker(root, session) {
  return stampFile(root, session) + '.mainattr';
}

// Session ids below are all plain alphanumeric-plus-hyphen, so plan-gate.js's
// stampPath() uses the session id verbatim as the state-dir key (no sha256
// fallback), which lets these helpers locate marker files without
// reimplementing the hash path.
function stateDir(root) {
  return path.join(root, 'claude-plan-gate');
}

function mutationsDir(root, session) {
  return path.join(stateDir(root), session) + '.mutations';
}

function mutationMarker(root, session, kind) {
  return path.join(mutationsDir(root, session), kind);
}

function stampFile(root, session) {
  return path.join(stateDir(root), session);
}

function denyReason(stdout) {
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
  return parsed.hookSpecificOutput.permissionDecisionReason;
}

async function npmTestSilent() {
  const f = fixture();
  const session = 'sess-npm-test';
  assert.strictEqual(run(bashEvent('npm test', session), f.env), '');
  // Fast path: a zero-kind command must do NO filesystem work at all.
  assert.strictEqual(fs.existsSync(mutationsDir(f.root, session)), false);
  // Proof the engine is alive: a real mutation afterward in the same session
  // is still counted from zero, not pre-inflated by the npm test call.
  assert.strictEqual(run(bashEvent('git push origin main', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'git-push')), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function gitPushHelpSilent() {
  const f = fixture();
  const session = 'sess-push-help';
  assert.strictEqual(run(bashEvent('git push --help', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationsDir(f.root, session)), false);
  assert.strictEqual(run(bashEvent('gh pr merge 1', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'gh-pr-merge')), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function gitPushDryRunSilent() {
  const f = fixture();
  const session = 'sess-push-dry-run';
  assert.strictEqual(run(bashEvent('git push --dry-run', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationsDir(f.root, session)), false);
  assert.strictEqual(run(bashEvent('gh pr create --fill', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'gh-pr-create')), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function ghPrViewSilent() {
  const f = fixture();
  const session = 'sess-pr-view';
  assert.strictEqual(run(bashEvent('gh pr view 123', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationsDir(f.root, session)), false);
  assert.strictEqual(run(bashEvent('git push origin main', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'git-push')), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function quoteAwareCommitNoMutation() {
  const f = fixture();
  const session = 'sess-quote-commit';
  assert.strictEqual(run(bashEvent('git commit -m "then git push"', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationsDir(f.root, session)), false);
  assert.strictEqual(run(bashEvent('git push origin main', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'git-push')), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function heredocBodyStripsGitPush() {
  const f = fixture();
  const session = 'sess-heredoc';
  const command = 'gh pr create --body-file - <<EOF\nSome body mentioning git push here.\nEOF';
  assert.strictEqual(run(bashEvent(command, session), f.env), '');
  // The real (non-heredoc) gh pr create is counted...
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'gh-pr-create')), true);
  // ...but the heredoc body's "git push" text must never be.
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'git-push')), false);
  assert.strictEqual(fs.readdirSync(mutationsDir(f.root, session)).length, 1);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function gitCGlobalOptCounts() {
  const f = fixture();
  const session = 'sess-git-c';
  assert.strictEqual(run(bashEvent('git -C /tmp/x push', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'git-push')), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function ghRGlobalOptCounts() {
  const f = fixture();
  const session = 'sess-gh-r';
  assert.strictEqual(run(bashEvent('gh -R o/r pr merge', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'gh-pr-merge')), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function thresholdEscalationDeniesSecond() {
  const f = fixture();
  const session = 'sess-escalation';
  assert.strictEqual(run(bashEvent('git push origin main', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'git-push')), true);
  const reason = denyReason(run(bashEvent('gh pr create --fill', session), f.env));
  assert.match(reason, /2 distinct outward git\/gh mutations/);
  // A real deny must not record the new kind (it would inflate the count on retry).
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'gh-pr-create')), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function singleCallUnionDenies() {
  const f = fixture();
  const session = 'sess-single-call-union';
  const reason = denyReason(run(bashEvent('git push && gh pr create && gh pr merge', session), f.env));
  assert.match(reason, /2 distinct outward git\/gh mutations/);
  assert.strictEqual(fs.existsSync(mutationsDir(f.root, session)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function stampedSessionBypassesThreshold() {
  const f = fixture();
  const session = 'sess-stamped';
  assert.strictEqual(run(bashEvent('git push origin main', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'git-push')), true);
  assert.strictEqual(run(skillEvent(session), f.env), '');
  assert.strictEqual(fs.existsSync(stampFile(f.root, session)), true);
  // Without the stamp this second call would union to 2 >= threshold and
  // deny (see thresholdEscalationDeniesSecond above); the stamp must
  // bypass the mutation gate entirely, so this proves the stamp check
  // actually ran rather than the gate having silently no-opped.
  assert.strictEqual(run(bashEvent('gh pr create --fill', session), f.env), '');
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function warnModeDemotes() {
  const f = fixture();
  const session = 'sess-warn';
  const env = { ...f.env, PLANGATE_WARN: '1' };
  assert.strictEqual(run(bashEvent('git push origin main', session), env), '');
  const stdout = run(bashEvent('gh pr create --fill', session), env);
  assert.notStrictEqual(stdout, '');
  const parsed = JSON.parse(stdout);
  assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, undefined);
  assert.match(parsed.hookSpecificOutput.additionalContext, /2 distinct outward git\/gh mutations/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /Warn-only mode/);
  // Warn mode still proceeds, so the mutation is recorded (unlike a real deny).
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'gh-pr-create')), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function disabledModeSilent() {
  const f = fixture();
  const session = 'sess-disabled';
  const env = { ...f.env, PLANGATE_DISABLED: '1' };
  assert.strictEqual(run(bashEvent('git push origin main', session), env), '');
  assert.strictEqual(fs.existsSync(mutationsDir(f.root, session)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function mutationThresholdOneDeniesFirst() {
  const f = fixture();
  const session = 'sess-threshold-one';
  const env = { ...f.env, PLANGATE_MUTATION_THRESHOLD: '1' };
  const reason = denyReason(run(bashEvent('git push origin main', session), env));
  assert.match(reason, /1 distinct outward git\/gh mutations/);
  assert.strictEqual(fs.existsSync(mutationsDir(f.root, session)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function heredocHyphenDelimBodyNotClassified() {
  const f = fixture();
  const session = 'sess-heredoc-hyphen';
  // A non-identifier delimiter ('END-PR' has a hyphen) must still open a
  // heredoc, so the body's "git push" text is stripped, not classified.
  const command = "gh pr create --body-file - <<'END-PR'\nremember to git push once this merges\nEND-PR";
  assert.strictEqual(run(bashEvent(command, session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'gh-pr-create')), true);
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'git-push')), false);
  assert.strictEqual(fs.readdirSync(mutationsDir(f.root, session)).length, 1);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function quotedHeredocOpNotHiding() {
  const f = fixture();
  const session = 'sess-quoted-heredoc-op';
  // The `<<EOF` is inside double quotes, so it is NOT a heredoc operator and
  // must not swallow the real `git push` that follows the `;`.
  const command = 'echo "see <<EOF for usage" ; git push origin main';
  assert.strictEqual(run(bashEvent(command, session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'git-push')), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function commentStripsFollowingCommand() {
  const f = fixture();
  const session = 'sess-comment';
  // `# ...` is a comment, so the `git push` after it never runs and must not
  // be classified.
  assert.strictEqual(run(bashEvent('echo done # then git push origin main', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationsDir(f.root, session)), false);
  // Liveness: a real git push in the same session is still counted from zero.
  assert.strictEqual(run(bashEvent('git push origin main', session), f.env), '');
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'git-push')), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// --- Main-attribution guard cases ---
//
// Each case stamps the session (Skill event) before touching .tasks/todo.md,
// since maybeGuardMainAttribution only runs once the session is already
// stamped, then issues a Write event carrying the full post-edit content
// (simulateResult() reads the pre-edit baseline straight off disk, so the
// baseline file must actually exist there first).

async function newStepUserAttributionDenied() {
  const f = fixture();
  const session = 'sess-mainattr-new';
  const todo = writeTodo(f.root, '## Plan\n- [ ] existing step (executor)\n');
  assert.strictEqual(run(skillEvent(session), f.env), '');
  const content = '## Plan\n- [ ] existing step (executor)\n- [ ] new step (main: user disabled subagent delegation this session)\n';
  const reason = denyReason(run(writeEvent(session, todo, content), f.env));
  assert.match(reason, /reads as a claim about what the user did/);
  assert.strictEqual(fs.existsSync(mainAttrMarker(f.root, session)), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function attributionDenyOnceRetryAllowed() {
  const f = fixture();
  const session = 'sess-mainattr-retry';
  const todo = writeTodo(f.root, '## Plan\n- [ ] existing step (executor)\n');
  assert.strictEqual(run(skillEvent(session), f.env), '');
  const content = '## Plan\n- [ ] existing step (executor)\n- [ ] new step (main: user disabled subagent delegation this session)\n';
  const reason = denyReason(run(writeEvent(session, todo, content), f.env));
  assert.match(reason, /reads as a claim about what the user did/);
  const marker = mainAttrMarker(f.root, session);
  assert.strictEqual(fs.existsSync(marker), true);
  // Back-date the marker instead of sleeping in the test suite:
  // maybeGuardMainAttribution's deny-vs-concurrent-retry race check only
  // treats a marker younger than 2000ms as a racing loser, so pushing its
  // mtime into the past makes this immediate retry look like a real
  // model-turn-later retry rather than a race, the same fs.utimesSync
  // back-dating hooks/codex/scripts/run-plan-gate-pilot-fixtures.js already
  // uses for its own staleness checks (see scopeFile there), rather than
  // adding a real sleep.
  const aged = new Date(Date.now() - 5000);
  fs.utimesSync(marker, aged, aged);
  assert.strictEqual(run(writeEvent(session, todo, content), f.env), '');
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function nonAttributionMainReasonAllowed() {
  const f = fixture();
  const session = 'sess-mainattr-factual';
  const todo = writeTodo(f.root, '## Plan\n- [ ] existing step (executor)\n');
  assert.strictEqual(run(skillEvent(session), f.env), '');
  // Mentions "user" but states a fact about the work, not a claim about what
  // the user did: MAIN_USER_ATTRIBUTION_RE must not match this.
  const content = '## Plan\n- [ ] existing step (executor)\n- [ ] new step (main: needs user sign-off mid-step)\n';
  assert.strictEqual(run(writeEvent(session, todo, content), f.env), '');
  assert.strictEqual(fs.existsSync(mainAttrMarker(f.root, session)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function executorTagUnaffectedByAttributionGuard() {
  const f = fixture();
  const session = 'sess-mainattr-executor';
  const todo = writeTodo(f.root, '## Plan\n- [ ] existing step (executor)\n');
  assert.strictEqual(run(skillEvent(session), f.env), '');
  const content = '## Plan\n- [ ] existing step (executor)\n- [ ] new step (executor)\n';
  assert.strictEqual(run(writeEvent(session, todo, content), f.env), '');
  assert.strictEqual(fs.existsSync(mainAttrMarker(f.root, session)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function lintDisabledAllowsAttributionCase() {
  const f = fixture();
  const session = 'sess-mainattr-lintoff';
  const todo = writeTodo(f.root, '## Plan\n- [ ] existing step (executor)\n');
  const env = { ...f.env, PLANGATE_LINT_DISABLED: '1' };
  assert.strictEqual(run(skillEvent(session), env), '');
  const content = '## Plan\n- [ ] existing step (executor)\n- [ ] new step (main: user disabled subagent delegation this session)\n';
  assert.strictEqual(run(writeEvent(session, todo, content), env), '');
  assert.strictEqual(fs.existsSync(mainAttrMarker(f.root, session)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function continuationLineAttributionDenied() {
  const f = fixture();
  const session = 'sess-mainattr-continuation';
  // The checkbox (first) line is IDENTICAL between baseline and result; only
  // the wrapped step's continuation line gains the attribution tag. This is
  // the case collectNewUncheckedPlanSteps's checkbox-line-only newness test
  // misses (it never sees this step as new), and collectChangedUncheckedPlanSteps
  // must catch via the step's whole joined text instead.
  const todo = writeTodo(f.root, '## Plan\n- [ ] wrapped step needs detail\n  more context\n');
  assert.strictEqual(run(skillEvent(session), f.env), '');
  const content = '## Plan\n- [ ] wrapped step needs detail\n  more context (main: user requested this)\n';
  const reason = denyReason(run(writeEvent(session, todo, content), f.env));
  assert.match(reason, /reads as a claim about what the user did/);
  // The tag lives on the continuation line, so firstLine alone would name the
  // step without ever showing what tripped the check. The message must quote
  // the offending reason back, or a wrapped step gets a strictly worse
  // diagnostic than a single-line one.
  assert.match(reason, /offending reason: \(main: user requested this\)/);
  assert.strictEqual(fs.existsSync(mainAttrMarker(f.root, session)), true);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// Default PLANGATE_SCOPE_THRESHOLD is 3, but the deny fires on the write
// that would BRING the count to 3 (wouldBeCount >= threshold), not on a
// fourth write after three allowed ones: two distinct-file writes are
// allowed, and the third is denied (verified against the real hook).
async function subagentScopeDenyNamesCaller() {
  const f = fixture();
  const session = 'sess-subagent-scope';
  assert.strictEqual(run(writeEvent(session, path.join(f.root, 'a.js'), 'x'), f.env), '');
  assert.strictEqual(run(writeEvent(session, path.join(f.root, 'b.js'), 'x'), f.env), '');
  const event = writeEvent(session, path.join(f.root, 'c.js'), 'x');
  event.agent_id = 'a1';
  event.agent_type = 'executor';
  const reason = denyReason(run(event, f.env));
  assert.match(reason, /stop and report to your caller/);
  assert.match(reason, /executor/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function subagentMutationDenyNamesCaller() {
  const f = fixture();
  const session = 'sess-subagent-mutation';
  assert.strictEqual(run(bashEvent('git push origin main', session), f.env), '');
  const event = bashEvent('gh pr create --fill', session);
  event.agent_id = 'a1';
  event.agent_type = 'executor';
  const reason = denyReason(run(event, f.env));
  assert.match(reason, /stop and report to your caller/);
  assert.match(reason, /executor/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function mainThreadDenyHasNoSubagentLine() {
  const f = fixture();
  const session = 'sess-main-thread-scope';
  assert.strictEqual(run(writeEvent(session, path.join(f.root, 'a.js'), 'x'), f.env), '');
  assert.strictEqual(run(writeEvent(session, path.join(f.root, 'b.js'), 'x'), f.env), '');
  const reason = denyReason(run(writeEvent(session, path.join(f.root, 'c.js'), 'x'), f.env));
  assert.match(reason, /3 distinct files/);
  assert.doesNotMatch(reason, /report to your caller/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// The todo gate (gateMsg) through the alternate `agentId` spelling, one of
// the four fields the subagent test accepts.
async function subagentTodoDenyAltIdFieldNamesCaller() {
  const f = fixture();
  const session = 'sess-subagent-todo';
  const event = writeEvent(session, todoPath(f.root), '# Plan\n');
  event.agentId = 'a1';
  event.agent_type = 'mechanic';
  const reason = denyReason(run(event, f.env));
  assert.match(reason, /Writes to \.tasks\/todo\.md are gated/);
  assert.match(reason, /stop and report to your caller/);
  assert.match(reason, /mechanic/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// agent_type alone is set for a whole session launched with --agent, which
// is main-thread: no id field, no subagent line.
async function agentTypeOnlyIsMainThread() {
  const f = fixture();
  const session = 'sess-agent-type-only';
  assert.strictEqual(run(writeEvent(session, path.join(f.root, 'a.js'), 'x'), f.env), '');
  assert.strictEqual(run(writeEvent(session, path.join(f.root, 'b.js'), 'x'), f.env), '');
  const event = writeEvent(session, path.join(f.root, 'c.js'), 'x');
  event.agent_type = 'executor';
  const reason = denyReason(run(event, f.env));
  assert.match(reason, /3 distinct files/);
  assert.doesNotMatch(reason, /report to your caller/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// --- In-flight batch warning cases ---
//
// Same shape as the attribution cases: real baseline on disk, stamp the
// session, then a Write/Edit event. BATCH_BASELINE holds one closed-out batch
// (all [x] plus a Review) and one in-flight batch (an unchecked step).

const BATCH_CLOSED = '## Batch 40: closed batch\n### Plan\n- [x] done step (executor)\n### Review\nShipped.\n\n';
const BATCH_INFLIGHT = '## Batch 41: in-flight work\n### Plan\n- [ ] pending step (executor)\n';
const BATCH_BASELINE = '# Todo\n\n' + BATCH_CLOSED + BATCH_INFLIGHT;

function editEvent(session, filePath, oldString, newString) {
  return { session_id: session, tool_name: 'Edit', tool_input: { file_path: filePath, old_string: oldString, new_string: newString } };
}

// A hook run may emit at most one JSON object: stdout is empty or parses as
// exactly one (two concatenated objects would throw here).
function atMostOneJson(stdout) {
  return stdout === '' ? null : JSON.parse(stdout);
}

function assertInFlightWarning(stdout, batchPattern) {
  const parsed = atMostOneJson(stdout);
  assert.notStrictEqual(parsed, null);
  assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
  const out = parsed.hookSpecificOutput;
  assert.deepStrictEqual(Object.keys(out).sort(), ['additionalContext', 'hookEventName']);
  assert.strictEqual(out.hookEventName, 'PreToolUse');
  assert.strictEqual(out.permissionDecision, undefined);
  assert.match(out.additionalContext, /^\[PlanGate\]/);
  assert.match(out.additionalContext, batchPattern);
  assert.match(out.additionalContext, /not closed out \(no fully checked plan, or no Review section\)/);
  assert.match(out.additionalContext, /another session's in-flight work/);
  assert.match(out.additionalContext, /The write is proceeding/);
  assert.match(out.additionalContext, /put that batch back exactly as it was before your write/);
  assert.match(out.additionalContext, /PLANGATE_DISABLED=1/);
}

async function writeDropsInFlightBatchWarns() {
  const f = fixture();
  const session = 'sess-batch-inflight';
  const todo = writeTodo(f.root, BATCH_BASELINE);
  assert.strictEqual(run(skillEvent(session), f.env), '');
  const content = '# Todo\n\n' + BATCH_CLOSED;
  assertInFlightWarning(run(writeEvent(session, todo, content), f.env), /Batch 41: in-flight work/);
  // No once-marker: the same write warns again.
  assertInFlightWarning(run(writeEvent(session, todo, content), f.env), /Batch 41: in-flight work/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function writeDropsAllCheckedNoReviewBatchWarns() {
  const f = fixture();
  const session = 'sess-batch-noreview';
  const todo = writeTodo(f.root, '# Todo\n\n## Batch 43: checked but unreviewed\n### Plan\n- [x] done step (executor)\n');
  assert.strictEqual(run(skillEvent(session), f.env), '');
  assertInFlightWarning(run(writeEvent(session, todo, '# Todo\n'), f.env), /Batch 43: checked but unreviewed/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function writeDropsReviewedBatchWithoutChecklistWarns() {
  const f = fixture();
  const session = 'sess-batch-nochecklist';
  // A Review heading alone is not closed out: plan-and-track also requires a
  // fully checked Plan checklist, so a batch with no checked step warns.
  const todo = writeTodo(f.root, '# Todo\n\n## Batch 44: reviewed without a checklist\n### Review\nLooked fine.\n');
  assert.strictEqual(run(skillEvent(session), f.env), '');
  assertInFlightWarning(run(writeEvent(session, todo, '# Todo\n'), f.env), /Batch 44: reviewed without a checklist/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function editCompressesClosedBatchSilent() {
  const f = fixture();
  const session = 'sess-batch-compress';
  const todo = writeTodo(f.root, BATCH_BASELINE);
  assert.strictEqual(run(skillEvent(session), f.env), '');
  // The one-line summary is not a heading, so Batch 40 vanishes as a heading
  // but its baseline block was closed out: no warning.
  assert.strictEqual(
    run(editEvent(session, todo, BATCH_CLOSED, 'Batch 40: closed batch: done 2026-10-09\n\n'), f.env),
    ''
  );
  // Liveness: the same compression of the in-flight batch does warn.
  assertInFlightWarning(
    run(editEvent(session, todo, BATCH_INFLIGHT, 'Batch 41: in-flight work: done\n'), f.env),
    /Batch 41: in-flight work/
  );
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function editInsertsNewBatchSilent() {
  const f = fixture();
  const session = 'sess-batch-insert';
  const todo = writeTodo(f.root, BATCH_BASELINE);
  assert.strictEqual(run(skillEvent(session), f.env), '');
  const inserted = '## Batch 42: new work\n### Plan\n- [ ] new step (executor)\n\n' + BATCH_INFLIGHT;
  assert.strictEqual(run(editEvent(session, todo, BATCH_INFLIGHT, inserted), f.env), '');
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function lintDenyWinsOverInFlightWarning() {
  const f = fixture();
  const session = 'sess-batch-lintwins';
  const todo = writeTodo(f.root, BATCH_BASELINE);
  assert.strictEqual(run(skillEvent(session), f.env), '');
  // Drops in-flight Batch 41 AND adds an untagged plan step: one JSON, the
  // tag-lint deny; no second warning JSON.
  const content = '# Todo\n\n' + BATCH_CLOSED + '## Batch 42: new work\n### Plan\n- [ ] untagged new step\n';
  const stdout = run(writeEvent(session, todo, content), f.env);
  assert.notStrictEqual(atMostOneJson(stdout), null);
  assert.match(denyReason(stdout), /need an owner tag/);
  assert.doesNotMatch(stdout, /in-flight work/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function lintDisabledStillWarnsInFlight() {
  const f = fixture();
  const session = 'sess-batch-lintoff';
  const todo = writeTodo(f.root, BATCH_BASELINE);
  const env = { ...f.env, PLANGATE_LINT_DISABLED: '1' };
  assert.strictEqual(run(skillEvent(session), env), '');
  assertInFlightWarning(run(writeEvent(session, todo, '# Todo\n\n' + BATCH_CLOSED), env), /Batch 41: in-flight work/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// --- Review goal-line lint cases ---
//
// Same shape as the in-flight cases: real baseline on disk, stamp the
// session, then a Write/Edit event. Expectations come from the lint's stated
// contract, not from running it: a Review heading new to its `Batch N` block
// needs `Goal met: yes` or `Goal met: partial: <non-empty gap>`, and Reviews
// already on disk never count. Each allow case ends with a liveness deny on
// the same baseline, so a silent no-op can't score as a pass.

const GOAL_BASELINE = '# Todo\n\n## Batch 50: goal work\n### Plan\n- [x] done step (executor)\n';

function goalReview(lines) {
  return GOAL_BASELINE + '### Review\nShipped.\n' + lines;
}

function assertGoalLineDeny(stdout, batchPattern) {
  assert.notStrictEqual(atMostOneJson(stdout), null);
  const reason = denyReason(stdout);
  assert.match(reason, /needs a goal line/);
  assert.match(reason, batchPattern);
  return reason;
}

async function reviewWithoutGoalLineDenied() {
  const f = fixture();
  const session = 'sess-goal-missing';
  const todo = writeTodo(f.root, GOAL_BASELINE);
  assert.strictEqual(run(skillEvent(session), f.env), '');
  assertGoalLineDeny(run(writeEvent(session, todo, goalReview('')), f.env), /Batch 50: goal work/);
  // No once-marker: the identical retry is denied again.
  assertGoalLineDeny(run(writeEvent(session, todo, goalReview('')), f.env), /Batch 50: goal work/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function reviewGoalMetYesAllowed() {
  const f = fixture();
  const session = 'sess-goal-yes';
  const todo = writeTodo(f.root, GOAL_BASELINE);
  assert.strictEqual(run(skillEvent(session), f.env), '');
  assert.strictEqual(run(writeEvent(session, todo, goalReview('Goal met: yes\n')), f.env), '');
  assertGoalLineDeny(run(writeEvent(session, todo, goalReview('')), f.env), /Batch 50: goal work/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function reviewGoalMetPartialWithGapAllowed() {
  const f = fixture();
  const session = 'sess-goal-partial';
  const todo = writeTodo(f.root, GOAL_BASELINE);
  assert.strictEqual(run(skillEvent(session), f.env), '');
  // Edit path, list-item form.
  const added = '- [x] done step (executor)\n### Review\nShipped.\n- Goal met: partial: file is still 40 lines over its size limit\n';
  assert.strictEqual(run(editEvent(session, todo, '- [x] done step (executor)\n', added), f.env), '');
  assertGoalLineDeny(run(writeEvent(session, todo, goalReview('')), f.env), /Batch 50: goal work/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function reviewGoalMetPartialEmptyGapDenied() {
  const f = fixture();
  const session = 'sess-goal-empty-gap';
  const todo = writeTodo(f.root, GOAL_BASELINE);
  assert.strictEqual(run(skillEvent(session), f.env), '');
  // The gap must sit on the Goal met line itself, not be borrowed from the next line.
  assertGoalLineDeny(
    run(writeEvent(session, todo, goalReview('Goal met: partial: \nVerified with npm test.\n')), f.env),
    /Batch 50: goal work/
  );
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function legacyReviewWithoutGoalLineAllowed() {
  const f = fixture();
  const session = 'sess-goal-legacy';
  const todo = writeTodo(f.root, BATCH_BASELINE);
  assert.strictEqual(run(skillEvent(session), f.env), '');
  // Batch 40's Review is already on disk with no goal line: editing its
  // text, or adding a tagged step to Batch 41, is never linted.
  assert.strictEqual(run(editEvent(session, todo, 'Shipped.\n', 'Shipped and tagged.\n'), f.env), '');
  assert.strictEqual(
    run(editEvent(session, todo, '- [ ] pending step (executor)\n', '- [ ] pending step (executor)\n- [ ] next step; verify: npm test (executor)\n'), f.env),
    ''
  );
  // Liveness: a Review newly added to Batch 41 on this same baseline is linted,
  // and the legacy Batch 40 Review is not named.
  const reason = assertGoalLineDeny(
    run(editEvent(session, todo, '- [ ] pending step (executor)\n', '- [ ] pending step (executor)\n### Review\nDone.\n'), f.env),
    /Batch 41: in-flight work/
  );
  assert.doesNotMatch(reason, /Batch 40/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function reviewGoalLineWarnMode() {
  const f = fixture();
  const session = 'sess-goal-warn';
  const todo = writeTodo(f.root, GOAL_BASELINE);
  const env = { ...f.env, PLANGATE_WARN: '1' };
  assert.strictEqual(run(skillEvent(session), env), '');
  const parsed = atMostOneJson(run(writeEvent(session, todo, goalReview('')), env));
  assert.notStrictEqual(parsed, null);
  assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, undefined);
  assert.match(parsed.hookSpecificOutput.additionalContext, /needs a goal line/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /Warn-only mode/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function reviewGoalLineLintDisabledAllowed() {
  const f = fixture();
  const session = 'sess-goal-lintoff';
  const todo = writeTodo(f.root, GOAL_BASELINE);
  const env = { ...f.env, PLANGATE_LINT_DISABLED: '1' };
  assert.strictEqual(run(skillEvent(session), env), '');
  assert.strictEqual(run(writeEvent(session, todo, goalReview('')), env), '');
  // Liveness: the same write in the same session without the opt-out is denied.
  assertGoalLineDeny(run(writeEvent(session, todo, goalReview('')), f.env), /Batch 50: goal work/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function reviewInNewBatchDenied() {
  const f = fixture();
  const session = 'sess-goal-new-file';
  assert.strictEqual(run(skillEvent(session), f.env), '');
  // No baseline on disk: every Review in the written file is new.
  assertGoalLineDeny(run(writeEvent(session, todoPath(f.root), goalReview('')), f.env), /Batch 50: goal work/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function goalLineDenyWinsOverInFlightWarning() {
  const f = fixture();
  const session = 'sess-goal-wins';
  const todo = writeTodo(f.root, BATCH_BASELINE);
  assert.strictEqual(run(skillEvent(session), f.env), '');
  // Drops in-flight Batch 41 AND adds a Review without the line to a new
  // Batch 42: one JSON, the goal-line deny; no in-flight warning.
  const content = '# Todo\n\n' + BATCH_CLOSED + '## Batch 42: new work\n### Plan\n- [x] new step (executor)\n### Review\nDone.\n';
  const stdout = run(writeEvent(session, todo, content), f.env);
  assertGoalLineDeny(stdout, /Batch 42: new work/);
  assert.doesNotMatch(stdout, /in-flight work/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// --- Bash writes to .tasks/todo.md ---

const TODO_SHELL_PY_HEREDOC = [
  'cd /repo && python3 - <<\'EOF\'',
  "p='.tasks/todo.md'",
  's=open(p).read()',
  "s=s.replace('a','b')",
  "open(p,'w').write(s)",
  'EOF',
].join('\n');

function assertTodoShellDeny(stdout) {
  const reason = denyReason(stdout);
  assert.match(reason, /Bash command writes or removes \.tasks\/todo\.md/);
  assert.match(reason, /Edit or Write tool/);
  assert.match(reason, /PLANGATE_DISABLED=1/);
  return reason;
}

async function bashTodoPythonHeredocDeniedUnstamped() {
  const f = fixture();
  assertTodoShellDeny(run(bashEvent(TODO_SHELL_PY_HEREDOC, 'sess-todo-py'), f.env));
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashTodoPythonHeredocDeniedStamped() {
  const f = fixture();
  const session = 'sess-todo-py-stamped';
  assert.strictEqual(run(skillEvent(session), f.env), '');
  assert.strictEqual(fs.existsSync(stampFile(f.root, session)), true);
  assertTodoShellDeny(run(bashEvent(TODO_SHELL_PY_HEREDOC, session), f.env));
  // Deny-every-attempt: a bare retry is denied again.
  assertTodoShellDeny(run(bashEvent(TODO_SHELL_PY_HEREDOC, session), f.env));
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashTodoSedInPlaceDenied() {
  const f = fixture();
  assertTodoShellDeny(run(bashEvent("sed -i 's/a/b/' .tasks/todo.md", 'sess-todo-sed'), f.env));
  assertTodoShellDeny(run(bashEvent("sed -i '' 's/a/b/' .tasks/todo.md", 'sess-todo-sed'), f.env));
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashTodoAppendRedirectDenied() {
  const f = fixture();
  assertTodoShellDeny(run(bashEvent('echo x >> .tasks/todo.md', 'sess-todo-redir'), f.env));
  assertTodoShellDeny(run(bashEvent('cat /tmp/new.md > .tasks/todo.md', 'sess-todo-redir'), f.env));
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashTodoTeeDenied() {
  const f = fixture();
  assertTodoShellDeny(run(bashEvent("printf 'x\\n' | tee .tasks/todo.md", 'sess-todo-tee'), f.env));
  assertTodoShellDeny(run(bashEvent("printf 'x\\n' | tee -a .tasks/todo.md", 'sess-todo-tee'), f.env));
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashTodoNodeEvalDenied() {
  const f = fixture();
  const command = `node -e "require('fs').writeFileSync('.tasks/todo.md', 'x')"`;
  assertTodoShellDeny(run(bashEvent(command, 'sess-todo-node'), f.env));
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashTodoAbsolutePathDenied() {
  const f = fixture();
  assertTodoShellDeny(run(bashEvent('echo x >> /abs/proj/.tasks/todo.md', 'sess-todo-abs'), f.env));
  fs.rmSync(f.root, { recursive: true, force: true });
}

// mv/cp/install deny only when they would overwrite an existing todo.md, so
// these run with cwd at a scratch root that holds one.
async function bashTodoMoveCopyTruncateDenied() {
  const f = fixture();
  const existing = writeTodo(f.root, '# Batch 1: x\n');
  for (const command of [
    'mv /tmp/new.md .tasks/todo.md',
    `cp /tmp/new.md ${existing}`,
    'install -m 644 /tmp/new.md .tasks/todo.md',
    'truncate -s 0 .tasks/todo.md',
    "perl -pi -e 's/a/b/' .tasks/todo.md",
  ]) {
    assertTodoShellDeny(run({ ...bashEvent(command, 'sess-todo-mv'), cwd: f.root }, f.env));
  }
  fs.rmSync(f.root, { recursive: true, force: true });
}

// plan-and-track's legacy migration moves tasks/todo.md onto a .tasks/todo.md
// that does not exist yet: a create, not an overwrite, so it passes. With a
// `cd` earlier in the command the destination can't be resolved reliably, and
// with no cwd neither can a relative path, so both still deny.
async function bashTodoMigrationMoveAllowed() {
  const f = fixture();
  const session = 'sess-todo-migrate';
  for (const command of ['mv tasks/todo.md .tasks/todo.md', 'mkdir -p .tasks && mv tasks/todo.md .tasks/todo.md']) {
    assert.strictEqual(run({ ...bashEvent(command, session), cwd: f.root }, f.env), '', command);
  }
  assertTodoShellDeny(run({ ...bashEvent('cd sub && mv tasks/todo.md .tasks/todo.md', session), cwd: f.root }, f.env));
  assertTodoShellDeny(run(bashEvent('mv tasks/todo.md .tasks/todo.md', session), f.env));
  // Only the legacy migration's source creates freely: any other file moved,
  // copied, or installed onto a missing todo.md lands content no lint read.
  for (const command of [
    'mv /tmp/forged.md .tasks/todo.md',
    'cp tasks/todo.md .tasks/todo.md',
    'install -m 644 tasks/todo.md .tasks/todo.md',
  ]) {
    assertTodoShellDeny(run({ ...bashEvent(command, session), cwd: f.root }, f.env));
  }
  fs.rmSync(f.root, { recursive: true, force: true });
}

// A literal path is still literal when a parent directory has a space in it:
// quoted, it reaches every write and removal form, and the legacy migration
// exemption still resolves it.
async function bashTodoQuotedSpacedPathDenied() {
  const f = fixture();
  const spaced = path.join(f.root, 'my project');
  writeTodo(spaced, '# Batch 1: x\n');
  const p = path.join(spaced, '.tasks', 'todo.md');
  const session = 'sess-todo-spaced';
  for (const command of [
    `echo x > "${p}"`,
    `echo x >> '${p}'`,
    `printf 'x' | tee -a "${p}"`,
    `rm "${p}"`,
    `mv "${p}" /tmp/todo.md`,
    `cp /tmp/new.md "${p}"`,
    `truncate -s 0 "${p}"`,
    `rm -rf "${path.join(spaced, '.tasks')}"`,
  ]) {
    assertTodoShellDeny(run({ ...bashEvent(command, session), cwd: f.root }, f.env));
  }
  const fresh = path.join(f.root, 'other dir', '.tasks', 'todo.md');
  assert.strictEqual(run({ ...bashEvent(`mv tasks/todo.md "${fresh}"`, session), cwd: f.root }, f.env), '', 'legacy migration onto a missing quoted path');
  assert.strictEqual(run({ ...bashEvent(`cat "${p}"`, session), cwd: f.root }, f.env), '', 'read-only quoted path');
  fs.rmSync(f.root, { recursive: true, force: true });
}

// Deleting the file or moving it away removes the Migration State block and
// every in-flight batch with no check running, and so does removing or moving
// the .tasks directory that holds it.
async function bashTodoDeleteDenied() {
  const f = fixture();
  writeTodo(f.root, '# Batch 1: x\n');
  const session = 'sess-todo-rm';
  for (const command of [
    'rm .tasks/todo.md',
    'rm -f ./.tasks/todo.md',
    'unlink .tasks/todo.md',
    'mv .tasks/todo.md /tmp/todo.md',
    'rm -rf .tasks',
    'rm -r ./.tasks/',
    'mv .tasks /tmp/old-tasks',
  ]) {
    assertTodoShellDeny(run({ ...bashEvent(command, session), cwd: f.root }, f.env));
  }
  for (const command of [
    'rm /tmp/x.md',
    'rm -rf .tasks-old',
    'rm .tasks/lessons-draft.md',
    'mv tasks/lessons.md .tasks/lessons.md',
    'ls .tasks',
  ]) {
    // These pass the todo guard but each names a distinct file, so a high
    // scope threshold keeps the Bash scope gate out of this todo-guard case.
    const env = { ...f.env, PLANGATE_SCOPE_THRESHOLD: '99' };
    assert.strictEqual(run({ ...bashEvent(command, session), cwd: f.root }, env), '', command);
  }
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashTodoReadOnlySilent() {
  const f = fixture();
  const session = 'sess-todo-readonly';
  for (const command of [
    'cat .tasks/todo.md',
    'grep -n "Batch" .tasks/todo.md',
    "sed -n '1,20p' .tasks/todo.md",
    "sed -n '1,20p' .tasks/todo.md | grep -i batch",
    'head -20 .tasks/todo.md',
    'tail -5 .tasks/todo.md',
    'wc -l .tasks/todo.md',
    "awk '/Batch/ {print $0}' .tasks/todo.md",
    'git diff .tasks/todo.md',
    `python3 -c "print(open('.tasks/todo.md').read())"`,
    'grep x .tasks/todo.md > /tmp/out',
    'cp .tasks/todo.md /tmp/todo.bak',
    'cat .tasks/todo.md | tee /tmp/copy.md',
    'echo x >> .tasks/todo.md.bak',
    'echo x > /tmp/other.md',
  ]) {
    assert.strictEqual(run(bashEvent(command, session), f.env), '', command);
  }
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashTodoWarnModeWarns() {
  const f = fixture();
  const env = { ...f.env, PLANGATE_WARN: '1' };
  const stdout = run(bashEvent('echo x >> .tasks/todo.md', 'sess-todo-warn'), env);
  const parsed = JSON.parse(stdout);
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, undefined);
  assert.match(parsed.hookSpecificOutput.additionalContext, /Bash command writes or removes \.tasks\/todo\.md/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /Warn-only mode/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashTodoLintDisabledStillDenies() {
  const f = fixture();
  const env = { ...f.env, PLANGATE_LINT_DISABLED: '1' };
  assertTodoShellDeny(run(bashEvent('echo x >> .tasks/todo.md', 'sess-todo-lint-off'), env));
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashTodoPlangateDisabledSilent() {
  const f = fixture();
  const env = { ...f.env, PLANGATE_DISABLED: '1' };
  assert.strictEqual(run(bashEvent('echo x >> .tasks/todo.md', 'sess-todo-off'), env), '');
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashTodoSubagentDenyNamesCaller() {
  const f = fixture();
  const event = { ...bashEvent('echo x >> .tasks/todo.md', 'sess-todo-sub'), agent_id: 'agent-1', agent_type: 'executor' };
  const reason = assertTodoShellDeny(run(event, f.env));
  assert.match(reason, /runs inside subagent `executor`/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// --- Scope gate: files written through Bash ---
//
// Bash events here carry `cwd` (the hook resolves relative targets against
// it). The hook process runs with TMPDIR set to the case's scratch root, so
// os.tmpdir() equals f.root: a file inside a cwd under f.root must still
// count, while the temp exemption applies only to paths outside the cwd.

function filesDir(root, session) {
  return stampFile(root, session) + '.files';
}

function fileMarkerCount(root, session) {
  try {
    return fs.readdirSync(filesDir(root, session)).length;
  } catch {
    return 0;
  }
}

function heredocWrite(name) {
  return `cat > ${name} <<'EOF'\nconsole.log(1);\nEOF`;
}

async function bashScopeHeredocSideDoorDenied() {
  const f = fixture();
  const session = 'sess-bs-heredoc';
  assert.strictEqual(run(bashEvent(heredocWrite('a.js'), session, f.root), f.env), '');
  assert.strictEqual(run(bashEvent(heredocWrite('b.js'), session, f.root), f.env), '');
  assert.strictEqual(fileMarkerCount(f.root, session), 2);
  const reason = denyReason(run(bashEvent(heredocWrite('c.js'), session, f.root), f.env));
  assert.match(reason, /3 distinct files/);
  assert.match(reason, /retry this command/);
  // A real deny records nothing, and the edit tools share the same count.
  assert.strictEqual(fileMarkerCount(f.root, session), 2);
  const editReason = denyReason(run(writeEvent(session, path.join(f.root, 'd.js'), 'x'), f.env));
  assert.match(editReason, /3 distinct files/);
  assert.match(editReason, /retry this edit/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashScopeWriteShapesCount() {
  const f = fixture();
  const env = { ...f.env, PLANGATE_SCOPE_THRESHOLD: '1' };
  const shapes = [
    'echo x > a.txt',
    'echo x >> a.txt',
    'make 2> err.log',
    'echo x >out.txt',
    'echo x | tee a.txt',
    'echo x | tee -a a.txt',
    "sed -i 's/a/b/' f.txt",
    "sed -i.bak -e 's/a/b/' f.txt",
    "perl -pi -e 's/a/b/' f.txt",
    'cp a.txt b.txt',
    'mv a.txt b.txt',
    'install -m 644 a.txt b.txt',
    'rm f.txt',
    'rm -rf build',
    'unlink f.txt',
    'truncate -s 0 f.txt',
    "python3 - <<'EOF'\nopen('gen.py', 'w').write('x')\nEOF",
    `python3 -c "open('x.txt','w').write('1')"`,
    `node -e "require('fs').writeFileSync('y.js','1')"`,
    "python3 - <<'EOF'\nfrom pathlib import Path\nPath('z.md').write_text('x')\nEOF",
  ];
  for (const [index, command] of shapes.entries()) {
    const session = `sess-bs-shape-${index}`;
    const reason = denyReason(run(bashEvent(command, session, f.root), env));
    assert.match(reason, /1 distinct files/, command);
    assert.strictEqual(fileMarkerCount(f.root, session), 0, command);
  }
  fs.rmSync(f.root, { recursive: true, force: true });
}

// Warn mode records every counted target, so the marker count shows exactly
// which operands were read as files (the threshold-1 shapes case above only
// proves that something counted).
async function bashScopeExactTargetCounts() {
  const f = fixture();
  const env = { ...f.env, PLANGATE_WARN: '1', PLANGATE_SCOPE_THRESHOLD: '99' };
  const cases = [
    ["sed -i '' 's/a/b/' f.txt", 1],
    ["sed -i '' -e 's/a/b/' f.txt g.txt", 2],
    ['mv a.txt b.txt', 2],
    ['cp -r src dst', 1],
    ['if true; then cp a.txt b.txt; fi', 1],
    ['for f in x; do rm a.txt; done', 1],
    ['! rm a.txt', 1],
    [`git commit -m "$(cat <<'EOF'\nFix the parser\n\nKeeps quotes 'as is' > none.\nEOF\n)"`, 0],
    // splitShellSegments breaks `>&word` at the `&` and `>|` at the `|`; the
    // operand still counts, while an fd dup or close does not.
    ['make >& build.log', 1],
    ['make >&build.log', 1],
    ['echo x >| out.txt', 1],
    ['make 2>&1 | tee build.log', 1],
    ['echo x >&-', 0],
    // Process substitution is a command, not a redirect target.
    ['echo x | tee >(cat) out.txt', 1],
    ['tee >(cat) >(wc -l) < f.txt', 0],
    ['diff <(sort a.txt) <(sort b.txt) > /dev/null', 0],
    // Only an interpreter's own body is scanned for write APIs: a plain
    // heredoc that quotes write examples writes just its redirect target.
    [`cat > README.md <<'EOF'\nRun python3 -c "open('generated.py','w')" or\nPath('other.md').write_text('x') to regenerate.\nEOF`, 1],
    ["cat <<'EOF' | python3\nopen('a.py', 'w').write('x')\nEOF", 1],
    [`/usr/bin/python3 -c "open('b.py','w').write('1')"`, 1],
  ];
  for (const [index, [command, expected]] of cases.entries()) {
    const session = `sess-bs-exact-${index}`;
    run(bashEvent(command, session, f.root), env);
    assert.strictEqual(fileMarkerCount(f.root, session), expected, command);
  }
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashScopeBashAndEditDedupe() {
  const f = fixture();
  const session = 'sess-bs-dedupe';
  assert.strictEqual(run(bashEvent('echo x > a.js', session, f.root), f.env), '');
  assert.strictEqual(fileMarkerCount(f.root, session), 1);
  assert.strictEqual(run(writeEvent(session, path.join(f.root, 'a.js'), 'x'), f.env), '');
  assert.strictEqual(fileMarkerCount(f.root, session), 1);
  assert.strictEqual(run(writeEvent(session, path.join(f.root, 'b.js'), 'x'), f.env), '');
  assert.strictEqual(fileMarkerCount(f.root, session), 2);
  // a.js was counted once across Bash and Write, so the fourth call is the third file.
  const reason = denyReason(run(writeEvent(session, path.join(f.root, 'c.js'), 'x'), f.env));
  assert.match(reason, /3 distinct files/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashScopeReadOnlySilent() {
  const f = fixture();
  const session = 'sess-bs-readonly';
  const env = { ...f.env, PLANGATE_SCOPE_THRESHOLD: '1' };
  for (const command of [
    'cat a.txt',
    'grep -rn foo src',
    "sed -n '1,5p' f.txt",
    'head -5 f.txt',
    'git diff',
    'ls > /dev/null 2>&1',
    'npm test 2>&1 | tail -5',
    'cmd 2>/dev/null',
    'echo hi >&2',
    'git commit -m "a > b.js"',
    `python3 -c "print(open('a.py').read())"`,
    'touch f.txt',
    'mkdir -p d',
    'echo x > /tmp/scratch.txt',
  ]) {
    assert.strictEqual(run(bashEvent(command, session, f.root), env), '', command);
  }
  // Temp scratch under the OS temp dir is exempt only when outside the cwd.
  const scratch = path.join(f.root, 'scratch.txt');
  assert.strictEqual(run(bashEvent(`echo x > ${scratch}`, session, path.join(f.root, 'proj')), env), '');
  assert.strictEqual(fs.existsSync(filesDir(f.root, session)), false);
  assert.strictEqual(fs.existsSync(mutationsDir(f.root, session)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

// The temp exemption must not swallow a project that lives under the temp
// dir: os.tmpdir() is f.root in the hook process, and the cwd is f.root too.
async function bashScopeTempInsideCwdCounts() {
  const f = fixture();
  const env = { ...f.env, PLANGATE_SCOPE_THRESHOLD: '1' };
  const reason = denyReason(run(bashEvent(`echo x > ${path.join(f.root, 'scratch.txt')}`, 'sess-bs-temp-cwd', f.root), env));
  assert.match(reason, /1 distinct files/);
  denyReason(run(bashEvent('echo x > sub/a.js', 'sess-bs-temp-cwd-rel', path.join(f.root, 'proj')), env));
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashScopeUnresolvedTargetNotCounted() {
  const f = fixture();
  const session = 'sess-bs-unresolved';
  const env = { ...f.env, PLANGATE_SCOPE_THRESHOLD: '1' };
  for (const command of ['echo x > "$OUT"', 'cat > $(mktemp)', 'echo x > `mktemp`', 'rm "$TARGET"', 'rm $(find . -name x)']) {
    assert.strictEqual(run(bashEvent(command, session, f.root), env), '', command);
  }
  assert.strictEqual(fs.existsSync(filesDir(f.root, session)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashScopeStampedSilent() {
  const f = fixture();
  const session = 'sess-bs-stamped';
  const env = { ...f.env, PLANGATE_SCOPE_THRESHOLD: '1' };
  assert.strictEqual(run(skillEvent(session), env), '');
  assert.strictEqual(run(bashEvent('echo x > a.js', session, f.root), env), '');
  assert.strictEqual(fs.existsSync(filesDir(f.root, session)), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashScopeWarnMode() {
  const f = fixture();
  const session = 'sess-bs-warn';
  const env = { ...f.env, PLANGATE_WARN: '1', PLANGATE_SCOPE_THRESHOLD: '1' };
  const parsed = JSON.parse(run(bashEvent('echo x > a.js', session, f.root), env));
  assert.deepStrictEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, undefined);
  assert.match(parsed.hookSpecificOutput.additionalContext, /1 distinct files/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /retry this command/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /Warn-only mode/);
  // Warn mode proceeds, so the file is recorded (unlike a real deny).
  assert.strictEqual(fileMarkerCount(f.root, session), 1);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashScopeDenyRecordsNothing() {
  const f = fixture();
  const session = 'sess-bs-deny-records';
  const env = { ...f.env, PLANGATE_SCOPE_THRESHOLD: '1' };
  denyReason(run(bashEvent('echo x > a.js', session, f.root), env));
  denyReason(run(bashEvent('echo x > a.js', session, f.root), env));
  assert.strictEqual(fileMarkerCount(f.root, session), 0);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashScopeSubagentDenyNamesCaller() {
  const f = fixture();
  const session = 'sess-bs-subagent';
  assert.strictEqual(run(bashEvent('echo x > a.js', session, f.root), f.env), '');
  assert.strictEqual(run(bashEvent('echo x > b.js', session, f.root), f.env), '');
  const event = bashEvent('echo x > c.js', session, f.root);
  event.agent_id = 'a1';
  event.agent_type = 'executor';
  const reason = denyReason(run(event, f.env));
  assert.match(reason, /stop and report to your caller/);
  assert.match(reason, /executor/);
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function bashScopeAndMutationSingleJson() {
  const f = fixture();
  const session = 'sess-bs-single-json';
  assert.strictEqual(run(bashEvent('git push origin main', session, f.root), f.env), '');
  assert.strictEqual(run(bashEvent('echo x > a.js', session, f.root), f.env), '');
  assert.strictEqual(run(bashEvent('echo x > b.js', session, f.root), f.env), '');
  // Both gates would trip here (3rd file, 2nd mutation kind): exactly one
  // JSON object comes back, the scope deny, and nothing is recorded.
  const stdout = run(bashEvent('echo x > c.js && gh pr create --fill', session, f.root), f.env);
  assert.notStrictEqual(atMostOneJson(stdout), null);
  const reason = denyReason(stdout);
  assert.match(reason, /3 distinct files/);
  assert.doesNotMatch(reason, /outward git\/gh mutations/);
  assert.strictEqual(fileMarkerCount(f.root, session), 2);
  assert.strictEqual(fs.existsSync(mutationMarker(f.root, session, 'gh-pr-create')), false);
  fs.rmSync(f.root, { recursive: true, force: true });
}

const HANDLERS = {
  'npm-test-silent': npmTestSilent,
  'git-push-help-silent': gitPushHelpSilent,
  'git-push-dry-run-silent': gitPushDryRunSilent,
  'gh-pr-view-silent': ghPrViewSilent,
  'quote-aware-commit-no-mutation': quoteAwareCommitNoMutation,
  'heredoc-body-strips-git-push': heredocBodyStripsGitPush,
  'git-c-global-opt-counts': gitCGlobalOptCounts,
  'gh-r-global-opt-counts': ghRGlobalOptCounts,
  'threshold-escalation-denies-second': thresholdEscalationDeniesSecond,
  'single-call-union-denies': singleCallUnionDenies,
  'stamped-session-bypasses-threshold': stampedSessionBypassesThreshold,
  'warn-mode-demotes': warnModeDemotes,
  'disabled-mode-silent': disabledModeSilent,
  'mutation-threshold-one-denies-first': mutationThresholdOneDeniesFirst,
  'heredoc-hyphen-delim-body-not-classified': heredocHyphenDelimBodyNotClassified,
  'quoted-heredoc-op-not-hiding-command': quotedHeredocOpNotHiding,
  'comment-strips-following-command': commentStripsFollowingCommand,
  'new-step-user-attribution-denied': newStepUserAttributionDenied,
  'attribution-deny-once-retry-allowed': attributionDenyOnceRetryAllowed,
  'non-attribution-main-reason-allowed': nonAttributionMainReasonAllowed,
  'executor-tag-unaffected-by-attribution-guard': executorTagUnaffectedByAttributionGuard,
  'lint-disabled-allows-attribution-case': lintDisabledAllowsAttributionCase,
  'continuation-line-attribution-denied': continuationLineAttributionDenied,
  'subagent-scope-deny-names-caller': subagentScopeDenyNamesCaller,
  'subagent-mutation-deny-names-caller': subagentMutationDenyNamesCaller,
  'main-thread-deny-has-no-subagent-line': mainThreadDenyHasNoSubagentLine,
  'subagent-todo-deny-alt-id-field-names-caller': subagentTodoDenyAltIdFieldNamesCaller,
  'agent-type-only-is-main-thread': agentTypeOnlyIsMainThread,
  'write-drops-in-flight-batch-warns': writeDropsInFlightBatchWarns,
  'write-drops-all-checked-no-review-batch-warns': writeDropsAllCheckedNoReviewBatchWarns,
  'write-drops-reviewed-batch-without-checklist-warns': writeDropsReviewedBatchWithoutChecklistWarns,
  'edit-compresses-closed-batch-silent': editCompressesClosedBatchSilent,
  'edit-inserts-new-batch-silent': editInsertsNewBatchSilent,
  'lint-deny-wins-over-in-flight-warning': lintDenyWinsOverInFlightWarning,
  'lint-disabled-still-warns-in-flight': lintDisabledStillWarnsInFlight,
  'review-without-goal-line-denied': reviewWithoutGoalLineDenied,
  'review-goal-met-yes-allowed': reviewGoalMetYesAllowed,
  'review-goal-met-partial-with-gap-allowed': reviewGoalMetPartialWithGapAllowed,
  'review-goal-met-partial-empty-gap-denied': reviewGoalMetPartialEmptyGapDenied,
  'legacy-review-without-goal-line-allowed': legacyReviewWithoutGoalLineAllowed,
  'review-goal-line-warn-mode': reviewGoalLineWarnMode,
  'review-goal-line-lint-disabled-allowed': reviewGoalLineLintDisabledAllowed,
  'review-in-new-batch-denied': reviewInNewBatchDenied,
  'goal-line-deny-wins-over-in-flight-warning': goalLineDenyWinsOverInFlightWarning,
  'bash-todo-python-heredoc-denied-unstamped': bashTodoPythonHeredocDeniedUnstamped,
  'bash-todo-python-heredoc-denied-stamped': bashTodoPythonHeredocDeniedStamped,
  'bash-todo-sed-in-place-denied': bashTodoSedInPlaceDenied,
  'bash-todo-append-redirect-denied': bashTodoAppendRedirectDenied,
  'bash-todo-tee-denied': bashTodoTeeDenied,
  'bash-todo-node-eval-denied': bashTodoNodeEvalDenied,
  'bash-todo-absolute-path-denied': bashTodoAbsolutePathDenied,
  'bash-todo-move-copy-truncate-denied': bashTodoMoveCopyTruncateDenied,
  'bash-todo-migration-move-allowed': bashTodoMigrationMoveAllowed,
  'bash-todo-delete-denied': bashTodoDeleteDenied,
  'bash-todo-quoted-spaced-path-denied': bashTodoQuotedSpacedPathDenied,
  'bash-todo-read-only-silent': bashTodoReadOnlySilent,
  'bash-todo-warn-mode-warns': bashTodoWarnModeWarns,
  'bash-todo-lint-disabled-still-denies': bashTodoLintDisabledStillDenies,
  'bash-todo-plangate-disabled-silent': bashTodoPlangateDisabledSilent,
  'bash-todo-subagent-deny-names-caller': bashTodoSubagentDenyNamesCaller,
  'bash-scope-heredoc-side-door-denied': bashScopeHeredocSideDoorDenied,
  'bash-scope-write-shapes-count': bashScopeWriteShapesCount,
  'bash-scope-exact-target-counts': bashScopeExactTargetCounts,
  'bash-scope-bash-and-edit-dedupe': bashScopeBashAndEditDedupe,
  'bash-scope-read-only-silent': bashScopeReadOnlySilent,
  'bash-scope-temp-inside-cwd-counts': bashScopeTempInsideCwdCounts,
  'bash-scope-unresolved-target-not-counted': bashScopeUnresolvedTargetNotCounted,
  'bash-scope-stamped-silent': bashScopeStampedSilent,
  'bash-scope-warn-mode': bashScopeWarnMode,
  'bash-scope-deny-records-nothing': bashScopeDenyRecordsNothing,
  'bash-scope-subagent-deny-names-caller': bashScopeSubagentDenyNamesCaller,
  'bash-scope-and-mutation-single-json': bashScopeAndMutationSingleJson,
};

async function main() {
  const fixtureCases = JSON.parse(fs.readFileSync(CASES, 'utf8')).cases;
  let failures = 0;
  for (const fixtureCase of fixtureCases) {
    const handler = HANDLERS[fixtureCase.id];
    if (typeof handler !== 'function') {
      process.stdout.write(`FAIL ${fixtureCase.id}: no handler registered\n`);
      failures += 1;
      continue;
    }
    try {
      await handler();
      process.stdout.write(`PASS ${fixtureCase.id}\n`);
    } catch (err) {
      process.stdout.write(`FAIL ${fixtureCase.id}: ${(err && err.stack) || err}\n`);
      failures += 1;
    }
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
