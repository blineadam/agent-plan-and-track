#!/usr/bin/env node
/**
 * scan-context.js: estimate the always-on context cost of the agent config
 * (skills + instruction files + rules digest) and flag oversized components.
 *
 * Usage: scan-context.js [EXTRA_SKILLS_DIR ...]
 * Output: JSON to stdout. Node built-ins only (fs, path, os); no jq/awk/wc.
 *
 * This is a faithful, cross-platform (Windows/macOS/Linux) port of the sibling
 * scan-context.sh. Same arguments, same environment variables, same defaults,
 * and byte-for-byte the same stdout for a given filesystem. All file walking
 * and text processing is done in pure JS so there is no bash/jq/awk dependency.
 *
 * Tool-agnostic: scans the user-scope skills dir of Claude Code, GitHub Copilot,
 * and Codex (whichever exist), plus any dirs passed as arguments (e.g. this
 * repo's own skills/ when run from the repo root); each harness's instruction
 * file (CLAUDE.md / AGENTS.md / copilot-instructions.md); and the core-rules
 * digest (core-rules.md) wherever it is installed.
 *
 * Token estimate is deliberately crude: words x 1.3. It is a relative signal for
 * spotting bloat, not an exact tokenizer count.
 *
 * What counts as "always on": a skill's SKILL.md frontmatter (name + description)
 * is what loads into every session; the body loads only when the skill fires.
 * So we report BOTH: `frontmatter_tokens` (the always-on cost) and `body_tokens`
 * (the on-demand cost), and size-flag on total file lines (in practice the
 * body; frontmatter is only a few lines).
 *
 * Thresholds (override via env): SKILL_LINE_LIMIT (400), RULES_LINE_LIMIT (100),
 * INSTRUCTIONS_LINE_LIMIT (300).
 *
 * Environment:
 *   CONTEXT_BUDGET_SKILLS_DIRS  Colon-separated dirs to scan instead of the
 *                               default harness dirs (for testing).
 *   CONTEXT_BUDGET_CONFIG_DIRS  Colon-separated dirs to search for instruction
 *                               files + core-rules.md instead of the defaults.
 *
 * Parity notes (differences from the .sh that are cosmetic and intentional):
 *   - Ordering. The .sh emits skills/configs in shell-glob order of temp files
 *     ("skill.<i>.json"), which is lexicographic on the index string, not
 *     numeric (0, 1, 10, 11, ... 19, 2, 20 ...). We reproduce that exact order
 *     by sorting entries on String(index). Both the per-directory `find | sort`
 *     and the glob use byte/codepoint order for these ASCII paths (verified to
 *     match the ambient en_US.UTF-8 collation on this repo), which is what JS
 *     string comparison gives.
 *   - Token math. `words * 1.3 + 0.5` truncated to an integer, computed in IEEE
 *     754 doubles exactly as awk's `printf "%d"` does, so counts are identical.
 *   - Output shape. We emit the same object with the same key order and print it
 *     with 2-space indentation plus a trailing newline, matching jq's default
 *     pretty-printer for this data.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// $HOME as the .sh sees it, used for both the default scan dirs and the
// `${path/#$HOME/~}` home-to-tilde rewrite. os.homedir() equals $HOME on
// macOS/Linux and gives a sane value on Windows where HOME may be unset.
const HOME = process.env.HOME || os.homedir();

// Line thresholds. `${VAR:-default}` semantics: use the env value only when set
// and non-empty, otherwise the default. Parsed as an integer to mirror jq's
// --argjson (the .sh passes these through as JSON numbers).
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

const SKILL_LINE_LIMIT = intEnv('SKILL_LINE_LIMIT', 400);
const RULES_LINE_LIMIT = intEnv('RULES_LINE_LIMIT', 100);
const INSTRUCTIONS_LINE_LIMIT = intEnv('INSTRUCTIONS_LINE_LIMIT', 300);

// --- Text metrics (pure JS equivalents of wc -w, wc -l, and the token math) ---

// wc -w: number of whitespace-delimited words. Whitespace is the classic C set
// (space, tab, newline, vertical tab, form feed, carriage return); the config
// files are ASCII text, so this matches wc -w exactly.
function wordCount(text) {
  const m = text.match(/[^ \t\n\v\f\r]+/g);
  return m ? m.length : 0;
}

// wc -l: number of newline characters (a final line without a trailing newline
// is not counted, same as wc).
function lineCount(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

// Token estimate: words * 1.3 rounded to nearest via truncation of (x + 0.5).
// Word counts are non-negative, so trunc toward zero equals floor here, and the
// double arithmetic mirrors awk's `printf "%d", (w * 1.3) + 0.5` bit for bit.
function tokensFromText(text) {
  return Math.trunc(wordCount(text) * 1.3 + 0.5);
}

// The YAML frontmatter block (between the first two lines that are exactly
// "---"), which is the always-on part of a skill. Mirrors the awk that prints
// records while fm==1 and exits on the second "---". Line ending is exactly
// "---" (a CRLF file would carry a trailing \r and not match, same as the .sh).
function frontmatterText(content) {
  const lines = content.split('\n');
  let fm = 0;
  const out = [];
  for (const line of lines) {
    if (line === '---') {
      fm++;
      if (fm >= 2) break;
      continue;
    }
    if (fm === 1) out.push(line);
  }
  return out.join('\n');
}

// --- Path helpers ---

// `${p/#$HOME/~}`: replace a leading $HOME with "~", leave other paths alone.
function homeToTilde(p) {
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
}

// Read a regular file's text, or null if it is not a readable regular file.
function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Join a parent path with a child using a forward slash, the way the shell does
// (`"$dir/$base"`) and the way find prints its results. Deliberately does NOT
// normalize: path.join would collapse a leading "./" and a doubled slash, which
// would diverge from the .sh output. Forward slashes are accepted by Node fs on
// every platform, so this stays cross-platform.
function joinChild(parent, child) {
  return parent + '/' + child;
}

// find strips trailing slashes from its start operand ("skills/" is walked and
// printed as "skills"), while a bare "/" is left intact. Applied only to the
// walk root; interior names come from readdir and never carry a trailing slash.
function stripTrailingSlashes(p) {
  let s = p;
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

// `[[ -f p ]]`: exists and is a regular file (follows symlinks, like test -f).
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// `find "$dir" -name SKILL.md -type f`: every regular file named SKILL.md under
// dir. Like find without -L, symlinked directories are not descended and a
// symlinked SKILL.md is not counted (Dirent flags come from lstat). Returned
// unsorted; callers sort to reproduce `| sort`.
function findSkillFiles(dir) {
  const out = [];
  // find echoes back the literal start operand as the path prefix, minus any
  // trailing slash, then joins children with forward slashes.
  const stack = [stripTrailingSlashes(dir)];
  while (stack.length > 0) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue; // unreadable dir: find would warn (2>/dev/null) and skip it
    }
    for (const ent of entries) {
      const full = joinChild(d, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name === 'SKILL.md') out.push(full);
    }
  }
  return out;
}

// Byte/codepoint order, matching the ASCII `sort` and shell-glob order the .sh
// relies on for both file paths and the "skill.<i>.json" temp-file names.
function byteCmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Split a colon-separated env list the way `IFS=':' read -a` does.
function splitColon(value) {
  return value.split(':');
}

// hkey: classify a path/source string to the harness it belongs to. Mirrors the
// jq regex tests, in the same priority order.
function harnessKey(s) {
  if (/\.claude/.test(s)) return 'claude';
  if (/\.copilot/.test(s)) return 'copilot';
  if (/\.agents|\.codex/.test(s)) return 'codex';
  return 'repo';
}

function sum(values) {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

// hstats: the per-harness always-on summary, matching the jq def of the same
// name (empty arrays sum to 0, as in jq's `(... | add) // 0`).
function harnessStats(skillsArr, configsArr) {
  const fm = sum(skillsArr.map((s) => s.frontmatter_tokens));
  const ct = sum(configsArr.map((c) => c.tokens));
  return {
    skill_count: skillsArr.length,
    skill_frontmatter_tokens: fm,
    skill_body_tokens: sum(skillsArr.map((s) => s.body_tokens)),
    config_tokens: ct,
    always_on_tokens: fm + ct,
    oversized:
      skillsArr.filter((s) => s.over_limit).length +
      configsArr.filter((c) => c.over_limit).length,
  };
}

function main() {
  const args = process.argv.slice(2);

  // Default scan sets.
  const defaultSkillsDirs = [
    path.join(HOME, '.claude', 'skills'),
    path.join(HOME, '.copilot', 'skills'),
    path.join(HOME, '.agents', 'skills'),
  ];
  const defaultConfigDirs = [
    path.join(HOME, '.claude'),
    path.join(HOME, '.copilot'),
    path.join(HOME, '.codex'),
  ];

  // CONTEXT_BUDGET_SKILLS_DIRS overrides the defaults, then positional args are
  // always appended (matching `skills_dirs+=("$@")`).
  const skillsEnv = process.env.CONTEXT_BUDGET_SKILLS_DIRS;
  let skillsDirs = skillsEnv ? splitColon(skillsEnv) : defaultSkillsDirs.slice();
  skillsDirs = skillsDirs.concat(args);

  const configEnv = process.env.CONTEXT_BUDGET_CONFIG_DIRS;
  const configDirs = configEnv ? splitColon(configEnv) : defaultConfigDirs.slice();

  // --- Skills ---
  // Build entries in the .sh's index order: for each existing, not-yet-seen dir
  // (dedup on the raw string), that dir's SKILL.md files in sorted order.
  const skillEntries = [];
  const seenDirs = new Set();
  for (const dir of skillsDirs) {
    if (!dir || !isDir(dir)) continue;
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const files = findSkillFiles(dir).sort(byteCmp);
    const source = homeToTilde(dir);
    for (const file of files) {
      const content = readFile(file);
      const total = content === null ? 0 : tokensFromText(content);
      const fm = content === null ? 0 : tokensFromText(frontmatterText(content));
      let body = total - fm;
      if (body < 0) body = 0;
      const lines = content === null ? 0 : lineCount(content);
      skillEntries.push({
        path: homeToTilde(file),
        name: path.basename(path.dirname(file)),
        source,
        total_tokens: total,
        frontmatter_tokens: fm,
        body_tokens: body,
        lines,
        over_limit: lines > SKILL_LINE_LIMIT,
      });
    }
  }

  // --- Instruction files + rules digest (always on) ---
  const configEntries = [];
  for (const dir of configDirs) {
    if (!dir || !isDir(dir)) continue;
    for (const base of ['CLAUDE.md', 'AGENTS.md', 'copilot-instructions.md', 'core-rules.md']) {
      const file = joinChild(dir, base); // literal "$dir/$base", as the .sh writes it
      if (!isFile(file)) continue;
      const kind = base === 'core-rules.md' ? 'rules' : 'instructions';
      const limit = kind === 'rules' ? RULES_LINE_LIMIT : INSTRUCTIONS_LINE_LIMIT;
      const content = readFile(file);
      const tokens = content === null ? 0 : tokensFromText(content);
      const lines = content === null ? 0 : lineCount(content);
      configEntries.push({
        path: homeToTilde(file),
        kind,
        tokens,
        lines,
        limit,
        over_limit: lines > limit,
      });
    }
  }

  // Reproduce the shell-glob reorder of "skill.<i>.json" / "cfg.<j>.json": the
  // slurp order is lexicographic on the index string, not the numeric index.
  const globReorder = (entries) =>
    entries
      .map((entry, i) => ({ entry, key: String(i) }))
      .sort((a, b) => byteCmp(a.key, b.key))
      .map((x) => x.entry);

  // Attach the harness classification (appended last, as jq's `. + {harness}`).
  const sk = globReorder(skillEntries).map((s) => ({ ...s, harness: harnessKey(s.source) }));
  const cf = globReorder(configEntries).map((c) => ({ ...c, harness: harnessKey(c.path) }));

  const byHarness = (arr, key) => arr.filter((x) => x.harness === key);
  const repoSkills = byHarness(sk, 'repo');

  // Report always-on cost PER HARNESS, not as one cross-harness sum: the three
  // harnesses are mutually exclusive, a session runs in exactly one, so summing
  // them (and any repo ./skills copies passed as args) would charge a portable
  // skill up to four times and combine three instruction/digest pairs that never
  // co-load. Each skill/config is classified to its harness; extra dirs (e.g. the
  // repo's own ./skills) land in a separate `repo_inventory` bucket that is a
  // pre-install source listing, never a session cost.
  const result = {
    limits: {
      skill_lines: SKILL_LINE_LIMIT,
      rules_lines: RULES_LINE_LIMIT,
      instructions_lines: INSTRUCTIONS_LINE_LIMIT,
    },
    note: 'always_on_tokens is PER harness: a session pays one harness column, never the sum. repo_inventory is source skills from extra dirs passed as args (e.g. ./skills), not a session cost.',
    harnesses: {
      claude: harnessStats(byHarness(sk, 'claude'), byHarness(cf, 'claude')),
      copilot: harnessStats(byHarness(sk, 'copilot'), byHarness(cf, 'copilot')),
      codex: harnessStats(byHarness(sk, 'codex'), byHarness(cf, 'codex')),
    },
    repo_inventory: {
      skill_count: repoSkills.length,
      skill_frontmatter_tokens: sum(repoSkills.map((s) => s.frontmatter_tokens)),
      skill_body_tokens: sum(repoSkills.map((s) => s.body_tokens)),
    },
    counts: {
      skills: sk.length,
      configs: cf.length,
      oversized_skills: sk.filter((s) => s.over_limit).length,
      oversized_configs: cf.filter((c) => c.over_limit).length,
    },
    skills: sk,
    configs: cf,
  };

  // jq's default pretty-printer: 2-space indent, a trailing newline, and the
  // same string escaping and key order JSON.stringify produces for this data.
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
