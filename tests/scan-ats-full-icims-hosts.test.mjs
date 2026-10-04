import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, icimsHostCandidates } from '../scan-ats-full.mjs';

function hostnames(slug) {
  return icimsHostCandidates(slug);
}

test('iCIMS host candidates follow the directory slug preference rules', () => {
  assert.deepEqual(hostnames('s'), ['careers-s.icims.com', 's.icims.com']);
  assert.deepEqual(hostnames('careers-acme'), ['careers-acme.icims.com']);
  assert.deepEqual(hostnames('uscareers'), ['uscareers.icims.com', 'careers-uscareers.icims.com']);
  assert.deepEqual(hostnames('acme-labs'), ['careers-acme-labs.icims.com', 'acme-labs.icims.com']);
  assert.deepEqual(hostnames('AcMe'), ['careers-acme.icims.com', 'acme.icims.com']);
  assert.deepEqual(hostnames('---Acme-Labs'), ['careers-acme-labs.icims.com', 'acme-labs.icims.com']);
  assert.deepEqual(hostnames('ACMEcareers'), ['acmecareers.icims.com', 'careers-acmecareers.icims.com']);
  assert.deepEqual(hostnames('careers'), ['careers.icims.com', 'careers-careers.icims.com']);
});

test('iCIMS candidates preserve the source slug and carry only the ordered fallback URLs', () => {
  const entry = SOURCES.icims.toEntry('Acme-Labs');
  assert.equal(entry.name, 'Acme-Labs');
  assert.equal(entry.careers_url, 'https://careers-acme-labs.icims.com');
  assert.deepEqual(entry.fallback_urls, ['https://acme-labs.icims.com']);
  assert.equal(SOURCES.icims.dataset, 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/icims_companies.json');
  assert.equal(SOURCES.icims.toEntry('careers-acme').fallback_urls, undefined);
  assert.deepEqual(icimsHostCandidates('s'), ['careers-s.icims.com', 's.icims.com']);
  assert.deepEqual(icimsHostCandidates('careers-acme'), ['careers-acme.icims.com']);
  assert.deepEqual(icimsHostCandidates('uscareers'), ['uscareers.icims.com', 'careers-uscareers.icims.com']);
  assert.deepEqual(icimsHostCandidates('acme-labs'), ['careers-acme-labs.icims.com', 'acme-labs.icims.com']);
  assert.deepEqual(icimsHostCandidates('--AcMe'), ['careers-acme.icims.com', 'acme.icims.com']);
});

test('iCIMS host candidates reject empty, hostile, and invalid DNS slugs', () => {
  for (const slug of [
    '', '---', '../acme', 'acme/jobs', 'evil.com@attacker', 'acme?next=evil',
    'acme_corp', 'a..b', 'a.-b', 'a.b-', '.acme', 'acme.', 'a'.repeat(64),
    `${'a'.repeat(61)}.${'b'.repeat(61)}.${'c'.repeat(61)}.${'d'.repeat(61)}`,
  ]) {
    assert.deepEqual(icimsHostCandidates(slug), [], slug);
    assert.equal(SOURCES.icims.toEntry(slug), null, slug);
  }
});
