#!/usr/bin/env node
/**
 * scan-rules.js: index this repo's rule files (H2 headings + line counts) so a
 * distill run can check candidates against what the rules already cover.
 *
 * Usage: node scan-rules.js [RULES_DIR]
 * Output: JSON to stdout.
 *
 * Cross-platform Node port of scan-rules.sh. Same arguments, same defaults, same
 * output. Unlike the shell original it needs no external tools (no bash, jq,
 * find, wc, grep, or sed), so it runs unchanged on Windows, macOS, and Linux.
 *
 * This repo is the source of truth for the rules (README: "This repo is the
 * source of truth"), so we index the repo's rules/ dir, NOT the per-tool
 * installed copies. Run from the repo root, or pass the rules dir explicitly.
 *
 * Parity notes vs scan-rules.sh:
 *   - The shell script guards `command -v jq` and exits 1 when jq is missing.
 *     This port has no jq dependency, so that check is intentionally dropped:
 *     the whole point of the rewrite is to stop requiring jq. When jq IS present
 *     (the case where the two scripts can be compared), the stdout is identical.
 *   - The shell builds one `$tmpdir/$i.json` per file, then merges them with
 *     `jq -s "$tmpdir"/*.json`, whose glob sorts filenames LEXICOGRAPHICALLY
 *     ("0.json","1.json","10.json","2.json",...) rather than numerically. For up
 *     to ten files this equals the sorted find order; with eleven or more it
 *     reorders them. We reproduce that exact order so the output matches
 *     byte-for-byte. See reorderLikeGlob() below; it is a quirk of the original,
 *     preserved deliberately and flagged for a possible future cleanup.
 *
 * Environment:
 *   RULES_DISTILL_DIR  Override the rules dir (for testing).
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Resolve the rules dir with the shell's precedence: `${RULES_DISTILL_DIR:-${1:-
// $PWD/rules}}`. The `:-` operator treats an empty string as unset, so a set but
// empty env var or arg falls through to the next candidate.
function resolveRulesDir() {
  const env = process.env.RULES_DISTILL_DIR;
  if (env) return env; // non-empty env wins
  const arg = process.argv[2];
  if (arg) return arg; // non-empty first CLI arg
  return path.join(process.cwd(), 'rules'); // $PWD/rules
}

// jq pretty-prints with a two-space indent and a trailing newline; JSON.stringify
// with the same indent produces byte-identical output for the value shapes here
// (object key order preserved, empty arrays inline as `[]`, forward slashes and
// printable Unicode left unescaped, the same control-char escapes). One shared
// helper keeps stdout and the error path formatted identically to jq.
function toJqJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

// Recursively collect `*.md` regular files under `dir`, mirroring
// `find "$dir" -name '*.md' -type f`. `withFileTypes` uses lstat semantics, so
// (like find with no -L/-H) symlinks are never followed: a symlinked directory
// is not descended and a symlink to a file is not matched by -type f. Read
// errors are swallowed to match find's `2>/dev/null`.
function findMarkdown(dir) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      found.push(full);
    }
  }
  return found;
}

// Build the per-file record: basename, newline count, and H2 headings.
//   - Headings: `grep -E '^## '` then `sed 's/^## //'`, i.e. every line that
//     begins with "## " (hash hash space) with those three characters stripped.
//     Only exact H2 lines qualify; "### " has a '#' where the space must be.
//   - Lines: `wc -l`, i.e. the count of '\n' bytes (a file whose last line has
//     no trailing newline does not count that line). splitting on '\n' and
//     subtracting one yields exactly that count.
function buildRecord(file) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const headings = [];
  for (const line of lines) {
    if (line.startsWith('## ')) headings.push(line.slice(3));
  }
  return {
    file: path.basename(file),
    lines: lines.length - 1,
    headings,
  };
}

// Reorder the sorted file list into the order the shell's `jq -s "$tmpdir"/*.json`
// glob would merge them: filenames "0.json".."N.json" sorted as strings, not as
// numbers. Identity for up to ten files; only 11+ files diverge. See the header
// parity note.
function reorderLikeGlob(files) {
  return files
    .map((file, index) => ({ file, key: String(index) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((item) => item.file);
}

function main() {
  const rulesDir = resolveRulesDir();

  // `[[ ! -d "$RULES_DIR" ]]`: statSync follows symlinks, matching `-d`.
  let stat = null;
  try {
    stat = fs.statSync(rulesDir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    process.stderr.write(
      toJqJson({
        error: 'rules dir not found: run from the repo root or pass RULES_DIR',
        path: rulesDir,
      })
    );
    process.exit(1);
  }

  // `find ... | sort`: default string sort compares UTF-16 code units, which for
  // the ASCII paths here equals the C-locale byte order find|sort produces.
  const files = findMarkdown(rulesDir).sort();
  const rules = reorderLikeGlob(files).map(buildRecord);

  process.stdout.write(
    toJqJson({
      rules_dir: rulesDir,
      total: rules.length,
      rules,
    })
  );
}

try {
  main();
} catch (err) {
  // The shell runs under `set -euo pipefail`, so an unexpected failure (e.g. a
  // file vanishing mid-scan) aborts with a nonzero status. Mirror that instead
  // of emitting partial JSON.
  process.stderr.write(`error: ${err && err.message}\n`);
  process.exit(1);
}
