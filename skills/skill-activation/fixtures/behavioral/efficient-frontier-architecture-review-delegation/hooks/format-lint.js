'use strict';

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

function checkShape(message) {
  const trimmed = message.trim();
  const startsCapital = /^[A-Z]/.test(trimmed);
  const endsPeriod = trimmed.endsWith('.');
  const ok = startsCapital && !endsPeriod;
  const reasons = [];
  if (!startsCapital) {
    reasons.push('message must start with a capital letter');
  }
  if (endsPeriod) {
    reasons.push('message must not end with a period');
  }
  return { ok, reasons };
}

async function main() {
  const raw = await readStdin();
  const payload = normalizePayload(raw);
  const result = checkShape(payload.message);
  process.stdout.write(JSON.stringify({ ok: result.ok, reasons: result.reasons }));
  process.exitCode = result.ok ? 0 : 1;
}

main();
