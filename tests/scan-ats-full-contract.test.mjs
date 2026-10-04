import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { persistFullAtsScanRun } from '../scan-ats-full.mjs';
import { createApplicationBatch } from '../application-batch.mjs';

test('reverse ATS scan persists canonical immutable schema-v3 candidates compatible with exact-ID batches', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-full-ats-'));
  try {
    const offers = [
      { company: 'Acme', title: 'Engineer', source: 'greenhouse-full', url: 'https://job-boards.greenhouse.io/acme/jobs/123?utm_source=x' },
      { company: 'Acme', title: 'Engineer', source: 'greenhouse-full', url: 'https://job-boards.greenhouse.io/acme/jobs/124' },
      { company: 'Other', title: 'Engineer', source: 'workday-full', url: 'https://other.wd5.myworkdayjobs.com/site/job/Helsinki/Engineer_R123' },
    ];
    const result = persistFullAtsScanRun({ root, runId: 'full-ats-run', offers, createdAt: '2026-07-13T00:00:00.000Z' });
    assert.equal(result.manifest.schema_version, 3);
    assert.equal(result.manifest.source_architecture, 'reverse_ats_full');
    assert.equal(result.manifest.artifact_authority, 'review_only');
    assert.equal(result.candidates.length, 3);
    assert.notEqual(result.candidates[0].candidate_id, result.candidates[1].candidate_id);
    const tracked = result.candidates.find((row) => row.requisition_id === '123');
    assert.ok(tracked.url_aliases.some((url) => url.includes('utm_source')));
    for (const file of ['manifest.json', 'candidates.json', 'candidates.tsv', 'review.csv', 'review.md']) assert.ok(existsSync(join(result.runDir, file)));
    const batch = createApplicationBatch({ root, sourceRunId: 'full-ats-run', batchId: 'full-ats-batch', selectedCandidateIds: [tracked.candidate_id] });
    assert.equal(batch.manifest.candidates[0].candidate_id, tracked.candidate_id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('immutable collision fails before any mutable compatibility output can change', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-full-ats-collision-'));
  try {
    const pipeline = join(root, 'data', 'pipeline.md');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(pipeline, 'PIPELINE SENTINEL');
    persistFullAtsScanRun({ root, runId: 'collision-run', offers: [] });
    assert.throws(() => persistFullAtsScanRun({ root, runId: 'collision-run', offers: [] }), /EEXIST/);
    assert.equal(readFileSync(pipeline, 'utf8'), 'PIPELINE SENTINEL');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
