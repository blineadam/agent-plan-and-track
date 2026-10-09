'use strict';

const clock = require('../lib/clock');

// Returns the next delay in ms, or null once the deadline has passed.
function nextDelay(attempt, startedAt, deadlineMs) {
  const elapsed = clock.nowMs() - startedAt;
  if (elapsed >= deadlineMs) return null;
  return Math.min(100 * 2 ** attempt, deadlineMs - elapsed);
}

module.exports = { nextDelay };
