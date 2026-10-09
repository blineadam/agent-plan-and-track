'use strict';
function logError(where, err) { process.stderr.write(JSON.stringify({ level: 'error', where, msg: err.message }) + '\n'); }
module.exports = { logError };
