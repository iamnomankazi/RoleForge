import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../backup.mjs', import.meta.url));
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const hash = (content) => createHash('sha256').update(content).digest('hex');
const diskPath = (root, path = '') => toNamespacedPath(resolve(root, path));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'roleforge-backup-'));
  t.after(() => rmSync(diskPath(root), { recursive: true, force: true }));
  return root;
}

function write(root, path, content = 'Alex Example fixture') {
  const target = diskPath(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function run(root, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}

function backups(root) {
  return readdirSync(diskPath(root, 'backups')).filter((name) => STAMP.test(name)).sort();
}

function seedOldBackups(root) {
  const names = Array.from({ length: 7 }, (_, i) => `2000-01-0${i + 1}T00-00-00-000Z`);
  for (const name of names) write(root, `backups/${name}/cv.md`, 'old fixture');
  return names;
}

test('copies all selected sources, hashes content, preserves long paths and excludes nested caches', (t) => {
  const root = fixture(t);
  const evidence = `output/application-batches/example-batch/evidence/${'candidate-'.repeat(12)}/${'form-step-'.repeat(10)}/screen résumé.png`;
  assert.ok(resolve(root, evidence).length > 260);
  const expected = new Map([
    ['cv.md', 'Alex Example CV'],
    ['config/profile.yml', 'candidate: Alex Example'],
    ['modes/_profile.md', 'Example profile'],
    ['modes/_custom.md', 'Example rules'],
    ['article-digest.md', 'Example proof points'],
    ['portals.yml', 'companies: []'],
    ['voice-dna.md', 'Example voice'],
    ['writing-samples/sample.md', 'Example writing'],
    ['data/applications.md', 'Example tracker'],
    ['reports/001-example.md', 'Example report'],
    ['interview-prep/sessions/example.md', 'Example interview'],
    ['jds/example.txt', 'Example JD'],
    ['output/cv-approved/Alex Example CV.pdf', Buffer.from([0, 255, 1, 2])],
    ['output/application-answer-bank.md', 'Example answers'],
    ['output/application-batches/example-batch/manifest.json', '{}'],
    ['output/scan-runs/example-run/candidates.json', '[]'],
    [evidence, Buffer.from([3, 2, 1, 0])],
  ]);
  for (const [path, content] of expected) write(root, path, content);
  for (const path of [
    'backups/notes/private.txt', 'data/backups/nested.txt', 'reports/preimages/old.md',
    'output/application-batches/example-batch/preimages/old.json',
    'data/nested/node_modules/package/index.js', 'data/nested/preimages/old.md',
    'output/unrelated-generated.pdf', 'config/system.yml',
  ]) write(root, path);
  mkdirSync(diskPath(root, 'data/empty'), { recursive: true });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Restore manually/);
  const [timestamp] = backups(root);
  const destination = `backups/${timestamp}`;
  const manifest = JSON.parse(readFileSync(diskPath(root, `${destination}/manifest.json`), 'utf8'));
  assert.equal(manifest.complete, true);
  assert.deepEqual(manifest.failures, []);
  assert.equal(new Date(manifest.createdAt).toISOString().replace(/[:.]/g, '-'), timestamp);
  assert.deepEqual(manifest.files.map((file) => file.path).sort(), [...expected.keys()].sort());
  for (const file of manifest.files) {
    const content = Buffer.from(expected.get(file.path));
    assert.deepEqual(readFileSync(diskPath(root, `${destination}/${file.path}`)), content, file.path);
    assert.equal(file.size, content.length, file.path);
    assert.equal(file.sha256, hash(content), file.path);
    assert.deepEqual(readFileSync(diskPath(root, file.path)), content, 'source remains unchanged');
  }
  assert.ok(existsSync(diskPath(root, `${destination}/data/empty`)));
  assert.ok(!existsSync(diskPath(root, `${destination}/reports/preimages`)));
  assert.ok(!existsSync(diskPath(root, `${destination}/data/backups`)));
  assert.ok(!existsSync(diskPath(root, `${destination}/data/nested/node_modules`)));
});

test('retention keeps the newest five timestamp directories and leaves other entries alone', (t) => {
  const root = fixture(t);
  write(root, 'cv.md');
  const old = seedOldBackups(root);
  write(root, 'backups/manual-copy/keep.txt');
  write(root, 'backups/2000-01-08T00-00-00-000Z.incomplete/keep.txt');
  write(root, 'backups/2000-01-09T00-00-00-000Z', 'regular file');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const retained = backups(root).filter((name) => name !== '2000-01-09T00-00-00-000Z');
  assert.equal(retained.length, 5);
  assert.deepEqual(retained.slice(0, 4), old.slice(3));
  for (const name of old.slice(0, 3)) assert.ok(!existsSync(diskPath(root, `backups/${name}`)));
  assert.ok(existsSync(diskPath(root, 'backups/manual-copy/keep.txt')));
  assert.ok(existsSync(diskPath(root, 'backups/2000-01-08T00-00-00-000Z.incomplete/keep.txt')));
  assert.equal(readFileSync(diskPath(root, 'backups/2000-01-09T00-00-00-000Z'), 'utf8'), 'regular file');
});

test('dry-run reports counts and bytes, writes nothing and never prunes existing backups', (t) => {
  const root = fixture(t);
  write(root, 'cv.md', 'Alex Example');
  write(root, 'data/example.bin', Buffer.from([0, 1, 255]));
  write(root, 'data/preimages/skip.md');
  const before = readdirSync(diskPath(root), { recursive: true }).sort();
  const result = run(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Dry run: 2 files, 15 bytes.');
  assert.deepEqual(readdirSync(diskPath(root), { recursive: true }).sort(), before);
  assert.ok(!existsSync(diskPath(root, 'backups')));
  const old = seedOldBackups(root);
  assert.equal(run(root, ['--dry-run']).status, 0);
  assert.deepEqual(backups(root), old);
});

test('help and unknown arguments write nothing; missing sources are skipped', (t) => {
  const root = fixture(t);
  assert.match(run(root, ['--help']).stdout, /Usage: node backup.mjs/);
  assert.deepEqual(readdirSync(root), []);
  for (const args of [['--unknown'], ['--dry-run', '--unknown'], ['--help', '--unknown'], ['cv.md']]) {
    const result = run(root, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown argument/);
    assert.deepEqual(readdirSync(root), []);
  }
  const result = run(root, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 files, 0 bytes/);
  assert.deepEqual(readdirSync(root), []);
});

test('all copy failures are listed, mark the backup incomplete and preserve older backups', (t) => {
  const root = fixture(t);
  write(root, 'cv.md');
  write(root, 'voice-dna.md');
  write(root, 'data/applications.md');
  const old = seedOldBackups(root);
  const program = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const copy = fs.copyFileSync;
    fs.copyFileSync = (source, ...args) => {
      if (source.endsWith('cv.md') || source.endsWith('voice-dna.md')) {
        throw new Error('fixture copy failure');
      }
      return copy(source, ...args);
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(SCRIPT)}];
    await import(pathToFileURL(${JSON.stringify(SCRIPT)}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], { cwd: root, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /2 failures/);
  assert.match(result.stderr, /cv\.md: fixture copy failure/);
  assert.match(result.stderr, /voice-dna\.md: fixture copy failure/);
  assert.deepEqual(backups(root), old);
  const incomplete = readdirSync(diskPath(root, 'backups')).find((name) => name.endsWith('.incomplete'));
  assert.ok(incomplete);
  const manifest = JSON.parse(readFileSync(diskPath(root, `backups/${incomplete}/manifest.json`), 'utf8'));
  assert.equal(manifest.complete, false);
  assert.equal(manifest.failures.length, 2);
  assert.deepEqual(manifest.files.map((file) => file.path), ['data/applications.md']);
});

test('linked sources and backup roots fail without following them; retention skips linked directories', (t) => {
  const root = fixture(t);
  write(root, 'linked-target/profile.yml');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(join(root, 'linked-target'), join(root, 'config'), linkType);
  const sourceResult = run(root, ['--dry-run']);
  assert.equal(sourceResult.status, 1, sourceResult.stderr);
  assert.match(sourceResult.stderr, /config\/profile.yml: Source parent is a symbolic link/);
  assert.ok(!existsSync(diskPath(root, 'backups')));
  rmSync(diskPath(root, 'config'));
  symlinkSync(join(root, 'linked-target'), join(root, 'backups'), linkType);
  const rootResult = run(root);
  assert.equal(rootResult.status, 1, rootResult.stderr);
  assert.match(rootResult.stderr, /backups\/ must be a regular directory/);
  assert.deepEqual(readdirSync(diskPath(root, 'linked-target')), ['profile.yml']);
  rmSync(diskPath(root, 'backups'));
  seedOldBackups(root);
  symlinkSync(join(root, 'linked-target'), join(root, 'backups', '1999-01-01T00-00-00-000Z'), linkType);
  const retentionResult = run(root);
  assert.equal(retentionResult.status, 0, retentionResult.stderr);
  assert.ok(existsSync(diskPath(root, 'backups/1999-01-01T00-00-00-000Z/profile.yml')));
});
