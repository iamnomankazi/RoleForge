import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importLegacyQueue } from '../legacy-queue-importer.mjs';
import {
  acquireBatchExecutionLock,
  bindCandidateArtifact,
  confirmPreflight,
  loadBatchState,
  transitionCandidateState,
} from '../application-batch.mjs';
import { deriveCandidateId } from '../candidate-identity.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-legacy-import-'));
  const runId = 'phase-three-import-run';
  const runDir = join(root, 'output', 'scan-runs', runId);
  mkdirSync(runDir, { recursive: true });
  const candidates = [
    { company: 'Excluded Example', title: 'Data Intern', url: 'https://jobs.example.test/hone/7', source: 'fixture', run_id: runId },
    { company: 'Wolt', title: 'Backend Engineer', url: 'https://jobs.example.test/wolt/1?utm_source=queue', source: 'fixture', run_id: runId },
    { company: 'IMC', title: 'Graduate Engineer', url: 'https://jobs.example.test/imc/2', source: 'fixture', run_id: runId },
  ].map((row) => ({ ...row, candidate_id: deriveCandidateId(row) }));
  writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify({ run_id: runId }, null, 2)}\n`);
  writeFileSync(join(runDir, 'candidates.json'), `${JSON.stringify(candidates, null, 2)}\n`);
  const queue = join(root, 'explicit legacy queue.csv');
  writeFileSync(queue, [
    'rank,company,role,url',
    '99,Legacy Example A,Analytics Engineer,https://stale.example.test/danish',
    `2,Wolt,Backend Engineer,${candidates[1].url.replace('?utm_source=queue', '?utm_campaign=legacy')}`,
    `1,IMC,Graduate Engineer,${candidates[2].url}`,
    '17,Legacy Example B,Software Engineer,https://stale.example.test/persohap',
  ].join('\n'));
  return { root, runId, candidates, queue };
}

function usingFixture(fn) {
  const value = fixture();
  try { return fn(value); } finally { rmSync(value.root, { recursive: true, force: true }); }
}

test('explicit legacy URLs import only exact source-run members, never stale queue rows', () => usingFixture((f) => {
  const result = importLegacyQueue({
    root: f.root,
    queueFile: f.queue,
    sourceRunId: f.runId,
    batchId: 'legacy-exact-two',
    selectedUrls: [
      f.candidates[1].url.replace('?utm_source=queue', '?utm_campaign=legacy'),
      f.candidates[2].url,
    ],
    now: new Date('2026-01-01T10:00:00.000Z'),
  });
  assert.deepEqual(result.manifest.candidates.map((row) => row.candidate_id), [
    f.candidates[1].candidate_id, f.candidates[2].candidate_id,
  ]);
  const serialized = readFileSync(result.manifestPath, 'utf8');
  assert.doesNotMatch(serialized, /Legacy Example A|Legacy Example B/);
  assert.equal(result.manifest.legacyImport.queueFile, f.queue);
  assert.match(result.manifest.legacyImport.queueSha256, /^sha256:/);
  assert.deepEqual(result.manifest.legacyImport.selectedRows.map((row) => row.rowNumber), [3, 4]);
  const state = loadBatchState(result.manifestPath, { root: f.root }).state;
  assert.deepEqual(state.candidates.map((row) => row.importVerification.status), ['legacy_unverified', 'legacy_unverified']);

  const docs = join(f.root, 'output', 'documents');
  mkdirSync(docs, { recursive: true });
  const cv = join(docs, 'Alex Example Backend CV.pdf');
  writeFileSync(cv, 'cv');
  for (const candidate of result.manifest.candidates) {
    bindCandidateArtifact(result.manifestPath, candidate.candidate_id, { root: f.root, artifactType: 'cv', filePath: cv });
  }
  confirmPreflight(result.manifestPath, result.manifest.batchId, { root: f.root });
  const candidateId = result.manifest.candidates[0].candidate_id;
  const lock = acquireBatchExecutionLock(result.manifestPath, {
    root: f.root, candidateId, operation: 'prepare_application',
  });
  try {
    transitionCandidateState(result.manifestPath, candidateId, 'listing_verified', {
      root: f.root, currentUrl: result.manifest.candidates[0].listingUrl,
      reason: 'fresh liveness and visible identity verified', lockToken: lock.token,
    });
  } finally {
    lock.release();
  }
  assert.equal(loadBatchState(result.manifestPath, { root: f.root }).state.candidates[0].importVerification.status, 'fresh_verified');
}));

test('rank changes cannot affect explicit URL selection', () => usingFixture((f) => {
  const selectedUrl = f.candidates[2].url;
  const first = importLegacyQueue({ root: f.root, queueFile: f.queue, sourceRunId: f.runId, batchId: 'rank-a', selectedUrls: [selectedUrl] });
  const changed = readFileSync(f.queue, 'utf8').replace('1,IMC', '500,IMC');
  writeFileSync(f.queue, changed);
  const second = importLegacyQueue({ root: f.root, queueFile: f.queue, sourceRunId: f.runId, batchId: 'rank-b', selectedUrls: [selectedUrl],
    allowDuplicateReason: 'Re-import the same candidate to compare selection after a rank change.' });
  assert.equal(first.manifest.candidates[0].candidate_id, second.manifest.candidates[0].candidate_id);
}));

test('stable candidate-ID import is exact and cross-run IDs are rejected', () => usingFixture((f) => {
  const queue = join(f.root, 'id queue.csv');
  writeFileSync(queue, `candidate_id,url\n${f.candidates[1].candidate_id},${f.candidates[1].url}\n`);
  const result = importLegacyQueue({
    root: f.root,
    queueFile: queue,
    sourceRunId: f.runId,
    batchId: 'exact-id-import',
    selectedCandidateIds: [f.candidates[1].candidate_id],
  });
  assert.equal(result.manifest.candidates[0].candidate_id, f.candidates[1].candidate_id);

  const other = deriveCandidateId({ company: 'Other', title: 'Role', url: 'https://other.example.test/jobs/999' });
  writeFileSync(queue, `candidate_id,url\n${other},https://other.example.test/jobs/999\n`);
  assert.throws(() => importLegacyQueue({
    root: f.root, queueFile: queue, sourceRunId: f.runId, selectedCandidateIds: [other],
  }), /does not match source run/);
}));

test('importer rejects implicit queue, unmatched rows, ambiguity, and overwrite', () => usingFixture((f) => {
  assert.throws(() => importLegacyQueue({ root: f.root, sourceRunId: f.runId, selectedUrls: [f.candidates[1].url] }), /Explicit --queue-file/);
  assert.throws(() => importLegacyQueue({
    root: f.root, queueFile: f.queue, sourceRunId: f.runId, selectedUrls: ['https://stale.example.test/danish'],
  }), /does not match source run/);

  const ambiguousRun = 'ambiguous-import-run';
  const runDir = join(f.root, 'output', 'scan-runs', ambiguousRun);
  mkdirSync(runDir, { recursive: true });
  const shared = 'https://mirror.example.test/jobs/42';
  const rows = [
    { company: 'A', title: 'Engineer', url: 'https://a.example.test/1', url_aliases: [shared], run_id: ambiguousRun },
    { company: 'B', title: 'Engineer', url: 'https://b.example.test/2', url_aliases: [shared], run_id: ambiguousRun },
  ].map((row) => ({ ...row, candidate_id: deriveCandidateId(row) }));
  writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify({ run_id: ambiguousRun })}\n`);
  writeFileSync(join(runDir, 'candidates.json'), `${JSON.stringify(rows)}\n`);
  const ambiguousQueue = join(f.root, 'ambiguous.csv');
  writeFileSync(ambiguousQueue, `url\n${shared}\n`);
  assert.throws(() => importLegacyQueue({
    root: f.root, queueFile: ambiguousQueue, sourceRunId: ambiguousRun, selectedUrls: [shared],
  }), /ambiguous/);

  const args = { root: f.root, queueFile: f.queue, sourceRunId: f.runId, batchId: 'no-overwrite', selectedUrls: [f.candidates[2].url] };
  importLegacyQueue(args);
  assert.throws(() => importLegacyQueue(args), /EEXIST|already exists/i);
}));

test('CLI forwards --allow-duplicate with a required explicit reason', () => usingFixture((f) => {
  const queue = join(f.root, 'fictional queue.csv');
  writeFileSync(queue, `url\n${f.candidates[0].url}\n`);
  importLegacyQueue({
    root: f.root, queueFile: queue, sourceRunId: f.runId,
    batchId: 'cli-existing', selectedUrls: [f.candidates[0].url],
  });
  // Relocate the entry points so the CLI writes only to the fictional root.
  for (const name of ['application-batch.mjs', 'legacy-queue-importer.mjs']) {
    const sourceUrl = new URL(`../${name}`, import.meta.url);
    const script = readFileSync(sourceUrl, 'utf8').replace(/from '(\.\/[^']+)'/g, (_, path) => {
      const target = path === './application-batch.mjs'
        ? pathToFileURL(join(f.root, 'application-batch.mjs')) : new URL(path, sourceUrl);
      return `from '${target.href}'`;
    });
    writeFileSync(join(f.root, name), script);
  }
  const entry = join(f.root, 'legacy-queue-importer.mjs');
  const args = ['--queue-file', queue, '--source-run', f.runId, '--batch-id', 'cli-override', '--row', '2'];
  const run = (extra = []) => spawnSync(process.execPath, [entry, ...args, ...extra], { cwd: f.root, encoding: 'utf8' });
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--allow-duplicate <reason>/);
  const refused = run();
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /application batch cli-existing.*--allow-duplicate/);
  const missing = run(['--allow-duplicate']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing value for --allow-duplicate/);
  const empty = run(['--allow-duplicate', '   ']);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /--allow-duplicate requires a non-empty reason/);
  const reason = 'Alex Example approved this intentional fictional retry.';
  const allowed = run(['--allow-duplicate', reason]);
  assert.equal(allowed.status, 0, allowed.stderr);
  const result = JSON.parse(allowed.stdout);
  const { manifest } = loadBatchState(result.manifest, { root: f.root });
  assert.equal(manifest.duplicateOverride.reason, reason);
  assert.equal(manifest.legacyImport.selectedRows[0].rowNumber, 2);
  assert.equal(manifest.candidates[0].candidate_id, f.candidates[0].candidate_id);
}));
