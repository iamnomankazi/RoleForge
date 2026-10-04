import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadProviders, resolveProvider } from '../providers/_registry.mjs';
import { buildImmutableScanRun } from '../scan-candidate-contract.mjs';
import { validatePortalsConfig } from '../validate-portals.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const providers = await loadProviders(join(ROOT, 'providers'));

test('active boards still auto-route and EchoJobs does not auto-route by name or URL', () => {
  assert.equal(
    resolveProvider({ name: 'Acme', careers_url: 'https://boards.greenhouse.io/acme' }, providers)?.provider?.id,
    'greenhouse',
  );
  assert.equal(resolveProvider({ name: 'EchoJobs' }, providers), null);
  assert.equal(
    resolveProvider({ name: 'EchoJobs', careers_url: 'https://echojobs.io/api/jobs' }, providers),
    null,
  );
});

test('explicit legacy EchoJobs config resolves, reports retirement, and performs no HTTP calls', async () => {
  const entry = { name: 'EchoJobs', provider: 'echojobs' };
  const resolved = resolveProvider(entry, providers);
  assert.equal(resolved?.provider?.id, 'echojobs');

  const validation = await validatePortalsConfig(
    { tracked_companies: [entry] },
    { providerIds: new Set(providers.keys()) },
  );
  assert.deepEqual(validation.errors, []);

  let calls = 0;
  const ctx = {
    transport: 'http',
    fetchJson: async () => { calls += 1; return { status: 429 }; },
    fetchText: async () => { calls += 1; return 'Vercel checkpoint'; },
  };
  await assert.rejects(
    resolved.provider.fetch(entry, ctx),
    /retired.*HTTP 429.*robots\.txt/i,
  );
  assert.equal(calls, 0);
});

test('retirement removes the example portal entry while historical EchoJobs provenance remains valid', () => {
  const portals = yaml.load(readFileSync(join(ROOT, 'templates/portals.example.yml'), 'utf8'));
  assert.equal((portals.job_boards || []).some((entry) => entry?.provider === 'echojobs'), false);
  assert.equal((portals.tracked_companies || []).some((entry) => entry?.provider === 'echojobs'), false);

  const docs = readFileSync(join(ROOT, 'docs/SUPPORTED_JOB_BOARDS.md'), 'utf8');
  const retiredSection = docs.split('## Retired sources')[1] || '';
  assert.doesNotMatch(docs.split('## Retired sources')[0], /^\| EchoJobs \|/m);
  assert.match(retiredSection, /### EchoJobs/);
  assert.match(retiredSection, /provider: echojobs/);

  const run = buildImmutableScanRun({
    runId: 'phase1b7-echojobs-provenance',
    locationPriority: [],
    inputs: [{
      name: 'legacy-echojobs.json',
      rows: [{
        company: 'Acme',
        title: 'ML Engineer',
        url: 'https://jobs.ashbyhq.com/acme/legacy-role',
        provider: 'echojobs',
        source: 'echojobs-api',
        sourceId: 'legacy-echojobs-123',
      }],
    }],
  });
  assert.equal(run.manifest.candidate_count, 1);
  assert.equal(run.candidates[0].source, 'echojobs-api');
  assert.equal(run.candidates[0].source_id, 'legacy-echojobs-123');
  assert.equal(run.candidates[0].provenance[0].provider, 'echojobs');
  assert.equal(run.candidates[0].provenance[0].source, 'echojobs-api');
});
