'use strict';

const path = require('path');

const DEV_TOKEN_FALLBACK = 'local-dev';

const token = process.env.DROP_TOKEN || DEV_TOKEN_FALLBACK;

const allowAnonymous = process.env.DROP_ALLOW_ANONYMOUS === 'true';

const uploadsDir = path.join(__dirname, '..', 'uploads');

module.exports = {
  token,
  allowAnonymous,
  uploadsDir,
};
