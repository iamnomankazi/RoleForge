import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, parseArgs, runSeedScan } from '../scan-ats-full.mjs';
import { SEED_SOURCES } from '../seeds/vc-portfolios.mjs';

const entry = SOURCES.lever.toEntry('example-eu');
const euPosting = {
  text: 'Backend Engineer',
  hostedUrl: 'https://jobs.eu.lever.co/example-eu/123',
  categories: { location: 'Helsinki, Finland' },
  createdAt: 1791504000000,
};

test('reverse Lever scan retries a global 404 once on the EU host and preserves EU URLs', async () => {
  const calls = [];
  const rows = await SOURCES.lever.provider.fetch(entry, {
    async fetchJson(url, options) {
      calls.push(url);
      assert.equal(options.redirect, 'error');
      if (url === 'https://api.lever.co/v0/postings/example-eu') {
        throw Object.assign(new Error('HTTP 404'), { status: 404 });
      }
      assert.equal(url, 'https://api.eu.lever.co/v0/postings/example-eu');
      return [euPosting];
    },
  });
  assert.deepEqual(calls, [
    'https://api.lever.co/v0/postings/example-eu',
    'https://api.eu.lever.co/v0/postings/example-eu',
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, euPosting.hostedUrl);
  assert.equal(rows[0].company, 'example-eu');
  assert.equal(rows[0].location, 'Helsinki, Finland');
  assert.equal(entry.careers_url, 'https://jobs.lever.co/example-eu');
});

test('reverse Lever scan stops after the EU retry fails', async () => {
  const calls = [];
  const euError = Object.assign(new Error('EU HTTP 404'), { status: 404 });
  await assert.rejects(SOURCES.lever.provider.fetch(entry, {
    async fetchJson(url) {
      calls.push(url);
      throw calls.length === 1
        ? Object.assign(new Error('Global HTTP 404'), { status: 404 })
        : euError;
    },
  }), error => error === euError);
  assert.equal(calls.length, 2);
});

test('reverse Lever scan does not retry a successful global response, including an empty board', async () => {
  for (const payload of [[], [{ ...euPosting, hostedUrl: 'https://jobs.lever.co/example-eu/123' }]]) {
    const calls = [];
    const rows = await SOURCES.lever.provider.fetch(entry, {
      async fetchJson(url) { calls.push(url); return payload; },
    });
    assert.deepEqual(calls, ['https://api.lever.co/v0/postings/example-eu']);
    assert.equal(rows.length, payload.length);
    if (rows.length) assert.equal(rows[0].url, payload[0].hostedUrl);
  }
});

test('reverse Lever scan retries only a global HTTP 404', async () => {
  const cases = [
    { entry, status: 405 },
    { entry, status: 429 },
    { entry, status: 500 },
    { entry, status: undefined },
    { entry: { ...entry, careers_url: 'https://jobs.eu.lever.co/example-eu' }, status: 404 },
  ];
  for (const scenario of cases) {
    let calls = 0;
    const error = Object.assign(new Error('fetch failed'), { status: scenario.status });
    await assert.rejects(SOURCES.lever.provider.fetch(scenario.entry, {
      async fetchJson() { calls++; throw error; },
    }), actual => actual === error);
    assert.equal(calls, 1);
  }
});

test('reverse ATS defaults exclude iCIMS while --ats icims explicitly opts in', () => {
  const argv = ['node', 'scan-ats-full.mjs', '--run-id', 'example-run'];
  assert.deepEqual(parseArgs(argv).ats, ['greenhouse', 'lever', 'ashby', 'workday']);
  assert.deepEqual(parseArgs([...argv, '--ats', 'icims']).ats, ['icims']);
  assert.deepEqual(parseArgs([...argv, '--ats=lever,icims']).ats, ['lever', 'icims']);
  assert.deepEqual(parseArgs([...argv, '--seeds', 'yc']).ats, []);
});

test('reverse seed scans skip iCIMS unless it is explicitly selected', async (t) => {
  t.mock.method(SEED_SOURCES.yc, 'fetch', async () => [
    { name: 'Example Company', url: 'https://careers-example.icims.com' },
  ]);
  const opts = { limit: Infinity, sinceDays: 3, titleFilter: () => true, locationFilter: () => true };
  let requests = 0;
  const ctx = {
    async fetchText() {
      requests++;
      throw Object.assign(new Error('HTTP 405'), { status: 405 });
    },
  };
  const defaultRun = await runSeedScan('yc', opts, ctx, new Set(), 'Example');
  assert.equal(defaultRun.attempted, 0);
  assert.equal(requests, 0);
  const optInRun = await runSeedScan('yc', { ...opts, ats: ['icims'] }, ctx, new Set(), 'Example');
  assert.equal(optInRun.attempted, 1);
  assert.equal(optInRun.errors, 1);
  assert.equal(requests, 1);
});
