import test from 'node:test';
import assert from 'node:assert/strict';

import provider from '../../providers/icims.mjs';

const primary = 'https://primary.icims.com/jobs';
const card = (id = 1) => `<li class="iCIMS_JobCardItem"><a href="/jobs/${id}/role/job"><h3>Role ${id}</h3></a></li>`;
const empty = '<html><body><ul class="iCIMS_JobsTable"></ul></body></html>';

function httpError(status) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  return error;
}

function entry(fallback_urls = []) {
  return { name: 'Acme', careers_url: primary, fallback_urls };
}

test('only first-page 404 tries validated, ordered, deduplicated fallback hosts', async () => {
  const calls = [];
  const notFound = httpError(404);
  const jobs = await provider.fetch(entry([
    'https://primary.icims.com/duplicate',
    'http://insecure.icims.com/jobs',
    'https://user@credentials.icims.com/jobs',
    'https://port.icims.com:8443/jobs',
    'https://icims.com/jobs',
    'https://fallback.icims.com/jobs',
    'https://evil.example/jobs',
    'https://last.icims.com/jobs',
  ]), {
    fetchText: async (url) => {
      const parsed = new URL(url);
      calls.push({ host: parsed.hostname, page: parsed.searchParams.get('pr') });
      if (parsed.hostname === 'primary.icims.com') throw notFound;
      if (parsed.hostname === 'fallback.icims.com' && parsed.searchParams.get('pr') === '0') return card(20);
      if (parsed.hostname === 'fallback.icims.com') return empty;
      throw new Error(`unexpected request to ${parsed.hostname}`);
    },
  });
  assert.deepEqual(calls, [
    { host: 'primary.icims.com', page: '0' },
    { host: 'fallback.icims.com', page: '0' },
    { host: 'fallback.icims.com', page: '1' },
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, 'https://fallback.icims.com/jobs/20/role/job');
  assert.equal(Object.hasOwn(notFound, 'firstPage'), false, 'errors are not mutated to track fallback eligibility');
});

test('primary throttle, timeout, resolver, and non-404 errors propagate without fallback', async (t) => {
  const failures = [httpError(429), Object.assign(new Error('timeout'), { name: 'AbortError', code: 'ETIMEDOUT' }),
    Object.assign(new Error('dns'), { code: 'ENOTFOUND' }), httpError(500)];
  for (const failure of failures) {
    await t.test(failure.code || failure.status, async () => {
      const calls = [];
      await assert.rejects(() => provider.fetch(entry(['https://fallback.icims.com/jobs']), {
        fetchText: async (url) => { calls.push(new URL(url).hostname); throw failure; },
      }), (error) => error === failure);
      assert.deepEqual(calls, ['primary.icims.com']);
    });
  }
});

test('a later-page 404 never triggers a host fallback', async () => {
  const calls = [];
  const failure = httpError(404);
  await assert.rejects(() => provider.fetch(entry(['https://fallback.icims.com/jobs']), {
    fetchText: async (url) => {
      const parsed = new URL(url);
      calls.push({ host: parsed.hostname, page: parsed.searchParams.get('pr') });
      if (parsed.searchParams.get('pr') === '0') return card(1);
      throw failure;
    },
    sleep: async () => {},
  }), (error) => error === failure);
  assert.deepEqual(calls, [
    { host: 'primary.icims.com', page: '0' },
    { host: 'primary.icims.com', page: '1' },
  ]);
});

test('fallback failures preserve their status and stop traversal after throttle, timeout, or DNS errors', async (t) => {
  const failures = [httpError(429), Object.assign(new Error('timeout'), { name: 'AbortError', code: 'ETIMEDOUT' }),
    Object.assign(new Error('dns'), { code: 'ENOTFOUND' }), httpError(500)];
  for (const failure of failures) {
    await t.test(failure.code || failure.status, async () => {
      const calls = [];
      await assert.rejects(() => provider.fetch(entry([
        'https://fallback.icims.com/jobs', 'https://last.icims.com/jobs',
      ]), {
        fetchText: async (url) => {
          const host = new URL(url).hostname;
          calls.push(host);
          if (host === 'primary.icims.com') throw httpError(404);
          throw failure;
        },
      }), (error) => error === failure);
      assert.deepEqual(calls, ['primary.icims.com', 'fallback.icims.com']);
    });
  }
});

test('404 fallback exhaustion rethrows the original first-page error', async () => {
  const original = httpError(404);
  const calls = [];
  await assert.rejects(() => provider.fetch(entry([
    'https://fallback.icims.com/jobs', 'https://last.icims.com/jobs',
  ]), {
    fetchText: async (url) => {
      calls.push(new URL(url).hostname);
      throw original;
    },
  }), (error) => error === original);
  assert.deepEqual(calls, ['primary.icims.com', 'fallback.icims.com', 'last.icims.com']);
  assert.equal(Object.hasOwn(original, 'firstPage'), false);
});
