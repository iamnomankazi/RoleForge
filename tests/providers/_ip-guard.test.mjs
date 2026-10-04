import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKED_ADDRESS_CODE,
  assertPublicIpAddress,
  getProviderIpGuardContext,
  isPublicIpAddress,
  validateLookupResult,
  withProviderIpGuard,
} from '../../providers/_ip-guard.mjs';

test('IP guard accepts representative public IPv4 and IPv6 addresses', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPublicIpAddress(address), true, address);
  }
});

test('IP guard rejects IPv4 private, loopback, link-local, documentation, multicast, and reserved ranges', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1',
    '198.51.100.2', '203.0.113.3', '224.0.0.1', '240.0.0.1', '255.255.255.255',
  ]) assert.equal(isPublicIpAddress(address), false, address);
});

test('IP guard rejects IPv6 non-public ranges and mapped private IPv4', () => {
  for (const address of [
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1',
    '2001:db8::1', '2001:2::1', '2002:7f00:1::', '::127.0.0.1',
    '::ffff:127.0.0.1', '0:0:0:0:0:ffff:a9fe:a9fe', '64:ff9b::7f00:1',
  ]) assert.equal(isPublicIpAddress(address), false, address);
});

test('IP guard fails closed with a stable security error and metadata', () => {
  for (const address of ['', 'not-an-ip', null, undefined]) {
    assert.throws(
      () => assertPublicIpAddress(address, { hostname: 'tenant.example', context: { requestUrl: 'https://tenant.example/jobs' } }),
      (error) => error.code === BLOCKED_ADDRESS_CODE
        && error.hostname === 'tenant.example'
        && error.requestUrl === 'https://tenant.example/jobs',
    );
  }
});

test('provider guard context survives asynchronous work and validates all lookup shapes', async () => {
  assert.equal(getProviderIpGuardContext(), null);
  await withProviderIpGuard(async () => {
    await Promise.resolve();
    assert.equal(getProviderIpGuardContext()?.providerHttp, true);
    assert.doesNotThrow(() => validateLookupResult('public.example', ['8.8.8.8', 4]));
    assert.throws(
      () => validateLookupResult('mixed.example', [[{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]]),
      (error) => error.code === BLOCKED_ADDRESS_CODE && error.address === '127.0.0.1',
    );
    assert.throws(() => validateLookupResult('empty.example', [[]]), { code: BLOCKED_ADDRESS_CODE });
  });
  assert.equal(getProviderIpGuardContext(), null);
});
