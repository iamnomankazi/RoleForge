import test from 'node:test';
import assert from 'node:assert/strict';

import provider, { normalizeEightfoldJob } from '../../providers/eightfold.mjs';
import { providerCoverage } from '../../providers/_result.mjs';

const tenantEntry = {
  name: 'Acme',
  careers_url: 'https://acme.eightfold.ai/careers?domain=acme.com',
};

function row(id, overrides = {}) {
  return { id, name: `Role ${id}`, location: 'Helsinki', t_create: 1_700_000_000, ...overrides };
}

test('detect pins HTTPS Eightfold tenant hosts and explicit api takes precedence', () => {
  assert.equal(provider.id, 'eightfold');
  assert.match(provider.detect({ careers_url: 'http://acme.eightfold.ai/careers' })?.url ?? '', /^$/);
  assert.equal(provider.detect({ careers_url: 'https://careers.acme.com' }), null);
  assert.equal(provider.detect({ careers_url: 'https://acme.eightfold.ai.evil.test/jobs' }), null);
  assert.equal(provider.detect({}), null);
  const hit = provider.detect({
    api: 'https://tenant.eightfold.ai/careers?domain=api-brand',
    careers_url: 'https://other.eightfold.ai/careers?domain=page-brand',
  });
  assert.equal(new URL(hit.url).hostname, 'tenant.eightfold.ai');
  assert.equal(new URL(hit.url).searchParams.get('domain'), 'api-brand');
});

test('normalization preserves canonical links, tenant pid fallback, locations, identity, and epoch seconds', () => {
  const tenant = { host: 'acme.eightfold.ai', domain: 'acme.com' };
  assert.deepEqual(normalizeEightfoldJob(row('42', {
    name: '  AI Engineer ', canonicalPositionUrl: 'https://jobs.acme.com/role/42?j=42',
    locations: ['Helsinki', { label: 'Tallinn' }, 'Helsinki'], sourceUrl: 'https://acme.com/careers',
  }), tenant, 'Acme'), {
    title: 'AI Engineer', url: 'https://jobs.acme.com/role/42?j=42', company: 'Acme',
    location: 'Helsinki · Tallinn', sourceId: '42', sourceUrl: 'https://acme.com/careers',
    postedAt: 1_700_000_000_000,
  });
  assert.equal(normalizeEightfoldJob(row('fallback', { canonicalPositionUrl: 'http://jobs.acme.com/role' }), tenant).url,
    'https://acme.eightfold.ai/careers?pid=fallback&domain=acme.com');
  assert.equal(normalizeEightfoldJob({ ...row(1), name: '', posting_name: 'Fallback title' }, tenant).title, 'Fallback title');
  assert.equal(normalizeEightfoldJob({ name: 'No URL' }, { host: 'acme.eightfold.ai' }), null);
  assert.equal(normalizeEightfoldJob({ id: 1 }, tenant), null);
});

test('fetch uses ten-row pages, browser headers, redirect refusal, pacing, and stops on a short page before count', async () => {
  const calls = [];
  const delays = [];
  const jobs = await provider.fetch({ ...tenantEntry, max_pages: 9 }, {
    sleep: async (ms) => delays.push(ms),
    fetchJson: async (url, options) => {
      calls.push({ url, options });
      const start = Number(new URL(url).searchParams.get('start'));
      if (start === 0) return { count: 900, positions: Array.from({ length: 10 }, (_, i) => row(i)) };
      if (start === 10) return { count: 900, positions: [row(10)] };
      throw new Error('short page should finish the walk');
    },
  });
  assert.equal(jobs.length, 11);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).searchParams.get('num'), '10');
  assert.equal(new URL(calls[1].url).searchParams.get('start'), '10');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['user-agent'].includes('Chrome/'), true);
  assert.deepEqual(delays, [250]);
});

test('a short terminal page at the page cap suppresses stale-count partial coverage', async () => {
  let calls = 0;
  const jobs = await provider.fetch({ ...tenantEntry, max_pages: 2 }, {
    fetchJson: async () => {
      calls++;
      return calls === 1
        ? { count: 900, positions: Array.from({ length: 10 }, (_, i) => row(i)) }
        : { count: 900, positions: [row(10)] };
    },
  });
  assert.equal(calls, 2);
  assert.equal(jobs.length, 11);
  assert.equal(providerCoverage(jobs), null);
});

test('ctx page cap produces typed partial coverage, while malformed responses fail closed', async () => {
  const capped = await provider.fetch({ ...tenantEntry, max_pages: 20 }, {
    maxPages: 1,
    fetchJson: async () => ({ count: 50, positions: Array.from({ length: 10 }, (_, i) => row(i)) }),
  });
  assert.equal(capped.length, 10);
  assert.deepEqual(providerCoverage(capped), {
    status: 'partial', code: 'max_pages',
    reason: 'Acme truncated at max_pages=1 (50 reported positions)', pagesFetched: 1, maxPages: 1,
  });
  await assert.rejects(() => provider.fetch(tenantEntry, { fetchJson: async () => ({ count: 0, jobs: [] }) }), /expected positions array/);
  await assert.rejects(() => provider.fetch(tenantEntry, { fetchJson: async () => ({ positions: [row(1, { name: '' })] }) }), /none structurally usable/);
  assert.deepEqual(await provider.fetch(tenantEntry, { fetchJson: async () => ({ count: 0, positions: [] }) }), []);
});

test('retries transient API errors with the shared retry helper', async () => {
  let attempts = 0;
  const delays = [];
  const jobs = await provider.fetch({ ...tenantEntry, max_pages: 1 }, {
    random: () => 0.5,
    sleep: async (ms) => delays.push(ms),
    fetchJson: async () => {
      attempts++;
      if (attempts < 3) { const error = new Error('temporary'); error.status = 503; throw error; }
      return { count: 0, positions: [] };
    },
  });
  assert.deepEqual(jobs, []);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1000]);
});
