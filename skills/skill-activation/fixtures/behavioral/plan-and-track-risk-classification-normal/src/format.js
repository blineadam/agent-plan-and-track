'use strict';

// Wraps a single line of plain text so no printed line exceeds 80
// characters, breaking only at whitespace.

const MAX_LINE_WIDTH = 79;

function wrapLine(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    // Stay under the 79-character limit before starting a new line.
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > MAX_LINE_WIDTH) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

module.exports = { wrapLine, MAX_LINE_WIDTH };
