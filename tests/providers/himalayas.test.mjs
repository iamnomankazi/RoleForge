// tests/providers/himalayas.test.mjs — moved verbatim from test-all.mjs (#1440).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — himalayas');

try {
  const himalayasModule = await import(pathToFileURL(join(ROOT, 'providers/himalayas.mjs')).href);
  const himalayas = himalayasModule.default;
  const {
    parseHimalayasResponse,
    fetchHimalayasPages,
    fetchHimalayasSearchPages,
    fetchHimalayasDiscovery,
    classifyHimalayasLocation,
  } = himalayasModule;
  const { providerCoverage } = await import(pathToFileURL(join(ROOT, 'providers/_result.mjs')).href);

  if (himalayas.id === 'himalayas') pass('himalayas.id is "himalayas"');
  else fail(`himalayas.id is ${JSON.stringify(himalayas.id)}`);

  const hit = himalayas.detect({ name: 'Himalayas', provider: 'himalayas' });
  if (hit && hit.url === 'https://himalayas.app/jobs/api?limit=20') {
    pass('himalayas.detect() claims explicit provider config');
  } else {
    fail(`himalayas.detect() returned ${JSON.stringify(hit)}`);
  }

  if (himalayas.detect({ name: 'Remote Board', provider: 'remotive' }) === null) {
    pass('himalayas.detect() ignores other provider ids');
  } else {
    fail('himalayas.detect() should only claim provider: himalayas');
  }

  const sample = {
    offset: 0,
    limit: 20,
    totalCount: 7,
    jobs: [
      {
        title: '  Staff AI Engineer  ',
        companyName: ' Acme Labs ',
        companySlug: 'acme-labs',
        locationRestrictions: ['Worldwide', 'Europe'],
        timezoneRestrictions: [0, 1],
        seniority: ['Senior'],
        employmentType: 'Full Time',
        description: '<p>Python role requiring 3+ years of experience.</p>',
        minSalary: 80000,
        maxSalary: 90000,
        currency: 'usd',
        expiryDate: 4102444800,
        pubDate: 1782538666,
        applicationLink: 'https://himalayas.app/companies/acme-labs/jobs/staff-ai-engineer',
        guid: 'https://himalayas.app/companies/acme-labs/jobs/staff-ai-engineer-guid',
      },
      {
        title: 'Product Manager',
        companyName: 'Fallback Co',
        companySlug: 'fallback-co',
        locationRestrictions: [],
        pubDate: '2026-01-02T09:00:00Z',
        applicationLink: '',
        guid: 'https://himalayas.app/companies/fallback-co/jobs/product-manager',
      },
      {
        title: 'Expired Python Developer',
        companyName: 'Expired Co',
        locationRestrictions: ['Worldwide'],
        expiryDate: 1,
        applicationLink: 'https://himalayas.app/companies/expired-co/jobs/expired-python-developer',
      },
      {
        title: 'Missing Link Role',
        companyName: 'Dropped Co',
        locationRestrictions: ['United States'],
      },
      {
        title: 'Off Host Role',
        companyName: 'Bad Co',
        locationRestrictions: ['Remote'],
        applicationLink: 'https://example.com/companies/bad/jobs/off-host',
      },
      {
        title: 'HTTP Role',
        companyName: 'Bad Scheme Co',
        locationRestrictions: ['Remote'],
        applicationLink: 'http://himalayas.app/companies/bad/jobs/http-role',
      },
      {
        title: '   ',
        companyName: 'Blank Title Co',
        locationRestrictions: ['Remote'],
        applicationLink: 'https://himalayas.app/companies/blank/jobs/blank-title',
      },
    ],
  };
  const jobs = parseHimalayasResponse(sample);

  if (jobs.length === 2) pass('parseHimalayasResponse keeps 2 jobs (drops missing/off-host/http/blank-title rows)');
  else fail(`parseHimalayasResponse returned ${jobs.length} jobs (expected 2)`);

  if (jobs[0]?.title === 'Staff AI Engineer' && jobs[0]?.company === 'Acme Labs') {
    pass('parseHimalayasResponse trims title and companyName');
  } else {
    fail(`row 0 title/company = ${JSON.stringify({ title: jobs[0]?.title, company: jobs[0]?.company })}`);
  }

  if (jobs[0]?.location === 'Worldwide, Europe') {
    pass('parseHimalayasResponse joins locationRestrictions');
  } else {
    fail(`row 0 location = ${JSON.stringify(jobs[0]?.location)}`);
  }

  if (jobs[0]?.url === 'https://himalayas.app/companies/acme-labs/jobs/staff-ai-engineer') {
    pass('parseHimalayasResponse maps applicationLink to url');
  } else {
    fail(`row 0 url = ${JSON.stringify(jobs[0]?.url)}`);
  }

  if (jobs[0]?.postedAt === 1782538666 * 1000) {
    pass('parseHimalayasResponse converts epoch seconds pubDate -> postedAt ms');
  } else {
    fail(`row 0 postedAt = ${JSON.stringify(jobs[0]?.postedAt)}`);
  }

  if (jobs[0]?.expiresAt === 4102444800 * 1000) {
    pass('parseHimalayasResponse converts expiryDate epoch seconds -> expiresAt ms');
  } else {
    fail(`row 0 expiresAt = ${JSON.stringify(jobs[0]?.expiresAt)}`);
  }

  if (jobs[0]?.seniority?.[0] === 'Senior' && jobs[0]?.employmentType === 'Full Time') {
    pass('parseHimalayasResponse preserves seniority and employment type');
  } else {
    fail(`row 0 metadata = ${JSON.stringify({ seniority: jobs[0]?.seniority, employmentType: jobs[0]?.employmentType })}`);
  }

  if (jobs[0]?.description?.includes('3+ years') && jobs[0]?.salary?.min === 80000) {
    pass('parseHimalayasResponse preserves description and salary metadata');
  } else {
    fail(`row 0 detail metadata = ${JSON.stringify({ description: jobs[0]?.description, salary: jobs[0]?.salary })}`);
  }

  if (jobs[1]?.url === 'https://himalayas.app/companies/fallback-co/jobs/product-manager') {
    pass('parseHimalayasResponse falls back to guid when applicationLink is missing');
  } else {
    fail(`row 1 url = ${JSON.stringify(jobs[1]?.url)}`);
  }

  if (jobs[1]?.postedAt === Date.parse('2026-01-02T09:00:00Z')) {
    pass('parseHimalayasResponse parses string pubDate -> postedAt');
  } else {
    fail(`row 1 postedAt = ${JSON.stringify(jobs[1]?.postedAt)}`);
  }

  if (parseHimalayasResponse({}).length === 0 && parseHimalayasResponse(null).length === 0) {
    pass('parseHimalayasResponse empty / non-object payload -> empty result (no crash)');
  } else {
    fail('parseHimalayasResponse invalid payload should yield empty result');
  }

  let capturedUrl = null;
  let capturedOpts = null;
  const fetched = await himalayas.fetch(
    { name: 'Himalayas', provider: 'himalayas' },
    { fetchJson: async (url, opts) => { capturedUrl = url; capturedOpts = opts; return sample; } },
  );

  if (capturedUrl === 'https://himalayas.app/jobs/api?limit=20') {
    pass('himalayas.fetch() requests the current 20-row public API limit');
  } else {
    fail(`himalayas.fetch() requested ${JSON.stringify(capturedUrl)}`);
  }

  if (capturedOpts && capturedOpts.redirect === 'error') {
    pass('himalayas.fetch() passes redirect:"error" to fetchJson');
  } else {
    fail(`himalayas.fetch() should pass redirect:"error", got: ${JSON.stringify(capturedOpts)}`);
  }

  if (fetched[0]?.company === 'Acme Labs' && fetched[0]?.title === 'Staff AI Engineer') {
    pass('provider: himalayas config returns normalized jobs');
  } else {
    fail(`himalayas.fetch() normalized row = ${JSON.stringify(fetched[0])}`);
  }
  if (providerCoverage(fetched) === null) pass('complete Himalayas discovery does not report false partial coverage');
  else fail(`complete Himalayas coverage = ${JSON.stringify(providerCoverage(fetched))}`);

  // Pagination uses the response's effective limit and offset, deduplicates
  // overlapping rows, and stops from totalCount without a speculative page.
  const mkRow = (id) => ({
    title: `Role ${id}`,
    companyName: 'Pagination Co',
    locationRestrictions: ['Worldwide'],
    applicationLink: `https://himalayas.app/companies/pagination-co/jobs/${id}`,
  });
  const pageCalls = [];
  const paged = await fetchHimalayasPages(
    { name: 'Himalayas', provider: 'himalayas' },
    {
      fetchJson: async (url, opts) => {
        pageCalls.push({ url, opts });
        const offset = Number(new URL(url).searchParams.get('offset') || 0);
        return offset === 0
          ? { offset: 0, limit: 2, totalCount: 4, jobs: [mkRow('a'), mkRow('b')] }
          : { offset: 2, limit: 2, totalCount: 4, jobs: [mkRow('b'), mkRow('c')] };
      },
    },
  );
  if (paged.jobs.length === 3 && paged.stats.pagesFetched === 2 && paged.stats.duplicateRawRows === 1) {
    pass('fetchHimalayasPages() paginates by response offset and deduplicates overlapping rows');
  } else {
    fail(`pagination result = ${JSON.stringify(paged)}`);
  }
  if (pageCalls.length === 2
      && pageCalls[0].url === 'https://himalayas.app/jobs/api?limit=20'
      && pageCalls[1].url === 'https://himalayas.app/jobs/api?limit=20&offset=2'
      && pageCalls.every(({ opts }) => opts?.redirect === 'error')) {
    pass('fetchHimalayasPages() builds bounded offset URLs with redirect:\"error\"');
  } else {
    fail(`pagination requests = ${JSON.stringify(pageCalls)}`);
  }

  // max_pages and max_jobs are independent safety valves. max_jobs also
  // narrows the requested limit on the final page so the cap is exact.
  const pageCapCalls = [];
  const pageCapped = await fetchHimalayasPages(
    { name: 'Himalayas', provider: 'himalayas', max_pages: 1 },
    { fetchJson: async (url) => { pageCapCalls.push(url); return { offset: 0, limit: 2, totalCount: 99, jobs: [mkRow('a'), mkRow('b')] }; } },
  );
  if (pageCapped.jobs.length === 2 && pageCapCalls.length === 1
      && pageCapped.stats.stopReason === 'max_pages' && pageCapped.stats.truncated) {
    pass('fetchHimalayasPages() honors entry.max_pages and records proven truncation');
  }
  else fail(`max_pages cap = ${JSON.stringify({ jobs: pageCapped.jobs.length, calls: pageCapCalls })}`);

  const jobCapCalls = [];
  const jobCapped = await fetchHimalayasPages(
    { name: 'Himalayas', provider: 'himalayas', max_jobs: 3 },
    {
      fetchJson: async (url) => {
        jobCapCalls.push(url);
        const offset = Number(new URL(url).searchParams.get('offset') || 0);
        return offset === 0
          ? { offset: 0, limit: 2, totalCount: 99, jobs: [mkRow('a'), mkRow('b')] }
          : { offset: 2, limit: 1, totalCount: 99, jobs: [mkRow('c')] };
      },
    },
  );
  if (jobCapped.jobs.length === 3 && jobCapped.stats.rawJobsFetched === 3
      && jobCapped.stats.stopReason === 'max_jobs' && jobCapped.stats.truncated
      && jobCapCalls[1] === 'https://himalayas.app/jobs/api?limit=1&offset=2') {
    pass('fetchHimalayasPages() honors exact entry.max_jobs and narrows the final request');
  } else {
    fail(`max_jobs cap = ${JSON.stringify({ result: jobCapped, calls: jobCapCalls })}`);
  }

  const repeatCalls = [];
  const repeated = await fetchHimalayasPages(
    { name: 'Himalayas', provider: 'himalayas', max_pages: 5 },
    {
      fetchJson: async (url) => {
        repeatCalls.push(url);
        const offset = Number(new URL(url).searchParams.get('offset') || 0);
        return { offset, limit: 2, totalCount: 99, jobs: [mkRow('same-a'), mkRow('same-b')] };
      },
    },
  );
  if (repeated.jobs.length === 2 && repeated.stats.repeatedPages === 1 && repeatCalls.length === 2) {
    pass('fetchHimalayasPages() stops when the API repeats a page');
  } else {
    fail(`repeated-page guard = ${JSON.stringify({ result: repeated, calls: repeatCalls })}`);
  }

  const searchRow = (id, title = `Search Role ${id}`) => ({
    id,
    title,
    companyName: 'Search Co',
    locationRestrictions: ['Worldwide'],
    seniority: ['Entry-level'],
    employmentType: 'Full Time',
    description: `<p>${title} description</p>`,
    applicationLink: `https://himalayas.app/companies/search-co/jobs/${id}`,
  });

  // Search pagination is page-based, deduplicates query overlap, and records
  // every query that found a shared job. The request adds an explicit stable
  // sort but must not add unsupported limit/offset parameters.
  const searchCalls = [];
  const targeted = await fetchHimalayasSearchPages(
    {
      name: 'Himalayas',
      provider: 'himalayas',
      search_queries: ['data engineer', 'data analyst', 'DATA ENGINEER'],
      search_max_pages: 2,
      search_max_jobs: 40,
    },
    {
      fetchJson: async (url, opts) => {
        searchCalls.push({ url, opts });
        const parsed = new URL(url);
        const query = parsed.searchParams.get('q');
        const page = Number(parsed.searchParams.get('page'));
        const rows = query === 'data engineer'
          ? (page === 1 ? [searchRow('shared', 'Data Engineer'), searchRow('de-1')] : [searchRow('de-2'), searchRow('de-3')])
          : (page === 1 ? [searchRow('shared', 'Data Engineer'), searchRow('da-1')] : [searchRow('da-2'), searchRow('da-3')]);
        return { offset: (page - 1) * 2, limit: 2, totalCount: 4, jobs: rows };
      },
    },
  );
  const shared = targeted.jobs.find(job => job.sourceId === 'shared');
  if (targeted.jobs.length === 7 && targeted.stats.pagesFetched === 4
      && targeted.stats.duplicateJobs === 1 && targeted.stats.queries.length === 2
      && shared?.sourceQueries?.join('|') === 'data engineer|data analyst') {
    pass('fetchHimalayasSearchPages() paginates, deduplicates cross-query jobs, and preserves source queries');
  } else {
    fail(`targeted search result = ${JSON.stringify({ jobs: targeted.jobs, stats: targeted.stats })}`);
  }
  if (searchCalls.length === 4
      && searchCalls.every(({ url, opts }) => {
        const parsed = new URL(url);
        return parsed.pathname === '/jobs/api/search'
          && parsed.searchParams.has('q')
          && parsed.searchParams.has('page')
          && parsed.searchParams.get('sort') === 'recent'
          && !parsed.searchParams.has('limit')
          && !parsed.searchParams.has('offset')
          && opts?.redirect === 'error';
      })) {
    pass('targeted searches use q/page/recent sort and never send unsupported search limit/offset');
  } else {
    fail(`targeted search requests = ${JSON.stringify(searchCalls)}`);
  }

  // Structured query objects may opt into stable public filters. Exact
  // duplicates are collapsed, while omitted filters remain omitted.
  const structuredCalls = [];
  const structured = await fetchHimalayasSearchPages(
    {
      search_queries: [
        {
          query: 'data engineer', sort: 'salaryDesc', country: ['Finland', 'Germany'],
          seniority: ['Entry-level'], employment_type: ['Full Time', 'Internship'],
        },
        {
          query: 'DATA ENGINEER', sort: 'salaryDesc', country: ['FINLAND', 'GERMANY'],
          seniority: ['ENTRY-LEVEL'], employmentType: ['FULL TIME', 'INTERNSHIP'],
        },
      ],
      search_max_pages: 2,
      search_max_jobs: 40,
    },
    { fetchJson: async (url) => { structuredCalls.push(url); return { offset: 0, limit: 20, totalCount: 0, jobs: [] }; } },
  );
  const structuredUrl = new URL(structuredCalls[0]);
  if (structured.stats.queries.length === 1 && structuredCalls.length === 1
      && structuredUrl.searchParams.get('q') === 'data engineer'
      && structuredUrl.searchParams.get('sort') === 'salaryDesc'
      && structuredUrl.searchParams.get('country') === 'Finland,Germany'
      && structuredUrl.searchParams.get('seniority') === 'Entry-level'
      && structuredUrl.searchParams.get('employment_type') === 'Full Time,Internship') {
    pass('structured Himalayas queries deduplicate and encode supported filters deterministically');
  } else {
    fail(`structured search = ${JSON.stringify({ calls: structuredCalls, stats: structured.stats })}`);
  }

  if (searchCalls.every(({ url }) => {
    const parsed = new URL(url);
    return !parsed.searchParams.has('country')
      && !parsed.searchParams.has('seniority')
      && !parsed.searchParams.has('employment_type');
  })) {
    pass('plain targeted queries do not impose restrictive upstream location or seniority filters');
  } else {
    fail(`plain targeted search unexpectedly added filters: ${JSON.stringify(searchCalls)}`);
  }

  // A representative high-teens/20-query shape covers the intended technical
  // role families and gets two pages per query without starving the final one
  // (20 * 2 * 20 = 800 raw rows).
  const familyQueries = [
    'Python developer', 'Backend engineer', 'Junior backend', 'Software engineer',
    'Junior software engineer', 'Associate software engineer', 'Graduate software engineer',
    'Data engineer', 'Junior data engineer', 'Analytics engineer', 'ETL developer',
    'Machine learning AI engineer', 'Data analyst', 'BI developer',
    'Working student software', 'Working student data', 'Working student machine learning AI',
    'Software engineering intern', 'Data engineering intern', 'Machine learning AI intern',
  ];
  const familyCalls = [];
  const familySearch = await fetchHimalayasSearchPages(
    { search_queries: familyQueries, search_max_pages: 2, search_max_jobs: 800 },
    { fetchJson: async (url) => {
      familyCalls.push(url);
      const parsed = new URL(url);
      const query = parsed.searchParams.get('q');
      const page = Number(parsed.searchParams.get('page'));
      const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      return {
        offset: (page - 1) * 20, limit: 20, totalCount: 40,
        jobs: Array.from({ length: 20 }, (_, index) => searchRow(`${slug}-${page}-${index}`)),
      };
    } },
  );
  if (familyCalls.length === 40 && familySearch.jobs.length === 800
      && familySearch.stats.queryStats.length === 20
      && familySearch.stats.queryStats.at(-1)?.query === 'Machine learning AI intern'
      && familySearch.stats.queryStats.every(({ reachedEnd, truncated }) => reachedEnd && !truncated)
      && familySearch.stats.globalCapHit === false) {
    pass('20-query two-page search reaches every role family within the derived 800-row cap');
  } else {
    fail(`family search bounds = ${JSON.stringify({ calls: familyCalls.length, jobs: familySearch.jobs.length, stats: familySearch.stats })}`);
  }

  // A repeated search page stops that query safely instead of walking forever.
  const repeatedSearchCalls = [];
  const repeatedSearch = await fetchHimalayasSearchPages(
    { name: 'Himalayas', search_queries: ['software engineer'], search_max_pages: 5, search_max_jobs: 100 },
    {
      fetchJson: async (url) => {
        repeatedSearchCalls.push(url);
        return { offset: 0, limit: 2, totalCount: 99, jobs: [searchRow('repeat-a'), searchRow('repeat-b')] };
      },
    },
  );
  if (repeatedSearch.jobs.length === 2 && repeatedSearch.stats.repeatedPages === 1 && repeatedSearchCalls.length === 2) {
    pass('fetchHimalayasSearchPages() stops on a repeated page');
  } else {
    fail(`repeated search guard = ${JSON.stringify({ result: repeatedSearch, calls: repeatedSearchCalls })}`);
  }

  // Discovery runs targeted searches first, then exactly one configured generic
  // latest-feed pass, merging any targeted/generic overlap.
  const discoveryCalls = [];
  const discovery = await fetchHimalayasDiscovery(
    {
      name: 'Himalayas',
      search_queries: ['backend developer'],
      search_max_pages: 1,
      search_max_jobs: 20,
      max_pages: 1,
      max_jobs: 20,
    },
    {
      fetchJson: async (url, opts) => {
        discoveryCalls.push({ url, opts });
        if (new URL(url).pathname.endsWith('/search')) {
          return { offset: 0, limit: 20, totalCount: 1, jobs: [searchRow('shared', 'Backend Developer')] };
        }
        return { offset: 0, limit: 20, totalCount: 1, jobs: [searchRow('shared', 'Backend Developer')] };
      },
    },
  );
  const discoveryJob = discovery.jobs[0];
  if (discovery.jobs.length === 1 && discovery.stats.duplicatesAcrossModes === 1
      && discoveryJob?.sourceQueries?.join('|') === 'backend developer|generic-latest-feed'
      && discovery.targeted.stats.requests === 1 && discovery.browse.stats.requests === 1) {
    pass('fetchHimalayasDiscovery() runs targeted plus one generic latest-feed pass and merges provenance');
  } else {
    fail(`discovery result = ${JSON.stringify(discovery)}`);
  }
  if (discoveryCalls.length === 2
      && discoveryCalls.some(({ url }) => new URL(url).pathname === '/jobs/api/search')
      && discoveryCalls.some(({ url }) => url === 'https://himalayas.app/jobs/api?limit=20')
      && discoveryCalls.every(({ opts }) => opts?.redirect === 'error')) {
    pass('generic discovery pass uses the browse API with a 20-job cap');
  } else {
    fail(`discovery requests = ${JSON.stringify(discoveryCalls)}`);
  }

  const bounded = await himalayas.fetch(
    {
      name: 'Himalayas', search_queries: ['data engineer'], search_max_pages: 1,
      search_max_jobs: 20, max_pages: 1, max_jobs: 20,
    },
    { fetchJson: async (url) => new URL(url).pathname.endsWith('/search')
      ? { offset: 0, limit: 20, totalCount: 40, jobs: Array.from({ length: 20 }, (_, index) => searchRow(`bounded-${index}`)) }
      : { offset: 0, limit: 20, totalCount: 0, jobs: [] } },
  );
  const boundedCoverage = providerCoverage(bounded);
  if (bounded.length === 20 && boundedCoverage?.code === 'bounded_search'
      && boundedCoverage.reason.includes('search_max_jobs=20')) {
    pass('global-cap-bounded Himalayas search retains jobs and reports typed partial coverage');
  } else {
    fail(`bounded Himalayas coverage = ${JSON.stringify({ jobs: bounded.length, coverage: boundedCoverage })}`);
  }

  const pageBounded = await himalayas.fetch(
    {
      name: 'Himalayas', search_queries: ['data engineer'], search_max_pages: 1,
      search_max_jobs: 40, max_pages: 1, max_jobs: 20,
    },
    { fetchJson: async (url) => new URL(url).pathname.endsWith('/search')
      ? { offset: 0, limit: 20, totalCount: 40, jobs: Array.from({ length: 20 }, (_, index) => searchRow(`page-bounded-${index}`)) }
      : { offset: 0, limit: 20, totalCount: 0, jobs: [] } },
  );
  const pageBoundedCoverage = providerCoverage(pageBounded);
  if (pageBounded.length === 20 && pageBoundedCoverage?.code === 'bounded_search'
      && pageBoundedCoverage.reason.includes('1 of 1 targeted queries')
      && pageBoundedCoverage.reason.includes('configured page cap')
      && !pageBoundedCoverage.reason.includes('search_max_jobs')) {
    pass('per-query page bounds retain jobs and report the distinct aggregate partial cause');
  } else {
    fail(`page-bounded Himalayas coverage = ${JSON.stringify({ jobs: pageBounded.length, coverage: pageBoundedCoverage })}`);
  }

  const healthyEmpty = await fetchHimalayasPages(
    { max_pages: 1 },
    { fetchJson: async () => ({ offset: 0, limit: 20, totalCount: 0, jobs: [] }) },
  );
  if (healthyEmpty.jobs.length === 0) pass('Himalayas browse treats a valid empty jobs array as healthy empty');
  else fail(`Himalayas valid empty returned ${healthyEmpty.jobs.length} rows`);

  const expiredOnly = await fetchHimalayasPages(
    { max_pages: 1 },
    { fetchJson: async () => ({ offset: 0, limit: 20, totalCount: 1, jobs: [{
      title: 'Expired', companyName: 'Old Co', status: 'expired',
      applicationLink: 'https://himalayas.app/companies/old/jobs/expired',
    }] }) },
  );
  if (expiredOnly.jobs.length === 0) pass('Himalayas explicit unavailable rows remain a truthful healthy empty result');
  else fail('Himalayas should drop explicit unavailable rows');

  let unusableBrowseThrew = false;
  try {
    await fetchHimalayasPages({ max_pages: 1 }, {
      fetchJson: async () => ({ offset: 0, limit: 20, totalCount: 1, jobs: [{ title: 'Broken', companyName: 'Acme' }] }),
    });
  } catch { unusableBrowseThrew = true; }
  if (unusableBrowseThrew) pass('Himalayas browse rejects non-empty all-unusable payloads');
  else fail('Himalayas browse should reject non-empty all-unusable payloads');

  let unusableSearchThrew = false;
  try {
    await fetchHimalayasSearchPages({ search_queries: ['data engineer'], search_max_pages: 1 }, {
      fetchJson: async () => ({ offset: 0, limit: 20, totalCount: 1, jobs: [{ title: 'Broken', companyName: 'Acme' }] }),
    });
  } catch { unusableSearchThrew = true; }
  if (unusableSearchThrew) pass('Himalayas search rejects non-empty all-unusable payloads');
  else fail('Himalayas search should reject non-empty all-unusable payloads');

  const policy = { block: ['United States', 'Canada'] };
  if (classifyHimalayasLocation({ locationRestrictions: ['Worldwide'] }, policy).classification === 'Confirmed eligible'
      && classifyHimalayasLocation({ locationRestrictions: [] }, policy).classification === 'Potential, verify Finland hiring eligibility'
      && classifyHimalayasLocation({ locationRestrictions: ['United States'] }, policy).classification === 'Blocked') {
    pass('Himalayas location classification preserves worldwide, unspecified, and explicit-country outcomes');
  } else {
    fail('Himalayas location classification outcomes are incorrect');
  }

  // Keep title-gate coverage deterministic and independent of ignored/private
  // user configuration. Constrained internship/student phrases admit relevant
  // early-career roles without making generic internships pass.
  const { buildTitleFilter } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
  const titleFilter = buildTitleFilter({
    positive: [
      'Python Developer', 'Backend Developer', 'Backend Engineer', 'Software Engineer',
      'Data Engineer', 'Machine Learning Engineer', 'AI Engineer',
      'Machine Learning Intern', 'ML Intern', 'AI Intern',
      'AI/ML Intern', 'AI & ML Intern', 'Data Engineering Intern',
      'Software Engineering Intern', 'Working Student Software',
      'Working Student Data', 'Working Student AI', 'Working Student Machine Learning',
    ],
    negative: [
      'Senior', 'Staff', 'Lead', 'Marketing', 'Finance', 'Human Resources', 'HR ', 'Sales',
    ],
  });
  const shouldPass = [
    'Machine Learning Intern', 'ML Intern', 'AI Intern', 'AI/ML Intern', 'AI & ML Intern',
    'AI/Machine Learning Engineer Intern', 'Data Engineering Intern',
    'Software Engineering Intern', 'Associate Software Engineer',
    'Associate Data Engineer', 'Junior Python Developer', 'Backend Developer',
    'Working Student Software Engineering', 'Working Student Data Engineering',
    'Working Student AI', 'Working Student Machine Learning',
  ];
  const shouldFail = [
    'Marketing Intern', 'Finance Intern', 'HR Intern', 'Sales Intern',
    'Working Student Marketing', 'Working Student Finance',
    'Senior Software Engineer', 'Staff Data Engineer',
  ];
  if (shouldPass.every(titleFilter) && shouldFail.every(title => !titleFilter(title))) {
    pass('constrained early-career title phrases pass while unrelated internships and senior roles stay blocked');
  } else {
    fail(`early-career title fixture mismatch = ${JSON.stringify({
      unexpectedFails: shouldPass.filter(title => !titleFilter(title)),
      unexpectedPasses: shouldFail.filter(titleFilter),
    })}`);
  }
} catch (e) {
  fail(`himalayas provider tests crashed: ${e.message}`);
}
