'use strict';

const clock = require('../lib/clock');

function createSession(ttlMs) {
  return { expiresAt: clock.nowMs() + ttlMs };
}

function isExpired(session) {
  return clock.nowMs() >= session.expiresAt;
}

module.exports = { createSession, isExpired };
