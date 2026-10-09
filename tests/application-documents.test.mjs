import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeImmutableScanRun } from '../scan-candidate-contract.mjs';
import { createApplicationBatch, loadBatchState } from '../application-batch.mjs';
import { candidateLocalDate, createDocumentPlan, prepareAndBindDocuments, validateDocumentPlan } from '../application-documents.mjs';
import { buildHtml, coverLetterFilename } from '../generate-cover-letter.mjs';
import { sha256Canonical } from '../application-integrity.mjs';
import { loadApplicationProfile, selectApprovedCv } from '../application-profile.mjs';
import { createDraftManifest } from '../cv-claims.mjs';
import { approveCoverLetterV2, runCoverLetterV2 } from '../cover-letter-v2.mjs';

function write(root, path, value) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
  return target;
}

function fixture({ legacyEvidence = false, claimManifest = true, unanchoredClaims = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-documents-'));
  write(root, 'config/profile.yml', `candidate:\n  full_name: Alex Example\n  email: alex.example@example.test\n  phone: "+1 202-555-0142"\n  location: Example City, Finland\n  linkedin: https://linkedin.test/alex-example\n  github: https://github.test/alex-example\nlocation:\n  country: Finland\n  city: Example City\ncurrent_status:\n  summary: Graduate student at Example University\n  availability:\n    start: Available immediately\ncompensation:\n  target_range: EUR 50000-55000/year\neducation_details:\n  expected_graduation_date: 31/12/2030\nnarrative:\n  banned_phrases: [excited to leverage, cutting-edge, passionate]\napplication_form:\n  narrative_evidence:\n    - id: fictional-cv-projects\n      topics: [data_engineering, analytics, python_sql, ai_ml, software_backend, motivation_fit]\n      provenance:\n        - sourceType: cv\n          locator: lines:2\ncv:\n  approved_system:\n    master_pdf: output/cv-approved/Alex Example Master CV.pdf\n    role_pdfs:\n      data_engineering: output/cv-approved/Alex Example Data Engineering CV.pdf\n      ai_ml: output/cv-approved/Alex Example AI ML CV.pdf\n      software_backend: output/cv-approved/Alex Example Software Backend CV.pdf\n`);
  const cvText = '## Projects\nIn the fictional Warehouse project, I used Python and SQL for data validation.';
  write(root, 'cv.md', cvText);
  if (claimManifest) {
    const claimManifestData = createDraftManifest(cvText);
    claimManifestData.claims.forEach((claim) => { claim.state = unanchoredClaims ? 'needs_review' : 'asserted'; });
    write(root, 'data/cv-claim-anchors.json', JSON.stringify(claimManifestData, null, 2));
  }
  write(root, 'modes/_profile.md', '# Rules\nUse only truthful approved evidence.');
  write(root, 'output/application-answer-bank.md', `# Application Answer Bank\n\n## Tell us about yourself\nI am an early-career Computer Science student with practical Python, SQL, backend, data, and machine-learning project work.\n\n## SQL/data experience\nI built a PostgreSQL warehouse from 250K+ synthetic inventory rows, including cleaning, validation, dimensional models, and reporting.\n\n## Data warehouse project\nI used Python, pandas, PostgreSQL, fact and dimension tables, indexes, and validation on 250K+ synthetic inventory rows.\n\n## Python experience\nI have used Python for ETL, data cleaning, Django backend work, automation, and machine-learning experiments.\n`);
  if (legacyEvidence) {
    const profilePath = join(root, 'config', 'profile.yml');
    const current = readFileSync(profilePath, 'utf8');
    writeFileSync(profilePath, current.replace(
      '      provenance:\n        - sourceType: cv\n          locator: lines:2',
      '      text: Unproven legacy cover-letter prose.\n      evidence_refs: [cv.md]',
    ));
  }
  for (const name of ['Master', 'Data Engineering', 'AI ML', 'Software Backend']) {
    write(root, `output/cv-approved/Alex Example ${name} CV.pdf`, `%PDF-1.4 ${name}`);
  }
  const description = 'Acme needs a junior Data Engineer to build Python and SQL ETL data pipelines, PostgreSQL dimensional models, data validation, analytics, and reporting with Git on Linux.';
  const scan = writeImmutableScanRun({
    root, runId: 'doc-run', sourceArchitecture: 'test',
    inputs: [{ name: 'fixture', rows: [{ company: 'Acme', title: 'Data Engineer', url: 'https://jobs.example.test/acme/1', description }] }],
  });
  const batch = createApplicationBatch({ root, sourceRunId: 'doc-run', batchId: 'doc-batch', selectedCandidateIds: [scan.candidates[0].candidate_id] });
  return { root, batch, candidateId: scan.candidates[0].candidate_id, description };
}

const v2PassingValidator = async ({ claims }) => ({
  ok: true,
  results: claims.map((claim) => ({ claimId: claim.id, status: 'pass' })),
});

function makeV2Draft(jdText, { companyName = 'Acme', roleName = 'Data Engineer' } = {}) {
  const sentence = 'I built reliable software tools with Python and SQL, validated structured data, documented interfaces, and tested changes carefully with teammates.';
  const sentences = Array.from({ length: 10 }, () => sentence);
  return {
    company: companyName,
    role: roleName,
    language: 'en',
    jd: { text: jdText },
    greeting: 'Dear Hiring Team,',
    paragraphs: [{ text: sentences.join(' '), claims: sentences.map((text, index) => ({ id: `claim-${index + 1}`, text })) }],
    closing: 'I would welcome a conversation about the role and its practical responsibilities.',
    signature: 'Synthetic Candidate',
  };
}

async function createApprovedV2Pair(f, options = {}) {
  const jdText = options.jdText || f.description;
  const draft = makeV2Draft(jdText, options);
  const outputDirectory = join(f.root, 'output', 'cover-letters');
  const result = await runCoverLetterV2(draft, {
    jdText,
    validateClaims: v2PassingValidator,
    outputDirectory,
  });
  assert.equal(result.status, 'pass', JSON.stringify(result.checks));
  const approval = options.approve === false ? null : await approveCoverLetterV2(result.files.check);
  return { result, approval, jdText };
}

function rehashPlan(plan) {
  plan.planHash = sha256Canonical(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planHash')));
  return plan;
}

function answerHash(value) {
  const clean = String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return `sha256:${createHash('sha256').update(clean).digest('hex')}`;
}

test('cover-letter date uses the candidate timezone across a UTC date boundary', () => {
  assert.equal(candidateLocalDate(
    new Date('2030-12-31T23:30:00.000Z'),
    { location: { timezone: 'Europe/Helsinki' } },
  ), '2031-01-01');
});

test('document plan binds exact JD, approved CV, grounded cover content, and readable filenames', async () => {
  const f = fixture();
  try {
    const plan = createDocumentPlan({ manifestPath: f.batch.manifestPath, candidateId: f.candidateId, root: f.root });
    assert.equal(plan.documentState, 'ready');
    assert.deepEqual(Object.keys(plan.sourceHashes).sort(), ['cv', 'profile']);
    assert.equal(plan.cv.variant, 'data_engineering');
    assert.match(plan.coverLetter.pdfPath, /acme_cover_letter\.pdf$/);
    assert.match(plan.coverLetter.textPath, /acme_cover_letter\.txt$/);
    assert.ok(!plan.coverLetter.pdfPath.includes('%20'));
    assert.equal(coverLetterFilename('Tesla'), 'tesla_cover_letter.pdf');
    assert.equal(coverLetterFilename('ACME & Sons'), 'acme_sons_cover_letter.pdf');
    assert.match(plan.coverLetter.text, /fictional Warehouse project/);
    assert.match(plan.coverLetter.text, /The role calls for/);
    assert.doesNotMatch(plan.coverLetter.text, /The job description emphasizes/i);
    const html = buildHtml(plan.coverLetter.payload);
    assert.match(html, /font-family: "Times New Roman"/);
    assert.match(html, /<div class="role-title">Cover Letter<\/div>/);
    assert.doesNotMatch(html, /cv:lines|structured_profile:|sha256:|fictional-cv-projects/);
    assert.doesNotMatch(html, /<ul class="achievements">/);
    const factualSentence = 'In the fictional Warehouse project, I used Python and SQL for data validation.';
    assert.equal(html.split(factualSentence).length - 1, 1);
    for (const paragraph of plan.coverLetter.text.split('\n\n')) assert.ok(html.includes(paragraph), paragraph);
    write(f.root, 'output/application-answer-bank.md', '# Changed draft wording only\n\n## Why this role?\nThis must not invalidate a factual document plan.\n');
    assert.equal(validateDocumentPlan(plan, f.batch.manifestPath, f.root).expectedCover.text, plan.coverLetter.text);
    const prepared = await prepareAndBindDocuments({
      manifestPath: f.batch.manifestPath,
      candidateId: f.candidateId,
      plan,
      confirmPlanHash: plan.planHash,
      root: f.root,
    });
    assert.equal(prepared.records.cv.sourceCvVariant, 'data_engineering');
    const loaded = loadBatchState(f.batch.manifestPath, { root: f.root });
    const artifacts = loaded.state.candidates[0].artifacts;
    assert.ok(artifacts.cv && artifacts.coverLetter && artifacts.coverLetterText);
    assert.equal(artifacts.coverLetterText.narrativeProvenance.schemaVersion, 1);
    assert.equal(artifacts.coverLetterText.narrativeProvenance.answerHash, plan.coverLetter.provenance.answerHash);
    assert.equal(artifacts.coverLetterText.sha256, prepared.records.coverLetterText.sha256);
    assert.equal(loaded.state.preflight.status, 'unconfirmed');
    assert.ok(readFileSync(artifacts.coverLetterText.resolvedPath, 'utf8').includes('Acme'));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('missing or rejecting CV claim manifests mark only narrative preparation review-required', () => {
  for (const options of [{ claimManifest: false }, { unanchoredClaims: true }]) {
    const f = fixture(options);
    try {
      const plan = createDocumentPlan({ manifestPath: f.batch.manifestPath, candidateId: f.candidateId, root: f.root });
      assert.equal(plan.documentState, 'review_required');
      assert.equal(plan.reviewRequired.code, 'candidate_claims_review_required');
      assert.ok(plan.reviewRequired.reasonCodes.length > 0);
      assert.equal(plan.cv.variant, 'data_engineering');
      assert.match(plan.coverLetter.text, /fictional Warehouse project/);
      assert.equal(validateDocumentPlan(plan, f.batch.manifestPath, f.root).expectedCover, null);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('an approved v2 pair is copied and bound to the exact batch candidate with both hashes and approval evidence', async () => {
  const f = fixture();
  try {
    const pair = await createApprovedV2Pair(f);
    const originalText = readFileSync(pair.result.files.text);
    const originalPdf = readFileSync(pair.result.files.pdf);
    const plan = createDocumentPlan({
      manifestPath: f.batch.manifestPath,
      candidateId: f.candidateId,
      coverV2Approved: pair.approval.approvedPath,
      root: f.root,
    });
    assert.equal(plan.documentState, 'ready');
    assert.equal(plan.coverLetter.text, originalText.toString('utf8'));
    assert.equal(validateDocumentPlan(plan, f.batch.manifestPath, f.root).expectedCover.approval.draftHash,
      JSON.parse(readFileSync(pair.approval.approvedPath, 'utf8')).draftHash);
    const prepared = await prepareAndBindDocuments({
      manifestPath: f.batch.manifestPath,
      candidateId: f.candidateId,
      plan,
      confirmPlanHash: plan.planHash,
      root: f.root,
    });
    const loaded = loadBatchState(f.batch.manifestPath, { root: f.root });
    const artifacts = loaded.state.candidates[0].artifacts;
    assert.equal(readFileSync(artifacts.coverLetterText.resolvedPath).toString('utf8'), originalText.toString('utf8'));
    assert.deepEqual(readFileSync(pair.result.files.text), originalText);
    assert.deepEqual(readFileSync(pair.result.files.pdf), originalPdf);
    for (const key of ['coverLetter', 'coverLetterText']) {
      assert.equal(artifacts[key].coverLetterV2Approval.draftHash, JSON.parse(readFileSync(pair.approval.approvedPath, 'utf8')).draftHash);
      assert.match(artifacts[key].coverLetterV2Approval.approvalRecordSha256, /^sha256:[a-f0-9]{64}$/);
    }
    assert.equal(prepared.records.coverLetter.sha256, artifacts.coverLetter.sha256);
    assert.equal(artifacts.coverLetter.sha256, `sha256:${JSON.parse(readFileSync(pair.approval.approvedPath, 'utf8')).pdfHash}`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('v2 binding rejects an unapproved pair, company/role mismatch, and candidate JD hash mismatch', async () => {
  const cases = [
    { kind: 'unapproved', options: { approve: false }, error: /approved v2 record is missing/i },
    { kind: 'company', options: { companyName: 'Other Labs', jdText: 'Other Labs has a Data Engineer opening. ' + 'Acme needs a junior Data Engineer to build Python and SQL ETL data pipelines, PostgreSQL dimensional models, data validation, analytics, and reporting with Git on Linux.' }, error: /company\/role does not match/i },
    { kind: 'role', options: { roleName: 'Analytics Engineer', jdText: 'Acme has an Analytics Engineer opening. ' + 'Acme needs a junior Data Engineer to build Python and SQL ETL data pipelines, PostgreSQL dimensional models, data validation, analytics, and reporting with Git on Linux.' }, error: /company\/role does not match/i },
    { kind: 'jd', options: { jdText: 'Acme needs a junior Data Engineer to build Python and SQL ETL data pipelines, PostgreSQL dimensional models, data validation, analytics, and reporting with Git on Linux. New wording.' }, error: /JD hash does not match/i },
  ];
  for (const item of cases) {
    const f = fixture();
    try {
      const pair = await createApprovedV2Pair(f, item.options);
      const approvedPath = pair.approval?.approvedPath || pair.result.files.check.replace(/\.check\.json$/, '.approved.json');
      assert.throws(() => createDocumentPlan({
        manifestPath: f.batch.manifestPath,
        candidateId: f.candidateId,
        coverV2Approved: approvedPath,
        root: f.root,
      }), item.error, item.kind);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('tampering with a v2 PDF after approval prevents binding', async () => {
  const f = fixture();
  try {
    const pair = await createApprovedV2Pair(f);
    writeFileSync(pair.result.files.pdf, 'tampered after approval');
    assert.throws(() => createDocumentPlan({
      manifestPath: f.batch.manifestPath,
      candidateId: f.candidateId,
      coverV2Approved: pair.approval.approvedPath,
      root: f.root,
    }), /approved v2 pair hash mismatch/i);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('document planning fails closed for missing JD and plan tampering', () => {
  const f = fixture();
  try {
    const sourcePath = join(f.root, 'output', 'scan-runs', 'doc-run', 'candidates.json');
    const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
    source[0].description = null;
    // Historical immutable source tampering is detected before a missing-JD fallback can be attempted.
    writeFileSync(sourcePath, JSON.stringify(source));
    assert.throws(() => createDocumentPlan({ manifestPath: f.batch.manifestPath, candidateId: f.candidateId, root: f.root }), /integrity mismatch/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('rehashed unsupported cover-letter prose is rejected by deterministic reconstruction before rendering', async () => {
  const f = fixture();
  try {
    const plan = createDocumentPlan({ manifestPath: f.batch.manifestPath, candidateId: f.candidateId, root: f.root });
    plan.coverLetter.text += '\n\nI owned production for a global platform.';
    plan.coverLetter.provenance.answerHash = answerHash(plan.coverLetter.text);
    rehashPlan(plan);
    await assert.rejects(() => prepareAndBindDocuments({
      manifestPath: f.batch.manifestPath,
      candidateId: f.candidateId,
      plan,
      confirmPlanHash: plan.planHash,
      root: f.root,
    }), /does not match deterministic cover-letter-v1 output/);
    assert.equal(existsSync(join(dirname(f.batch.manifestPath), 'documents', f.candidateId, 'acme_cover_letter.pdf')), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('tampered candidate-facing payload and unsupported cover templates are rejected before PDF binding', async () => {
  for (const mutation of ['payload', 'template']) {
    const f = fixture();
    try {
      const plan = createDocumentPlan({ manifestPath: f.batch.manifestPath, candidateId: f.candidateId, root: f.root });
      if (mutation === 'payload') plan.coverLetter.payload.letter.profile_intro += ' Unsupported payload claim.';
      else plan.coverLetter.provenance.templateId = 'cover-letter-v999';
      rehashPlan(plan);
      await assert.rejects(() => prepareAndBindDocuments({
        manifestPath: f.batch.manifestPath,
        candidateId: f.candidateId,
        plan,
        confirmPlanHash: plan.planHash,
        root: f.root,
      }), mutation === 'payload' ? /payload does not match deterministic/ : /Unsupported cover-letter template ID/);
      assert.equal(loadBatchState(f.batch.manifestPath, { root: f.root }).state.candidates[0].artifacts.coverLetter, null);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('legacy narrative evidence returns an explicit review-required document plan without corrupting batch state', async () => {
  const f = fixture({ legacyEvidence: true });
  try {
    const loadedBefore = loadBatchState(f.batch.manifestPath, { root: f.root });
    const stateBefore = readFileSync(loadedBefore.statePath, 'utf8');
    const plan = createDocumentPlan({ manifestPath: f.batch.manifestPath, candidateId: f.candidateId, root: f.root });
    assert.equal(plan.documentState, 'review_required');
    assert.equal(plan.reviewRequired.code, 'narrative_evidence_migration_required');
    assert.match(plan.reviewRequired.reason, /legacy unproven prose/);
    assert.match(plan.reviewRequired.action, /migrate.*factual CV\/profile provenance/i);
    assert.equal(plan.coverLetter.available, false);
    assert.equal(plan.coverLetter.text, null);
    assert.equal(plan.coverLetter.payload, null);
    assert.equal(plan.coverLetter.provenance, null);
    assert.equal(plan.cv.variant, 'data_engineering');
    assert.match(plan.jd.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(validateDocumentPlan(plan, f.batch.manifestPath, f.root).expectedCover, null);
    await assert.rejects(() => prepareAndBindDocuments({
      manifestPath: f.batch.manifestPath,
      candidateId: f.candidateId,
      plan,
      confirmPlanHash: plan.planHash,
      root: f.root,
    }), /narrative_evidence_migration_required/);
    assert.equal(readFileSync(loadedBefore.statePath, 'utf8'), stateBefore);
    assert.deepEqual(loadBatchState(f.batch.manifestPath, { root: f.root }).state.candidates[0].artifacts, {
      cv: null, coverLetter: null, coverLetterText: null, combinedDocument: null,
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('confirmed document plans still reject paths outside the exact batch candidate directory', async () => {
  const f = fixture();
  try {
    const plan = createDocumentPlan({ manifestPath: f.batch.manifestPath, candidateId: f.candidateId, root: f.root });
    plan.coverLetter.pdfPath = join(f.root, 'outside Cover Letter.pdf');
    plan.planHash = sha256Canonical(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planHash')));
    await assert.rejects(() => prepareAndBindDocuments({
      manifestPath: f.batch.manifestPath,
      candidateId: f.candidateId,
      plan,
      confirmPlanHash: plan.planHash,
      root: f.root,
    }), /escapes the exact batch candidate directory/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('confirmed document plans reject nonconforming cover-letter filenames inside the candidate directory', async () => {
  const f = fixture();
  try {
    const plan = createDocumentPlan({ manifestPath: f.batch.manifestPath, candidateId: f.candidateId, root: f.root });
    plan.coverLetter.pdfPath = join(dirname(plan.coverLetter.pdfPath), 'Acme Cover Letter.pdf');
    plan.planHash = sha256Canonical(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planHash')));
    await assert.rejects(() => prepareAndBindDocuments({
      manifestPath: f.batch.manifestPath,
      candidateId: f.candidateId,
      plan,
      confirmPlanHash: plan.planHash,
      root: f.root,
    }), /must use acme_cover_letter\.pdf/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('CV selection covers data, AI/ML, software/backend, and broad graduate roles deterministically', () => {
  const f = fixture();
  try {
    const profile = loadApplicationProfile(f.root);
    assert.equal(selectApprovedCv(profile, { title: 'Data Engineer' }, 'Python SQL ETL warehouse').variant, 'data_engineering');
    assert.equal(selectApprovedCv(profile, { title: 'Machine Learning Engineer' }, 'PyTorch computer vision model training').variant, 'ai_ml');
    assert.equal(selectApprovedCv(profile, { title: 'Backend Developer' }, 'Python Django REST APIs').variant, 'software_backend');
    assert.equal(selectApprovedCv(profile, { title: 'Graduate Technology Trainee' }, 'Python SQL machine learning software').variant, 'master');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
