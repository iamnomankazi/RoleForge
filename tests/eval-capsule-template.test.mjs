import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const template = readFileSync(resolve(import.meta.dirname, '..', 'batch', 'eval-capsule.template.md'), 'utf8');

test('evaluation capsule takes eval-queue include entries only', () => {
  assert.match(template, /built from `eval-queue\.mjs` `include` entries only/);
  assert.match(template, /Never add `needs_liveness` entries/);
});

test('evaluation capsule gates every offer on active liveness before evaluating it', () => {
  assert.match(template, /Liveness gate \(check first, for every offer\): evaluate only offers whose input `liveness\.status` is\s+`active`/);
  assert.match(template, /not evaluated: liveness not confirmed/);
  assert.doesNotMatch(template, /else `unconfirmed`/);
});
