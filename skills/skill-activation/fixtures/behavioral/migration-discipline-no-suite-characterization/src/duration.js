'use strict';

const { leftPad } = require('../lib/strings');

// Formats a minute count as H:MM, e.g. 75 -> "1:15".
function formatMinutes(total) {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return hours + ':' + leftPad(minutes, 2, 0);
}

module.exports = { formatMinutes };
