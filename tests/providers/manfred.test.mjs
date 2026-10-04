import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — manfred');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/manfred.mjs')).href);
  const provider = mod.default;
  if (provider.id === 'manfred') pass('manfred id is stable'); else fail(`id=${provider.id}`);
  if (provider.detect({ provider: 'manfred' })?.url === 'https://www.getmanfred.com/api/v2/public/offers?lang=EN') pass('detect pins the public feed'); else fail('detect drift');
  if (provider.detect({ provider: 'other' }) === null) pass('detect ignores other providers'); else fail('detect claimed another provider');
  if (mod.resolveLang({ lang: 'es' }) === 'ES' && mod.resolveLang({ lang: 'fr' }) === 'EN') pass('lang is constrained to EN/ES'); else fail('lang handling drift');

  const active = {
    id: 7, slug: 'python-engineer', status: 'ACTIVE', position: ' Python Engineer ',
    company: { name: ' Acme ' }, locations: ['Madrid, Spain'], remotePercentage: 0,
    salaryFrom: 40000, salaryTo: 50000, currency: ' €',
    description: '<p>Build APIs</p>', publishedAt: '2026-08-01T00:00:00Z',
  };
  const job = mod.normalizeManfredOffer(active, 'Fallback');
  if (job?.title === 'Python Engineer' && job.company === 'Acme' && job.location === 'Madrid, Spain'
      && job.url.endsWith('/7/python-engineer') && job.sourceId === '7'
      && job.salary?.currency === 'EUR' && job.description === '<p>Build APIs</p>'
      && job.postedAt === Date.parse('2026-08-01T00:00:00Z')) pass('normalizes title, identity, location, salary and evidence');
  else fail(`normalized=${JSON.stringify(job)}`);
  if (mod.normalizeManfredOffer({ ...active, status: 'CLOSED' }) === null && mod.normalizeManfredOffer({ ...active, id: undefined }) === null) pass('drops closed and structurally unusable offers'); else fail('drop rules drift');
  if (mod.resolveLocation({ locations: [], remotePercentage: 100 }) === 'Remote' && mod.resolveLocation({ locations: [], remotePercentage: 50 }) === 'Hybrid') pass('derives remote/hybrid only when source signals it'); else fail('location derivation drift');
  if (mod.normalizeCurrency(' €') === 'EUR' && mod.normalizeCurrency('₿') === '') pass('currency mapping fails closed on unknown symbols'); else fail('currency mapping drift');

  const ctx = { transport: 'http', fetchJson: async (url, opts) => {
    if (url !== 'https://www.getmanfred.com/api/v2/public/offers?lang=EN' || opts?.redirect !== 'error') throw new Error('request contract drift');
    return [active, { ...active, id: 8, status: 'CLOSED' }];
  } };
  const jobs = await provider.fetch({ provider: 'manfred', name: 'Board' }, ctx);
  if (jobs.length === 1 && jobs[0].sourceId === '7') pass('fetch keeps only active offers'); else fail(`fetch=${JSON.stringify(jobs)}`);
  if ((await provider.fetch({}, { transport: 'http', fetchJson: async () => [] })).length === 0) pass('valid empty catalogue is healthy'); else fail('empty catalogue drift');
  let malformed = false;
  try { await provider.fetch({}, { transport: 'http', fetchJson: async () => ({ offers: [] }) }); } catch { malformed = true; }
  if (malformed) pass('malformed payload throws'); else fail('malformed payload accepted');
  let unusable = false;
  try { await provider.fetch({}, { transport: 'http', fetchJson: async () => [{ status: 'ACTIVE', position: 'Broken' }] }); } catch { unusable = true; }
  if (unusable) pass('active all-unusable payload throws'); else fail('active all-unusable payload accepted');
} catch (error) { fail(`manfred tests crashed: ${error.message}`); }
