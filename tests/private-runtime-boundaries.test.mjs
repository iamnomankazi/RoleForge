import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function isIgnored(path) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', path], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  assert.ok([0, 1].includes(result.status), result.stderr || `git check-ignore failed for ${path}`);
  return result.status === 0;
}

test('private runtime and user-data paths are ignored by default', () => {
  for (const path of [
    'article-digest.md',
    'local/session.json',
    'data/future-runtime-file.json',
    'data/offers/private-contract.pdf',
    'data/parser-output/company/result.json',
    'interview-prep/sessions/private-session.md',
    'config/cv-facts.json',
    'config/benchmarks.yml',
    'modes/_custom.md',
    'modes/_brief.md',
    'opencode.json',
    'test-results/result.json',
    'playwright-report/index.html',
    '.career-ops-web/history.json',
    '.manifesto-noted',
  ]) {
    assert.equal(isIgnored(path), true, path);
  }
});

test('system placeholders, fixtures, and lockfiles remain trackable', () => {
  for (const path of [
    'data/.gitkeep',
    'data/offers/.gitkeep',
    'data/parser-output/.gitkeep',
    'data/parser-output/nested/.gitkeep',
    'interview-prep/.gitkeep',
    'interview-prep/sessions/.gitkeep',
    'interview-prep/sessions/README.md',
    'examples/dual-track-engineer-instructor/cv.md',
    'test-fixtures/example/cv.md',
    'package-lock.json',
    'web/package-lock.json',
  ]) {
    assert.equal(isIgnored(path), false, path);
  }
});
