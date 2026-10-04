import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { persistStandardScanRun } from '../scan.mjs';
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
