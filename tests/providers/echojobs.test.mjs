// tests/providers/echojobs.test.mjs — compatibility tests for the retired
// EchoJobs provider (providers/echojobs.mjs).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — echojobs');

try {
  const echojobsModule = await import(pathToFileURL(join(ROOT, 'providers/echojobs.mjs')).href);
  const echojobs = echojobsModule.default;
  const { normalizeEchojobsJob } = echojobsModule;

  if (echojobs.id === 'echojobs') pass('echojobs.id is "echojobs"');
  else fail(`echojobs.id is ${JSON.stringify(echojobs.id)}`);

  // detect() — explicit provider selection only (board-wide feed)
  const hit = echojobs.detect({ name: 'EchoJobs', provider: 'echojobs' });
  if (hit && hit.url === 'https://echojobs.io/api/jobs') pass('echojobs.detect() resolves provider:echojobs → feed URL');
  else fail(`echojobs.detect() returned ${JSON.stringify(hit)}`);
  if (echojobs.detect({ name: 'X' }) === null) pass('echojobs.detect() returns null without provider:echojobs');
  else fail('echojobs.detect() should require provider:echojobs');

  // normalizeEchojobsJob — field mapping, external ATS url kept, postedAt (ms)
  const j = {
    title: '  Senior Go Engineer  ',
    url: 'https://jobs.ashbyhq.com/acme/abc-123',
    company_name: 'Acme',
    locations: ['San Francisco, CA', 'New York, NY'],
    remote_type: 'on_site',
    posted_at: 1783380913765,
  };
  const n = normalizeEchojobsJob(j, 'Fallback');
  if (n && n.title === 'Senior Go Engineer' && n.company === 'Acme' &&
      n.url === 'https://jobs.ashbyhq.com/acme/abc-123' && n.location === 'San Francisco, CA, New York, NY' &&
      n.postedAt === 1783380913765) {
    pass('normalizeEchojobsJob maps title/company/url/location/postedAt and keeps the external ATS URL');
  } else {
    fail(`normalizeEchojobsJob => ${JSON.stringify(n)}`);
  }

  // remote fallback when no listed place
  const remote = normalizeEchojobsJob({ title: 'X', url: 'https://jobs.lever.co/x/1', locations: [], remote_type: 'remote' });
  const hybrid = normalizeEchojobsJob({ title: 'X', url: 'https://jobs.lever.co/x/2', remote_type: 'hybrid' });
  if (remote?.location === 'Remote' && hybrid?.location === 'Remote') {
    pass('normalizeEchojobsJob falls back to "Remote" for a placeless remote OR hybrid role');
  } else {
    fail(`remote/hybrid fallback => ${JSON.stringify([remote?.location, hybrid?.location])}`);
  }

  // company fallback to the entry name
  const bare = normalizeEchojobsJob({ title: 'X', url: 'https://jobs.lever.co/x/1' }, 'EntryName');
  if (bare?.company === 'EntryName') pass('normalizeEchojobsJob falls back to the entry name for company');
  else fail(`company fallback => ${JSON.stringify(bare?.company)}`);

  // drops: no title, non-https url, missing url
  if (normalizeEchojobsJob({ url: 'https://x/1' }) === null) pass('normalizeEchojobsJob drops a title-less item');
  else fail('title-less item should be dropped');
  if (normalizeEchojobsJob({ title: 'X', url: 'http://insecure/1' }) === null) pass('normalizeEchojobsJob drops a non-https url');
  else fail('non-https url should be dropped');
  if (normalizeEchojobsJob({ title: 'X' }) === null) pass('normalizeEchojobsJob drops an item with no url');
  else fail('url-less item should be dropped');

  // fetch() — retired immediately; HTTP context methods must never be called.
  const calls = [];
  const ctx = {
    transport: 'http',
    fetchJson: async () => {
      calls.push('fetchJson');
      return { status: 429, body: 'Vercel checkpoint' };
    },
    fetchText: async () => {
      calls.push('fetchText');
      return 'Vercel checkpoint';
    },
  };
  let message = '';
  try {
    await echojobs.fetch({ name: 'EchoJobs', provider: 'echojobs' }, ctx);
  } catch (e) { message = e.message; }
  if (/retired/.test(message) && /HTTP 429/.test(message) && /robots\.txt/.test(message)) {
    pass('echojobs.fetch() reports the retired feed and its confirmed HTTP 429/robots.txt state');
  } else {
    fail(`echojobs.fetch() returned diagnostic ${JSON.stringify(message)}`);
  }
  if (calls.length === 0) pass('echojobs.fetch() makes no HTTP context calls, even with a 429 fixture');
  else fail(`echojobs.fetch() called HTTP context methods: ${JSON.stringify(calls)}`);

} catch (e) {
  fail(`echojobs provider tests crashed: ${e.message}`);
}
