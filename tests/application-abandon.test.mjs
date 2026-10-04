import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  abandonApplicationBatch, acquireBatchExecutionLock, createApplicationBatch, inspectCandidateClaim, loadBatchState,
} from '../application-batch.mjs';
import { deriveCandidateId } from '../candidate-identity.mjs';
import { parseAbandonArgs } from '../application-abandon.mjs';

function fixture(count = 2) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-abandon-'));
  const runId = 'phase5-run';
  const candidates = Array.from({ length: count }, (_, index) => {
    const row = { company: `Acme ${index}`, title: 'Engineer', url: `https://jobs.example.test/${index}`, run_id: runId };
    return { ...row, candidate_id: deriveCandidateId(row) };
  });
  const runDir = join(root, 'output', 'scan-runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ run_id: runId }));
  writeFileSync(join(runDir, 'candidates.json'), JSON.stringify(candidates));
  const tracker = join(root, 'data', 'applications.md');
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(tracker, 'TRACKER SENTINEL');
  const created = createApplicationBatch({ root, sourceRunId: runId, batchId: `batch-${count}`, selectedCandidateIds: candidates.map((r) => r.candidate_id) });
  return { root, candidates, created, tracker };
}

test('exact candidate abandonment releases its claim atomically and retains audit evidence without tracker mutation', () => {
  const f = fixture();
  try {
    const id = f.candidates[0].candidate_id;
    const executor = acquireBatchExecutionLock(f.created.manifestPath, { root: f.root, candidateId: id, operation: 'prepare_application' });
    executor.release();
    assert.ok(inspectCandidateClaim(f.root, id));
    const result = abandonApplicationBatch(f.created.manifestPath, { root: f.root, candidateId: id, reason: 'User chose not to continue.' });
    assert.equal(result.idempotent, false);
    assert.equal(inspectCandidateClaim(f.root, id), null);
    const row = loadBatchState(f.created.manifestPath, { root: f.root }).state.candidates[0];
    assert.equal(row.state, 'abandoned');
    assert.equal(row.abandonmentHistory[0].previousState, 'not_opened');
    assert.equal(row.abandonmentHistory[0].claimRelease.status, 'released');
    assert.equal(readFileSync(f.tracker, 'utf8'), 'TRACKER SENTINEL');
    assert.equal(abandonApplicationBatch(f.created.manifestPath, { root: f.root, candidateId: id, reason: 'Same decision.' }).idempotent, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('explicit batch abandonment validates every candidate and releases all claims', () => {
  const f = fixture();
  try {
    for (const row of f.candidates) acquireBatchExecutionLock(f.created.manifestPath, { root: f.root, candidateId: row.candidate_id, operation: 'prepare_application' }).release();
    const result = abandonApplicationBatch(f.created.manifestPath, { root: f.root, entireBatch: true, reason: 'Batch intentionally cancelled.' });
    assert.deepEqual(result.candidates, f.candidates.map((row) => row.candidate_id));
    assert.ok(loadBatchState(f.created.manifestPath, { root: f.root }).state.candidates.every((row) => row.state === 'abandoned'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('active executor is refused while a conservatively recoverable stale/PID-reused lock is released', () => {
  const f = fixture(1);
  try {
    const id = f.candidates[0].candidate_id;
    const active = acquireBatchExecutionLock(f.created.manifestPath, { root: f.root, candidateId: id, operation: 'prepare_application' });
    assert.throws(() => abandonApplicationBatch(f.created.manifestPath, { root: f.root, candidateId: id, reason: 'No longer wanted.' }), /already executing/);
    active.release();
    const lockDir = join(f.root, 'output', 'application-batches', f.created.manifest.batchId, '.execution.lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ schemaVersion: 2, batchId: f.created.manifest.batchId, candidateId: id, operation: 'prepare_application', token: 'old', hostname: 'fixture', pid: process.pid, processStartKey: 'reused-old-process', acquiredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString() }));
    const result = abandonApplicationBatch(f.created.manifestPath, { root: f.root, candidateId: id, reason: 'Recover stale claim.', processStartKeyForPid: () => 'current-process' });
    assert.equal(result.idempotent, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('wrong candidate, missing reason, URL/global-queue selectors, and implicit batch scope fail closed', () => {
  const f = fixture(1);
  try {
    assert.throws(() => abandonApplicationBatch(f.created.manifestPath, { root: f.root, candidateId: deriveCandidateId({ url: 'https://other.test/1' }), reason: 'No.' }), /not in/);
    assert.throws(() => abandonApplicationBatch(f.created.manifestPath, { root: f.root, candidateId: f.candidates[0].candidate_id, reason: '' }), /reason/);
    assert.throws(() => parseAbandonArgs(['--manifest', f.created.manifestPath, '--candidate-id', 'https://jobs.example.test/0', '--reason', 'No.']), /candidate ID/);
    assert.throws(() => parseAbandonArgs(['--manifest', f.created.manifestPath, '--reason', 'No.']), /exactly one/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
