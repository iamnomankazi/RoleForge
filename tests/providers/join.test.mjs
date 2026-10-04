import assert from 'node:assert/strict';
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

console.log('\nProvider - join');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/join.mjs')).href);
  const provider = mod.default;
  const { normalizeJoinJob, parseJoinResponse, parseJoinHtml, providerCoverage } = {
    ...mod,
    providerCoverage: (await import(pathToFileURL(join(ROOT, 'providers/_result.mjs')).href)).providerCoverage,
  };
  assert.equal(provider.id, 'join');
  assert.ok(provider.detect({ careers_url: 'https://join.com/companies/acme' }));
  assert.ok(provider.detect({ careers_url: 'https://www.join.com/companies/acme' }));
  assert.equal(provider.detect({ careers_url: 'https://join.com.evil.test/companies/acme' }), null);
  assert.equal(provider.detect({ careers_url: 'http://join.com/companies/acme' }), null);
  pass('id, HTTPS host/path detection, and spoof rejection are correct');

  const raw = {
    idParam: '12345-platform-engineer', title: ' Platform Engineer ', company: { name: 'Acme' },
    city: { cityName: 'Zurich' }, country: { name: 'Switzerland' }, workplaceType: 'HYBRID',
    employmentType: { name: 'Permanent' }, createdAt: '2026-08-01T10:00:00Z',
    descriptionHtml: '<p>Build &amp; ship</p>', salary: { min: 100000, max: 120000, currency: 'CHF' },
  };
  const normalized = normalizeJoinJob(raw, 'Fallback', { sourceUrl: 'https://join.com/companies/acme', companySlug: 'acme' });
  assert.equal(normalized.title, 'Platform Engineer');
  assert.equal(normalized.url, 'https://join.com/companies/acme/12345-platform-engineer');
  assert.equal(normalized.location, 'Zurich, Switzerland');
  assert.equal(normalized.workModel, 'HYBRID');
  assert.equal(normalized.sourceId, '12345-platform-engineer');
  assert.equal(normalized.sourceUrl, 'https://join.com/companies/acme');
  assert.equal(normalized.postedAt, Date.parse('2026-08-01T10:00:00Z'));
  assert.equal(normalized.description, 'Build & ship');
  assert.deepEqual(normalized.salary, { min: 100000, max: 120000, currency: 'CHF' });
  assert.equal(normalizeJoinJob({ title: 'Bad', url: 'https://evil.test/jobs/1' }, 'Acme'), null);
  pass('normalization maps canonical URL/id, description/date/work model/location/company/salary');

  const html = (payload) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></html>`;
  const first = { props: { pageProps: {
    jobs: [raw, { id: 2, slug: 'designer', title: 'Designer', location: 'Remote', workplaceType: 'REMOTE' }],
    pageInfo: { page: 1, pageCount: 2, pageSize: 2 },
  } } };
  assert.equal(parseJoinResponse(first, 'Acme', 'https://join.com/companies/acme', 'acme').length, 2);
  assert.equal(parseJoinHtml(html(first), 'Acme', 'https://join.com/companies/acme', 'acme').length, 2);
  assert.deepEqual(parseJoinResponse({ props: { pageProps: { jobs: [] } } }), []);
  pass('valid SSR payload and valid empty board parse without false failures');

  assert.throws(() => parseJoinHtml('<html>no payload</html>'), /malformed HTML/);
  assert.throws(() => parseJoinHtml('<script id="__NEXT_DATA__">{bad</script>'), /failed to parse/);
  assert.throws(() => parseJoinResponse({ props: { pageProps: { jobs: [{ title: 'Broken' }] } } }), /none structurally usable/);
  pass('missing/malformed payloads and all-unusable rows fail closed');

  const requests = [];
  const second = { props: { pageProps: { jobs: [{ id: 3, slug: 'data', title: 'Data Engineer', location: 'Bern' }], pageInfo: { page: 2, pageCount: 2, pageSize: 2 } } } };
  const jobs = await provider.fetch({ name: 'Acme', careers_url: 'https://join.com/companies/acme' }, {
    fetchText: async (url, opts) => {
      requests.push({ url, opts });
      return url.includes('page=1') ? html(first) : html(second);
    },
  });
  assert.equal(jobs.length, 3);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => r.opts.redirect === 'error'));
  assert.equal(providerCoverage(jobs), null);
  pass('bounded page pagination, terminal page guard, dedupe, and redirect protection work');

  const repeatCalls = [];
  const repeated = await provider.fetch({ careers_url: 'https://join.com/companies/acme', max_pages: 10 }, {
    fetchText: async (url) => { repeatCalls.push(url); return html(first); },
  });
  assert.equal(repeatCalls.length, 2);
  assert.equal(repeated.length, 2);
  pass('exact repeated-page signature terminates pagination');

  const cappedCalls = [];
  const capped = await provider.fetch({ careers_url: 'https://join.com/companies/acme', max_pages: 100 }, {
    maxPages: 1,
    fetchText: async (url) => { cappedCalls.push(url); return html({ props: { pageProps: { jobs: first.props.pageProps.jobs, pageInfo: { page: 1, pageCount: 4, pageSize: 2 } } } }); },
  });
  assert.equal(cappedCalls.length, 1);
  assert.equal(providerCoverage(capped)?.code, 'max_pages');
  pass('entry/context caps clamp requests and expose partial coverage when pages remain');
} catch (error) {
  fail(`join provider tests crashed: ${error.stack || error.message}`);
}
