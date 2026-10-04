import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import yaml from 'js-yaml';
import { validatePortalsConfig } from '../validate-portals.mjs';
import { loadProviders, resolveProvider } from '../providers/_registry.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const template = yaml.load(readFileSync(join(ROOT, 'templates/portals.example.yml'), 'utf8'));

test('VDAB example stays opt-in, uses the public board, and resolves through the normal provider registry', async () => {
  const boards = Array.isArray(template.job_boards) ? template.job_boards : [];
  const entries = boards.filter((entry) => entry?.provider === 'vdab');
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.enabled, false);
  assert.equal(entry.careers_url, 'https://www.vdab.be/vindeenjob/vacatures');
  assert.deepEqual(entry.vdab, {
    keywords: ['software'],
    days: 30,
    size: 100,
    fetchDetails: false,
    detailLimit: 25,
  });

  const providers = await loadProviders(join(ROOT, 'providers'));
  assert.equal(resolveProvider(entry, providers)?.provider?.id, 'vdab');
  const result = await validatePortalsConfig(template, { providerIds: new Set(providers.keys()) });
  assert.deepEqual(result.errors, []);
});

test('Interamt example is explicit, bounded, and kept outside provider routing', () => {
  assert.deepEqual(template.interamt_searches, [{ was: 'Informatik' }]);
  assert.deepEqual(template.interamt, {
    max_load_more: 10,
    page_timeout_ms: 15000,
    wait_timeout_ms: 10000,
  });
  const providers = yaml.load(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(providers.scripts['scan:interamt'], 'node scan-interamt.mjs');
  assert.equal((template.job_boards || []).some((entry) => entry?.provider === 'interamt'), false);
});

test('optional provider settings may be omitted for profile-role fallback', async () => {
  const result = await validatePortalsConfig({
    tracked_companies: [],
    job_boards: [{ provider: 'vdab' }],
  });
  assert.deepEqual(result.errors, []);
});

test('VDAB configuration reports malformed keywords, numeric bounds, and non-boolean detail opt-in', async () => {
  const result = await validatePortalsConfig({
    job_boards: [{
      provider: 'vdab',
      vdab: {
        keywords: [' software ', 'software', 42],
        days: 0,
        size: 101,
        fetchDetails: 'false',
        detailLimit: 0,
      },
    }],
  });
  const paths = result.errors.map((issue) => issue.path);
  assert.ok(paths.includes('job_boards[0].vdab.keywords[0]'));
  assert.ok(paths.includes('job_boards[0].vdab.keywords[1]'));
  assert.ok(paths.includes('job_boards[0].vdab.keywords[2]'));
  assert.ok(paths.includes('job_boards[0].vdab.days'));
  assert.ok(paths.includes('job_boards[0].vdab.size'));
  assert.ok(paths.includes('job_boards[0].vdab.fetchDetails'));
  assert.ok(paths.includes('job_boards[0].vdab.detailLimit'));
});

test('Interamt configuration reports empty, duplicate, malformed, oversized, and out-of-range values', async () => {
  const empty = await validatePortalsConfig({ interamt_searches: [] });
  assert.ok(empty.errors.some((issue) => issue.path === 'interamt_searches'));

  const result = await validatePortalsConfig({
    interamt_searches: [
      { was: 'Informatik' },
      { was: ' informatik ' },
      { was: '' },
      'Data Engineering',
      { was: 'x'.repeat(121) },
    ],
    interamt: {
      max_load_more: 51,
      page_timeout_ms: 0,
      wait_timeout_ms: '10000',
    },
  });
  const paths = result.errors.map((issue) => issue.path);
  assert.ok(paths.includes('interamt_searches[1].was'));
  assert.ok(paths.includes('interamt_searches[2].was'));
  assert.ok(paths.includes('interamt_searches[3]'));
  assert.ok(paths.includes('interamt_searches[4].was'));
  assert.ok(paths.includes('interamt.max_load_more'));
  assert.ok(paths.includes('interamt.page_timeout_ms'));
  assert.ok(paths.includes('interamt.wait_timeout_ms'));
});
