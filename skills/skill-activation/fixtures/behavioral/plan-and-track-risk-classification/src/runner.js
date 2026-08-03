'use strict';

// Spawns a single child process and forwards its exit behavior.

const { spawn } = require('child_process');

function runChild(command, args) {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : code;
  });
  return child;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    process.stderr.write('usage: runner.js <command> [args...]\n');
    process.exit(1);
  }
  runChild(command, args);
}

main();

module.exports = { runChild };
