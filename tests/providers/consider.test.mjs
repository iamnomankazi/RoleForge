import assert from 'node:assert/strict';
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

console.log('\nProvider - consider');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/consider.mjs')).href);
  const provider = mod.default;
  const { providerCoverage } = await import(pathToFileURL(join(ROOT, 'providers/_result.mjs')).href);

  assert.equal(provider.id, 'consider');
  assert.ok(provider.detect({ consider_board: 'wingman', careers_url: 'https://jobs.example.com/jobs' }));
  assert.ok(provider.detect({ consider: { board_id: 'wingman' }, careers_url: 'https://jobs.example.com/jobs' }));
  assert.equal(provider.detect({ consider_board: 'wingman', careers_url: 'http://jobs.example.com/jobs' }), null);
  assert.equal(provider.detect({ consider_board: '', careers_url: 'https://jobs.example.com/jobs' }), null);
  assert.equal(provider.detect({ consider_board: 'wingman', careers_url: 'https://127.0.0.1/jobs' }), null);
  pass('id and public HTTPS board detection are scoped correctly');

  const normalized = mod.normalizeConsiderJob({
    id: 42,
    title: ' Staff Engineer ', companyName: ' Acme ',
    url: 'https://jobs.example.com/jobs/staff',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/42',
    locations: ['Helsinki'], remote: true,
    timeStamp: '2026-07-01T00:00:00Z', description: '<p>Build <b>systems</b>.</p>',
  }, 'https://jobs.example.com/jobs', 'Fallback');
  assert.deepEqual(normalized, {
    title: 'Staff Engineer', company: 'Acme', location: 'Helsinki, Remote',
    url: 'https://boards.greenhouse.io/acme/jobs/42',
    sourceUrl: 'https://jobs.example.com/jobs/staff', sourceId: '42',
    postedAt: Date.parse('2026-07-01T00:00:00Z'), description: 'Build systems .',
  });
  assert.equal(mod.normalizeConsiderJob({ title: 'Off host', applyUrl: 'http://evil.example/x' }, 'https://jobs.example.com'), null);
  pass('normalization maps destination/source provenance, identity, location, date, and description');

  const requests = [];
  const jobs = await provider.fetch(
    { name: 'Founderful', consider_board: 'wingman', careers_url: 'https://jobs.example.com/jobs', consider_size: 3 },
    { fetchJson: async (url, opts) => {
      requests.push({ url, opts, body: JSON.parse(opts.body) });
      return {
        total: 3,
        jobs: [
          { id: 'a', title: 'Role A', companyName: 'A', url: '/jobs/a', applyUrl: 'https://jobs.ashbyhq.com/a/1' },
          { id: 'b', title: 'Role B', companyName: 'B', url: '/jobs/b', applyUrl: 'https://jobs.lever.co/b/2' },
        ],
      };
    } },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://jobs.example.com/api-boards/search-jobs');
  assert.equal(requests[0].opts.redirect, 'error');
  assert.deepEqual(requests[0].body, { meta: { size: 3 }, board: { id: 'wingman', isParent: true }, query: { promoteFeatured: true } });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].sourceUrl, 'https://jobs.example.com/jobs/a');
  assert.equal(jobs[0].url, 'https://jobs.ashbyhq.com/a/1');
  assert.equal(jobs[1].url, 'https://jobs.lever.co/b/2');
  pass('fetch uses the bounded same-origin POST and preserves ATS destinations plus board provenance');

  const capped = await provider.fetch(
    { name: 'Board', consider_board: 'x', careers_url: 'https://board.example/jobs', consider_size: 2 },
    { fetchJson: async () => ({ total: 99, jobs: [
      { id: 1, title: 'A', url: '/jobs/1' }, { id: 2, title: 'B', url: '/jobs/2' },
    ] }) },
  );
  assert.equal(providerCoverage(capped)?.code, 'max_size');
  assert.equal(capped.length, 2);
  pass('server-reported truncation is surfaced as typed partial coverage');

  const overReturned = await provider.fetch(
    { name: 'Board', consider_board: 'x', careers_url: 'https://board.example/jobs', consider_size: 2 },
    { fetchJson: async () => ({ jobs: [
      { id: 1, title: 'A', url: '/jobs/1' }, { id: 2, title: 'B', url: '/jobs/2' }, { id: 3, title: 'C', url: '/jobs/3' },
    ] }) },
  );
  assert.equal(overReturned.length, 2);
  assert.equal(providerCoverage(overReturned)?.code, 'max_size');
  pass('client-side size bound holds even when a board over-returns rows');

  assert.deepEqual(await provider.fetch({ consider_board: 'x', careers_url: 'https://board.example/jobs' }, { fetchJson: async () => ({ jobs: [] }) }), []);
  await assert.rejects(() => provider.fetch({ consider_board: 'x', careers_url: 'https://board.example/jobs' }, { fetchJson: async () => ({ nope: [] }) }), /malformed response/);
  await assert.rejects(() => provider.fetch({ consider_board: 'x', careers_url: 'https://board.example/jobs' }, { fetchJson: async () => ({ jobs: [{ title: 'Broken', url: 'http://evil.example/job' }] }) }), /none structurally usable/);
  await assert.rejects(() => provider.fetch({ careers_url: 'https://board.example/jobs' }, { fetchJson: async () => ({ jobs: [] }) }), /needs a/);
  pass('healthy empty succeeds while malformed, unusable, and missing-config cases fail closed');
} catch (error) {
  fail(`consider provider tests crashed: ${error.stack || error.message}`);
}
