'use strict';

function slugify(title, options = {}) {
  const separator = options.separator ?? '-';
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(separator);
}

module.exports = { slugify };
