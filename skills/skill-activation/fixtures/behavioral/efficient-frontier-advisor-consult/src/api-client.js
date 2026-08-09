'use strict';

const https = require('https');
const { getToken } = require('./session');

function requestOnce(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'internal-api.example.com',
        path,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        resolve(res.statusCode);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function callApi(path) {
  let token = getToken();
  let statusCode = await requestOnce(path, token);
  if (statusCode === 401) {
    token = getToken();
    statusCode = await requestOnce(path, token);
  }
  return statusCode;
}

module.exports = { callApi };
