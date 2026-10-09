#!/usr/bin/env node
'use strict';

const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log('Usage: cli.js [name] [--help]');
  console.log('Prints a greeting for name (default: world).');
  process.exit(0);
}

const name = args.find((a) => !a.startsWith('--')) || 'world';
console.log(`Hello, ${name}!`);
