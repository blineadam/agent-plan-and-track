#!/usr/bin/env node
/**
 * scan-context.js: estimate the always-on context cost of the agent config
 * (skills + instruction files + rules digest) and flag oversized components.
 *
 * Usage: scan-context.js [EXTRA_SKILLS_DIR ...]
 * Output: JSON to stdout. Node built-ins only (fs, path, os); no jq/awk/wc.
 *
 * This is a pure-Node, cross-platform (Windows/macOS/Linux) scanner: all file
 * walking and text processing is done in JS, so there is no bash/jq/awk
 * dependency. It was originally a port of a shell-plus-jq sibling script that
 * PR #37 deleted once this file replaced it; the ordering and formatting
 * choices documented below (e.g. shell-glob ordering, jq's pretty-printer)
 * are carried over from that heritage for output stability, not because a
 * sibling file still exists to stay in sync with.
 *
 * Tool-agnostic: scans the user-scope skills dir of Claude Code, GitHub Copilot,
 * and Codex (whichever exist), plus any dirs passed as arguments (e.g. this
 * repo's own skills/ when run from the repo root); each harness's instruction
 * file (CLAUDE.md / AGENTS.md / copilot-instructions.md); the core-rules
 * digest (core-rules.md, plus core-rules.local.md) wherever it is installed;
 * and each harness's agent roster.
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
 * Thresholds (override via env): SKILL_LINE_LIMIT (400), RULES_CHAR_LIMIT
 * (10000, matching check-digest-preview.js's INLINE_THRESHOLD_CHARS),
 * INSTRUCTIONS_CHAR_LIMIT (20000).
 *
 * Environment:
 *   CONTEXT_BUDGET_SKILLS_DIRS  Dirs to scan instead of the default harness
 *                               dirs, separated by the platform list delimiter
 *                               (`:` on POSIX, `;` on Windows). For testing.
 *   CONTEXT_BUDGET_CONFIG_DIRS  Dirs to search for instruction files + the
 *                               core-rules digest instead of the defaults
 *                               (same delimiter).
 *   CONTEXT_BUDGET_AGENTS_DIRS  Dirs to search for agent rosters instead of
 *                               the default harness agents dirs (same
 *                               delimiter). For testing.
 *
 * Heritage notes (why the output looks the way it does; "the .sh" throughout
 * these comments means the deleted sibling described above, not a live file):
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
// 10000 matches INLINE_THRESHOLD_CHARS in .github/scripts/check-digest-preview.js
// (line 33): that is the real char count above which Claude Code stops
// persisting hook stdout inline, so this threshold is grounded in that
// measured harness behavior rather than invented.
const RULES_CHAR_LIMIT = intEnv('RULES_CHAR_LIMIT', 10000);
const INSTRUCTIONS_CHAR_LIMIT = intEnv('INSTRUCTIONS_CHAR_LIMIT', 20000);

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

// Character count for the rules/instructions size flag: JS string length
// after UTF-8 decoding (UTF-16 code units), the same measurement
// check-digest-preview.js's INLINE_THRESHOLD_CHARS gate uses (its
// `content.length`), so a file classified under/over that threshold here
// agrees with that script. ASCII text makes this identical to a byte count;
// the repo's rules/instruction files are ASCII except for rare typographic
// punctuation.
function charCount(text) {
  return text.length;
}

// The YAML frontmatter block (between the first two lines that are exactly
// "---"), which is the always-on part of a skill. Mirrors the awk that prints
// records while fm==1 and exits on the second "---". Split on \r?\n so a
// CRLF-authored skill (common on Windows) still matches "---"; the .sh's awk
// missed those and charged the whole file as body.
function frontmatterText(content) {
  const lines = content.split(/\r?\n/);
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

// A single scalar field's value from a YAML frontmatter block (as returned by
// frontmatterText), e.g. `name: foo` or `description: "some text"`. Strips an
// optional surrounding double-quote pair, the style Claude's and Copilot's
// agent files use for description. Line-based, not a full YAML parser: fine
// for the single-line name/description fields these agent files use.
function yamlFieldValue(frontmatter, field) {
  const m = frontmatter.match(new RegExp('^' + field + ':\\s*(.*)$', 'm'));
  if (!m) return '';
  let v = m[1].trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v;
}

// A single top-level scalar field's value from a Codex agent TOML file, e.g.
// `name = "foo"`. Reads only single-line `key = "value"` assignments and
// stops at the `developer_instructions = '''` heredoc opener, so prose inside
// that multi-line body is never mistaken for a top-level field.
function tomlFieldValue(content, field) {
  const re = new RegExp('^' + field + '\\s*=\\s*"(.*)"\\s*$');
  for (const line of content.split(/\r?\n/)) {
    if (/^developer_instructions\s*=/.test(line)) break;
    const m = line.match(re);
    if (m) return m[1];
  }
  return '';
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
      if (ent.isDirectory()) {
        // Skip dot-prefixed dirs (e.g. .plan-and-track-pruned): a quarantined
        // or hidden skill dir is not loaded by any session, so it should not
        // be billed as always-on.
        if (ent.name.startsWith('.')) continue;
        stack.push(full);
      } else if (ent.isFile() && ent.name === 'SKILL.md') {
        out.push(full);
      }
    }
  }
  return out;
}

// Byte/codepoint order, matching the ASCII `sort` and shell-glob order the .sh
// relies on for both file paths and the "skill.<i>.json" temp-file names.
function byteCmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Split an env dir-list on the platform list delimiter (`:` on POSIX like the
// shell's `IFS=':'`, `;` on Windows) so a Windows absolute path such as
// `C:\skills` is not split on its drive-letter colon.
function splitPathList(value) {
  return value.split(path.delimiter);
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
// name (empty arrays sum to 0, as in jq's `(... | add) // 0`). Agent routing
// text (name + description) is always-on the same way skill frontmatter is,
// so it folds into always_on_tokens alongside it.
function harnessStats(skillsArr, configsArr, agentsArr) {
  const fm = sum(skillsArr.map((s) => s.frontmatter_tokens));
  const ct = sum(configsArr.map((c) => c.tokens));
  const art = sum(agentsArr.map((a) => a.routing_tokens));
  return {
    skill_count: skillsArr.length,
    skill_frontmatter_tokens: fm,
    skill_body_tokens: sum(skillsArr.map((s) => s.body_tokens)),
    config_tokens: ct,
    agent_routing_tokens: art,
    always_on_tokens: fm + ct + art,
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
  const defaultAgentsDirs = [
    path.join(HOME, '.claude', 'agents'),
    path.join(HOME, '.copilot', 'agents'),
    path.join(HOME, '.codex', 'agents'),
  ];

  // CONTEXT_BUDGET_SKILLS_DIRS overrides the defaults, then positional args are
  // always appended (matching `skills_dirs+=("$@")`).
  const skillsEnv = process.env.CONTEXT_BUDGET_SKILLS_DIRS;
  let skillsDirs = skillsEnv ? splitPathList(skillsEnv) : defaultSkillsDirs.slice();
  skillsDirs = skillsDirs.concat(args);

  const configEnv = process.env.CONTEXT_BUDGET_CONFIG_DIRS;
  const configDirs = configEnv ? splitPathList(configEnv) : defaultConfigDirs.slice();

  const agentsEnv = process.env.CONTEXT_BUDGET_AGENTS_DIRS;
  const agentsDirs = agentsEnv ? splitPathList(agentsEnv) : defaultAgentsDirs.slice();

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
    for (const base of ['CLAUDE.md', 'AGENTS.md', 'copilot-instructions.md', 'core-rules.md', 'core-rules.local.md']) {
      const file = joinChild(dir, base); // literal "$dir/$base", as the .sh writes it
      if (!isFile(file)) continue;
      const kind = base.startsWith('core-rules') ? 'rules' : 'instructions';
      const limit = kind === 'rules' ? RULES_CHAR_LIMIT : INSTRUCTIONS_CHAR_LIMIT;
      const content = readFile(file);
      const tokens = content === null ? 0 : tokensFromText(content);
      const chars = content === null ? 0 : charCount(content);
      // `lines` stays reported alongside `chars` even though only `chars`
      // gates over_limit: it is the Lines column of the summary table the
      // skill's Phase 3 asks for, and dropping it would leave the two
      // heaviest always-on components as the only rows that cannot fill it.
      const lines = content === null ? 0 : lineCount(content);
      configEntries.push({
        path: homeToTilde(file),
        kind,
        tokens,
        chars,
        lines,
        limit,
        over_limit: chars > limit,
      });
    }
  }

  // --- Agent rosters (routing text: name + description, always on) ---
  // Flat, non-recursive per dir: unlike skills, agent files sit directly in
  // the harness's agents dir with no per-agent subdirectory.
  const agentEntries = [];
  for (const dir of agentsDirs) {
    if (!dir || !isDir(dir)) continue;
    let dirEntries;
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = dirEntries
      .filter((e) => e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.toml')))
      .map((e) => e.name)
      .sort(byteCmp);
    for (const base of files) {
      const file = joinChild(dir, base);
      const content = readFile(file);
      if (content === null) continue;
      let nameField;
      let descField;
      if (base.endsWith('.toml')) {
        nameField = tomlFieldValue(content, 'name');
        descField = tomlFieldValue(content, 'description');
      } else {
        const fm = frontmatterText(content);
        nameField = yamlFieldValue(fm, 'name');
        descField = yamlFieldValue(fm, 'description');
      }
      agentEntries.push({
        path: homeToTilde(file),
        name: nameField,
        routing_tokens: tokensFromText(nameField + ' ' + descField),
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
  const ag = agentEntries.map((a) => ({ ...a, harness: harnessKey(a.path) }));

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
      rules_chars: RULES_CHAR_LIMIT,
      instructions_chars: INSTRUCTIONS_CHAR_LIMIT,
    },
    note: 'always_on_tokens is PER harness: a session pays one harness column, never the sum. repo_inventory is source skills from extra dirs passed as args (e.g. ./skills), not a session cost.',
    harnesses: {
      claude: harnessStats(byHarness(sk, 'claude'), byHarness(cf, 'claude'), byHarness(ag, 'claude')),
      copilot: harnessStats(byHarness(sk, 'copilot'), byHarness(cf, 'copilot'), byHarness(ag, 'copilot')),
      codex: harnessStats(byHarness(sk, 'codex'), byHarness(cf, 'codex'), byHarness(ag, 'codex')),
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
    agents: ag,
  };

  // jq's default pretty-printer: 2-space indent, a trailing newline, and the
  // same string escaping and key order JSON.stringify produces for this data.
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
