import assert from 'node:assert/strict';
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

console.log('\nProvider — hackernews');

try {
  const module = await import(pathToFileURL(join(ROOT, 'providers/hackernews.mjs')).href);
  const provider = module.default;
  const { parseHnComment, resolveLatestThreadId } = module;
  const { buildLocationClassifier } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

  assert.equal(provider.id, 'hackernews');
  assert.ok(provider.detect({ provider: 'hackernews' }));
  assert.equal(provider.detect({ provider: 'other' }), null);
  pass('id and explicit provider detection are scoped correctly');

  assert.equal(resolveLatestThreadId({ hits: [
    { objectID: '1', title: 'Ask HN: Who wants to be hired?' },
    { objectID: '2', title: 'Ask HN: Who is hiring? (August 2026)' },
  ] }), '2');
  assert.equal(resolveLatestThreadId({ hits: [] }), null);
  assert.equal(resolveLatestThreadId(null), null);
  pass('latest monthly hiring thread resolution is defensive');

  const standard = parseHnComment(
    'Acme Corp | Backend Engineer | Remote Europe | Full-Time\nWe build data systems.\nApply: https://jobs.lever.co/acme/123',
    'https://news.ycombinator.com/item?id=10',
  );
  assert.equal(standard?.company, 'Acme Corp');
  assert.equal(standard?.title, 'Backend Engineer');
  assert.equal(standard?.location, 'Remote Europe');
  assert.equal(standard?.url, 'https://jobs.lever.co/acme/123');
  assert.match(standard?.description || '', /We build data systems/);
  assert.equal(standard?.sourceUrl, 'https://news.ycombinator.com/item?id=10');
  pass('standard pipe header yields clean company/role/location plus description and provenance');

  const headerCases = [
    ['Remote | Apply: https://jobs.lever.co/acme/1', 'Remote'],
    ['Remote | Careers: https://jobs.lever.co/acme/1', 'Remote'],
    ['Remote | Full-time | https://jobs.lever.co/acme/1', 'Remote'],
    ['Remote | Europe | https://jobs.lever.co/acme/1', 'Remote; Europe'],
    ['Remote | CET | https://jobs.lever.co/acme/1', 'Remote; CET'],
    ['Hybrid | Berlin | https://jobs.lever.co/acme/1', 'Hybrid; Berlin'],
  ];
  const classifyLocation = buildLocationClassifier({
    always_allow: ['Germany', 'Berlin'],
    allow: ['Remote Europe', 'Europe', 'EU', 'EEA', 'Remote'],
  });
  for (const [tail, expectedLocation] of headerCases) {
    const parsed = parseHnComment(`Header Co | Engineer | ${tail}`, 'https://news.ycombinator.com/item?id=1010');
    assert.equal(parsed?.location, expectedLocation, tail);
  }
  assert.equal(classifyLocation('Remote; Europe').status, 'eligible');
  assert.equal(classifyLocation('Remote; CET').status, 'uncertain');
  assert.equal(classifyLocation('Hybrid; Berlin').status, 'eligible');
  const restrictedHeader = parseHnComment(
    'Header Co | Engineer | Remote | US only | https://jobs.lever.co/acme/1',
    'https://news.ycombinator.com/item?id=1011',
  );
  assert.equal(classifyLocation(restrictedHeader?.location).status, 'ineligible');
  pass('action labels stay out of HN locations while meaningful secondary evidence reaches the classifier');

  const laterUrl = parseHnComment(
    '<p>Beta &amp; Co | ML Engineer | Helsinki, Finland</p><p>Details first.</p><p><a href="https://beta.example/careers/ml">Apply here</a></p>',
    'https://news.ycombinator.com/item?id=11',
  );
  assert.equal(laterUrl?.company, 'Beta & Co');
  assert.equal(laterUrl?.url, 'https://beta.example/careers/ml');
  pass('HTML anchors and later-paragraph careers URLs are handled');

  const ranked = parseHnComment(
    'Ranked Co | Data Engineer | Amsterdam, Netherlands\nFounder: https://www.linkedin.com/in/example-person\nWebsite: https://ranked.example/about\nApply: https://jobs.ashbyhq.com/ranked/abc',
    'https://news.ycombinator.com/item?id=12',
  );
  assert.equal(ranked?.url, 'https://jobs.ashbyhq.com/ranked/abc');
  pass('LinkedIn personal profiles are rejected and a later ATS URL wins');

  const multiple = parseHnComment(
    'Many Co | Software Engineer | Berlin, Germany\nBlog: https://many.example/blog/post\nCareers: https://many.example/careers/software-engineer\nSocial: https://x.com/many',
    'https://news.ycombinator.com/item?id=13',
  );
  assert.equal(multiple?.url, 'https://many.example/careers/software-engineer');
  pass('multiple URLs are ranked by job/careers evidence instead of first occurrence');

  const companyBeforeBoard = parseHnComment(
    'Priority Co | Software Engineer | Remote\nLinkedIn: https://www.linkedin.com/jobs/view/123\nDirect: https://company.example/careers/software-engineer',
    'https://news.ycombinator.com/item?id=131',
  );
  assert.equal(companyBeforeBoard?.url, 'https://company.example/careers/software-engineer');
  const linkedInFallback = parseHnComment(
    'Fallback Co | Software Engineer | Remote\nApply: https://www.linkedin.com/jobs/view/456',
    'https://news.ycombinator.com/item?id=132',
  );
  assert.equal(linkedInFallback?.url, 'https://www.linkedin.com/jobs/view/456');
  pass('direct company postings outrank LinkedIn Jobs while LinkedIn remains a fallback');

  for (const lookalike of [
    'https://fakegreenhouse.io/acme/123',
    'https://notlever.co/acme/123',
  ]) {
    const guarded = parseHnComment(
      `Host Guard Co | Engineer | Remote\nLookalike: ${lookalike}\nApply: https://www.linkedin.com/jobs/view/789`,
      'https://news.ycombinator.com/item?id=133',
    );
    assert.equal(guarded?.url, 'https://www.linkedin.com/jobs/view/789', lookalike);
  }
  pass('ATS trust uses exact-host-or-subdomain matching, not loose hostname suffixes');

  const noExternal = parseHnComment(
    'No Link Co | Backend Engineer | Remote\nContact https://www.linkedin.com/in/example-person',
    'https://news.ycombinator.com/item?id=14',
  );
  assert.equal(noExternal?.url, '');
  assert.equal(parseHnComment('Software Engineer with 5+ years of experience building enterprise systems.', 'https://news.ycombinator.com/item?id=15'), null);
  assert.equal(parseHnComment('', ''), null);
  pass('no usable external URL and malformed/free-form headers degrade conservatively');

  const numericEntity = parseHnComment(
    'Snout | Backend Engineer | EEA | https:&#x2F;&#x2F;snout.example&#x2F;careers&#x2F;backend',
    'https://news.ycombinator.com/item?id=16',
  );
  assert.equal(numericEntity?.url, 'https://snout.example/careers/backend');
  pass('numeric HTML entities in URLs are decoded');

  const threadId = '42424242';
  const search = { hits: [{ objectID: threadId, title: 'Ask HN: Who is hiring? (August 2026)' }] };
  const item = { children: [
    { id: 101, text: 'Startup XYZ | Backend Engineer | Helsinki, Finland\nhttps://xyz.example/careers/backend', created_at: '2026-08-01T10:00:00Z' },
    { id: 102, text: 'URL-less Co | Data Engineer | Remote' },
    { id: 103, text: 'Profile only | Engineer | Remote\nhttps://linkedin.com/in/profile' },
    { id: 104, deleted: true, text: 'Deleted | Engineer | Remote\nhttps://deleted.example/jobs/1' },
  ] };
  const jobs = await provider.fetch({ name: 'HN Hiring' }, {
    async fetchJson(url) {
      if (url.includes('search_by_date')) return search;
      if (url.includes(`/items/${threadId}`)) return item;
      throw new Error(`unexpected URL ${url}`);
    },
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, 'https://xyz.example/careers/backend');
  assert.equal(jobs[0].sourceUrl, 'https://news.ycombinator.com/item?id=101');
  assert.equal(jobs[0].postedAt, Date.parse('2026-08-01T10:00:00Z'));
  assert.match(jobs[0].description, /Startup XYZ/);
  pass('fetch skips unsafe rows while preserving per-comment identity, date, and body text');

  const empty = await provider.fetch({ name: 'HN' }, {
    async fetchJson(url) { return url.includes('search_by_date') ? search : { children: [] }; },
  });
  assert.deepEqual(empty, []);
  pass('valid empty threads remain healthy empty');

  await assert.rejects(() => provider.fetch({}, { fetchJson: async () => ({ results: [] }) }), /malformed search/);
  await assert.rejects(() => provider.fetch({}, {
    fetchJson: async (url) => url.includes('search_by_date') ? search : { comments: [] },
  }), /expected children/);
  pass('malformed API payloads fail truthfully');
} catch (error) {
  fail(`hackernews provider tests crashed: ${error.stack || error.message}`);
}
