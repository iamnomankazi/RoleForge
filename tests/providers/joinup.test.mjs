import assert from 'node:assert/strict';
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

console.log('\nProvider - joinup');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/joinup.mjs')).href);
  const provider = mod.default;
  const { normalizeJoinupJob, parseJoinupResponse, parseJoinupHtml } = mod;
  assert.equal(provider.id, 'joinup');
  assert.ok(provider.detect({ careers_url: 'https://joinup.ch/browse/jobs' }));
  assert.ok(provider.detect({ provider: 'joinup' }));
  assert.equal(provider.detect({ careers_url: 'https://joinup.ch.evil.test/browse/jobs' }), null);
  assert.equal(provider.detect({ careers_url: 'http://joinup.ch/browse/jobs' }), null);
  pass('id, HTTPS host detection, and spoof rejection are correct');

  const hit = {
    id: 'j-42', slug: 'senior-data-engineer', title: ' Senior Data Engineer ', startup: 'Acme Labs',
    location: { city: 'Zürich', country: 'Switzerland' }, created: '2026-08-11T09:00:00Z',
    description: '<p>Build Swiss data products.</p>', workplaceType: 'HYBRID',
    salary: { min: 100000, max: 130000, currency: 'CHF' }, employmentType: 'Full-time',
  };
  const normalized = normalizeJoinupJob(hit);
  assert.equal(normalized.title, 'Senior Data Engineer');
  assert.equal(normalized.url, 'https://joinup.ch/job/senior-data-engineer');
  assert.equal(normalized.company, 'Acme Labs');
  assert.equal(normalized.location, 'Zürich, Switzerland');
  assert.equal(normalized.sourceId, 'j-42');
  assert.equal(normalized.sourceUrl, 'https://joinup.ch/browse/jobs');
  assert.equal(normalized.postedAt, Date.parse('2026-08-11T09:00:00Z'));
  assert.equal(normalized.description, 'Build Swiss data products.');
  assert.deepEqual(normalized.salary, { min: 100000, max: 130000, currency: 'CHF' });
  assert.equal(normalizeJoinupJob({ title: 'Bad', slug: 'x', url: 'https://evil.test/jobs/1' }), null);
  pass('normalization preserves Swiss location/date/description/work model and compensation');

  const payload = { props: { pageProps: { serverState: { initialResults: { jobs: {
    results: [{ hits: [hit, { slug: 'remote-role', headline: 'Remote Role', startup: 'Beta', location: 'Remote', remote: true }] }],
  } } } } } };
  const html = (value) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(value)}</script></html>`;
  assert.equal(parseJoinupResponse(payload, 'Joinup').length, 2);
  assert.equal(parseJoinupHtml(html(payload), 'Joinup').length, 2);
  assert.deepEqual(parseJoinupResponse({ props: { pageProps: { serverState: { initialResults: { jobs: { results: [{ hits: [] }] } } } } } }), []);
  pass('known Typesense SSR path parses and a structurally valid empty result stays healthy');

  assert.throws(() => parseJoinupHtml('<html>missing</html>'), /malformed HTML/);
  assert.throws(() => parseJoinupHtml('<script id="__NEXT_DATA__">{bad</script>'), /failed to parse/);
  assert.throws(() => parseJoinupResponse({ props: { pageProps: { serverState: { initialResults: { jobs: { results: [{ hits: [{ slug: 'x' }] }] } } } } } }), /none structurally usable/);
  assert.throws(() => parseJoinupResponse({ props: { pageProps: { serverState: { initialResults: { jobs: {} } } } } }), /malformed __NEXT_DATA__/);
  pass('missing/malformed payloads and all-unusable rows fail closed');

  let request;
  const jobs = await provider.fetch({ name: 'Joinup' }, { fetchText: async (url, opts) => { request = { url, opts }; return html(payload); } });
  assert.equal(jobs.length, 2);
  assert.equal(request.url, 'https://joinup.ch/browse/jobs');
  assert.equal(request.opts.redirect, 'error');
  assert.ok(jobs.every((job) => job.sourceUrl === 'https://joinup.ch/browse/jobs'));
  pass('fetch uses the pinned newest browse page with redirect protection and provenance');
} catch (error) {
  fail(`joinup provider tests crashed: ${error.stack || error.message}`);
}
