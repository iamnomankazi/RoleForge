import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalJson,
  createArtifactRecord,
  sha256Canonical,
  validateArtifactRecord,
} from '../application-integrity.mjs';

function withRoot(callback) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-integrity-'));
  mkdirSync(join(root, 'output'), { recursive: true });
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('canonical scope hashes do not depend on object key insertion order', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(sha256Canonical({ b: 2, a: 1 }), sha256Canonical({ a: 1, b: 2 }));
});

test('artifact binding records exact readable filename, real path, and SHA-256', () => withRoot((root) => {
  const path = join(root, 'output', 'Alex Example Backend CV.pdf');
  writeFileSync(path, 'phase-two-cv');
  const record = createArtifactRecord({ root, artifactType: 'cv', filePath: path, sourceCvVariant: 'backend' });
  assert.equal(record.intendedFilename, 'Alex Example Backend CV.pdf');
  assert.match(record.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(record.sourceCvVariant, 'backend');
  assert.equal(validateArtifactRecord(record, { root, expectedType: 'cv' }), record);
}));

test('Phase 4 validates exact cover-text and combined-document artifact records', () => withRoot((root) => {
  const textPath = join(root, 'output', 'Acme Role Cover Letter.txt');
  const combinedPath = join(root, 'output', 'Acme Role Application Document.pdf');
  writeFileSync(textPath, 'complete grounded letter');
  writeFileSync(combinedPath, 'combined fixture');
  const textRecord = createArtifactRecord({ root, artifactType: 'cover_letter_text', filePath: textPath });
  const combinedRecord = createArtifactRecord({
    root, artifactType: 'combined_document', filePath: combinedPath,
    sourceArtifacts: [
      { artifactType: 'cv', sha256: `sha256:${'1'.repeat(64)}`, size: 1 },
      { artifactType: 'cover_letter', sha256: `sha256:${'2'.repeat(64)}`, size: 1 },
    ],
  });
  assert.equal(validateArtifactRecord(textRecord, { root, expectedType: 'cover_letter_text' }), textRecord);
  assert.equal(validateArtifactRecord(combinedRecord, { root, expectedType: 'combined_document' }), combinedRecord);
}));

test('lowercase underscore artifact filenames remain hash-bound and valid', () => withRoot((root) => {
  const path = join(root, 'output', 'tesla_cover_letter.pdf');
  writeFileSync(path, 'grounded cover letter');
  const record = createArtifactRecord({ root, artifactType: 'cover_letter', filePath: path });
  assert.equal(record.intendedFilename, 'tesla_cover_letter.pdf');
  assert.equal(validateArtifactRecord(record, { root, expectedType: 'cover_letter' }), record);
}));

test('missing, traversal, and URL-encoded artifact paths are rejected', () => withRoot((root) => {
  assert.throws(
    () => createArtifactRecord({ root, artifactType: 'cv', filePath: 'output/Missing CV.pdf' }),
    /missing/,
  );
  const outside = join(root, 'Secret CV.pdf');
  writeFileSync(outside, 'secret');
  assert.throws(
    () => createArtifactRecord({ root, artifactType: 'cv', filePath: '../Secret CV.pdf' }),
    /approved output directory/,
  );
  const encoded = join(root, 'output', 'Backend%20CV.pdf');
  writeFileSync(encoded, 'cv');
  assert.throws(
    () => createArtifactRecord({ root, artifactType: 'cv', filePath: encoded }),
    /Unsafe artifact path|never underscores or %20/,
  );
}));

test('artifact hash changes and deletions fail validation', () => withRoot((root) => {
  const path = join(root, 'output', 'Backend CV.pdf');
  writeFileSync(path, 'original');
  const record = createArtifactRecord({ root, artifactType: 'cv', filePath: path });
  writeFileSync(path, 'replacement');
  assert.throws(() => validateArtifactRecord(record, { root, expectedType: 'cv' }), /hash or size mismatch/);
  rmSync(path);
  assert.throws(() => validateArtifactRecord(record, { root, expectedType: 'cv' }), /missing/);
}));

test('symlink or junction escape outside output is rejected', () => withRoot((root) => {
  const outside = mkdtempSync(join(tmpdir(), 'career-ops-outside-'));
  try {
    const outsideFile = join(outside, 'Outside CV.pdf');
    writeFileSync(outsideFile, 'outside');
    const link = join(root, 'output', 'Escaped Documents');
    symlinkSync(outside, link, 'junction');
    assert.throws(
      () => createArtifactRecord({ root, artifactType: 'cv', filePath: join(link, 'Outside CV.pdf') }),
      /symlink escapes|outside the approved output directory/,
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));
