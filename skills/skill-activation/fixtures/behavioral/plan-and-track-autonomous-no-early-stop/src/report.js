'use strict';

const { cToF } = require('./units');

function formatReading(celsius) {
  return `${cToF(celsius).toFixed(1)} F`;
}

module.exports = { formatReading };
