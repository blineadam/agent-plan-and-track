#!/usr/bin/env node
/**
 * Warn-only Codex plan gate.
 *
 * The PreToolUse half snapshots every explicit apply_patch path before the
 * patch. The PostToolUse half atomically claims that immutable snapshot and
 * bases every verdict on the disk delta, never on tool_response. This is a
 * hook response. The installer copies this source to plan-gate.js.
 *
 * State is keyed by sha256([session_id, canonical cwd, tool_use_id]). A
 * sibling per-session+cow scope record counts changed source paths. Missing
 * correlation, malformed input/state, snapshots, or filesystem failures fail
 * open. Warnings are the sole output, one JSON object with systemMessage.
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
const MIGRATION_HEADING_RE = /^\s{0,3}##\s+Migration State\s*$/im;
const SCOPE_WARNING = 'This session has changed 3 distinct source paths without a new valid `## Plan` item. The edits still proceed.';

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
  const sessionId = input && typeof input.session_id === 'string' ? input.session_id.trim() : '';
  const toolUseId = input && typeof input.tool_use_id === 'string' ? input.tool_use_id.trim() : '';
  const cwd = canonicalCwd(input);
  if (!sessionId || !toolUseId || !cwd) return null;
  return { cwd, sessionId, toolUseId };
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
  for (const directory of ['transactions', 'scopes']) {
    try {
      const stateDir = path.join(STATE_DIR, directory);
      const names = fs.readdirSync(stateDir).filter((name) => directory === 'transactions' ? /\.(?:json|claim)$/.test(name) : /\.json$/.test(name));
      let removed = 0;
      for (const name of names) {
        if (removed >= PRUNE_LIMIT) break;
        const target = path.join(stateDir, name);
        if (fs.statSync(target).mtimeMs >= cutoff) continue;
        fs.unlinkSync(target);
        removed += 1;
      }
    } catch {
      /* state pruning is best effort and never affects a hook verdict */
    }
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
  if (typeof filePath !== 'string' || !filePath || path.isAbsolute(filePath)) return null;
  const resolved = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  let canonicalParent;
  try {
    canonicalParent = fs.realpathSync(path.dirname(resolved));
  } catch {
    return null;
  }
  const parentRelative = path.relative(cwd, canonicalParent);
  if (parentRelative === '..' || parentRelative.startsWith('..' + path.sep) || path.isAbsolute(parentRelative)) return null;
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
  if (!fs.existsSync(file)) return { paths: [], stamped: false, warned: false };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || !Array.isArray(parsed.paths) || typeof parsed.stamped !== 'boolean' || typeof parsed.warned !== 'boolean' || !parsed.paths.every((p) => typeof p === 'string')) throw new Error('invalid scope');
  return { paths: [...new Set(parsed.paths)], stamped: parsed.stamped, warned: parsed.warned };
}

function saveScope(c, state) {
  writeAtomic(scopePath(c), JSON.stringify(state), false);
}

function decode(snapshot) {
  return typeof snapshot.text === 'string' ? Buffer.from(snapshot.text, 'base64').toString('utf8') : '';
}

function collectNewUncheckedPlanItems(baseline, result) {
  const counts = new Map();
  for (const line of baseline.split('\n').map((line) => line.replace(/\s+$/, ''))) counts.set(line, (counts.get(line) || 0) + 1);
  const lines = result.split('\n');
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
    const first = lines[i].replace(/\s+$/, '');
    const prior = counts.get(first) || 0;
    if (prior) {
      counts.set(first, prior - 1);
      continue;
    }
    const item = [lines[i]];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*[-*]\s+\[[ xX]\]\s/.test(lines[i + 1]) && !/^\s{0,3}#{1,6}\s+/.test(lines[i + 1])) item.push(lines[++i]);
    items.push(item.join(' ').replace(/\s+$/, ''));
  }
  return items;
}

function validPlanItem(item) {
  if (!/\bverify:\s*\S/i.test(item)) return false;
  if (MAIN_OK_RE.test(item)) return true;
  if (MAIN_ANY_RE.test(item)) return false;
  return TIER_TAG_RE.test(item);
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
    fs.appendFileSync(eventFile, JSON.stringify({ cwd: c.cwd, message, phase, session_id: input.session_id, tool_name: input.tool_name, tool_use_id: input.tool_use_id }) + '\n', { mode: 0o600 });
  } catch {
    /* instrumentation must never affect a hook verdict */
  }
}

function warning(message, input, c) {
  const systemMessage = '[PlanGate] ' + message;
  recordEvent('Warning', input, c, systemMessage);
  process.stdout.write(JSON.stringify({ systemMessage }));
}

function pre(input, c) {
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
      if (!file.snapshot.exists) continue;
      const baseline = decode(file.snapshot);
      if (!file.after.exists) {
        if (MIGRATION_HEADING_RE.test(baseline)) migrationDeleted = true;
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
        return null;
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
