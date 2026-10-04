import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildReviewCsv, buildReviewMarkdown, canonicalUrl, mergeCandidates, parseJsonFile } from '../merge-scan-results.mjs';

test('reads BOM-prefixed scan JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-scan-'));
  const file = join(dir, 'worker.json');
  writeFileSync(file, '\uFEFF' + JSON.stringify({ offers: [{ company: 'A', title: 'Engineer', url: 'https://a.test/job/1' }] }));
  assert.equal(parseJsonFile(file).length, 1);
});

test('deduplicates tracking URLs and preserves provenance', () => {
  const result = mergeCandidates([
    { name: 'a.json', rows: [{ company: 'Acme', title: 'Junior Engineer', location: 'Helsinki', url: 'https://jobs.test/1?utm_source=x' }] },
    { name: 'b.json', rows: [{ company: 'Acme', title: 'Junior Engineer', location: 'Helsinki', url: 'https://jobs.test/1' }] },
  ]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.candidates[0].provenance.length, 2);
  assert.match(result.candidates[0].candidate_id, /^cand_v1_[a-f0-9]{64}$/);
  assert.equal(canonicalUrl('https://JOBS.test/1/?utm_source=x#top'), 'https://jobs.test/1');
});

test('does not collapse distinct ATS requisitions with the same title', () => {
  const result = mergeCandidates([{ name: 'a.json', rows: [
    { company: 'Acme', title: 'Software Engineer', location: 'Berlin', url: 'https://job-boards.greenhouse.io/acme/jobs/100' },
    { company: 'Acme', title: 'Software Engineer', location: 'Berlin', url: 'https://job-boards.greenhouse.io/acme/jobs/101' },
  ] }]);
  assert.equal(result.candidates.length, 2);
  assert.notEqual(result.candidates[0].candidate_id, result.candidates[1].candidate_id);
});

test('builds human-reviewable CSV and Markdown safely', () => {
  const candidates = [{
    company: '=Example Oy', title: 'Junior Data | Engineer', url: 'https://example.test/jobs/1',
    location: 'Helsinki', postedAt: '2026-07-10', source: 'worker', status: 'discovered',
    hardBlockers: ['Finnish required'], provenance: [{ input: 'worker.json', row: 1 }],
    matchBucket: 'Blocked', matchReason: 'Language blocker', recommendedCvVariant: 'ml-ai.pdf',
    sourceWorker: 'fresh-discovery', notes: 'Check language wording',
    run_id: 'test-run', candidate_id: `cand_v1_${'a'.repeat(64)}`,
  }];
  const csv = buildReviewCsv(candidates);
  const md = buildReviewMarkdown(candidates, {
    run_id: 'test-run', runId: 'test-run', createdAt: '2026-07-10T00:00:00.000Z', candidates: 1,
    duplicatesRemoved: 0, invalidRows: 0,
    matchBuckets: { 'Strong Match': 0, 'Viable Apply': 0, 'Stretch Credible': 0, Blocked: 1 },
  });
  assert.match(csv, /^run_id,candidate_id,review_decision,match_bucket,hard_blocker_check,liveness,/);
  assert.match(csv, /test-run,cand_v1_/);
  assert.match(csv, /'=Example Oy/);
  assert.match(csv, /detected - verify/);
  assert.match(md, /Junior Data \\| Engineer/);
  assert.match(md, /Unverified/);
  assert.match(md, /Language blocker/);
  assert.match(md, /Candidate ID/);
  assert.match(md, /cand_v1_/);
});

test('preserves classification metadata and blockers win duplicate merges', () => {
  const result = mergeCandidates([
    { name: 'fresh.json', rows: [{ company: 'Acme', title: 'Engineer', url: 'https://jobs.test/1', matchBucket: 'Strong Match', matchReason: 'Python', sourceWorker: 'fresh' }] },
    { name: 'ats.json', rows: [{ company: 'Acme', title: 'Engineer', url: 'https://jobs.test/1', matchBucket: 'Blocked', hardBlockers: ['German required'], notes: 'Verified in JD', sourceWorker: 'ats' }] },
  ]);
  assert.equal(result.candidates[0].matchBucket, 'Blocked');
  assert.deepEqual(result.candidates[0].hardBlockers, ['German required']);
  assert.equal(result.candidates[0].sourceWorker, 'fresh | ats');
});

test('orders the review by bucket, target geography, then freshness', () => {
  const rows = [
    { company: 'BlockedCo', title: 'Engineer', url: 'https://x.test/1', location: 'Finland', matchBucket: 'Blocked' },
    { company: 'OlderDE', title: 'Engineer', url: 'https://x.test/2', location: 'Berlin, Germany', postedAt: '2026-07-01', matchBucket: 'Strong Match' },
    { company: 'FreshFI', title: 'Engineer', url: 'https://x.test/3', location: 'Helsinki, Finland', postedAt: '2026-07-10', matchBucket: 'Strong Match' },
    { company: 'ViableFI', title: 'Engineer', url: 'https://x.test/4', location: 'Helsinki, Finland', matchBucket: 'Viable Apply' },
  ];
  const result = mergeCandidates([{ name: 'worker.json', rows }]);
  assert.deepEqual(result.candidates.map(row => row.company), ['FreshFI', 'OlderDE', 'ViableFI', 'BlockedCo']);
});

test('run directories are immutable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-scan-'));
  const input = join(dir, 'input.json');
  const out = join(dir, 'runs');
  writeFileSync(input, JSON.stringify([{ company: 'A', title: 'Engineer', url: 'https://a.test/1' }]));
  const args = ['merge-scan-results.mjs', '--run-id', 'same', '--out-root', out, input];
  const first = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8' });
  const second = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /EEXIST|file already exists/i);
  assert.equal(JSON.parse(readFileSync(join(out, 'same', 'manifest.json'), 'utf8')).candidate_count, 1);
  const manifest = JSON.parse(readFileSync(join(out, 'same', 'manifest.json'), 'utf8'));
  const candidates = JSON.parse(readFileSync(join(out, 'same', 'candidates.json'), 'utf8'));
  assert.equal(manifest.schema_version, 3);
  assert.equal(manifest.run_id, 'same');
  assert.equal(candidates[0].run_id, 'same');
  assert.match(candidates[0].candidate_id, /^cand_v1_[a-f0-9]{64}$/);
  assert.match(readFileSync(join(out, 'same', 'candidates.tsv'), 'utf8'), /^schema_version\trun_id\tcandidate_id\t/);
  assert.match(readFileSync(join(out, 'same', 'review.csv'), 'utf8'), /^run_id,candidate_id,review_decision/);
  assert.match(readFileSync(join(out, 'same', 'review.md'), 'utf8'), /Candidate ID/);
  assert.match(readFileSync(join(out, 'same', 'review.md'), 'utf8'), new RegExp(candidates[0].candidate_id));
});

test('same listing keeps candidate_id across runs while run_id changes', () => {
  const input = [{ name: 'worker.json', rows: [{ company: 'A', title: 'Engineer', url: 'https://a.test/jobs/1?utm_source=x' }] }];
  const first = mergeCandidates(input, { runId: 'run-one' }).candidates[0];
  const second = mergeCandidates(input, { runId: 'run-two' }).candidates[0];
  assert.equal(first.candidate_id, second.candidate_id);
  assert.equal(first.run_id, 'run-one');
  assert.equal(second.run_id, 'run-two');
});
