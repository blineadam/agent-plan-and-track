'use strict';

const { leftPad } = require('../lib/strings');

function invoiceNumber(n) {
  return 'INV-' + leftPad(n, 6, '0');
}

module.exports = { invoiceNumber };
