'use strict';

const cache = new Map();

async function warmCache() {
  console.log('cache_warm_started');
  // A real deployment preloads recent invoices here.
  console.log('cache_warm_finished', { entries: cache.size });
}

module.exports = { warmCache, cache };
