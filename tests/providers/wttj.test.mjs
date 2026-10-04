import test from 'node:test';
import assert from 'node:assert/strict';

import provider, {
  normalizeWttjHit,
  parseEnvPayload,
  resolveConfig,
} from '../../providers/wttj.mjs';

const APP_ID = 'TESTAPP123';
const API_KEY = '0123456789abcdef0123456789abcdef';
const INDEX = 'wttj_jobs_production_en';

function envText(overrides = {}) {
  return `window.env = ${JSON.stringify({
    PUBLIC_ALGOLIA_APPLICATION_ID: APP_ID,
    PUBLIC_ALGOLIA_API_KEY_CLIENT: API_KEY,
    PUBLIC_ALGOLIA_JOBS_INDEX: INDEX,
    ...overrides,
  })};`;
}

function hit(id, overrides = {}) {
  return {
    objectID: id,
    name: `Role ${id}`,
    slug: `role-${String(id).toLowerCase()}`,
    organization: { name: 'Acme', slug: 'acme' },
    offices: [{ city: 'Helsinki', country_code: 'FI' }],
    ...overrides,
  };
}

function context(search, opts = {}) {
  const calls = [];
  const ctx = {
    calls,
    fetchText: async (url, requestOptions) => {
      calls.push({ kind: 'env', url, opts: requestOptions });
      return opts.env ?? envText();
    },
    fetchJson: async (url, requestOptions) => {
      calls.push({ kind: 'search', url, opts: requestOptions });
      const params = new URLSearchParams(JSON.parse(requestOptions.body).params);
      const rows = await search(params.get('query'), Number(params.get('page')), params);
      return rows;
    },
  };
  return { ctx, calls, search };
}

test('WTTJ provider exposes explicit detection and strict query configuration', () => {
  assert.equal(provider.id, 'wttj');
  assert.deepEqual(provider.detect({ provider: 'wttj' }), { url: 'https://www.welcometothejungle.com' });
  assert.equal(provider.detect({ provider: 'other' }), null);
  assert.deepEqual(resolveConfig({ wttj: { queries: [' Data ', 'data', 'Python'] } }), {
    queries: ['Data', 'Python'], maxHits: 100, maxPages: 3, maxJobs: 1000,
  });
  assert.throws(() => resolveConfig({ provider: 'wttj', wttj: { queries: [] } }), /non-empty/);
  assert.throws(() => resolveConfig({ provider: 'wttj' }), /non-empty/);
});

test('runtime env parsing validates credentials, index, and drift', () => {
  assert.deepEqual(parseEnvPayload(envText()), {
    appId: APP_ID,
    apiKey: API_KEY,
    index: INDEX,
    host: 'TESTAPP123-dsn.algolia.net',
  });
  assert.equal(
    parseEnvPayload(envText({ PUBLIC_ALGOLIA_JOBS_INDEX: undefined })).index,
    'wttj_jobs_production_en',
  );
  assert.equal(
    parseEnvPayload(envText({ PUBLIC_ALGOLIA_JOBS_INDEX: 'wttj_jobs_staging' })).index,
    'wttj_jobs_staging',
  );
  assert.throws(() => parseEnvPayload(envText({ PUBLIC_ALGOLIA_API_KEY_CLIENT: '' })), /search key/);
  assert.throws(() => parseEnvPayload(envText({ PUBLIC_ALGOLIA_APPLICATION_ID: '' })), /application id/);
  assert.throws(() => parseEnvPayload(envText({ PUBLIC_ALGOLIA_JOBS_INDEX: '' })), /jobs index/);
  assert.throws(() => parseEnvPayload(envText({ PUBLIC_ALGOLIA_JOBS_INDEX: '../private' })), /jobs index/);
  assert.throws(() => parseEnvPayload(envText({ PUBLIC_ALGOLIA_HOST: 'evil.example' })), /untrusted Algolia host/);
  assert.throws(() => parseEnvPayload('window.env = {"PUBLIC_ALGOLIA_APPLICATION_ID":"broken"'), /incomplete/);
});

test('hit normalization maps canonical fields, salary, remote, date, and description', () => {
  const normalized = normalizeWttjHit(hit('42', {
    name: '  Data Engineer  ',
    remote: 'fulltime',
    published_at_timestamp: 1_759_000_000,
    salary_yearly_minimum: 60000,
    salary_yearly_maximum: 85000,
    salary_period: 'yearly',
    salary_currency: 'eur',
    descriptions: { en: '<p>Build &amp; ship</p>' },
  }));
  assert.deepEqual(normalized, {
    title: 'Data Engineer',
    url: 'https://www.welcometothejungle.com/en/companies/acme/jobs/role-42',
    company: 'Acme',
    location: 'Helsinki, FI, Remote',
    sourceId: '42',
    postedAt: 1_759_000_000_000,
    description: 'Build & ship',
    salary: { min: 60000, max: 85000, currency: 'EUR' },
  });
  assert.equal(normalizeWttjHit({ name: 'Bad', slug: '../escape', organization: { slug: 'acme' } }), null);
  assert.equal(normalizeWttjHit({ title: 'Alias only', slug: 'ok', organization: { slug: 'acme' } }), null);
  assert.equal(normalizeWttjHit({ name: 'Bad', slug: 'ok', organization: { slug: 'acme' } }).company, 'Welcome to the Jungle');
});

test('fetch performs bounded multi-query Algolia searches and preserves overlap provenance', async () => {
  const search = async (query, page) => {
    if (page > 0) return { hits: [], nbPages: 1 };
    return query === 'Data'
      ? { hits: [hit('shared', { name: 'Data Engineer' }), hit('data-only')], nbPages: 1 }
      : { hits: [hit('shared', { name: 'Data Engineer', description: '<p>Shared detail</p>' }), hit('python-only')], nbPages: 1 };
  };
  const { ctx, calls } = context(search);
  const jobs = await provider.fetch({
    name: 'WTTJ', provider: 'wttj', wttj: { queries: ['Data', 'Python'] },
  }, ctx);
  assert.equal(calls.filter(call => call.kind === 'env').length, 1);
  const searchCalls = calls.filter(call => call.kind === 'search');
  assert.equal(searchCalls.length, 2);
  assert.ok(searchCalls.every(call => call.opts.method === 'POST' && call.opts.redirect === 'error'));
  assert.ok(searchCalls.every(call => call.opts.headers.referer === 'https://www.welcometothejungle.com/'));
  const shared = jobs.find(job => job.sourceId === 'shared');
  assert.equal(jobs.length, 3);
  assert.deepEqual(shared?.sourceQueries, ['Data', 'Python']);
  assert.equal(shared?.sourceQuery, 'Data');
  assert.equal(shared?.sourceUrl, 'https://www.welcometothejungle.com/en/jobs?query=Data');
});

test('pagination honors entry/context caps and terminates repeated pages', async () => {
  const calls = [];
  const ctx = {
    maxPages: 2,
    fetchText: async () => envText(),
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      const params = new URLSearchParams(JSON.parse(opts.body).params);
      const page = Number(params.get('page'));
      return {
        hits: Array.from({ length: 200 }, (_, index) => hit(`${page === 0 ? 'first' : 'repeat'}-${index}`)),
        nbPages: 9,
      };
    },
  };
  const jobs = await provider.fetch({ provider: 'wttj', wttj: { queries: ['one'], max_hits: 400, max_pages: 20 } }, ctx);
  assert.equal(calls.length, 2);
  assert.equal(jobs.length, 400);
  assert.equal(jobs[0].sourceQuery, 'one');

  const repeatedCalls = [];
  const repeated = await provider.fetch({ provider: 'wttj', wttj: { queries: ['one'], max_hits: 400, max_pages: 10 } }, {
    fetchText: async () => envText(),
    fetchJson: async (url, opts) => {
      repeatedCalls.push(url);
      return { hits: Array.from({ length: 200 }, (_, index) => hit(`same-${index}`)), nbPages: 99 };
    },
  });
  assert.equal(repeatedCalls.length, 2);
  assert.equal(repeated.length, 200);
});

test('malformed and all-unusable responses fail closed while empty results remain healthy', async () => {
  const base = { provider: 'wttj', wttj: { queries: ['one'] } };
  const envOnly = { fetchText: async () => envText(), fetchJson: async () => ({ hits: [] }) };
  assert.deepEqual(await provider.fetch(base, envOnly), []);
  await assert.rejects(() => provider.fetch(base, {
    fetchText: async () => envText(), fetchJson: async () => ({ jobs: [] }),
  }), /expected .*hits/);
  await assert.rejects(() => provider.fetch(base, {
    fetchText: async () => envText(), fetchJson: async () => ({ hits: [{ name: 'Broken' }] }),
  }), /none structurally usable/);
});
