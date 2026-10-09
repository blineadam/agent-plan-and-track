'use strict';

const clock = require('../lib/clock');

function createLimiter(maxHits, windowMs) {
  let hits = [];
  return function allow() {
    const t = clock.nowMs();
    hits = hits.filter((h) => t - h < windowMs);
    if (hits.length >= maxHits) return false;
    hits.push(t);
    return true;
  };
}

module.exports = { createLimiter };
