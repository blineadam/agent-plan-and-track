const http = require('http');

const items = [{ id: 1, name: 'widget' }, { id: 2, name: 'gadget' }];

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && req.url === '/api/items') return send(res, 200, items);
  if (req.method === 'POST' && req.url === '/api/login') return send(res, 200, { token: 'demo' });
  return send(res, 404, { error: 'not found' });
});

if (require.main === module) server.listen(process.env.PORT || 3000);
module.exports = server;
