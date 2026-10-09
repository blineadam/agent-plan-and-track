'use strict';

let source = () => Date.now();

function setSource(fn) {
  source = fn;
}

// Current time in milliseconds since the epoch.
function now() {
  return source();
}

// Deprecated: use now().
function nowMs() {
  return now();
}

module.exports = { now, nowMs, setSource };
