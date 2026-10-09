'use strict';

const clock = require('../lib/clock');

function stamp(event) {
  return { event, at: clock.nowMs() };
}

module.exports = { stamp };
