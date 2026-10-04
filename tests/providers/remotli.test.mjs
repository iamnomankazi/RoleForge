import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — remotli');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/remotli.mjs')).href);
  const provider = mod.default;
  const { providerCoverage } = await import(pathToFileURL(join(ROOT, 'providers/_result.mjs')).href);
  if (provider.id === 'remotli') pass('remotli id is stable'); else fail(`id=${provider.id}`);
  if (provider.detect({ provider: 'remotli' })?.url === 'https://remotli.ch/api/jobs?page=1&limit=50&remote=all') pass('detect pins remote=all feed'); else fail('detect drift');

  const row = {
    id: 'r-1', status: 'active', title: ' Backend Engineer ', companyId: 'c-1',
    applyUrl: 'https://jobs.example.com/apply/r-1', url: 'https://remotli.ch/jobs/backend-engineer',
    location: 'Zurich, Switzerland', remote: true, publishedAt: '2026-08-01T00:00:00Z',
    description: '<p>Build distributed systems</p>', salary: { min: 110000, max: 130000, currency: 'CHF' },
  };
  const job = mod.normalizeRemotliJob(row, [{ id: 'c-1', name: ' Swiss Co ' }]);
  if (job?.title === 'Backend Engineer' && job.company === 'Swiss Co' && job.url === row.applyUrl
      && job.sourceUrl === row.url && job.sourceId === 'r-1' && job.location.includes('Remote')
      && job.salary?.currency === 'CHF' && job.description === row.description
      && job.postedAt === Date.parse(row.publishedAt)) pass('normalizes joined company, ATS destination, CHF salary and evidence');
  else fail(`normalized=${JSON.stringify(job)}`);
  if (mod.normalizeRemotliJob({ ...row, status: 'closed' }) === null
      && mod.normalizeRemotliJob({ ...row, id: undefined, applyUrl: 'http://jobs.example.com/a', url: '' }) === null) pass('drops inactive and unusable rows'); else fail('drop rules drift');

  const mk = (i) => ({ id: `r-${i}`, status: 'active', title: `Role ${i}`, applyUrl: `https://jobs.example.com/r-${i}`, url: `https://remotli.ch/jobs/r-${i}`, companyId: 'c' });
  const calls = [];
  const jobs = await provider.fetch({ name: 'Remotli', max_pages: 3 }, {
    transport: 'http', fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) return { jobs: Array.from({ length: 50 }, (_, i) => mk(i)), companies: [{ id: 'c', name: 'Co' }], hasMore: true };
      if (page === 2) return { jobs: [mk(50)], companies: [{ id: 'c', name: 'Co' }], hasMore: false };
      return { jobs: [], companies: [] };
    },
  });
  if (calls.length === 2 && calls[0].url === 'https://remotli.ch/api/jobs?page=1&limit=50&remote=all'
      && jobs.length === 51 && calls.every((call) => call.opts?.redirect === 'error')) pass('paginates active jobs with remote=all and redirect guard');
  else fail(`pagination=${JSON.stringify({ calls, count: jobs.length })}`);

  const capped = await provider.fetch({ name: 'Remotli', max_pages: 1 }, {
    transport: 'http', fetchJson: async () => ({ jobs: Array.from({ length: 50 }, (_, i) => mk(i)), companies: [], hasMore: true }),
  });
  if (capped.length === 50 && providerCoverage(capped)?.code === 'max_pages') pass('page cap preserves jobs with typed partial coverage'); else fail(`coverage=${JSON.stringify(providerCoverage(capped))}`);
  let repeatCalls = 0;
  const repeated = await provider.fetch({ max_pages: 4 }, { transport: 'http', fetchJson: async () => { repeatCalls++; return { jobs: [mk(1)], companies: [], hasMore: true }; } });
  if (repeatCalls === 2 && repeated.length === 1 && providerCoverage(repeated)?.code === 'repeated_page') pass('repeated pages stop safely'); else fail(`repeat=${JSON.stringify({ repeatCalls, coverage: providerCoverage(repeated) })}`);
  let malformed = false;
  try { await provider.fetch({}, { transport: 'http', fetchJson: async () => ({ jobs: {} }) }); } catch { malformed = true; }
  if (malformed) pass('malformed envelope throws'); else fail('malformed envelope accepted');
  let unusable = false;
  try { await provider.fetch({}, { transport: 'http', fetchJson: async () => ({ jobs: [{ status: 'active', title: 'Broken' }], companies: [] }) }); } catch { unusable = true; }
  if (unusable) pass('all-unusable active page throws'); else fail('all-unusable page accepted');
} catch (error) { fail(`remotli tests crashed: ${error.message}`); }
