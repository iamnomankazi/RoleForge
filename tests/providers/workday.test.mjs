// tests/providers/workday.test.mjs — moved verbatim from test-all.mjs (#1440).
import { pass, fail, warn, run, ROOT, captureConsoleErrors } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { providerCoverage } from '../../providers/_result.mjs';

console.log('\nProvider — workday');


try {
  const workdayModule = await import(pathToFileURL(join(ROOT, 'providers/workday.mjs')).href);
  const workday = workdayModule.default;
  const { parseWorkdayResponse } = workdayModule;

  // Shared mock ctx shape for workday.fetch() calls below — only fetchJson varies per test.
  // sleep is a no-op so retry-backoff delays don't slow the test suite down.
  const mkWorkdayCtx = (fetchJson, extra = {}) => ({
    transport: 'http',
    fetchText: async () => { throw new Error('fetchText should not be called'); },
    fetchJson,
    sleep: async () => {},
    ...extra,
  });

  if (workday.id === 'workday') pass('workday.id is "workday"');
  else fail(`workday.id is ${JSON.stringify(workday.id)}`);

  // detect() — valid Workday URLs
  const hitUs = workday.detect({ name: 'Acme', careers_url: 'https://acme.wd12.myworkdayjobs.com/en-US/acme-jobs' });
  if (hitUs && hitUs.url === 'https://acme.wd12.myworkdayjobs.com/wday/cxs/acme/acme-jobs/jobs') {
    pass('workday.detect() resolves wd12 URL to CXS API endpoint');
  } else {
    fail(`workday.detect(wd12) returned ${JSON.stringify(hitUs)}`);
  }

  const hitNoLocale = workday.detect({ name: 'Test', careers_url: 'https://test.wd5.myworkdayjobs.com/TestBoard' });
  if (hitNoLocale && hitNoLocale.url === 'https://test.wd5.myworkdayjobs.com/wday/cxs/test/TestBoard/jobs') {
    pass('workday.detect() works without locale segment in path');
  } else {
    fail(`workday.detect(no-locale) returned ${JSON.stringify(hitNoLocale)}`);
  }

  // detect() — null cases
  if (workday.detect({ name: 'X', careers_url: 'https://example.com/careers' }) === null) {
    pass('workday.detect() returns null for non-Workday URL');
  } else {
    fail('workday.detect() should return null for non-Workday URL');
  }

  // entry.api precedence: a branded careers_url is kept while the Workday tenant
  // is pinned via api: (mirrors greenhouse/ashby).
  const hitApiWd = workday.detect({
    name: 'PTC',
    careers_url: 'https://www.ptc.com/en/careers',
    api: 'https://ptc.wd1.myworkdayjobs.com/PTC',
  });
  if (hitApiWd && hitApiWd.url === 'https://ptc.wd1.myworkdayjobs.com/wday/cxs/ptc/PTC/jobs') {
    pass('workday.detect() honors api: over a branded careers_url');
  } else {
    fail(`workday.detect(api-pinned) returned ${JSON.stringify(hitApiWd)}`);
  }

  // A non-Workday api: must not shadow a valid Workday careers_url — resolution
  // falls through to the next candidate instead of returning null.
  const hitFallthrough = workday.detect({
    name: 'Acme',
    api: 'https://acme.com/careers',
    careers_url: 'https://acme.wd12.myworkdayjobs.com/en-US/acme-jobs',
  });
  if (hitFallthrough && hitFallthrough.url === 'https://acme.wd12.myworkdayjobs.com/wday/cxs/acme/acme-jobs/jobs') {
    pass('workday.detect() falls through a non-Workday api: to a valid careers_url');
  } else {
    fail(`workday.detect(fallthrough) returned ${JSON.stringify(hitFallthrough)}`);
  }

  // Path-spoofed URL: myworkdayjobs.com in path, not hostname
  if (workday.detect({ name: 'Spoof', careers_url: 'https://evil.example/test.wd5.myworkdayjobs.com/en-US/board' }) === null) {
    pass('workday.detect() rejects path-spoofed URL');
  } else {
    fail('workday.detect() must NOT detect path-spoofed URLs');
  }

  // Non-string careers_url
  if (workday.detect({ name: 'X', careers_url: null }) === null && workday.detect({ name: 'X' }) === null) {
    pass('workday.detect() returns null for null / missing careers_url');
  } else {
    fail('workday.detect() should return null for non-string careers_url');
  }

  // parseWorkdayResponse — normalization
  const sampleJson = {
    jobPostings: [
      { title: 'Senior QA Engineer', externalPath: '/job/board/Senior-QA-Engineer_JR001', locationsText: 'Berlin, Germany', postedOn: 'Posted 2 Days Ago' },
      { title: 'Lead Developer', externalPath: '/job/board/Lead-Developer_JR002', locationsText: 'Remote' },
      { title: '', externalPath: '/job/board/No-Title_JR003' },          // no title — skip
      { title: 'No Path Role', externalPath: '' },                        // no externalPath — skip
      { title: 'Also No Path' },                                          // undefined externalPath — skip
    ],
  };
  const entry = { name: 'Acme', careers_url: 'https://acme.wd12.myworkdayjobs.com/en-US/acme-jobs' };
  const parsed = parseWorkdayResponse(sampleJson, entry);

  if (parsed.length === 2) pass('parseWorkdayResponse extracts 2 valid jobs (skips missing title/path)');
  else fail(`parseWorkdayResponse returned ${parsed.length} jobs, expected 2`);

  if (parsed[0].title === 'Senior QA Engineer' && parsed[0].location === 'Berlin, Germany') {
    pass('parseWorkdayResponse maps title and location');
  } else {
    fail(`row 0 = ${JSON.stringify(parsed[0])}`);
  }

  if (parsed[0].url.includes('acme-jobs') && parsed[0].url.includes('/job/board/Senior-QA-Engineer_JR001')) {
    pass('parseWorkdayResponse builds URL from jobBase + externalPath');
  } else {
    fail(`row 0 url = ${JSON.stringify(parsed[0].url)}`);
  }

  if (parsed[0].company === 'Acme') pass('parseWorkdayResponse sets company from entry.name');
  else fail(`parseWorkdayResponse company = ${JSON.stringify(parsed[0].company)}`);

  // parseWorkdayResponse — location fallback from URL path
  const noLocEntry = { name: 'Globex', careers_url: 'https://globex.wd103.myworkdayjobs.com/globexcareers' };
  const noLocJson = {
    jobPostings: [
      { title: 'Quality Engineer', externalPath: '/job/Mumbai/Quality-Engineer_ATCI-123' },           // no locationsText
      { title: 'Test Lead', externalPath: '/job/Remote-Poland/Test-Lead_ATCI-456', locationsText: '' }, // empty locationsText
      { title: 'QA Analyst', externalPath: '/job/Remote-Hungary/QA-Analyst_ATCI-789', locationsText: 'Remote, Hungary' }, // has locationsText — use it
    ],
  };
  const noLocParsed = parseWorkdayResponse(noLocJson, noLocEntry);
  if (noLocParsed[0]?.location === 'Mumbai') pass('parseWorkdayResponse falls back to URL path location when locationsText absent');
  else fail(`parseWorkdayResponse path fallback: expected "Mumbai", got ${JSON.stringify(noLocParsed[0]?.location)}`);
  if (noLocParsed[1]?.location === 'Remote Poland') pass('parseWorkdayResponse falls back to URL path location when locationsText empty');
  else fail(`parseWorkdayResponse path fallback empty: expected "Remote Poland", got ${JSON.stringify(noLocParsed[1]?.location)}`);
  if (noLocParsed[2]?.location === 'Remote, Hungary') pass('parseWorkdayResponse prefers locationsText over URL path when present');
  else fail(`parseWorkdayResponse locationsText priority: expected "Remote, Hungary", got ${JSON.stringify(noLocParsed[2]?.location)}`);

  // Malformed percent-encoding in an upstream externalPath is rejected without
  // throwing or aborting processing of other job records.
  const malformedPathJson = {
    jobPostings: [
      { title: 'Broken Encoding', externalPath: '/job/%E0%A4%A/Broken-Encoding_JR1' },
      { title: 'Fine Job', externalPath: '/job/Berlin/Fine-Job_JR2' },
    ],
  };
  try {
    const malformedParsed = parseWorkdayResponse(malformedPathJson, entry);
    if (malformedParsed.length === 1 && malformedParsed[0].location === 'Berlin') {
      pass('parseWorkdayResponse rejects malformed externalPath encoding without dropping valid records');
    } else {
      fail(`parseWorkdayResponse malformed encoding result = ${JSON.stringify(malformedParsed)}`);
    }
  } catch (e4) {
    fail(`parseWorkdayResponse should not throw on malformed percent-encoding: ${e4.message}`);
  }

  // parseWorkdayResponse — empty / malformed input
  if (parseWorkdayResponse({}, entry).length === 0) pass('parseWorkdayResponse({}) → empty result');
  else fail('parseWorkdayResponse({}) should be empty');

  if (parseWorkdayResponse({ jobPostings: null }, entry).length === 0) {
    pass('parseWorkdayResponse handles null jobPostings');
  } else {
    fail('parseWorkdayResponse null jobPostings should be empty');
  }

  // fetch() with mock ctx — uses total field to bound sequential pagination
  let postRequests = 0;
  const capturedRedirects = [];
  const fetchedJobs = await workday.fetch(entry, mkWorkdayCtx(async (_url, opts) => {
    postRequests++;
    capturedRedirects.push(opts?.redirect);
    const body = JSON.parse(opts.body);
    if (body.offset === 0) {
      return { total: 30, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Job P1-${i}`, externalPath: `/job/board/p1-${i}` })) };
    }
    return { total: 30, jobPostings: Array.from({ length: 10 }, (_, i) => ({ title: `Job P2-${i}`, externalPath: `/job/board/p2-${i}` })) };
  }));
  if (postRequests === 2 && fetchedJobs.length === 30) {
    pass('workday.fetch() uses total field to fetch exact pages sequentially (20+10=30)');
  } else {
    fail(`fetch pagination: requests=${postRequests}, total=${fetchedJobs.length} (expected 2 requests / 30 jobs)`);
  }

  if (capturedRedirects.length === 2 && capturedRedirects.every(r => r === 'error')) {
    pass('workday.fetch() passes redirect:"error" on every page (SSRF guard)');
  } else {
    fail(`workday.fetch() redirect opts across pages = ${JSON.stringify(capturedRedirects)}`);
  }

  // parseWorkdayResponse — null/undefined entries in jobPostings must be
  // skipped, not crash
  const sparseWorkday = { jobPostings: [null, undefined, { title: 'Real Job', externalPath: '/job/board/real-job' }] };
  try {
    const parsedSparseWorkday = parseWorkdayResponse(sparseWorkday, entry);
    if (parsedSparseWorkday.length === 1 && parsedSparseWorkday[0].title === 'Real Job') {
      pass('parseWorkdayResponse skips null/undefined entries without crashing');
    } else {
      fail(`parseWorkdayResponse sparse result = ${JSON.stringify(parsedSparseWorkday)}`);
    }
  } catch (e2) {
    fail(`parseWorkdayResponse should not throw on null/undefined entries: ${e2.message}`);
  }

  // fetch() pagination cap — an inflated `total` must not trigger unbounded
  // requests (DEFAULT_MAX_PAGES = 100 in providers/workday.mjs), and hitting
  // the cap must be visible (console.error), not silent — real tenants
  // (Dollar Tree, total=23,609; CVS Health, total=16,974) already exceed the
  // 100-page/2000-job default.
  let hugeWorkdayRequests = 0;
  const { result: fetchedHugeWorkday, errors: capturedWarnings } = await captureConsoleErrors(() =>
    workday.fetch(entry, mkWorkdayCtx(async (_url, opts) => {
      hugeWorkdayRequests++;
      const page = JSON.parse(opts.body).offset / 20;
      return { total: 1_000_000, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Job ${page}-${i}`, externalPath: `/job/board/${page}-${i}` })) };
    })));
  if (hugeWorkdayRequests === 100 && fetchedHugeWorkday.length === 2000) {
    pass('workday.fetch() caps pagination at DEFAULT_MAX_PAGES despite an inflated total');
  } else {
    fail(`workday fetch pagination cap: requests=${hugeWorkdayRequests}, total=${fetchedHugeWorkday.length} (expected 100/2000)`);
  }
  if (capturedWarnings.some(w => /truncated at max_pages=\d+/.test(w))) {
    pass('workday.fetch() warns (console.error) when the cap truncates real results');
  } else {
    fail(`workday fetch cap: expected a truncation warning, got ${JSON.stringify(capturedWarnings)}`);
  }
  if (providerCoverage(fetchedHugeWorkday)?.code === 'max_pages') {
    pass('workday page-cap truncation has typed partial coverage');
  } else {
    fail(`workday page-cap coverage missing: ${JSON.stringify(providerCoverage(fetchedHugeWorkday))}`);
  }

  // fetch() pagination cap — entry.max_pages raises the cap for a genuinely
  // large tenant (e.g. Deutsche Bank-scale postings)
  let overriddenWorkdayRequests = 0;
  const bigWorkdayEntry = { name: 'BigCo', careers_url: 'https://bigco.wd5.myworkdayjobs.com/careers', max_pages: 80 };
  const fetchedOverriddenWorkday = await workday.fetch(bigWorkdayEntry, mkWorkdayCtx(async (_url, opts) => {
    overriddenWorkdayRequests++;
    const page = JSON.parse(opts.body).offset / 20;
    return { total: 1_000_000, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Job ${page}-${i}`, externalPath: `/job/board/${page}-${i}` })) };
  }));
  if (overriddenWorkdayRequests === 80 && fetchedOverriddenWorkday.length === 1600) {
    pass('workday.fetch() honors entry.max_pages to raise the cap above the default');
  } else {
    fail(`workday fetch max_pages override: requests=${overriddenWorkdayRequests}, total=${fetchedOverriddenWorkday.length} (expected 80/1600)`);
  }

  // entry.max_pages is itself capped (MAX_PAGES_CAP = 1500) — an absurd
  // override can't turn this into an unbounded scan either.
  let absurdWorkdayRequests = 0;
  const absurdWorkdayEntry = { name: 'AbsurdCo', careers_url: 'https://absurdco.wd5.myworkdayjobs.com/careers', max_pages: 100_000 };
  const fetchedAbsurdWorkday = await workday.fetch(absurdWorkdayEntry, mkWorkdayCtx(async (_url, opts) => {
    absurdWorkdayRequests++;
    const page = JSON.parse(opts.body).offset / 20;
    return { total: 10_000_000, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Job ${page}-${i}`, externalPath: `/job/board/${page}-${i}` })) };
  }));
  if (absurdWorkdayRequests === 1500 && fetchedAbsurdWorkday.length === 30_000) {
    pass('workday.fetch() caps an absurd entry.max_pages at MAX_PAGES_CAP');
  } else {
    fail(`workday fetch max_pages hard cap: requests=${absurdWorkdayRequests}, total=${fetchedAbsurdWorkday.length} (expected 1500/30000)`);
  }

  // Invalid max_pages values (negative, zero, non-numeric) fall back to
  // DEFAULT_MAX_PAGES, same as omitting max_pages entirely.
  for (const invalidMaxPages of [-5, 0, 'abc', NaN, null]) {
    let invalidRequests = 0;
    const invalidEntry = { name: 'InvalidCo', careers_url: 'https://invalidco.wd5.myworkdayjobs.com/careers', max_pages: invalidMaxPages };
    const fetchedInvalid = await workday.fetch(invalidEntry, mkWorkdayCtx(async (_url, opts) => {
      invalidRequests++;
      const page = JSON.parse(opts.body).offset / 20;
      return { total: 1_000_000, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Job ${page}-${i}`, externalPath: `/job/board/${page}-${i}` })) };
    }));
    // Number.isNaN(NaN) is true but JSON.stringify(NaN) === 'null', which would
    // be indistinguishable from the literal `null` case in the log below.
    const label = Number.isNaN(invalidMaxPages) ? 'NaN' : JSON.stringify(invalidMaxPages);
    if (invalidRequests === 100 && fetchedInvalid.length === 2000) {
      pass(`workday.fetch() falls back to DEFAULT_MAX_PAGES for invalid max_pages=${label}`);
    } else {
      fail(`workday fetch invalid max_pages=${label}: requests=${invalidRequests}, total=${fetchedInvalid.length} (expected 100/2000)`);
    }
  }

  // fetch() pagination — a failure that persists across every retry attempt
  // on a later page returns the jobs gathered so far instead of discarding
  // everything (sequential, not Promise.all), retries MAX_RETRIES+1=4 times
  // on that page before giving up, and the failure itself is visible
  // (console.error), not silent. The truncation ("raise max_pages") warning
  // must NOT also fire — that knob does nothing for a rate-limited tenant.
  let flakyWorkdayRequests = 0;
  const { result: flakyWorkdayJobs, errors: flakyWarnings } = await captureConsoleErrors(() =>
    workday.fetch(entry, mkWorkdayCtx(async (_url, opts) => {
      flakyWorkdayRequests++;
      const body = JSON.parse(opts.body);
      const page = body.offset / 20; // PAGE_SIZE in providers/workday.mjs
      if (page === 2) { const err = new Error('HTTP 503'); err.status = 503; throw err; }
      return { total: 80, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Job p${page}-${i}`, externalPath: `/job/board/p${page}-${i}` })) };
    })));
  if (flakyWorkdayRequests === 6 && flakyWorkdayJobs.length === 40) {
    pass('workday.fetch() retries a failing page 4x then returns partial results');
  } else {
    fail(`workday fetch partial failure: requests=${flakyWorkdayRequests}, total=${flakyWorkdayJobs.length} (expected 6/40)`);
  }
  if (flakyWarnings.some(w => /truncated at \d+ of \d+ pages after 4 attempts/.test(w))) {
    pass('workday.fetch() warns (console.error) when a page fetch fails after exhausting retries, with the attempt count');
  } else {
    fail(`workday fetch page failure: expected a fetch-failed warning, got ${JSON.stringify(flakyWarnings)}`);
  }
  // The failure message must show scale — which page out of how many were
  // planned, and how many jobs came back out of the tenant's real total —
  // not just "page 3, 40 jobs" with no sense of how much was actually lost.
  // Same "truncated at ... (N of M jobs)" shape as the cap-hit warning below,
  // so the two read consistently.
  if (flakyWarnings.some(w => /truncated at 3 of 4 pages after 4 attempts \(40 of 80 jobs\): HTTP 503/.test(w))) {
    pass('workday.fetch() fetch-failure warning reports scale (page X of Y, N of total jobs)');
  } else {
    fail(`workday fetch-failure warning missing scale context: ${JSON.stringify(flakyWarnings)}`);
  }
  if (!flakyWarnings.some(w => /raise max_pages/.test(w))) {
    pass('workday.fetch() does NOT fire the "raise max_pages" warning on a fetch-error stop');
  } else {
    fail(`workday fetch-error stop should not also warn about max_pages: ${JSON.stringify(flakyWarnings)}`);
  }
  if (!flakyWorkdayJobs.providerDegraded && providerCoverage(flakyWorkdayJobs)?.code === 'fetch_error') {
    pass('workday fetch failure is represented once by typed coverage without the legacy degraded flag');
  } else {
    fail(`workday fetch-error coverage mismatch: ${JSON.stringify({ legacy: flakyWorkdayJobs.providerDegraded, coverage: providerCoverage(flakyWorkdayJobs) })}`);
  }

  // fetch() retry — a 429 that succeeds on a later attempt is transparent to
  // the caller (no jobs lost, no error surfaced) and respects Retry-After.
  let retrySleepCalls = [];
  let retryAttempts = 0;
  const retryEntry = { name: 'RetryCo', careers_url: 'https://retryco.wd5.myworkdayjobs.com/careers' };
  const retryJobs = await workday.fetch(retryEntry, mkWorkdayCtx(async () => {
    retryAttempts++;
    if (retryAttempts === 1) { const err = new Error('HTTP 429'); err.status = 429; err.retryAfter = '1'; throw err; }
    return { total: 1, jobPostings: [{ title: 'Recovered Job', externalPath: '/job/board/recovered' }] };
  }, { sleep: async (ms) => { retrySleepCalls.push(ms); } }));
  if (retryAttempts === 2 && retryJobs.length === 1 && retryJobs[0].title === 'Recovered Job') {
    pass('workday.fetch() retries a 429 and recovers transparently');
  } else {
    fail(`workday 429 retry: attempts=${retryAttempts}, jobs=${JSON.stringify(retryJobs)}`);
  }
  if (retrySleepCalls[0] === 1000) {
    pass('workday.fetch() honors Retry-After header for backoff delay');
  } else {
    fail(`workday retry-after: expected first backoff delay 1000ms, got ${JSON.stringify(retrySleepCalls)}`);
  }

  // fetch() retry — a hostile or misconfigured Retry-After (e.g. 86400s = a
  // full day) must not be honored verbatim: it's clamped to
  // RETRY_MAX_DELAY_MS * 4 (32s) so a single bad header can't stall a
  // tenant's fetch indefinitely, defeating the point of a bounded backoff.
  let hostileRetrySleepCalls = [];
  let hostileRetryAttempts = 0;
  const hostileRetryEntry = { name: 'HostileRetryCo', careers_url: 'https://hostileretryco.wd5.myworkdayjobs.com/careers' };
  await workday.fetch(hostileRetryEntry, mkWorkdayCtx(async () => {
    hostileRetryAttempts++;
    if (hostileRetryAttempts === 1) { const err = new Error('HTTP 429'); err.status = 429; err.retryAfter = '86400'; throw err; }
    return { total: 0, jobPostings: [] };
  }, { sleep: async (ms) => { hostileRetrySleepCalls.push(ms); } }));
  if (hostileRetrySleepCalls[0] === 32_000) {
    pass('workday.fetch() clamps an oversized Retry-After to RETRY_MAX_DELAY_MS * 4');
  } else {
    fail(`workday retry-after clamp: expected 32000ms, got ${JSON.stringify(hostileRetrySleepCalls)}`);
  }

  // fetch() retry — a non-retryable 4xx (e.g. malformed request) breaks
  // immediately, without wasting retry attempts.
  let non429Attempts = 0;
  const { result: non429Jobs } = await captureConsoleErrors(() =>
    workday.fetch(entry, mkWorkdayCtx(async (_url, opts) => {
      non429Attempts++;
      const body = JSON.parse(opts.body);
      if (body.offset === 0) return { total: 40, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Job ${i}`, externalPath: `/job/board/${i}` })) };
      const err = new Error('HTTP 400: bad request'); err.status = 400; throw err;
    })));
  if (non429Attempts === 2 && non429Jobs.length === 20) {
    pass('workday.fetch() does not retry a non-retryable 4xx error');
  } else {
    fail(`workday non-retryable 4xx: attempts=${non429Attempts}, jobs=${non429Jobs.length} (expected 2/20)`);
  }

  // fetch() early-stop — once a page's postings are all clearly past
  // ctx.sinceMs, pagination stops without hitting max_pages, and the
  // "raise max_pages" warning does NOT fire (this isn't a cap hit).
  const SINCE_DAYS = 3; // mirrors scan-ats-full.mjs's --since default
  const nowMs = Date.now();
  const sinceMs = nowMs - SINCE_DAYS * 86_400_000;
  let earlyStopRequests = 0;
  const { result: earlyStopJobs, errors: earlyStopWarnings } = await captureConsoleErrors(() =>
    workday.fetch(entry, mkWorkdayCtx(async (_url, opts) => {
      earlyStopRequests++;
      const body = JSON.parse(opts.body);
      const page = body.offset / 20;
      if (page === 0) {
        // Page 0: fresh postings, well within the window.
        return { total: 1_000_000, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Fresh ${i}`, externalPath: `/job/board/fresh-${i}`, postedOn: 'Posted Today' })) };
      }
      // Every later page: clearly stale (well past sinceMs - margin) — if
      // early-stop didn't work, this mock would be asked for 100 pages.
      return { total: 1_000_000, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Stale ${i}`, externalPath: `/job/board/stale-${i}`, postedOn: 'Posted 20 Days Ago' })) };
    }, { sinceMs })));
  if (earlyStopRequests === 2 && earlyStopJobs.length === 40) {
    pass('workday.fetch() stops paginating once a page is past --since (early-stop)');
  } else {
    fail(`workday early-stop: requests=${earlyStopRequests}, jobs=${earlyStopJobs.length} (expected 2/40)`);
  }
  if (!earlyStopWarnings.some(w => /truncated at/.test(w))) {
    pass('workday.fetch() does NOT warn about max_pages when it stopped early on --since');
  } else {
    fail(`workday early-stop should not warn about max_pages: ${JSON.stringify(earlyStopWarnings)}`);
  }

  // fetch() early-stop — a wide --since window (>= 30 days) never triggers
  // early-stop off the unbounded "30+ Days Ago" bucket; pagination still
  // proceeds until max_pages/total, as before. includeUndated: true isolates
  // this from the no-date-skip optimization tested separately below — every
  // posting here is undated ("30+"), which would otherwise short-circuit
  // after page 1 regardless of --since width.
  const WIDE_SINCE_DAYS = 90; // >= 30 — past the "30+ Days Ago" bucket's ambiguity threshold
  const wideSinceMs = nowMs - WIDE_SINCE_DAYS * 86_400_000;
  let wideRequests = 0;
  const wideJobs = await workday.fetch(entry, mkWorkdayCtx(async (_url, opts) => {
    wideRequests++;
    const body = JSON.parse(opts.body);
    if (body.offset === 0) {
      return { total: 40, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Old ${i}`, externalPath: `/job/board/old-${i}`, postedOn: 'Posted 30+ Days Ago' })) };
    }
    return { total: 40, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Old2 ${i}`, externalPath: `/job/board/old2-${i}`, postedOn: 'Posted 30+ Days Ago' })) };
  }, { sinceMs: wideSinceMs, includeUndated: true }));
  if (wideRequests === 2 && wideJobs.length === 40) {
    pass('workday.fetch() never early-stops off the unbounded "30+ Days Ago" bucket');
  } else {
    fail(`workday wide-since: requests=${wideRequests}, jobs=${wideJobs.length} (expected 2/40)`);
  }

  // fetch() cap-hit warning — reverse-scan context (ctx.sinceMs set, as
  // scan-ats-full.mjs always does) where entries are synthesized from an
  // external dataset, not portals.yml: there's no portal entry to edit, and
  // — per the "no fixed cap can guarantee full coverage" conclusion — no
  // fix to advise at all, so the message is just the short fact, with
  // neither "raise max_pages" nor a portals.yml edit suggested.
  // includeUndated: true forces this past the no-date-skip short-circuit
  // (tested separately below) so the fetch actually reaches the cap.
  const noDateSinceMs = nowMs - SINCE_DAYS * 86_400_000;
  const { errors: noDateWarnings } = await captureConsoleErrors(() =>
    workday.fetch(entry, mkWorkdayCtx(async (_url, opts) => {
      const page = JSON.parse(opts.body).offset / 20;
      return {
        total: 1_000_000,
        jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `NoDate ${page}-${i}`, externalPath: `/job/board/nodate-${page}-${i}` })), // no postedOn
      };
    }, { sinceMs: noDateSinceMs, includeUndated: true })));
  if (noDateWarnings.some(w => /truncated at \d+ pages/.test(w))) {
    pass('workday.fetch() cap-hit warning fires in reverse-scan context (tenant has no dates, includeUndated on)');
  } else {
    fail(`workday no-date cap warning missing: ${JSON.stringify(noDateWarnings)}`);
  }
  if (!noDateWarnings.some(w => /raise max_pages|portal entry|portals\.yml/.test(w))) {
    pass('workday.fetch() reverse-scan cap warning gives no inactionable advice (no portal entry to edit)');
  } else {
    fail(`workday reverse-scan cap warning should not suggest editing a portal entry: ${JSON.stringify(noDateWarnings)}`);
  }

  // fetch() no-date-skip — the default case (includeUndated NOT set, as
  // scan-ats-full.mjs leaves it by default): a tenant whose first page has
  // zero dated postings stops right there instead of grinding through up to
  // maxPages requests whose results would all be dropped as 'undated'
  // downstream anyway. Only 1 request should fire, not maxPages (100).
  const skipSinceMs = nowMs - SINCE_DAYS * 86_400_000;
  let skipRequests = 0;
  const { result: skipJobs, errors: skipWarnings } = await captureConsoleErrors(() =>
    workday.fetch(entry, mkWorkdayCtx(async () => {
      skipRequests++;
      return {
        total: 1_000_000,
        jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `NoDate ${i}`, externalPath: `/job/board/skip-${i}` })), // no postedOn
      };
    }, { sinceMs: skipSinceMs }))); // includeUndated intentionally omitted — the default, falsy case
  if (skipRequests === 1 && skipJobs.length === 20) {
    pass('workday.fetch() skips pagination after page 1 when includeUndated is off and the tenant has no dated postings');
  } else {
    fail(`workday no-date-skip: requests=${skipRequests}, jobs=${skipJobs.length} (expected 1/20)`);
  }
  // A full-directory scan hits this on a large fraction of tenants — a
  // console.error per occurrence would just be the same line thousands of
  // times, so the signal is a tag on the returned array instead (aggregated
  // by scan-ats-full.mjs into one summary line at the end of the run).
  if (skipJobs.workdayNoDateSkip === true) {
    pass('workday.fetch() tags the returned jobs array for no-date-skip aggregation');
  } else {
    fail(`workday no-date-skip tag missing: jobs.workdayNoDateSkip = ${JSON.stringify(skipJobs.workdayNoDateSkip)}`);
  }
  if (providerCoverage(skipJobs)?.code === 'no_date_skip' && !skipJobs.providerDegraded) {
    pass('workday no-date skip reports typed partial coverage without the legacy fetch-error flag');
  } else {
    fail(`workday no-date-skip coverage mismatch: ${JSON.stringify({ legacy: skipJobs.providerDegraded, coverage: providerCoverage(skipJobs) })}`);
  }
  if (skipWarnings.length === 0) {
    pass('workday.fetch() does not console.error per-company on a no-date-skip (aggregated instead)');
  } else {
    fail(`workday no-date-skip should not log anything directly: ${JSON.stringify(skipWarnings)}`);
  }

  // fetch() no-date-skip — does NOT trigger when includeUndated is true (the
  // "hit the cap while genuinely undated" scenario above already covers that
  // the fetch continues in that case); this just re-confirms the gate.
  let noSkipWithIncludeUndatedRequests = 0;
  const noSkipJobs = await workday.fetch(entry, mkWorkdayCtx(async (_url, opts) => {
    noSkipWithIncludeUndatedRequests++;
    const body = JSON.parse(opts.body);
    if (body.offset === 0) return { total: 40, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `ND ${i}`, externalPath: `/job/board/nd-${i}` })) };
    return { total: 40, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `ND2 ${i}`, externalPath: `/job/board/nd2-${i}` })) };
  }, { sinceMs: skipSinceMs, includeUndated: true }));
  if (noSkipWithIncludeUndatedRequests === 2 && noSkipJobs.length === 40) {
    pass('workday.fetch() does not no-date-skip when includeUndated is true');
  } else {
    fail(`workday no-date-skip gate: requests=${noSkipWithIncludeUndatedRequests}, jobs=${noSkipJobs.length} (expected 2/40)`);
  }

  // fetch() cap-hit warning — reverse-scan context, tenant genuinely has
  // more within --since than the cap allows (total far above the window,
  // e.g. cvshealth-scale): short line, no suspect-cap tag.
  const datedCapSinceMs = nowMs - SINCE_DAYS * 86_400_000;
  const { errors: datedCapWarnings } = await captureConsoleErrors(() =>
    workday.fetch(entry, mkWorkdayCtx(async (_url, opts) => {
      const page = JSON.parse(opts.body).offset / 20;
      return {
        total: 1_000_000,
        jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Fresh ${page}-${i}`, externalPath: `/job/board/fresh-${page}-${i}`, postedOn: 'Posted Today' })),
      };
    }, { sinceMs: datedCapSinceMs })));
  if (datedCapWarnings.some(w => /truncated at \d+ pages \(2000 of 1000000 jobs\)/.test(w))) {
    pass('workday.fetch() cap-hit warning reports the short "truncated at N pages" form');
  } else {
    fail(`workday dated cap-hit warning mismatch: ${JSON.stringify(datedCapWarnings)}`);
  }
  if (!datedCapWarnings.some(w => /Workday-capped/.test(w))) {
    pass('workday.fetch() cap-hit warning omits the suspected-Workday-cap tag when total is far above the window');
  } else {
    fail(`workday cap-hit warning should not suspect a Workday-side cap here (total=1,000,000, window=2,000): ${JSON.stringify(datedCapWarnings)}`);
  }

  // fetch() cap-hit warning — Workday's own CXS backend has been observed
  // reporting `total` as exactly maxPages*PAGE_SIZE even when the real count
  // is far higher (verified live: dickssportinggoods reported total=2000 but
  // its public careers page listed 7,120 openings, and offset=2000/4000
  // requests returned the same first posting as offset=0 instead of new
  // results). This exact-match case must carry a distinct, short tag.
  const suspectCapSinceMs = nowMs - SINCE_DAYS * 86_400_000;
  const { errors: suspectCapWarnings } = await captureConsoleErrors(() =>
    workday.fetch(entry, mkWorkdayCtx(async (_url, opts) => {
      const page = JSON.parse(opts.body).offset / 20;
      return {
        total: 2000, // === DEFAULT_MAX_PAGES (100) * PAGE_SIZE (20)
        jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Suspect ${page}-${i}`, externalPath: `/job/board/suspect-${page}-${i}`, postedOn: 'Posted Today' })),
      };
    }, { sinceMs: suspectCapSinceMs })));
  if (suspectCapWarnings.some(w => /\(total may be Workday-capped, not real\)/.test(w))) {
    pass('workday.fetch() cap-hit warning flags a suspected Workday-side total cap when total === maxPages*PAGE_SIZE');
  } else {
    fail(`workday suspected-cap tag missing: ${JSON.stringify(suspectCapWarnings)}`);
  }

  // Verify POST method was used
  let capturedMethod = null;
  await workday.fetch(entry, mkWorkdayCtx(async (_url, opts) => { capturedMethod = opts?.method; return { total: 0, jobPostings: [] }; }));
  if (capturedMethod === 'POST') pass('workday.fetch() uses POST method');
  else fail(`workday.fetch() method is ${JSON.stringify(capturedMethod)}, expected POST`);

  // Fallback: no total field — paginate sequentially until short page
  let fallbackRequests = 0;
  const fallbackJobs = await workday.fetch(entry, mkWorkdayCtx(async (_url, opts) => {
    fallbackRequests++;
    const body = JSON.parse(opts.body);
    if (body.offset === 0) return { jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `FB P1-${i}`, externalPath: `/job/board/fb-${i}` })) };
    return { jobPostings: Array.from({ length: 5 }, (_, i) => ({ title: `FB P2-${i}`, externalPath: `/job/board/fb2-${i}` })) };
  }));
  if (fallbackRequests === 2 && fallbackJobs.length === 25) {
    pass('workday.fetch() fallback (no total): paginates sequentially, stops on short page (20+5=25)');
  } else {
    fail(`fallback pagination: requests=${fallbackRequests}, jobs=${fallbackJobs.length} (expected 2/25)`);
  }

  // fetch() honors ctx.maxPages — verify-portals' liveness probe sets maxPages:1.
  // It must stop after the first page and NOT request page 2, which would trip
  // the probe's second-request sentinel; fetchPageWithRetry treats that abort as
  // transient and retries it MAX_RETRIES times (4 requests) plus a truncation
  // warning. Even though total=173 implies 9 pages, the cap must win at 1.
  let probeRequests = 0;
  const probeWarnings = [];
  const probeErr = console.error;
  console.error = (m) => probeWarnings.push(m);
  let probeJobs;
  try {
    probeJobs = await workday.fetch(entry, mkWorkdayCtx(async (_url, opts) => {
      probeRequests++;
      // Simulate the probe sentinel: any request past the first throws.
      if (JSON.parse(opts.body).offset > 0) throw new Error('probe budget: no second page');
      return { total: 173, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Job ${i}`, externalPath: `/job/board/${i}` })) };
    }, { maxPages: 1 }));
  } finally {
    console.error = probeErr;
  }
  if (probeRequests === 1 && probeJobs.length === 20) {
    pass('workday.fetch() honors ctx.maxPages=1 — one request, no second-page retry storm');
  } else {
    fail(`workday probe cap: requests=${probeRequests} (expected 1), jobs=${probeJobs?.length} (expected 20)`);
  }
  if (!probeWarnings.some((w) => /truncated/.test(String(w)))) {
    pass('workday.fetch() stays silent (no truncation warning) under the liveness probe cap');
  } else {
    fail(`workday probe should emit no warning, got: ${JSON.stringify(probeWarnings)}`);
  }
  let failedProbeRequests = 0;
  try {
    await workday.fetch(entry, mkWorkdayCtx(async () => {
      failedProbeRequests++;
      const error = new Error('liveness request failed');
      error.status = 503;
      throw error;
    }, { maxPages: 1 }));
  } catch { /* one failed probe is reported to the caller */ }
  if (failedProbeRequests === 1) {
    pass('workday liveness maxPages=1 also makes only one request when its first page fails');
  } else {
    fail(`workday failed liveness probe retried ${failedProbeRequests} times instead of once`);
  }

  // Endpoint identity is derived only from strict configured Workday URLs.
  const workdaySiteHit = workday.detect({
    name: 'Path Tenant',
    careers_url: 'https://wd5.myworkdaysite.com/recruiting/path-tenant/careers',
  });
  if (workdaySiteHit?.url === 'https://wd5.myworkdaysite.com/wday/cxs/path-tenant/careers/jobs') {
    pass('workday.detect() resolves configured myworkdaysite recruiting paths to the CXS endpoint');
  } else {
    fail(`workday.detect(myworkdaysite) returned ${JSON.stringify(workdaySiteHit)}`);
  }
  const workdaySiteJob = parseWorkdayResponse({ jobPostings: [{
    title: 'Path Job', externalPath: '/job/Finland/Path_1',
  }] }, { name: 'Path Tenant', careers_url: 'https://wd5.myworkdaysite.com/recruiting/path-tenant/careers' });
  if (workdaySiteJob[0]?.url === 'https://wd5.myworkdaysite.com/recruiting/path-tenant/careers/job/Finland/Path_1') {
    pass('parseWorkdayResponse retains configured myworkdaysite recruiting path in job URLs');
  } else {
    fail(`myworkdaysite public job URL mismatch: ${JSON.stringify(workdaySiteJob[0]?.url)}`);
  }
  const rejectedWorkdayUrls = [
    'https://user:secret@acme.wd5.myworkdayjobs.com/careers',
    'https://acme.wd5.myworkdayjobs.com:8443/careers',
    'https://acme.wd5.myworkdayjobs.com/careers/extra',
    'https://acme.wd5.myworkdayjobs.com/careers/../other',
    'https://wd5.myworkdaysite.com/recruiting/path-tenant',
    'https://wd5.myworkdaysite.com/recruiting/path-tenant/en-US/careers',
    'https://evil.example/recruiting/path-tenant/careers',
  ];
  if (rejectedWorkdayUrls.every((careers_url) => workday.detect({ name: 'Reject', careers_url }) === null)) {
    pass('workday.detect() rejects credentials, non-default ports, ambiguous paths, and untrusted hosts');
  } else {
    fail('workday.detect() accepted an unsafe or ambiguous configured URL');
  }

  // The configured facet IDs are opaque; the provider forwards them exactly.
  let capturedFacets = null;
  await workday.fetch({
    name: 'Faceted Co',
    careers_url: 'https://facetedco.wd5.myworkdayjobs.com/careers',
    workday: { appliedFacets: { '101': ['NYC', 'remote-site'], 'countryIsoCode': ['FI'] } },
  }, mkWorkdayCtx(async (_url, opts) => {
    capturedFacets = JSON.parse(opts.body).appliedFacets;
    return { total: 0, jobPostings: [] };
  }));
  if (JSON.stringify(capturedFacets) === JSON.stringify({ '101': ['NYC', 'remote-site'], countryIsoCode: ['FI'] })) {
    pass('workday.fetch() forwards configured opaque appliedFacets without inference');
  } else {
    fail(`workday appliedFacets were changed: ${JSON.stringify(capturedFacets)}`);
  }

  // Relative labels are anchored, and the unbounded 30+ label remains unknown.
  const relativeDates = parseWorkdayResponse({ jobPostings: [
    { title: 'Today', externalPath: '/job/board/today', postedOn: 'Posted Today' },
    { title: 'Yesterday', externalPath: '/job/board/yesterday', postedOn: 'Posted Yesterday' },
    { title: 'Old', externalPath: '/job/board/old', postedOn: 'Posted 30+ Days Ago' },
    { title: 'Unknown suffix', externalPath: '/job/board/unknown', postedOn: 'Posted Today - promoted' },
  ] }, entry);
  if (relativeDates[0].postedAt <= Date.now() && relativeDates[0].postedAt >= Date.now() - 1_000
      && relativeDates[1].postedAt < relativeDates[0].postedAt
      && relativeDates[2].postedAt === undefined && relativeDates[3].postedAt === undefined) {
    pass('parseWorkdayResponse keeps relative dates bounded and ambiguous labels unknown');
  } else {
    fail(`Workday relative date parsing mismatch: ${JSON.stringify(relativeDates.map((job) => job.postedAt))}`);
  }

  // Placeholder location lookup uses a trusted CXS detail URL, preserves all
  // primary/additional/country evidence, recovers a date and decodes HTML text.
  let detailRequests = [];
  const detailEntry = {
    name: 'Detail Co',
    careers_url: 'https://detailco.wd5.myworkdayjobs.com/en-US/detailco',
    workday: { detailLimit: 4 },
  };
  const detailJobs = await workday.fetch(detailEntry, mkWorkdayCtx(async (url, opts) => {
    if (opts.method === 'POST') {
      return { total: 1, jobPostings: [{
        title: 'Platform Engineer',
        externalPath: '/job/United-States/Platform-Engineer_JR4',
        locationsText: '12 Locations',
        postedOn: 'Posted 30+ Days Ago',
      }] };
    }
    detailRequests.push({ url, opts });
    return { jobPostingInfo: {
      startDate: '2026-09-20',
      location: { descriptor: 'Toronto', country: { descriptor: 'Canada', countryCode: 'CA' } },
      additionalLocations: [{ descriptor: 'Vancouver', country: { descriptor: 'Canada' } }, 'Remote, Canada'],
      countryName: 'Canada',
      jobDescription: '<p>R&amp;D&nbsp; engineer</p>',
    } };
  }));
  if (detailRequests.length === 1
      && detailRequests[0].url === 'https://detailco.wd5.myworkdayjobs.com/wday/cxs/detailco/detailco/job/United-States/Platform-Engineer_JR4'
      && detailRequests[0].opts.redirect === 'error'
      && detailJobs[0].location.includes('Toronto') && detailJobs[0].location.includes('Vancouver')
      && detailJobs[0].location.includes('Canada') && detailJobs[0].location.includes('CA')
      && detailJobs[0].postedAt === Date.parse('2026-09-20')
      && detailJobs[0].description === 'R&D engineer') {
    pass('workday.fetch() recovers placeholder locations/date/description from trusted detail evidence');
  } else {
    fail(`workday detail recovery mismatch: ${JSON.stringify({ detailRequests: detailRequests.map((item) => item.url), job: detailJobs[0] })}`);
  }
  if (!JSON.stringify(detailJobs).includes('detailLimit') && !JSON.stringify(detailJobs).includes('externalPath')) {
    pass('workday detail state and raw posting evidence stay out of job payloads');
  } else {
    fail('workday leaked internal detail state into serialized jobs');
  }

  let pathPlaceholderDetailCalls = 0;
  const pathPlaceholderJobs = await workday.fetch({
    name: 'Path Placeholder Co',
    careers_url: 'https://pathplaceholder.wd5.myworkdayjobs.com/careers',
  }, mkWorkdayCtx(async (_url, opts) => {
    if (opts.method === 'POST') return { total: 1, jobPostings: [{
      title: 'Path Placeholder', externalPath: '/job/Locations/Path_Placeholder',
    }] };
    pathPlaceholderDetailCalls++;
    return { jobPostingInfo: { location: 'Riga, Latvia' } };
  }));
  if (pathPlaceholderDetailCalls === 1 && pathPlaceholderJobs[0].location === 'Riga, Latvia') {
    pass('workday recovers geography when the externalPath itself only says Locations');
  } else {
    fail(`workday path placeholder was not enriched: ${JSON.stringify({ calls: pathPlaceholderDetailCalls, job: pathPlaceholderJobs[0] })}`);
  }

  // The same ctx can serve several boards; each board keeps its own detail
  // cache and budget, and enrichDate uses the job-bound state after fetch.
  let sharedCtxDetailUrls = [];
  const sharedCtx = mkWorkdayCtx(async (url, opts) => {
    if (opts.method === 'POST') return { total: 1, jobPostings: [{
      title: 'Undated Job', externalPath: '/job/Remote/Undated_1', locationsText: 'Remote', postedOn: 'Posted 30+ Days Ago',
    }] };
    sharedCtxDetailUrls.push(url);
    return { jobPostingInfo: { startDate: '2026-09-25', location: 'Helsinki, Finland' } };
  });
  const firstBoardJobs = await workday.fetch({ name: 'One', careers_url: 'https://one.wd5.myworkdayjobs.com/careers' }, sharedCtx);
  const secondBoardJobs = await workday.fetch({ name: 'Two', careers_url: 'https://two.wd5.myworkdayjobs.com/careers' }, sharedCtx);
  await workday.enrichDate(firstBoardJobs[0], sharedCtx);
  await workday.enrichDate(secondBoardJobs[0], sharedCtx);
  if (sharedCtxDetailUrls.length === 2
      && sharedCtxDetailUrls[0].includes('/wday/cxs/one/careers/')
      && sharedCtxDetailUrls[1].includes('/wday/cxs/two/careers/')
      && firstBoardJobs[0].postedAt === Date.parse('2026-09-25')
      && secondBoardJobs[0].postedAt === Date.parse('2026-09-25')) {
    pass('workday.enrichDate() reuses job-bound board state when scanner ctx is shared across boards');
  } else {
    fail(`workday shared-ctx board binding mismatch: ${JSON.stringify({ urls: sharedCtxDetailUrls, first: firstBoardJobs[0], second: secondBoardJobs[0] })}`);
  }

  // Retries consume the same per-board detail budget. Exhaustion leaves later
  // jobs intact and makes partial coverage visible exactly once.
  let boundedDetailAttempts = 0;
  const boundedDetails = await workday.fetch({
    name: 'Budget Co',
    careers_url: 'https://budgetco.wd5.myworkdayjobs.com/careers',
    workday: { detailLimit: 3 },
  }, mkWorkdayCtx(async (url, opts) => {
    if (opts.method === 'POST') return { total: 2, jobPostings: [1, 2].map((n) => ({
      title: `Job ${n}`, externalPath: `/job/Locations/Job_${n}`, locationsText: '10 Locations',
    })) };
    boundedDetailAttempts++;
    if (boundedDetailAttempts < 3) { const error = new Error('HTTP 503'); error.status = 503; throw error; }
    return { jobPostingInfo: { startDate: '2026-09-01', location: 'Oulu, Finland' } };
  }));
  const boundedCoverage = providerCoverage(boundedDetails);
  if (boundedDetailAttempts === 3 && boundedDetails.length === 2
      && boundedDetails[0].postedAt === Date.parse('2026-09-01')
      && boundedDetails[1].location === '10 Locations'
      && boundedCoverage?.status === 'partial' && boundedCoverage.code === 'detail_budget') {
    pass('workday detail retries consume the bounded budget and report visible partial coverage');
  } else {
    fail(`workday detail budget mismatch: ${JSON.stringify({ attempts: boundedDetailAttempts, coverage: boundedCoverage, jobs: boundedDetails })}`);
  }

  let lastBudgetAttemptCalls = 0;
  const lastBudgetAttemptJobs = await workday.fetch({
    name: 'Last Attempt Co',
    careers_url: 'https://lastattemptco.wd5.myworkdayjobs.com/careers',
    workday: { detailLimit: 1 },
  }, mkWorkdayCtx(async (_url, opts) => {
    if (opts.method === 'POST') return { total: 1, jobPostings: [{
      title: 'One Attempt', externalPath: '/job/Locations/One_Attempt', locationsText: '5 Locations',
    }] };
    lastBudgetAttemptCalls++;
    const error = new Error('HTTP 503');
    error.status = 503;
    throw error;
  }));
  if (lastBudgetAttemptCalls === 1 && providerCoverage(lastBudgetAttemptJobs)?.code === 'detail_fetch_error') {
    pass('workday reports a failed final detail HTTP attempt as fetch failure, not budget exhaustion');
  } else {
    fail(`workday final detail-attempt classification mismatch: ${JSON.stringify({ attempts: lastBudgetAttemptCalls, coverage: providerCoverage(lastBudgetAttemptJobs) })}`);
  }

  let zeroLimitDetailCalls = 0;
  const zeroLimitJobs = await workday.fetch({
    name: 'No Details Co',
    careers_url: 'https://nodetailsco.wd5.myworkdayjobs.com/careers',
    workday: { detailLimit: 0 },
  }, mkWorkdayCtx(async (_url, opts) => {
    if (opts.method === 'POST') return { total: 1, jobPostings: [{
      title: 'No Details', externalPath: '/job/Locations/No_Details', locationsText: '5 Locations',
    }] };
    zeroLimitDetailCalls++;
    return { jobPostingInfo: { location: 'Helsinki' } };
  }));
  if (zeroLimitDetailCalls === 0 && providerCoverage(zeroLimitJobs)?.code === 'detail_budget') {
    pass('workday detailLimit=0 skips HTTP and marks required detail recovery as partial');
  } else {
    fail(`workday zero detail limit mismatch: ${JSON.stringify({ detailCalls: zeroLimitDetailCalls, coverage: providerCoverage(zeroLimitJobs) })}`);
  }

  let refusedDetailAttempts = 0;
  const refusedDetails = await workday.fetch({
    name: 'Redirect Co',
    careers_url: 'https://redirectco.wd5.myworkdayjobs.com/careers',
    workday: { detailLimit: 10 },
  }, mkWorkdayCtx(async (_url, opts) => {
    if (opts.method === 'POST') return { total: 1, jobPostings: [{
      title: 'Redirected Detail', externalPath: '/job/Locations/Redirected', locationsText: '5 Locations',
    }] };
    refusedDetailAttempts++;
    const error = new Error('redirect refused');
    error.code = 'ECAREEROPS_REDIRECT_REFUSED';
    error.redirectRefused = true;
    throw error;
  }));
  if (refusedDetailAttempts === 1 && providerCoverage(refusedDetails)?.code === 'detail_fetch_error') {
    pass('workday refuses detail redirects without retrying an untrusted target');
  } else {
    fail(`workday detail redirect refusal mismatch: ${JSON.stringify({ attempts: refusedDetailAttempts, coverage: providerCoverage(refusedDetails) })}`);
  }

  let lateDetailAttempts = 0;
  const lateDetailCtx = mkWorkdayCtx(async (_url, opts) => {
    if (opts.method === 'POST') return { total: 1, jobPostings: [{
      title: 'Late Detail', externalPath: '/job/Remote/Late_Detail', locationsText: 'Remote', postedOn: 'Posted 30+ Days Ago',
    }] };
    lateDetailAttempts++;
    const error = new Error('HTTP 404: detail removed');
    error.status = 404;
    throw error;
  });
  const lateDetailJobs = await workday.fetch({
    name: 'Late Detail Co', careers_url: 'https://latedetailco.wd5.myworkdayjobs.com/careers',
  }, lateDetailCtx);
  const coverageBeforeHook = providerCoverage(lateDetailJobs);
  await workday.enrichDate(lateDetailJobs[0], lateDetailCtx);
  if (coverageBeforeHook === null && lateDetailAttempts === 1
      && providerCoverage(lateDetailJobs)?.code === 'detail_fetch_error') {
    pass('workday late enrichDate failures attach typed partial coverage to the original jobs array');
  } else {
    fail(`workday late enrichment coverage mismatch: ${JSON.stringify({ before: coverageBeforeHook, after: providerCoverage(lateDetailJobs), attempts: lateDetailAttempts })}`);
  }

  const invalidDateCtx = mkWorkdayCtx(async (_url, opts) => {
    if (opts.method === 'POST') return { total: 1, jobPostings: [{
      title: 'Bad Date', externalPath: '/job/Remote/Bad_Date', locationsText: 'Remote', postedOn: 'Posted 30+ Days Ago',
    }] };
    return { jobPostingInfo: { startDate: '2026-02-30', date: 'recently' } };
  });
  const invalidDateJobs = await workday.fetch({ name: 'Invalid Date Co', careers_url: 'https://invaliddateco.wd5.myworkdayjobs.com/careers' }, invalidDateCtx);
  await workday.enrichDate(invalidDateJobs[0], invalidDateCtx);
  if (invalidDateJobs[0].postedAt === undefined) {
    pass('workday leaves invalid and ambiguous detail dates unknown');
  } else {
    fail(`workday accepted an invalid detail date: ${JSON.stringify(invalidDateJobs[0].postedAt)}`);
  }

  const dateEvidenceJobs = await workday.fetch({
    name: 'Date Evidence Co',
    careers_url: 'https://dateevidence.wd5.myworkdayjobs.com/careers',
  }, mkWorkdayCtx(async (url, opts) => {
    if (opts.method === 'POST') return { total: 3, jobPostings: [
      ['Offsetless', 'Posted 30+ Days Ago'],
      ['Offset', 'Posted 30+ Days Ago'],
      ['DateOnly', 'Posted 30+ Days Ago'],
    ].map(([role, postedOn]) => ({
      title: role, externalPath: `/job/Locations/${role}`, locationsText: '1 Location', postedOn,
    })) };
    const startDate = url.includes('/Offsetless') ? '2026-09-20T12:00:00'
      : url.includes('/Offset') ? '2026-09-20T12:00:00+02:00' : '2026-09-20';
    return { jobPostingInfo: { startDate, location: 'Helsinki, Finland' } };
  }));
  if (dateEvidenceJobs[0].postedAt === undefined
      && dateEvidenceJobs[1].postedAt === Date.parse('2026-09-20T12:00:00+02:00')
      && dateEvidenceJobs[2].postedAt === Date.parse('2026-09-20')) {
    pass('workday rejects offsetless date-times and accepts explicit-offset and date-only evidence');
  } else {
    fail(`workday date evidence timezone handling mismatch: ${JSON.stringify(dateEvidenceJobs.map((job) => job.postedAt))}`);
  }

  const invalidDetailShapeJobs = await workday.fetch({
    name: 'Invalid Detail Shape Co',
    careers_url: 'https://invalidshape.wd5.myworkdayjobs.com/careers',
  }, mkWorkdayCtx(async (_url, opts) => {
    if (opts.method === 'POST') return { total: 1, jobPostings: [{
      title: 'Invalid Detail Shape', externalPath: '/job/Locations/Invalid_Shape', locationsText: '4 Locations',
    }] };
    return { startDate: '2026-09-20', location: 'Helsinki, Finland' };
  }));
  if (invalidDetailShapeJobs[0].postedAt === undefined
      && invalidDetailShapeJobs[0].location === '4 Locations'
      && providerCoverage(invalidDetailShapeJobs)?.code === 'detail_invalid') {
    pass('workday ignores unwrapped detail lookalikes and reports invalid detail evidence');
  } else {
    fail(`workday accepted malformed detail evidence: ${JSON.stringify({ job: invalidDetailShapeJobs[0], coverage: providerCoverage(invalidDetailShapeJobs) })}`);
  }

  // Listing-only liveness checks remain exactly one request and do not spend
  // the detail budget even when the response contains placeholder geography.
  let livenessDetails = 0;
  const placeholderProbe = await workday.fetch(detailEntry, mkWorkdayCtx(async (_url, opts) => {
    if (opts.method === 'POST') return { total: 100, jobPostings: [{
      title: 'Probe Job', externalPath: '/job/Remote/Probe', locationsText: 'Multiple Locations',
    }] };
    livenessDetails++;
    return { jobPostingInfo: { location: 'Helsinki' } };
  }, { maxPages: 1 }));
  if (placeholderProbe.length === 1 && livenessDetails === 0 && providerCoverage(placeholderProbe) === null) {
    pass('workday ctx.maxPages=1 avoids detail requests and stays a full one-request liveness probe');
  } else {
    fail(`workday liveness detail suppression mismatch: ${JSON.stringify({ details: livenessDetails, coverage: providerCoverage(placeholderProbe) })}`);
  }

  // Repeated offset pages are structural truncation, not a cap hit; a valid
  // empty directory is complete, while deadboard/error payloads remain errors.
  let repeatedCalls = 0;
  const repeatedJobs = await workday.fetch({ name: 'Repeat', careers_url: 'https://repeat.wd5.myworkdayjobs.com/careers' }, mkWorkdayCtx(async () => {
    repeatedCalls++;
    return { total: 100, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Repeat ${i}`, externalPath: `/job/Repeat/Job_${i}` })) };
  }));
  if (repeatedCalls === 2 && repeatedJobs.length === 20 && providerCoverage(repeatedJobs)?.code === 'repeated_page') {
    pass('workday.fetch() stops safely and reports typed coverage when a structural page repeats');
  } else {
    fail(`workday repeated-page result mismatch: ${JSON.stringify({ requests: repeatedCalls, jobs: repeatedJobs.length, coverage: providerCoverage(repeatedJobs) })}`);
  }
  // Later pages may report total=0 (first-page total is authoritative); empty
  // later pages fail closed unless the board shrank to or below the offset.
  const mkPaged = (secondPage) => async (_url, opts) => {
    const offset = JSON.parse(opts.body).offset;
    const rows = (prefix) => Array.from({ length: 20 }, (_, i) => ({ title: `${prefix} ${i}`, externalPath: `/job/${prefix}/Job_${i}` }));
    return offset === 0 ? { total: 40, jobPostings: rows('First') } : secondPage(rows);
  };
  const laterZero = await workday.fetch({ name: 'LaterZero', careers_url: 'https://laterzero.wd5.myworkdayjobs.com/careers' },
    mkWorkdayCtx(mkPaged((rows) => ({ total: 0, jobPostings: rows('Second') }))));
  if (laterZero.length === 40 && providerCoverage(laterZero) === null) {
    pass('workday accepts later pages that report total=0 with postings');
  } else {
    fail(`workday later total=0 page mismatch: ${JSON.stringify({ jobs: laterZero.length, coverage: providerCoverage(laterZero) })}`);
  }
  let firstZeroRejected = false;
  try {
    await workday.fetch({ name: 'FirstZero', careers_url: 'https://firstzero.wd5.myworkdayjobs.com/careers' },
      mkWorkdayCtx(async () => ({ total: 0, jobPostings: [{ title: 'Zero', externalPath: '/job/Zero/Job_1' }] })));
  } catch { firstZeroRejected = true; }
  if (firstZeroRejected) {
    pass('workday still rejects first page with postings and total=0');
  } else {
    fail('workday accepted first page with postings and total=0');
  }
  const laterEmptyZero = await workday.fetch({ name: 'LaterEmptyZero', careers_url: 'https://lateremptyzero.wd5.myworkdayjobs.com/careers' },
    mkWorkdayCtx(mkPaged(() => ({ total: 0, jobPostings: [] }))));
  if (laterEmptyZero.length === 20 && providerCoverage(laterEmptyZero)?.code === 'invalid_page') {
    pass('workday fails closed on an empty later page with total=0 while rows remain');
  } else {
    fail(`workday empty later total=0 mismatch: ${JSON.stringify({ jobs: laterEmptyZero.length, coverage: providerCoverage(laterEmptyZero) })}`);
  }
  const shrunk = await workday.fetch({ name: 'Shrunk', careers_url: 'https://shrunk.wd5.myworkdayjobs.com/careers' },
    mkWorkdayCtx(mkPaged(() => ({ total: 20, jobPostings: [] }))));
  if (shrunk.length === 20 && providerCoverage(shrunk) === null) {
    pass('workday completes cleanly when a later empty page reports a shrunken positive total');
  } else {
    fail(`workday shrinkage mismatch: ${JSON.stringify({ jobs: shrunk.length, coverage: providerCoverage(shrunk) })}`);
  }
  const emptyBoard = await workday.fetch({ name: 'Empty', careers_url: 'https://empty.wd5.myworkdayjobs.com/careers' }, mkWorkdayCtx(async () => ({ total: 0, jobPostings: [] })));
  let deadBoardRejected = false;
  try {
    await workday.fetch({ name: 'Dead', careers_url: 'https://dead.wd5.myworkdayjobs.com/careers' }, mkWorkdayCtx(async () => ({ errorCode: 'BOARD_NOT_FOUND', total: 0, jobPostings: [] })));
  } catch { deadBoardRejected = true; }
  if (emptyBoard.length === 0 && providerCoverage(emptyBoard) === null && deadBoardRejected) {
    pass('workday distinguishes a complete empty board from an explicit deadboard response');
  } else {
    fail(`workday empty/deadboard result mismatch: ${JSON.stringify({ empty: emptyBoard.length, coverage: providerCoverage(emptyBoard), deadBoardRejected })}`);
  }

  // A mixed page cannot be considered stale just because one row is old.
  const mixedSince = Date.now() - 3 * 86_400_000;
  let mixedPageCalls = 0;
  const mixedPageJobs = await workday.fetch({ name: 'Mixed', careers_url: 'https://mixed.wd5.myworkdayjobs.com/careers', max_pages: 4 }, mkWorkdayCtx(async (_url, opts) => {
    const page = JSON.parse(opts.body).offset / 20;
    mixedPageCalls++;
    const posting = (index, postedOn) => ({ title: `Mixed ${page}-${index}`, externalPath: `/job/Mixed/${page}-${index}`, postedOn });
    if (page === 0) return { total: 80, jobPostings: Array.from({ length: 20 }, (_, i) => posting(i, 'Posted Today')) };
    if (page === 1) return { total: 80, jobPostings: [...Array.from({ length: 18 }, (_, i) => posting(i, 'Posted 20 Days Ago')), posting(18, 'Posted Today'), posting(19, 'Posted 30+ Days Ago')] };
    return { total: 80, jobPostings: Array.from({ length: 20 }, (_, i) => posting(i, 'Posted 20 Days Ago')) };
  }, { sinceMs: mixedSince, includeUndated: true }));
  if (mixedPageCalls === 3 && mixedPageJobs.length === 60) {
    pass('workday since-aware pagination continues across a page with mixed fresh and stale rows');
  } else {
    fail(`workday mixed-page early-stop mismatch: ${JSON.stringify({ requests: mixedPageCalls, jobs: mixedPageJobs.length })}`);
  }

  // Unsafe posting paths are rejected before they can become detail requests.
  const unsafePosting = parseWorkdayResponse({ jobPostings: [
    { title: 'Escape', externalPath: '/job/../wday/cxs/other/jobs' },
    { title: 'Foreign', externalPath: '//evil.example/job/Role' },
  ] }, entry);
  if (unsafePosting.length === 0) pass('parseWorkdayResponse rejects traversal and protocol-relative external paths');
  else fail(`Workday unsafe externalPath accepted: ${JSON.stringify(unsafePosting)}`);

} catch (e) {
  fail(`workday provider tests crashed: ${e.message}`);
}
