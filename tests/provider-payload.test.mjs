import test from 'node:test';
import assert from 'node:assert/strict';
import greenhouse from '../providers/greenhouse.mjs';
import workday from '../providers/workday.mjs';
import phenom from '../providers/phenom.mjs';
import radancy from '../providers/radancy.mjs';
import successfactors from '../providers/successfactors.mjs';
import arbeitsagentur from '../providers/arbeitsagentur.mjs';

const cases = [
  {
    name: 'Greenhouse',
    run: (body) => greenhouse.fetch({ name: 'G', api: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs' }, { fetchJson: async () => body }),
    empty: { jobs: [] }, malformed: {}, unusable: { jobs: [{ title: 'No URL' }] },
  },
  {
    name: 'Workday',
    run: (body) => workday.fetch({ name: 'W', careers_url: 'https://acme.wd3.myworkdayjobs.com/Careers' }, { fetchJson: async () => body, sleep: async () => {} }),
    empty: { total: 0, jobPostings: [] }, malformed: {}, unusable: { total: 1, jobPostings: [{ title: 'No path' }] },
  },
  {
    name: 'Phenom',
    run: (body) => phenom.fetch({ name: 'P', careers_url: 'https://p.phenompeople.com' }, { fetchJson: async () => body, sleep: async () => {} }),
    empty: { refineSearch: { totalHits: 0, data: { jobs: [] } } }, malformed: {}, unusable: { refineSearch: { totalHits: 1, data: { jobs: [{ title: 'No id' }] } } },
  },
  {
    name: 'Radancy',
    run: (body) => radancy.fetch({ name: 'R', careers_url: 'https://jobs.example.com/en/search-jobs' }, { fetchText: async () => body, sleep: async () => {} }),
    empty: '<html></html>', malformed: '<html>login gateway</html>', unusable: '<li class="search-results-list__item">broken</li>',
  },
  {
    name: 'SuccessFactors',
    run: (body) => successfactors.fetch({ name: 'S', careers_url: 'https://jobs.successfactors.com', sfVariant: 'csb' }, {
      fetchText: async () => '<a href="?locale=en_US">EN</a>', fetchJson: async () => body,
    }),
    empty: { totalJobs: 0, jobSearchResult: [] }, malformed: {}, unusable: { totalJobs: 1, jobSearchResult: [{ response: { id: '1', jobTitle: '' } }] },
  },
  {
    name: 'Arbeitsagentur',
    run: (body) => arbeitsagentur.fetch({ name: 'A', arbeitsagentur: { keywords: ['Engineer'] } }, { fetchJson: async () => body }),
    empty: { stellenangebote: [] }, malformed: {}, unusable: { stellenangebote: [{ titel: 'No reference' }] },
  },
];

for (const provider of cases) {
  test(`${provider.name} accepts an explicit valid empty first page`, async () => {
    assert.deepEqual(await provider.run(provider.empty), []);
  });
  test(`${provider.name} rejects a missing expected response container`, async () => {
    await assert.rejects(() => provider.run(provider.malformed), /malformed/i);
  });
  test(`${provider.name} rejects a non-empty collection with no usable rows`, async () => {
    await assert.rejects(() => provider.run(provider.unusable), /malformed/i);
  });
}
