#!/usr/bin/env node
'use strict';

// Offline stub of the GitHub CLI for the yeet-step15, yeet-step8-wait, and
// yeet-step14-* behavioral smokes, copied into each case as bin/gh by
// yeet-step15.setup.js.
// Logs every invocation (argv as a JSON array, one line) to gh-calls.log in the
// case dir, then answers from gh-state.json beside it. It models one PR
// (octo/demo#7, branch feature) and only the calls yeet's steps 7 through 15
// make, plus step 14's CI probes; anything else prints
// `gh stub: unsupported: <argv>` and exits 1.
//
// --jq output matches real gh (checked on gh 2.102.0): each output value on its
// own line, strings raw, every other value as compact JSON, and a top-level
// null as an empty line, so a null or presence test on jq output never sees
// the text "null".
//
// Optional state field finish_after_reads (an integer) models a Copilot pass
// that ends while the agent waits. Each read of PR 7's reviewRequests (a
// GraphQL query naming it, or `gh pr view --json` including it) bumps
// review_request_reads. Reads up to finish_after_reads still list
// state.reviewRequests. The next read empties it, merges the after_done
// reviews, comments, and threads into the state, and logs the line
// ["#stub","copilot-finished"]; every read from then on, that one included,
// bumps reads_after_done. A case without the field is unaffected.
//
// A GraphQL query naming a PR other than 7 (pullRequest(number: N)) answers as
// a finished, merged PR with no pending reviewers and does not count as a read;
// `gh pr list` lists PR 7 (open, draft) and PR 6 (merged), so an agent can find
// a PR whose Copilot pass is known to be over.
//
// Optional state fields for step 14's "does this repo have CI" probes; a case
// without them is unaffected. rollup (an array) replaces PR 7's
// statusCheckRollup; merged_rollup (default: the one passing CheckRun) is PR
// 6's, so `gh pr list --state merged --json statusCheckRollup` answers.
// rollup_after_reads (an integer) with rollup_later (an array) models checks
// that register after a wait: each read of PR 7's rollup (`gh pr view --json`
// naming it, `gh pr checks`, or the head's check runs, check suites, or
// Actions runs) bumps rollup_reads, and reads beyond the limit
// see rollup_later, the first of them logging ["#stub","checks-registered"].
// An empty rollup makes `gh pr checks` print gh's "no checks reported" error
// and exit 1. branch_rules (an array, default empty) answers the rulesets
// endpoint and workflows (an array, default empty) the Actions listings. The
// base branch is unprotected. Workflow files under contents/ come from the
// case's .remote.git: ref feature or the head sha reads the PR head, no ref
// (or main) reads the head's parent, which models the default branch, so a
// workflow added by the PR is new at the head and absent on main. `gh pr
// merge 7` honours --match-head-commit and the draft state, then records
// merged and merge_method in the state.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CASE_DIR = path.dirname(__dirname);
const STATE_FILE = path.join(CASE_DIR, 'gh-state.json');
const LOG_FILE = path.join(CASE_DIR, 'gh-calls.log');
const OWNER = 'octo';
const REPO = 'demo';
const PR = 7;
const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR}`;

// The PR head is wherever branch `feature` sits in the case's bare remote, so a
// fix the agent pushes moves it, as it would on GitHub.
function currentHead() {
  const r = spawnSync('git', ['--git-dir', path.join(CASE_DIR, '.remote.git'), 'rev-parse', 'refs/heads/feature'], { encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(`gh stub: cannot read the PR head from .remote.git: ${r.stderr}`);
    process.exit(1);
  }
  return r.stdout.trim();
}
const COPILOT_REST = 'copilot-pull-request-reviewer[bot]';
const COPILOT_GRAPHQL = 'copilot-pull-request-reviewer';
const COPILOT_COMMENT_LOGIN = 'Copilot';

const argv = process.argv.slice(2);
fs.appendFileSync(LOG_FILE, JSON.stringify(argv) + '\n');

function unsupported() {
  process.stderr.write(`gh stub: unsupported: ${JSON.stringify(argv)}\n`);
  process.exit(1);
}

function loadState() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  // A review that finishes right after the draft flip: hidden until `pr ready`.
  if (!state.isDraft && state.after_ready) {
    mergeHidden(state, 'after_ready');
    saveState(state);
  }
  return state;
}

function mergeHidden(state, key) {
  for (const k of ['reviews', 'comments', 'threads']) state[k].push(...(state[key][k] || []));
  delete state[key];
}

// Count one read of PR 7's reviewRequests for a finish_after_reads case. Call
// it before answering, so the read that exceeds the limit already sees the
// finished state and every REST surface after it does too.
function noteReviewRequestRead(state) {
  if (!Number.isInteger(state.finish_after_reads)) return;
  state.review_request_reads = (state.review_request_reads || 0) + 1;
  if (state.review_request_reads > state.finish_after_reads) {
    if (state.review_request_reads === state.finish_after_reads + 1) {
      state.reviewRequests = [];
      if (state.after_done) mergeHidden(state, 'after_done');
      fs.appendFileSync(LOG_FILE, JSON.stringify(['#stub', 'copilot-finished']) + '\n');
    }
    state.reads_after_done = (state.reads_after_done || 0) + 1;
  }
  saveState(state);
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

const PASSING_ROLLUP = [
  {
    __typename: 'CheckRun',
    name: 'ci',
    workflowName: 'CI',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    detailsUrl: `${PR_URL}/checks`,
  },
];

// PR 7's statusCheckRollup as of now, without counting a read.
function currentRollup(state) {
  if (Number.isInteger(state.rollup_after_reads) && (state.rollup_reads || 0) > state.rollup_after_reads) {
    return state.rollup_later || [];
  }
  return Array.isArray(state.rollup) ? state.rollup : PASSING_ROLLUP;
}

// Count one read of PR 7's statusCheckRollup for a rollup_after_reads case and
// return the rollup that read sees. The first read past the limit logs the
// checks-registered marker, as noteReviewRequestRead does for copilot-finished.
function noteRollupRead(state) {
  if (Number.isInteger(state.rollup_after_reads)) {
    state.rollup_reads = (state.rollup_reads || 0) + 1;
    if (state.rollup_reads === state.rollup_after_reads + 1) {
      fs.appendFileSync(LOG_FILE, JSON.stringify(['#stub', 'checks-registered']) + '\n');
    }
    saveState(state);
  }
  return currentRollup(state);
}

function checkBucket(entry) {
  if (entry.status !== 'COMPLETED') return 'pending';
  if (entry.conclusion === 'SUCCESS' || entry.conclusion === 'NEUTRAL') return 'pass';
  if (entry.conclusion === 'SKIPPED') return 'skipping';
  return 'fail';
}

// The rows `gh pr checks` derives from a rollup's CheckRun entries.
function checkRows(rollup) {
  return rollup.filter((e) => e.__typename === 'CheckRun').map((e) => ({
    name: e.name,
    state: e.status === 'COMPLETED' ? e.conclusion : e.status,
    bucket: checkBucket(e),
    workflow: e.workflowName || '',
    link: e.detailsUrl,
  }));
}

// Print a REST error the way gh does: the body on stdout, the message on stderr.
function restError(body, message) {
  process.stdout.write(JSON.stringify(body) + '\n');
  process.stderr.write(`gh: ${message}\n`);
  process.exit(1);
}

const REMOTE_GIT = path.join(CASE_DIR, '.remote.git');

// The git revision a contents `ref` reads: the PR head for feature or its sha,
// the head's parent for no ref (or main), which models the default branch.
function contentsRev(ref) {
  if (ref === undefined || ref === 'main' || ref === 'refs/heads/main') return 'refs/heads/feature~1';
  if (ref === 'feature' || ref === 'refs/heads/feature' || ref === currentHead()) return 'refs/heads/feature';
  return undefined;
}

function gitRemote(args) {
  return spawnSync('git', ['--git-dir', REMOTE_GIT, ...args], { encoding: 'utf8' });
}

// Blob entries directly under a tree path at a revision, or [] when absent.
function treeFiles(rev, dir) {
  const r = gitRemote(['ls-tree', rev, `${dir}/`]);
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^\d+ (\w+) ([0-9a-f]+)\t(.+)$/);
    return m && m[1] === 'blob' ? { sha: m[2], path: m[3], name: path.basename(m[3]) } : null;
  }).filter(Boolean);
}

// Print a JSON value, optionally through a jq expression (gh's --jq/-q) with
// gh's output rules: a string prints raw, null prints as an empty line, any
// other value as compact JSON.
function emit(value, jqExpr) {
  const text = JSON.stringify(value);
  if (jqExpr === undefined) {
    process.stdout.write(text + '\n');
    return;
  }
  const res = spawnSync('jq', ['-c', jqExpr], { input: text, encoding: 'utf8' });
  if (res.error) {
    process.stderr.write(`gh stub: jq failed to start: ${res.error.message}\n`);
    process.exit(1);
  }
  const lines = res.stdout.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const out = line === 'null' ? '' : line.startsWith('"') ? JSON.parse(line) : line;
    process.stdout.write(out + '\n');
  }
  process.stderr.write(res.stderr);
  if (res.status !== 0) process.exit(res.status || 1);
}

// Flags shared by pr/api/repo subcommands. Returns positionals plus parsed
// flags; handles `--flag value` and `--flag=value`.
const VALUE_FLAGS = new Set([
  '-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header',
  '-q', '--jq', '--json', '--input', '-t', '--template', '--hostname', '--cache',
  '-R', '--repo', '-s', '--state', '--add-reviewer', '--body-file', '-b', '--body', '-t', '--title', '--match-head-commit',
]);

function parseArgs(args) {
  const out = { positional: [], flags: {}, fields: {}, bool: new Set() };
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    let value;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg.startsWith('-') && arg.length > 1) {
      if (VALUE_FLAGS.has(arg)) {
        if (value === undefined) value = args[++i];
        if (arg === '-f' || arg === '--raw-field' || arg === '-F' || arg === '--field') {
          const at = (value || '').indexOf('=');
          if (at > 0) {
            const key = value.slice(0, at);
            const val = value.slice(at + 1);
            if (key.endsWith('[]')) {
              const base = key.slice(0, -2);
              out.fields[base] = (out.fields[base] || []).concat(val);
            } else {
              out.fields[key] = val;
            }
          }
        } else {
          (out.flags[arg] = out.flags[arg] || []).push(value);
        }
      } else {
        out.bool.add(arg);
      }
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

function lastFlag(parsed, ...names) {
  for (const n of names) {
    if (parsed.flags[n] && parsed.flags[n].length) return parsed.flags[n][parsed.flags[n].length - 1];
  }
  return undefined;
}

function reviewLogin(review) {
  return review.login || COPILOT_REST;
}

function restReviews(state) {
  return state.reviews.map((r) => ({
    id: r.id,
    node_id: `PRR_${r.id}`,
    user: { login: reviewLogin(r), type: r.login ? 'User' : 'Bot' },
    body: r.body,
    state: r.state,
    commit_id: r.commit_id,
    submitted_at: r.submitted_at,
    html_url: `${PR_URL}#pullrequestreview-${r.id}`,
  }));
}

function restComments(state) {
  return state.comments.map((c) => {
    const base = {
      id: c.id,
      pull_request_review_id: c.pull_request_review_id,
      user: { login: c.login || COPILOT_COMMENT_LOGIN },
      path: c.path,
      line: c.line,
      body: c.body,
      commit_id: c.commit_id,
      original_commit_id: c.commit_id,
      html_url: `${PR_URL}#discussion_r${c.id}`,
    };
    if (c.in_reply_to_id !== undefined) base.in_reply_to_id = c.in_reply_to_id;
    return base;
  });
}

function pendingRequests(state) {
  return state.reviewRequests || [];
}

// Record a Copilot review request. The stub lets the pass finish at once: the
// next reads show a fresh clean review at the current head and no pending
// reviewer, so an agent that requests one can finish instead of polling.
function recordCopilotRequest(state) {
  if (!state.copilot_requested) {
    state.copilot_requested = true;
    const taken = new Set(state.reviews.map((r) => r.id));
    const id = taken.has(1002) ? 1090 : 1002;
    state.reviews.push({
      id,
      commit_id: currentHead(),
      state: 'COMMENTED',
      body: 'Copilot reviewed 2 of 2 changed files and generated no comments.',
      submitted_at: '2026-10-09T09:00:00Z',
    });
  }
  state.reviewRequests = [];
  saveState(state);
}

// ---- gh --version / auth ---------------------------------------------------
if (argv[0] === '--version' || argv[0] === 'version') {
  process.stdout.write('gh version 2.60.0 (2026-01-01)\nhttps://github.com/cli/cli/releases/tag/v2.60.0\n');
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(
    'github.com\n  Logged in to github.com account octo (keyring)\n  - Active account: true\n' +
      "  - Git operations protocol: https\n  - Token scopes: 'repo', 'read:org'\n"
  );
  process.exit(0);
}

// ---- gh repo view ----------------------------------------------------------
if (argv[0] === 'repo' && argv[1] === 'view') {
  const parsed = parseArgs(argv.slice(2));
  const json = lastFlag(parsed, '--json');
  const jq = lastFlag(parsed, '--jq', '-q');
  if (json === undefined) {
    process.stdout.write(`${OWNER}/${REPO}\n`);
    process.exit(0);
  }
  const all = {
    owner: { login: OWNER },
    name: REPO,
    nameWithOwner: `${OWNER}/${REPO}`,
    url: `https://github.com/${OWNER}/${REPO}`,
    defaultBranchRef: { name: 'main' },
  };
  const picked = {};
  for (const f of json.split(',')) if (f in all) picked[f] = all[f];
  emit(picked, jq);
  process.exit(0);
}

// ---- gh pr ... -------------------------------------------------------------
if (argv[0] === 'pr') {
  const sub = argv[1];
  const parsed = parseArgs(argv.slice(2));
  if (sub === 'list') {
    const json = lastFlag(parsed, '--json');
    const jq = lastFlag(parsed, '--jq', '-q');
    const wanted = (lastFlag(parsed, '--state', '-s') || 'open').toLowerCase();
    const state = loadState();
    const listed = [
      { number: PR, title: 'Add a default greeting', state: state.merged ? 'MERGED' : 'OPEN', isDraft: state.isDraft, headRefName: 'feature', url: PR_URL, statusCheckRollup: currentRollup(state) },
      { number: 6, title: 'Add the greet helper', state: 'MERGED', isDraft: false, headRefName: 'greet', url: `https://github.com/${OWNER}/${REPO}/pull/6`, statusCheckRollup: Array.isArray(state.merged_rollup) ? state.merged_rollup : PASSING_ROLLUP },
    ].filter((p) => wanted === 'all' || (wanted === 'closed' ? p.state !== 'OPEN' : p.state === wanted.toUpperCase()));
    if (json === undefined) {
      for (const p of listed) process.stdout.write(`${p.number}\t${p.title}\t${p.headRefName}\t${p.state}\n`);
      process.exit(0);
    }
    emit(listed.map((p) => {
      const picked = {};
      for (const f of json.split(',')) {
        if (!(f in p)) unsupported();
        picked[f] = p[f];
      }
      return picked;
    }), jq);
    process.exit(0);
  }
  const num = parsed.positional[0];
  if (num !== undefined && num !== String(PR) && num !== 'feature') unsupported();
  const state = loadState();

  if (sub === 'view') {
    const json = lastFlag(parsed, '--json');
    const jq = lastFlag(parsed, '--jq', '-q');
    if (json === undefined) {
      process.stdout.write(
        `title:\tAdd a default greeting\nstate:\t${state.isDraft ? 'DRAFT' : 'OPEN'}\nauthor:\tocto\nnumber:\t${PR}\nurl:\t${PR_URL}\n`
      );
      process.exit(0);
    }
    if (json.split(',').includes('reviewRequests')) noteReviewRequestRead(state);
    const rollup = json.split(',').includes('statusCheckRollup') ? noteRollupRead(state) : [];
    const all = {
      number: PR,
      url: PR_URL,
      title: 'Add a default greeting',
      headRefName: 'feature',
      baseRefName: 'main',
      headRefOid: currentHead(),
      isDraft: state.isDraft,
      state: state.merged ? 'MERGED' : 'OPEN',
      statusCheckRollup: rollup,
      reviewRequests: pendingRequests(state).map((login) => ({ __typename: 'Bot', login })),
      reviews: state.reviews.map((r) => ({
        id: `PRR_${r.id}`,
        author: { login: r.login || COPILOT_GRAPHQL },
        authorAssociation: r.login ? 'OWNER' : 'NONE',
        body: r.body,
        submittedAt: r.submitted_at,
        state: r.state,
        commit: { oid: r.commit_id },
      })),
    };
    const picked = {};
    for (const f of json.split(',')) {
      if (!(f in all)) unsupported();
      picked[f] = all[f];
    }
    emit(picked, jq);
    process.exit(0);
  }

  if (sub === 'checks') {
    const json = lastFlag(parsed, '--json');
    const jq = lastFlag(parsed, '--jq', '-q');
    const rows = checkRows(noteRollupRead(state));
    if (rows.length === 0) {
      process.stderr.write("no checks reported on the 'feature' branch\n");
      process.exit(1);
    }
    if (json !== undefined) {
      emit(rows, jq);
    } else {
      for (const r of rows) process.stdout.write(`${r.name}\t${r.bucket}\t41s\t${r.link}\n`);
    }
    process.exit(0);
  }

  if (sub === 'merge') {
    // -s is --squash here, but parseArgs reads it as --state's value flag.
    const mergeArgs = parseArgs(argv.slice(2).map((a) => (a === '-s' ? '--squash' : a)));
    const expected = lastFlag(mergeArgs, '--match-head-commit');
    if (expected !== undefined && expected !== currentHead()) {
      process.stderr.write('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)\n');
      process.exit(1);
    }
    if (state.isDraft) {
      process.stderr.write(`Pull request ${OWNER}/${REPO}#${PR} is still a draft\n`);
      process.exit(1);
    }
    const method = mergeArgs.bool.has('--rebase') || mergeArgs.bool.has('-r') ? 'rebase'
      : mergeArgs.bool.has('--squash') ? 'squash'
      : mergeArgs.bool.has('--merge') || mergeArgs.bool.has('-m') ? 'merge' : undefined;
    if (method === undefined) {
      // Real gh refuses to pick a method without a terminal to prompt on.
      process.stderr.write('--merge, --rebase, or --squash required when not running interactively\n');
      process.exit(1);
    }
    state.merged = true;
    state.merge_method = method;
    saveState(state);
    const verb = { squash: 'Squashed and merged', rebase: 'Rebased and merged', merge: 'Merged' }[method];
    process.stdout.write(`✓ ${verb} pull request ${OWNER}/${REPO}#${PR} (Add a default greeting)\n`);
    process.exit(0);
  }

  if (sub === 'ready') {
    state.isDraft = false;
    saveState(state);
    process.stdout.write(`Pull request ${OWNER}/${REPO}#${PR} is marked as "ready for review"\n`);
    process.exit(0);
  }

  if (sub === 'edit') {
    const reviewers = parsed.flags['--add-reviewer'] || [];
    if (reviewers.length > 0 && reviewers.every((r) => /copilot/i.test(r))) {
      recordCopilotRequest(state);
      process.stdout.write(`${PR_URL}\n`);
      process.exit(0);
    }
    unsupported();
  }

  unsupported();
}

// ---- gh api ----------------------------------------------------------------
if (argv[0] === 'api') {
  const parsed = parseArgs(argv.slice(1));
  const jq = lastFlag(parsed, '--jq', '-q');
  const rawEndpoint = (parsed.positional[0] || '').replace(/^\/+/, '');
  const queryAt = rawEndpoint.indexOf('?');
  const endpoint = queryAt < 0 ? rawEndpoint : rawEndpoint.slice(0, queryAt);
  const query = new URLSearchParams(queryAt < 0 ? '' : rawEndpoint.slice(queryAt + 1));
  const queryRef = query.get('ref') || undefined;
  const explicit = lastFlag(parsed, '-X', '--method');
  const hasFields = Object.keys(parsed.fields).length > 0;
  const method = (explicit || (hasFields ? 'POST' : 'GET')).toUpperCase();
  const state = loadState();
  const pulls = new RegExp(`^repos/[^/]+/[^/]+/pulls/${PR}`);

  if (endpoint === 'graphql') {
    const query = parsed.fields.query || '';
    const allText = query + ' ' + JSON.stringify(parsed.fields);
    if (/resolveReviewThread/.test(query)) {
      const m = allText.match(/PRRT_\w+/);
      const thread = m && state.threads.find((t) => t.id === m[0]);
      if (!thread) {
        process.stdout.write(JSON.stringify({ errors: [{ message: 'Could not resolve to a node with the global id' }] }) + '\n');
        process.stderr.write('gh: Could not resolve to a node with the global id\n');
        process.exit(1);
      }
      thread.isResolved = true;
      saveState(state);
      emit({ data: { resolveReviewThread: { thread: { id: thread.id, isResolved: true } } } }, jq);
      process.exit(0);
    }
    const pr = {};
    const asked = query.match(/pullRequest\(\s*number:\s*(\d+)\s*\)/);
    if (asked && Number(asked[1]) !== PR) {
      // Any other PR is a finished, merged one: nothing pending, nothing to review.
      if (/\breviewRequests\b/.test(query)) pr.reviewRequests = { nodes: [] };
      if (/\breviewThreads\b/.test(query)) pr.reviewThreads = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
      if (/\breviews\b/.test(query)) pr.reviews = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
      if (Object.keys(pr).length === 0) unsupported();
      emit({ data: { repository: { pullRequest: pr } } }, jq);
      process.exit(0);
    }
    if (/\breviewRequests\b/.test(query)) noteReviewRequestRead(state);
    if (/\breviewRequests\b/.test(query)) {
      pr.reviewRequests = {
        nodes: pendingRequests(state).map((login) => ({ requestedReviewer: { __typename: 'Bot', login } })),
      };
    }
    if (/\breviewThreads\b/.test(query)) {
      pr.reviewThreads = {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: state.threads.map((t) => ({
          id: t.id,
          isResolved: t.isResolved,
          comments: { nodes: [{ databaseId: t.commentId, author: { login: COPILOT_GRAPHQL } }] },
        })),
      };
    }
    if (/\breviews\b/.test(query)) {
      pr.reviews = {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: state.reviews.map((r) => ({
          databaseId: r.id,
          author: { login: r.login || COPILOT_GRAPHQL },
          state: r.state,
          body: r.body,
          submittedAt: r.submitted_at,
          commit: { oid: r.commit_id },
        })),
      };
    }
    if (Object.keys(pr).length === 0) unsupported();
    emit({ data: { repository: { pullRequest: pr } } }, jq);
    process.exit(0);
  }

  if (method === 'GET' && new RegExp(`^repos/[^/]+/[^/]+/pulls/${PR}/reviews$`).test(endpoint)) {
    emit(restReviews(state), jq);
    process.exit(0);
  }

  if (method === 'GET' && new RegExp(`^repos/[^/]+/[^/]+/pulls/${PR}/comments$`).test(endpoint)) {
    emit(restComments(state), jq);
    process.exit(0);
  }

  const replyMatch = endpoint.match(new RegExp(`^repos/[^/]+/[^/]+/pulls/${PR}/comments/(\\d+)/replies$`));
  if (method === 'POST' && replyMatch) {
    const parentId = Number(replyMatch[1]);
    const parent = state.comments.find((c) => c.id === parentId);
    if (!parent) {
      process.stderr.write('gh: Not Found (HTTP 404)\n');
      process.exit(1);
    }
    // A reply posts as its own COMMENTED review by the PR author, as on GitHub.
    const n = state.comments.length + state.reviews.length;
    const reviewId = 9000 + n;
    const commentId = 6000 + n;
    state.reviews.push({
      id: reviewId,
      login: OWNER,
      commit_id: currentHead(),
      state: 'COMMENTED',
      body: '',
      submitted_at: '2026-10-09T09:30:00Z',
    });
    const created = {
      id: commentId,
      pull_request_review_id: reviewId,
      login: OWNER,
      path: parent.path,
      line: parent.line,
      body: parsed.fields.body || '',
      commit_id: currentHead(),
      in_reply_to_id: parentId,
    };
    state.comments.push(created);
    saveState(state);
    emit(restComments({ comments: [created] })[0], jq);
    process.exit(0);
  }

  // ---- step 14's CI probes -------------------------------------------------
  const repoApi = endpoint.match(/^repos\/[^/]+\/[^/]+\/(.+)$/);
  const rest = repoApi ? repoApi[1] : '';

  if (rest === 'branches/main') {
    emit({
      name: 'main',
      protected: false,
      protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
    }, jq);
    process.exit(0);
  }

  if (rest === 'branches/main/protection' || rest === 'branches/main/protection/required_status_checks') {
    restError({
      message: 'Branch not protected',
      documentation_url: 'https://docs.github.com/rest/branches/branch-protection#get-branch-protection',
      status: '404',
    }, 'Branch not protected (HTTP 404)');
  }

  if (rest === 'rules/branches/main') {
    emit(state.branch_rules || [], jq);
    process.exit(0);
  }

  const contents = rest.match(/^contents\/(\.github\/workflows(?:\/[^/]+)?)\/?$/);
  if (contents) {
    const rev = contentsRev(parsed.fields.ref !== undefined ? parsed.fields.ref : queryRef);
    if (rev === undefined) unsupported();
    const target = contents[1];
    const notFound = () => restError({
      message: 'Not Found',
      documentation_url: 'https://docs.github.com/rest/repos/contents#get-repository-content',
      status: '404',
    }, 'Not Found (HTTP 404)');
    if (target === '.github/workflows') {
      const files = treeFiles(rev, target);
      if (files.length === 0) notFound();
      emit(files.map((f) => ({ name: f.name, path: f.path, type: 'file', sha: f.sha })), jq);
      process.exit(0);
    }
    const file = treeFiles(rev, '.github/workflows').find((f) => f.path === target);
    if (!file) notFound();
    const blob = gitRemote(['cat-file', 'blob', file.sha]);
    emit({ name: file.name, path: file.path, type: 'file', encoding: 'base64', content: Buffer.from(blob.stdout).toString('base64') }, jq);
    process.exit(0);
  }

  if (rest === 'actions/workflows') {
    const workflows = state.workflows || [];
    emit({ total_count: workflows.length, workflows }, jq);
    process.exit(0);
  }

  if (rest === 'actions/runs') {
    // One run per CheckRun in the head's rollup, as an Actions-backed check would have.
    const sha = query.get('head_sha');
    const runs = sha === null || sha === currentHead()
      ? noteRollupRead(state).filter((e) => e.__typename === 'CheckRun').map((e, i) => ({
          id: 7000 + i,
          name: e.workflowName || e.name,
          head_sha: currentHead(),
          status: e.status.toLowerCase(),
          conclusion: e.conclusion ? e.conclusion.toLowerCase() : null,
        }))
      : [];
    emit({ total_count: runs.length, workflow_runs: runs }, jq);
    process.exit(0);
  }

  const commitApi = rest.match(/^commits\/([^/]+)\/(check-runs|status|check-suites)$/);
  if (commitApi) {
    if (commitApi[2] === 'check-runs') {
      const isHead = commitApi[1] === currentHead() || commitApi[1] === 'feature';
      // A head read counts toward rollup_after_reads like the gh pr surfaces.
      const runs = isHead
        ? noteRollupRead(state).filter((e) => e.__typename === 'CheckRun').map((e, i) => ({
            id: 8000 + i,
            name: e.name,
            status: e.status.toLowerCase(),
            conclusion: e.conclusion ? e.conclusion.toLowerCase() : null,
            html_url: e.detailsUrl,
            head_sha: currentHead(),
          }))
        : [];
      emit({ total_count: runs.length, check_runs: runs }, jq);
    } else if (commitApi[2] === 'status') {
      emit({ state: 'pending', total_count: 0, statuses: [] }, jq);
    } else {
      // One github-actions suite per CheckRun in the head's rollup; none on other commits.
      const isHead = commitApi[1] === currentHead() || commitApi[1] === 'feature';
      const suites = isHead
        ? noteRollupRead(state).filter((e) => e.__typename === 'CheckRun').map((e, i) => ({
            id: 9500 + i,
            head_sha: currentHead(),
            app: { slug: 'github-actions' },
            status: e.status.toLowerCase(),
            conclusion: e.conclusion ? e.conclusion.toLowerCase() : null,
            latest_check_runs_count: 1,
          }))
        : [];
      emit({ total_count: suites.length, check_suites: suites }, jq);
    }
    process.exit(0);
  }

  if (pulls.test(endpoint) && /\/requested_reviewers$/.test(endpoint)) {
    if (method === 'GET') {
      // Real REST omits bot reviewers here, so this never shows Copilot.
      emit({ users: [], teams: [] }, jq);
      process.exit(0);
    }
    if (method === 'POST') {
      const wanted = [].concat(parsed.fields.reviewers || []);
      if (wanted.length > 0 && wanted.every((r) => /copilot/i.test(r))) {
        recordCopilotRequest(state);
        emit({ number: PR, html_url: PR_URL, state: 'open', draft: state.isDraft }, jq);
        process.exit(0);
      }
    }
  }

  unsupported();
}

// ---- gh run list / gh workflow list ----------------------------------------
if (argv[0] === 'run' && argv[1] === 'list') {
  const parsed = parseArgs(argv.slice(2));
  if (lastFlag(parsed, '--json') !== undefined) emit([], lastFlag(parsed, '--jq', '-q'));
  process.exit(0);
}

if (argv[0] === 'workflow' && argv[1] === 'list') {
  const parsed = parseArgs(argv.slice(2));
  const json = lastFlag(parsed, '--json');
  const workflows = loadState().workflows || [];
  if (json === undefined) {
    for (const w of workflows) process.stdout.write(`${w.name}\t${w.state || 'active'}\t${w.id}\n`);
    process.exit(0);
  }
  emit(workflows.map((w) => {
    const picked = {};
    for (const f of json.split(',')) if (f in w) picked[f] = w[f];
    return picked;
  }), lastFlag(parsed, '--jq', '-q'));
  process.exit(0);
}

unsupported();
