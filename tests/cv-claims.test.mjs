import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildValidationReport,
  createDraftManifest,
  parseCvClaims,
  sha256,
  textHash,
  validateClaims,
} from '../cv-claims.mjs';

const CLI = resolve('validate-cv-claims.mjs');
const BASE_CV = `# Experience
## Engineer at Synthetic Labs 2022-2023
- Built API services in JavaScript for 30 users.

# Skills
- JavaScript, PostgreSQL

# Projects
## Sample Project
- Processed 500 rows.

# Education
- BSc Computer Science, Example University, 2019-2022

# Languages
- English — fluent
`;

function anchoredManifest(cv = BASE_CV) {
  const manifest = createDraftManifest(cv);
  for (const entry of manifest.claims) entry.state = 'asserted';
  return manifest;
}

function findClaim(manifest, type, textIncludes) {
  return manifest.claims.find((entry) => entry.type === type && entry.text.toLowerCase().includes(textIncludes.toLowerCase()));
}

async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'cv-claims-'));
  try { return await fn(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('parses typed claims with content-stable IDs and canonical text hashes', () => {
  const claims = parseCvClaims(BASE_CV);
  assert.ok(claims.some((claim) => claim.type === 'role' && claim.text === 'Engineer'));
  assert.ok(claims.some((claim) => claim.type === 'employer' && claim.text === 'Synthetic Labs'));
  assert.ok(claims.some((claim) => claim.type === 'dates' && claim.text === '2022-2023'));
  assert.ok(claims.some((claim) => claim.type === 'technology' && claim.text === 'javascript'));
  assert.ok(claims.some((claim) => claim.type === 'metric' && claim.text === '30 users'));
  assert.ok(claims.some((claim) => claim.type === 'project' && claim.text === 'Sample Project'));
  assert.ok(claims.some((claim) => claim.type === 'education'));
  assert.ok(claims.some((claim) => claim.type === 'language'));
  assert.equal(claims.every((claim) => claim.textHash === textHash(claim.text)), true);
});

test('exact CV evidence passes and moved lines preserve anchors by content hash', async () => {
  const manifest = anchoredManifest();
  const result = validateClaims({
    claims: [{ id: 'letter-1', text: 'Built API services in JavaScript for 30 users.' }],
    manifest, cv: BASE_CV,
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].status, 'pass');
  assert.ok(result.results[0].anchorIds.length > 0);

  const moved = `\n\n${BASE_CV}`;
  const report = await buildValidationReport({ cvText: moved, manifest });
  assert.equal(report.status, 'pass');
  assert.equal(report.counts.asserted, manifest.claims.length);
  assert.equal(report.delta.unchanged.length, manifest.claims.length);
  assert.equal(report.delta.added.length, 0);
});

test('changed metric and date become stale/new and appear in the CV delta', async () => {
  const manifest = anchoredManifest();
  const changed = BASE_CV.replace('2022-2023', '2022-2024').replace('30 users', '40 users');
  const report = await buildValidationReport({ cvText: changed, manifest });
  assert.equal(report.status, 'review_required');
  assert.ok(report.counts.stale >= 2);
  assert.ok(report.counts.unanchored >= 2);
  assert.ok(report.delta.changed.length >= 2);
  assert.ok(report.delta.removed.length >= 2);
  assert.ok(report.delta.added.length >= 2);
});

test('approximate metrics do not authorize a precise number', () => {
  const approximateCv = BASE_CV.replace('30 users', 'about 30 users');
  const manifest = anchoredManifest(approximateCv);
  const result = validateClaims({
    claims: [{ id: 'precision', text: 'Built API services in JavaScript for 30 users.' }],
    manifest, cv: approximateCv,
  });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reasonCode, 'unsupported_metric');
});

test('currency markers are part of exact metric support', () => {
  const budgetCv = BASE_CV.replace('30 users', 'EUR 30 users');
  const manifest = anchoredManifest(budgetCv);
  const result = validateClaims({
    claims: [{ id: 'currency', text: 'Built API services in JavaScript for 30 users.' }],
    manifest, cv: budgetCv,
  });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reasonCode, 'unsupported_metric');
});

test('missing evidence source marks a supported claim stale', async () => {
  await withTemp(async (root) => {
    const manifest = anchoredManifest();
    const entry = findClaim(manifest, 'role', 'Built API');
    entry.state = 'supported';
    entry.evidence = [{ path: 'article-digest.md', locator: 'lines:1', sourceHash: sha256('Built API services in JavaScript for 30 users.'), relation: 'independent' }];
    const report = await buildValidationReport({ cvText: BASE_CV, manifest, root });
    assert.equal(report.claims.find((claim) => claim.id === entry.id).state, 'stale');
    assert.ok(report.claims.find((claim) => claim.id === entry.id).issues.includes('evidence_source_missing'));
  });
});

test('CV line evidence resolves against the supplied CV and rebinds unchanged text after moves', async () => {
  await withTemp(async (root) => {
    const manifest = anchoredManifest();
    const entry = findClaim(manifest, 'role', 'Built API');
    entry.evidence = [{ path: 'cv.md', locator: `lines:${entry.cv.startLine}`, sourceHash: sha256(BASE_CV), relation: 'derivative' }];
    const exact = await buildValidationReport({ cvText: BASE_CV, manifest, root });
    assert.equal(exact.claims.find((claim) => claim.id === entry.id).state, 'asserted');
    const movedCv = `\n\n${BASE_CV}`;
    const moved = await buildValidationReport({ cvText: movedCv, manifest, root });
    assert.equal(moved.claims.find((claim) => claim.id === entry.id).state, 'asserted');
  });
});

test('a derivative profile echo cannot be counted as independent corroboration', async () => {
  await withTemp(async (root) => {
    const profilePath = join(root, 'config');
    await mkdir(profilePath, { recursive: true });
    const profileText = `candidate:\n  summary: Built API services in JavaScript for 30 users.\n`;
    await writeFile(join(profilePath, 'profile.yml'), profileText);
    const manifest = anchoredManifest();
    const entry = findClaim(manifest, 'role', 'Built API');
    entry.state = 'supported';
    entry.evidence = [{ path: 'config/profile.yml', locator: 'candidate.summary', sourceHash: sha256(profileText), relation: 'independent' }];
    const report = await buildValidationReport({ cvText: BASE_CV, manifest, root });
    const output = report.claims.find((claim) => claim.id === entry.id);
    assert.equal(output.state, 'needs_review');
    assert.ok(!report.counts.supported);
    assert.equal(validateClaims({ claims: [{ id: 'echo', text: 'Built API services in JavaScript for 30 users.' }], manifest, cv: BASE_CV }).ok, false);
  });
});

test('PDF-only historical facts remain needs_review and do not authorize new text', async () => {
  const manifest = anchoredManifest();
  const oldClaim = parseCvClaims('# Projects\n## Archive Product\n')[0];
  manifest.claims.push({
    id: oldClaim.id, type: oldClaim.type, text: oldClaim.text, textHash: oldClaim.textHash,
    cv: oldClaim.cv, state: 'needs_review',
    evidence: [{ path: 'output/cv-approved/archive.pdf', locator: 'page:1', sourceHash: sha256('pdf bytes'), relation: 'historical' }],
  });
  const report = await buildValidationReport({ cvText: BASE_CV, manifest });
  assert.equal(report.claims.find((claim) => claim.id === oldClaim.id).state, 'needs_review');
  const output = validateClaims({ claims: [{ id: 'new', text: 'Archive Product' }], manifest, cv: BASE_CV });
  assert.equal(output.ok, false);
});

test('style-only sources are rejected as factual evidence', async () => {
  await withTemp(async (root) => {
    await writeFile(join(root, 'voice-dna.md'), 'Synthetic style note.');
    const manifest = anchoredManifest();
    const entry = findClaim(manifest, 'role', 'Built API');
    entry.evidence = [{ path: 'voice-dna.md', locator: 'lines:1', sourceHash: sha256('Synthetic style note.'), relation: 'independent' }];
    const report = await buildValidationReport({ cvText: BASE_CV, manifest, root });
    const result = report.claims.find((claim) => claim.id === entry.id);
    assert.equal(result.state, 'needs_review');
    assert.ok(result.issues.includes('style_source_forbidden'));
  });
});

test('new claims are unanchored and reported as additions', async () => {
  const manifest = anchoredManifest();
  const newerCv = `${BASE_CV}\n# Projects\n## Fresh Sample\n- Added GraphQL support.\n`;
  const report = await buildValidationReport({ cvText: newerCv, manifest });
  assert.ok(report.delta.added.length > 0);
  assert.ok(report.counts.unanchored > 0);
  assert.equal(report.delta.changed.length, 0);
});

test('validateClaims rejects added metrics, TypeScript inferred from JavaScript, and unknown employers', () => {
  const manifest = anchoredManifest();
  const cases = [
    ['metric', 'Built API services in JavaScript for 40 users.', 'unsupported_metric'],
    ['typescript', 'Built API services in TypeScript for 30 users.', 'unsupported_technology'],
    ['employer', 'Joined Unknown Corporation in 2022.', 'unknown_named_entity'],
  ];
  for (const [id, text, reasonCode] of cases) {
    const result = validateClaims({ claims: [{ id, text }], manifest, cv: BASE_CV });
    assert.equal(result.ok, false, id);
    assert.equal(result.results[0].reasonCode, reasonCode, id);
  }
});

test('validateClaims fails closed for empty and sparse claim inputs', () => {
  const manifest = anchoredManifest();
  assert.equal(validateClaims({ claims: [], manifest, cv: BASE_CV }).ok, false);
  const sparse = Array(1);
  const result = validateClaims({ claims: sparse, manifest, cv: BASE_CV });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reasonCode, 'claim_missing');
});

test('init writes a hash-qualified draft and refuses to overwrite it', async () => {
  await withTemp(async (root) => {
    const cvPath = join(root, 'cv.md');
    const requested = join(root, 'output', 'anchors.json');
    await mkdir(join(root, 'output'), { recursive: true });
    await writeFile(cvPath, BASE_CV);
    const args = [CLI, '--cv', cvPath, '--init', requested];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const match = /Draft manifest written: (.+)/.exec(first.stdout);
    assert.ok(match, first.stdout);
    const draftPath = match[1].trim();
    assert.match(draftPath, /anchors\.[a-f0-9]{12}\.json$/);
    const original = await readFile(draftPath, 'utf8');
    const draft = JSON.parse(original);
    assert.ok(draft.claims.every((entry) => entry.state === 'unanchored'));

    const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(second.status, 1);
    assert.match(`${second.stdout}\n${second.stderr}`, /init_collision/);
    assert.equal(await readFile(draftPath, 'utf8'), original);
  });
});
