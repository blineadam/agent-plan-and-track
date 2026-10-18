#!/usr/bin/env node
'use strict';

/**
 * Regression coverage for check-doc-links.js. Free and offline: every case
 * writes a small scratch repo tree under os.tmpdir(), spawns the real script
 * against it with the tree as its positional repo-root argument, and inspects
 * the exit code plus distinguishing substrings of stdout/stderr; nothing here
 * calls a model or the network and the real repo files are never touched.
 *
 * Every case starts from the same clean tree (baseFiles()) and overrides or
 * adds files, so each failing case isolates one rule and each passing case
 * isolates one thing the checker must ignore. For each failing case the
 * assertions require the file:line, the offending target, and a "fix:" hint,
 * since the FAIL line is the checker's whole interface.
 */

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, 'check-doc-links.js');

function baseFiles() {
  return {
    'README.md': '# Readme\n\nSee [the catalog](docs/skills.md).\n',
    'AGENTS.md': '# Agents\n',
    'docs/skills.md': '# Skills\n\n- **`alpha`** does a thing.\n- **beta** does another.\n',
    'docs/other.md': '# Other\n\nBack to [readme](../README.md).\n',
    'skills/alpha/SKILL.md': '# alpha\n\nPair with [[beta]] and [[helper]].\nRead [references/x.md](references/x.md).\n',
    'skills/alpha/references/x.md': '# x\n',
    'skills/beta/SKILL.md': '# beta\n',
    'agents/helper.md': '# helper\n',
    'rules/core.md': '# core\n',
  };
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function runChecker(root) {
  return childProcess.spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
}

function assertExitAndSubstrings(result, expectedStatus, stream, substrings) {
  const detail = `\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
  assert.strictEqual(result.status, expectedStatus, `expected exit ${expectedStatus}, got ${result.status}${detail}`);
  for (const substring of substrings) {
    assert.ok(result[stream].includes(substring), `expected ${stream} to include "${substring}"${detail}`);
  }
}

// Builds the tree with the given overrides and expects a clean pass.
function expectPass(dir, overrides) {
  writeTree(dir, { ...baseFiles(), ...overrides });
  assertExitAndSubstrings(runChecker(dir), 0, 'stdout', ['OK:']);
}

// Builds the tree with the given overrides and expects one FAIL naming the
// file:line, the target, and a fix hint.
function expectFail(dir, overrides, location, target) {
  writeTree(dir, { ...baseFiles(), ...overrides });
  assertExitAndSubstrings(runChecker(dir), 1, 'stderr', ['FAIL:', location, target, 'fix:']);
}

async function passCleanTree(dir) {
  expectPass(dir, {});
}

async function unresolvedWikiLinkFails(dir) {
  expectFail(
    dir,
    { 'skills/beta/SKILL.md': '# beta\n\nsee also\n[[ghost]]\n' },
    'skills/beta/SKILL.md:4',
    '[[ghost]]'
  );
}

async function wikiLinkResolvesToAgent(dir) {
  expectPass(dir, { 'rules/core.md': '# core\n\nAsk [[helper]].\n' });
}

async function missingRelativeLinkFails(dir) {
  expectFail(
    dir,
    { 'docs/other.md': '# Other\n\nline\nSee [gone](missing/page.md) here.\n' },
    'docs/other.md:4',
    'missing/page.md'
  );
}

async function missingImageFails(dir) {
  expectFail(dir, { 'README.md': '# Readme\n![shot](img/shot.png)\n' }, 'README.md:2', 'img/shot.png');
}

async function missingReferenceDefinitionFails(dir) {
  expectFail(dir, { 'README.md': '# Readme\n\n[ref]: docs/nope.md\n' }, 'README.md:3', 'docs/nope.md');
}

async function skillMissingFromCatalogFails(dir) {
  expectFail(
    dir,
    { 'skills/gamma/SKILL.md': '# gamma\n' },
    'skills/gamma/SKILL.md:1',
    'gamma'
  );
}

async function skillNameOnlyInsideLongerTokenFails(dir) {
  // "gamma" appears only as part of "gamma-extended", which is not a token match.
  expectFail(
    dir,
    {
      'skills/gamma/SKILL.md': '# gamma\n',
      'docs/skills.md': '# Skills\n\n- `alpha`, beta, and `gamma-extended`.\n',
    },
    'skills/gamma/SKILL.md:1',
    'gamma'
  );
}

async function missingScopeDirFails(dir) {
  writeTree(dir, baseFiles());
  fs.rmSync(path.join(dir, 'agents'), { recursive: true, force: true });
  assertExitAndSubstrings(runChecker(dir), 1, 'stderr', ['FAIL:', 'agents', 'fix:']);
}

async function wikiLinkInCodeIgnored(dir) {
  expectPass(dir, {
    'skills/beta/SKILL.md': [
      '# beta',
      '',
      'Inline `[[ghost]]` and ``[[ghost2]]`` are examples.',
      '',
      '```bash',
      '[[ ghost3 ]] and [[ghost4]]',
      '```',
      '',
      '~~~~',
      '[[ghost5]]',
      '```',
      '[[ghost6]]',
      '~~~~',
      '',
    ].join('\n'),
  });
}

async function brokenLinkInCodeIgnored(dir) {
  expectPass(dir, {
    'docs/other.md': [
      '# Other',
      '',
      'Inline `[x](nope.md)` is an example.',
      '',
      '```md',
      '[x](also-missing.md)',
      '[ref]: gone.md',
      '```',
      '',
    ].join('\n'),
  });
}

async function urlsAnchorsAndFragmentsIgnored(dir) {
  expectPass(dir, {
    'docs/other.md': [
      '# Other',
      '',
      '[web](https://example.com/a/b) [mail](mailto:a@example.com) [rel](//cdn.example.com/x)',
      '[top](#other) [frag](../README.md#readme) [query](../README.md?plain=1#readme)',
      '[angle](<../README.md> "a title") [titled](../README.md \'t\') [enc](my%20file.md)',
      '[root](/README.md)',
      '',
    ].join('\n'),
    'docs/my file.md': '# spaced\n',
  });
}

async function crlfFilesScanned(dir) {
  expectPass(dir, {
    'docs/other.md': '# Other\r\n\r\n[ok](../README.md)\r\n```\r\n[bad](nope.md)\r\n```\r\n',
  });
  writeTree(dir, { 'docs/other.md': '# Other\r\n\r\n[bad](nope.md)\r\n' });
  assertExitAndSubstrings(runChecker(dir), 1, 'stderr', ['docs/other.md:3', 'nope.md', 'fix:']);
}

const CASES = [
  ['pass-clean-tree', passCleanTree],
  ['unresolved-wiki-link-fails', unresolvedWikiLinkFails],
  ['wiki-link-resolves-to-agent', wikiLinkResolvesToAgent],
  ['missing-relative-link-fails', missingRelativeLinkFails],
  ['missing-image-fails', missingImageFails],
  ['missing-reference-definition-fails', missingReferenceDefinitionFails],
  ['skill-missing-from-catalog-fails', skillMissingFromCatalogFails],
  ['skill-name-only-inside-longer-token-fails', skillNameOnlyInsideLongerTokenFails],
  ['missing-scope-dir-fails', missingScopeDirFails],
  ['wiki-link-in-code-ignored', wikiLinkInCodeIgnored],
  ['broken-link-in-code-ignored', brokenLinkInCodeIgnored],
  ['urls-anchors-and-fragments-ignored', urlsAnchorsAndFragmentsIgnored],
  ['crlf-files-scanned', crlfFilesScanned],
];

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-doc-links-fixtures-'));
  let failures = 0;
  try {
    for (const [id, handler] of CASES) {
      try {
        await handler(path.join(dir, id));
        process.stdout.write(`PASS ${id}\n`);
      } catch (err) {
        process.stdout.write(`FAIL ${id}: ${(err && err.stack) || err}\n`);
        failures += 1;
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write(`${CASES.length - failures}/${CASES.length} PASS\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
