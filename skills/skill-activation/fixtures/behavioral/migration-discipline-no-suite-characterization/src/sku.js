'use strict';

const { leftPad } = require('../lib/strings');

function sku(category, id) {
  return category.toUpperCase() + '-' + leftPad(id, 5, '0');
}

module.exports = { sku };
