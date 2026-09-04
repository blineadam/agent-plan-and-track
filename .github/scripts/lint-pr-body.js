#!/usr/bin/env node
'use strict';

/**
 * Lints a PR body file against this repo's PR-body convention (see AGENTS.md
 * "PR body convention" and the sibling rule in rules/core-rules.md /
 * rules/agent-guidelines.md). This lives in CI rather than a PreToolUse hook
 * because a hook only sees the tool call that opens or edits a PR through
 * this session's own `gh` invocation; it can't see `--fill`, `gh pr edit`,
 * `gh api`, the GitHub web UI, MCP tools, or a PR opened by CI itself. A
 * `pull_request` workflow sees the final body from every one of those paths.
 *
 * Invocation: node .github/scripts/lint-pr-body.js <path-to-body-file>
 * Exit 1 if any HARD finding, exit 0 otherwise. WARN findings never affect
 * the exit code but are always printed alongside any HARD findings.
 *
 * HARD findings:
 *   1. The first markdown heading in the body is not `## Summary` (case-insensitive).
 *   2. Any heading line matching one of the banned-narration-heading patterns:
 *      review round(s), alternatives considered, or known limits/limitations.
 *   3. The body does not carry exactly one level-2 heading whose text is
 *      `Test plan` or `Verification` (case-insensitive, trimmed): zero or two
 *      or more is a HARD finding.
 *   4. An em dash (U+2014) in prose.
 *   5. An emoji in prose (\p{Extended_Pictographic}, plus regional-indicator
 *      flag sequences and keycap sequences, minus the text-presentation
 *      exceptions (c), (r), (tm)).
 *   6. A level-2 `## Implementation` heading occurring after the first
 *      `## Test plan`/`## Verification` heading: the convention orders
 *      Implementation before verification, not after.
 *
 * WARN findings:
 *   7. Any ##-level heading whose text isn't Summary, Implementation, Test
 *      plan, or Verification (case-insensitive). Warn only: that allowlist is
 *      inferred from eight samples and is a style preference, not a
 *      correctness claim.
 *
 * "Code" (excluded from every check below, not just the voice checks) means
 * fenced code blocks (``` and ~~~) and inline code spans. codeLineMask()
 * computes which lines are fenced code ONCE, and every check (the heading
 * checks above, not only the voice checks) consumes that same mask; a
 * quoted example heading inside a fence (e.g. showing what this very lint
 * rejects) must never be read as a real heading. An unclosed fence must
 * never swallow the rest of the document as code: if no matching close is
 * found, everything from that opening line to the end of the body is
 * treated as ordinary lines instead.
 *
 * Deliberately NOT stripped: 4-space-indented lines. An earlier version of
 * this script also treated a 4-space indent as an indented code block, but
 * that silently disabled the voice check on an indented list continuation
 * (a nested bullet), which is common in this repo's PR bodies, in order to
 * guard against a construct (an indented code block with no fence) that
 * none of them actually use. Telling the two apart properly means tracking
 * list context, which is real markdown parsing and more than this tripwire
 * warrants. Do not restore indented-code stripping without solving that.
 */

const fs = require('fs');

const EM_DASH = '\u2014';
// (c), (r), (tm) are text-presentation characters in this context, not emoji;
// only the bare text-presentation form is exempt (see checkEmoji below).
const EXCLUDED_PICTOGRAPHS = new Set(['©', '®', '™']);
const ALLOWED_HEADINGS = new Set(['summary', 'implementation', 'test plan', 'verification']);
const VERIFICATION_HEADINGS = new Set(['test plan', 'verification']);
const BANNED_NARRATION_HEADINGS = [
  { name: 'review-round narration', re: /^ {0,3}#{1,6}\s+.*\breview\s+rounds?\b/i },
  { name: 'alternatives-considered narration', re: /^ {0,3}#{1,6}\s+.*\balternatives\s+considered\b/i },
  { name: 'known-limits narration', re: /^ {0,3}#{1,6}\s+.*\bknown\s+limit(?:ation)?s?\b/i },
];
// CommonMark allows an ATX heading up to a 3-space indent (GitHub renders it
// as a heading); 4 or more leading spaces is not a heading.
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.+?)\s*$/;
const HUMANIZER_POINTER = 'see the humanizer skill for PR-body prose';

function parseHeading(line) {
  const m = HEADING_RE.exec(line);
  if (!m) return null;
  return { level: m[1].length, text: m[2] };
}

// Fenced code blocks (``` or ~~~, >=3 chars, optional up-to-3-space indent,
// optional info string on the opening line). Returns a boolean array marking
// which line indices are inside a *closed* fenced block (including its own
// fence marker lines). An opening fence with no matching close leaves every
// remaining line unmarked, per the "must never swallow the remainder"
// requirement: fence detection simply stops there.
// Per CommonMark's fenced-code-block info string rule, a backtick fence's
// info string must not itself contain a backtick (a tilde fence's may
// contain anything, backticks included).
function codeLineMask(lines) {
  const isCode = new Array(lines.length).fill(false);
  const openRe = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  let i = 0;
  while (i < lines.length) {
    const open = openRe.exec(lines[i]);
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) {
      i += 1;
      continue;
    }
    const fenceChar = open[1][0];
    const fenceLen = open[1].length;
    const closeRe = fenceChar === '`' ? /^ {0,3}(`{3,})\s*$/ : /^ {0,3}(~{3,})\s*$/;
    let closeIndex = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const close = closeRe.exec(lines[j]);
      if (close && close[1].length >= fenceLen) {
        closeIndex = j;
        break;
      }
    }
    if (closeIndex === -1) {
      // Unclosed fence: stop fence detection here and leave the rest of the
      // document (including this opening line) as ordinary, non-code lines.
      break;
    }
    for (let k = i; k <= closeIndex; k += 1) isCode[k] = true;
    i = closeIndex + 1;
  }
  return isCode;
}

// Non-code lines, shared by every check below (structural and voice alike),
// so a heading or a voice violation quoted inside a fenced example is never
// mistaken for a real one.
function nonCodeLines(lines, mask) {
  const result = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (mask[i]) continue;
    result.push({ lineNumber: i + 1, text: lines[i] });
  }
  return result;
}

function checkFirstHeading(nonCode, findings) {
  for (const { lineNumber, text } of nonCode) {
    const heading = parseHeading(text);
    if (!heading) continue;
    const normalized = `${'#'.repeat(heading.level)} ${heading.text}`.trim().toLowerCase();
    if (normalized !== '## summary') {
      findings.push({
        severity: 'HARD',
        message: `first heading is not "## Summary": observed "${text.trim()}" on line ${lineNumber}`,
      });
    }
    return;
  }
  findings.push({ severity: 'HARD', message: 'first heading is not "## Summary": observed no markdown heading in the body' });
}

function checkBannedNarrationHeadings(nonCode, findings) {
  for (const { lineNumber, text } of nonCode) {
    for (const { name, re } of BANNED_NARRATION_HEADINGS) {
      if (re.test(text)) {
        findings.push({
          severity: 'HARD',
          message: `${name} heading: observed "${text.trim()}" on line ${lineNumber}`,
        });
      }
    }
  }
}

function checkVerificationHeading(nonCode, findings) {
  let count = 0;
  for (const { text } of nonCode) {
    const heading = parseHeading(text);
    if (!heading || heading.level !== 2) continue;
    if (VERIFICATION_HEADINGS.has(heading.text.trim().toLowerCase())) count += 1;
  }
  if (count === 0) {
    findings.push({
      severity: 'HARD',
      message: 'expected exactly one "## Test plan" or "## Verification" heading: observed no such heading',
    });
  } else if (count > 1) {
    findings.push({
      severity: 'HARD',
      message: `expected exactly one "## Test plan" or "## Verification" heading: observed ${count} such headings`,
    });
  }
}

function checkHeadingOrder(nonCode, findings) {
  let verificationLine = null;
  for (const { lineNumber, text } of nonCode) {
    const heading = parseHeading(text);
    if (!heading || heading.level !== 2) continue;
    const normalized = heading.text.trim().toLowerCase();
    if (verificationLine === null && VERIFICATION_HEADINGS.has(normalized)) {
      verificationLine = lineNumber;
      continue;
    }
    if (verificationLine !== null && normalized === 'implementation') {
      findings.push({
        severity: 'HARD',
        message: `"## Implementation" must come before the "## Test plan"/"## Verification" heading: observed "${text.trim()}" on line ${lineNumber}, after the verification heading on line ${verificationLine}`,
      });
    }
  }
}

function checkHeadingAllowlist(nonCode, findings) {
  for (const { lineNumber, text } of nonCode) {
    const heading = parseHeading(text);
    if (!heading || heading.level !== 2) continue;
    if (!ALLOWED_HEADINGS.has(heading.text.trim().toLowerCase())) {
      findings.push({
        severity: 'WARN',
        message: `heading not in the Summary/Implementation/Test plan/Verification allowlist: observed "${text.trim()}" on line ${lineNumber}`,
      });
    }
  }
}

function stripInlineCode(line) {
  return line.replace(/(`+)([\s\S]*?)\1/g, '');
}

function checkEmDash(prose, findings) {
  for (const { lineNumber, text } of prose) {
    let idx = text.indexOf(EM_DASH);
    while (idx !== -1) {
      const snippet = text.slice(Math.max(0, idx - 20), idx + 21);
      findings.push({
        severity: 'HARD',
        message: `em dash in prose on line ${lineNumber}: observed "${snippet}" (${HUMANIZER_POINTER})`,
      });
      idx = text.indexOf(EM_DASH, idx + 1);
    }
  }
}

// \p{Extended_Pictographic} alone misses two emoji classes that are not
// themselves pictographic: a regional-indicator flag sequence (two regional
// indicators) and a keycap sequence (a digit, # or *, an optional U+FE0F,
// then the combining U+20E3). Both multi-character alternatives are listed
// before the single-character \p{Extended_Pictographic} one so the engine
// prefers the longer match. The pictographic alternative also consumes an
// optional trailing U+FE0F (variation selector 16, which explicitly requests
// emoji presentation): that keeps a bare text-presentation exclusion (c/r/tm)
// exempt while a base-plus-VS16 sequence produces a two-character match that
// is not in EXCLUDED_PICTOGRAPHS, so it is not exempt.
function checkEmoji(prose, findings) {
  const re = /\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}\uFE0F?/gu;
  for (const { lineNumber, text } of prose) {
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m !== null) {
      const ch = m[0];
      if (!EXCLUDED_PICTOGRAPHS.has(ch)) {
        const codePoints = Array.from(ch, (c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
        findings.push({
          severity: 'HARD',
          message: `emoji in prose on line ${lineNumber}: observed "${ch}" (${codePoints}) (${HUMANIZER_POINTER})`,
        });
      }
      m = re.exec(text);
    }
  }
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    process.stderr.write('usage: node .github/scripts/lint-pr-body.js <path-to-body-file>\n');
    process.exit(1);
  }
  const body = fs.readFileSync(filePath, 'utf8');
  const lines = body.split('\n');

  const mask = codeLineMask(lines);
  const nonCode = nonCodeLines(lines, mask);

  const findings = [];
  checkFirstHeading(nonCode, findings);
  checkBannedNarrationHeadings(nonCode, findings);
  checkVerificationHeading(nonCode, findings);
  checkHeadingOrder(nonCode, findings);
  checkHeadingAllowlist(nonCode, findings);

  const prose = nonCode.map(({ lineNumber, text }) => ({ lineNumber, text: stripInlineCode(text) }));
  checkEmDash(prose, findings);
  checkEmoji(prose, findings);

  let hardCount = 0;
  for (const finding of findings) {
    process.stdout.write(`${finding.severity}: ${finding.message}\n`);
    if (finding.severity === 'HARD') hardCount += 1;
  }
  if (findings.length === 0) {
    process.stdout.write('no findings\n');
  }
  process.exit(hardCount > 0 ? 1 : 0);
}

main();
