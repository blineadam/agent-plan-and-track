'use strict';

const fs = require('fs');

function parseArgs(argv) {
  const args = argv.slice(2);
  const legacyIndex = args.indexOf('--legacy-mode');
  if (legacyIndex !== -1) {
    args.splice(legacyIndex, 1);
  }
  const [pattern, file] = args;
  return { pattern, file };
}

function countMatches(pattern, file) {
  const contents = fs.readFileSync(file, 'utf8');
  const lines = contents.split('\n');
  return lines.filter((line) => line.includes(pattern)).length;
}

function main() {
  const { pattern, file } = parseArgs(process.argv);
  if (!pattern || !file) {
    process.stderr.write('usage: cli.js <pattern> <file>\n');
    process.exit(1);
  }
  const count = countMatches(pattern, file);
  console.log(count);
}

main();
