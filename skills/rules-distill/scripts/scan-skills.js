#!/usr/bin/env node
/**
 * scan-skills.js: enumerate installed skills across every supported harness and
 * extract each skill's name/description/mtime as a JSON inventory.
 *
 * Usage: node scan-skills.js [EXTRA_SKILLS_DIR ...]
 * Output: JSON to stdout. Node core only (fs/os/path), no jq/awk/find/sort.
 *
 * Tool-agnostic: scans the user-scope skills dir of Claude Code, GitHub Copilot,
 * and Codex (whichever exist), plus any dirs passed as arguments (e.g. this
 * repo's own skills/ when run from the repo root). Duplicate skill names across
 * dirs are reported as-is: a distill run treats them as one skill by name.
 *
 * Cross-platform Node port of scan-skills.sh (the bash/jq/awk/find/sort
 * original), written so it runs where bash does not (Windows). Output matches
 * the shell version byte-for-byte on LF-terminated skill files, including the
 * array ordering quirk described in buildInventory() below.
 *
 * Two deliberate, documented behaviors differ from a literal transcription of
 * the shell, both invisible on the platform where both scripts run:
 *   1. CRLF safety: each line is read with a trailing carriage return stripped,
 *      so YAML frontmatter still parses on Windows-checked-out (CRLF) files. The
 *      awk original matches `^---$` exactly and would silently return empty
 *      fields on CRLF. On LF files the strip is a no-op, so output is identical.
 *   2. path.delimiter for RULES_DISTILL_SKILLS_DIRS: `:` on POSIX (matching the
 *      shell) and `;` on Windows, so Windows drive letters (C:\...) are not
 *      mis-split. On POSIX this is the same `:` the shell uses.
 *
 * Environment:
 *   RULES_DISTILL_SKILLS_DIRS  Delimiter-separated dirs to scan instead of the
 *                              default harness dirs (for testing).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

// Default scan set: the three harness user-scope skills dirs. Built with
// path.join off the real home dir so it resolves on Windows too (no bare $HOME).
const DEFAULT_DIRS = [
  path.join(HOME, '.claude', 'skills'),
  path.join(HOME, '.copilot', 'skills'),
  path.join(HOME, '.agents', 'skills'),
];

// Render a leading $HOME as `~`, mirroring bash `${p/#$HOME/~}`: a literal
// prefix replacement, applied to both the file path and its source dir.
function toDisplay(p) {
  if (HOME && typeof p === 'string' && p.startsWith(HOME)) {
    return '~' + p.slice(HOME.length);
  }
  return p;
}

// Extract a single-line frontmatter field (quoted or unquoted), reproducing the
// awk in the shell version: only lines between the first and second `---`, only
// a line that starts with `<field>: ` (colon then one space), value is the rest
// with at most one leading and one trailing double quote removed. Does not
// handle multi-line YAML blocks or nested keys. Returns '' when not found.
function extractField(lines, field) {
  const prefix = field + ': ';
  let fm = 0; // count of `---` delimiter lines seen so far
  for (const raw of lines) {
    const line = raw.replace(/\r$/, ''); // CRLF-safe; no-op on LF (see header)
    if (line === '---') {
      fm++;
      continue;
    }
    if (fm >= 2) break; // past the frontmatter block
    if (fm === 1 && line.startsWith(prefix)) {
      return line.slice(prefix.length).replace(/^"/, '').replace(/"$/, '');
    }
  }
  return '';
}

// File mtime as UTC ISO8601 (YYYY-MM-DDTHH:MM:SSZ), truncated to whole seconds
// to match `stat %Y` + `date -u`. Returns '' if the file can't be stat'd, like
// the shell's get_mtime early return.
function getMtime(file) {
  let secs;
  try {
    secs = Math.floor(fs.statSync(file).mtimeMs / 1000);
  } catch {
    return '';
  }
  return new Date(secs * 1000).toISOString().slice(0, 19) + 'Z';
}

// Recursively collect regular files named exactly `SKILL.md` under `root`,
// mirroring `find <root> -name SKILL.md -type f`. Dirent types use lstat
// semantics, so symlinks are neither followed nor matched (find's default).
// Paths are built by appending to the verbatim `root` prefix rather than via
// path.join, so a relative start like `./skills` stays `./skills/...` exactly as
// find prints it. Unreadable dirs are skipped (find warns and moves on).
function collectSkillFiles(root, out) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = root + path.sep + ent.name;
    if (ent.isDirectory()) {
      collectSkillFiles(full, out);
    } else if (ent.isFile() && ent.name === 'SKILL.md') {
      out.push(full);
    }
  }
}

// One dir's SKILL.md files, sorted like `find ... | sort`. Plain lexical sort
// matches the sort utility for these ASCII paths (verified against the C and
// en_US.UTF-8 collations that ship on these harnesses).
function findSkillFiles(dir) {
  // find strips a trailing slash from its start path (`find d/` -> `d/x`), so
  // normalize the walk root while leaving the original `dir` for the source
  // field, which the shell reports verbatim.
  const root = dir.replace(/[\\/]+$/, '') || dir;
  const out = [];
  collectSkillFiles(root, out);
  out.sort();
  return out;
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Resolve the dir list: RULES_DISTILL_SKILLS_DIRS (if non-empty) replaces the
// default harness dirs, then any positional args are appended. Empty entries are
// left for the existence check below to drop, matching the shell.
function resolveDirs() {
  const env = process.env.RULES_DISTILL_SKILLS_DIRS;
  const base = env && env.length > 0 ? env.split(path.delimiter) : DEFAULT_DIRS.slice();
  return base.concat(process.argv.slice(2));
}

function buildInventory(dirs) {
  const seen = new Set();
  const records = []; // one per SKILL.md, in scan order (dir order, sorted within)

  for (const dir of dirs) {
    if (!dir || !isDirectory(dir)) continue;
    // Skip a dir already scanned (harnesses can share ~/.agents/skills); dedup
    // on the exact string, like the shell's seen_dirs.
    if (seen.has(dir)) continue;
    seen.add(dir);

    const source = toDisplay(dir);
    for (const file of findSkillFiles(dir)) {
      const lines = readFileSafe(file).split('\n');
      records.push({
        path: toDisplay(file),
        name: extractField(lines, 'name'),
        description: extractField(lines, 'description'),
        mtime: getMtime(file),
        source,
      });
    }
  }

  // The shell writes each record to <i>.json (i is a global counter) and then
  // reassembles with `jq -s '.' *.json`. The shell glob sorts those filenames
  // lexically, so with 10+ skills the array order is 0,1,10,11,...,2,20,...,
  // not numeric insertion order. Reproduce that by sorting the indices as the
  // filename strings the glob would have seen.
  const order = records.map((_, i) => i).sort((a, b) => {
    const fa = a + '.json';
    const fb = b + '.json';
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
  const skills = order.map((i) => records[i]);

  return { count: skills.length, skills };
}

function main() {
  const inventory = buildInventory(resolveDirs());
  // jq pretty-prints with 2-space indent and a trailing newline; JSON.stringify
  // with the same indent produces byte-identical output for this data (jq and
  // JSON.stringify escape the same set of characters and emit non-ASCII, such as
  // em dashes in descriptions, as raw UTF-8).
  process.stdout.write(JSON.stringify(inventory, null, 2) + '\n');
}

main();
