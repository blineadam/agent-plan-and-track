'use strict';

const REFRESH_MARGIN_MS = 60 * 1000;

let currentToken = null;
let currentExpiresAt = 0;

function fetchNewToken() {
  return {
    token: `tok_${Date.now()}`,
    expiresAt: Date.now() + 15 * 60 * 1000,
  };
}

function setToken(token, expiresAt) {
  currentToken = token;
  currentExpiresAt = expiresAt;
}

function isNearExpiry() {
  return Date.now() >= currentExpiresAt - REFRESH_MARGIN_MS;
}

function getToken() {
  if (!currentToken || isNearExpiry()) {
    const fresh = fetchNewToken();
    setToken(fresh.token, fresh.expiresAt);
  }
  return currentToken;
}

module.exports = { getToken, setToken };
