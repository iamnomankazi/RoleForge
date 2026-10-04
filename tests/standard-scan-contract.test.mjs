import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { persistStandardScanRun } from '../scan.mjs';
import {
  buildCandidatesTsv,
  CANDIDATE_TSV_COLUMNS,
  mergeCanonicalCandidates,
} from '../scan-candidate-contract.mjs';
import { mergeCandidates } from '../merge-scan-results.mjs';
import { createApplicationBatch } from '../application-batch.mjs';

test('standard scan and worker merge share stable canonical identity and immutable artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-standard-scan-'));
  try {
    const row = {
      company: 'Acme', title: 'Data Engineer',
      url: 'https://boards.greenhouse.io/acme/jobs/123?utm_source=standard',
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/123#app',
      source: 'greenhouse', sourceQuery: 'data', seniority: ['junior'],
    };
    const standard = persistStandardScanRun({ runId: 'standard-run', offers: [row], root });
    const worker = mergeCandidates([{ name: 'worker.json', rows: [{ ...row, url: 'https://boards.greenhouse.io/acme/jobs/123?gh_src=worker' }] }], { runId: 'worker-run' });
    assert.equal(standard.candidates[0].candidate_id, worker.candidates[0].candidate_id);
    assert.equal(standard.candidates[0].schema_version, 3);
    assert.equal(standard.candidates[0].canonical_url, 'https://boards.greenhouse.io/acme/jobs/123');
    assert.ok(standard.candidates[0].url_aliases.some((url) => url.includes('utm_source')));
    for (const file of ['manifest.json', 'candidates.json', 'candidates.tsv', 'review.csv', 'review.md']) {
      assert.ok(readFileSync(join(standard.runDir, file), 'utf8').length > 0);
    }
    const canonicalJson = JSON.parse(readFileSync(join(standard.runDir, 'candidates.json'), 'utf8'));
    const [tsvHeader, tsvRow] = readFileSync(join(standard.runDir, 'candidates.tsv'), 'utf8').trim().split(/\r?\n/);
    const provenanceIndex = tsvHeader.split('\t').indexOf('provenance');
    assert.deepEqual(canonicalJson[0].provenance, [{ input: 'standard-scan', row: 1 }]);
    assert.equal(tsvRow.split('\t')[provenanceIndex], '[{"input":"standard-scan","row":1}]');
    const batch = createApplicationBatch({
      root,
      sourceRunId: 'standard-run',
      batchId: 'standard-batch',
      selectedCandidateIds: [standard.candidates[0].candidate_id],
    });
    assert.equal(batch.manifest.candidates[0].candidate_id, standard.candidates[0].candidate_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate TSV keeps primitive arrays readable and structured values lossless', () => {
  const candidate = {
    source_queries: ['Python', 'SQL'],
    salary: { currency: 'EUR', minimum: 42000 },
    notes: '=HYPERLINK("https://example.test")',
    provenance: [{ input: 'standard-scan', row: 4, detail: 'tab\there\nnext line' }],
  };
  const tsv = buildCandidatesTsv([candidate]);
  const lines = tsv.trimEnd().split(/\r?\n/);
  assert.equal(lines.length, 2);
  const header = lines[0].split('\t');
  const cells = lines[1].split('\t');
  assert.equal(header.length, CANDIDATE_TSV_COLUMNS.length);
  assert.equal(cells.length, CANDIDATE_TSV_COLUMNS.length);
  assert.equal(cells[header.indexOf('source_queries')], 'Python; SQL');
  assert.equal(cells[header.indexOf('salary')], '{"currency":"EUR","minimum":42000}');
  assert.equal(
    cells[header.indexOf('provenance')],
    '[{"input":"standard-scan","row":4,"detail":"tab\\there\\nnext line"}]',
  );
  assert.doesNotMatch(tsv, /\[object Object\]/);
  assert.equal(cells[header.indexOf('notes')], `'${candidate.notes}`);
});

test('standard scan artifacts preserve structured experience review evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-standard-experience-'));
  try {
    const experienceMetadata = {
      interpretation: 'stretch',
      numeric_hard_blocker: false,
      requirements: [{ text: '2-5 years', minimum_years: 2, maximum_years: 5, bound: 'range', strength: 'required', interpretation: 'stretch' }],
    };
    const result = persistStandardScanRun({
      runId: 'experience-run', root,
      offers: [{
        company: 'Example', title: 'ML Engineer II', url: 'https://jobs.example.com/experience',
        experienceMetadata,
      }],
    });
    const candidates = JSON.parse(readFileSync(join(result.runDir, 'candidates.json'), 'utf8'));
    assert.deepEqual(candidates[0].experience_metadata, experienceMetadata);
    const tsv = readFileSync(join(result.runDir, 'candidates.tsv'), 'utf8');
    assert.match(tsv, /"interpretation":"stretch"/);
    assert.doesNotMatch(tsv, /\[object Object\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('different requisitions with the same company and title remain distinct', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-standard-req-'));
  try {
    const result = persistStandardScanRun({
      runId: 'distinct-run', root,
      offers: [123, 124].map((id) => ({
        company: 'Acme', title: 'Software Engineer', source: 'greenhouse',
        url: `https://boards.greenhouse.io/acme/jobs/${id}`,
      })),
    });
    assert.equal(result.candidates.length, 2);
    assert.notEqual(result.candidates[0].candidate_id, result.candidates[1].candidate_id);
    assert.throws(() => persistStandardScanRun({ runId: 'distinct-run', root, offers: [] }), /EEXIST/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a completed zero-result standard scan still has an immutable run identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-standard-empty-'));
  try {
    const result = persistStandardScanRun({ runId: 'empty-run', offers: [], root });
    assert.equal(result.manifest.candidate_count, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(result.runDir, 'candidates.json'), 'utf8')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('location evidence and verified liveness survive canonical JSON, TSV, CSV, and Markdown artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-standard-liveness-'));
  try {
    const result = persistStandardScanRun({
      runId: 'liveness-run', root,
      offers: [
        {
          company: 'Active Co', title: 'Engineer - Berlin', url: 'https://jobs.example.com/active',
          location: 'United States', locationEligibility: 'eligible', locationEligibilityCode: 'target_region',
          locationEligibilityMatch: 'Berlin', locationEligibilitySource: 'title', sourceUrl: 'https://source.example/item/1',
          livenessStatus: 'active', livenessCode: 'apply_control_visible', livenessReason: 'visible apply control detected',
        },
        { company: 'Blocked Co', title: 'Engineer', url: 'https://jobs.example.com/blocked', livenessStatus: 'uncertain', livenessCode: 'bot_challenge', livenessReason: 'anti-bot challenge' },
      ],
    });
    const candidates = JSON.parse(readFileSync(join(result.runDir, 'candidates.json'), 'utf8'));
    assert.deepEqual(candidates.map((row) => [row.liveness_status, row.liveness_code]).sort(), [
      ['active', 'apply_control_visible'],
      ['uncertain', 'bot_challenge'],
    ]);
    const active = candidates.find((row) => row.company === 'Active Co');
    assert.equal(active.schema_version, 3);
    assert.equal(active.location, 'United States');
    assert.deepEqual([
      active.location_eligibility, active.location_eligibility_code,
      active.location_eligibility_match, active.location_eligibility_source,
    ], ['eligible', 'target_region', 'Berlin', 'title']);
    assert.equal(active.source_url, 'https://source.example/item/1');
    assert.match(readFileSync(join(result.runDir, 'candidates.tsv'), 'utf8'), /liveness_status\tliveness_code\tliveness_reason/);
    assert.match(readFileSync(join(result.runDir, 'candidates.tsv'), 'utf8'), /location_eligibility_match\tlocation_eligibility_source/);
    assert.match(readFileSync(join(result.runDir, 'review.csv'), 'utf8'), /active,apply_control_visible/);
    assert.match(readFileSync(join(result.runDir, 'review.csv'), 'utf8'), /eligible,target_region,Berlin,title/);
    const markdown = readFileSync(join(result.runDir, 'review.md'), 'utf8');
    assert.match(markdown, /eligible \/ target_region \/ Berlin \/ title/);
    assert.match(markdown, /active \/ apply_control_visible/);
    assert.match(markdown, /uncertain \/ bot_challenge/);
    assert.doesNotMatch(markdown, /\| Unverified \|/);
    const tableLines = markdown.split(/\r?\n/).filter((line) => line.startsWith('|'));
    const columnCounts = new Set(tableLines.map((line) => line.split('|').length));
    assert.deepEqual([...columnCounts], [14]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('location evidence merges atomically and deterministically without pessimistic eligibility', () => {
  const shared = { company: 'Acme', title: 'Engineer', url: 'https://jobs.example.com/roles/123' };
  const titleEvidence = {
    ...shared, location: 'United States', locationEligibility: 'eligible', locationEligibilityCode: 'target_region',
    locationEligibilityMatch: 'Berlin', locationEligibilitySource: 'title',
  };
  const urlEvidence = {
    ...shared, location: 'Remote', locationEligibility: 'eligible', locationEligibilityCode: 'target_region',
    locationEligibilityMatch: 'Finland', locationEligibilitySource: 'url',
  };
  const incompatible = {
    ...shared, location: 'US only', locationEligibility: 'ineligible', locationEligibilityCode: 'remote_restricted_elsewhere',
    locationEligibilityMatch: 'US', locationEligibilitySource: 'location',
  };
  const merge = (rows) => mergeCanonicalCandidates([{ name: 'fixture.json', rows }], {
    runId: 'merge-location', createdAt: '2026-08-09T00:00:00.000Z',
    locationPriority: [['Finland'], ['Germany'], ['Denmark'], ['Netherlands']],
  }).candidates[0];
  for (const rows of [[urlEvidence, incompatible, titleEvidence], [titleEvidence, incompatible, urlEvidence]]) {
    const candidate = merge(rows);
    assert.deepEqual([
      candidate.location_eligibility, candidate.location_eligibility_code,
      candidate.location_eligibility_match, candidate.location_eligibility_source,
    ], ['eligible', 'target_region', 'Berlin', 'title']);
  }
});

test('resolved eligible evidence drives configured location ordering with token-safe Europe fallback', () => {
  const rows = [
    { company: 'Unrelated', title: 'Engineer', url: 'https://jobs.example.com/5', location: 'Neumünster', locationEligibility: 'uncertain' },
    { company: 'Remote', title: 'Engineer', url: 'https://jobs.example.com/4', location: 'Remote', locationEligibility: 'uncertain' },
    { company: 'Denmark', title: 'Engineer', url: 'https://jobs.example.com/3', location: 'Herning, DK', locationEligibility: 'eligible', locationEligibilityMatch: 'Denmark', locationEligibilitySource: 'location' },
    { company: 'Berlin', title: 'Engineer - Berlin', url: 'https://jobs.example.com/2', location: 'United States', locationEligibility: 'eligible', locationEligibilityMatch: 'Berlin', locationEligibilitySource: 'title' },
    { company: 'Finland', title: 'Engineer', url: 'https://jobs.example.com/1', location: 'Helsinki, Finland', locationEligibility: 'eligible', locationEligibilityMatch: 'Finland', locationEligibilitySource: 'location' },
  ];
  const result = mergeCanonicalCandidates([{ name: 'fixture.json', rows }], {
    runId: 'sort-location', createdAt: '2026-08-09T00:00:00.000Z',
    locationPriority: [['Finland'], ['Germany', 'Berlin'], ['Denmark'], ['Netherlands']],
  });
  assert.deepEqual(result.candidates.map((row) => row.company), ['Finland', 'Berlin', 'Denmark', 'Remote', 'Unrelated']);
  assert.equal(result.candidates.find((row) => row.company === 'Berlin').location, 'United States');
});
