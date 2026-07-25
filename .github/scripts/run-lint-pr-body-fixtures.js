#!/usr/bin/env node
'use strict';

/**
 * Local case table for lint-pr-body.js's shared code-line masking (heading
 * checks and voice checks alike must ignore a fenced quoted example) and its
 * voice-check stripping rules (em dash / emoji in prose vs. fenced code and
 * inline code spans, and a nested list continuation, which is NOT stripped;
 * see lint-pr-body.js's header for why), plus the structural checks no real
 * body happens to violate. None of the eight PR bodies this repo has
 * labelled exercises the masking or stripping paths (zero contain an em
 * dash, an emoji, or even one fenced block), and all eight carry exactly one
 * verification heading, so this fixture set is the only coverage for the
 * voice checks, the missing or duplicated verification section, and the two
 * narration forms besides review rounds. Free and offline: every case spawns the real script against a
 * scratch body file and inspects its exit code and stdout; nothing here
 * calls a model or the network.
 *
 * Em dashes and emoji are written as \u escapes throughout, not literal
 * characters, so this file's own source stays free of the characters the
 * script under test is designed to catch.
 */

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, 'lint-pr-body.js');
const CASES = path.join(__dirname, 'fixtures', 'lint-pr-body', 'cases.json');

const EM_DASH = '\u2014';
const WARNING_EMOJI = '\u26A0';
// A keycap sequence (digit + combining U+20E3, no variation selector) and a
// regional-indicator flag sequence (two regional indicators): neither is
// \p{Extended_Pictographic} on its own, so checkEmoji has to match them as
// their own alternatives.
const KEYCAP = '3\u20E3';
const FLAG = '\u{1F1FA}\u{1F1F8}';

function run(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-pr-body-'));
  const bodyPath = path.join(dir, 'pr-body.md');
  fs.writeFileSync(bodyPath, body);
  const result = childProcess.spawnSync(process.execPath, [SCRIPT, bodyPath], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

function assertClean(result) {
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}\n${result.stdout}${result.stderr}`);
  assert.doesNotMatch(result.stdout, /HARD:/);
}

function assertHardFails(result, expectedSubstring) {
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, expectedSubstring);
}

async function emDashInFencedBlockPasses() {
  const body = [
    '## Summary',
    'This describes the change; the block below quotes some output.',
    '',
    '```',
    `some quoted output ${EM_DASH} with a dash right here`,
    '```',
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  assertClean(run(body));
}

async function emDashInNestedListContinuationHardFails() {
  const body = [
    '## Summary',
    '- top bullet',
    `    - nested bullet with an em dash ${EM_DASH} right here`,
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  // Indented-code stripping was dropped deliberately (see lint-pr-body.js's
  // header): a 4-space-indented nested list continuation is prose, not code,
  // so the em dash inside it must still be caught.
  assertHardFails(run(body), /HARD: em dash in prose/);
}

async function emDashInInlineSpanPasses() {
  const body = [
    '## Summary',
    `The command \`git log --format="a ${EM_DASH} b"\` is quoted inline.`,
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  assertClean(run(body));
}

async function emDashInProseHardFails() {
  const body = [
    '## Summary',
    `This sentence has an em dash ${EM_DASH} right in the prose.`,
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  assertHardFails(run(body), /HARD: em dash in prose/);
}

async function emojiInFencedBlockPasses() {
  const body = [
    '## Summary',
    'This describes the change; the block below quotes some output.',
    '',
    '```',
    `${WARNING_EMOJI} quoted marker in fenced output`,
    '```',
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  assertClean(run(body));
}

async function emojiInNestedListContinuationHardFails() {
  const body = [
    '## Summary',
    '- top bullet',
    `    - nested bullet with a ${WARNING_EMOJI} marker right here`,
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  assertHardFails(run(body), /HARD: emoji in prose/);
}

async function emojiInInlineSpanPasses() {
  const body = [
    '## Summary',
    `The tool prints \`${WARNING_EMOJI} warning\` as its literal marker.`,
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  assertClean(run(body));
}

async function emojiInProseHardFails() {
  const body = [
    '## Summary',
    `This sentence has a ${WARNING_EMOJI} emoji right in the prose.`,
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  assertHardFails(run(body), /HARD: emoji in prose/);
}

async function unclosedFenceScansRemainderAsProse() {
  const body = [
    '## Summary',
    'This block below never gets a closing fence.',
    '',
    '```',
    'first line inside the unclosed fence',
    `and here a plain sentence with an em dash ${EM_DASH} that must still be scanned`,
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  // If the unclosed fence swallowed the remainder, this would come back
  // clean; it must instead hard-fail on the em dash past the open fence.
  assertHardFails(run(body), /HARD: em dash in prose/);
}

async function bannedHeadingInsideFencedBlockPasses() {
  const body = [
    '## Summary',
    'This lint rejects review-loop narration headings like the quoted example below.',
    '',
    '```markdown',
    '## Review round 1',
    '```',
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  // The banned heading only appears as a quoted example inside a fence; it
  // must not be read as a real heading (this is the PR that ships this very
  // lint plausibly quoting itself, per the reported defect).
  assertClean(run(body));
}

async function quotedProblemHeadingInFenceWithRealSummaryPasses() {
  const body = [
    '```markdown',
    '## Problem',
    '```',
    '',
    '## Summary',
    'This describes the change.',
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  // The fenced example's "## Problem" comes before the real first heading,
  // "## Summary"; the fenced line must not be read as the body's first
  // heading.
  assertClean(run(body));
}

async function missingVerificationHeadingHardFails() {
  const body = ['## Summary', 'This describes the change with no verification section at all.', ''].join('\n');
  // A body with only "## Summary" and no "## Test plan"/"## Verification"
  // heading must hard-fail: that section is required, not optional.
  assertHardFails(run(body), /HARD: expected exactly one "## Test plan" or "## Verification" heading: observed no such heading/);
}

async function duplicateVerificationHeadingsHardFails() {
  const body = [
    '## Summary',
    'This describes the change.',
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
    '## Verification',
    '- [x] ran the check again',
    '',
  ].join('\n');
  // Exactly one of "## Test plan" / "## Verification" is required; carrying
  // both must hard-fail rather than silently pick one.
  assertHardFails(run(body), /HARD: expected exactly one "## Test plan" or "## Verification" heading: observed 2 such headings/);
}

async function alternativesConsideredHeadingHardFails() {
  const body = [
    '## Summary',
    'This describes the change.',
    '',
    '## Alternatives considered',
    'We could have done it a different way instead.',
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  // "Alternatives considered" is one of the three banned narration headings;
  // it must hard-fail, not just warn.
  assertHardFails(run(body), /HARD: alternatives-considered narration heading/);
}

async function knownLimitsHeadingHardFails() {
  const body = [
    '## Summary',
    'This describes the change.',
    '',
    '## Known limits',
    'Some edge case is not yet handled.',
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  // "Known limits" is one of the three banned narration headings; it must
  // hard-fail, not just warn.
  assertHardFails(run(body), /HARD: known-limits narration heading/);
}

async function fencedBlockWithMultiTokenInfoStringPasses() {
  const body = [
    '## Summary',
    'This describes the change; the block below quotes some output.',
    '',
    '```js title="example"',
    `some quoted output ${EM_DASH} with a dash right here`,
    '```',
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  // A multi-token info string (a language tag plus an attribute) must still
  // open a real fence; before the fence-parsing fix, only a single info
  // token was recognized, so this content would have been scanned as prose
  // and hard-failed on the em dash inside it.
  assertClean(run(body));
}

async function keycapSequenceInProseHardFails() {
  const body = [
    '## Summary',
    `This sentence has a keycap sequence ${KEYCAP} right in the prose.`,
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  // A keycap sequence is not \p{Extended_Pictographic} on its own; it must
  // still be caught as emoji.
  assertHardFails(run(body), /HARD: emoji in prose/);
}

async function regionalIndicatorFlagInProseHardFails() {
  const body = [
    '## Summary',
    `This sentence has a flag sequence ${FLAG} right in the prose.`,
    '',
    '## Test plan',
    '- [x] ran the check',
    '',
  ].join('\n');
  // A regional-indicator flag sequence is not \p{Extended_Pictographic} on
  // its own; it must still be caught as emoji.
  assertHardFails(run(body), /HARD: emoji in prose/);
}

const HANDLERS = {
  'em-dash-in-fenced-block-passes': emDashInFencedBlockPasses,
  'em-dash-in-nested-list-continuation-hard-fails': emDashInNestedListContinuationHardFails,
  'em-dash-in-inline-span-passes': emDashInInlineSpanPasses,
  'em-dash-in-prose-hard-fails': emDashInProseHardFails,
  'emoji-in-fenced-block-passes': emojiInFencedBlockPasses,
  'emoji-in-nested-list-continuation-hard-fails': emojiInNestedListContinuationHardFails,
  'emoji-in-inline-span-passes': emojiInInlineSpanPasses,
  'emoji-in-prose-hard-fails': emojiInProseHardFails,
  'unclosed-fence-scans-remainder-as-prose': unclosedFenceScansRemainderAsProse,
  'banned-heading-inside-fenced-block-passes': bannedHeadingInsideFencedBlockPasses,
  'quoted-problem-heading-in-fence-with-real-summary-passes': quotedProblemHeadingInFenceWithRealSummaryPasses,
  'missing-verification-heading-hard-fails': missingVerificationHeadingHardFails,
  'duplicate-verification-headings-hard-fails': duplicateVerificationHeadingsHardFails,
  'alternatives-considered-heading-hard-fails': alternativesConsideredHeadingHardFails,
  'known-limits-heading-hard-fails': knownLimitsHeadingHardFails,
  'fenced-block-with-multi-token-info-string-passes': fencedBlockWithMultiTokenInfoStringPasses,
  'keycap-sequence-in-prose-hard-fails': keycapSequenceInProseHardFails,
  'regional-indicator-flag-in-prose-hard-fails': regionalIndicatorFlagInProseHardFails,
};

async function main() {
  const cases = JSON.parse(fs.readFileSync(CASES, 'utf8')).cases;
  let failures = 0;
  for (const fixtureCase of cases) {
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
