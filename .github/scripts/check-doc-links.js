#!/usr/bin/env node
'use strict';

/**
 * Guards the cross-references between this repo's markdown files, which
 * nothing else checks: a renamed or deleted skill leaves dangling [[name]]
 * wiki-links, a moved doc leaves dead relative links, and a new skill can
 * ship without a catalog entry. Ideas adapted from LilMGenius/paperthin's
 * link and catalog checks (see docs/credits.md), rewritten in Node built-ins.
 *
 * Invocation: node .github/scripts/check-doc-links.js [repo-root]
 * With no argument, the repo root is resolved relative to this script's own
 * location. The optional positional arg points the checker at a scratch tree,
 * used by run-check-doc-links-fixtures.js to prove each rule can actually
 * fail without touching the real files.
 *
 * Scopes (relative to the repo root):
 *   wiki-link scope: every *.md under skills/ (recursive), agents/*.md,
 *     rules/*.md
 *   link scope: the wiki-link scope plus README.md, AGENTS.md, docs/*.md
 *   skills: each skills/<name>/ directory containing SKILL.md
 * Rules (a) and (b) skip fenced code blocks and inline code spans, since a
 * link written inside code is an example, not a link. Rule (c) skips fenced
 * blocks only, since real catalog entries name skills in inline code. Each
 * file is scanned whole rather than line by line, so a code span wrapped
 * across lines (until a blank line ends the paragraph) and a link
 * destination after one line break are both handled.
 *
 * The link parser covers the CommonMark subset this repo's docs use (inline
 * links and images, reference definitions, quoted and parenthesized titles,
 * backslash escapes in destinations). Known gap: any "](" counts as the end
 * of a link label, so literal text such as an escaped "\[x](y.md)" is
 * checked as a link. That gap fails loudly rather than letting a broken link
 * pass; wrap such text in inline code.
 *
 * Rules (HARD, each finding is one FAIL line on stderr):
 *   (a) wiki-links: a [[name]] must resolve to skills/<name>/SKILL.md or
 *       agents/<name>.md.
 *   (b) relative links: the target of an inline link, image, or reference
 *       definition must exist on disk. Targets with a URI scheme (http,
 *       mailto, ...), protocol-relative // targets, and pure #anchor targets
 *       are ignored; #fragment and ?query are stripped before the check.
 *   (c) catalog sync: every skill name must appear as a token (bounded by
 *       characters outside [A-Za-z0-9_-]) in docs/skills.md.
 *
 * Failure format: FAIL: <file>:<line>: <rule>: <target> <problem>; fix: <hint>
 * A missing scope directory or docs/skills.md throws loudly instead of
 * passing on an empty scan.
 *
 * Exit 1 if any rule is violated or a required path is missing. Exit 0
 * otherwise, with one OK line on stdout giving the scan counts.
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', '..');

const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;
const WIKI_LINK = /\[\[([^\[\]\n]+?)\]\]/g;
// A definition's destination may follow its label after one line break.
const REFERENCE_DEFINITION = /^ {0,3}\[([^\]^][^\]]*)\]:[ \t]*\n?[ \t]*(<[^>\n]*>|\S+)/gm;
// Link titles: double-quoted, single-quoted, or parenthesized, with escapes.
const LINK_TITLE = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))/;
// A backslash before ASCII punctuation is a markdown escape, removed before
// the destination is resolved.
const ESCAPED_PUNCTUATION = /\\([!-/:-@[-`{-~])/g;

// --- File discovery ---

function relPath(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function listDir(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(
      `required directory not found: ${relPath(dir)} under ${ROOT}; ` +
      'fix: pass the repo root as the first argument, or restore the directory'
    );
  }
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function markdownIn(dir, recursive) {
  const found = [];
  for (const entry of listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      found.push(...markdownIn(full, true));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      found.push(full);
    }
  }
  return found;
}

function skillNames() {
  return listDir(path.join(ROOT, 'skills'))
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, 'skills', entry.name, 'SKILL.md')))
    .map((entry) => entry.name);
}

// --- Markdown scanning ---

// Returns the file as LF-joined text with every fenced block, fence lines
// included, replaced by empty lines, so line numbers survive. Fenced blocks
// open on 3+ backticks or tildes and close on the same character at >= the
// opening length.
function unfencedText(content) {
  let fence = null;
  return content.split(/\r?\n/).map((raw) => {
    if (fence) {
      const close = raw.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      return '';
    }
    const open = raw.match(FENCE_OPEN);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], length: open[1].length };
      return '';
    }
    return raw;
  }).join('\n');
}

// Blanks inline code spans with spaces, keeping newlines so line numbers
// survive. A span is a backtick run closed by a run of the same length
// before the paragraph ends (a blank line), so a span may wrap across lines;
// a run with no such close is literal text. Outside a span, a backslash
// escapes the next character, so an escaped backtick opens nothing; inside
// a span, backslashes are literal.
function blankInlineCode(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (text[i] !== '`') {
      out += text[i];
      i += 1;
      continue;
    }
    let runEnd = i;
    while (text[runEnd] === '`') runEnd += 1;
    const runLength = runEnd - i;
    const paragraphBreak = /\n[ \t]*\n/g;
    paragraphBreak.lastIndex = runEnd;
    const breakMatch = paragraphBreak.exec(text);
    const limit = breakMatch ? breakMatch.index : text.length;
    let close = -1;
    let search = runEnd;
    while (search < limit) {
      const next = text.indexOf('`', search);
      if (next === -1 || next >= limit) break;
      let nextEnd = next;
      while (text[nextEnd] === '`') nextEnd += 1;
      if (nextEnd - next === runLength) {
        close = nextEnd;
        break;
      }
      search = nextEnd;
    }
    if (close === -1) {
      out += text.slice(i, runEnd);
      i = runEnd;
    } else {
      out += text.slice(i, close).replace(/[^\n]/g, ' ');
      i = close;
    }
  }
  return out;
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

// Skips spaces and tabs with at most one line break among them, the
// whitespace a link destination and its title may sit between.
function skipLinkSpace(text, start) {
  let i = start;
  while (text[i] === ' ' || text[i] === '\t') i += 1;
  if (text[i] === '\n') {
    i += 1;
    while (text[i] === ' ' || text[i] === '\t') i += 1;
  }
  return i;
}

// Parses the destination of an inline link starting just after "](".
// Returns { index, target } (index is where the target starts) or null when
// the parentheses never close as a link.
function parseInlineTarget(text, start) {
  let i = skipLinkSpace(text, start);
  const index = i;
  let target;
  if (text[i] === '<') {
    const end = text.indexOf('>', i);
    if (end === -1) return null;
    target = text.slice(i + 1, end);
    i = end + 1;
  } else {
    let depth = 0;
    const from = i;
    while (i < text.length && !/\s/.test(text[i])) {
      if (text[i] === '\\' && i + 1 < text.length && !/\s/.test(text[i + 1])) {
        i += 2;
        continue;
      }
      if (text[i] === '(') depth += 1;
      if (text[i] === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
      i += 1;
    }
    target = text.slice(from, i);
  }
  i = skipLinkSpace(text, i);
  const title = text.slice(i).match(LINK_TITLE);
  if (title) i = skipLinkSpace(text, i + title[0].length);
  return text[i] === ')' ? { index, target } : null;
}

// Returns [{ index, target }] for every reference definition and inline
// link or image in the (unfenced, code-blanked) text.
function linkTargets(text) {
  const targets = [];
  for (const definition of text.matchAll(REFERENCE_DEFINITION)) {
    const raw = definition[2];
    targets.push({
      index: definition.index + definition[0].length - raw.length,
      target: raw.startsWith('<') ? raw.slice(1, -1) : raw,
    });
  }
  let from = 0;
  for (;;) {
    const at = text.indexOf('](', from);
    if (at === -1) break;
    const parsed = parseInlineTarget(text, at + 2);
    if (parsed !== null) targets.push(parsed);
    from = at + 2;
  }
  return targets;
}

// Returns the on-disk path a link target points at, or null for targets this
// checker ignores (URI scheme, protocol-relative, pure #anchor, empty).
function resolveTarget(file, rawTarget) {
  const target = rawTarget.trim();
  if (target === '' || target.startsWith('#') || target.startsWith('//') || URI_SCHEME.test(target)) {
    return null;
  }
  const bare = target.replace(ESCAPED_PUNCTUATION, '$1').split(/[#?]/)[0];
  if (bare === '') return null;
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    /* malformed %xx escape: check the raw text rather than crash */
  }
  return decoded.startsWith('/')
    ? path.join(ROOT, decoded)
    : path.resolve(path.dirname(file), decoded);
}

// --- Rules ---

function main() {
  const wikiFiles = [
    ...markdownIn(path.join(ROOT, 'skills'), true),
    ...markdownIn(path.join(ROOT, 'agents'), false),
    ...markdownIn(path.join(ROOT, 'rules'), false),
  ];
  const linkFiles = [
    ...wikiFiles,
    path.join(ROOT, 'README.md'),
    path.join(ROOT, 'AGENTS.md'),
    ...markdownIn(path.join(ROOT, 'docs'), false),
  ];
  const wikiSet = new Set(wikiFiles);

  const findings = [];
  let wikiCount = 0;
  let linkCount = 0;

  for (const file of linkFiles) {
    const label = relPath(file);
    const text = blankInlineCode(unfencedText(fs.readFileSync(file, 'utf8')));
    if (wikiSet.has(file)) {
      for (const match of text.matchAll(WIKI_LINK)) {
        wikiCount += 1;
        const name = match[1].trim();
        const resolved =
          fs.existsSync(path.join(ROOT, 'skills', name, 'SKILL.md')) ||
          fs.existsSync(path.join(ROOT, 'agents', `${name}.md`));
        if (!resolved) {
          findings.push(
            `${label}:${lineAt(text, match.index)}: wiki-link: [[${name}]] matches no skills/${name}/SKILL.md ` +
            `or agents/${name}.md; fix: correct the name or add the skill/agent`
          );
        }
      }
    }
    for (const { index, target: rawTarget } of linkTargets(text)) {
      const resolved = resolveTarget(file, rawTarget);
      if (resolved === null) continue;
      linkCount += 1;
      if (!fs.existsSync(resolved)) {
        findings.push(
          `${label}:${lineAt(text, index)}: relative-link: ${rawTarget.trim()} does not exist ` +
          `(resolved to ${relPath(resolved)}); fix: correct the path or create the file`
        );
      }
    }
  }

  const catalogPath = path.join(ROOT, 'docs', 'skills.md');
  if (!fs.existsSync(catalogPath)) {
    throw new Error(
      `required file not found: ${relPath(catalogPath)} under ${ROOT}; ` +
      'fix: pass the repo root as the first argument, or restore the skills catalog'
    );
  }
  const catalog = unfencedText(fs.readFileSync(catalogPath, 'utf8'));
  const skills = skillNames();
  for (const name of skills) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`).test(catalog)) {
      findings.push(
        `skills/${name}/SKILL.md:1: catalog-sync: ${name} is not named in docs/skills.md; ` +
        'fix: add an entry for it to docs/skills.md'
      );
    }
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(`FAIL: ${finding}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(
    `OK: scanned ${linkFiles.length} files, ${wikiCount} wiki-links, ${linkCount} relative links, ` +
    `${skills.length} skills checked against docs/skills.md\n`
  );
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`FAIL: ${err.message}\n`);
  process.exit(1);
}
