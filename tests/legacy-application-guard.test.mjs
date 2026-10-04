import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const DISABLED = [
  'prepare-application.mjs',
  'scripts/open-apply-batch.mjs',
  'scripts/mark-applied.mjs',
  'output/build-high-volume-workflow.mjs',
  'output/high-volume-fast-scan.mjs',
  'output/extract-queue-jds.mjs',
  'output/fill-fast-batch-15.mjs',
  'output/fill-ashby-apply-now.mjs',
  'output/fill-glassdoor-personio-batch.mjs',
  'output/fill-reply-batch.mjs',
  'output/fill-zalando-application.mjs',
  'output/fill-verti-application.mjs',
  'output/fill-n26-application.mjs',
  'output/fill-n8n-application.mjs',
  'output/fill-heidi-current.mjs',
  'output/fill-heidi-apply-now.mjs',
  'output/fill-heidi-embedded-form.mjs',
  'output/fill-isar-once.cjs',
  'output/prepare-ashby-apply-now.mjs',
  'output/prepare-glassdoor-personio-batch.mjs',
  'output/prepare-reply-batch.mjs',
  'output/generate-application-packet.mjs',
  'output/application-prep/build-two-job-packages.mjs',
  'tmp/playwright/fill-discovery-applications.mjs',
];

test('every audited unsafe legacy application entrypoint is fail-closed at startup', () => {
  for (const relative of DISABLED) {
    const absolute = resolve(ROOT, relative);
    if (!existsSync(absolute)) continue;
    const source = readFileSync(absolute, 'utf8').slice(0, 700);
    assert.match(source, /Legacy application entrypoint disabled|disableLegacyApplicationEntrypoint/, relative);
  }
});

test('every legacy entrypoint fails with a migration message before application work', () => {
  for (const relative of DISABLED) {
    const absolute = resolve(ROOT, relative);
    if (!existsSync(absolute)) continue;
    const result = spawnSync(process.execPath, [absolute], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(result.status, 0, relative);
    assert.match(result.stdout + result.stderr, /Legacy application entrypoint disabled/);
    assert.match(result.stdout + result.stderr, /application-batches\/<batch-id>\/manifest\.json and an exact candidate ID/);
  }
});

test('package commands expose only batch-scoped application authority', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['or:apply'], undefined);
  assert.match(pkg.scripts['or:apply-draft'], /apply-draft/);
  assert.equal(pkg.scripts['prepare:application'], undefined);
  assert.match(pkg.scripts['application:execute'], /application-browser-executor/);
  assert.match(pkg.scripts['application:shared-browser'], /application-shared-browser/);
  assert.match(pkg.scripts['application:import-legacy'], /legacy-queue-importer/);
  assert.match(pkg.scripts['application:submission'], /application-submission/);
  assert.equal(pkg.scripts['application:state'], undefined);
  const runner = readFileSync(resolve(ROOT, 'openrouter-runner.mjs'), 'utf8');
  assert.doesNotMatch(runner, /case ['"]apply['"]:/);
  assert.match(runner, /case ['"]apply-draft['"]:/);
});

test('active application authority has no global queue or hard-coded target fallback', () => {
  for (const relative of [
    'application-batch.mjs', 'application-browser-executor.mjs', 'application-shared-browser.mjs', 'application-submission.mjs',
    'application-documents.mjs', 'application-form-core.mjs',
  ]) {
    const source = readFileSync(resolve(ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /output[\\/]apply-queue\.csv|first\s+\d+|active\s+tab/i, relative);
  }
  const importer = readFileSync(resolve(ROOT, 'legacy-queue-importer.mjs'), 'utf8');
  assert.doesNotMatch(importer, /queueFile\s*=\s*['"].*apply-queue|--rank/i);
  const queueBuilderPath = resolve(ROOT, 'output/build-current-apply-queue.mjs');
  if (existsSync(queueBuilderPath)) {
    const queueBuilder = readFileSync(queueBuilderPath, 'utf8');
    assert.match(queueBuilder, /Derived Review Queue.*Non-authoritative/);
  }
});

test('static guard catches new risky executables under legacy application directories', () => {
  const allow = new Set(['output/build-current-apply-queue.mjs', 'output/extract-one-workday.mjs']);
  const walk = (relative) => {
    const absolute = resolve(ROOT, relative);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
      const child = `${relative}/${entry.name}`;
      return entry.isDirectory() ? walk(child) : [child];
    });
  };
  const candidates = ['scripts', 'output', 'tmp/playwright'].flatMap(walk)
    .filter((relative) => /\.(?:mjs|cjs|js)$/.test(relative));
  for (const relative of candidates) {
    const source = readFileSync(resolve(ROOT, relative), 'utf8');
    if (!/apply-queue\.csv|chromium\.launch|page\.goto/.test(source) || allow.has(relative)) continue;
    assert.match(source.slice(0, 700), /Legacy application entrypoint disabled|disableLegacyApplicationEntrypoint/, relative);
  }
});

test('standard scanner uses the shared immutable candidate contract in Phase 4', () => {
  const scan = readFileSync(resolve(ROOT, 'scan.mjs'), 'utf8');
  assert.match(scan, /candidate-identity\.mjs/);
  assert.match(scan, /scan-candidate-contract\.mjs/);
  assert.match(scan, /persistStandardScanRun/);
  assert.match(scan, /Immutable authority is committed first/);
});

test('canonical browser authority is exact-ID only and generic progress attestation is unavailable', () => {
  const executor = readFileSync(resolve(ROOT, 'application-browser-executor.mjs'), 'utf8');
  const batch = readFileSync(resolve(ROOT, 'application-batch.mjs'), 'utf8');
  assert.doesNotMatch(executor, /--candidate-url/);
  assert.match(executor, /Explicit exact --candidate-id/);
  assert.match(batch, /may only be recorded by the locked canonical browser executor/);
  assert.doesNotMatch(batch, /command === 'transition'/);
});

test('final submission APIs are only guarded and never invoked by preparation code', () => {
  const executor = readFileSync(resolve(ROOT, 'application-browser-executor.mjs'), 'utf8');
  const coordinator = readFileSync(resolve(ROOT, 'application-shared-browser.mjs'), 'utf8');
  const form = readFileSync(resolve(ROOT, 'application-form-core.mjs'), 'utf8');
  assert.doesNotMatch(executor, /\.submit\(|requestSubmit\(|getByRole\(['"]button['"].*submit/i);
  assert.doesNotMatch(coordinator, /\.submit\(|requestSubmit\(|getByRole\(['"]button['"].*submit/i);
  assert.match(form, /blocked a final form submission attempt/);
  assert.match(form, /finalAction.*activated/s);
});

test('all localized apply modes carry the same batch authority marker', () => {
  const modes = [
    'modes/apply.md', 'modes/ar/takdeem.md', 'modes/da/apply.md', 'modes/de/bewerben.md',
    'modes/es/aplicar.md', 'modes/fr/postuler.md', 'modes/hi/aavedan.md', 'modes/id/melamar.md',
    'modes/it/candidarsi.md', 'modes/ja/oubo.md', 'modes/ko/jiwon.md', 'modes/pl/aplikuj.md',
    'modes/pt/aplicar.md', 'modes/ru/apply.md', 'modes/tr/basvuru.md', 'modes/ua/apply.md',
    'modes/zh/apply.md',
  ];
  for (const relative of modes) {
    const source = readFileSync(resolve(ROOT, relative), 'utf8');
    assert.match(source, /APPLICATION_BATCH_AUTHORITY_V1/, relative);
    assert.doesNotMatch(source, /`node set-status\.mjs <report#> Applied`/, relative);
  }
});
