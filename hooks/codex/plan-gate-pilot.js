#!/usr/bin/env node
/**
 * Codex plan gate.
 *
 * The PreToolUse half snapshots every explicit apply_patch path before the
 * patch. The PostToolUse half atomically claims that immutable snapshot and
 * bases every verdict on the disk delta, never on tool_response. A separate
 * Bash PreToolUse path blocks the second distinct unplanned outward mutation
 * among git push, gh pr create, and gh pr merge. A valid new plan item written
 * through apply_patch stamps the shared session state; at the mutation
 * threshold, a valid plan item added after SessionStart also stamps it when a
 * wrapper hides the patch lifecycle. An apply_patch PreToolUse guard also
 * denies once when an exact in-memory simulation finds a new or changed
 * unchecked Plan step whose `(main: ...)` reason attributes an action or
 * preference to the user.
 * The installer copies this source to plan-gate.js.
 *
 * State is keyed by sha256([session_id, canonical cwd, tool_use_id]). A
 * sibling per-session+cwd scope record counts changed source paths and allowed
 * outward mutation kinds. Missing correlation, malformed input/state,
 * snapshots, or filesystem failures fail open. Scope and migration warnings
 * remain nonblocking systemMessage output; mutation denials use Codex's
 * canonical PreToolUse permissionDecision response.
 *
 * Config (env):
 *   PLANGATE_LINT_DISABLED  set to 1 to disable the main-attribution guard.
 *   PLANGATE_MUTATION_THRESHOLD distinct-outward-mutation-kind count that
 *                             trips the mutation gate (default 2). Only 3
 *                             kinds exist, so a value above 3 effectively
 *                             disables this gate.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.tmpdir(), 'codex-plan-gate-pilot');
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
const PRUNE_LIMIT = 64;
const ROSTER = ['planner', 'executor', 'researcher', 'mechanic', 'debugger', 'security-auditor', 'architect-reviewer', 'fable-advisor'];
const TIER_TAG_RE = new RegExp('\\((?:' + ROSTER.join('|') + ')(?::[^)]*)?\\)\\s*$', 'i');
const MAIN_OK_RE = /\(main:\s*[^)\s][^)]*\)\s*$/i;
const MAIN_ANY_RE = /\(main(?::[^)]*)?\)\s*$/i;
const MAIN_REASON_RE = /\(main:\s*([^)\s][^)]*)\)\s*$/i;
const MAIN_USER_ATTRIBUTION_RE =
  /\b(?:user|you)\b(?:\s+\S+){0,2}\s+(?:disabled|enabled|turned on|turned off|asked|said|told|chose|requested|wanted|wants|approved|confirmed|authorized|declined|rejected|prefers|preferred|specified)\b/i;
const MIGRATION_HEADING_RE = /^\s{0,3}##\s+Migration State\s*$/im;
const SCOPE_WARNING = 'This session has changed 3 distinct source paths without a new valid `## Plan` item. The edits still proceed.';
const MUTATION_KINDS = new Set(['git-push', 'gh-pr-create', 'gh-pr-merge']);

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalCwd(input) {
  if (!input || typeof input.cwd !== 'string' || !input.cwd.trim()) return null;
  try {
    return fs.realpathSync(input.cwd);
  } catch {
    return null;
  }
}

function correlation(input) {
  const scope = scopeCorrelation(input);
  if (!scope) return null;
  const toolUseId = input && typeof input.tool_use_id === 'string' ? input.tool_use_id.trim() : '';
  if (!toolUseId) return null;
  return { ...scope, toolUseId };
}

function scopeCorrelation(input) {
  const sessionId = input && typeof input.session_id === 'string' ? input.session_id.trim() : '';
  const cwd = canonicalCwd(input);
  if (!sessionId || !cwd) return null;
  return { cwd, sessionId };
}

function transactionPath(key) {
  return path.join(STATE_DIR, 'transactions', key + '.json');
}

function claimPath(key) {
  return path.join(STATE_DIR, 'transactions', key + '.claim');
}

function scopePath(c) {
  return path.join(STATE_DIR, 'scopes', sha256([c.sessionId, c.cwd]) + '.json');
}

function scopeLockPath(c) {
  return scopePath(c) + '.lock';
}

function pruneState() {
  const cutoff = Date.now() - PRUNE_AGE_MS;
  try {
    const stateDir = path.join(STATE_DIR, 'transactions');
    const names = fs.readdirSync(stateDir).filter((name) => /\.(?:json|claim)$/.test(name));
    let removed = 0;
    for (const name of names) {
      if (removed >= PRUNE_LIMIT) break;
      const target = path.join(stateDir, name);
      if (fs.statSync(target).mtimeMs >= cutoff) continue;
      fs.unlinkSync(target);
      removed += 1;
    }
  } catch {
    /* transaction pruning is best effort and never affects a hook verdict */
  }
}

function parsePaths(command) {
  const paths = [];
  for (const line of String(command || '').split('\n')) {
    let match;
    if ((match = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/.exec(line))) paths.push(match[1]);
    else if ((match = /^\*\*\* Move to:\s*(.+?)\s*$/.exec(line))) paths.push(match[1]);
  }
  return [...new Set(paths)];
}

function absolutePath(cwd, filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const requested = path.resolve(cwd, filePath);
  let canonicalParent;
  try {
    canonicalParent = fs.realpathSync(path.dirname(requested));
  } catch {
    return null;
  }
  const resolved = path.join(canonicalParent, path.basename(requested));
  const relative = path.relative(cwd, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  return { absolute: resolved, relative: relative.replace(/\\/g, '/') };
}

function snapshotFile(file) {
  try {
    if (fs.lstatSync(file.absolute).isSymbolicLink()) return null;
    const bytes = fs.readFileSync(file.absolute);
    const encoded = bytes.toString('base64');
    const snapshot = { exists: true, hash: sha256(encoded) };
    if (isTodo(file)) snapshot.text = encoded;
    return snapshot;
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, hash: '' };
    return null;
  }
}

function sameSnapshot(snapshot, file) {
  const next = snapshotFile(file);
  if (!next) return null;
  return next.exists === snapshot.exists && next.hash === snapshot.hash ? false : { after: next };
}

function writeAtomic(filePath, value, exclusive) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (exclusive) {
    const fd = fs.openSync(filePath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, value, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  const temp = filePath + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temp, value, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, filePath);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* rename completed or the temp was never created */
    }
  }
}

function withScopeLock(c, fn) {
  const lock = scopeLockPath(c);
  const deadline = Date.now() + 1000;
  let fd;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    for (;;) {
      try {
        fd = fs.openSync(lock, 'wx', 0o600);
        break;
      } catch (err) {
        if (!err || err.code !== 'EEXIST') return null;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 5000) {
            fs.unlinkSync(lock);
            continue;
          }
        } catch {
          /* race with the lock holder's release, retry */
        }
        if (Date.now() >= deadline) return null;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
    return fn();
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
        fs.unlinkSync(lock);
      } catch {
        /* lock cleanup is best effort */
      }
    }
  }
}

function loadScope(c) {
  const file = scopePath(c);
  if (!fs.existsSync(file)) return { mutations: [], paths: [], stamped: false, warned: false };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const mutations = parsed && parsed.mutations === undefined ? [] : parsed && parsed.mutations;
  const mainAttributionAt = parsed && parsed.mainAttributionAt;
  const planBaseline = parsed && parsed.planBaseline;
  const planBaselineV2 = parsed && parsed.planBaselineV2;
  if (!parsed || !Array.isArray(parsed.paths) || !Array.isArray(mutations) || typeof parsed.stamped !== 'boolean' || typeof parsed.warned !== 'boolean' || !parsed.paths.every((p) => typeof p === 'string') || !mutations.every((kind) => MUTATION_KINDS.has(kind)) || (mainAttributionAt !== undefined && (!Number.isFinite(mainAttributionAt) || mainAttributionAt < 0)) || (planBaseline !== undefined && (!Array.isArray(planBaseline) || !planBaseline.every((item) => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)))) || (planBaselineV2 !== undefined && (!Array.isArray(planBaselineV2) || !planBaselineV2.every((item) => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item))))) throw new Error('invalid scope');
  const state = { mutations: [...new Set(mutations)], paths: [...new Set(parsed.paths)], stamped: parsed.stamped, warned: parsed.warned };
  if (mainAttributionAt !== undefined) state.mainAttributionAt = mainAttributionAt;
  if (planBaseline !== undefined) state.planBaseline = [...planBaseline];
  if (planBaselineV2 !== undefined) state.planBaselineV2 = [...planBaselineV2];
  return state;
}

function saveScope(c, state) {
  writeAtomic(scopePath(c), JSON.stringify(state), false);
}

function decode(snapshot) {
  return typeof snapshot.text === 'string' ? Buffer.from(snapshot.text, 'base64').toString('utf8') : '';
}

// Parses only the deliberately supported structured apply_patch subset:
// Begin/End Patch containing an optional remote Environment ID and Update File
// operations whose hunks use a bare `@@` header and ordinary context/add/remove
// lines. Any Add/Delete/Move, contextual hunk header, malformed envelope, or
// other syntax returns null so the attribution guard fails open instead of
// approximating upstream.
function parseStructuredPatch(command) {
  const lines = String(command || '').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length < 4 || lines[0] !== '*** Begin Patch' || lines[lines.length - 1] !== '*** End Patch') return null;
  const operations = [];
  const end = lines.length - 1;
  let i = 1;
  if (/^\*\*\* Environment ID: .+$/.test(lines[i])) i += 1;
  while (i < end) {
    const header = /^\*\*\* Update File:\s*(.+?)\s*$/.exec(lines[i]);
    if (!header) return null;
    const operation = { filePath: header[1], hunks: [] };
    i += 1;
    while (i < end && !/^\*\*\* (?:Add|Update|Delete) File:|^\*\*\* Move to:/.test(lines[i])) {
      if (lines[i] !== '@@') return null;
      i += 1;
      const hunk = [];
      while (i < end && lines[i] !== '@@' && !/^\*\*\* (?:Add|Update|Delete) File:|^\*\*\* Move to:/.test(lines[i])) {
        if (!/^[ +\-]/.test(lines[i])) return null;
        hunk.push(lines[i]);
        i += 1;
      }
      if (!hunk.length || !hunk.some((line) => line[0] === '+' || line[0] === '-')) return null;
      operation.hunks.push(hunk);
    }
    if (!operation.hunks.length) return null;
    operations.push(operation);
  }
  return operations.length ? operations : null;
}

function exactMatch(lines, needle, start) {
  const matches = [];
  for (let i = start; i + needle.length <= lines.length; i += 1) {
    if (needle.every((line, offset) => lines[i + offset] === line)) matches.push(i);
  }
  return matches.length === 1 ? matches[0] : null;
}

// Simulates only a single-file patch whose one Update File operation targets
// the already snapshotted tasks/todo.md. Non-todo snapshots deliberately
// retain no plaintext, so a multi-file patch cannot be proved exact here and
// fails open. Hunks apply in order and each old sequence must have exactly one
// byte-for-byte line match after the prior hunk.
function simulateTodoPatch(command, c, file) {
  if (!file.snapshot.exists || typeof file.snapshot.text !== 'string') return null;
  const operations = parseStructuredPatch(command);
  if (!operations || operations.length !== 1) return null;
  const target = absolutePath(c.cwd, operations[0].filePath);
  if (!target || target.absolute !== file.absolute) return null;
  const lines = decode(file.snapshot).split('\n');
  let cursor = 0;
  for (const hunk of operations[0].hunks) {
    const before = hunk.filter((line) => line[0] !== '+').map((line) => line.slice(1));
    const after = hunk.filter((line) => line[0] !== '-').map((line) => line.slice(1));
    if (!before.length) return null;
    const at = exactMatch(lines, before, cursor);
    if (at === null) return null;
    lines.splice(at, before.length, ...after);
    cursor = at + after.length;
  }
  return lines.join('\n');
}

function extractUncheckedPlanItems(text) {
  const lines = text.split('\n');
  const items = [];
  let planLevel = null;
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/.exec(lines[i]);
    if (heading) {
      const level = heading[1].length;
      if (level === 2 && heading[2] === 'Plan') planLevel = level;
      else if (planLevel !== null && level <= planLevel) planLevel = null;
      continue;
    }
    if (planLevel === null || !/^\s*[-*]\s+\[ \]\s/.test(lines[i])) continue;
    const item = [lines[i]];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*[-*]\s+\[[ xX]\]\s/.test(lines[i + 1]) && !/^\s{0,3}#{1,6}\s+/.test(lines[i + 1])) item.push(lines[++i]);
    items.push({ firstLine: item[0].replace(/\s+$/, ''), joined: item.join(' ').replace(/\s+$/, '') });
  }
  return items;
}

function collectChangedUncheckedPlanItems(baseline, result) {
  const counts = new Map();
  for (const item of extractUncheckedPlanItems(baseline)) counts.set(item.joined, (counts.get(item.joined) || 0) + 1);
  const items = [];
  for (const item of extractUncheckedPlanItems(result)) {
    const prior = counts.get(item.joined) || 0;
    if (prior) counts.set(item.joined, prior - 1);
    else items.push(item);
  }
  return items;
}

function attributionFinding(baseline, result) {
  for (const item of collectChangedUncheckedPlanItems(baseline, result)) {
    const match = MAIN_REASON_RE.exec(item.joined);
    if (match && MAIN_USER_ATTRIBUTION_RE.test(match[1])) return { item, reason: match[1] };
  }
  return null;
}

function collectNewUncheckedPlanItems(baseline, result) {
  const counts = new Map();
  for (const item of extractUncheckedPlanItems(baseline)) {
    const identity = planItemIdentity(item.firstLine);
    counts.set(identity, (counts.get(identity) || 0) + 1);
  }
  const items = [];
  for (const item of extractUncheckedPlanItems(result)) {
    const identity = planItemIdentity(item.firstLine);
    const prior = counts.get(identity) || 0;
    if (prior) {
      counts.set(identity, prior - 1);
      continue;
    }
    items.push(item.joined);
  }
  return items;
}

function validPlanItem(item) {
  if (!/\bverify:\s*\S/i.test(item)) return false;
  if (MAIN_OK_RE.test(item)) return true;
  if (MAIN_ANY_RE.test(item)) return false;
  return TIER_TAG_RE.test(item);
}

function currentPlanItems(c) {
  const todo = absolutePath(c.cwd, 'tasks/todo.md');
  if (!todo) {
    try {
      fs.lstatSync(path.join(c.cwd, 'tasks'));
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
    }
    return null;
  }
  const snapshot = snapshotFile(todo);
  if (!snapshot) return null;
  return snapshot.exists ? extractUncheckedPlanItems(decode(snapshot)) : [];
}

function planItemIdentity(firstLine) {
  return firstLine.replace(/^\s*[-*]\s+\[ \]\s+/, '');
}

function hasSessionPlan(c, scope) {
  if (!Array.isArray(scope.planBaselineV2)) return false;
  const items = currentPlanItems(c);
  if (!items) return false;
  const baseline = new Map();
  for (const item of scope.planBaselineV2) baseline.set(item, (baseline.get(item) || 0) + 1);
  for (const item of items) {
    const itemHash = sha256(planItemIdentity(item.firstLine));
    const prior = baseline.get(itemHash) || 0;
    if (prior) baseline.set(itemHash, prior - 1);
    else if (validPlanItem(item.joined)) return true;
  }
  return false;
}

function sessionStart(input, c) {
  pruneState();
  withScopeLock(c, () => {
    const scope = loadScope(c);
    if (scope.planBaselineV2 !== undefined) return;
    const items = currentPlanItems(c);
    if (!items) return;
    scope.planBaselineV2 = items.map((item) => sha256(planItemIdentity(item.firstLine)));
    saveScope(c, scope);
    recordEvent('SessionStart', input, c);
  });
}

// Quote-aware split of a Bash command into command-position segments, with
// shell comments and heredoc bodies removed in the same pass so neither a
// `# ...` comment nor a `<<EOF ... EOF` body (e.g. a PR description piped to
// `gh pr create`) is ever classified. Comment, heredoc, and separator
// recognition all happen ONLY in unquoted context: a `#`, a `<<`, or a `;`
// inside quotes is literal text, not shell syntax. That is what keeps
// `git commit -m "then git push"` from splitting and `echo "text <<EOF"`
// from swallowing a real following command.
//
// Command substitutions (`$(...)`, backticks) and subshells (`(...)`) are
// deliberately NOT descended into: a mutation buried in one (`echo $(git
// push)`) is an accepted false negative, the same class as `env git push`,
// `/usr/bin/git push`, or an aliased `git`. The backstop targets the plain
// `git push` / `gh pr ...` forms a session actually uses to ship, not exotic
// nesting.
function splitShellSegments(command) {
  const text = String(command || '');
  const n = text.length;
  const segments = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  const pendingHeredocs = []; // delimiters whose bodies follow the current line
  let i = 0;

  while (i < n) {
    const ch = text[i];

    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < n) {
        current += ch + text[i + 1];
        i += 2;
        continue;
      }
      current += ch;
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }

    // Unquoted context below.
    if (ch === '\\' && i + 1 < n) {
      current += ch + text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      i += 1;
      continue;
    }

    // A `#` at a word boundary starts a comment that runs to end of line.
    if (ch === '#' && (current === '' || /\s/.test(current[current.length - 1]))) {
      while (i < n && text[i] !== '\n') i += 1;
      continue; // leave the '\n' for the separator branch to close the segment
    }

    // Heredoc operator `<<` or `<<-` (not `<<<`, a here-string): record the
    // delimiter (quoted 'X'/"X" or a bare word) and skip its body once the
    // command line ends. Multiple heredocs on one line strip in order.
    if (ch === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      let j = i + 2;
      let stripTabs = false;
      if (text[j] === '-') {
        stripTabs = true;
        j += 1;
      }
      while (j < n && (text[j] === ' ' || text[j] === '\t')) j += 1;
      let word = '';
      if (text[j] === "'" || text[j] === '"') {
        const quote = text[j];
        j += 1;
        while (j < n && text[j] !== quote) {
          word += text[j];
          j += 1;
        }
        if (j < n) j += 1; // consume the closing quote
      } else {
        while (j < n && !/[\s;&|<>()]/.test(text[j])) {
          word += text[j];
          j += 1;
        }
      }
      if (word) {
        pendingHeredocs.push({ word, stripTabs });
        i = j; // consumed the operator + delimiter; keep scanning this line
        continue;
      }
      current += ch; // no delimiter parsed: treat `<` as ordinary text
      i += 1;
      continue;
    }

    if (ch === '\n') {
      segments.push(current);
      current = '';
      i += 1;
      // Drop the bodies of any heredocs this line opened, in order.
      while (pendingHeredocs.length && i < n) {
        const { word, stripTabs } = pendingHeredocs.shift();
        for (;;) {
          let lineEnd = text.indexOf('\n', i);
          const atEnd = lineEnd === -1;
          if (atEnd) lineEnd = n;
          const line = text.slice(i, lineEnd);
          const compare = stripTabs ? line.replace(/^\t+/, '') : line;
          i = atEnd ? n : lineEnd + 1;
          if (compare === word || atEnd) break;
        }
      }
      continue;
    }

    if (ch === ';' || ch === '&' || ch === '|') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }
  segments.push(current);
  return segments;
}

// Classifies one Bash command into the (closed) set of outward, hard-to-
// reverse git/gh mutations it contains: a subset of {git-push,
// gh-pr-create, gh-pr-merge}. Conservative by design: a full-path
// invocation (`/usr/bin/git`), `env git`, or a shell alias is an accepted
// false negative, not chased.
function detectOutwardMutations(command) {
  const kinds = new Set();
  for (const rawSegment of splitShellSegments(command)) {
    const trimmed = rawSegment.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
    if (tokens[0] === 'command') tokens.shift();
    if (!tokens.length) continue;

    if (tokens[0] === 'git') {
      let i = 1;
      while (i < tokens.length) {
        const t = tokens[i];
        if (t === '-C' || t === '-c') {
          i += 2;
          continue;
        }
        if (/^(--git-dir=|-C=)/.test(t)) {
          i += 1;
          continue;
        }
        break;
      }
      if (tokens[i] === 'push') {
        const excluded = tokens.some((t) => t === '--help' || t === '-h' || t === '--dry-run' || t === '-n');
        if (!excluded) kinds.add('git-push');
      }
    } else if (tokens[0] === 'gh') {
      let i = 1;
      while (i < tokens.length) {
        const t = tokens[i];
        if (t === '-R' || t === '--repo') {
          i += 2;
          continue;
        }
        break;
      }
      const excluded = tokens.some((t) => t === '--help' || t === '--dry-run');
      if (!excluded) {
        const remaining = tokens.slice(i).filter((t) => !/^-/.test(t));
        if (remaining[0] === 'pr' && remaining[1] === 'create') kinds.add('gh-pr-create');
        if (remaining[0] === 'pr' && remaining[1] === 'merge') kinds.add('gh-pr-merge');
      }
    }
  }
  return kinds;
}

function mutationThreshold() {
  const raw = process.env.PLANGATE_MUTATION_THRESHOLD;
  if (raw === undefined || raw === '') return 2;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? n : 2;
}

function isTodo(file) {
  return /(^|\/)tasks\/todo\.md$/i.test(file.relative);
}

function isScopeExempt(file) {
  return /(^|\/)tasks\/(?:todo|lessons)\.md$/i.test(file.relative);
}

function recordEvent(phase, input, c, message) {
  const eventFile = process.env.PLANGATE_PILOT_EVENT_LOG;
  if (!eventFile) return;
  try {
    fs.mkdirSync(path.dirname(eventFile), { recursive: true, mode: 0o700 });
    const command = input.tool_name === 'Bash' && input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : undefined;
    fs.appendFileSync(eventFile, JSON.stringify({ command, cwd: c.cwd, message, phase, session_id: input.session_id, tool_name: input.tool_name, tool_use_id: input.tool_use_id }) + '\n', { mode: 0o600 });
  } catch {
    /* instrumentation must never affect a hook verdict */
  }
}

function warning(message, input, c) {
  const systemMessage = '[PlanGate] ' + message;
  recordEvent('Warning', input, c, systemMessage);
  process.stdout.write(JSON.stringify({ systemMessage }));
}

function mutationMessage(prospective, threshold) {
  return `[PlanGate] This command would bring this session to ${prospective} distinct outward git/gh mutations (push, PR create, PR merge), meeting the configured limit of ${threshold} without a plan. Add a valid new unchecked item under an exact \`## Plan\` heading in tasks/todo.md through apply_patch, including a verify clause and owner tag, then retry this command. (PLANGATE_MUTATION_THRESHOLD sets the mutation-count trigger, default 2.)`;
}

function attributionMessage(finding) {
  const text = finding.item.firstLine.length > 100 ? finding.item.firstLine.slice(0, 100) + '...' : finding.item.firstLine;
  const reason = finding.reason.length > 100 ? finding.reason.slice(0, 100) + '...' : finding.reason;
  return [
    "[PlanGate] This step's (main: ...) reason reads as a claim about what the user did or asked, not a fact about the work itself:",
    `  ${text}`,
    `  offending reason: (main: ${reason})`,
    'A (main: <why>) reason should state a fact about the work (context needed, timing, low mechanical cost), not attribute an action or preference to the user. If the user genuinely did ask/confirm/decide this, retry the same write: this check denies only once per session.',
    '(PLANGATE_LINT_DISABLED=1 turns off this check.)',
  ].join('\n');
}

function deny(message, input, c) {
  recordEvent('Denied', input, c, message);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: message,
    },
  }));
}

function denyMutation(prospective, threshold, input, c) {
  deny(mutationMessage(prospective, threshold), input, c);
}

function mutationPre(input, c) {
  if (!input.tool_input || typeof input.tool_input.command !== 'string') return;
  const kinds = detectOutwardMutations(input.tool_input.command);
  if (!kinds.size) return;
  pruneState();
  const outcome = withScopeLock(c, () => {
    const scope = loadScope(c);
    if (scope.stamped) return null;
    const newKinds = [...kinds].filter((kind) => !scope.mutations.includes(kind));
    const threshold = mutationThreshold();
    const prospective = scope.mutations.length + newKinds.length;
    if (prospective >= threshold) {
      if (hasSessionPlan(c, scope)) {
        scope.stamped = true;
        saveScope(c, scope);
        return null;
      }
      return { prospective, threshold };
    }
    scope.mutations.push(...newKinds);
    saveScope(c, scope);
    return null;
  });
  if (outcome && outcome.threshold) denyMutation(outcome.prospective, outcome.threshold, input, c);
  else if (outcome === null) recordEvent('Allowed', input, c);
}

function pre(input, c) {
  if (input.tool_name === 'Bash') {
    mutationPre(input, c);
    return;
  }
  if (input.tool_name !== 'apply_patch' || !input.tool_input || typeof input.tool_input.command !== 'string') return;
  pruneState();
  const declared = parsePaths(input.tool_input.command);
  if (!declared.length) return;
  const files = [];
  for (const declaredPath of declared) {
    const file = absolutePath(c.cwd, declaredPath);
    if (!file) return;
    const snapshot = snapshotFile(file);
    if (!snapshot) return;
    files.push({ ...file, snapshot });
  }
  if (process.env.PLANGATE_LINT_DISABLED !== '1') {
    const todoFiles = files.filter(isTodo);
    if (todoFiles.length === 1) {
      const result = simulateTodoPatch(input.tool_input.command, c, todoFiles[0]);
      const finding = result === null ? null : attributionFinding(decode(todoFiles[0].snapshot), result);
      if (finding) {
        const outcome = withScopeLock(c, () => {
          const scope = loadScope(c);
          if (scope.mainAttributionAt !== undefined) return { deny: Date.now() - scope.mainAttributionAt < 2000 };
          scope.mainAttributionAt = Date.now();
          saveScope(c, scope);
          return { deny: true };
        });
        if (outcome && outcome.deny) {
          deny(attributionMessage(finding), input, c);
          return;
        }
      }
    }
  }
  const key = sha256([c.sessionId, c.cwd, c.toolUseId]);
  try {
    writeAtomic(transactionPath(key), JSON.stringify({ cwd: c.cwd, files, sessionId: c.sessionId, toolUseId: c.toolUseId }), true);
    recordEvent('PreToolUse', input, c);
  } catch {
    /* another pre or an I/O failure leaves this call untracked */
  }
}

function cleanupTransaction(key) {
  for (const file of [transactionPath(key), claimPath(key)]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* transaction cleanup is best effort */
    }
  }
}

function post(input, c) {
  if (input.tool_name !== 'apply_patch') return;
  const key = sha256([c.sessionId, c.cwd, c.toolUseId]);
  const stateFile = transactionPath(key);
  let state;
  let claimed = false;
  try {
    if (!fs.existsSync(stateFile)) return;
    const claim = fs.openSync(claimPath(key), 'wx', 0o600);
    fs.closeSync(claim);
    claimed = true;
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!state || state.cwd !== c.cwd || state.sessionId !== c.sessionId || state.toolUseId !== c.toolUseId || !Array.isArray(state.files)) return;
    recordEvent('PostToolUse', input, c);
    const changed = [];
    for (const stored of state.files) {
      if (!stored || typeof stored.relative !== 'string' || typeof stored.absolute !== 'string' || !stored.snapshot) return;
      const current = absolutePath(c.cwd, stored.relative);
      if (!current) return;
      const delta = sameSnapshot(stored.snapshot, current);
      if (delta === null) return;
      if (delta) changed.push({ ...stored, ...current, after: delta.after });
    }
    if (!changed.length) return;

    let migrationDeleted = false;
    let planValid = false;
    for (const file of changed.filter(isTodo)) {
      const baseline = decode(file.snapshot);
      if (!file.after.exists) {
        if (file.snapshot.exists && MIGRATION_HEADING_RE.test(baseline)) migrationDeleted = true;
        continue;
      }
      const result = decode(file.after);
      if (MIGRATION_HEADING_RE.test(baseline) && !MIGRATION_HEADING_RE.test(result)) migrationDeleted = true;
      const newItems = collectNewUncheckedPlanItems(baseline, result);
      if (newItems.some(validPlanItem)) planValid = true;
    }
    const outcome = withScopeLock(c, () => {
      const scope = loadScope(c);
      if (migrationDeleted) return { message: 'This apply_patch would delete the `## Migration State` block. The edit still proceeds, but no plan stamp was recorded.' };
      if (planValid) {
        scope.stamped = true;
        saveScope(c, scope);
        return { stamped: true };
      }
      if (scope.stamped) return null;
      if (!scope.warned) {
        for (const file of changed) if (!isScopeExempt(file) && !scope.paths.includes(file.relative)) scope.paths.push(file.relative);
        if (scope.paths.length >= 3) {
          scope.warned = true;
          saveScope(c, scope);
          return { message: SCOPE_WARNING };
        }
      }
      saveScope(c, scope);
      return null;
    });
    if (outcome && outcome.message) warning(outcome.message, input, c);
    else if (outcome && outcome.stamped) recordEvent('Stamped', input, c);
  } catch {
    return;
  } finally {
    if (claimed) cleanupTransaction(key);
  }
}

function main() {
  const phase = process.argv[2];
  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    return;
  }
  if (phase === '--session-start') {
    const c = scopeCorrelation(input);
    if (c) sessionStart(input, c);
    return;
  }
  if (phase !== '--pre' && phase !== '--post') return;
  const c = correlation(input);
  if (!c) return;
  if (phase === '--pre') pre(input, c);
  else post(input, c);
}

try {
  main();
} catch {
  process.exit(0);
}
