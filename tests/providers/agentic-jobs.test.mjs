import assert from 'node:assert/strict';
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

console.log('\nProvider - agentic-jobs');

try {
  const {
    default: provider, countryName, stripHtml, normalizeAgenticLocation,
    normalizeAgenticSalary, normalizeAgenticJob,
  } = await import(pathToFileURL(join(ROOT, 'providers/agentic-jobs.mjs')).href);
  const { providerCoverage } = await import(pathToFileURL(join(ROOT, 'providers/_result.mjs')).href);

  assert.equal(provider.id, 'agentic-jobs');
  assert.ok(provider.detect({ provider: 'agentic-jobs' }));
  assert.equal(provider.detect({ provider: 'other' }), null);
  assert.equal(countryName('FI'), 'Finland');
  assert.equal(countryName('../'), '');
  pass('id, explicit detection, and ISO-country handling are correct');

  assert.equal(stripHtml('<p>Build &amp; ship</p><script>bad()</script>'), 'Build & ship');
  assert.equal(normalizeAgenticLocation({ countries: ['FI', 'DE'] }), 'Finland / Germany');
  assert.deepEqual(normalizeAgenticSalary({ salaryMin: 50000, salaryMax: 70000, salaryCurrency: 'eur' }), {
    min: 50000, max: 70000, currency: 'EUR',
  });
  const normalized = normalizeAgenticJob({
    title: 'AI Engineer', companyName: 'Acme', slug: 'ai-engineer', location: 'Remote (EU)',
    description: '<p>Python &amp; agents</p>', postedAt: '2026-07-02T00:00:00Z',
    salaryMin: 50000, salaryCurrency: 'eur',
  });
  assert.equal(normalized.url, 'https://agentic-engineering-jobs.com/jobs/ai-engineer');
  assert.equal(normalized.description, 'Python & agents');
  assert.equal(normalized.postedAt, Date.parse('2026-07-02T00:00:00Z'));
  assert.equal(normalizeAgenticJob({ title: 'Bad', companyName: 'Acme', slug: '../escape' }), null);
  pass('description, location, salary, date, and safe-slug normalization work');

  const row = (slug) => ({ title: `Role ${slug}`, companyName: 'Acme', slug, location: 'Europe' });
  const calls = [];
  const sleeps = [];
  const jobs = await provider.fetch({ max_pages: 4 }, {
    sleep: async (ms) => { sleeps.push(ms); },
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      const page = Number(new URL(url).searchParams.get('page'));
      return page === 1
        ? { data: Array.from({ length: 50 }, (_, index) => row(String(index))), meta: { total: 51, per_page: 50 } }
        : { data: [row('49'), row('50')], meta: { total: 51, per_page: 50 } };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(jobs.length, 51);
  assert.deepEqual(sleeps, [2100]);
  assert.equal(providerCoverage(jobs), null);
  assert.ok(calls.every(({ opts }) => opts.redirect === 'error'));
  pass('pagination, rate-limit hook, redirect protection, and dedup work');

  const cappedCalls = [];
  const capped = await provider.fetch({ max_pages: 10 }, {
    maxPages: 1,
    fetchJson: async (url) => {
      cappedCalls.push(url);
      return { data: Array.from({ length: 50 }, (_, index) => row(String(index))), meta: { total: 500, per_page: 50 } };
    },
  });
  assert.equal(cappedCalls.length, 1);
  assert.equal(capped.length, 50);
  assert.deepEqual(providerCoverage(capped), {
    status: 'partial', code: 'max_pages',
    reason: 'board truncated at max_pages=1 (500 total jobs)',
    pagesFetched: 1, maxPages: 1,
  });
  pass('entry/context pagination caps retain jobs and report structured partial coverage');

  const empty = await provider.fetch({}, { fetchJson: async () => ({ data: [], meta: { total: 0 } }) });
  assert.deepEqual(empty, []);
  assert.equal(providerCoverage(empty), null);
  await assert.rejects(() => provider.fetch({}, { fetchJson: async () => ({ jobs: [] }) }), /malformed response/);
  await assert.rejects(
    () => provider.fetch({}, { fetchJson: async () => ({ data: [{ title: 'Bad' }] }) }),
    /none structurally usable/,
  );
  pass('healthy empty succeeds while malformed and unusable payloads fail truthfully');
} catch (error) {
  fail(`agentic-jobs provider tests crashed: ${error.stack || error.message}`);
}
