import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — flowxtra');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/flowxtra.mjs')).href);
  const provider = mod.default;
  const { providerCoverage } = await import(pathToFileURL(join(ROOT, 'providers/_result.mjs')).href);
  if (provider.id === 'flowxtra') pass('flowxtra id is stable'); else fail(`id=${provider.id}`);
  const full = mod.normalizeFlowxtraJob({
    id: 'a1', title: ' Staff AI Engineer ', urlJobApplay: 'https://flowxtra.com/apply/a1',
    name_company: ' Acme ', city_company: 'Helsinki', country_company: 'Finland', workplace: 'Remote',
    date_share: '2026-08-01T00:00:00Z', description: '<p>Python</p>', salaryMin: 70000, salaryMax: 80000, currency: 'EUR',
    url: 'https://flowxtra.com/jobs/a1',
  });
  if (full?.title === 'Staff AI Engineer' && full.company === 'Acme' && full.location === 'Helsinki, Finland, Remote'
      && full.sourceId === 'a1' && full.sourceUrl === 'https://flowxtra.com/jobs/a1'
      && full.description === '<p>Python</p>' && full.salary?.min === 70000) pass('normalizes provenance and cheap metadata');
  else fail(`normalized=${JSON.stringify(full)}`);
  if (mod.normalizeFlowxtraJob({ title: 'x', urlJobApplay: 'https://evil.example/x' }) === null
      && mod.normalizeFlowxtraJob({ title: 'x', urlJobApplay: 'http://flowxtra.com/x' }) === null) pass('rejects off-host/insecure destinations'); else fail('destination guard drift');

  const mk = (i) => ({ id: `id-${i}`, title: `Role ${i}`, urlJobApplay: `https://flowxtra.com/apply/${i}`, name_company: `Co ${i}`, city_company: 'Berlin' });
  const calls = [];
  const result = await provider.fetch({ name: 'Flowxtra', max_pages: 4 }, {
    transport: 'http',
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) return { data: { data: Array.from({ length: 100 }, (_, i) => mk(i)), next_page_url: 'https://app.flowxtra.com/api/central/jobs?page=2' } };
      if (page === 2) return { data: { data: [mk(100)], next_page_url: null } };
      return { data: { data: [] } };
    },
  });
  if (calls.length === 2 && calls[0].url === 'https://app.flowxtra.com/api/central/jobs?status=Live&per_page=100&page=1'
      && result.length === 101 && calls.every((call) => call.opts?.redirect === 'error')) pass('paginates bounded pages and propagates redirect guard');
  else fail(`pagination=${JSON.stringify({ calls, count: result.length })}`);

  const capped = await provider.fetch({ name: 'Flowxtra', max_pages: 1 }, {
    transport: 'http', fetchJson: async () => ({ data: { data: Array.from({ length: 100 }, (_, i) => mk(i)), next_page_url: 'next' } }),
  });
  if (capped.length === 100 && providerCoverage(capped)?.code === 'max_pages') pass('page cap preserves jobs with typed partial coverage'); else fail(`coverage=${JSON.stringify(providerCoverage(capped))}`);

  let repeatCalls = 0;
  const repeated = await provider.fetch({ max_pages: 5 }, {
    transport: 'http', fetchJson: async () => { repeatCalls++; return { data: { data: [mk(1)], next_page_url: 'next' } }; },
  });
  if (repeatCalls === 2 && repeated.length === 1 && providerCoverage(repeated)?.code === 'repeated_page') pass('repeated pages stop safely'); else fail(`repeat=${JSON.stringify({ repeatCalls, coverage: providerCoverage(repeated) })}`);

  let malformed = false;
  try { await provider.fetch({}, { transport: 'http', fetchJson: async () => ({ data: {} }) }); } catch { malformed = true; }
  if (malformed) pass('malformed envelope throws'); else fail('malformed envelope accepted');
  let unusable = false;
  try { await provider.fetch({}, { transport: 'http', fetchJson: async () => ({ data: { data: [{ title: 'Broken' }] } }) }); } catch { unusable = true; }
  if (unusable) pass('all-unusable non-empty page throws'); else fail('all-unusable page accepted');
} catch (error) { fail(`flowxtra tests crashed: ${error.message}`); }
