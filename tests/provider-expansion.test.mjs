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
  const config = yaml.load(readFileSync(join(ROOT, 'templates/portals.example.yml'), 'utf8'));
  const boards = Array.isArray(config?.job_boards) ? config.job_boards : [];
  const providers = await loadProviders(join(ROOT, 'providers'));

  const active = boards.filter((entry) => entry?.enabled !== false);
  for (const providerId of expectedBoardProviders) {
    const entries = active.filter((entry) => entry.provider === providerId);
    assert.equal(entries.length, 1, `${providerId} must have exactly one enabled job_boards entry`);
    const resolved = resolveProvider(entries[0], providers);
    assert.equal(resolved?.provider?.id, providerId, `${providerId} must resolve through the scanner registry`);
  }
  pass('all six board-wide providers are enabled once in tracked job_boards config and resolve through the normal registry');

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
