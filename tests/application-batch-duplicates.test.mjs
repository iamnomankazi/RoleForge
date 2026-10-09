import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  abandonApplicationBatch,
  createApplicationBatch,
  loadBatchState,
} from '../application-batch.mjs';

function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), 'roleforge-batch-duplicates-'));
  const candidate = { company: 'Example Labs, Inc.', title: 'Senior Data Engineer', url: 'https://jobs.example.test/one' };
  const runId = 'fictional-run';
  const runDir = join(root, 'output', 'scan-runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ run_id: runId }));
  writeFileSync(join(runDir, 'candidates.json'), JSON.stringify([candidate]));
  const create = (batchId, options = {}) => createApplicationBatch({
    root, sourceRunId: runId, batchId, selectedUrls: [candidate.url], ...options,
  });
  const trackerPath = join(root, 'data', 'applications.md');
  const writeTracker = (status, company = ' EXAMPLE  LABS INC ', role = 'senior data-engineer') => {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(trackerPath, [
      '# Fictional Applications',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|---|---|---|---|---|---|---|---|',
      `| 42 | 2026-10-01 | ${company} | ${role} | 4/5 | ${status} | - | - | Submission unverified |`,
    ].join('\n'));
  };
  try {
    callback({ root, candidate, runId, create, trackerPath, writeTracker });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const status of [
  'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP', 'Hired', 'Unknown',
  'aPpLiEd', '**APPLIED**', 'sent', 'respondido', 'entrevista', 'oferta',
  'RECHAZADA', 'descartada', 'no_aplicar', 'No Aplicar', 'monitor',
]) {
  test(`tracker ${status} rows refuse duplicate creation regardless of submission evidence`, () => withFixture((f) => {
    f.writeTracker(status);
    const before = readFileSync(f.trackerPath, 'utf8');
    assert.throws(() => f.create('refused'), (error) => {
      assert.match(error.message, /Duplicate application.*tracker row #42/);
      assert.ok(error.message.includes(status));
      assert.match(error.message, /--allow-duplicate "<reason>"/);
      return true;
    });
    assert.equal(existsSync(join(f.root, 'output', 'application-batches', 'refused')), false);
    assert.equal(readFileSync(f.trackerPath, 'utf8'), before);
  }));
}

for (const status of ['Evaluated', 'eVaLuAtEd', '**Evaluated**', 'EVALUADA']) {
  test(`tracker ${status} rows allow batch creation without an override`, () => withFixture((f) => {
    f.writeTracker(status);
    const before = readFileSync(f.trackerPath, 'utf8');
    const created = f.create('evaluated-batch');
    assert.equal(created.manifest.duplicateOverride, undefined);
    assert.equal(readFileSync(f.trackerPath, 'utf8'), before);
    assert.throws(() => f.create('duplicate-evaluated-batch'), /application batch evaluated-batch.*--allow-duplicate/);
  }));
}

test('tracker detection uses header-aware parsing and Unicode punctuation normalization', () => withFixture((f) => {
  f.writeTracker('Applied');
  writeFileSync(f.trackerPath, [
    '| # | Role | Location | Status | Company | Score | Notes | Date | Report | PDF |',
    '|---|---|---|---|---|---|---|---|---|---|',
    '| 19 | ＳＥＮＩＯＲ　ＤＡＴＡ—ＥＮＧＩＮＥＥＲ | Example City | Applied | ＥＸＡＭＰＬＥ ＬＡＢＳ ＩＮＣ | 4/5 | unverified | 2026-10-01 | - | - |',
  ].join('\n'));
  assert.throws(() => f.create('reordered-tracker'), /tracker row #19/);
}));

test('another non-abandoned batch blocks the same company and role across source runs and URLs', () => withFixture((f) => {
  const original = f.create('existing-active');
  const manifestBefore = readFileSync(original.manifestPath, 'utf8');
  const stateBefore = readFileSync(original.statePath, 'utf8');
  const runDir = join(f.root, 'output', 'scan-runs', 'second-run');
  mkdirSync(runDir);
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ run_id: 'second-run' }));
  const candidate = { company: 'example labs inc', role: 'SENIOR DATA-ENGINEER', url: 'https://another.example.test/two' };
  writeFileSync(join(runDir, 'candidates.json'), JSON.stringify([candidate]));
  assert.throws(() => f.create('refused-active', {
    sourceRunId: 'second-run', selectedUrls: [candidate.url],
  }), /application batch existing-active.*--allow-duplicate/);
  assert.equal(readFileSync(original.manifestPath, 'utf8'), manifestBefore);
  assert.equal(readFileSync(original.statePath, 'utf8'), stateBefore);
}));

test('an explicitly abandoned batch permits creation again', () => withFixture((f) => {
  const original = f.create('abandoned-batch');
  abandonApplicationBatch(original.manifestPath, { root: f.root, entireBatch: true, reason: 'Alex Example cancelled this fixture.' });
  const created = f.create('replacement-batch');
  assert.equal(created.manifest.batchId, 'replacement-batch');
  assert.equal(created.manifest.duplicateOverride, undefined);
}));

test('partial abandonment releases only the abandoned opening', () => withFixture((f) => {
  const other = { company: 'Example Labs Inc', title: 'Data Analyst', url: 'https://jobs.example.test/analyst' };
  writeFileSync(join(f.root, 'output', 'scan-runs', f.runId, 'candidates.json'), JSON.stringify([f.candidate, other]));
  const original = f.create('partially-abandoned', { selectedUrls: [f.candidate.url, other.url] });
  abandonApplicationBatch(original.manifestPath, {
    root: f.root, candidateId: original.manifest.candidates[0].candidate_id, reason: 'Alex Example cancelled the engineer application.',
  });
  f.create('replacement-engineer');
  assert.throws(() => f.create('refused-analyst', { selectedUrls: [other.url] }), /application batch partially-abandoned/);
}));

test('missing batch state does not imply abandonment', () => withFixture((f) => {
  const original = f.create('missing-state');
  rmSync(original.statePath);
  assert.throws(() => f.create('refused-missing-state'), /application batch missing-state.*--allow-duplicate/);
}));

test('an override permits tracker and batch conflicts and records a hash-bound reason', () => withFixture((f) => {
  f.create('existing-batch');
  f.writeTracker('Applied');
  const reason = 'Alex Example confirmed an intentional reapplication.';
  const created = f.create('overridden', { allowDuplicateReason: reason });
  assert.deepEqual(created.manifest.duplicateOverride, { reason });
  assert.equal(loadBatchState(created.manifestPath, { root: f.root }).manifest.duplicateOverride.reason, reason);
  const tampered = JSON.parse(readFileSync(created.manifestPath, 'utf8'));
  tampered.duplicateOverride.reason = 'Changed without approval.';
  writeFileSync(created.manifestPath, JSON.stringify(tampered));
  assert.throws(() => loadBatchState(created.manifestPath, { root: f.root }), /manifest scope hash mismatch/);
}));

test('an override requires a non-empty reason', () => withFixture((f) => {
  for (const reason of ['', '  \t\n  ']) {
    assert.throws(() => f.create('empty-reason', { allowDuplicateReason: reason }), /--allow-duplicate requires a non-empty reason/);
  }
  assert.equal(existsSync(join(f.root, 'output', 'application-batches')), false);
}));

test('distinct company or role allows creation without an override', () => withFixture((f) => {
  f.writeTracker('Applied', 'Other Example Labs', f.candidate.title);
  const first = f.create('nonduplicate');
  assert.equal(first.manifest.duplicateOverride, undefined);
  f.writeTracker('Evaluated', f.candidate.company, 'Senior Data Analyst');
  abandonApplicationBatch(first.manifestPath, { root: f.root, entireBatch: true, reason: 'Reset fictional batch for the second case.' });
  assert.equal(f.create('different-role').manifest.duplicateOverride, undefined);
}));

test('CLI refuses duplicates, requires an override value, and persists the explicit override reason', () => withFixture((f) => {
  f.writeTracker('Applied');
  // Relocate only the entry point so CLI output stays inside the fictional root.
  const sourceUrl = new URL('../application-batch.mjs', import.meta.url);
  const script = readFileSync(sourceUrl, 'utf8').replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, sourceUrl).href}'`);
  const entry = join(f.root, 'application-batch.mjs');
  writeFileSync(entry, script);
  mkdirSync(join(f.root, 'templates'));
  writeFileSync(join(f.root, 'templates', 'states.yml'), readFileSync(new URL('../templates/states.yml', import.meta.url)));
  const args = ['create', '--source-run', f.runId, '--batch-id', 'cli-batch', '--url', f.candidate.url];
  const run = (extra = []) => spawnSync(process.execPath, [entry, ...args, ...extra], { cwd: f.root, encoding: 'utf8' });
  const refused = run();
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /tracker row #42.*--allow-duplicate/);
  const missing = run(['--allow-duplicate']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing value for --allow-duplicate/);
  const reason = 'Alex Example approved this fictional retry.';
  const allowed = run(['--allow-duplicate', reason]);
  assert.equal(allowed.status, 0, allowed.stderr);
  const result = JSON.parse(allowed.stdout);
  const { manifest } = loadBatchState(result.manifest, { root: f.root });
  assert.equal(manifest.duplicateOverride.reason, reason);
  assert.equal(manifest.candidates[0].listingUrl, f.candidate.url);
}));
