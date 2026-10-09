import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertWritableOutput } from '../output-safety.mjs';
import { coverLetterFilename, safeOutputPath } from '../generate-cover-letter.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('output guard allows fresh paths and refuses approved, traversal, and existing targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'roleforge-output-safety-'));
  try {
    const fresh = join(root, 'output', 'new-cv.pdf');
    assert.equal(assertWritableOutput(fresh, { root }), resolve(fresh));

    const approved = join(root, 'output', 'cv-approved', 'nested', 'approved.pdf');
    mkdirSync(dirname(approved), { recursive: true });
    writeFileSync(approved, 'approved sentinel');
    assert.throws(() => assertWritableOutput(approved, { root }), /approved CV directory/i);
    assert.throws(
      () => assertWritableOutput(`${root}/output/draft/../cv-approved/nested/new.pdf`, { root }),
      /approved CV directory/i,
    );

    if (process.platform === 'win32') {
      assert.throws(
        () => assertWritableOutput(join(root, 'OUTPUT', 'CV-APPROVED', 'nested', 'new.pdf'), { root }),
        /approved CV directory/i,
      );
    }

    const existing = join(root, 'output', 'existing.pdf');
    writeFileSync(existing, 'existing sentinel');
    assert.throws(() => assertWritableOutput(existing, { root }), /overwrite existing output.*different name/i);
    assert.equal(readFileSync(existing, 'utf8'), 'existing sentinel');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('output guard follows symlink aliases into the approved directory where supported', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'roleforge-output-symlink-'));
  const approved = join(root, 'output', 'cv-approved');
  const alias = join(root, 'output', 'approved-alias');
  mkdirSync(approved, { recursive: true });
  try {
    try {
      symlinkSync(approved, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if (['EPERM', 'EACCES', 'UNKNOWN', 'ENOTSUP'].includes(err?.code)) {
        t.skip(`directory symlinks unavailable: ${err.code}`);
        return;
      }
      throw err;
    }
    assert.throws(() => assertWritableOutput(join(alias, 'nested', 'new.pdf'), { root }), /approved CV directory/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all CV renderers reject approved and existing outputs without changing sentinels', () => {
  const id = `output-safety-${process.pid}-${Date.now()}`;
  const scratch = mkdtempSync(join(tmpdir(), 'roleforge-renderer-safety-'));
  const outputRoot = join(ROOT, 'output', id);
  const approvedRoot = join(ROOT, 'output', 'cv-approved', id);
  const hadOutput = existsSync(join(ROOT, 'output'));
  const hadApproved = existsSync(join(ROOT, 'output', 'cv-approved'));
  mkdirSync(outputRoot, { recursive: true });
  mkdirSync(approvedRoot, { recursive: true });

  const inputs = {
    html: join(scratch, 'input.html'),
    json: join(scratch, 'input.json'),
    tex: join(scratch, 'input.tex'),
    payload: join(scratch, 'payload.json'),
  };
  writeFileSync(inputs.html, '<!doctype html><html><body>fixture</body></html>');
  writeFileSync(inputs.json, '{}');
  writeFileSync(inputs.tex, 'fixture');
  writeFileSync(inputs.payload, '{}');

  const renderers = [
    {
      name: 'HTML to PDF', script: 'generate-pdf.mjs', args: (path) => [inputs.html, path], extension: '.pdf',
    },
    {
      name: 'CV to LaTeX', script: 'build-cv-latex.mjs', args: (path) => [inputs.json, path], extension: '.tex',
    },
    {
      name: 'LaTeX to PDF', script: 'generate-latex.mjs', args: (path) => [inputs.tex, path], extension: '.pdf',
    },
    {
      name: 'cover letter PDF', script: 'generate-cover-letter.mjs', args: (path) => ['--payload', inputs.payload, '--out', path], extension: '.pdf',
    },
  ];

  try {
    for (const renderer of renderers) {
      const existingPath = join(outputRoot, `existing${renderer.extension}`);
      const approvedPath = join(approvedRoot, `approved${renderer.extension}`);
      writeFileSync(existingPath, `${renderer.name} existing sentinel`);
      writeFileSync(approvedPath, `${renderer.name} approved sentinel`);

      for (const [path, expected] of [
        [existingPath, `${renderer.name} existing sentinel`],
        [approvedPath, `${renderer.name} approved sentinel`],
      ]) {
        const result = spawnSync(process.execPath, [join(ROOT, renderer.script), ...renderer.args(path)], {
          cwd: ROOT,
          encoding: 'utf8',
        });
        assert.notEqual(result.status, 0, `${renderer.name} unexpectedly wrote ${path}: ${result.stdout}\n${result.stderr}`);
        assert.match(`${result.stdout}\n${result.stderr}`, /Refusing to (write|overwrite)/i, renderer.name);
        assert.equal(readFileSync(path, 'utf8'), expected, `${renderer.name} changed sentinel at ${path}`);
      }
    }

    const freshTex = join(outputRoot, 'fresh.tex');
    const build = spawnSync(process.execPath, [join(ROOT, 'build-cv-latex.mjs'), inputs.json, freshTex], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    assert.ok(readFileSync(freshTex, 'utf8').includes('\\begin{document}'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(approvedRoot, { recursive: true, force: true });
    if (!hadApproved) {
      try { rmSync(join(ROOT, 'output', 'cv-approved')); } catch { /* other output may share the directory */ }
    }
    if (!hadOutput) {
      try { rmSync(join(ROOT, 'output')); } catch { /* keep output if another test created files */ }
    }
  }
});

test('cover-letter fallback can include a role title and still protects existing outputs', () => {
  assert.equal(coverLetterFilename('Example Labs', 'Data Engineer'), 'example_labs_data_engineer_cover_letter.pdf');
  assert.equal(coverLetterFilename('Example Labs'), 'example_labs_cover_letter.pdf');

  const id = `cover-output-safety-${process.pid}-${Date.now()}`;
  const path = join(ROOT, 'output', `${id}.pdf`);
  const hadOutput = existsSync(join(ROOT, 'output'));
  mkdirSync(dirname(path), { recursive: true });
  try {
    assert.equal(safeOutputPath(path), resolve(path));
    writeFileSync(path, 'cover sentinel');
    assert.throws(() => safeOutputPath(path), /overwrite existing output/i);
    assert.equal(readFileSync(path, 'utf8'), 'cover sentinel');
  } finally {
    rmSync(path, { force: true });
    if (!hadOutput) {
      try { rmSync(join(ROOT, 'output')); } catch { /* keep output if another test created files */ }
    }
  }
});
