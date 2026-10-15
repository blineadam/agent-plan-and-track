'use strict';
const http = require('node:http');
const { getInvoice } = require('./src/billing');
const { warmCache } = require('./src/cache');

const port = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const match = req.url.match(/^\/invoices\/([\w-]+)$/);
  if (req.method !== 'GET' || !match) {
    res.writeHead(404);
    return res.end();
  }
  try {
    const body = await getInvoice(match[1]);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  } catch (err) {
    console.error('invoice_request_failed', { invoice_id: match[1], error: err.message });
    res.writeHead(502);
    res.end();
  }
});

warmCache().catch((err) => console.error('cache_warm_failed', { error: err.message }));
server.listen(port, () => console.log('server_started', { port }));
