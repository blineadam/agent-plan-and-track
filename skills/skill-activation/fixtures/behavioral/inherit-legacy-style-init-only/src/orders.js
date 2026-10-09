'use strict';
const { fetchJson } = require('./lib/http');
const { logError } = require('./lib/log');

async function listOrders(pageNo) {
  try {
    const data = await fetchJson('/api/orders?page=' + pageNo);
    return { ok: true, data };
  } catch (err) {
    logError('orders.list', err);
    return { ok: false, error: err.message };
  }
}

module.exports = { listOrders };
