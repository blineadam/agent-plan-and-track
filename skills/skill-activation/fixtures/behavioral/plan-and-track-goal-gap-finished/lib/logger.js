function log(msg) {
  console.log(msg);
}

/** @deprecated Use log instead. */
function oldLog(msg) {
  console.log(msg);
}

module.exports = { log, oldLog };
