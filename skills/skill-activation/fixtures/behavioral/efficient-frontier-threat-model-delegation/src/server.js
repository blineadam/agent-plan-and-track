'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');

const config = require('./config');

function checkAuth(req) {
  if (config.allowAnonymous) {
    return true;
  }
  const header = req.headers['authorization'] || '';
  const [scheme, value] = header.split(' ');
  return scheme === 'Bearer' && value === config.token;
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function handleUpload(req, res, url) {
  const filename = url.searchParams.get('filename');
  if (!filename) {
    return sendJson(res, 400, { error: 'filename query param required' });
  }
  const targetPath = path.join(config.uploadsDir, filename);
  readBody(req).then((body) => {
    fs.writeFile(targetPath, body, (err) => {
      if (err) {
        return sendJson(res, 500, { error: 'write failed' });
      }
      sendJson(res, 200, { stored: filename });
    });
  });
}

function handleFiles(req, res, url) {
  const relPath = url.searchParams.get('path');
  if (!relPath) {
    return sendJson(res, 400, { error: 'path query param required' });
  }
  const targetPath = path.join(config.uploadsDir, relPath);
  fs.readFile(targetPath, (err, data) => {
    if (err) {
      return sendJson(res, 404, { error: 'not found' });
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(data);
  });
}

function handleConvert(req, res) {
  readBody(req).then((body) => {
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch (err) {
      return sendJson(res, 400, { error: 'invalid json body' });
    }
    const format = payload.format;
    if (!format) {
      return sendJson(res, 400, { error: 'format required' });
    }
    const child = spawn('convert-tool', ['--to', format, '--source', payload.filename || '']);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      sendJson(res, code === 0 ? 200 : 500, { code, output });
    });
    child.on('error', () => {
      sendJson(res, 500, { error: 'spawn failed' });
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (!checkAuth(req)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'POST' && url.pathname === '/upload') {
    return handleUpload(req, res, url);
  }
  if (req.method === 'GET' && url.pathname === '/files') {
    return handleFiles(req, res, url);
  }
  if (req.method === 'POST' && url.pathname === '/convert') {
    return handleConvert(req, res);
  }

  sendJson(res, 404, { error: 'not found' });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`drop-service listening on ${port}`);
});

module.exports = server;
