'use strict';

// Deprecated: use String.prototype.padStart.
function leftPad(value, width, ch) {
  const s = String(value);
  const fill = ch === undefined ? ' ' : String(ch);
  if (s.length >= width) return s;
  return fill.repeat(width - s.length) + s;
}

module.exports = { leftPad };
