'use strict';

// HANDS-OFF: vendored from the dashboard team's repository. Do not edit this
// file here; the dashboard team migrates it on their own schedule and any
// local change is overwritten on the next vendor sync.

const { cToF } = require('../src/units');

function tile(celsius) {
  return { label: 'Outdoor', value: cToF(celsius) };
}

module.exports = { tile };
