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

function writeRun(f, runId, company, title = f.candidate.title) {
  const runDir = join(f.root, 'output', 'scan-runs', runId);
  mkdirSync(runDir, { recursive: true });
  const candidate = { company, title, url: `https://jobs.example.test/${runId}` };
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ run_id: runId }));
  writeFileSync(join(runDir, 'candidates.json'), JSON.stringify([candidate]));
  return { sourceRunId: runId, selectedUrls: [candidate.url] };
}

for (const suffix of [
  'GmbH', 'AG', 'SE', 'Oy', 'Oyj', 'AB', 'ApS', 'A/S', 'AS', 'BV', 'B.V.', 'NV',
  'Ltd', 'Limited', 'LLC', 'Inc.', 'Corp.', 'Corporation', 'PLC', 'SA', 'SAS', 'SRL', 'SpA',
  'GmbH & Co. KG', 'KG',
]) {
  test(`trailing ${suffix} matches bare company names in trackers and batches in both directions`, () => {
    for (const [existingCompany, company] of [
      [`Example Labs, ${suffix}`, 'Example Labs'], ['Example Labs', `Example Labs ${suffix}`],
    ]) {
      withFixture((f) => {
        const selected = writeRun(f, 'suffix-candidate', company);
        f.writeTracker('Applied', existingCompany);
        assert.throws(() => f.create('tracker-refused', selected), /tracker row #42/);
        assert.equal(existsSync(join(f.root, 'output', 'application-batches')), false);
        f.writeTracker('Evaluated', existingCompany);
        f.create('suffix-existing', writeRun(f, 'suffix-original', existingCompany));
        assert.throws(() => f.create('batch-refused', selected), /application batch suffix-existing/);
      });
    }
  });
}

test('legal suffix stripping is limited to trailing company tokens', () => withFixture((f) => {
  for (const company of ['GmbH Example Labs', 'Example Labsag', 'Example Labs Partners']) {
    f.writeTracker('Applied', company);
    const result = f.create(`distinct-company-${company.replace(/ /g, '-')}`, writeRun(f, 'bare-company', 'Example Labs'));
    abandonApplicationBatch(result.manifestPath, { root: f.root, entireBatch: true, reason: 'Reset fictional company case.' });
  }
  f.writeTracker('Applied', 'Example Labs', 'Senior Data Engineer GmbH');
  const selected = writeRun(f, 'bare-role', 'Example Labs');
  f.create('distinct-role', selected);
  f.writeTracker('Evaluated');
  assert.equal(f.create('role-suffix', writeRun(f, 'suffixed-role', 'Example Labs', 'Senior Data Engineer GmbH')).manifest.duplicateOverride, undefined);
}));

for (const [existingRole, role] of [
  ['C++ Developer', 'C# Developer'], ['C++ Developer', 'C Developer'],
  ['C# Developer', 'C Developer'], ['F# Developer', 'F Developer'], ['.NET Developer', 'NET Developer'],
]) {
  test(`${existingRole} and ${role} stay distinct in trackers and batches`, () => withFixture((f) => {
    f.writeTracker('Applied', 'Example Labs', existingRole);
    const selected = writeRun(f, 'technology-candidate', 'Example Labs', role);
    const created = f.create('different-technology', selected);
    assert.equal(created.manifest.duplicateOverride, undefined);
    f.writeTracker('Evaluated');
    assert.equal(f.create('original-technology', writeRun(f, 'technology-original', 'Example Labs', existingRole)).manifest.duplicateOverride, undefined);
  }));
}

for (const [role, equivalent] of [
  ['C++ Developer', 'CPLUSPLUS-DEVELOPER'], ['C# Developer', 'CSHARP Developer'],
  ['F# Developer', 'FSHARP Developer'], ['.NET Developer', 'DOTNET Developer'],
  ['Ｃ＋＋ Developer', 'c++-DEVELOPER'],
]) {
  test(`${role} preserves technology, case, whitespace and dash equivalence`, () => withFixture((f) => {
    const selected = writeRun(f, 'equivalent-candidate', 'Example Labs', role);
    f.writeTracker('Applied', 'Example Labs', `  ${equivalent}  `);
    assert.throws(() => f.create('tracker-equivalent', selected), /tracker row #42/);
    f.writeTracker('Evaluated');
    f.create('technology-existing', writeRun(f, 'equivalent-original', 'Example Labs', equivalent));
    assert.throws(() => f.create('batch-equivalent', selected), /application batch technology-existing/);
  }));
}

for (const corruption of ['manifest-json', 'manifest-hash', 'state-json', 'state-scope']) {
  test(`${corruption} load failures identify the batch, manifest path and recovery options`, () => withFixture((f) => {
    const original = f.create('damaged-batch');
    const path = corruption.startsWith('manifest') ? original.manifestPath : original.statePath;
    if (corruption.endsWith('json')) writeFileSync(path, '{broken json');
    else {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (corruption === 'manifest-hash') value.createdAt = '2025-01-01T00:00:00.000Z';
      else value.manifestScopeHash = 'sha256:' + '0'.repeat(64);
      writeFileSync(path, JSON.stringify(value));
    }
    const damaged = readFileSync(path, 'utf8');
    const selected = corruption.startsWith('manifest')
      ? writeRun(f, 'unrelated-candidate', 'Other Example Labs') : {};
    assert.throws(() => f.create('refused-damaged', selected), (error) => {
      assert.match(error.message, /Cannot check duplicates against application batch damaged-batch/);
      assert.ok(error.message.includes(original.manifestPath));
      assert.match(error.message, /Inspect\/repair or abandon that batch/);
      assert.match(error.message, /--allow-duplicate.*intentionally a duplicate/);
      assert.ok(error.cause instanceof Error);
      assert.ok(error.message.includes(error.cause.message));
      return true;
    });
    assert.equal(existsSync(join(f.root, 'output', 'application-batches', 'refused-damaged')), false);
    assert.equal(readFileSync(path, 'utf8'), damaged);
    const reason = 'Alex Example approved an intentional duplicate while inspecting the damaged fixture.';
    assert.equal(f.create('override-damaged', { ...selected, allowDuplicateReason: reason }).manifest.duplicateOverride.reason, reason);
  }));
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
