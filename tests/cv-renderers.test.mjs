import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDraftManifest } from '../cv-claims.mjs';
import { structuredCvSegments } from '../build-cv-latex.mjs';
import { claimRenderOptions, enforceRenderedCvClaims, extractDocumentSegments } from '../validate-cv-claims.mjs';

const ROOT = resolve('.');
const CV = '# Projects\n## Alpha\n- Built API services for 30 users.\n\n# Skills\n- JavaScript, Node.js\n';
const TEMPLATE = resolve('templates/cv-template.tex');

async function fixture(run) {
  await mkdir(resolve('output'), { recursive: true });
  const root = await mkdtemp(resolve('output', 'claim-renderers-'));
  try {
    const cvPath = join(root, 'cv.md');
    const anchors = join(root, 'anchors.json');
    await writeFile(cvPath, CV);
    await writeFile(anchors, JSON.stringify(createDraftManifest(CV)));
    return await run({ root, cvPath, anchors });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function cli(script, args) {
  return spawnSync(process.execPath, [resolve(script), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
}

test('all CV CLI entry points reject unsupported rendered facts and a missing manifest before output', async () => {
  await fixture(async ({ root, cvPath, anchors }) => {
    const html = join(root, 'input.html');
    const json = join(root, 'input.json');
    const tex = join(root, 'input.tex');
    await writeFile(html, '<html><body><p>TypeScript</p><p>Next.js</p></body></html>');
    await writeFile(json, JSON.stringify({ skills: ['TypeScript', 'Next.js'] }));
    const template = (await readFile(TEMPLATE, 'utf8')).replace(/\{\{[A-Z_]+\}\}/g, '');
    await writeFile(tex, template.replace('\\section{Technical Skills}', '\\section{Technical Skills}\nTypeScript\\\\ Next.js'));
    for (const manifest of [join(root, 'missing.json'), anchors]) {
      for (const [script, input, extension, flags] of [
        ['generate-pdf.mjs', html, 'pdf', []],
        ['build-cv-latex.mjs', json, 'tex', []],
        ['generate-latex.mjs', tex, 'pdf', []],
      ]) {
        const output = join(root, `${script}-${manifest === anchors ? 'unsupported' : 'missing'}.${extension}`);
        const result = cli(script, [input, output, ...flags, '--cv-source', cvPath, '--anchors', manifest]);
        assert.notEqual(result.status, 0, `${script}: ${result.stdout}\n${result.stderr}`);
        assert.match(`${result.stdout}\n${result.stderr}`, manifest === anchors ? /unsupported_technology/ : /manifest_load_failed/);
        assert.equal(existsSync(output), false, script);
        assert.equal(existsSync(`${output}.claims.json`), false, script);
      }
    }
  });
});

test('structured CV validation checks rendered fields, permits supported skill lists and writes metadata', async () => {
  await fixture(async ({ root, cvPath, anchors }) => {
    const payload = { projects: [{ name: 'Alpha', bullets: ['Built API services for 30 users.'] }],
      skills: [{ category: 'Languages', items: ['JavaScript', 'Node.js'] }], ignored: 'TypeScript 900 users' };
    assert.deepEqual(structuredCvSegments(payload), ['Alpha', 'Built API services for 30 users.', 'JavaScript', 'Node.js']);
    assert.ok(structuredCvSegments({ skills: [{ category: 'I authored TypeScript.', items: 'JavaScript' }] }).includes('I authored TypeScript.'));
    const input = join(root, 'payload.json');
    const output = join(root, 'supported.tex');
    await writeFile(input, JSON.stringify(payload));
    const result = cli('build-cv-latex.mjs', [input, output, '--cv-source', cvPath, '--anchors', anchors]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const metadata = JSON.parse(result.stdout).claimValidation;
    assert.equal(metadata.status, 'pass');
    assert.equal(metadata.checked, 4);
    const generated = await readFile(output, 'utf8');
    assert.match(generated, /RoleForge claim validation:.*"status":"pass"/);
    const segments = extractDocumentSegments(generated, output);
    const checked = await enforceRenderedCvClaims(segments, { cvPath, anchorsPath: anchors });
    assert.equal(checked.status, 'pass', JSON.stringify(segments));
  });
});

test('explicit unverified flag prints a warning and persists bypass metadata with the actual output', async () => {
  await fixture(async ({ root }) => {
    const input = join(root, 'payload.json');
    const output = join(root, 'unverified.tex');
    await writeFile(input, JSON.stringify({ skills: ['TypeScript', 'Next.js'] }));
    const result = cli('build-cv-latex.mjs', ['--allow-unverified-claims', input, output]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /WARNING.*UNVERIFIED CLAIMS/);
    const metadata = JSON.parse(result.stdout).claimValidation;
    assert.equal(metadata.status, 'unverified');
    assert.equal(metadata.allowUnverifiedClaims, true);
    assert.match(await readFile(output, 'utf8'), /RoleForge claim validation:.*"allowUnverifiedClaims":true/);
  });
});

test('PDF CLI defaults to CV for HTML without template classes and parses explicit document types', async () => {
  await fixture(async ({ root, cvPath }) => {
    const input = join(root, 'input.html');
    const output = join(root, 'automatic.pdf');
    await writeFile(input, '<html><body><p>TypeScript</p></body></html>');
    const result = cli('generate-pdf.mjs', [input, output, '--cv-source', cvPath, '--anchors', join(root, 'missing.json')]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /manifest_load_failed/);
    assert.equal(existsSync(output), false);
    // Existing cover-letter artifact tests exercise the unchanged library renderer.
    // Generic CLI HTML gets to normal format checking without requiring claim files.
    await writeFile(input, '<html><body><p>Ordinary report</p></body></html>');
    const generic = cli('generate-pdf.mjs', [input, output, '--document-type', 'report', '--format=invalid']);
    assert.match(generic.stderr, /Invalid format/);
    assert.doesNotMatch(generic.stderr, /claim validation/);
  });
});

test('non-CV CLI documents require explicit valid classification', () => {
  assert.equal(claimRenderOptions([]).options.documentType, 'cv');
  for (const type of ['cover', 'report', 'other']) {
    assert.equal(claimRenderOptions(['--document-type', type]).options.documentType, type);
  }
  assert.throws(() => claimRenderOptions(['--document-type']), /requires cover/);
  assert.throws(() => claimRenderOptions(['--document-type', 'guessed-cv']), /requires cover/);
});

test('unknown skills categories and TeX sections are validated without factual keyword exemptions', async () => {
  await fixture(async ({ cvPath, anchors }) => {
    for (const label of ['Expert in pandas', 'Unlisted expertise']) {
      const structured = structuredCvSegments({ skills: [{ category: label, items: ['JavaScript'] }] });
      assert.ok(structured.includes(label));
      await assert.rejects(enforceRenderedCvClaims(structured, { cvPath, anchorsPath: anchors }), /validation failed/);
      for (const [source, path] of [[`<h2>${label}</h2><p>JavaScript</p>`, 'cv.html'],
        [`\\begin{document}\\section{${label}}JavaScript\\end{document}`, 'cv.tex']]) {
        const extracted = extractDocumentSegments(source, path);
        assert.ok(extracted.includes(label));
        await assert.rejects(enforceRenderedCvClaims(extracted, { cvPath, anchorsPath: anchors }), /validation failed/);
      }
    }
  });
});

test('changed and added TeX definitions fail compilation and check-document before output', async () => {
  await fixture(async ({ root, cvPath, anchors }) => {
    const cv = '# Skills\n- Python\n';
    await writeFile(cvPath, cv);
    await writeFile(anchors, JSON.stringify(createDraftManifest(cv)));
    const template = (await readFile(TEMPLATE, 'utf8')).replace(/\{\{[A-Z_]+\}\}/g, '')
      .replace('\\section{Technical Skills}', '\\section{Technical Skills}\n\\resumeItem{Python}');
    const sources = [
      template.replace('{#1 \\vspace{-3pt}}', '{I authored TypeScript. #1 \\vspace{-3pt}}'),
      template.replace('\\begin{document}', '\\def\\resumeItem#1{I authored TypeScript. #1}\n\\begin{document}'),
      template.replace('\\begin{document}', '\\renewcommand{\\resumeItem}[1]{I authored TypeScript. #1}\n\\begin{document}'),
      template.replace('\\begin{document}', '\\newcommand{\\extra}{I authored TypeScript.}\n\\begin{document}'),
    ];
    for (const [index, source] of sources.entries()) {
      const input = join(root, `macro-${index}.tex`);
      const output = join(root, `macro-${index}.pdf`);
      await writeFile(input, source);
      assert.throws(() => extractDocumentSegments(source, input), /untrusted_macro_definition/);
      for (const [script, args] of [['generate-latex.mjs', [input, output, '--cv-source', cvPath]],
        ['validate-cv-claims.mjs', ['--check-document', input, '--cv', cvPath, '--strict']]]) {
        const result = cli(script, [...args, '--anchors', anchors]);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout + result.stderr, /untrusted_macro_definition/);
        assert.equal(existsSync(output), false);
      }
    }
    const bypass = cli('validate-cv-claims.mjs', ['--check-document', join(root, 'macro-0.tex'), '--cv', cvPath, '--allow-unverified-claims']);
    assert.equal(bypass.status, 0);
    assert.equal(JSON.parse(bypass.stdout).status, 'unverified');
  });
});
