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
import { compareDriftFacts, extractDocumentSegments } from '../validate-cv-claims.mjs';

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

test('unit suffixes glued to numbers are checked as metrics, not as stray words', () => {
  const cv = BASE_CV.replace('for 30 users', 'from 1.1M+ synthetic records in 50k-row batches');
  const manifest = anchoredManifest(cv);
  const check = (text) => validateClaims({ claims: [{ id: 'm', text }], manifest, cv }).results[0];
  assert.equal(check('Built API services in JavaScript from 1.1M+ synthetic records in 50k-row batches.').status, 'pass');
  assert.equal(check('Built API services in JavaScript from 2.5M+ synthetic records.').reasonCode, 'unsupported_metric');
  assert.equal(check('Built API services in JavaScript from 1.1M synthetic records.').reasonCode, 'unsupported_metric');
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
    assert.ok(draft.claims.every((entry) => entry.state === 'asserted'));
    assert.ok(draft.claims.every((entry) => entry.evidence.some((ref) => ref.path === 'cv.md' && ref.relation === 'self' && ref.sourceHash === draft.cv.inputHash)));

    const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(second.status, 1);
    assert.match(`${second.stdout}\n${second.stderr}`, /init_collision/);
    assert.equal(await readFile(draftPath, 'utf8'), original);
  });
});

test('refresh carries content-stable claims, asserts new claims, and reports stale changes/removals', async () => {
  await withTemp(async (root) => {
    const cvPath = join(root, 'cv.md');
    const activePath = join(root, 'active.json');
    const requested = join(root, 'output', 'refresh.json');
    const newer = BASE_CV.replace('30 users', '40 users').replace('## Sample Project', '## Renamed Sample');
    await writeFile(cvPath, newer);
    await writeFile(activePath, `${JSON.stringify(anchoredManifest(), null, 2)}\n`);
    const run = spawnSync(process.execPath, [CLI, '--cv', cvPath, '--anchors', activePath, '--refresh', requested, '--json'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.ok(report.delta.added.length > 0);
    assert.ok(report.delta.changed.length > 0);
    assert.ok(report.delta.removed.length > 0);
    assert.ok(report.staleClaims.length > 0);
    const refreshed = JSON.parse(await readFile(report.draftPath, 'utf8'));
    assert.ok(refreshed.claims.every((entry) => entry.state === 'asserted'));
    assert.ok(refreshed.claims.every((entry) => entry.evidence[0].relation === 'self'));
    assert.ok(report.delta.added.every((id) => refreshed.claims.find((entry) => entry.id === id)?.state === 'asserted'));
    assert.equal(JSON.parse(await readFile(activePath, 'utf8')).cv.inputHash, anchoredManifest().cv.inputHash);
  });
});

test('activation refuses an existing active manifest unless replacement is explicit, then backs it up', async () => {
  await withTemp(async (root) => {
    const activePath = join(root, 'data', 'cv-claim-anchors.json');
    const draftPath = join(root, 'output', 'draft.json');
    const oldManifest = anchoredManifest();
    const newManifest = createDraftManifest(BASE_CV.replace('30 users', '31 users'));
    await mkdir(join(root, 'data'), { recursive: true });
    await mkdir(join(root, 'output'), { recursive: true });
    await writeFile(activePath, `${JSON.stringify(oldManifest)}\n`);
    await writeFile(draftPath, `${JSON.stringify(newManifest)}\n`);
    const refused = spawnSync(process.execPath, [CLI, '--activate', draftPath, '--anchors', activePath], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /active_manifest_exists/);
    assert.equal(JSON.parse(await readFile(activePath, 'utf8')).cv.inputHash, oldManifest.cv.inputHash);
    assert.ok(await readFile(draftPath, 'utf8'));

    const activated = spawnSync(process.execPath, [CLI, '--activate', draftPath, '--anchors', activePath, '--replace-active', '--json'], { encoding: 'utf8' });
    assert.equal(activated.status, 0, activated.stderr);
    const result = JSON.parse(activated.stdout);
    assert.ok(result.backupPath);
    assert.equal(JSON.parse(await readFile(result.backupPath, 'utf8')).cv.inputHash, oldManifest.cv.inputHash);
    assert.equal(JSON.parse(await readFile(activePath, 'utf8')).cv.inputHash, newManifest.cv.inputHash);
  });
});

test('drift comparison flags PDF-only technology, metric, project, employer, and language facts for review', () => {
  const cv = `# Projects\n## Sample Processor\n- Processed 500 rows with Python.\n\n# Languages\n- English: Fluent\n`;
  const approvedText = `Projects\nNew Ledger\nBuilt with Python and Rust across 750 rows.\nExperience\nEngineer | Example Labs | 2021-2022\nLanguages\nEnglish: Fluent\nFinnish: Beginner\n`;
  const facts = compareDriftFacts(cv, approvedText);
  assert.ok(facts.some((fact) => fact.type === 'technology' && fact.text === 'rust' && fact.state === 'needs_review'));
  assert.ok(facts.some((fact) => fact.type === 'metric' && fact.text === '750 rows'));
  assert.ok(facts.some((fact) => fact.type === 'project' && fact.text === 'New Ledger'));
  assert.ok(facts.some((fact) => fact.type === 'employer' && fact.text === 'Example Labs'));
  assert.ok(facts.some((fact) => fact.type === 'language_level' && fact.text === 'Finnish: Beginner'));
  assert.ok(!facts.some((fact) => fact.text === 'Python' || fact.text === '500 rows' || fact.text === 'English: Fluent'));
});

test('document extraction strips HTML and LaTeX markup and separates plain-text bullets and sentences', () => {
  assert.deepEqual(extractDocumentSegments('<h2>Experience</h2><p>Built API services. Added support.</p>', 'cv.html'), ['Built API services.', 'Added support.']);
  assert.deepEqual(extractDocumentSegments('- First bullet.\n- Second bullet.', 'cv.txt'), ['First bullet.', 'Second bullet.']);
  assert.deepEqual(extractDocumentSegments('\\begin{document}\\section{Experience}\n\\item Built \\textbf{API} services.\\end{document}', 'cv.tex'), ['Built API services.']);
});

test('authorship and metrics require one complete project or experience anchor', () => {
  const skillsCv = '# Skills\n- JavaScript, React, Git\n';
  for (const text of ['I built Git.', 'I built React.']) {
    const result = validateClaims({ claims: [{ id: 'c', text }], manifest: anchoredManifest(skillsCv), cv: skillsCv });
    assert.equal(result.ok, false, text);
    assert.equal(result.results[0].reasonCode, 'unsupported_relationship');
  }
  const cv = '# Projects\n## Alpha\n- Built API services for 30 users.\n## Beta\n- Built tools for 900 users.\n';
  for (const [text, supported] of [['Built API services for 900 users', false], ['I built API services for 30 users.', true]]) {
    const result = validateClaims({ claims: [{ id: 'c', text }], manifest: anchoredManifest(cv), cv });
    assert.equal(result.ok, supported, text);
    if (!supported) assert.equal(result.results[0].reasonCode, 'unsupported_relationship');
    else assert.equal(result.results[0].anchorIds.length, 1);
  }
  const toolsCv = '# Projects\n## Alpha\n- Built API services with React.\n';
  assert.equal(validateClaims({ claims: [{ id: 'c', text: 'I built React.' }], manifest: anchoredManifest(toolsCv), cv: toolsCv }).ok, false);
  const authoredCv = '# Projects\n## Alpha\n- Authored a Node.js API.\n';
  assert.equal(validateClaims({ claims: [{ id: 'c', text: 'I authored a Nodejs API.' }], manifest: anchoredManifest(authoredCv), cv: authoredCv }).ok, true);
});

test('all numeric approximation markers survive cleaning and never authorize precise metrics', () => {
  for (const marked of ['~30', '≈30', 'approx. 30', 'about 30', 'around 30', 'over 30', 'more than 30', 'up to 30', '30+', '30 +']) {
    const cv = `## Projects\n- Processed ${marked} users.\n`;
    const manifest = anchoredManifest(cv);
    assert.ok(manifest.claims.some(entry => entry.type === 'metric' && entry.text.includes(marked)), marked);
    const precise = validateClaims({ claims: [{ id: 'c', text: 'Processed 30 users.' }], manifest, cv });
    assert.equal(precise.ok, false, marked);
    assert.equal(precise.results[0].reasonCode, 'unsupported_metric', marked);
    assert.equal(validateClaims({ claims: [{ id: 'c', text: `Processed ${marked} users.` }], manifest, cv }).ok, true, marked);
  }
  const cv = '## Projects\n- Processed 30 users.\n';
  assert.equal(validateClaims({ claims: [{ id: 'c', text: 'Processed 30.0 users.' }], manifest: anchoredManifest(cv), cv }).ok, false);
});

test('dotted technology aliases remain intact in HTML, plain text and TeX sentences', () => {
  const cv = '# Skills\n- Node.js, Next.js, Vue.js, .NET, ASP.NET\n';
  const manifest = anchoredManifest(cv);
  for (const [source, path] of [
    ['<p>Node.js</p><p>Next.js</p><p>Vue.js</p><p>.NET</p><p>ASP.NET</p>', 'cv.html'],
    ['Node.js\nNext.js\nVue.js\n.NET\nASP.NET', 'cv.txt'],
    ['\\begin{document}Node.js\\\\ Next.js\\\\ Vue.js\\\\ .NET\\\\ ASP.NET\\end{document}', 'cv.tex'],
  ]) {
    const segments = extractDocumentSegments(source, path);
    assert.equal(segments.length, 5, JSON.stringify(segments));
    assert.equal(validateClaims({ claims: segments.map((text, index) => ({ id: String(index), text })), manifest, cv }).ok, true);
  }
  const segments = extractDocumentSegments('<p>Used Node.js. Used Next.js.</p>', 'cv.html');
  assert.deepEqual(segments, ['Used Node.js.', 'Used Next.js.']);
});

test('standard empty TeX template has no facts and untrusted definitions fail closed', async () => {
  const template = (await readFile(resolve('templates/cv-template.tex'), 'utf8')).replace(/\{\{[A-Z_]+\}\}/g, '');
  assert.deepEqual(extractDocumentSegments(template, 'cv.tex'), []);
  const filled = template.replace('\\section{Education}', '\\section{Education}\n\\resumeItem{Processed 500 rows.}')
    .replace('\\begin{document}', '\\begin{document}\n\\newcommand{\\fixture}[1]{TypeScript and 900 users}\n\\vspace{-7pt}');
  assert.throws(() => extractDocumentSegments(filled, 'cv.tex'), /untrusted_macro_definition/);
  assert.throws(() => extractDocumentSegments('\\newcommand{\\hidden}{TypeScript}\n\\begin{document}Processed 500 rows.\\hidden\\end{document}', 'cv.tex'), /untrusted_macro_definition/);
  assert.throws(() => extractDocumentSegments('\\begin{document}Processed 500 rows.\\input{unverified-facts}\\end{document}', 'cv.tex'), /unsupported_tex_command:input/);
  const currencyCv = '# Projects\n- Managed $30 for about 30 users.\n';
  const currency = extractDocumentSegments('\\begin{document}Managed \\$30 for about 30 users.\\end{document}', 'cv.tex');
  assert.equal(validateClaims({ claims: currency.map(text => ({ id: 'c', text })), manifest: anchoredManifest(currencyCv), cv: currencyCv }).ok, true);
});

test('strict document check reports unsupported generated facts with reason codes', async () => {
  await withTemp(async (root) => {
    const cvPath = join(root, 'cv.md');
    const anchorsPath = join(root, 'anchors.json');
    const documentPath = join(root, 'generated.html');
    await writeFile(cvPath, BASE_CV);
    await writeFile(anchorsPath, `${JSON.stringify(anchoredManifest())}\n`);
    await writeFile(documentPath, '<h2>Experience</h2><p>Built API services in JavaScript for 30 users.</p><p>Built API services in TypeScript for 30 users.</p>');
    const run = spawnSync(process.execPath, [CLI, '--check-document', documentPath, '--cv', cvPath, '--anchors', anchorsPath, '--strict'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    const report = JSON.parse(run.stdout);
    assert.equal(report.counts.checked, 2);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].reasonCode, 'unsupported_technology');
    assert.match(report.failures[0].text, /TypeScript/);
  });
});

test('every action verb must have the same lemma in the single covering anchor', () => {
  const cv = '# Projects\n- Built API services for 30 users.\n';
  for (const text of ['I managed API services for 30 users.', 'I built and maintained API services for 30 users.']) {
    const result = validateClaims({ claims: [{ id: 'action', text }], manifest: anchoredManifest(cv), cv });
    assert.equal(result.ok, false, text);
    assert.equal(result.results[0].reasonCode, 'unsupported_relationship');
  }
  for (const [past, present] of [['managed', 'manage'], ['led', 'lead'], ['built', 'build'], ['created', 'create'],
    ['developed', 'develop'], ['designed', 'design'], ['implemented', 'implement'], ['maintained', 'maintain'],
    ['owned', 'own'], ['reviewed', 'review'], ['analysed', 'analyze'], ['automated', 'automate'],
    ['processed', 'process'], ['migrated', 'migrate']]) {
    const source = `# Projects\n- ${past} API services for 30 users.\n`;
    assert.equal(validateClaims({ claims: [{ id: 'action', text: `I ${present} API services for 30 users.` }],
      manifest: anchoredManifest(source), cv: source }).ok, true, past);
  }
  assert.equal(validateClaims({ claims: [{ id: 'scope', text: 'Built API services by 30 users.' }], manifest: anchoredManifest(cv), cv }).ok, true);
});

test('skills lists and heading separators preserve supported structural combinations', () => {
  const cv = '# Skills\n- Python, Pandas\n\n# Experience\n## Engineer at Synthetic Labs 2022-2023\n';
  const manifest = anchoredManifest(cv);
  for (const separator of [',', '|', '·', '/', ';']) {
    const segments = extractDocumentSegments(`<h2>Skills</h2><p>Python ${separator} Pandas</p>`, 'cv.html');
    assert.deepEqual(segments, ['Python', 'Pandas']);
    assert.equal(validateClaims({ claims: segments.map(text => ({ id: text, text })), manifest, cv }).ok, true);
  }
  for (const separator of ['|', '·', '–', '—', '-']) {
    const text = `Engineer ${separator} Synthetic Labs ${separator} 2022-2023`;
    assert.equal(validateClaims({ claims: [{ id: 'heading', text }], manifest, cv }).ok, true, text);
  }
  assert.equal(validateClaims({ claims: [{ id: 'narrative', text: 'Built Python with Pandas.' }], manifest, cv }).ok, false);
});
