'use strict';

const { leftPad } = require('../lib/strings');

// Right-aligns each cell to its column width.
function row(cells, widths) {
  return cells.map((cell, i) => leftPad(cell, widths[i])).join(' | ');
}

module.exports = { row };
