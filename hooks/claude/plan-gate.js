#!/usr/bin/env node
/**
 * Plan Gate: plan-and-track enforcement for tasks/todo.md (Claude Code only)
 *
 * A PreToolUse hook (registered for Skill|Edit|Write|MultiEdit) that denies
 * every Edit/Write/MultiEdit to `tasks/todo.md` until the plan-and-track
 * Skill has been invoked this session. A plan written straight into
 * tasks/todo.md skips the skill's reconcile/lessons/checklist steps, and
 * attention-based fixes (description wording, digest lines) don't reach
 * mid-session self-initiated planning, so per this repo's thesis the rule is
 * enforced by the harness: a Skill call naming plan-and-track stamps the
 * session; edits to tasks/todo.md check for the stamp.
 *
 * UNLIKE GATEGUARD, REPEATED DENIAL IS INTENTIONAL. Gateguard marks a file
 * "checked" at deny time so the retry always passes; this gate denies every
 * todo.md write until the external unlock (the Skill invocation). The two
 * gates never double-fire: gateguard exempts tasks/todo.md.
 *
 * CLAUDE-ONLY. Codex loads skills as instructions, so there is no Skill tool
 * event to stamp from and a hard block could never unlock; Copilot has no
 * Skill tool either and its PreToolUse is fail-closed. Those harnesses get
 * the portable skill plus the digest line instead (the same portable-skill +
 * Claude-only-hook split as suggest-compact.js), so no dialect branching.
 *
 * NO SUBAGENT CARVE-OUT: a subagent's tool call carries the same session_id
 * as its parent (verified empirically), so the stamp check resolves to the
 * same file either way. Exempting subagents (gateguard's precedent) would
 * let the main session dodge the gate entirely by delegating the todo.md
 * write to an executor/mechanic before ever invoking the Skill.
 *
 * FAIL OPEN everywhere else: malformed stdin exits 0, and if the state dir
 * can't be created the edit is ALLOWED with a stderr note, since the Skill
 * branch could never stamp on such a machine and a deny would loop forever.
 *
 * SCOPE GATE: a session that never touches tasks/todo.md at all still needs
 * catching (a competing-pressure prompt like "just hack it in" can skip
 * planning and go straight to source edits). Once a session's distinct
 * edited-file count reaches PLANGATE_SCOPE_THRESHOLD (default 3, since a
 * one- or two-file fix-plus-its-test is legitimately plan-free) without a
 * plan-and-track stamp, every further Edit/Write/MultiEdit is denied the
 * same hard way as the tasks/todo.md gate. "3+ distinct files" is the
 * observable proxy for the "3+ steps" core rule a hook can actually measure.
 * Marker files record each *allowed* edit's normalized path (sha256-keyed,
 * next to the session's stamp file) so a denied edit is never counted and
 * repeated denials can't inflate the total.
 *
 * CONTENT LINT: once a session is stamped, tasks/todo.md writes still get a
 * lighter check: every NEW unchecked step inside a `## Plan` section (not
 * Review/Context/preamble) must end in an owner tag, e.g. `(executor)`,
 * `(researcher)`, `(mechanic)`, or a reasoned `(main: <why>)`; a bare `(main)`
 * or no tag at all is denied with a message the retry can self-correct from.
 * Legacy untagged steps already on disk, and Review-section or non-Plan
 * text, are never linted; only a step whose checkbox line is absent from the
 * on-disk baseline counts as new. Runs only after the stamp check passes, via
 * maybeLintTodoContent().
 *
 * MIGRATION-STATE GUARD: also once stamped, a tasks/todo.md write that would
 * delete an existing `## Migration State` heading (the durable cross-session
 * block the migration-discipline project skill keeps there) is denied once
 * per session, gateguard-style: the marker is written at deny time so an
 * intentional retry always passes (a concurrent write racing that first
 * deny is denied too, via marker age, not mistaken for the retry).
 * PLANGATE_LINT_DISABLED does not turn this
 * off (it is a data-loss guard, not a formatting lint); PLANGATE_DISABLED
 * does, and PLANGATE_WARN demotes it like every other deny here.
 *
 * Config (env):
 *   PLANGATE_DISABLED        "1" turns the gate off entirely.
 *   PLANGATE_WARN            "1" demotes deny to a non-blocking warning.
 *   PLANGATE_SCOPE_THRESHOLD distinct-file count that trips the scope gate
 *                             (default 3).
 *   PLANGATE_LINT_DISABLED   "1" turns off the tasks/todo.md content lint
 *                             only (stamp gate and scope gate still apply).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.tmpdir(), 'claude-plan-gate');
const STALE_MS = 24 * 60 * 60 * 1000; // prune stamps older than a day
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// --- Per-session stamp: one empty file per session key ---

// Session-key derivation byte-identical to gateguard's sessionDir(): a
// sanitized session_id, else a hash of the transcript path / cwd. Both the
// Skill branch (stamp) and the edit branch (check) derive through this one
// helper, so they can never disagree on the key.
function stampPath(sessionId, input) {
  const sid = String(sessionId || '').trim();
  const key = /^[a-zA-Z0-9_-]{1,64}$/.test(sid)
    ? sid
    : 'k' +
      crypto
        .createHash('sha256')
        .update(String((input && input.transcript_path) || (input && input.cwd) || process.cwd()))
        .digest('hex')
        .slice(0, 24);
  return path.join(STATE_DIR, key);
}

function pruneStaleState() {
  try {
    const now = Date.now();
    for (const d of fs.readdirSync(STATE_DIR)) {
      const dp = path.join(STATE_DIR, d);
      try {
        if (now - fs.statSync(dp).mtimeMs > STALE_MS) fs.rmSync(dp, { recursive: true, force: true });
      } catch {
        /* stamp vanished between readdir and stat/rm */
      }
    }
  } catch {
    /* no state dir yet */
  }
}

// --- Skill-call recognition ---

// Does this Skill call name plan-and-track? Exact match against the field the
// Skill tool actually populates (`skill`), same convention the repo's own
// trace parser uses (skills/skill-activation/scripts/run-activation-cases.js,
// which reads only input.skill/input.name/arguments.skill). A substring or
// whole-object scan would stamp on an unrelated Skill call that merely
// mentions plan-and-track in a prompt or argument string.
function namesPlanAndTrack(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return false;
  if (toolInput.skill === 'plan-and-track') return true;
  if (toolInput.name === 'plan-and-track') return true;
  return !!(toolInput.arguments && toolInput.arguments.skill === 'plan-and-track');
}

// --- Scope gate: distinct edited-file count, same stamp, sibling markers ---

// Paths the scope count ignores: tasks/todo.md (already gated on its own),
// tasks/lessons.md and .claude/settings*.json (rule-forced/hook-repair
// edits, mirroring gateguard's isBuiltinExempt). Case-insensitive: NTFS
// treats these paths case-insensitively, same rationale as the todo.md gate.
function isScopeExempt(norm) {
  return (
    /(^|\/)tasks\/(todo|lessons)\.md$/i.test(norm) ||
    /(^|\/)\.claude\/settings(?:\.[^/]+)?\.json$/i.test(norm)
  );
}

function filesDir(sessionId, input) {
  return stampPath(sessionId, input) + '.files';
}

function fileMarkerPath(sessionId, input, norm) {
  // Lowercased: NTFS (and case-insensitive-by-default APFS) treat differently
  // cased paths as the same file; hashing the raw case would let a session
  // double-count C:/repo/a.js and c:/repo/A.js as two distinct files.
  const hash = crypto.createHash('sha256').update(norm.toLowerCase()).digest('hex').slice(0, 32);
  return path.join(filesDir(sessionId, input), hash);
}

function distinctFileCount(sessionId, input) {
  try {
    return fs.readdirSync(filesDir(sessionId, input)).length;
  } catch {
    return 0;
  }
}

// Validated PLANGATE_SCOPE_THRESHOLD: a positive integer, else the default.
// Same shape as intEnv in gateguard.js/delivery-gate.js, but with a floor of
// 1 (0 would deny before any file is ever edited, which isn't a threshold).
function scopeThreshold() {
  const raw = process.env.PLANGATE_SCOPE_THRESHOLD;
  if (raw === undefined || raw === '') return 3;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? n : 3;
}

// Serialize the count-check-write critical section per session: Claude can
// issue multiple Edit/Write tool calls whose PreToolUse hooks run
// concurrently, and a plain read-count-then-decide has a TOCTOU window where
// two racing edits each see a stale count and both cross the threshold
// unblocked. Exclusive lockfile creation is atomic at the OS level, so at
// most one PreToolUse invocation per session runs the section at a time.
// Bounded spin-wait with Atomics.wait (a real blocking sleep, not a busy
// spin); on timeout or any lock error, fail open and run unlocked rather
// than deny or hang, consistent with this file's fail-open philosophy.
function withSessionLock(sessionId, input, fn) {
  const lockPath = stampPath(sessionId, input) + '.lock';
  const deadline = Date.now() + 1000;
  let fd = null;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    for (;;) {
      try {
        fd = fs.openSync(lockPath, 'wx');
        break;
      } catch (err) {
        if (!err || err.code !== 'EEXIST') break; // unexpected error: run unlocked
        try {
          // Reclaim a lock abandoned by a crashed hook process instead of
          // waiting out the full deadline on every subsequent call.
          if (Date.now() - fs.statSync(lockPath).mtimeMs > 5000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          /* lock vanished between the failed open and this stat; retry */
        }
        if (Date.now() >= deadline) break;
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        } catch {
          /* Atomics.wait unavailable: retry immediately instead of sleeping */
        }
      }
    }
  } catch {
    /* STATE_DIR unwritable: run unlocked, same as everywhere else in this file */
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
        fs.unlinkSync(lockPath);
      } catch {
        /* best effort release */
      }
    }
  }
}

// --- Content lint: todo-step owner tags ---

// Hardcoded rather than parsed from skills/efficient-frontier/SKILL.md (that
// file is the human source of truth) at runtime: the repo checkout and the
// installed layout disagree on relative paths, so there's no one path this
// script could rely on to find it.
const ROSTER = ['planner', 'executor', 'researcher', 'mechanic', 'debugger', 'security-auditor', 'architect-reviewer', 'fable-advisor'];
const TIER_TAG_RE = new RegExp('\\((?:' + ROSTER.join('|') + ')(?::[^)]*)?\\)\\s*$', 'i');
const MAIN_OK_RE = /\(main:\s*[^)\s][^)]*\)\s*$/i; // (main: <non-empty reason>)
const MAIN_ANY_RE = /\(main(?::[^)]*)?\)\s*$/i; // any main tag, incl. bare/empty-reason

// Simulates the post-edit tasks/todo.md content for Edit/Write/MultiEdit
// without writing anything to disk. Returns null (skip the lint entirely) on
// anything that would make the simulation a guess rather than exact: an
// unreadable existing file, an old_string that's empty or not found in the
// text it's applied against, or a tool this hook doesn't otherwise handle.
function simulateResult(toolName, toolInput) {
  const filePath = String((toolInput && toolInput.file_path) || '');
  let baseline = '';
  if (fs.existsSync(filePath)) {
    try {
      baseline = fs.readFileSync(filePath, 'utf8');
    } catch {
      return null; // unreadable: fail open on the lint
    }
  }

  if (toolName === 'Write') {
    return { baseline, result: String((toolInput && toolInput.content) || '') };
  }

  function applyOne(text, oldStr, newStr, replaceAll) {
    if (!oldStr) return null;
    if (replaceAll) {
      if (!text.includes(oldStr)) return null;
      return text.split(oldStr).join(String(newStr || ''));
    }
    const idx = text.indexOf(oldStr);
    if (idx === -1) return null;
    return text.slice(0, idx) + String(newStr || '') + text.slice(idx + oldStr.length);
  }

  if (toolName === 'Edit') {
    const result = applyOne(baseline, toolInput.old_string, toolInput.new_string, toolInput.replace_all);
    return result === null ? null : { baseline, result };
  }

  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    let result = baseline;
    for (const edit of edits) {
      result = applyOne(result, edit && edit.old_string, edit && edit.new_string, edit && edit.replace_all);
      if (result === null) return null;
    }
    return { baseline, result };
  }

  return null;
}

// New unchecked steps inside a `## Plan` section: a logical step is a
// checkbox line plus its continuation lines, so a wrapped step's tag can sit
// on the last continuation line rather than the checkbox line itself. Only
// `- [ ]` lines start a step (checked-off `[x]`/`[X]` steps are never new
// steps to tag); newness is decided on the checkbox line alone, right-trimmed
// and compared against the same right-trimmed set from the on-disk baseline,
// so touching only a legacy step's continuation line never counts as new.
function collectNewUncheckedPlanSteps(baseline, result) {
  // A multiset, not a Set: todo.md accumulates historical batches, so two
  // unrelated steps (old and new) can share identical checkbox text. Each
  // baseline occurrence exempts at most one matching result occurrence from
  // being "new"; a genuinely new copy beyond what the baseline had still
  // counts, even if its text collides with an old, already-tagged step.
  const baselineCounts = new Map();
  for (const l of baseline.split('\n').map((l) => l.replace(/\s+$/, ''))) {
    baselineCounts.set(l, (baselineCounts.get(l) || 0) + 1);
  }
  const resultLines = result.split('\n');

  const steps = [];
  let inPlan = false;
  // The heading level `## Plan` itself was opened at, so a deeper heading
  // (e.g. `### Phase 1` nested under it) doesn't leave the Plan section;
  // only a heading at the same or shallower level does.
  let planLevel = null;
  let i = 0;
  while (i < resultLines.length) {
    const line = resultLines[i];
    const headerMatch = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const title = headerMatch[2];
      if (/^plan\b/i.test(title)) {
        inPlan = true;
        planLevel = level;
      } else if (planLevel === null || level <= planLevel) {
        inPlan = false;
        planLevel = null;
      }
      i += 1;
      continue;
    }
    if (inPlan && /^\s*[-*]\s+\[ \]\s/.test(line)) {
      const firstLine = line.replace(/\s+$/, '');
      const stepLines = [line];
      let j = i + 1;
      while (
        j < resultLines.length &&
        /^\s+\S/.test(resultLines[j]) &&
        !/^\s*[-*]\s+\[[ xX]\]\s/.test(resultLines[j]) &&
        !/^\s{0,3}#{1,6}\s+/.test(resultLines[j])
      ) {
        stepLines.push(resultLines[j]);
        j += 1;
      }
      const remaining = baselineCounts.get(firstLine) || 0;
      if (remaining > 0) {
        baselineCounts.set(firstLine, remaining - 1);
      } else {
        steps.push({ firstLine, joined: stepLines.join(' ').replace(/\s+$/, '') });
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return steps;
}

// Tag verdict for one new step's joined (single-space-joined, right-trimmed)
// text. MAIN_OK_RE first so a reasoned `(main: ...)` always passes before the
// broader MAIN_ANY_RE gets a chance to flag it as bare.
function stepTagViolation(joined) {
  if (MAIN_OK_RE.test(joined)) return null;
  if (MAIN_ANY_RE.test(joined)) return 'bare-main';
  if (TIER_TAG_RE.test(joined)) return null;
  return 'untagged';
}

// --- Messages ---

function gateMsg() {
  return [
    '[PlanGate] Writes to tasks/todo.md are gated: invoke the plan-and-track Skill via the Skill tool first (it loads the reconcile/lessons/checklist steps), then retry this edit.',
    '(PLANGATE_DISABLED=1 turns this gate off; PLANGATE_WARN=1 demotes it to a warning.)',
  ].join('\n');
}

function scopeMsg(threshold) {
  return [
    `[PlanGate] This session has touched ${threshold} distinct files without a plan: invoke the plan-and-track Skill via the Skill tool first (it loads the reconcile/lessons/checklist steps), then retry this edit.`,
    '(PLANGATE_SCOPE_THRESHOLD sets the file-count trigger, default 3; PLANGATE_DISABLED=1 turns this gate off; PLANGATE_WARN=1 demotes it to a warning.)',
  ].join('\n');
}

function lintMsg(offenders) {
  // firstLine already carries its own "- [ ]" marker, so indent only: a
  // second leading "- " here would print as a double bullet.
  const shown = offenders.slice(0, 3).map((o) => {
    const text = o.firstLine.length > 100 ? o.firstLine.slice(0, 100) + '...' : o.firstLine;
    return `  ${text}`;
  });
  if (offenders.length > 3) shown.push(`  ...and ${offenders.length - 3} more`);
  return [
    '[PlanGate] New plan steps in tasks/todo.md need an owner tag at end of step:',
    ...shown,
    'Tag each step with who carries it out: implementation defaults to (executor), research to (researcher), mechanical tails to (mechanic); also valid: (planner), (debugger), (security-auditor), (architect-reviewer), (fable-advisor), each optionally with a reason like (executor: <why>). Tagging (main) is the exception and must carry a one-clause reason in the tag itself, e.g. (main: needs user sign-off mid-step); "main already has the context" does not qualify. Retry the same write with tags added.',
    '(PLANGATE_LINT_DISABLED=1 turns off this lint; PLANGATE_DISABLED=1 turns off the whole gate; PLANGATE_WARN=1 demotes to a warning.)',
  ].join('\n');
}

function migrationMsg() {
  return [
    '[PlanGate] This write would delete the `## Migration State` block from tasks/todo.md. That block is durable cross-session migration state (frozen oracle, ladder rung, ownership) that must survive tidying, batch compression, and compaction.',
    'If ending or abandoning the migration is intentional (user-confirmed), retry the same write: the retry passes. Otherwise re-issue the write with the `## Migration State` block kept intact.',
    '(PLANGATE_DISABLED=1 turns off the whole gate; PLANGATE_WARN=1 demotes to a warning.)',
  ].join('\n');
}

function emitGateDecision(msg) {
  if (process.env.PLANGATE_WARN === '1') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: msg + '\n(Warn-only mode: the edit proceeds.)',
        },
      })
    );
  } else {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: msg,
        },
      })
    );
  }
}

// Runs only once the stamp check has already passed. Skips outright when
// PLANGATE_LINT_DISABLED=1, and the whole body is wrapped in try/catch so any
// simulation/lint error fails open (allows the edit) rather than wedging the
// gate, consistent with this file's fail-open philosophy everywhere else.
function maybeLintTodoContent(toolName, toolInput) {
  if (process.env.PLANGATE_LINT_DISABLED === '1') return;
  try {
    const sim = simulateResult(toolName, toolInput);
    if (!sim) return;
    const steps = collectNewUncheckedPlanSteps(sim.baseline, sim.result);
    const offenders = steps.filter((s) => stepTagViolation(s.joined));
    if (offenders.length) emitGateDecision(lintMsg(offenders));
  } catch {
    /* fail open: any simulation/lint error allows the edit */
  }
}

// --- Migration-state guard ---

// The `## Migration State` block (see project-skills/migration-discipline) is
// durable cross-session state; a tidying sweep that deletes it is
// unrecoverable after compaction. Exact H2 title only, case-insensitive like
// the Plan-heading match above; no trailing text, so prose that merely
// mentions the phrase never counts as the heading.
const MIGRATION_HEADING_RE = /^\s{0,3}##\s+Migration State\s*$/im;

// Deny ONCE per session a tasks/todo.md write that would delete an existing
// `## Migration State` heading. Gateguard's mark-at-deny-time pattern: the
// `.migstate` marker is claimed exclusively when the deny is emitted, so the
// intentional retry (and any later deletion this session) passes. Runs only
// after the stamp check, and deliberately ignores PLANGATE_LINT_DISABLED:
// opting out of tag formatting must not silently drop a data-loss guard.
// Returns true when a decision was emitted, so the caller exits without
// running the lint (a hook run may emit at most one decision JSON).
function maybeGuardMigrationState(toolName, toolInput, stamp) {
  try {
    const sim = simulateResult(toolName, toolInput);
    if (!sim) return false;
    if (!MIGRATION_HEADING_RE.test(sim.baseline) || MIGRATION_HEADING_RE.test(sim.result)) return false;
    try {
      // STATE_DIR exists here: the session stamp this branch requires lives in it.
      fs.writeFileSync(stamp + '.migstate', '', { flag: 'wx' });
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // EEXIST alone can't tell an intentional retry from a concurrent
        // write that lost the wx race microseconds ago (PreToolUse hooks can
        // run concurrently; see withSessionLock above). A racing loser sees
        // a marker written within the same tool batch, sub-second old; a
        // genuine retry needs a model turn after seeing the deny. So a fresh
        // marker means contention: deny this invocation too. The check never
        // touches the marker's mtime, so denied racers can't keep the window
        // open and re-deny a real retry forever.
        try {
          if (Date.now() - fs.statSync(stamp + '.migstate').mtimeMs < 2000) {
            emitGateDecision(migrationMsg());
            return true;
          }
        } catch {
          /* marker vanished or unreadable: treat as the retry and allow */
        }
        return false; // aged marker: intentional retry passes
      }
      process.stderr.write('[PlanGate] migration-state marker could not be persisted; allowing the edit.\n');
      return false; // never deny what we can't record, or the deny would repeat forever
    }
    emitGateDecision(migrationMsg());
    return true;
  } catch {
    return false; // fail open: any simulation/guard error allows the edit
  }
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    process.exit(0); // unparseable input: allow (Claude's PreToolUse fails open on silence)
  }

  if (process.env.PLANGATE_DISABLED === '1') process.exit(0);

  const toolName = String(input.tool_name || '');
  const toolInput = input.tool_input || {};

  // Skill branch: a plan-and-track invocation stamps the session.
  if (toolName.toLowerCase() === 'skill') {
    if (namesPlanAndTrack(toolInput)) {
      pruneStaleState();
      try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(stampPath(input.session_id, input), '');
      } catch (err) {
        process.stderr.write(`[PlanGate] could not write session stamp: ${err && err.message}\n`);
      }
    }
    process.exit(0);
  }

  // Edit branch. Case-insensitive throughout: install.ps1 deploys this hook
  // on Windows, where NTFS treats tasks\todo.md and TASKS\TODO.MD (etc.) as
  // the same file.
  if (!EDIT_TOOLS.has(toolName)) process.exit(0);
  const norm = String(toolInput.file_path || '').replace(/\\/g, '/');
  const stamp = stampPath(input.session_id, input);

  // tasks/todo.md gate: unchanged behavior, own message.
  if (/(^|\/)tasks\/todo\.md$/i.test(norm)) {
    if (fs.existsSync(stamp)) {
      // Guard before lint, exclusively: at most one decision JSON per run,
      // and keeping the Migration State block outranks tag formatting.
      if (maybeGuardMigrationState(toolName, toolInput, stamp)) process.exit(0);
      maybeLintTodoContent(toolName, toolInput); // may emitGateDecision(lintMsg(...))
      process.exit(0);
    }
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    } catch {
      // Unwritable state dir: the Skill branch could never stamp, so a deny
      // here would loop forever. Fail open with a note.
      process.stderr.write('[PlanGate] state dir could not be created; allowing the edit.\n');
      process.exit(0);
    }
    emitGateDecision(gateMsg());
    process.exit(0);
  }

  // Scope gate: deny once the session's distinct edited-file count reaches
  // the threshold without a stamp. No-op for exempt paths or once stamped.
  if (!norm || isScopeExempt(norm) || fs.existsSync(stamp)) process.exit(0);

  withSessionLock(input.session_id, input, () => {
    const threshold = scopeThreshold();
    const marker = fileMarkerPath(input.session_id, input, norm);
    const alreadyCounted = fs.existsSync(marker);
    const wouldBeCount = alreadyCounted ? distinctFileCount(input.session_id, input) : distinctFileCount(input.session_id, input) + 1;

    if (wouldBeCount >= threshold) {
      emitGateDecision(scopeMsg(threshold));
      // A real deny must not record the marker (it would inflate the count
      // on retry). PLANGATE_WARN=1 lets the edit proceed, so it falls
      // through and gets the same marker as any other allowed edit.
      if (process.env.PLANGATE_WARN !== '1') return;
    }

    // Allowed (or warned-but-proceeding): record this file so a future edit
    // doesn't re-count it, and repeated denials of an unrecorded file never
    // inflate the total.
    try {
      fs.mkdirSync(filesDir(input.session_id, input), { recursive: true });
      fs.writeFileSync(marker, '');
    } catch {
      /* best effort: worst case a later edit re-checks the same file */
    }
  });
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[PlanGate] ${err && err.message}\n`);
  process.exit(0);
}
