#!/usr/bin/env node
/**
 * Strategic Compact Suggester (Claude Code only)
 *
 * A PreToolUse (Edit/Write) hook that nudges you to run /compact at logical
 * boundaries instead of waiting for arbitrary mid-task auto-compaction. It adds
 * a one-line suggestion to the next model turn via hookSpecificOutput; it never
 * blocks a tool call and always exits 0.
 *
 * Two signals:
 *  - Context size (primary): reads the latest assistant `usage` record from the
 *    session transcript and compares real context tokens against a window-scaled
 *    threshold, re-reminding after each interval of growth.
 *  - Tool-call count (secondary): first at COMPACT_THRESHOLD, then every 25.
 *
 * Self-contained: no external modules, Node core only (Claude Code ships Node).
 * Claude-native — reads Claude's transcript JSONL format and suggests /compact —
 * so it stays a Claude-only piece; Copilot/Codex get the guidance skill instead.
 *
 * Config (env): COMPACT_THRESHOLD (default 50), COMPACT_CONTEXT_THRESHOLD
 * (default 160000 on a 200k window / 250000 on 1M; 0 disables the context
 * signal), COMPACT_CONTEXT_INTERVAL (default 60000).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Last assistant usage record in the transcript → real context size + model.
function readLatestUsage(transcriptPath) {
  if (!transcriptPath) return null;
  let text;
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const u = obj && obj.message && obj.message.usage;
    if (u && typeof u.input_tokens === 'number') {
      const tokens =
        (u.input_tokens || 0) +
        (u.cache_read_input_tokens || 0) +
        (u.cache_creation_input_tokens || 0);
      const model = (obj.message && obj.message.model) || '';
      return { tokens, model };
    }
  }
  return null;
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    input = {};
  }

  const rawId =
    (input && typeof input.session_id === 'string' && input.session_id) ||
    process.env.CLAUDE_SESSION_ID ||
    'default';
  const sessionId = rawId.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  const transcriptPath =
    input && typeof input.transcript_path === 'string' ? input.transcript_path : '';

  const tmp = os.tmpdir();
  const counterFile = path.join(tmp, `claude-tool-count-${sessionId}`);
  const bucketFile = path.join(tmp, `claude-context-bucket-${sessionId}`);
  const messages = [];

  // --- Context-size signal (primary) ---
  const usage = readLatestUsage(transcriptPath);
  if (usage) {
    const is1M = /\[1m\]/i.test(usage.model) || usage.tokens > 200000;
    const windowTokens = is1M ? 1000000 : 200000;
    const threshold = intEnv('COMPACT_CONTEXT_THRESHOLD', is1M ? 250000 : 160000);
    const interval = Math.max(1, intEnv('COMPACT_CONTEXT_INTERVAL', 60000));
    if (threshold > 0 && usage.tokens >= threshold) {
      const bucket = Math.floor((usage.tokens - threshold) / interval);
      let last = -1;
      try {
        last = Number.parseInt(fs.readFileSync(bucketFile, 'utf8').trim(), 10);
        if (!Number.isInteger(last)) last = -1;
      } catch {
        last = -1;
      }
      if (bucket > last) {
        try {
          fs.writeFileSync(bucketFile, String(bucket));
        } catch {
          /* best effort */
        }
        const approx = `${Math.round(usage.tokens / 1000)}k`;
        const pct = Math.round((usage.tokens / windowTokens) * 100);
        const win = windowTokens >= 1000000 ? '1M' : '200k';
        messages.push(
          `[StrategicCompact] Context ~${approx} tokens (${pct}% of ${win} window) — consider /compact at the next logical boundary.`
        );
      }
    }
  }

  // --- Tool-count signal (secondary) ---
  const toolThreshold = intEnv('COMPACT_THRESHOLD', 50) || 50;
  let count = 1;
  try {
    const prev = Number.parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10);
    if (Number.isInteger(prev) && prev > 0 && prev <= 1000000) count = prev + 1;
  } catch {
    count = 1;
  }
  try {
    fs.writeFileSync(counterFile, String(count));
  } catch {
    /* best effort */
  }
  if (count === toolThreshold) {
    messages.push(
      `[StrategicCompact] ${toolThreshold} tool calls reached — consider /compact if you're transitioning phases.`
    );
  } else if (count > toolThreshold && (count - toolThreshold) % 25 === 0) {
    messages.push(
      `[StrategicCompact] ${count} tool calls — good checkpoint for /compact if the context is stale.`
    );
  }

  if (messages.length > 0) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: messages.join('\n'),
        },
      })
    );
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[StrategicCompact] ${err && err.message}\n`);
  process.exit(0);
}
