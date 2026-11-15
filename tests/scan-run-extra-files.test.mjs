import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCandidatesTsv,
  buildImmutableScanRun,
  buildReviewCsv,
  buildReviewMarkdown,
  writeImmutableScanRun,
} from '../scan-candidate-contract.mjs';

const inputs = [{ name: 'fixture.json', rows: [{
  company: 'Example Oy', title: 'Synthetic Engineer', url: 'https://careers.example.test/jobs/one',
}] }];
const createdAt = '2026-11-15T10:00:00.000Z';

test('writeImmutableScanRun retains standard artifact bytes without extraFiles', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-run-extra-files-'));
  try {
    const built = buildImmutableScanRun({ root, runId: 'standard-bytes', inputs, createdAt });
    const written = writeImmutableScanRun({ root, runId: 'standard-bytes', inputs, createdAt });
    const expected = {
      'candidates.json': `${JSON.stringify(built.candidates, null, 2)}\n`,
      'candidates.tsv': buildCandidatesTsv(built.candidates),
      'review.csv': buildReviewCsv(built.candidates),
      'review.md': buildReviewMarkdown(built.candidates, built.manifest),
      'manifest.json': `${JSON.stringify(built.manifest, null, 2)}\n`,
    };
    for (const [name, content] of Object.entries(expected)) {
      assert.equal(readFileSync(join(written.runDir, name), 'utf8'), content);
    }
    assert.deepEqual(readdirSync(written.runDir).sort(), Object.keys(expected).sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid extra file names fail before staging is created', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-run-extra-invalid-'));
  try {
    for (const name of ['../bad.json', 'Bad.json', 'candidates.json', 'review.md', 'manifest.json', 'not-json.txt']) {
      assert.throws(() => writeImmutableScanRun({
        root, runId: `invalid-${name.replace(/[^a-z0-9]/gi, '-')}`, inputs, createdAt,
        extraFiles: { [name]: '{}' },
      }), /Invalid extra scan run filename/);
    }
    const outputRoot = join(root, 'output', 'scan-runs');
    assert.equal(existsSync(outputRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extra file write failure removes staging and does not publish a run', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-run-extra-failure-'));
  try {
    const extraFiles = new Proxy({ 'enrichment.json': '{}' }, {
      get(target, property, receiver) {
        if (property === 'enrichment.json') throw new Error('injected extra file write failure');
        return Reflect.get(target, property, receiver);
      },
    });
    assert.throws(() => writeImmutableScanRun({
      root, runId: 'extra-failure', inputs, createdAt, extraFiles,
    }), /injected extra file write failure/);
    const outputRoot = join(root, 'output', 'scan-runs');
    assert.equal(existsSync(join(outputRoot, 'extra-failure')), false);
    assert.deepEqual(readdirSync(outputRoot), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
