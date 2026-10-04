// tests/providers/greenhouse.test.mjs — direct provider-contract tests (#1499).
// Covers the id/detect/fetch contract scan.mjs calls: api: precedence with the
// host allowlist, careers_url auto-detection, normalization from the
// boards-api JSON shape, and the guard chain running before any request.
// (Indirect coverage elsewhere: liveness tests exercise Greenhouse URL
// resolution; this file tests the provider module itself.)
import { pass, fail, ROOT, captureConsoleErrors } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — greenhouse');

try {
  const greenhouseModule = await import(pathToFileURL(join(ROOT, 'providers/greenhouse.mjs')).href);
  const greenhouse = greenhouseModule.default;

  if (greenhouse.id === 'greenhouse') pass('greenhouse.id is "greenhouse"');
  else fail(`greenhouse.id is ${JSON.stringify(greenhouse.id)}`);

  // detect() — careers_url auto-detection (job-boards host → boards-api endpoint)
  const hit = greenhouse.detect({ name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme' });
  if (hit && hit.url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs') {
    pass('greenhouse.detect() resolves job-boards.greenhouse.io/<slug> → boards-api jobs endpoint');
  } else {
    fail(`greenhouse.detect() returned ${JSON.stringify(hit)}`);
  }

  const hitEu = greenhouse.detect({ name: 'EuCo', careers_url: 'https://job-boards.eu.greenhouse.io/euco' });
  if (hitEu && hitEu.url === 'https://boards-api.greenhouse.io/v1/boards/euco/jobs') {
    pass('greenhouse.detect() extracts the slug from a job-boards.eu.greenhouse.io careers_url');
  } else {
    fail(`greenhouse.detect(eu) returned ${JSON.stringify(hitEu)}`);
  }

  const hitNestedBoard = greenhouse.detect({
    name: 'NestedCo',
    careers_url: 'https://job-boards.eu.greenhouse.io/nested-co/jobs/123',
  });
  if (hitNestedBoard && hitNestedBoard.url === 'https://boards-api.greenhouse.io/v1/boards/nested-co/jobs') {
    pass('greenhouse.detect() keeps resolving a board token from a nested careers path');
  } else {
    fail(`greenhouse.detect(nested board) returned ${JSON.stringify(hitNestedBoard)}`);
  }

  const hitEmbed = greenhouse.detect({
    name: 'EmbedCo',
    careers_url: 'https://boards.greenhouse.io/embed/job_board?for=embed-co',
  });
  if (hitEmbed && hitEmbed.url === 'https://boards-api.greenhouse.io/v1/boards/embed-co/jobs') {
    pass('greenhouse.detect() resolves the trusted embed/job_board?for=<token> form');
  } else {
    fail(`greenhouse.detect(embed) returned ${JSON.stringify(hitEmbed)}`);
  }

  const invalidCareersUrls = [
    'https://job-boards.greenhouse.io.evil.example/acme',
    'https://boards.greenhouse.io@evil.example/embed/job_board?for=acme',
    'https://user@boards.greenhouse.io/embed/job_board?for=acme',
    'https://boards.greenhouse.io:8443/embed/job_board?for=acme',
    'http://boards.greenhouse.io/embed/job_board?for=acme',
    'https://boards.greenhouse.io/embed/job_board',
    'https://boards.greenhouse.io/embed/job_board?for=acme&for=other',
    'https://boards.greenhouse.io/embed/job_board?for=../other',
    'https://boards.greenhouse.io/embed/job_board/extra?for=acme',
  ];
  if (invalidCareersUrls.every((careers_url) => greenhouse.detect({ name: 'BadUrl', careers_url }) === null)) {
    pass('greenhouse.detect() rejects hostile authorities, credentials, nondefault ports, and ambiguous embed tokens');
  } else {
    fail('greenhouse.detect() accepted an invalid or ambiguous careers_url');
  }

  // detect() — api: takes precedence over careers_url and is used verbatim
  // when its host is on the allowlist.
  const hitApi = greenhouse.detect({
    name: 'Pinned',
    careers_url: 'https://www.pinned.example/careers',
    api: 'https://boards-api.greenhouse.io/v1/boards/pinned/jobs',
  });
  if (hitApi && hitApi.url === 'https://boards-api.greenhouse.io/v1/boards/pinned/jobs') {
    pass('greenhouse.detect() honors an allowlisted api: over a branded careers_url');
  } else {
    fail(`greenhouse.detect(api-pinned) returned ${JSON.stringify(hitApi)}`);
  }

  // detect() — api: with an untrusted host must NOT be claimed (SSRF guard).
  if (greenhouse.detect({ name: 'Evil', api: 'https://evil.example/v1/boards/acme/jobs' }) === null) {
    pass('greenhouse.detect() returns null for an api: on an untrusted host');
  } else {
    fail('greenhouse.detect() must reject an untrusted api: host');
  }

  // detect() — api: must be HTTPS.
  if (greenhouse.detect({ name: 'Insecure', api: 'http://boards-api.greenhouse.io/v1/boards/acme/jobs' }) === null) {
    pass('greenhouse.detect() returns null for a non-HTTPS api:');
  } else {
    fail('greenhouse.detect() must reject an http:// api:');
  }

  if (greenhouse.detect({ name: 'Credentialed', api: 'https://user@boards-api.greenhouse.io/v1/boards/acme/jobs' }) === null
      && greenhouse.detect({ name: 'Port', api: 'https://boards-api.greenhouse.io:8443/v1/boards/acme/jobs' }) === null) {
    pass('greenhouse.detect() rejects API credentials and nondefault ports');
  } else {
    fail('greenhouse.detect() must reject API credentials and nondefault ports');
  }

  // detect() — malformed api: URL → null, not a crash.
  if (greenhouse.detect({ name: 'Broken', api: 'not a url' }) === null) {
    pass('greenhouse.detect() returns null for a malformed api: URL');
  } else {
    fail('greenhouse.detect() should treat a malformed api: as unclaimable');
  }

  // detect() — negative and non-string careers_url cases.
  if (greenhouse.detect({ name: 'X', careers_url: 'https://example.com/careers' }) === null) {
    pass('greenhouse.detect() returns null for a non-greenhouse careers_url');
  } else {
    fail('greenhouse.detect() should return null for non-greenhouse URLs');
  }

  if (greenhouse.detect({ name: 'X' }) === null
      && greenhouse.detect({ name: 'X', careers_url: null }) === null
      && greenhouse.detect({ name: 'X', careers_url: 7 }) === null) {
    pass('greenhouse.detect() returns null for missing / null / non-string careers_url');
  } else {
    fail('greenhouse.detect() should treat non-string careers_url as missing');
  }

  // fetch() — request URL, SSRF guard, and normalization from the real
  // boards-api shape: { jobs: [{ title, absolute_url, location: {name}, first_published }] }.
  const sample = {
    jobs: [
      {
        id: 101,
        title: 'Senior Backend Engineer',
        absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/101',
        location: { name: 'Berlin, Germany' },
        first_published: '2026-07-01T09:30:00-04:00',
        content: '<div><p>Build &amp; ship</p><p><strong>AI</strong> teams</p></div>',
      },
      {
        id: 102,
        // no title → '' ; no location → '' ; no first_published → postedAt undefined
        absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/102',
      },
      { id: 103, title: 'Ghost Role' },                                    // no absolute_url — dropped
      { id: 104, title: 'Bad Date', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/104', first_published: 'not-a-date' },
    ],
  };

  const capturedRequests = [];
  const fetched = await greenhouse.fetch(
    { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme' },
    { fetchJson: async (url, opts) => { capturedRequests.push({ url, opts }); return sample; } },
  );

  if (capturedRequests.length === 1
      && capturedRequests[0]?.url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true'
      && capturedRequests[0]?.opts?.redirect === 'error') {
    pass('greenhouse.fetch() makes one list request to the derived boards-api URL with redirect:"error"');
  } else {
    fail(`greenhouse.fetch() requests=${JSON.stringify(capturedRequests)}`);
  }

  let configuredListUrl = null;
  await greenhouse.fetch(
    { name: 'Configured', api: 'https://boards-api.greenhouse.io/v1/boards/configured/jobs?content=false&source=portal' },
    { fetchJson: async (url) => { configuredListUrl = url; return { jobs: [] }; } },
  );
  if (configuredListUrl === 'https://boards-api.greenhouse.io/v1/boards/configured/jobs?content=true&source=portal') {
    pass('greenhouse.fetch() forces content=true while preserving other configured list query parameters');
  } else {
    fail(`greenhouse.fetch() configured list URL=${JSON.stringify(configuredListUrl)}`);
  }

  if (fetched.length === 3)
    pass('greenhouse.fetch() drops rows without absolute_url (3 of 4 kept)');
  else fail(`greenhouse.fetch() returned ${fetched.length} jobs (expected 3)`);

  if (fetched[0]?.title === 'Senior Backend Engineer'
      && fetched[0]?.url === 'https://job-boards.greenhouse.io/acme/jobs/101'
      && fetched[0]?.company === 'Acme'
      && fetched[0]?.location === 'Berlin, Germany'
      && fetched[0]?.description === 'Build & ship AI teams'
      && fetched[0]?.postedAt === Date.parse('2026-07-01T09:30:00-04:00'))
    pass('greenhouse.fetch() maps canonical fields and converts provider HTML/entities to plain description text');
  else fail(`greenhouse.fetch() row 0 = ${JSON.stringify(fetched[0])}`);

  if (fetched[1]?.title === '' && fetched[1]?.location === '' && fetched[1]?.postedAt === undefined
      && !Object.hasOwn(fetched[1], 'description'))
    pass('greenhouse.fetch() preserves absent description and defaults missing title/location/date');
  else fail(`greenhouse.fetch() row 1 = ${JSON.stringify(fetched[1])}`);

  if (fetched[2]?.postedAt === undefined)
    pass('greenhouse.fetch() yields undefined postedAt for an unparseable first_published (NaN-safe)');
  else fail(`greenhouse.fetch() row 2 postedAt = ${JSON.stringify(fetched[2]?.postedAt)}`);

  // Strict date parsing keeps ambiguous, invalid and non-string values unknown,
  // while a real ISO epoch date remains a valid zero timestamp.
  const dateCases = await greenhouse.fetch(
    { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme' },
    { fetchJson: async () => ({ jobs: [
      { title: 'Epoch', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1', first_published: '1970-01-01T00:00:00.000Z' },
      { title: 'Null', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/2', first_published: null },
      { title: 'Ambiguous', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/3', first_published: '01/02/2026' },
      { title: 'Invalid calendar', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/4', first_published: '2026-02-30' },
      { title: 'Numeric', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/5', first_published: 0 },
      { title: 'Missing', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/6' },
    ] }) },
  );
  if (dateCases[0]?.postedAt === 0
      && dateCases.slice(1).every((job) => job.postedAt === undefined))
    pass('greenhouse.fetch() preserves a valid epoch and omits unusable null, ambiguous, invalid, numeric, or missing dates');
  else fail(`greenhouse.fetch() strict dates = ${JSON.stringify(dateCases.map((job) => job.postedAt))}`);

  // Offices are fetched once only when a listing has a work-model-only
  // location; the actual office geography is stable across provider ordering.
  const officeRequests = [];
  const enriched = await greenhouse.fetch(
    { name: 'MultiSite', api: 'https://boards-api.greenhouse.io/v1/boards/multisite/jobs' },
    { fetchJson: async (url, opts) => {
      officeRequests.push({ url, opts });
      if (new URL(url).pathname.endsWith('/jobs')) return { jobs: [
        { id: 301, title: 'Remote Role', absolute_url: 'https://job-boards.greenhouse.io/multisite/jobs/301', location: { name: 'Remote; Hybrid' } },
        { id: 302, title: 'Hybrid Role', absolute_url: 'https://job-boards.greenhouse.io/multisite/jobs/302', location: { name: 'Hybrid' } },
      ] };
      return { offices: [
        { name: 'West Office', location: 'Zurich, Switzerland', departments: [{ jobs: [{ id: '301' }, { id: '302' }] }] },
        { name: 'East Office', location: { city: 'Boston', country: 'US' }, departments: [{ jobs: [{ id: 301 }, { id: 302 }] }], children: [
          { name: 'Asia Office', location: 'Singapore', departments: [{ jobs: [{ id: 301 }, { id: 302 }] }] },
        ] },
      ] };
    } },
  );
  if (officeRequests.length === 2
      && officeRequests.every((request) => request.opts?.redirect === 'error')
      && officeRequests[0]?.url === 'https://boards-api.greenhouse.io/v1/boards/multisite/jobs?content=true'
      && officeRequests[1]?.url === 'https://boards-api.greenhouse.io/v1/boards/multisite/offices'
      && enriched[0]?.location === 'Remote; Hybrid · Boston, US · Singapore · Zurich, Switzerland'
      && enriched[1]?.location === 'Hybrid · Boston, US · Singapore · Zurich, Switzerland') {
    pass('greenhouse.fetch() makes one guarded offices request for multiple jobs and maps nested, multi-site geography in stable order');
  } else {
    fail(`greenhouse.fetch() officeRequests=${JSON.stringify(officeRequests)} result=${JSON.stringify(enriched)}`);
  }

  // Office lookup is optional enrichment: a failure retains all list evidence.
  const degraded = await captureConsoleErrors(() => greenhouse.fetch(
    { name: 'OfficeDown', careers_url: 'https://job-boards.greenhouse.io/officedown' },
    { fetchJson: async (url) => {
      if (new URL(url).pathname.endsWith('/jobs')) return { jobs: [
        { id: 302, title: 'Remote Role', absolute_url: 'https://job-boards.greenhouse.io/officedown/jobs/302', location: { name: 'Remote' } },
      ] };
      throw new Error('office fixture unavailable');
    } },
  ));
  if (degraded.result.length === 1 && degraded.result[0]?.url === 'https://job-boards.greenhouse.io/officedown/jobs/302'
      && degraded.result[0]?.location === 'Remote' && degraded.errors.length === 1) {
    pass('greenhouse.fetch() retains listing rows when optional office enrichment fails');
  } else {
    fail(`greenhouse.fetch() degraded result=${JSON.stringify(degraded)}`);
  }

  // Malformed response bodies → empty result, no crash.
  const emptyCases = [{ jobs: [] }];
  let emptyOk = true;
  for (const body of emptyCases) {
    const out = await greenhouse.fetch(
      { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme' },
      { fetchJson: async () => body },
    );
    if (!Array.isArray(out) || out.length !== 0) { emptyOk = false; fail(`greenhouse.fetch() body=${JSON.stringify(body)} → ${JSON.stringify(out)}`); break; }
  }
  if (emptyOk) pass('greenhouse.fetch() returns [] for null / {} / non-array jobs response bodies');

  // Guard chain runs BEFORE any request: an untrusted api: must throw without
  // ever calling fetchJson.
  let untrustedFetchCalled = false;
  try {
    await greenhouse.fetch(
      { name: 'Evil', api: 'https://evil.example/v1/boards/acme/jobs' },
      { fetchJson: async () => { untrustedFetchCalled = true; return { jobs: [] }; } },
    );
    fail('greenhouse.fetch() should throw for an untrusted api: host');
  } catch (e) {
    if (!untrustedFetchCalled && /untrusted hostname/.test(e.message)) {
      pass('greenhouse.fetch() throws on an untrusted api: host before any request is made');
    } else {
      fail(`greenhouse.fetch() untrusted api: fetchCalled=${untrustedFetchCalled}, error=${e.message}`);
    }
  }

  // Underivable entry → typed error, no request.
  try {
    await greenhouse.fetch(
      { name: 'NoBoard', careers_url: 'https://example.com/careers' },
      { fetchJson: async () => { throw new Error('must not be called'); } },
    );
    fail('greenhouse.fetch() should throw when no API URL can be derived');
  } catch (e) {
    if (/cannot derive API URL for NoBoard/.test(e.message)) {
      pass('greenhouse.fetch() throws "cannot derive API URL" for an undetectable entry');
    } else {
      fail(`greenhouse.fetch() threw the wrong error: ${e.message}`);
    }
  }

} catch (e) {
  fail(`greenhouse provider tests crashed: ${e.message}`);
}
