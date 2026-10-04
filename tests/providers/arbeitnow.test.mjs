// tests/providers/arbeitnow.test.mjs — moved verbatim from test-all.mjs (#1440).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — arbeitnow');

try {
  const arbeitnowModule = await import(pathToFileURL(join(ROOT, 'providers/arbeitnow.mjs')).href);
  const arbeitnow = arbeitnowModule.default;
  const { normalizeArbeitnowJob } = arbeitnowModule;
  const { providerCoverage } = await import(pathToFileURL(join(ROOT, 'providers/_result.mjs')).href);

  if (arbeitnow.id === 'arbeitnow') pass('arbeitnow.id is "arbeitnow"');
  else fail(`arbeitnow.id is ${JSON.stringify(arbeitnow.id)}`);

  // normalizeArbeitnowJob — field mapping.
  const full = normalizeArbeitnowJob(
    { title: '  Staff AI Engineer  ', url: '  https://www.arbeitnow.com/jobs/x1  ', company_name: '  Acme Co  ', location: '  Berlin  ', remote: false, description: '  <p>Minimum 5 years of professional data engineering experience.</p>  ', created_at: 1782693032 },
    'Fallback',
  );
  if (full && full.title === 'Staff AI Engineer' && full.url === 'https://www.arbeitnow.com/jobs/x1'
      && full.company === 'Acme Co' && full.location === 'Berlin'
      && full.description === '<p>Minimum 5 years of professional data engineering experience.</p>'
      && full.postedAt === 1782693032000) {
    pass('normalizeArbeitnowJob maps + trims title/url/company/location and converts created_at seconds → ms');
  } else {
    fail(`normalizeArbeitnowJob full row = ${JSON.stringify(full)}`);
  }

  const missingDescriptions = [
    normalizeArbeitnowJob({ title: 'T', url: 'https://www.arbeitnow.com/jobs/no-description' }),
    normalizeArbeitnowJob({ title: 'T', url: 'https://www.arbeitnow.com/jobs/null-description', description: null }),
    normalizeArbeitnowJob({ title: 'T', url: 'https://www.arbeitnow.com/jobs/empty-description', description: '   ' }),
  ];
  if (missingDescriptions.every(job => job && !('description' in job))) {
    pass('normalizeArbeitnowJob safely omits absent, null, and empty descriptions');
  } else {
    fail(`normalizeArbeitnowJob missing descriptions = ${JSON.stringify(missingDescriptions)}`);
  }

  // remote:true appends "Remote" to the location.
  const remoteJob = normalizeArbeitnowJob({ title: 'R', url: 'https://www.arbeitnow.com/jobs/r', location: 'Munich', remote: true }, 'X');
  if (remoteJob?.location === 'Munich, Remote') pass('normalizeArbeitnowJob appends "Remote" when remote is true');
  else fail(`normalizeArbeitnowJob remote location = ${JSON.stringify(remoteJob?.location)}`);

  // remote-only (no base location) → "Remote".
  const remoteOnly = normalizeArbeitnowJob({ title: 'R', url: 'https://www.arbeitnow.com/jobs/r2', remote: true }, 'X');
  if (remoteOnly?.location === 'Remote') pass('normalizeArbeitnowJob yields "Remote" when remote is true and location is absent');
  else fail(`normalizeArbeitnowJob remote-only location = ${JSON.stringify(remoteOnly?.location)}`);

  // company fallbacks: entry name, then "Arbeitnow".
  const coFromEntry = normalizeArbeitnowJob({ title: 'T', url: 'https://www.arbeitnow.com/jobs/c1', company_name: '' }, 'Entry Name');
  const coDefault = normalizeArbeitnowJob({ title: 'T', url: 'https://www.arbeitnow.com/jobs/c2' });
  if (coFromEntry?.company === 'Entry Name' && coDefault?.company === 'Arbeitnow') {
    pass('normalizeArbeitnowJob falls back company → entry name → "Arbeitnow"');
  } else {
    fail(`normalizeArbeitnowJob company fallbacks = ${JSON.stringify({ a: coFromEntry?.company, b: coDefault?.company })}`);
  }

  // drops: empty title, missing url, non-https url, malformed url, non-object.
  const drops = [
    normalizeArbeitnowJob({ title: '', url: 'https://www.arbeitnow.com/jobs/d1' }),
    normalizeArbeitnowJob({ title: 'No URL' }),
    normalizeArbeitnowJob({ title: 'Insecure', url: 'http://www.arbeitnow.com/jobs/d3' }),
    normalizeArbeitnowJob({ title: 'Relative', url: '/jobs/d4' }),
    normalizeArbeitnowJob({ title: 'Off host', url: 'https://evil.example/jobs/d5' }), // host-lock: external https dropped
    normalizeArbeitnowJob(null),
  ];
  if (drops.every(r => r === null)) pass('normalizeArbeitnowJob drops empty-title / no-url / non-https / relative / off-host / non-object');
  else fail(`normalizeArbeitnowJob drops = ${JSON.stringify(drops)}`);

  // missing created_at → no postedAt key.
  const noDate = normalizeArbeitnowJob({ title: 'T', url: 'https://www.arbeitnow.com/jobs/nd' });
  if (noDate && !('postedAt' in noDate)) pass('normalizeArbeitnowJob omits postedAt when created_at is absent');
  else fail(`normalizeArbeitnowJob postedAt presence = ${JSON.stringify(noDate)}`);

  // fetch(): pagination by self-built ?page=N, stop when links.next is null.
  const mk = (i) => ({ title: `Role ${i}`, url: `https://www.arbeitnow.com/jobs/x${i}`, company_name: `Co ${i}`, location: 'Berlin', remote: false, created_at: 1782693032 + i });
  const noWait = async () => {};
  const page1 = Array.from({ length: 100 }, (_, i) => mk(i));            // full page → continue
  const page2 = [mk(100), mk(101), { title: '', url: 'https://www.arbeitnow.com/jobs/bad' }]; // short page (3 < 100) → stop; 1 drop
  const requested = [];
  const pagedFetch = async (url, opts) => {
    requested.push({ url, redirect: opts?.redirect });
    const u = new URL(url);
    const page = Number(u.searchParams.get('page'));
    // links.next deliberately points at a featured ?search= URL to prove we DON'T follow it.
    if (page === 1) return { data: page1, links: { next: 'https://www.arbeitnow.com/api/job-board-api?search=foo&page=2' }, meta: {} };
    if (page === 2) return { data: page2, links: { next: null }, meta: {} };
    return { data: [], links: {}, meta: {} };
  };

  const paged = await arbeitnow.fetch({ name: 'Arbeitnow' }, { fetchJson: pagedFetch, sleep: noWait });

  if (requested.length === 2
      && requested[0].url === 'https://www.arbeitnow.com/api/job-board-api?page=1'
      && requested[1].url === 'https://www.arbeitnow.com/api/job-board-api?page=2') {
    pass('arbeitnow.fetch() builds ?page=N URLs itself and stops when links.next is null');
  } else {
    fail(`arbeitnow.fetch() requested = ${JSON.stringify(requested.map(r => r.url))}`);
  }

  if (requested.every(r => r.redirect === 'error')) pass('arbeitnow.fetch() passes redirect:"error" on every page (SSRF guard)');
  else fail(`arbeitnow.fetch() redirect opts = ${JSON.stringify(requested.map(r => r.redirect))}`);

  if (paged.length === 102) pass('arbeitnow.fetch() aggregates valid jobs across pages (100 + 2, dropping the empty-title row)');
  else fail(`arbeitnow.fetch() returned ${paged.length} jobs (expected 102)`);
  if (providerCoverage(paged) === null) pass('arbeitnow.fetch() reports full coverage when links.next reaches null');
  else fail(`arbeitnow.fetch() full coverage metadata = ${JSON.stringify(providerCoverage(paged))}`);

  // The live API can return unusual page sizes, so links.next—not row count—is authoritative.
  const unusualCalls = [];
  const unusual = await arbeitnow.fetch(
    { name: 'Arbeitnow', max_pages: 3 },
    { fetchJson: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      unusualCalls.push(page);
      return page === 1
        ? { data: [mk(200), mk(201)], links: { next: 'https://www.arbeitnow.com/api/job-board-api?page=2' } }
        : { data: [mk(202)], links: { next: null } };
    }, sleep: noWait },
  );
  if (unusualCalls.join(',') === '1,2' && unusual.length === 3 && providerCoverage(unusual) === null) {
    pass('arbeitnow.fetch() follows authoritative pagination despite a short intermediate page');
  } else {
    fail(`arbeitnow.fetch() unusual pages = ${JSON.stringify({ calls: unusualCalls, jobs: unusual.length, coverage: providerCoverage(unusual) })}`);
  }

  // max_pages cap: only the first page is requested even though it is full.
  const capRequested = [];
  const capped = await arbeitnow.fetch(
    { name: 'Arbeitnow', max_pages: 1 },
    { fetchJson: async (url, opts) => { capRequested.push(url); return { data: Array.from({ length: 100 }, (_, i) => mk(i)), links: { next: 'https://www.arbeitnow.com/api/job-board-api?page=2' } }; }, sleep: noWait },
  );
  if (capRequested.length === 1 && capRequested[0] === 'https://www.arbeitnow.com/api/job-board-api?page=1') {
    pass('arbeitnow.fetch() honors max_pages (stops at the cap even on a full page)');
  } else {
    fail(`arbeitnow.fetch() max_pages:1 requested ${JSON.stringify(capRequested)}`);
  }
  const cappedCoverage = providerCoverage(capped);
  if (capped.length === 100 && cappedCoverage?.code === 'max_pages'
      && cappedCoverage.pagesFetched === 1 && cappedCoverage.maxPages === 1) {
    pass('arbeitnow.fetch() retains capped jobs and reports structured partial coverage');
  } else {
    fail(`arbeitnow.fetch() cap coverage = ${JSON.stringify(cappedCoverage)}`);
  }

  const duplicateCompatible = await arbeitnow.fetch(
    { name: 'Arbeitnow' },
    { fetchJson: async () => ({ data: [mk(300), mk(300)], links: { next: null } }), sleep: noWait },
  );
  if (duplicateCompatible.length === 2) {
    pass('arbeitnow.fetch() leaves cross-provider/global dedup to the scanner as before');
  } else {
    fail(`arbeitnow.fetch() changed duplicate output semantics: ${duplicateCompatible.length}`);
  }

  // unexpected API response → throws.
  const httpError = (status, message = `HTTP ${status}`) => {
    const error = new Error(message);
    error.status = status;
    return error;
  };

  // A transient first-page 429 retries deterministically and recovers.
  let first429Attempts = 0;
  const first429Sleeps = [];
  const first429 = await arbeitnow.fetch(
    { name: 'RetryCo' },
    {
      fetchJson: async () => {
        first429Attempts++;
        if (first429Attempts === 1) {
          const error = httpError(429);
          error.retryAfter = '2';
          throw error;
        }
        return { data: [mk(400)], links: { next: null } };
      },
      sleep: async (ms) => { first429Sleeps.push(ms); },
    },
  );
  if (first429Attempts === 2 && first429.length === 1 && providerCoverage(first429) === null
      && first429Sleeps[0] === 2000) {
    pass('arbeitnow.fetch() retries a first-page 429 and honors Retry-After seconds');
  } else {
    fail(`arbeitnow.fetch() first-page 429 recovery = ${JSON.stringify({ attempts: first429Attempts, sleeps: first429Sleeps, jobs: first429.length, coverage: providerCoverage(first429) })}`);
  }

  // 5xx and statusless network errors are transient; successful retry attempts
  // must not append anything until the page actually returns.
  let transientAttempts = 0;
  const transientSleeps = [];
  const transient = await arbeitnow.fetch(
    { name: 'TransientCo' },
    {
      fetchJson: async () => {
        transientAttempts++;
        if (transientAttempts === 1) throw httpError(503, 'service unavailable');
        if (transientAttempts === 2) throw new Error('connection reset');
        return { data: [mk(401)], links: { next: null } };
      },
      sleep: async (ms) => { transientSleeps.push(ms); },
    },
  );
  if (transientAttempts === 3 && transient.length === 1
      && transientSleeps.join(',') === '500,1000') {
    pass('arbeitnow.fetch() retries 5xx and statusless transient failures with deterministic backoff');
  } else {
    fail(`arbeitnow.fetch() transient retry = ${JSON.stringify({ attempts: transientAttempts, sleeps: transientSleeps, jobs: transient.length })}`);
  }

  // A later-page 429 retries and keeps every successful page.
  let later429Attempts = 0;
  let later429Requests = 0;
  const later429Sleeps = [];
  const later429 = await arbeitnow.fetch(
    { name: 'LaterRetryCo' },
    {
      fetchJson: async (url) => {
        later429Requests++;
        const page = Number(new URL(url).searchParams.get('page'));
        if (page === 1) return { data: [mk(402)], links: { next: 'https://www.arbeitnow.com/api/job-board-api?page=2' } };
        later429Attempts++;
        if (later429Attempts === 1) throw httpError(429);
        return { data: [mk(403)], links: { next: null } };
      },
      sleep: async (ms) => { later429Sleeps.push(ms); },
    },
  );
  if (later429Requests === 3 && later429Attempts === 2 && later429.length === 2
      && providerCoverage(later429) === null && later429Sleeps.join(',') === '150,500') {
    pass('arbeitnow.fetch() retries a later-page 429 and retains all pages');
  } else {
    fail(`arbeitnow.fetch() later-page 429 recovery = ${JSON.stringify({ requests: later429Requests, attempts: later429Attempts, sleeps: later429Sleeps, jobs: later429.length, coverage: providerCoverage(later429) })}`);
  }

  // Retry-After HTTP dates are honored, but waits remain bounded.
  let dateAttempts = 0;
  const dateSleeps = [];
  const retryDate = new Date(Date.now() + 5000).toUTCString();
  const dateRecovered = await arbeitnow.fetch(
    { name: 'DateRetryCo' },
    {
      fetchJson: async () => {
        dateAttempts++;
        if (dateAttempts === 1) {
          const error = httpError(429);
          error.retryAfter = retryDate;
          throw error;
        }
        return { data: [mk(404)], links: { next: null } };
      },
      sleep: async (ms) => { dateSleeps.push(ms); },
    },
  );
  if (dateAttempts === 2 && dateRecovered.length === 1 && dateSleeps.length === 1
      && dateSleeps[0] >= 3000 && dateSleeps[0] <= 5000) {
    pass('arbeitnow.fetch() honors a future Retry-After HTTP date');
  } else {
    fail(`arbeitnow.fetch() Retry-After date = ${JSON.stringify({ attempts: dateAttempts, sleeps: dateSleeps, jobs: dateRecovered.length })}`);
  }

  let clampAttempts = 0;
  const clampSleeps = [];
  const clamped = await arbeitnow.fetch(
    { name: 'ClampRetryCo' },
    {
      fetchJson: async () => {
        clampAttempts++;
        if (clampAttempts === 1) {
          const error = httpError(429);
          error.retryAfter = '86400';
          throw error;
        }
        return { data: [mk(405)], links: { next: null } };
      },
      sleep: async (ms) => { clampSleeps.push(ms); },
    },
  );
  if (clampAttempts === 2 && clamped.length === 1 && clampSleeps[0] === 32000) {
    pass('arbeitnow.fetch() clamps excessive Retry-After delays to 32000ms');
  } else {
    fail(`arbeitnow.fetch() Retry-After clamp = ${JSON.stringify({ attempts: clampAttempts, sleeps: clampSleeps, jobs: clamped.length })}`);
  }

  // Persistent first-page 429 remains a provider failure after four attempts.
  const persistentFirstError = httpError(429, 'persistent rate limit');
  let persistentFirstAttempts = 0;
  let persistentFirstFailure;
  try {
    await arbeitnow.fetch(
      { name: 'PersistentFirstCo' },
      {
        fetchJson: async () => { persistentFirstAttempts++; throw persistentFirstError; },
        sleep: noWait,
      },
    );
  } catch (error) {
    persistentFirstFailure = error;
  }
  if (persistentFirstAttempts === 4 && persistentFirstFailure === persistentFirstError) {
    pass('arbeitnow.fetch() keeps a persistent first-page 429 as a provider failure');
  } else {
    fail(`arbeitnow.fetch() persistent first-page 429 = ${JSON.stringify({ attempts: persistentFirstAttempts, sameError: persistentFirstFailure === persistentFirstError })}`);
  }

  // Persistent later-page 429 returns prior jobs as typed rate-limited partial coverage.
  const persistentLaterError = httpError(429, 'later page rate limit');
  let persistentLaterAttempts = 0;
  const persistentLater = await arbeitnow.fetch(
    { name: 'PersistentLaterCo', max_pages: 3 },
    {
      fetchJson: async (url) => {
        const page = Number(new URL(url).searchParams.get('page'));
        if (page === 1) return { data: [mk(406)], links: { next: 'https://www.arbeitnow.com/api/job-board-api?page=2' } };
        persistentLaterAttempts++;
        throw persistentLaterError;
      },
      sleep: noWait,
    },
  );
  const persistentLaterCoverage = providerCoverage(persistentLater);
  if (persistentLater.length === 1 && persistentLaterAttempts === 4
      && persistentLaterCoverage?.code === 'rate_limited'
      && persistentLaterCoverage.pagesFetched === 1 && persistentLaterCoverage.maxPages === 3) {
    pass('arbeitnow.fetch() preserves earlier pages after a persistent later-page 429');
  } else {
    fail(`arbeitnow.fetch() persistent later-page 429 = ${JSON.stringify({ jobs: persistentLater.length, attempts: persistentLaterAttempts, coverage: persistentLaterCoverage })}`);
  }

  // A later statusless failure has its own stable partial-coverage code.
  let laterNetworkAttempts = 0;
  const laterNetwork = await arbeitnow.fetch(
    { name: 'LaterNetworkCo' },
    {
      fetchJson: async (url) => {
        const page = Number(new URL(url).searchParams.get('page'));
        if (page === 1) return { data: [mk(407)], links: { next: 'https://www.arbeitnow.com/api/job-board-api?page=2' } };
        laterNetworkAttempts++;
        throw new Error('network unavailable');
      },
      sleep: noWait,
    },
  );
  const laterNetworkCoverage = providerCoverage(laterNetwork);
  if (laterNetwork.length === 1 && laterNetworkAttempts === 4 && laterNetworkCoverage?.code === 'fetch_error'
      && laterNetworkCoverage.pagesFetched === 1) {
    pass('arbeitnow.fetch() preserves earlier pages after a persistent later fetch failure');
  } else {
    fail(`arbeitnow.fetch() persistent later fetch failure = ${JSON.stringify({ jobs: laterNetwork.length, attempts: laterNetworkAttempts, coverage: laterNetworkCoverage })}`);
  }

  // A permanent non-429 4xx is not retried.
  const permanentError = httpError(400, 'bad request');
  let permanentAttempts = 0;
  let permanentFailure;
  try {
    await arbeitnow.fetch(
      { name: 'PermanentCo' },
      {
        fetchJson: async () => { permanentAttempts++; throw permanentError; },
        sleep: noWait,
      },
    );
  } catch (error) {
    permanentFailure = error;
  }
  if (permanentAttempts === 1 && permanentFailure === permanentError) {
    pass('arbeitnow.fetch() does not retry a permanent non-429 4xx');
  } else {
    fail(`arbeitnow.fetch() permanent 4xx retry behavior = ${JSON.stringify({ attempts: permanentAttempts, sameError: permanentFailure === permanentError })}`);
  }

  let badThrew = false;
  try {
    await arbeitnow.fetch({ name: 'X' }, { fetchJson: async () => ({ wrong: true }), sleep: noWait });
  } catch (e) {
    badThrew = /unexpected API response/.test(e.message);
  }
  if (badThrew) pass('arbeitnow.fetch() throws on unexpected API response shape');
  else fail('arbeitnow.fetch() should throw when the data array is absent');

  const network = new Error('network unavailable');
  let networkFailure;
  try {
    await arbeitnow.fetch({ name: 'Arbeitnow' }, { fetchJson: async () => { throw network; }, sleep: noWait });
  } catch (error) {
    networkFailure = error;
  }
  if (networkFailure === network) pass('arbeitnow.fetch() preserves ordinary network failures');
  else fail(`arbeitnow.fetch() network failure = ${JSON.stringify(networkFailure)}`);

} catch (e) {
  fail(`arbeitnow provider tests crashed: ${e.message}`);
}
