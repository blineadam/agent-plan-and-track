#!/usr/bin/env node
/**
 * GitGuard: destructive-git command gate, plus a secrets-disclosure
 * tripwire (Claude Code, Codex, Copilot CLI)
 *
 * A PreToolUse hook that gates a closed set of destructive/history-altering
 * git commands. The standing "protect the working tree" rule (never run a
 * destructive or history-altering git operation, or discard uncommitted
 * changes, without the user explicitly asking for that exact operation) has
 * no mechanical backing today: this hook gives it one, the same way
 * plan-gate.js's mutation gate gives a mechanical backing to plan-before-you-
 * mutate. It narrows, not contradicts, this repo's earlier recorded decision
 * against a destructive-Bash gate (see the "Deliberately not ported from
 * ECC" note in gateguard.js): that decision targeted ECC's shape (gate every
 * first Bash call regardless of content) and the "the harness's own
 * permission system already covers this" half of its rationale, which does
 * not hold under a `git` prefix allowlist that auto-approves `git reset
 * --hard`, or, on Claude Code specifically, under autonomous/headless modes:
 * Anthropic's own hooks documentation states PreToolUse hooks fire before
 * any permission-mode check, in every permission mode, so no permission
 * prompt ever fires there while PreToolUse hooks still run
 * (https://code.claude.com/docs/en/hooks-guide). The same is NOT
 * documented for Codex: its hooks and approvals documentation does not state
 * whether PreToolUse hooks fire under its bypass or full-auto modes, so
 * treat that side as unverified rather than assumed to match Claude (same
 * split gateguard.js's own header documents). This hook instead inspects
 * command content, the same posture plan-gate's mutation gate already
 * established.
 *
 * ONE SCRIPT, THREE HARNESSES. The wire dialect is sniffed from stdin:
 *   - Claude / Codex ("snake"): top-level snake_case `tool_name` /
 *     `tool_input`, Claude-style camelCase `hookSpecificOutput` on output.
 *     Gated when `tool_name === 'Bash'`; the command string is
 *     `tool_input.command`.
 *   - Copilot: camelCase `toolName` / `toolArgs`, top-level
 *     `permissionDecision` on output. Gated when `toolName` is `'bash'` or
 *     `'powershell'`. `toolArgs` arrives as a JSON-encoded STRING, not an
 *     object (documented example: `{"toolName":"bash","toolArgs":"{\"command\":
 *     \"git status\"}"}`), so it is JSON.parsed in a try/catch and `.command`
 *     read off the result; an already-parsed object is tolerated too, in
 *     case a harness version parses it first. Copilot is FAIL-CLOSED (a hook
 *     crash or non-zero exit denies the tool), so every exit path here emits
 *     an explicit `{"permissionDecision":"allow"}` for Copilot and the outer
 *     catch allows too: the gate must never accidentally block by dying.
 *
 * BLOCKED SET (closed, exactly five kinds, each traceable to the standing
 * rule's own wording and observable from the command text alone):
 *   - reset-hard        `git reset` with `--hard`.
 *   - clean-force       `git clean` with a force flag: `-f`, `--force`, or
 *                        `-f` inside a combined short cluster (`-fd`,
 *                        `-fdx`, `-xdf`).
 *   - force-push        `git push` with `--force`, `-f`,
 *                        `--force-with-lease`, `--force-if-includes`, or
 *                        `--mirror` (bare, `=value` form, or `-f` inside a
 *                        combined short cluster like `-uf`), or a leading
 *                        `+` on a refspec argument (`git push origin
 *                        +main`). `--mirror` force-updates every remote ref
 *                        and propagates deletions, a forced rewrite of
 *                        remote history by any reading, fully observable
 *                        from the command text.
 *   - discard-worktree   `git checkout .`, `git checkout -- <path>`,
 *                        `git checkout -f`/`--force` (bare or with a
 *                        branch), `git switch -f`/`--discard-changes`, and
 *                        `git restore <path>` unless `--staged`/`-S` is
 *                        present without `--worktree`/`-W` (a staged-only
 *                        restore unstages but never touches the worktree).
 *   - stage-env-file     `git add` naming a `.env`-pattern file by basename:
 *                        `.env` exactly, or `.env.<suffix>` for any suffix
 *                        except the conventionally-committed template
 *                        variants (`example`, `sample`, `template`, `dist`,
 *                        `default`, `defaults`), backing the standing
 *                        never-commit-secrets rule with a mechanical check.
 *                        Scoped to `add` only, not `commit`: see STAGE-ENV-
 *                        FILE IS A DISCLOSURE TRIPWIRE, NOT A BACKSTOP below.
 * `--help`/`-h` on any of the above suppresses the match for that git
 * invocation, same exclusion detectOutwardMutations() (plan-gate.js) applies
 * to git-push/gh-pr classification; `-n`/`--dry-run` do too (including `-n`
 * inside a combined short cluster, e.g. `-fdn`), covering `git clean -n` and
 * `git push --dry-run`, which never touch anything.
 *
 * STAGE-ENV-FILE IS A DISCLOSURE TRIPWIRE, NOT A BACKSTOP. Unlike the other
 * four kinds, which are strictly destructive, stage-env-file exists to catch
 * an explicitly-named secrets path before it enters history. It is scoped to
 * `git add` only: `git commit <pathspec>` with no prior `git add` is an
 * accepted false negative (see DELIBERATE EXCLUSIONS below). `git add .` and
 * `git add -A` are unclosable from argv either way: the hook sees only the
 * tokens typed, not what the sweep would actually stage, so a bare `.`/`-A`
 * sweep that happens to pick up a real `.env` file is also an accepted false
 * negative, the common accident vector this hook cannot close. `.gitignore`
 * plus the standing never-commit-secrets rule text remain the primary
 * protection; this hook is a second check on the narrower case where a path
 * is named explicitly, not a substitute for either. A future session must
 * not over-trust it as a complete backstop.
 *
 * DELIBERATE EXCLUSIONS (accepted false negatives, not chased):
 *   - Plain `git push` (no force flag): not destructive, and this repo's
 *     `yeet` skill pushes as a routine step.
 *   - `git push --delete`: removes a named ref rather than rewriting
 *     history, so it sits outside the closed set this hook's standing rule
 *     enumerates.
 *   - `git stash` / `stash pop` / `stash drop` / `stash clear`: the standing
 *     rule scopes stash by "over work you don't own", which no hook can
 *     observe from the command text; approximating it (e.g. blocking all
 *     stash drops) would reintroduce the exact guard-approximates-its-
 *     condition failure the rule exists to avoid.
 *   - `git rebase`, `git commit --amend`, `git branch -D`: destructive only
 *     against shared history or reflog-recoverable, also unobservable from
 *     the command text, and routine on a local, unshared branch.
 *   - `git commit <pathspec>` naming a `.env`-pattern file with no prior
 *     `git add` of that file this session (e.g. `git commit .env -m wip`
 *     as the very first mention of the file): stage-env-file is scoped to
 *     `add` only (see STAGE-ENV-FILE IS A DISCLOSURE TRIPWIRE above), so a
 *     bare `commit` naming a path directly is an accepted false negative,
 *     alongside the `git add .` / `-A` bare-sweep gap.
 *   - `git restore --staged <path>` (unstages only, worktree untouched) and
 *     bare `git checkout <branchname>` / `git checkout -b <name>` (branch
 *     checkout, not a worktree discard; branch-vs-path ambiguity from the
 *     command text alone makes this an accepted false negative).
 *   - Indirection: `bash -c "git reset --hard"`, `/usr/bin/git reset
 *     --hard`, `env git reset --hard`, a shell alias, or command
 *     substitution (`echo $(git reset --hard)`). Same conservative posture
 *     plan-gate.js's own header documents for detectOutwardMutations(): a
 *     full-path invocation, `env`-wrapped call, alias, or nested
 *     substitution is an accepted false negative, not chased.
 *   - Quote-wrapped flags (`git reset '--hard'`): the tokenizer keeps the
 *     quote characters as part of the token (by design, so a quoted `+` or
 *     separator inside a string is never misread as shell syntax), so a
 *     quoted flag never equals the bare token this classifier matches on.
 *     stage-env-file's own `add` branch reads its pathspecs with a real
 *     quote-aware word splitter instead (shellWords, see its own header),
 *     which strips quote characters wherever they appear in a word, not
 *     only at the word's start; `git add .e"nv"`, `git add config/".env"`,
 *     `git add ".env"`, `git add '.env'`, and `git add "config dir/.env"`
 *     all deny. This exclusion no longer applies to stage-env-file; it still
 *     applies to every other kind's flag matching.
 *   - Backslash ambiguity in stage-env-file's own `add` branch: a backslash
 *     outside single quotes means two different things depending on which
 *     shell produced the command text, bash's escape-the-next-character rule
 *     or PowerShell's ordinary path-separator rule, and this hook cannot
 *     know which one from the command text alone (see ONE SCRIPT, THREE
 *     HARNESSES above). shellWords is parameterized on this
 *     (`backslashEscapes`, see its own header) and the `add` branch reads
 *     pathspecs under BOTH conventions, matching if either yields a
 *     `.env`-pattern basename: `git add .\env`, `git add config\.env`, and
 *     `git add .\.env` all deny under at least one parse. This deliberately
 *     over-matches rather than under-matches, not chased: a bash command
 *     staging a file literally named `.\env` (an escaped backslash) will
 *     also deny. For a secrets tripwire this is the correct error direction:
 *     an extra deny costs one confirmation, a missed one puts a credential
 *     in history.
 *   - An environment-assignment prefix whose value is itself quoted and
 *     contains a space (`GIT_AUTHOR_NAME="John Doe" git reset --hard`):
 *     whitespace token splitting breaks the assignment into two tokens
 *     before the leading-assignment strip runs, so `git` is never seen as
 *     tokens[0].
 *   - The two-token form of an unrecognized git global option (`git
 *     --git-dir .git reset --hard`, value in a separate token): resolving
 *     this needs a full global-option table (which options take a value)
 *     that this classifier doesn't carry; the self-contained forms
 *     (`--git-dir=...`, `--no-pager`, `-C.`) are still caught.
 *   - PowerShell-specific syntax: this hook also gates Copilot's
 *     `powershell` tool (see the ONE SCRIPT, THREE HARNESSES note above) but
 *     tokenizes every dialect with bash quoting/separator rules, so a
 *     PowerShell backtick line continuation splits wrong and can let a
 *     multi-line command escape the gate. The common single-line case is
 *     still gated correctly, which is why `powershell` stays in the matcher
 *     rather than being dropped.
 *
 * POSTURE: deny-once per command kind per session, not a hard deny and not
 * warn-only. The hook cannot tell whether the user actually asked for the
 * destructive operation, the same epistemic gap plan-gate.js's main-
 * attribution guard already solved this way: the first occurrence of a kind
 * this session is denied with the rule quoted; an intentional retry of that
 * same kind passes. The marker is claimed at deny (or warn) time, exactly
 * like gateguard's marker model, so the gate can never loop. "First
 * occurrence" is judged by marker age, not bare existence, the same
 * racing-loser check plan-gate.js's migration-state and main-attribution
 * guards use (see claimMarker below): two same-kind commands issued close
 * together (a same-turn batch, or an automated retry within ~2s) both deny,
 * since EEXIST alone can't tell a concurrent loser from a genuine retry.
 *
 * Config (env):
 *   GITGUARD_DISABLED   "1" turns the gate off entirely (allow everything).
 *   GITGUARD_WARN       "1" demotes deny to a non-blocking warning on Claude
 *                       and Codex (the fact is injected via additionalContext
 *                       instead of blocking the call). Copilot's PreToolUse
 *                       has no soft-warn channel, so on Copilot this degrades
 *                       to allow plus a stderr note, exactly as gateguard.js
 *                       does for the same reason.
 *
 * FAIL OPEN everywhere: unparseable stdin, an unrecognized tool, no
 * extractable command, or a state directory that can't be written all
 * allow. `main()` is wrapped in a top-level try/catch that always emits an
 * explicit allow and exits 0, so a bug in this script can never block a git
 * command by crashing (which would be fatal on Copilot's fail-closed
 * PreToolUse).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Distinct from gateguard.js's 'claude-gateguard' and plan-gate.js's
// 'claude-plan-gate' state dirs so this gate's per-session markers can never
// collide with either.
const STATE_DIR = path.join(os.tmpdir(), 'claude-git-guard');
const STALE_MS = 24 * 60 * 60 * 1000; // prune state dirs older than a day

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// --- Dialect detection & output (copied from gateguard.js's emit helpers) ---

function detectDialect(input) {
  return input && typeof input.toolName === 'string' ? 'copilot' : 'snake';
}

// Copilot must be told "allow" explicitly (fail-closed). Claude/Codex fail
// open, so a silent exit 0 is their allow.
function emitAllow(dialect) {
  if (dialect === 'copilot') process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
}

function emitDeny(dialect, reason) {
  if (dialect === 'copilot') {
    process.stdout.write(
      JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason })
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
}

function emitWarn(dialect, reason) {
  if (dialect === 'copilot') {
    // Copilot's PreToolUse has no soft-warn channel: allow and note on stderr.
    process.stderr.write(`[GitGuard] (warn) ${reason}\n`);
    emitAllow('copilot');
    return;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: reason,
      },
    })
  );
}

// --- Command parsing ---
//
// splitShellSegments is copied BYTE-FOR-BYTE from hooks/claude/plan-gate.js
// (as of the commit that added this file, starting around its line 294,
// comment starting around line 279) and must stay that way: this repo's
// hooks each install standalone into a harness's own scripts/ directory with
// no shared module root, so hooks copy shared logic rather than import it.
// Do not hand-edit this copy; port future changes from plan-gate.js instead.

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

// --- Destructive-git classification ---

// Human-readable description of each kind, used in the deny/warn message.
const KIND_LABELS = {
  'reset-hard': 'a hard reset (git reset --hard), which discards uncommitted changes and moves history pointers',
  'clean-force': 'a forced clean (git clean with a force flag), which deletes untracked files',
  'force-push': 'a force push (git push --force/-f/--force-with-lease/--force-if-includes), which can overwrite remote history',
  'discard-worktree': 'a worktree discard (git checkout . / git checkout -- <path> / git restore <path>), which discards uncommitted changes',
  'stage-env-file': 'staging a .env-pattern file (git add naming .env or .env.<suffix>, excluding template variants like .env.example), which risks committing secrets into history',
};

// A given letter inside a combined short-option cluster, e.g. -fd, -fdx,
// -xdf: a single dash followed by two or more letters, at least one of which
// is the target letter. Never matches a long option (those start with two
// dashes, ruled out by requiring the second character to be a letter).
function hasClusterLetter(rest, letter) {
  return rest.some((t) => /^-[a-zA-Z]{2,}$/.test(t) && t.slice(1).includes(letter));
}

function hasForceCluster(rest) {
  return hasClusterLetter(rest, 'f');
}

// -n inside a combined short cluster, e.g. -fdn: same cluster shape as
// hasForceCluster, symmetric so a dry-run flag isn't only recognized bare.
function hasDryRunCluster(rest) {
  return hasClusterLetter(rest, 'n');
}

function hasForceFlag(rest) {
  return rest.some((t) => t === '-f' || t === '--force') || hasForceCluster(rest);
}

// A leading `+` on a refspec argument (`git push origin +main`, `git push
// origin +HEAD:main`) is git's own force-push spelling, no flag required.
// The tokenizer keeps quote characters as part of the token, so a quoted
// `"+foo"` never starts with a literal `+` here; a remote name starting with
// `+` is not realistic git usage and is an accepted over-match, not chased.
function hasForceRefspec(rest) {
  return rest.some((t) => t.length > 1 && t[0] === '+');
}

// The executable token is matched case-insensitively and with an optional
// `.exe` suffix (also case-insensitive), since this hook is wired to
// Copilot's `powershell` tool, where `Git`, `GIT`, and `git.exe` are all
// valid spellings that would otherwise bypass the gate. A full path such as
// `/usr/bin/git` still does not match, same accepted false negative the
// header documents: this is about the bare executable name's spelling, not
// about resolving paths.
function isGitExecutable(token) {
  return /^git(\.exe)?$/i.test(token);
}

// The template suffixes below are conventionally committed on purpose
// (`.env.example`, `.env.sample`, etc. are the placeholder a repo ships so a
// developer can copy it to a real `.env`), so a `.env.<suffix>` token is
// only treated as a secrets file when its suffix is NOT one of these.
// Case-insensitive so `.env.Example` still counts as the template variant.
// `defaults` is the dotenv-defaults convention (`.env.defaults`), the same
// shape as `default`. `vault` is deliberately NOT included: `.env.vault` is
// dotenv-vault's encrypted secrets container, not a placeholder template, so
// even though it's encrypted, the deny-once friction on it is correct and
// should not be softened.
const ENV_TEMPLATE_SUFFIXES = new Set(['example', 'sample', 'template', 'dist', 'default', 'defaults']);

// Basename only (last path segment), so a nested path like
// `config/.env.production` is still recognized by its filename regardless of
// directory. Splits on both `/` and `\` since this hook also gates Copilot's
// `powershell` tool, where a Windows-style path is realistic.
function basenameOf(token) {
  const idx = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return idx === -1 ? token : token.slice(idx + 1);
}

// Matches `.env` exactly, or `.env.<suffix>` for any suffix except the
// conventionally-committed template suffixes above. Does NOT match `env`,
// `env.js`, `.environment`, or any name that merely contains "env": the
// basename must literally start with `.env` followed by either nothing or a
// `.`, ruling out `.environment` (no separating dot after `.env`).
function isEnvFilePattern(basename) {
  const lower = basename.toLowerCase();
  if (lower === '.env') return true;
  const m = /^\.env\.(.+)$/.exec(lower);
  if (!m) return false;
  return !ENV_TEMPLATE_SUFFIXES.has(m[1]);
}

// `--mirror` force-updates every remote ref and propagates deletions, a
// forced rewrite of remote history by any reading (see header).
function hasPushForce(rest) {
  return (
    rest.some(
      (t) =>
        t === '--force' ||
        t === '-f' ||
        t === '--force-with-lease' ||
        t === '--force-if-includes' ||
        t === '--mirror' ||
        /^--force-with-lease=/.test(t) ||
        /^--force-if-includes=/.test(t)
    ) ||
    hasForceCluster(rest) ||
    hasForceRefspec(rest)
  );
}

// Real shell word-splitting of one `add` segment's tail text, used ONLY to
// derive stage-env-file's candidate pathspecs. detectDestructiveGit's outer
// whitespace tokenization (used to find the subcommand and for every other
// kind's flag matching) stays untouched; this function re-splits the raw
// segment text for the `add` branch alone, character by character, so a
// quote appearing anywhere in a word (start, middle, or wrapping an interior
// space) is handled the same way a real shell handles it, instead of only
// the "quote at the start of a whitespace-split token" shape, which both
// `.e"nv"` and `config/".env"` defeat, since neither carries a quote
// character in token-initial position. Quote
// characters are removed from the output, so `.e"nv"` becomes `.env` and
// `config/".env"` becomes `config/.env`.
//
// backslashEscapes controls whether a backslash outside single quotes
// escapes the next character (Bash behavior, `.\env` -> `.env`) or is kept
// as an ordinary literal character (PowerShell behavior, where `\` is a path
// separator, not an escape). Quote detection and stripping is identical in
// both modes; only the backslash handling, in both the unquoted branch and
// inside a double-quoted span, changes. Unlike splitShellSegments (a byte-
// parity contract, not touched here), this function is scoped to this
// branch's own pathspec reading and is free to unescape.
function shellWords(segment, { backslashEscapes } = {}) {
  const words = [];
  let current = '';
  let hasContent = false;
  let inSingle = false;
  let inDouble = false;
  const text = String(segment || '');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (backslashEscapes && ch === '\\' && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasContent) words.push(current);
      current = '';
      hasContent = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (backslashEscapes && ch === '\\' && i + 1 < text.length) {
      current += text[i + 1];
      hasContent = true;
      i += 1;
      continue;
    }
    current += ch;
    hasContent = true;
  }
  if (hasContent) words.push(current);
  return words;
}

// Given a quote-aware word array covering a WHOLE segment (as produced by
// shellWords over the segment's full text, not just a tail slice), locates
// the `git add` subcommand within THAT array and returns the words that
// follow it, or null if this array does not resolve to a `git add`
// invocation. Re-derives the same normalization the outer whitespace-
// tokenized loop above applies (skip leading VAR=value assignments, skip a
// leading literal `command`, skip git global options where -C/-c each
// consume the next word and any other option-shaped word is self-
// contained), but walks THIS word array's own indices rather than reusing
// the outer loop's index `i`. That index was computed by walking a plain
// whitespace split, and whitespace split's length can differ from a quote-
// aware split's length whenever a quoted argument contains whitespace
// (`git -C "work tree" add .env`), so slicing a quote-aware array at the
// whitespace-split's index can drop or duplicate words. This local helper
// exists so the `add` branch's own reading stays self-consistent against
// whichever word array it is given; it does not change how the outer loop
// computes `i` for the other four kinds.
function addSubcommandTail(words) {
  let j = 0;
  while (j < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[j])) j += 1;
  if (words[j] === 'command') j += 1;
  if (!isGitExecutable(words[j])) return null;
  j += 1;
  while (j < words.length) {
    const t = words[j];
    if (t === '-C' || t === '-c') {
      j += 2;
      continue;
    }
    if (t.startsWith('-')) {
      j += 1;
      continue;
    }
    break;
  }
  if (words[j] !== 'add') return null;
  return words.slice(j + 1);
}

// The part of a kind string before its first colon. Bare kinds (the four
// destructive ones) have no colon and return unchanged; stage-env-file's
// composite kind (`stage-env-file:<full path>`, see detectDestructiveGit)
// collapses back to its label-lookup and message key this way.
function baseKind(kind) {
  const idx = kind.indexOf(':');
  return idx === -1 ? kind : kind.slice(0, idx);
}

// Classifies one Bash command into the (closed) set of destructive git
// operations it contains: a subset of {reset-hard, clean-force, force-push,
// discard-worktree, stage-env-file}. Reuses detectOutwardMutations()'s
// (plan-gate.js) token-normalization preamble: strip leading VAR=value
// assignments, strip a leading literal `command`, and skip git global
// options that precede the subcommand. `-C <arg>`/`-c <arg>` each consume
// the next (separate) token; any other option-shaped token (starts with
// `-`) is treated as self-contained and skipped by itself, whether it
// carries its own value attached (`--git-dir=...`, `-C.`) or takes none
// (`--no-pager`). The two-token form of an unrecognized global option
// (`--git-dir .git`, value in a separate token) can't be resolved this way
// without a full option-value table; it is an accepted false negative (see
// header).
function detectDestructiveGit(command) {
  const kinds = new Set();
  for (const rawSegment of splitShellSegments(command)) {
    const trimmed = rawSegment.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
    if (tokens[0] === 'command') tokens.shift();
    if (!tokens.length) continue;
    if (!isGitExecutable(tokens[0])) continue;

    let i = 1;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === '-C' || t === '-c') {
        i += 2;
        continue;
      }
      if (t.startsWith('-')) {
        i += 1;
        continue;
      }
      break;
    }
    const subcommand = tokens[i];
    if (!subcommand) continue;
    const rest = tokens.slice(i + 1);

    // --help/-h suppress the match for this git invocation, same exclusion
    // detectOutwardMutations() applies; -n/--dry-run too (git clean -n, git
    // push --dry-run never touch anything), including -n inside a combined
    // short cluster (git clean -fdn), symmetric with force detection.
    if (
      rest.some((t) => t === '--help' || t === '-h' || t === '-n' || t === '--dry-run') ||
      hasDryRunCluster(rest)
    )
      continue;

    if (subcommand === 'reset') {
      if (rest.includes('--hard')) kinds.add('reset-hard');
    } else if (subcommand === 'clean') {
      if (hasForceFlag(rest)) kinds.add('clean-force');
    } else if (subcommand === 'push') {
      if (hasPushForce(rest)) kinds.add('force-push');
    } else if (subcommand === 'checkout') {
      const dashIdx = rest.indexOf('--');
      if (rest.includes('.') || (dashIdx !== -1 && dashIdx < rest.length - 1) || hasForceFlag(rest)) {
        kinds.add('discard-worktree');
      }
    } else if (subcommand === 'restore') {
      const hasStaged = rest.includes('--staged') || rest.includes('-S');
      const hasWorktree = rest.includes('--worktree') || rest.includes('-W');
      const hasTarget = rest.some((t) => !t.startsWith('-'));
      if (hasTarget && !(hasStaged && !hasWorktree)) kinds.add('discard-worktree');
    } else if (subcommand === 'switch') {
      // git switch's own force flag is -f/--discard-changes (no --force);
      // hasForceFlag's -f/cluster checks still apply, --discard-changes is
      // checked directly.
      if (hasForceFlag(rest) || rest.includes('--discard-changes')) kinds.add('discard-worktree');
    }

    // stage-env-file: `git add` naming a `.env`-pattern file. Scoped to
    // `add` only, not `commit`: see the header's STAGE-ENV-FILE IS A
    // DISCLOSURE TRIPWIRE note for why (a bare `git commit <path>` naming a
    // `.env` file with no prior `git add` is an accepted false negative,
    // alongside the bare-sweep gap below) and for the false positive
    // removing `commit` fixes (a commit MESSAGE's interior word matching
    // `.env` is not a pathspec, but reading `commit`'s own token stream the
    // same way used to misread it as one).
    //
    // Deliberately NOT gated behind `subcommand === 'add'` (the outer
    // `subcommand`/`i` above, used by the five kinds handled in the if/else
    // chain): that pair is computed by walking a plain whitespace split of
    // `trimmed`, and a plain whitespace split's token count can differ from
    // a quote-aware split's whenever a global option's value is quoted and
    // contains whitespace (`git -C "work tree" add .env`, `git -c
    // user.name="A B" add .env`), which desynchronizes `i` against any
    // quote-aware array sliced at the same index and can misidentify the
    // subcommand entirely (a git-guard regression this rewrite fixes).
    // addSubcommandTail instead re-walks a quote-aware word array from the
    // START of this segment, independently confirming (or rejecting) that
    // this segment is a `git add` invocation, so this block never depends
    // on the outer `i`/`subcommand` at all. It is a no-op (returns null,
    // adds nothing) whenever the segment is not actually `git add`, so
    // running it unconditionally alongside the if/else chain above is safe:
    // the two never both match the same segment.
    //
    // Any non-option token is a candidate pathspec; option-shaped tokens
    // (start with '-') are skipped rather than paired with a value the way
    // -C/-c are above, since `add` has no flag this classifier needs to
    // treat specially. Each matching FULL PATH token becomes its own
    // composite kind (`stage-env-file:<full path, exact case>`, see
    // baseKind above and markerPath below), not just its basename: two
    // different directories can share a filename (`config/.env` and
    // `other/.env`), and keying on the basename alone would let a
    // confirmed retry for one silently disarm the guard for the other.
    // `./config/.env` and `config/.env` therefore get distinct markers
    // too; erring toward an extra deny on a path spelled two ways is
    // correct for this guard. Pattern matching itself still reads only
    // the basename, via isEnvFilePattern(basenameOf(...)).
    //   - `git add .` / `git add -A` with no explicit path: the hook only
    //     sees argv, not what the sweep would actually stage, so a bare
    //     `.`/`-A` token never matches this pattern (accepted false
    //     negative, git's own .gitignore handling is the real backstop).
    //   - A quote appearing anywhere in a word, or a backslash-escaped
    //     character (`git add ".env"`, `git add '.env'`,
    //     `git add "config dir/.env"`, `git add .e"nv"`,
    //     `git add config/".env"`, `git add .\env`): all now caught, via
    //     shellWords below, before the basename check.
    //
    // Read pathspecs under BOTH backslash conventions, bash-style
    // (backslash escapes the next character) and PowerShell-style
    // (backslash is an ordinary path-separator character), and match if
    // EITHER parse yields a `.env`-pattern candidate. This hook gates one
    // script across three harnesses/shells (see the header's ONE SCRIPT,
    // THREE HARNESSES note) and cannot know from the command text alone
    // which dialect actually produced it, so for a secrets tripwire the
    // correct error direction is to over-match rather than under-match: an
    // extra deny costs one confirmation, a missed one puts a credential in
    // history. This deliberately over-matches one concrete shape: a bash
    // command staging a file literally named `.\env` (a real escaped
    // backslash, not a PowerShell path separator) also denies, since its
    // bash-style parse unescapes it to the literal basename `.env`.
    {
      const candidates = new Set();
      for (const backslashEscapes of [true, false]) {
        const tail = addSubcommandTail(shellWords(trimmed, { backslashEscapes }));
        if (!tail) continue;
        for (const t of tail) {
          if (t.startsWith('-')) continue;
          candidates.add(t);
        }
      }
      for (const t of candidates) {
        const basename = basenameOf(t);
        if (isEnvFilePattern(basename)) kinds.add('stage-env-file:' + t);
      }
    }
  }
  return kinds;
}

// --- Per-session state: one empty marker file per (session, kind) pair ---
//
// Same shape as gateguard.js's sessionDir/claimMarker, but keyed by the
// destructive-kind string directly (the kind set is closed and small, so no
// hashing is needed, the same reasoning plan-gate.js's mutationMarkerPath
// uses for its own closed kind set). stage-env-file's composite kind
// (`stage-env-file:<full path>`) is the one exception: it is not closed (a
// path is arbitrary text), so markerPath hashes it into a filesystem-
// safe marker name instead of using it verbatim (see markerPath below).

function sessionDir(sessionId, input) {
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

// A bare (colon-free) kind keeps its existing byte-identical marker filename
// (the closed set's four kinds, plus anything else with no colon), so their
// fixtures keep passing. A composite kind (stage-env-file's own) hashes to a
// filesystem-safe name: this hook also gates Copilot's `powershell` tool,
// where a colon in a filename is invalid, and a full path is arbitrary text
// that could otherwise collide with path separators or reserved characters.
function markerPath(dir, kind) {
  if (kind.indexOf(':') === -1) return path.join(dir, kind);
  const hash = crypto.createHash('sha256').update(kind).digest('hex').slice(0, 12);
  return path.join(dir, baseKind(kind) + '-' + hash);
}

// A marker younger than this counts as a racing loser, not a genuine retry.
// Matches hooks/claude/plan-gate.js's maybeGuardMigrationState /
// maybeGuardMainAttribution racing-loser threshold exactly (marker-age logic
// around its lines 832-848 as of the commit that added this file): EEXIST
// alone can't tell an intentional retry from a concurrent write that lost
// the wx race microseconds ago (PreToolUse hooks can run concurrently). A
// racing loser sees a marker written within the same tool batch, sub-second
// old; a genuine retry needs a model turn after seeing the deny/warn. So a
// fresh marker means contention: this invocation must also deny/warn.
const RACE_MS = 2000;

// Atomically claim the (session, kind) marker with an exclusive create, so
// even two parallel commands of the SAME kind can't both slip through
// allowed. Returns:
//   'claimed'      this call created the marker: first-ever occurrence,
//                  deny/warn.
//   'racing'       marker exists but is younger than RACE_MS: a concurrent
//                  racing loser (see above), also deny/warn.
//   'already-seen' marker exists and is at least RACE_MS old: a genuine
//                  intentional retry a model turn later, allow.
//   'fail'         any other error, allow: fail open.
function claimMarker(dir, kind) {
  const p = markerPath(dir, kind);
  try {
    fs.writeFileSync(p, '', { flag: 'wx' });
    return 'claimed';
  } catch (err) {
    if (!err || err.code !== 'EEXIST') return 'fail';
    try {
      return Date.now() - fs.statSync(p).mtimeMs < RACE_MS ? 'racing' : 'already-seen';
    } catch {
      // Marker vanished or unreadable between the failed create and the
      // stat: treat as the retry and allow, matching plan-gate.js's own
      // handling of this same edge.
      return 'already-seen';
    }
  }
}

function pruneStaleState() {
  try {
    const now = Date.now();
    for (const d of fs.readdirSync(STATE_DIR)) {
      const dp = path.join(STATE_DIR, d);
      try {
        if (now - fs.statSync(dp).mtimeMs > STALE_MS) fs.rmSync(dp, { recursive: true, force: true });
      } catch {
        /* dir vanished between readdir and stat/rm */
      }
    }
  } catch {
    /* no state dir yet */
  }
}

// --- Messages ---

function gitGuardReason(kinds, mode) {
  const kindNames = kinds.join(', ');
  const described = kinds.map((k) => KIND_LABELS[baseKind(k)] || k).join('; ');
  const lines = [`[GitGuard] This command matches ${kindNames}: ${described}.`];
  // stage-env-file is a disclosure tripwire, not a destructive operation: the
  // generic "confirm the user asked for this exact operation, then retry"
  // line below is the wrong question for it (an intentional-repeat check),
  // since it says nothing about whether the file is actually safe and, on
  // its own, would coach exactly the bypass this file exists to prevent
  // (retry the same command unchanged). So the generic rationale and its
  // retry line are emitted only when at least one matched kind is NOT
  // stage-env-file; a command that matches this kind alongside a destructive
  // kind via `&&` still needs both, since the destructive kind's own retry
  // instruction still applies to it.
  if (kinds.some((k) => baseKind(k) !== 'stage-env-file')) {
    lines.push(
      'The standing protect-the-working-tree rule forbids destructive or history-altering git operations, or discarding uncommitted changes, unless the user explicitly asked for that exact operation.',
      mode === 'deny'
        ? 'Confirm the user asked for this exact operation, then retry the same command: the retry passes.'
        : 'This command is proceeding; confirm the user asked for this exact operation.'
    );
  }
  if (kinds.some((k) => baseKind(k) === 'stage-env-file')) {
    lines.push(
      'The same standing rule also states: "Never commit secrets, API keys, credentials, or a .env file; a committed-by-convention template (.env.example, .env.sample) is fine." ' +
        (mode === 'deny'
          ? 'Confirm this file holds no secrets (a template, dummy test values, or an encrypted-by-design file), then retry: the retry passes.'
          : 'This command is proceeding; confirm this file holds no secrets (a template, dummy test values, or an encrypted-by-design file).')
    );
  }
  lines.push('(GITGUARD_DISABLED=1 turns this gate off; GITGUARD_WARN=1 demotes deny to a warning.)');
  return lines.join('\n');
}

// --- Command extraction (per dialect) ---

function extractCommand(input, dialect) {
  if (dialect === 'copilot') {
    const toolName = String(input.toolName || '');
    if (toolName !== 'bash' && toolName !== 'powershell') return null;
    let args = input.toolArgs;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    if (!args || typeof args !== 'object') args = {};
    return typeof args.command === 'string' ? args.command : null;
  }
  const toolName = String(input.tool_name || '');
  if (toolName !== 'Bash') return null;
  const toolInput = input.tool_input || {};
  return typeof toolInput.command === 'string' ? toolInput.command : null;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    // Unparseable input: allow. We don't know the dialect, so emit the
    // universally-safe explicit allow (Copilot needs it; snake ignores it).
    process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
    process.exit(0);
  }

  const dialect = detectDialect(input);

  if (process.env.GITGUARD_DISABLED === '1') {
    emitAllow(dialect);
    process.exit(0);
  }

  const command = extractCommand(input, dialect);
  if (!command || !command.trim()) {
    emitAllow(dialect);
    process.exit(0);
  }

  const kinds = detectDestructiveGit(command);
  if (kinds.size === 0) {
    emitAllow(dialect);
    process.exit(0);
  }

  pruneStaleState();
  const dir = sessionDir(input.session_id || input.sessionId, input);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* claim will fail-open below if the dir truly can't be made */
  }

  // Mark at fire time (deny or warn) so the retry passes: this is what makes
  // the gate deny-once and loop-free. Claim every unseen kind this command
  // matched; a 'racing' kind (see claimMarker) denies/warns too without
  // claiming anything (someone else's invocation owns that marker). If a
  // claim can't persist partway through, roll back the markers THIS call
  // created (not 'racing' ones, which it doesn't own) before failing open:
  // the invariant is that a kind stays marked only if a deny/warn was
  // actually emitted for it, so a marker with no emitted decision must not
  // be left behind to silently gate away a real future occurrence.
  const toDeny = [];
  const claimedNow = [];
  let claimFailed = false;
  for (const kind of kinds) {
    const res = claimMarker(dir, kind);
    if (res === 'fail') {
      claimFailed = true;
      break;
    }
    if (res === 'claimed') {
      claimedNow.push(kind);
      toDeny.push(kind);
    } else if (res === 'racing') {
      toDeny.push(kind);
    }
    // 'already-seen': already gated a model turn ago; nothing to do.
  }

  if (claimFailed) {
    for (const kind of claimedNow) {
      try {
        fs.unlinkSync(markerPath(dir, kind));
      } catch {
        /* best effort: an unremovable marker still fails open below */
      }
    }
    process.stderr.write(
      '[GitGuard] state could not be persisted; allowing the command to avoid a deny loop.\n'
    );
    emitAllow(dialect);
    process.exit(0);
  }

  // Every matched kind was already gated a model turn ago -> allow (the
  // loop-free retry).
  if (toDeny.length === 0) {
    emitAllow(dialect);
    process.exit(0);
  }

  const mode = process.env.GITGUARD_WARN === '1' ? 'warn' : 'deny';
  const reason = gitGuardReason(toDeny, mode);

  if (mode === 'deny') emitDeny(dialect, reason);
  else emitWarn(dialect, reason);
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[GitGuard] ${err && err.message}\n`);
  // Fail open. Emit the explicit allow so a fail-closed harness (Copilot)
  // never denies just because the gate threw; snake harnesses ignore it.
  try {
    process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
  } catch {
    /* stdout gone, nothing more we can do */
  }
  process.exit(0);
}
