'use strict';

const { cToF } = require('./units');

const LIMIT_F = 104;

function isTooHot(celsius) {
  return cToF(celsius) > LIMIT_F;
}

module.exports = { isTooHot };
