import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDraftManifest } from '../cv-claims.mjs';
import { structuredCvSegments } from '../build-cv-latex.mjs';
import { enforceRenderedCvClaims, extractDocumentSegments } from '../validate-cv-claims.mjs';

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
        ['generate-pdf.mjs', html, 'pdf', ['--cv']],
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

test('PDF CLI enforces template CVs automatically but leaves generic reports and cover letters unaffected', async () => {
  await fixture(async ({ root, cvPath }) => {
    const input = join(root, 'input.html');
    const output = join(root, 'automatic.pdf');
    await writeFile(input, '<html><body><div class="summary-text">TypeScript</div></body></html>');
    const result = cli('generate-pdf.mjs', [input, output, '--cv-source', cvPath, '--anchors', join(root, 'missing.json')]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /manifest_load_failed/);
    assert.equal(existsSync(output), false);
    // Existing cover-letter artifact tests exercise the unchanged library renderer.
    // Generic CLI HTML gets to normal format checking without requiring claim files.
    await writeFile(input, '<html><body><p>Ordinary report</p></body></html>');
    const generic = cli('generate-pdf.mjs', [input, output, '--format=invalid']);
    assert.match(generic.stderr, /Invalid format/);
    assert.doesNotMatch(generic.stderr, /claim validation/);
  });
});
