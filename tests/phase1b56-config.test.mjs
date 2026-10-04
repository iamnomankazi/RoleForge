import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import yaml from 'js-yaml';
import { validatePortalsConfig } from '../validate-portals.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('Workday portal settings are optional and accept exact opaque facet IDs', async () => {
  const omitted = await validatePortalsConfig(
    { tracked_companies: [{ name: 'Acme', provider: 'workday' }] },
    { providerIds: new Set(['workday']) },
  );
  assert.deepEqual(omitted.errors, []);

  const configured = await validatePortalsConfig({
    tracked_companies: [{
      name: 'Acme',
      provider: 'workday',
      workday: {
        detailLimit: 0,
        appliedFacets: {
          locationHierarchy1: ['EU-17', 'opaque/id:42'],
        },
      },
    }],
  }, { providerIds: new Set(['workday']) });
  assert.deepEqual(configured.errors, []);
});

test('Workday options are strictly shaped and bounded on company and board entries', async () => {
  const tooManyIds = Array.from({ length: 51 }, (_, index) => `id-${index}`);
  const tooManyFacets = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`facet-${index}`, ['id']]));
  const longFacetName = 'f'.repeat(201);
  const result = await validatePortalsConfig({
    tracked_companies: [{
      name: 'Acme',
      workday: {
        detailLimit: 101,
        appliedFacets: {
          '': ['valid'],
          [longFacetName]: ['valid'],
          location: ['valid', 'valid', '', 42, 'x'.repeat(201)],
          oversized: tooManyIds,
          ...tooManyFacets,
        },
      },
    }],
    job_boards: [{
      workday: { appliedFacets: 'Remote' },
    }],
  });
  const paths = result.errors.map((issue) => issue.path);
  assert.ok(paths.includes('tracked_companies[0].workday.detailLimit'));
  assert.ok(paths.includes('tracked_companies[0].workday.appliedFacets.'));
  assert.ok(paths.includes(`tracked_companies[0].workday.appliedFacets.${longFacetName}`));
  assert.ok(paths.includes('tracked_companies[0].workday.appliedFacets.location[1]'));
  assert.ok(paths.includes('tracked_companies[0].workday.appliedFacets.location[2]'));
  assert.ok(paths.includes('tracked_companies[0].workday.appliedFacets.location[3]'));
  assert.ok(paths.includes('tracked_companies[0].workday.appliedFacets.location[4]'));
  assert.ok(paths.includes('tracked_companies[0].workday.appliedFacets.oversized'));
  assert.ok(paths.includes('job_boards[0].workday.appliedFacets'));
});

test('Workday example documents default no-facet behavior and bounded tenant options', () => {
  const templateText = readFileSync(join(ROOT, 'templates/portals.example.yml'), 'utf8');
  const template = yaml.load(templateText);
  assert.ok(templateText.includes('# - name: Example Workday Co'));
  assert.match(templateText, /workday:\n#\s+detailLimit: 20/);
  assert.match(templateText, /Omit appliedFacets for the default unfiltered request/);
  assert.match(templateText, /opaque IDs copied from this tenant's Workday board/);
  assert.ok(Array.isArray(template.tracked_companies));
});
