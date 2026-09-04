#!/usr/bin/env node
'use strict';

/**
 * Guards the boundary of the one section copilot-review-instructions owns in
 * .github/copilot-instructions.md, so the nightly style-refresh workflow can
 * let that file through its diff allowlist without also letting an unattended
 * --dangerously-skip-permissions session rewrite the hand-authored rest, which
 * steers Copilot's cloud agent.
 *
 * Usage: check-owned-section.js <base-file> <head-file>
 *
 * A path that does not exist means the file was absent on that side; the
 * caller is expected to omit it rather than write an empty file, so "absent"
 * and "empty" stay distinguishable.
 *
 * Three hard failures:
 *   1. The file existed on base and is gone on head. Deleting the whole file
 *      removes the hand-authored part too, and this skill only ever rewrites
 *      its own section.
 *   2. Head carries more than one `# Code reviews` H1. A duplicate is never
 *      legitimate output, and tolerating one would let a second heading carry
 *      arbitrary text that stripping "the owned section" would hide.
 *   3. Anything outside the owned section differs between base and head.
 *
 * Fence handling is not incidental. A hand-authored fenced example may contain
 * a literal `# Code reviews` line, and reading that as a real heading would
 * hide every following line from the comparison, which is exactly the bypass
 * this guard exists to prevent. codeLineMask comes from lint-pr-body.js rather
 * than being reimplemented here: it already applies CommonMark's rules for
 * closing-fence length, the whitespace-only closing suffix, and the backtick
 * info-string restriction, and it is covered by that script's own fixtures.
 */

const fs = require('fs');
const { codeLineMask } = require('./lint-pr-body.js');

const OWNED_HEADING = '# Code reviews';

function readIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

// Indexes of every real (non-code) H1 line, in order.
function headingIndexes(lines) {
  const isCode = codeLineMask(lines);
  const indexes = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isCode[i] && /^# /.test(lines[i])) indexes.push(i);
  }
  return indexes;
}

function ownedHeadingIndexes(lines) {
  return headingIndexes(lines).filter((i) => lines[i].trim() === OWNED_HEADING);
}

// Everything except the owned section: its heading through the line before the
// next real H1, or the end of the file.
function stripOwned(text) {
  if (text === null) return [];
  const lines = text.split('\n');
  const owned = ownedHeadingIndexes(lines);
  if (owned.length === 0) return lines;
  const start = owned[0];
  const next = headingIndexes(lines).find((i) => i > start);
  const end = next === undefined ? lines.length : next;
  return lines.slice(0, start).concat(lines.slice(end));
}

function dropTrailingBlanks(lines) {
  const out = lines.slice();
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

function main() {
  const [basePath, headPath] = process.argv.slice(2);
  if (!basePath || !headPath) {
    process.stderr.write('usage: check-owned-section.js <base-file> <head-file>\n');
    process.exit(2);
  }

  const base = readIfPresent(basePath);
  const head = readIfPresent(headPath);

  if (base !== null && head === null) {
    process.stderr.write(
      'the Copilot instructions file was deleted; this skill only rewrites its own section\n',
    );
    process.exit(1);
  }

  if (head !== null) {
    const duplicates = ownedHeadingIndexes(head.split('\n'));
    if (duplicates.length > 1) {
      process.stderr.write(
        `found ${duplicates.length} \`${OWNED_HEADING}\` headings; exactly one is allowed\n`,
      );
      process.exit(1);
    }
  }

  // Appending the section to a file that lacked it necessarily swallows the
  // blank line that separated them, so a first run would otherwise trip the
  // guard on nothing. Trailing blank lines carry no Markdown meaning, so drop
  // them from both sides; interior blank lines still count as content.
  const baseRest = dropTrailingBlanks(stripOwned(base));
  const headRest = dropTrailingBlanks(stripOwned(head));
  if (baseRest.join('\n') === headRest.join('\n')) {
    process.stdout.write(`OK: nothing outside the \`${OWNED_HEADING}\` section changed\n`);
    process.exit(0);
  }

  process.stderr.write(
    `the Copilot instructions file changed outside its \`${OWNED_HEADING}\` section:\n`,
  );
  const width = Math.max(baseRest.length, headRest.length);
  for (let i = 0; i < width; i += 1) {
    if (baseRest[i] !== headRest[i]) {
      if (baseRest[i] !== undefined) process.stderr.write(`- ${baseRest[i]}\n`);
      if (headRest[i] !== undefined) process.stderr.write(`+ ${headRest[i]}\n`);
    }
  }
  process.exit(1);
}

main();
