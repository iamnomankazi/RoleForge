import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import provider, { parseIcimsSearchPage } from '../../providers/icims.mjs';
import { providerCoverage } from '../../providers/_result.mjs';

const fixturePath = new URL('../fixtures/icims-search-page.html', import.meta.url);
const fixture = await readFile(fixturePath, 'utf8');
const entry = { name: 'Acme', careers_url: 'https://acme.icims.com/jobs' };

function card(id, title = `Role ${id}`, location = 'Helsinki') {
  return `<li class="iCIMS_JobCardItem"><a href="/jobs/${id}/role-${id}/job"><h3>${title}</h3></a><span class="field-label sr-only">Location</span><span>${location}</span></li>`;
}

function errorWith(status, code, name = 'Error') {
  const error = new Error(`${status || code || name} failure`);
  if (status != null) error.status = status;
  if (code) error.code = code;
  error.name = name;
  return error;
}

test('detect validates HTTPS iCIMS origins and gives api precedence over careers_url', () => {
  assert.equal(provider.id, 'icims');
  const hit = provider.detect({
    api: 'https://api.acme.icims.com/ignored',
    careers_url: 'https://other.icims.com/jobs',
  });
  assert.equal(hit?.url, 'https://api.acme.icims.com/jobs/search?ss=1&pr=0&in_iframe=1');
  assert.equal(provider.detect({ careers_url: 'https://acme.icims.com/jobs' })?.url,
    'https://acme.icims.com/jobs/search?ss=1&pr=0&in_iframe=1');

  for (const careers_url of [
    'http://acme.icims.com/jobs',
    'https://icims.com/jobs',
    'https://acme.icims.com.evil.test/jobs',
    'https://acme_icims.icims.com/jobs',
    'https://user:pass@acme.icims.com/jobs',
    'https://acme.icims.com:444/jobs',
    'https://127.0.0.1/jobs',
  ]) assert.equal(provider.detect({ careers_url }), null, careers_url);
  assert.equal(provider.detect({ careers_url: 'https://fallback.icims.com/jobs', api: 'https://wrong.example/jobs' })?.url,
    'https://fallback.icims.com/jobs/search?ss=1&pr=0&in_iframe=1');
});

test('canonical iCIMS cards normalize titles, locations, numeric ids, and same-origin relative URLs', () => {
  const jobs = parseIcimsSearchPage(fixture, 'https://acme.icims.com', 'Acme');
  assert.deepEqual(jobs, [
    {
      title: 'Senior Platform Engineer',
      url: 'https://acme.icims.com/jobs/1042/senior-platform-engineer/job',
      company: 'Acme', location: 'Helsinki, Finland', sourceId: '1042',
    },
    {
      title: 'Data & Analytics Engineer',
      url: 'https://acme.icims.com/jobs/2044/data-engineer/job',
      company: 'Acme', location: 'Remote', sourceId: '2044',
    },
  ]);
  assert.throws(() => parseIcimsSearchPage(fixture, 'https://evil.example'), /validated HTTPS/);
});

test('fetch sends browser HTML requests, paces pages, and stops naturally on an empty page', async () => {
  const calls = [];
  const delays = [];
  const jobs = await provider.fetch(entry, {
    sleep: async (ms) => delays.push(ms),
    fetchText: async (url, options) => {
      calls.push({ url, options });
      const page = Number(new URL(url).searchParams.get('pr'));
      if (page === 0) return fixture;
      if (page === 1) return card(3050, 'Data Engineer', 'Remote');
      return '<html><body><ul class="iCIMS_JobsTable"></ul></body></html>';
    },
  });
  assert.equal(jobs.length, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(({ url }) => new URL(url).searchParams.get('pr')), ['0', '1', '2']);
  for (const { url, options } of calls) {
    assert.equal(new URL(url).pathname, '/jobs/search');
    assert.equal(new URL(url).searchParams.get('ss'), '1');
    assert.equal(new URL(url).searchParams.get('in_iframe'), '1');
    assert.equal(options.redirect, 'error');
    assert.match(options.headers['user-agent'], /Chrome\//);
    assert.match(options.headers.accept, /text\/html/);
  }
  assert.deepEqual(delays, [250, 250]);
  assert.equal(providerCoverage(jobs), null);
});

test('fetch stops before appending a page whose first posting URL repeats', async () => {
  let calls = 0;
  const jobs = await provider.fetch(entry, {
    fetchText: async () => { calls++; return fixture; },
    sleep: async () => {},
  });
  assert.equal(calls, 2);
  assert.equal(jobs.length, 2);
  assert.equal(providerCoverage(jobs), null);
});

test('a one-page probe hint and the 30-page hard cap report typed partial coverage', async () => {
  const probe = await provider.fetch(entry, {
    maxPages: 1,
    fetchText: async () => card(1),
  });
  assert.equal(probe.length, 1);
  assert.deepEqual(providerCoverage(probe), {
    status: 'partial', code: 'icims_page_cap',
    reason: 'Acme truncated at maxPages=1', pagesFetched: 1, maxPages: 1,
  });

  const pages = [];
  const delays = [];
  const capped = await provider.fetch(entry, {
    sleep: async (ms) => delays.push(ms),
    fetchText: async (url) => {
      const page = Number(new URL(url).searchParams.get('pr'));
      pages.push(page);
      return card(page + 100, `Role ${page}`);
    },
  });
  assert.equal(pages.length, 30);
  assert.deepEqual(pages, Array.from({ length: 30 }, (_, index) => index));
  assert.equal(delays.length, 29);
  assert.equal(capped.length, 30);
  assert.deepEqual(providerCoverage(capped), {
    status: 'partial', code: 'icims_page_cap',
    reason: 'Acme truncated at maxPages=30', pagesFetched: 30, maxPages: 30,
  });
});

test('enrichDate supports JSON-LD arrays and @graph, prefers typed dates, and fills the first usable location in place', async () => {
  const details = `<script nonce='n' data-x='1' type = 'application/ld+json'>[
    {"@type":"Thing","datePosted":"2020-01-01"},
    {"@type":["Thing","JobPosting"],"datePosted":"2026-09-15T10:30:00Z","jobLocation":[
      {"address":{"addressLocality":"UNAVAILABLE","addressRegion":"UNAVAILABLE","addressCountry":"UNAVAILABLE"}},
      {"address":{"addressLocality":"Helsinki","addressRegion":"Uusimaa","addressCountry":"FI"}},
      {"address":{"addressLocality":"Toronto","addressRegion":"UNAVAILABLE","addressCountry":{"name":"CA"}}}
    ]}
  ]</script>
  <script type="application/ld+json">{"@graph":[{"@type":"JobPosting","datePosted":"2025-01-01"}]}</script>`;
  const requests = [];
  const job = { title: 'Role', url: 'https://acme.icims.com/jobs/42/role/job', company: 'Acme', location: 'N/A' };
  const result = await provider.enrichDate(job, {
    fetchText: async (url, options) => { requests.push({ url, options }); return details; },
  });
  assert.strictEqual(result, job);
  assert.equal(job.postedAt, Date.parse('2026-09-15T10:30:00Z'));
  assert.equal(job.location, 'Helsinki, Uusimaa, FI');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://acme.icims.com/jobs/42/role/job?in_iframe=1');
  assert.equal(requests[0].options.redirect, 'error');
  assert.match(requests[0].options.headers['user-agent'], /Chrome\//);
});

test('enrichDate falls back to any valid dated node and leaves populated locations alone', async () => {
  const page = `<script TYPE="application/ld+json" nonce="x">{ "@type": "Thing", "datePosted": "2026-08-20" }</script>
    <script type='application/ld+json'>{bad json}</script>
    <script type='application/ld+json'>{"@graph":[{"datePosted":"not-a-date","jobLocation":{"address":{"addressLocality":"Tallinn"}}}]}</script>`;
  const job = { title: 'Role', url: 'https://acme.icims.com/jobs/5/role/job', location: 'Remote' };
  await provider.enrichDate(job, { fetchText: async () => page });
  assert.equal(job.postedAt, Date.parse('2026-08-20'));
  assert.equal(job.location, 'Remote');

  const noDate = { title: 'Role', url: 'https://acme.icims.com/jobs/6/role/job', location: '' };
  await provider.enrichDate(noDate, { fetchText: async () => `<script type="application/ld+json">{"@type":"JobPosting","datePosted":"bogus"}</script>` });
  assert.equal('postedAt' in noDate, false);
  assert.equal(noDate.location, '');

  const canada = { title: 'Role', url: 'https://acme.icims.com/jobs/9/role/job', location: 'N/A' };
  await provider.enrichDate(canada, { fetchText: async () => `<script type="application/ld+json">{"@type":"JobPosting","jobLocation":{"address":{"addressLocality":"Toronto","addressCountry":{"name":"UNAVAILABLE","identifier":"CA"}}}}</script>` });
  assert.equal(canada.location, 'Toronto, Canada');
});

test('invalid or empty JobPosting dates do not borrow an unrelated typed or untyped date', async () => {
  for (const datePosted of ['not-a-date', '']) {
    const page = `<script type="application/ld+json">${JSON.stringify([
      { '@type': 'JobPosting', datePosted },
      { '@type': 'Organization', datePosted: '2026-08-20' },
    ])}</script>`;
    const job = { title: 'Role', url: 'https://acme.icims.com/jobs/7/role/job', location: '' };
    await provider.enrichDate(job, { fetchText: async () => page });
    assert.equal('postedAt' in job, false, `datePosted=${JSON.stringify(datePosted)}`);
  }
});

test('impossible ISO calendar dates are ignored', async () => {
  const job = { title: 'Role', url: 'https://acme.icims.com/jobs/10/role/job', location: '' };
  await provider.enrichDate(job, { fetchText: async () => `<script type="application/ld+json">{"@type":"JobPosting","datePosted":"2026-02-30"}</script>` });
  assert.equal('postedAt' in job, false);
});

test('JSON-LD raw text is parsed without HTML entity rewriting', async () => {
  const page = `<script type="application/ld+json">{"@type":"JobPosting","datePosted":"2026-08-20","description":"Keep &quot;literal&quot; text"}</script>`;
  const job = { title: 'Role', url: 'https://acme.icims.com/jobs/8/role/job', location: '' };
  await provider.enrichDate(job, { fetchText: async () => page });
  assert.equal(job.postedAt, Date.parse('2026-08-20'));
});

test('enrichDate validates detail URLs and leaves transport failures visible to the caller', async () => {
  let calls = 0;
  await assert.rejects(() => provider.enrichDate({ url: 'https://evil.example/jobs/1/x/job' }, {
    fetchText: async () => { calls++; return ''; },
  }), /HTTPS job URL on \*\.icims\.com/);
  assert.equal(calls, 0);
  const failure = errorWith(503);
  await assert.rejects(() => provider.enrichDate({ url: 'https://acme.icims.com/jobs/1/x/job' }, {
    fetchText: async () => { throw failure; },
  }), (error) => error === failure);
});
