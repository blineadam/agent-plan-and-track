'use strict';

const fs = require('fs');
const path = require('path');

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function normalizePayload(raw) {
  const parsed = JSON.parse(raw);
  return {
    message: typeof parsed.message === 'string' ? parsed.message : '',
    turnCount: typeof parsed.turnCount === 'number' ? parsed.turnCount : 0,
    timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
  };
}

const LOG_PATH = path.join(__dirname, '..', 'session-stats.log');

function appendLog(payload) {
  const line = `${payload.timestamp} turns=${payload.turnCount}\n`;
  fs.appendFileSync(LOG_PATH, line);
}

async function main() {
  const raw = await readStdin();
  const payload = normalizePayload(raw);
  appendLog(payload);
  process.stdout.write(JSON.stringify({ logged: true }));
}

main();
