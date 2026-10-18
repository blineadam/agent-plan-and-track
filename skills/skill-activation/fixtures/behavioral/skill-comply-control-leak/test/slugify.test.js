'use strict';

const assert = require('node:assert');
const test = require('node:test');
const { slugify } = require('../src/slugify');

test('lowercases and joins words', () => {
  assert.strictEqual(slugify('Hello World'), 'hello-world');
});

test('transliterates accents', () => {
  assert.strictEqual(slugify('Crème Brûlée'), 'creme-brulee');
});

test('honors a custom separator and trims it', () => {
  assert.strictEqual(slugify('  a b  ', { separator: '_' }), 'a_b');
});
