import assert from 'node:assert/strict';
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

console.log('\nProvider - getro');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/getro.mjs')).href);
  const provider = mod.default;
  const { providerCoverage } = await import(pathToFileURL(join(ROOT, 'providers/_result.mjs')).href);

  assert.equal(provider.id, 'getro');
  assert.ok(provider.detect({ getro_collection: 4283 }));
  assert.equal(provider.detect({ getro_collection: 'bad' }), null);
  assert.equal(provider.detect({ careers_url: 'https://jobs.example.com/jobs' }), null);
  assert.ok(provider.detect({ provider: 'getro', careers_url: 'https://jobs.example.com/jobs' }));
  pass('id and explicit numeric collection detection are scoped correctly');

  const html = '<script nonce="x" id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"network":{"id":4283}}}}</script>';
  assert.equal(mod.extractCollectionId(html), '4283');
  assert.equal(mod.extractCollectionId('<script id="__NEXT_DATA__">not json</script>'), null);
  assert.equal(mod.extractCollectionId('<script id="__NEXT_DATA__">{"props":{"pageProps":{"network":{"id":0}}}}</script>'), null);
  pass('collection id auto-discovery is strict and JSON-shape aware');

  const normalized = mod.normalizeGetroJob({
    id: 150809,
    title: ' Software Engineer ', organization: { name: ' Portfolio Co ' },
    url: 'https://jobs.example.com/listing/150809',
    applyUrl: 'https://boards.greenhouse.io/portfolio/jobs/150809',
    locations: ['Helsinki', 'Remote'], work_mode: 'remote',
    created_at: '2026-07-01T00:00:00Z', description: '<p>Build APIs.</p>',
  }, 'https://fund.example/jobs', 'Fund');
  assert.deepEqual(normalized, {
    title: 'Software Engineer', company: 'Portfolio Co',
    location: 'Helsinki, Remote',
    url: 'https://boards.greenhouse.io/portfolio/jobs/150809',
    sourceUrl: 'https://jobs.example.com/listing/150809', sourceId: '150809',
    postedAt: Date.parse('2026-07-01T00:00:00Z'), description: 'Build APIs.',
  });
  assert.equal(mod.normalizeGetroJob({ title: 'Broken', url: 'http://evil.example/job' }, 'https://fund.example/jobs'), null);
  pass('normalization maps portfolio employer, ATS destination, board provenance, identity, date, and description');

  const fresh = new Date(Date.now() - 60_000).toISOString();
  const row = (id, url = `https://jobs.example.com/listing/${id}`) => ({
    id, title: `Role ${id}`, organization: { name: 'Portfolio Co' }, url,
    created_at: fresh, locations: ['Europe'],
  });
  const requests = [];
  const jobs = await provider.fetch(
    { name: 'Fund', getro_collection: 12, careers_url: 'https://fund.example/jobs', getro_max_pages: 3, getro_max_age_days: 90 },
    { fetchJson: async (url, opts) => {
      requests.push({ url, opts, body: JSON.parse(opts.body) });
      const page = requests.length - 1;
      return page === 0
        ? { results: { count: 21, jobs: Array.from({ length: 20 }, (_, index) => row(index)) } }
        : { results: { count: 21, jobs: [row(20, 'https://jobs.ashbyhq.com/portfolio/20')] } };
    } },
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.getro.com/api/v2/collections/12/search/jobs');
  assert.equal(requests[0].opts.redirect, 'error');
  assert.deepEqual(requests[0].body, { hitsPerPage: 20, page: 0, filters: { page: 0 }, query: '' });
  assert.equal(jobs.length, 21);
  assert.equal(jobs[0].sourceUrl, 'https://fund.example/jobs');
  assert.equal(jobs[20].url, 'https://jobs.ashbyhq.com/portfolio/20');
  pass('fetch paginates newest-first with bounded POST requests and preserves ATS provenance');

  const boardSource = mod.normalizeGetroJob({ id: 'board-source', title: 'Role',
    url: 'https://fund.example/jobs/board-source', applyUrl: 'https://jobs.lever.co/portfolio/board-source' },
  'https://fund.example/jobs', 'Fund');
  assert.equal(boardSource?.url, 'https://jobs.lever.co/portfolio/board-source');
  assert.equal(boardSource?.sourceUrl, 'https://fund.example/jobs/board-source');
  pass('Getro row-level board URL is retained when applyUrl points at an ATS');

  const staleCalls = [];
  const stale = await provider.fetch(
    { name: 'Fund', getro_collection: 12, careers_url: 'https://fund.example/jobs', getro_max_pages: 5, getro_max_age_days: 30 },
    { fetchJson: async (url) => {
      staleCalls.push(url);
      return { results: { count: 100, jobs: [
        row('fresh'), { ...row('old'), created_at: '2020-01-01T00:00:00Z' },
      ] } };
    } },
  );
  assert.equal(staleCalls.length, 1);
  assert.equal(stale.length, 1);
  pass('age cutoff stops a newest-first walk after stale postings while retaining fresh jobs');

  const capped = await provider.fetch(
    { name: 'Fund', getro_collection: 12, careers_url: 'https://fund.example/jobs', getro_max_pages: 5 },
    { maxPages: 1, fetchJson: async () => ({ results: { count: 100, jobs: Array.from({ length: 20 }, (_, i) => row(i)) } }) },
  );
  assert.equal(capped.length, 20);
  assert.equal(providerCoverage(capped)?.code, 'max_pages');
  pass('ctx.maxPages is honored and exposed as typed partial coverage');

  const repeatedCalls = [];
  const repeated = await provider.fetch(
    { name: 'Fund', getro_collection: 12, careers_url: 'https://fund.example/jobs', getro_max_pages: 5, getro_max_age_days: 0 },
    { fetchJson: async (url) => {
      repeatedCalls.push(url);
      return { results: { count: 100, jobs: Array.from({ length: 20 }, (_, i) => row(i)) } };
    } },
  );
  assert.equal(repeatedCalls.length, 2);
  assert.equal(providerCoverage(repeated)?.code, 'repeated_page');
  pass('identical pagination pages terminate safely with partial coverage metadata');

  const discovered = await provider.fetch(
    { name: 'Fund', careers_url: 'https://fund.example/jobs' },
    { fetchText: async (url, opts) => {
      assert.equal(url, 'https://fund.example/jobs');
      assert.equal(opts.redirect, 'error');
      return html;
    }, fetchJson: async () => ({ results: { count: 0, jobs: [] } }) },
  );
  assert.deepEqual(discovered, []);
  pass('careers_url __NEXT_DATA__ discovery uses ctx.fetchText and accepts a healthy empty board');

  await assert.rejects(() => provider.fetch({ name: 'Fund', getro_collection: 12, careers_url: 'https://fund.example/jobs' }, { fetchJson: async () => ({ nope: {} }) }), /malformed response/);
  await assert.rejects(() => provider.fetch({ name: 'Fund', getro_collection: 12, careers_url: 'https://fund.example/jobs' }, { fetchJson: async () => ({ results: { count: 1, jobs: [{ title: 'Broken', organization: { name: 'X' } }] } }) }), /none structurally usable/);
  await assert.rejects(() => provider.fetch({ name: 'Fund', careers_url: 'https://fund.example/jobs' }, { fetchText: async () => '<html>missing data</html>', fetchJson: async () => ({ results: { jobs: [] } }) }), /could not resolve collection_id/);
  pass('malformed and all-unusable nonempty payloads fail closed instead of becoming empty results');
} catch (error) {
  fail(`getro provider tests crashed: ${error.stack || error.message}`);
}
