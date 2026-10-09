'use strict';

const clock = require('../lib/clock');

function createCache(ttlMs) {
  const entries = new Map();
  return {
    set(key, value) {
      entries.set(key, { value, storedAt: clock.nowMs() });
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (clock.nowMs() - entry.storedAt > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
  };
}

module.exports = { createCache };
