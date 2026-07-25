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

function bashEvent(command, session) {
  return { session_id: session, tool_name: 'Bash', tool_input: { command } };
}

function skillEvent(session) {
  return { session_id: session, tool_name: 'Skill', tool_input: { skill: 'plan-and-track' } };
}

function writeEvent(session, filePath, content) {
  return { session_id: session, tool_name: 'Write', tool_input: { file_path: filePath, content } };
}

// Real on-disk tasks/todo.md under the case's own scratch root: the
// main-attribution guard's simulateResult() reads the baseline off disk, so
// there is no shortcut around writing one.
function todoPath(root) {
  return path.join(root, 'tasks', 'todo.md');
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
// Each case stamps the session (Skill event) before touching tasks/todo.md,
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
  assert.strictEqual(fs.existsSync(mainAttrMarker(f.root, session)), true);
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
