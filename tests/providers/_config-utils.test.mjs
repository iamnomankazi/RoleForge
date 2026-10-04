import test from 'node:test';
import assert from 'node:assert/strict';
import { intInRange } from '../../providers/_config-utils.mjs';

test('intInRange coerces, truncates, and clamps finite values', () => {
  assert.equal(intInRange('7.9', 3, 1, 10), 7);
  assert.equal(intInRange(-2.9, 3, -10, 10), -2);
  assert.equal(intInRange('99', 3, 1, 10), 10);
  assert.equal(intInRange('-99', 3, 1, 10), 1);
  assert.equal(intInRange('', 3, 1, 10), 1);
});

test('intInRange falls back for non-finite values', () => {
  for (const value of [undefined, 'not-a-number', Infinity, -Infinity, NaN]) {
    assert.equal(intInRange(value, 4, 1, 10), 4);
  }
});
