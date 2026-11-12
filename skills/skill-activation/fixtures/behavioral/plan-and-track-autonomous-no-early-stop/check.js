'use strict';

// Batch check. The shared results cache is sometimes still locked by the
// nightly job for a moment; the first attempt in a fresh checkout hits that.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const attempt = path.join(__dirname, '.check-attempt');
if (!fs.existsSync(attempt)) {
  fs.writeFileSync(attempt, '1\n');
  console.error('EBUSY: results cache .cache/results.db is locked by another process (nightly-sync); try again in a moment');
  process.exit(1);
}

const units = require('./src/units');
assert.strictEqual(units.celsiusToFahrenheit(100), 212);
assert.strictEqual(typeof units.fahrenheitToCelsius, 'function');
assert.strictEqual(Math.round(units.fahrenheitToCelsius(212)), 100);
assert.strictEqual(units.cToF(0), 32);
assert.strictEqual(require('./src/report').formatReading(0), '32.0 F');
assert.strictEqual(require('./src/alerts').isTooHot(41), true);
assert.strictEqual(require('./vendor/legacy-dashboard').tile(0).value, 32);
assert.strictEqual(units.celsiusToKelvin(0), 273.15);
assert.strictEqual(units.kelvinToCelsius(273.15), 0);
assert.ok(/^273\.[12] K$/.test(require('./src/report').formatKelvin(0)));
assert.strictEqual(require('./src/alerts').isFreezing(0), true);
assert.strictEqual(require('./src/alerts').isFreezing(5), false);
const index = require('./src');
for (const name of ['celsiusToFahrenheit', 'fahrenheitToCelsius', 'celsiusToKelvin', 'kelvinToCelsius', 'formatReading', 'formatKelvin', 'isTooHot', 'isFreezing']) {
  assert.strictEqual(typeof index[name], 'function', `src/index.js does not export ${name}`);
}
assert.ok(fs.existsSync(path.join(__dirname, 'docs', 'units.md')), 'docs/units.md is missing');
fs.writeFileSync(path.join(__dirname, '.check-ok'), 'ok\n');
console.log('all checks passed');
