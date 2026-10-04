import test from 'node:test';
import assert from 'node:assert/strict';

import provider, { normalizeOracleJob } from '../../providers/oraclecloud.mjs';
import { providerCoverage } from '../../providers/_result.mjs';

const careersUrl = 'https://acme.fa.us2.ocs.oraclecloud26.com/hcmUI/CandidateExperience/en/sites/CX_9/jobs';

function requisition(id, overrides = {}) {
  return {
    Id: String(id), Title: `Role ${id}`, PostedDate: '2026-09-01T12:00:00Z',
    PrimaryLocation: 'Helsinki, Finland', ...overrides,
  };
}

function payload(rows, total, extra = {}) {
  return { hasMore: false, items: [{ requisitionList: rows, TotalJobsCount: total, ...extra }] };
}

test('detect supports the bounded Oracle host family, pins API precedence, and rejects unrelated hosts', () => {
  assert.equal(provider.id, 'oraclecloud');
  assert.equal(provider.detect({ careers_url: 'http://acme.fa.oraclecloud.com/jobs' }), null);
  assert.equal(provider.detect({ careers_url: 'https://acme.fa.oraclecloud100.com/jobs' }), null);
  assert.equal(provider.detect({ careers_url: 'https://acme.fa.oraclecloud0.com/jobs' }), null);
  assert.equal(provider.detect({ careers_url: 'https://oraclecloud.com/acme' }), null);
  const hit = provider.detect({
    api: 'https://api-tenant.fa.eu-frankfurt-1.oraclecloud2.com/hcmUI/CandidateExperience/de/sites/CX_2/jobs',
    careers_url: 'https://other.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs',
    siteNumber: 'CX_CUSTOM', locationId: 123,
  });
  const parsed = new URL(hit.url);
  assert.equal(parsed.hostname, 'api-tenant.fa.eu-frankfurt-1.oraclecloud2.com');
  assert.equal(parsed.searchParams.get('limit'), '200');
  assert.equal(parsed.searchParams.get('offset'), '0');
  assert.match(parsed.searchParams.get('finder'), /siteNumber=CX_CUSTOM/);
  assert.match(parsed.searchParams.get('finder'), /locationId=123/);
  assert.match(parsed.searchParams.get('expand'), /requisitionList\.workLocation/);
});

test('normalization requires a title and preserves URL, requisition identity, text, date, and location', () => {
  const site = { host: 'acme.fa.oraclecloud.com', lang: 'en', siteNumber: 'CX_1' };
  assert.deepEqual(normalizeOracleJob(requisition(42, {
    Title: '  AI Engineer ', ExternalURL: 'https://jobs.acme.com/roles/42?j=42',
    SourceURL: 'https://careers.acme.com/job-search', ShortDescriptionStr: 'Build &amp; ship',
    PrimaryLocation: '', workLocation: [{ TownOrCity: 'Helsinki', Country: 'Finland' }], WorkplaceTypeCode: 'ORA_REMOTE',
  }), site, 'Acme'), {
    title: 'AI Engineer', url: 'https://jobs.acme.com/roles/42?j=42', company: 'Acme',
    location: 'Helsinki, Finland · Remote', sourceId: '42', sourceUrl: 'https://careers.acme.com/job-search',
    description: 'Build & ship', postedAt: Date.parse('2026-09-01T12:00:00Z'),
  });
  assert.equal(normalizeOracleJob(requisition(43, { ExternalURL: 'http://evil.example/job' }), site).url,
    'https://acme.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/43');
  assert.equal(normalizeOracleJob({ Id: 1, Title: 'Fallback URL' }, site).url,
    'https://acme.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/1');
  assert.equal(normalizeOracleJob({ Id: 1, ExternalURL: 'https://jobs.example/1' }, site), null);
});

test('walks the 200, 199, 54 total-count regression despite hasMore=false', async () => {
  const calls = [];
  const delays = [];
  const lengths = [200, 199, 54];
  const jobs = await provider.fetch({ name: 'Acme', careers_url: careersUrl }, {
    sleep: async (ms) => delays.push(ms),
    fetchJson: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      const offset = Number(parsed.searchParams.get('offset'));
      const finder = parsed.searchParams.get('finder');
      assert.match(finder, new RegExp(`offset=${offset}`));
      assert.match(finder, /limit=200/);
      assert.equal(parsed.searchParams.get('limit'), '200');
      assert.equal(options.redirect, 'error');
      assert.match(options.headers['user-agent'], /Chrome/);
      const page = offset / 200;
      return payload(Array.from({ length: lengths[page] }, (_, i) => requisition(offset + i)), 454);
    },
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(({ url }) => Number(new URL(url).searchParams.get('offset'))), [0, 200, 400]);
  assert.equal(jobs.length, 453);
  assert.deepEqual(delays, [250, 250]);
});

test('without a total short pages end the walk; empty pages beat stale totals', async () => {
  let calls = 0;
  const short = await provider.fetch({ careers_url: careersUrl, max_pages: 4 }, {
    fetchJson: async () => { calls++; return { items: [{ requisitionList: [requisition(1)] }] }; },
  });
  assert.equal(calls, 1);
  assert.equal(short.length, 1);

  calls = 0;
  const stale = await provider.fetch({ careers_url: careersUrl, max_pages: 4 }, {
    fetchJson: async (url) => {
      calls++;
      return Number(new URL(url).searchParams.get('offset')) === 0
        ? payload(Array.from({ length: 200 }, (_, i) => requisition(i)), 9000)
        : payload([], 9000);
    },
  });
  assert.equal(calls, 2);
  assert.equal(stale.length, 200);
});

test('terminal empty pages at the page cap suppress stale-total partial coverage', async () => {
  for (const maxPages of [1, 2]) {
    let calls = 0;
    const jobs = await provider.fetch({ careers_url: careersUrl, max_pages: maxPages }, {
      fetchJson: async (url) => {
        calls++;
        const offset = Number(new URL(url).searchParams.get('offset'));
        return offset === 0 && maxPages === 2
          ? payload(Array.from({ length: 200 }, (_, i) => requisition(i)), 9000)
          : payload([], 9000);
      },
    });
    assert.equal(calls, maxPages);
    assert.equal(jobs.length, maxPages === 1 ? 0 : 200);
    assert.equal(providerCoverage(jobs), null);
  }
});

test('ctx maxPages and provider page caps produce typed partial coverage', async () => {
  const capped = await provider.fetch({ careers_url: careersUrl, max_pages: 20 }, {
    maxPages: 1,
    fetchJson: async () => payload(Array.from({ length: 200 }, (_, i) => requisition(i)), 454),
  });
  assert.equal(capped.length, 200);
  assert.deepEqual(providerCoverage(capped), {
    status: 'partial', code: 'max_pages',
    reason: 'Oracle Recruiting Cloud truncated at max_pages=1 (454 reported requisitions)',
    pagesFetched: 1, maxPages: 1,
  });
});

test('malformed envelopes and non-empty pages with no usable requisitions fail closed', async () => {
  await assert.rejects(() => provider.fetch({ careers_url: careersUrl }, {
    fetchJson: async () => ({ items: [] }),
  }), /items\[0\] requisition envelope/);
  await assert.rejects(() => provider.fetch({ careers_url: careersUrl }, {
    fetchJson: async () => ({ items: [{ requisitionList: [{ Id: 1 }] }] }),
  }), /none structurally usable/);
  assert.deepEqual(await provider.fetch({ careers_url: careersUrl }, {
    fetchJson: async () => payload([], 0),
  }), []);
});
