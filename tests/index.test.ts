import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../src/index.ts';

test('exports VERSION', () => {
  assert.equal(typeof VERSION, 'string');
});