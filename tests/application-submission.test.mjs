import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  acquireBatchExecutionLock,
  bindCandidateArtifact,
  confirmPreflight,
  createApplicationBatch,
  loadBatchState,
  transitionCandidateState,
} from '../application-batch.mjs';
import { buildSubmissionPreview, confirmManualSubmission } from '../application-submission.mjs';
import { deriveCandidateId } from '../candidate-identity.mjs';

const HERE = resolve(import.meta.dirname, '..');

function fixture({ prepare = true, candidateTitle = 'Backend Engineer', trackerRole = candidateTitle } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-submission-'));
  const runId = 'submission-run';
  const url = 'https://jobs.example.test/acme/123';
  const candidate = { company: 'Acme', title: candidateTitle, url, source: 'fixture', run_id: runId };
  candidate.candidate_id = deriveCandidateId(candidate);
  const runDir = join(root, 'output', 'scan-runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify({ run_id: runId })}\n`);
  writeFileSync(join(runDir, 'candidates.json'), `${JSON.stringify([candidate])}\n`);
  const docs = join(root, 'output', 'application documents');
  mkdirSync(docs, { recursive: true });
  const cv = join(docs, 'Alex Example Backend CV.pdf');
  const cover = join(docs, 'Acme Backend Engineer Cover Letter.pdf');
  const coverText = join(docs, 'Acme Backend Engineer Cover Letter.txt');
  writeFileSync(cv, 'bound cv');
  writeFileSync(cover, 'bound cover');
  writeFileSync(coverText, 'Complete grounded cover letter text.');
  const tracker = join(root, 'applications.md');
  writeFileSync(tracker, [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    `| 7 | 2026-07-13 | Acme | ${trackerRole} | 4.5/5 | Evaluated | ✅ | — | ready |`,
  ].join('\n'));
  const created = createApplicationBatch({
    root, sourceRunId: runId, batchId: 'submission-batch', selectedCandidateIds: [candidate.candidate_id],
  });
  bindCandidateArtifact(created.manifestPath, candidate.candidate_id, { root, artifactType: 'cv', filePath: cv });
  bindCandidateArtifact(created.manifestPath, candidate.candidate_id, { root, artifactType: 'cover_letter', filePath: cover });
  bindCandidateArtifact(created.manifestPath, candidate.candidate_id, { root, artifactType: 'cover_letter_text', filePath: coverText });
  confirmPreflight(created.manifestPath, created.manifest.batchId, { root });
  if (prepare) {
    const lock = acquireBatchExecutionLock(created.manifestPath, {
      root, candidateId: candidate.candidate_id, operation: 'prepare_application',
    });
    const move = (state, expectedFrom, reason, formPreparation = null) => transitionCandidateState(
      created.manifestPath, candidate.candidate_id, state, {
        root, currentUrl: state === 'listing_verified' ? url : `${url}/application`,
        reason, expectedFrom, lockToken: lock.token, formPreparation,
      },
    );
    try {
      move('listing_verified', 'not_opened', 'fresh listing and identity verified');
      move('actual_form_reached', 'listing_verified', 'actual candidate form reached');
      move('form_inspected', 'actual_form_reached', 'whole form inspected');
      move('fields_filled', 'form_inspected', 'all grounded fields filled');
      move('files_uploaded', 'fields_filled', 'bound files uploaded');
      const formPreparation = {
        schemaVersion: 1,
        inspectedAt: '2026-07-13T10:00:00.000Z',
        reviewedAt: '2026-07-13T10:01:00.000Z',
        currentUrl: `${url}/application`,
        formFingerprint: 'sha256:fixture',
        requiredFieldCount: 5,
        filledFields: [{ semantic: 'email' }],
        committedSelections: [],
        uploadedArtifacts: [{ filename: 'Alex Example Backend CV.pdf' }, { filename: 'Acme Backend Engineer Cover Letter.pdf' }],
        unresolvedFields: [],
        validationErrors: [],
        userActionRequired: false,
        finalAction: { detected: true, label: 'Submit Application', semanticClass: 'form_submit', activated: false },
        reviewComplete: true,
        evidenceHash: 'sha256:fixture-form-review',
      };
      move('form_prepared', 'files_uploaded', 'form prepared; final submit untouched', formPreparation);
    } finally {
      lock.release();
    }
  }
  return { root, candidate, created, tracker };
}

function usingFixture(fn, options) {
  const f = fixture(options);
  try { return fn(f); } finally { rmSync(f.root, { recursive: true, force: true }); }
}

function previewOptions(f) {
  return {
    root: f.root,
    manifestPath: f.created.manifestPath,
    candidateId: f.candidate.candidate_id,
    trackerPath: f.tracker,
    trackerRow: 7,
    evidence: 'I reviewed the prepared form and manually clicked the final submit control.',
  };
}

test('direct Applied status is unavailable without batch submission proof', () => usingFixture((f) => {
  const result = spawnSync(process.execPath, [resolve(HERE, 'set-status.mjs'), '7', 'Applied', '--json'], {
    cwd: f.root,
    encoding: 'utf8',
    env: { ...process.env, CAREER_OPS_TRACKER: f.tracker, CAREER_OPS_APPLICATION_ROOT: f.root },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /application-batch submission confirmation/i);
  assert.match(readFileSync(f.tracker, 'utf8'), /\| Evaluated \|/);
}));

test('preview binds exact batch, candidate, artifacts, tracker row, and user evidence', () => usingFixture((f) => {
  const preview = buildSubmissionPreview(previewOptions(f));
  assert.match(preview.confirmationDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(preview.eventId, /^submission_v1_[a-f0-9]{64}$/);
  assert.equal(preview.envelope.batchId, 'submission-batch');
  assert.equal(preview.envelope.candidate.candidate_id, f.candidate.candidate_id);
  assert.equal(preview.envelope.candidate.cv.intendedFilename, 'Alex Example Backend CV.pdf');
  assert.equal(preview.envelope.tracker.row, 7);
}));

test('wrong digest cannot mark Applied; exact confirmation is delegated and idempotent', () => usingFixture((f) => {
  const options = previewOptions(f);
  const preview = buildSubmissionPreview(options);
  assert.throws(() => confirmManualSubmission({ ...options, confirmationDigest: 'sha256:' + '0'.repeat(64) }), /repeat the exact preview digest/);
  assert.match(readFileSync(f.tracker, 'utf8'), /\| Evaluated \|/);

  const confirmed = confirmManualSubmission({ ...options, confirmationDigest: preview.confirmationDigest });
  assert.equal(confirmed.status, 'tracker_applied');
  assert.equal(confirmed.trackerResult.followupSeedCandidate, true);
  const tracker = readFileSync(f.tracker, 'utf8');
  assert.match(tracker, /\| Applied \|/);
  assert.match(tracker, new RegExp(preview.eventId));
  const state = loadBatchState(f.created.manifestPath, { root: f.root }).state.candidates[0];
  assert.equal(state.state, 'form_prepared');
  assert.equal(state.submission.status, 'tracker_applied');
  assert.equal(state.submission.eventId, preview.eventId);

  const retry = confirmManualSubmission({ ...options, confirmationDigest: preview.confirmationDigest });
  assert.equal(retry.changed, false);
  assert.equal(retry.idempotent, true);
  assert.equal((readFileSync(f.tracker, 'utf8').match(new RegExp(preview.eventId, 'g')) || []).length, 1);
}));

test('submission requires form_prepared and an exact tracker identity', () => usingFixture((f) => {
  const options = previewOptions(f);
  writeFileSync(f.tracker, readFileSync(f.tracker, 'utf8').replace('Backend Engineer', 'Unrelated Role'));
  assert.throws(() => buildSubmissionPreview(options), /does not match the manifest candidate/);
}));

test('submission proof keeps distinct non-Latin role titles distinct', () => usingFixture((f) => {
  assert.throws(() => buildSubmissionPreview(previewOptions(f)), /does not match the manifest candidate/);
}, { candidateTitle: 'データエンジニア', trackerRole: 'バックエンドエンジニア' }));

test('submission is unavailable before the form is prepared', () => usingFixture((f) => {
  assert.throws(() => buildSubmissionPreview(previewOptions(f)), /requires form_prepared/);
}, { prepare: false }));

test('an already-Applied tracker row without the batch event is rejected', () => usingFixture((f) => {
  writeFileSync(f.tracker, readFileSync(f.tracker, 'utf8').replace('| Evaluated |', '| Applied |'));
  const options = previewOptions(f);
  const preview = buildSubmissionPreview(options);
  assert.throws(
    () => confirmManualSubmission({ ...options, confirmationDigest: preview.confirmationDigest }),
    /already Applied without this batch submission event/,
  );
}));

test('submission module contains no browser or final-control automation', () => {
  const source = readFileSync(resolve(HERE, 'application-submission.mjs'), 'utf8');
  assert.doesNotMatch(source, /playwright|\.click\s*\(|browser\.new/i);
});

test('application answer helper cannot independently claim submitted state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-answer-state-'));
  try {
    const report = join(dir, 'report.md');
    const input = join(dir, 'answers.json');
    writeFileSync(report, '# Report\n');
    writeFileSync(input, JSON.stringify({ state: 'submitted', freeText: [] }));
    const result = spawnSync(process.execPath, [
      resolve(HERE, 'application-answers.mjs'), '--report', report, '--input', input,
    ], { cwd: HERE, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Direct submitted state is disabled/);
    assert.equal(readFileSync(report, 'utf8'), '# Report\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
