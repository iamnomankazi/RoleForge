import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { chromium } from 'playwright';
import {
  acquireBatchExecutionLock, bindCandidateArtifacts, confirmPreflight, createApplicationBatch, loadBatchState, transitionCandidateState,
} from '../application-batch.mjs';
import { deriveCandidateId } from '../candidate-identity.mjs';
import { hashFile } from '../application-integrity.mjs';
import { prepareAndBindCombinedDocument } from '../application-documents.mjs';
import { buildFormPlan, inspectApplicationForm, prepareApplicationForm } from '../application-form-core.mjs';
import { singleDocumentFixture } from './fixtures/application-form-fixtures.mjs';

const syntheticProfile = {
  candidate: {
    full_name: 'Alex Example',
    email: 'alex.example@example.test',
    phone: '+1 202-555-0142',
    location: 'Example City, Finland',
    linkedin: 'https://linkedin.test/alex-example',
    github: 'https://github.test/alex-example',
  },
  location: { country: 'Finland', city: 'Example City' },
  currentStatus: { summary: 'Graduate student at Example University', availability: { start: 'Available immediately' } },
  compensation: { target_range: 'EUR 50,000-55,000/year' },
  education: { expected_graduation_date: '31/12/2030' },
  formRules: {
    current_location: { city: 'Example City', country: 'Finland', combined: 'Example City, Finland' },
    work_authorization: { home_country: 'Finland' },
    source: { value: 'LinkedIn' },
    narrative_evidence: [],
  },
  answers: new Map([['why this role?', 'Grounded synthetic fixture cover letter.']]),
  priorApprovedAnswers: [],
  cvText: 'Synthetic fixture evidence only.',
  articleDigestText: '',
  answerBankText: 'Synthetic fixture evidence only.',
  profileModeText: 'Synthetic fixture evidence only.',
};

async function pdf(path, widths) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  widths.forEach((width, index) => { const page = doc.addPage([width, 700]); page.drawText(`SOURCE PAGE ${index + 1}`, { x: 40, y: 650, font }); });
  writeFileSync(path, await doc.save({ useObjectStreams: false }));
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-combined-'));
  const runId = 'combined-run';
  const row = { company: 'Acme', title: 'Data Engineer', url: 'https://jobs.example.test/combined', run_id: runId, description: 'Build reliable Python and SQL pipelines. '.repeat(10) };
  row.candidate_id = deriveCandidateId(row);
  const runDir = join(root, 'output', 'scan-runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ run_id: runId }));
  writeFileSync(join(runDir, 'candidates.json'), JSON.stringify([row]));
  const batch = createApplicationBatch({ root, sourceRunId: runId, batchId: 'combined-batch', selectedCandidateIds: [row.candidate_id] });
  const docs = join(root, 'output', 'application documents'); mkdirSync(docs, { recursive: true });
  const cv = join(docs, 'Alex Example CV.pdf'); const cover = join(docs, 'Acme Data Engineer Cover Letter.pdf'); const text = join(docs, 'Acme Data Engineer Cover Letter.txt');
  await pdf(cv, [500, 501]); await pdf(cover, [600]); writeFileSync(text, 'Detailed cover letter');
  bindCandidateArtifacts(batch.manifestPath, row.candidate_id, [
    { artifactType: 'cv', filePath: cv }, { artifactType: 'cover_letter', filePath: cover }, { artifactType: 'cover_letter_text', filePath: text },
  ], { root });
  confirmPreflight(batch.manifestPath, batch.manifest.batchId, { root });
  const lock = acquireBatchExecutionLock(batch.manifestPath, { root, candidateId: row.candidate_id, operation: 'prepare_application' });
  const evidence = { schemaVersion: 1, inspectedAt: new Date().toISOString(), reviewedAt: new Date().toISOString(), currentUrl: row.url, formFingerprint: 'sha256:' + '1'.repeat(64), requiredFieldCount: 2, filledFields: [], committedSelections: [], uploadedArtifacts: [], unresolvedFields: [{ fieldId: 'doc', label: 'Application documents', semantic: 'single_document_upload', reason: 'Combined artifact required.' }], validationErrors: [], userActionRequired: true, finalAction: { detected: true, label: 'Apply', semanticClass: 'form_submit', activated: false }, uploadTopology: { mode: 'single_combined', reason: 'Exactly one explicit field.', fields: [{ fieldId: 'doc', label: 'Application documents', semantic: 'single_document_upload' }] }, reviewComplete: false, evidenceHash: 'sha256:' + '2'.repeat(64) };
  const move = (to, from, formPreparation = null) => transitionCandidateState(batch.manifestPath, row.candidate_id, to, { root, currentUrl: row.url, reason: `Move to ${to}`, expectedFrom: from, lockToken: lock.token, formPreparation });
  move('listing_verified', 'not_opened'); move('actual_form_reached', 'listing_verified'); move('form_inspected', 'actual_form_reached', evidence); move('review_required', 'form_inspected', evidence);
  lock.release();
  return { root, row, batch, cv, cover, evidence };
}

test('combined PDF preserves ordered source pages, binds exact hashes, and invalidates preflight without changing standalone files', async () => {
  const f = await fixture();
  try {
    const beforeCv = hashFile(f.cv); const beforeCover = hashFile(f.cover);
    const result = await prepareAndBindCombinedDocument({ manifestPath: f.batch.manifestPath, candidateId: f.row.candidate_id, confirmFormEvidenceHash: f.evidence.evidenceHash, root: f.root });
    assert.equal(result.pdf.order, 'cv_then_cover'); assert.equal(result.pdf.pageCount, 3);
    assert.match(result.record.intendedFilename, /^Acme Data Engineer Application Documents\.pdf$/);
    assert.equal(result.record.intendedFilename.includes('_'), false);
    const merged = await PDFDocument.load(readFileSync(result.record.resolvedPath));
    assert.deepEqual(merged.getPages().map((page) => page.getWidth()), [500, 501, 600]);
    assert.deepEqual(hashFile(f.cv), beforeCv); assert.deepEqual(hashFile(f.cover), beforeCover);
    const state = loadBatchState(f.batch.manifestPath, { root: f.root }).state;
    assert.equal(state.preflight.status, 'invalidated');
    assert.equal(state.candidates[0].artifacts.combinedDocument.sha256, result.record.sha256);
    assert.deepEqual(result.record.sourceArtifacts.map((row) => row.artifactType), ['cv', 'cover_letter']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('verified single-document field uploads exact combined artifact visibly and never submits', async () => {
  const f = await fixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const combined = await prepareAndBindCombinedDocument({ manifestPath: f.batch.manifestPath, candidateId: f.row.candidate_id, confirmFormEvidenceHash: f.evidence.evidenceHash, root: f.root });
    const page = await browser.newPage(); await page.setContent(singleDocumentFixture);
    const profile = syntheticProfile;
    const result = await prepareApplicationForm(page, profile, { combinedDocument: combined.record });
    assert.equal(result.evidence.uploadTopology.mode, 'single_combined');
    assert.equal(result.evidence.uploadedArtifacts[0].filename, combined.record.intendedFilename);
    assert.equal(result.evidence.finalAction.activated, false);
    assert.equal(await page.evaluate(() => window.fixtureSubmitCount || 0), 0);
  } finally { await browser.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('separate fields never use combined artifact and ambiguous upload purpose fails to review', () => {
  const profile = syntheticProfile;
  const combinedDocument = { intendedFilename: 'Acme Application Documents.pdf', sha256: 'sha256:x' };
  const separate = buildFormPlan({ fields: [{ fieldId: 'cv', type: 'file', label: 'CV', visible: true }, { fieldId: 'cover', type: 'file', label: 'Cover letter', visible: true }], controls: [] }, profile, { cv: {}, coverLetter: {}, combinedDocument });
  assert.equal(separate.uploadTopology.mode, 'separate');
  assert.ok(separate.actions.every((row) => row.artifact !== combinedDocument));
  const ambiguous = buildFormPlan({ fields: [{ fieldId: 'file', type: 'file', label: 'Attachment', required: true, visible: true }], controls: [] }, profile, { combinedDocument });
  assert.equal(ambiguous.uploadTopology.mode, 'ambiguous');
  assert.ok(ambiguous.unresolvedFields.length > 0);
});
