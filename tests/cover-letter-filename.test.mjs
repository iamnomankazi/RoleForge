import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  coverLetterFilename,
  safeOutputPath,
} from '../generate-cover-letter.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('default cover-letter filename is a lowercase filesystem-safe company slug', () => {
  assert.equal(coverLetterFilename('Tesla'), 'tesla_cover_letter.pdf');
  assert.equal(coverLetterFilename('ACME & Sons Oy'), 'acme_sons_oy_cover_letter.pdf');
  assert.equal(coverLetterFilename('  Déjà Vu GmbH  '), 'deja_vu_gmbh_cover_letter.pdf');
});

test('cover-letter output accepts underscores but rejects URL-encoded spaces and escapes', () => {
  const valid = join(ROOT, 'output', 'tesla_cover_letter.pdf');
  assert.equal(safeOutputPath(valid), resolve(valid));
  assert.throws(
    () => safeOutputPath(join(ROOT, 'output', 'tesla%20cover_letter.pdf')),
    /must not contain %20/i,
  );
  assert.throws(
    () => safeOutputPath(join(ROOT, 'outside', 'tesla_cover_letter.pdf')),
    /stay inside output/i,
  );
});
