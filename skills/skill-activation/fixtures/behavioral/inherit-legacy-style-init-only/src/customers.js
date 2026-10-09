'use strict';
const { fetchJson } = require('./lib/http');
const { logError } = require('./lib/log');

async function listCustomers(pageNo) {
  try {
    const data = await fetchJson('/api/customers?page=' + pageNo);
    return { ok: true, data };
  } catch (err) {
    logError('customers.list', err);
    return { ok: false, error: err.message };
  }
}

module.exports = { listCustomers };
