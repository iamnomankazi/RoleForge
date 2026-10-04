#!/usr/bin/env node

/** Record a user's manual final submission, then gate the canonical tracker write. */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT,
  acquireBatchExecutionLock,
  assertPreflightConfirmed,
  loadBatchState,
  recordSubmissionConfirmation,
} from './application-batch.mjs';
import { sha256Canonical } from './application-integrity.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { normalizeCompany } from './tracker-utils.mjs';

function inline(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function normalizedRole(value) {
  return inline(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function exactTrackerRow(trackerPath, trackerRow) {
  if (!existsSync(trackerPath) || !statSync(trackerPath).isFile()) throw new Error(`Tracker file is missing: ${trackerPath}`);
  const content = readFileSync(trackerPath, 'utf8');
  const lines = content.split('\n');
  const columns = resolveColumns(lines);
  const matches = lines.map((line) => parseTrackerRow(line, columns)).filter((row) => row?.num === trackerRow);
  if (matches.length !== 1) throw new Error(`Tracker row #${trackerRow} must exist exactly once`);
  return matches[0];
}

export function buildSubmissionPreview({
  root = ROOT,
  manifestPath,
  candidateId,
  trackerPath,
  trackerRow,
  evidence,
} = {}) {
  if (!manifestPath) throw new Error('Explicit --manifest is required');
  if (!candidateId) throw new Error('Explicit --candidate-id is required');
  if (!Number.isInteger(Number(trackerRow)) || Number(trackerRow) < 1) throw new Error('Explicit positive --tracker-row is required');
  const proof = inline(evidence);
  if (!proof || proof.length > 500) throw new Error('Short explicit user submission evidence is required (1-500 characters)');
  const lexicalTracker = resolve(root, trackerPath || '');
  const exactTracker = realpathSync(lexicalTracker);
  const loaded = loadBatchState(manifestPath, { root });
  const verified = assertPreflightConfirmed(loaded.manifest, loaded.state, {
    root, requireCv: true, requireCoverLetter: true,
  });
  const candidate = verified.candidates.find((row) => row.candidate_id === candidateId);
  const candidateState = loaded.state.candidates.find((row) => row.candidate_id === candidateId);
  if (!candidate || !candidateState) throw new Error('Candidate is not in the supplied application batch');
  if (candidateState.state !== 'form_prepared') {
    throw new Error(`Manual submission confirmation requires form_prepared state, found ${candidateState.state}`);
  }
  if (!candidateState.formPreparation?.reviewComplete || candidateState.formPreparation?.finalAction?.activated !== false) {
    throw new Error('Manual submission confirmation requires completed Phase 4 whole-form review evidence');
  }
  if (candidateState.importVerification?.status === 'legacy_unverified') {
    throw new Error('Legacy-imported candidate has not passed fresh listing verification');
  }
  const tracker = exactTrackerRow(exactTracker, Number(trackerRow));
  if (normalizeCompany(candidate.company) !== normalizeCompany(tracker.company)
      || normalizedRole(candidate.title) !== normalizedRole(tracker.role)) {
    throw new Error('Exact tracker row company/role does not match the manifest candidate');
  }
  const envelope = {
    schemaVersion: 1,
    action: 'record_user_confirmed_manual_submission',
    batchId: loaded.manifest.batchId,
    sourceRunId: loaded.manifest.sourceRunId,
    manifestScopeHash: loaded.manifest.scopeHash,
    sourceIntegrity: loaded.manifest.sourceIntegrity,
    preflightScopeHash: loaded.state.preflight.confirmedScopeHash,
    orderedCandidateIds: loaded.manifest.candidates.map((row) => row.candidate_id),
    candidate: {
      candidate_id: candidate.candidate_id,
      company: candidate.company,
      title: candidate.title,
      listingUrl: candidate.listingUrl,
      applyUrl: candidate.applyUrl,
      cv: candidate.artifacts.cv && {
        intendedFilename: candidate.artifacts.cv.intendedFilename,
        sha256: candidate.artifacts.cv.sha256,
      },
      coverLetter: candidate.artifacts.coverLetter && {
        intendedFilename: candidate.artifacts.coverLetter.intendedFilename,
        sha256: candidate.artifacts.coverLetter.sha256,
      },
      formPreparationEvidenceHash: candidateState.formPreparation.evidenceHash,
    },
    tracker: {
      path: exactTracker,
      row: Number(trackerRow),
      company: tracker.company,
      role: tracker.role,
    },
    evidence: proof,
  };
  const confirmationDigest = sha256Canonical(envelope);
  const eventId = `submission_v1_${confirmationDigest.slice('sha256:'.length)}`;
  return {
    envelope,
    confirmationDigest,
    eventId,
    manifestPath: loaded.manifestPath,
    trackerPath: exactTracker,
    trackerRow: Number(trackerRow),
    trackerRecord: tracker,
    candidate,
    candidateState,
  };
}

export function confirmManualSubmission(options = {}) {
  const initialPreview = buildSubmissionPreview(options);
  if (options.confirmationDigest !== initialPreview.confirmationDigest) {
    throw new Error(`Confirmation must repeat the exact preview digest: ${initialPreview.confirmationDigest}`);
  }
  const lock = acquireBatchExecutionLock(initialPreview.manifestPath, {
    root: options.root || ROOT,
    candidateId: initialPreview.candidate.candidate_id,
    operation: 'confirm_manual_submission',
  });
  try {
    const preview = buildSubmissionPreview(options);
    if (preview.confirmationDigest !== initialPreview.confirmationDigest
        || options.confirmationDigest !== preview.confirmationDigest) {
      throw new Error('Submission confirmation scope changed after preview; preview and confirm again');
    }
    if (preview.trackerRecord.status === 'Applied'
        && !String(preview.trackerRecord.notes || '').includes(preview.eventId)
        && preview.candidateState.submission?.status !== 'tracker_applied') {
      throw new Error('Tracker row is already Applied without this batch submission event');
    }
    if (preview.candidateState.submission?.status === 'tracker_applied'
        && preview.candidateState.submission.eventId === preview.eventId) {
      const tracker = exactTrackerRow(preview.trackerPath, preview.trackerRow);
      if (tracker.status !== 'Applied' || !String(tracker.notes || '').includes(preview.eventId)) {
        throw new Error('Completed submission state no longer matches the tracker readback');
      }
      return { ...preview, changed: false, status: 'tracker_applied', idempotent: true };
    }
    recordSubmissionConfirmation(preview.manifestPath, preview.candidate.candidate_id, {
      root: options.root || ROOT,
      status: 'confirmed_pending_tracker',
      eventId: preview.eventId,
      trackerPath: preview.trackerPath,
      trackerRow: preview.trackerRow,
      evidence: preview.envelope.evidence,
      confirmationEnvelope: preview.envelope,
      lockToken: lock.token,
    });
    const note = `[submission-event:${preview.eventId}] User confirmed manual final submission; batch=${preview.envelope.batchId}; candidate=${preview.candidate.candidate_id}`;
    const result = spawnSync(process.execPath, [
      resolve(ROOT, 'set-status.mjs'),
      String(preview.trackerRow),
      'Applied',
      '--note', note,
      '--application-manifest', preview.manifestPath,
      '--candidate-id', preview.candidate.candidate_id,
      '--submission-event', preview.eventId,
      '--json',
    ], {
      cwd: options.root || ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CAREER_OPS_TRACKER: preview.trackerPath,
        CAREER_OPS_APPLICATION_ROOT: options.root || ROOT,
      },
    });
    if (result.status !== 0) {
      throw new Error(`Canonical tracker update failed; submission remains pending for safe retry: ${(result.stderr || result.stdout).trim()}`);
    }
    const tracker = exactTrackerRow(preview.trackerPath, preview.trackerRow);
    if (tracker.status !== 'Applied' || !String(tracker.notes || '').includes(preview.eventId)) {
      throw new Error('Tracker readback did not contain the exact Applied submission event');
    }
    recordSubmissionConfirmation(preview.manifestPath, preview.candidate.candidate_id, {
      root: options.root || ROOT,
      status: 'tracker_applied',
      eventId: preview.eventId,
      trackerPath: preview.trackerPath,
      trackerRow: preview.trackerRow,
      evidence: preview.envelope.evidence,
      confirmationEnvelope: preview.envelope,
      lockToken: lock.token,
    });
    return { ...preview, changed: true, status: 'tracker_applied', trackerResult: JSON.parse(result.stdout) };
  } finally {
    lock.release();
  }
}

function parseArgs(argv) {
  const options = {};
  const map = new Map([
    ['--manifest', 'manifestPath'], ['--candidate-id', 'candidateId'], ['--tracker', 'trackerPath'],
    ['--tracker-row', 'trackerRow'], ['--evidence', 'evidence'], ['--confirm-digest', 'confirmationDigest'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!map.has(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    const key = map.get(arg);
    if (options[key] != null) throw new Error(`Duplicate option: ${arg}`);
    options[key] = value;
    index += 1;
  }
  if (options.trackerRow != null) options.trackerRow = Number(options.trackerRow);
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node application-submission.mjs preview --manifest <manifest.json> --candidate-id <id> --tracker <applications.md> --tracker-row <#> --evidence <user-confirmation>',
    '  node application-submission.mjs confirm <same options> --confirm-digest <exact-preview-digest>',
    'This command records a submission the user already completed. It never clicks a final browser control.',
  ].join('\n');
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') return console.log(usage());
  const options = parseArgs(argv);
  if (command === 'preview') {
    const result = buildSubmissionPreview(options);
    console.log(JSON.stringify({ envelope: result.envelope, confirmationDigest: result.confirmationDigest, eventId: result.eventId }, null, 2));
    return;
  }
  if (command === 'confirm') {
    const result = confirmManualSubmission(options);
    console.log(JSON.stringify({ batchId: result.envelope.batchId, candidateId: result.candidate.candidate_id, trackerRow: result.trackerRow, status: result.status, changed: result.changed }, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
