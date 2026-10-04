import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { pass, fail, ROOT } from './helpers.mjs';
import { loadProviders, resolveProvider } from '../providers/_registry.mjs';

console.log('\nProvider expansion - configured scan routing');

try {
  const expectedBoardProviders = [
    'a16z-speedrun-talent',
    'agentic-jobs',
    'himalayas',
    'jobicy',
    'jobspresso',
    'hackernews',
  ];
  const phase1b1Disposition = {
    consider: { enabled: false, placeholder: 'consider_board' },
    getro: { enabled: false, placeholder: 'careers_url' },
    wttj: { enabled: true },
    join: { enabled: false, placeholder: 'careers_url' },
    joinup: { enabled: true },
    manfred: { enabled: true },
    flowxtra: { enabled: true },
    remotli: { enabled: true },
  };
  const config = yaml.load(readFileSync(join(ROOT, 'templates/portals.example.yml'), 'utf8'));
  const boards = Array.isArray(config?.job_boards) ? config.job_boards : [];
  const tracked = Array.isArray(config?.tracked_companies) ? config.tracked_companies : [];
  const providers = await loadProviders(join(ROOT, 'providers'));

  const active = boards.filter((entry) => entry?.enabled !== false);
  for (const providerId of expectedBoardProviders) {
    const entries = active.filter((entry) => entry.provider === providerId);
    assert.equal(entries.length, 1, `${providerId} must have exactly one enabled job_boards entry`);
    const resolved = resolveProvider(entries[0], providers);
    assert.equal(resolved?.provider?.id, providerId, `${providerId} must resolve through the scanner registry`);
  }
  pass('all six board-wide providers are enabled once in tracked job_boards config and resolve through the normal registry');

  // Phase 1B-1 adapters are all registry-loaded. Tenant-scoped adapters stay
  // intentionally disabled until users supply real board identifiers/URLs;
  // board-wide adapters carry deterministic, bounded config in the template.
  for (const [providerId, disposition] of Object.entries(phase1b1Disposition)) {
    assert.ok(providers.has(providerId), `${providerId} must auto-load from providers/*.mjs`);
    const entries = boards.filter((entry) => entry?.provider === providerId);
    assert.equal(entries.length, 1, `${providerId} must have exactly one job_boards disposition`);
    const [entry] = entries;
    assert.equal(entry.enabled !== false, disposition.enabled, `${providerId} enabled disposition must be intentional`);
    assert.equal(resolveProvider(entry, providers)?.provider?.id, providerId, `${providerId} must resolve through the scanner registry`);

    if (!disposition.enabled) {
      assert.match(String(entry.notes || ''), /disabled|placeholder|replace|configure/i, `${providerId} disabled entry must explain configuration`);
      if (disposition.placeholder === 'consider_board') {
        assert.match(String(entry.consider_board || ''), /replace|placeholder/i, 'Consider must not ship a fake board id');
      }
      if (disposition.placeholder === 'careers_url') {
        assert.match(String(entry.careers_url || ''), /example|replace|placeholder/i, `${providerId} must remain a placeholder`);
      }
    }
  }

  const wttj = boards.find((entry) => entry?.provider === 'wttj');
  assert.ok(Array.isArray(wttj?.wttj?.queries) && wttj.wttj.queries.length > 0, 'WTTJ requires explicit raw discovery queries');
  assert.ok(wttj.wttj.queries.every((query) => typeof query === 'string' && query.trim()), 'WTTJ queries must be non-empty strings');
  assert.ok(wttj.wttj.max_hits > 0 && wttj.wttj.max_hits <= 200, 'WTTJ max_hits must stay within provider cap');
  assert.ok(wttj.wttj.max_pages > 0 && wttj.wttj.max_pages <= 50, 'WTTJ max_pages must stay within provider cap');
  assert.ok(wttj.wttj.max_jobs > 0 && wttj.wttj.max_jobs <= 2000, 'WTTJ max_jobs must stay within provider cap');
  pass('Phase 1B-1 providers auto-load and each has an explicit enabled/disabled config disposition with bounded WTTJ queries');

  const phase1b2 = ['eightfold', 'oraclecloud', 'jobvite'];
  for (const providerId of phase1b2) {
    assert.ok(providers.has(providerId), `${providerId} must auto-load from providers/*.mjs`);
    const entries = tracked.filter((entry) => entry?.provider === providerId);
    assert.equal(entries.length, 1, `${providerId} must have exactly one tracked-company disposition`);
    const [entry] = entries;
    assert.equal(entry.enabled, false, `${providerId} example remains disabled until tenant setup`);
    assert.match(String(entry.careers_url || ''), /\.invalid\//, `${providerId} example must use a non-runnable placeholder URL`);
    assert.match(String(entry.notes || ''), /disabled|placeholder|configure/i, `${providerId} example must explain setup`);
    assert.equal(providers.get(providerId).detect(entry), null, `${providerId} placeholder must not autodetect`);
    assert.equal(resolveProvider(entry, providers)?.provider?.id, providerId, `${providerId} explicit provider routing must resolve`);
  }
  assert.equal(resolveProvider({ careers_url: 'https://tenant.eightfold.ai/careers' }, providers)?.provider?.id, 'eightfold');
  assert.equal(resolveProvider({ careers_url: 'https://tenant.fa.us2.ocs.oraclecloud26.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs' }, providers)?.provider?.id, 'oraclecloud');
  assert.equal(resolveProvider({ careers_url: 'https://jobs.jobvite.com/acme' }, providers)?.provider?.id, 'jobvite');
  assert.equal(resolveProvider({ careers_url: 'https://jobs.jobvite.com/api/company/acme/jobs' }, providers)?.provider?.id === 'jobvite', false);
  pass('Phase 1B-2 tenant adapters load, autodetect valid hosts, keep .invalid examples non-runnable, and accept explicit routes');

  const icims = providers.get('icims');
  assert.ok(icims, 'icims must auto-load from providers/*.mjs');
  const icimsEntries = tracked.filter((entry) => entry?.provider === 'icims');
  assert.equal(icimsEntries.length, 1, 'icims must have exactly one tracked-company disposition');
  const [icimsEntry] = icimsEntries;
  assert.equal(icimsEntry.enabled, false, 'iCIMS example remains disabled until tenant setup');
  assert.match(String(icimsEntry.careers_url || ''), /\.invalid\//, 'iCIMS example must use a non-runnable placeholder URL');
  assert.match(String(icimsEntry.notes || ''), /disabled|placeholder|configure/i, 'iCIMS example must explain setup');
  assert.equal(icims.detect(icimsEntry), null, 'iCIMS placeholder must not autodetect');
  assert.equal(resolveProvider(icimsEntry, providers)?.provider?.id, 'icims', 'iCIMS explicit provider routing must resolve');
  assert.match(icims.detect({ careers_url: 'https://tenant.icims.com/jobs' })?.url || '', /^https:\/\/tenant\.icims\.com\/jobs\/search\?/);
  pass('Phase 1B-3 iCIMS adapter loads, keeps its .invalid example disabled, detects valid tenant hosts, and resolves explicitly');

  const gemEntry = { name: 'Retool', careers_url: 'https://jobs.gem.com/retool' };
  assert.equal(resolveProvider(gemEntry, providers)?.provider?.id, 'gem');
  assert.equal(resolveProvider({ name: 'Not Gem', careers_url: 'https://example.com/retool' }, providers), null);
  pass('a real Gem company-board URL routes to Gem while an unrelated host does not');

  const source = readFileSync(join(ROOT, 'scan.mjs'), 'utf8');
  assert.match(source, /const boards = Array\.isArray\(config\.job_boards\)/);
  assert.match(source, /resolveEntries\(boards, \{ isBoard: true \}\)/);
  assert.match(source, /const titleFilter = buildTitleFilter\(config\.title_filter\)/);
  assert.match(source, /const locationFilter = buildLocationFilter\(config\.location_filter\)/);
  pass('scanner consumes configured job_boards through the same normal title/location filtering path');
} catch (error) {
  fail(`provider expansion integration tests crashed: ${error.stack || error.message}`);
}
