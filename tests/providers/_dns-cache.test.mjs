import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKED_ADDRESS_CODE, withProviderIpGuard } from '../../providers/_ip-guard.mjs';
import { createCachedLookup, isResolverFailure, RESOLVER_FAILURE_CODES } from '../../providers/_dns-cache.mjs';

function lookupOnce(lookup, hostname, options = {}) {
  return new Promise((resolve) => lookup(hostname, options, (error, ...rest) => resolve({ error, rest })));
}

test('cached lookup preserves option and callback shapes, TTLs, dedupe, and symbols', async () => {
  let calls = 0;
  let now = 1_000;
  let pending;
  let receivedOptions;
  const marker = Symbol('lookup marker');
  const realLookup = (_hostname, options, callback) => {
    calls++;
    receivedOptions = options;
    pending = callback;
  };
  realLookup[marker] = 'kept';
  const lookup = createCachedLookup(realLookup, { ttlMs: 100, now: () => now });

  const first = lookupOnce(lookup, 'public.example', 4);
  const second = lookupOnce(lookup, 'public.example', { family: 4 });
  assert.equal(calls, 1);
  assert.deepEqual(receivedOptions, { family: 4 });
  pending(null, '8.8.8.8', 4);
  assert.deepEqual((await first).rest, ['8.8.8.8', 4]);
  assert.deepEqual((await second).rest, ['8.8.8.8', 4]);
  assert.equal(lookup[marker], 'kept');

  assert.deepEqual((await lookupOnce(lookup, 'public.example', { family: 4 })).rest, ['8.8.8.8', 4]);
  assert.equal(calls, 1);
  now += 101;
  const expired = lookupOnce(lookup, 'public.example', { family: 4 });
  assert.equal(calls, 2);
  pending(null, '1.1.1.1', 4);
  assert.deepEqual((await expired).rest, ['1.1.1.1', 4]);
});

test('cached lookup preserves callback shorthand and max-entry eviction', async () => {
  let calls = 0;
  const seenOptions = [];
  const lookup = createCachedLookup((hostname, options, callback) => {
    calls++;
    seenOptions.push(options);
    callback(null, hostname === 'one.example' ? '1.1.1.1' : '8.8.8.8', 4);
  }, { maxEntries: 1 });

  const shorthand = await new Promise((resolve) => lookup('one.example', (error, address, family) => {
    resolve({ error, address, family });
  }));
  assert.deepEqual(shorthand, { error: null, address: '1.1.1.1', family: 4 });
  assert.deepEqual(seenOptions[0], {});
  await lookupOnce(lookup, 'two.example');
  await lookupOnce(lookup, 'one.example');
  assert.equal(calls, 3, 'the oldest entry is evicted at maxEntries');
});

test('cached lookup supports all:true and blocks any non-public answer for providers', async () => {
  const lookup = createCachedLookup((_hostname, _options, callback) => callback(null, [
    { address: '8.8.8.8', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ]));
  const result = await withProviderIpGuard(() => lookupOnce(lookup, 'mixed.example', { all: true }));
  assert.equal(result.error?.code, BLOCKED_ADDRESS_CODE);
  assert.equal(result.error?.hostname, 'mixed.example');
  assert.equal(result.error?.address, '169.254.169.254');
});

test('provider guard validates cached outside-context answers without breaking outside loopback use', async () => {
  let calls = 0;
  const lookup = createCachedLookup((_hostname, _options, callback) => {
    calls++;
    callback(null, '127.0.0.1', 4);
  });

  const outside = await lookupOnce(lookup, 'local.test');
  assert.equal(outside.error, null);
  assert.deepEqual(outside.rest, ['127.0.0.1', 4]);

  const guarded = await withProviderIpGuard(() => lookupOnce(lookup, 'local.test'));
  assert.equal(guarded.error?.code, BLOCKED_ADDRESS_CODE);
  assert.equal(calls, 1, 'provider validation must also apply to a result cached outside the guard');

  const outsideAgain = await lookupOnce(lookup, 'local.test');
  assert.equal(outsideAgain.error, null);
  assert.equal(calls, 1);
});

test('blocked provider answers are not cached and are not resolver outages', async () => {
  let calls = 0;
  const lookup = createCachedLookup((_hostname, _options, callback) => {
    calls++;
    callback(null, '10.0.0.7', 4);
  });
  const first = await withProviderIpGuard(() => lookupOnce(lookup, 'private.example'));
  const second = await withProviderIpGuard(() => lookupOnce(lookup, 'private.example'));
  assert.equal(first.error?.code, BLOCKED_ADDRESS_CODE);
  assert.equal(second.error?.code, BLOCKED_ADDRESS_CODE);
  assert.equal(calls, 2);
  assert.equal(RESOLVER_FAILURE_CODES.has(BLOCKED_ADDRESS_CODE), false);
  assert.equal(isResolverFailure(first.error), false);
});

test('resolver failures retain negative caching while other errors are not cached', async () => {
  let calls = 0;
  let now = 0;
  const failures = [
    Object.assign(new Error('resolver refused'), { code: 'EREFUSED' }),
    Object.assign(new Error('blocked'), { code: BLOCKED_ADDRESS_CODE }),
  ];
  const lookup = createCachedLookup((_hostname, _options, callback) => callback(failures[Math.min(calls++, failures.length - 1)]), {
    negativeTtlMs: 50,
    now: () => now,
  });
  assert.equal((await lookupOnce(lookup, 'failure.example')).error.code, 'EREFUSED');
  assert.equal((await lookupOnce(lookup, 'failure.example')).error.code, 'EREFUSED');
  assert.equal(calls, 1);
  now = 51;
  assert.equal((await lookupOnce(lookup, 'failure.example')).error.code, BLOCKED_ADDRESS_CODE);
  assert.equal((await lookupOnce(lookup, 'failure.example')).error.code, BLOCKED_ADDRESS_CODE);
  assert.equal(calls, 3);
});

test('lookup-time validation closes a changed DNS answer', async () => {
  let calls = 0;
  const lookup = createCachedLookup((_hostname, _options, callback) => {
    callback(null, calls++ === 0 ? '8.8.8.8' : '127.0.0.1', 4);
  }, { ttlMs: 0 });
  const first = await withProviderIpGuard(() => lookupOnce(lookup, 'rebinding.example'));
  const rebound = await withProviderIpGuard(() => lookupOnce(lookup, 'rebinding.example'));
  assert.equal(first.error, null);
  assert.equal(rebound.error?.code, BLOCKED_ADDRESS_CODE);
});
