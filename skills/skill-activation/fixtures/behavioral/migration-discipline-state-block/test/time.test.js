'use strict';

const test = require('node:test');
const assert = require('node:assert');
const clock = require('../lib/clock');
const { createSession, isExpired } = require('../src/session');
const { createCache } = require('../src/cache');
const { createLimiter } = require('../src/rate-limit');
const { stamp } = require('../src/audit');
const { nextDelay } = require('../src/retry');

let t = 1000;
clock.setSource(() => t);

test('session expires at its ttl', () => {
  t = 1000;
  const s = createSession(500);
  assert.strictEqual(s.expiresAt, 1500);
  t = 1499;
  assert.strictEqual(isExpired(s), false);
  t = 1500;
  assert.strictEqual(isExpired(s), true);
});

test('cache entry lapses after its ttl', () => {
  t = 0;
  const c = createCache(100);
  c.set('a', 1);
  t = 100;
  assert.strictEqual(c.get('a'), 1);
  t = 101;
  assert.strictEqual(c.get('a'), undefined);
});

test('limiter allows maxHits per window', () => {
  t = 0;
  const allow = createLimiter(2, 1000);
  assert.strictEqual(allow(), true);
  assert.strictEqual(allow(), true);
  assert.strictEqual(allow(), false);
  t = 1000;
  assert.strictEqual(allow(), true);
});

test('audit stamp records the current time', () => {
  t = 42;
  assert.deepStrictEqual(stamp('login'), { event: 'login', at: 42 });
});

test('retry delay backs off and stops at the deadline', () => {
  t = 0;
  assert.strictEqual(nextDelay(0, 0, 1000), 100);
  assert.strictEqual(nextDelay(2, 0, 1000), 400);
  t = 1000;
  assert.strictEqual(nextDelay(0, 0, 1000), null);
});
