import assert from 'node:assert/strict';
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

console.log('\nProvider - a16z-speedrun-talent');

try {
  const { default: provider, normalizeSpeedrunJob } = await import(
    pathToFileURL(join(ROOT, 'providers/a16z-speedrun-talent.mjs')).href
  );

  assert.equal(provider.id, 'a16z-speedrun-talent');
  assert.ok(provider.detect({ provider: 'a16z-speedrun-talent' }));
  assert.ok(provider.detect({ careers_url: 'https://speedrun-talent-network.com' }));
  assert.equal(provider.detect({ careers_url: 'https://evil.example' }), null);
  pass('id and explicit/host detection are scoped correctly');

  const normalized = normalizeSpeedrunJob({
    title: ' AI Engineer ', company: 'Acme',
    url: 'https://speedrun-talent-network.com/jobs/abc',
    location: 'Helsinki', remote: true, published_at: '2026-07-01T00:00:00Z',
  });
  assert.deepEqual(normalized, {
    title: 'AI Engineer', company: 'Acme',
    url: 'https://speedrun-talent-network.com/jobs/abc',
    location: 'Helsinki, Remote', postedAt: Date.parse('2026-07-01T00:00:00Z'),
  });
  assert.equal(normalizeSpeedrunJob({ title: 'Bad', url: 'https://evil.example/job' }), null);
  pass('normalization preserves fields/date and rejects off-host URLs');

  const row = (id) => ({
    title: `Role ${id}`, company: 'Startup',
    url: `https://speedrun-talent-network.com/jobs/${id}`, location: 'Europe',
  });
  const calls = [];
  const jobs = await provider.fetch(
    { name: 'a16z', max_pages: 3, q: 'data engineer' },
    { fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      const page = Number(new URL(url).searchParams.get('page'));
      return page === 0
        ? { jobs: Array.from({ length: 50 }, (_, index) => row(index)), total_pages: 2 }
        : { jobs: [row(49), row(50)], total_pages: 2 };
    } },
  );
  assert.equal(calls.length, 2);
  assert.equal(jobs.length, 51);
  assert.ok(calls.every(({ opts }) => opts.redirect === 'error'));
  assert.equal(new URL(calls[0].url).searchParams.get('source'), 'career-ops');
  assert.equal(new URL(calls[0].url).searchParams.get('q'), 'data engineer');
  pass('pagination is bounded, attributed, query-aware, redirect-safe, and deduplicated');

  const cappedCalls = [];
  await provider.fetch({ max_pages: 5 }, {
    maxPages: 1,
    fetchJson: async (url) => {
      cappedCalls.push(url);
      return { jobs: Array.from({ length: 50 }, (_, index) => row(index)), total_pages: 10 };
    },
  });
  assert.equal(cappedCalls.length, 1);
  pass('context maxPages bounds health/smoke probes');

  assert.deepEqual(await provider.fetch({}, { fetchJson: async () => ({ jobs: [] }) }), []);
  await assert.rejects(() => provider.fetch({}, { fetchJson: async () => ({ nope: [] }) }), /malformed response/);
  await assert.rejects(
    () => provider.fetch({}, { fetchJson: async () => ({ jobs: [{ title: 'Bad', url: 'https://evil.example' }] }) }),
    /none structurally usable/,
  );
  pass('healthy empty succeeds while malformed and unusable payloads fail truthfully');
} catch (error) {
  fail(`a16z-speedrun-talent provider tests crashed: ${error.stack || error.message}`);
}
