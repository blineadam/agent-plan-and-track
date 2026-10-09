'use strict';

const { leftPad } = require('../lib/strings');

function line(label, cents) {
  return label + leftPad((cents / 100).toFixed(2), 10);
}

module.exports = { line };
