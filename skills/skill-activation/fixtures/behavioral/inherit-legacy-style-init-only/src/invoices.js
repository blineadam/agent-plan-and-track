'use strict';
const { fetchJson } = require('./lib/http');
const { logError } = require('./lib/log');

async function listInvoices(pageNo) {
  try {
    const data = await fetchJson('/api/invoices?page=' + pageNo);
    return { ok: true, data };
  } catch (err) {
    logError('invoices.list', err);
    return { ok: false, error: err.message };
  }
}

module.exports = { listInvoices };
