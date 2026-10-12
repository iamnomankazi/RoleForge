#!/usr/bin/env node

/**
 * Immutable-run application-batch authority.
 *
 * Manifest data is immutable. Browser progress and explicit artifact bindings
 * live in separately versioned mutable state. Every executable scope is bound
 * to source-run, candidate, URL, and document hashes.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  candidateIdFromAliases,
  collectCandidateIdentityAliases,
  deriveCandidateId,
  isCandidateId,
} from './candidate-identity.mjs';
import {
  assertSourceRunIntegrity,
  createArtifactRecord,
  sha256Canonical,
  validateArtifactRecord,
} from './application-integrity.mjs';
import { GENERIC_APPLICATION_CLASSIFICATION_SEMANTICS } from './application-reasoning.mjs';
import { HUMAN_GATE_CAUSES, HUMAN_GATE_SIGNALS, sanitizeHumanGateUrl, sanitizeUrl, sanitizePersistedUrls } from './application-form-core.mjs';
import { hashFormValue } from './application-form-policy.mjs';
import { normalizeTextKey, parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { loadCanonicalStates, resolveCanonicalState } from './tracker-utils.mjs';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const APPLICATION_BATCH_MANIFEST_SCHEMA_VERSION = 2;
export const APPLICATION_BATCH_STATE_SCHEMA_VERSION = 5;
export const APPLICATION_BATCH_SCHEMA_VERSION = APPLICATION_BATCH_MANIFEST_SCHEMA_VERSION;
export const EXECUTION_STATES = Object.freeze([
  'not_opened',
  'listing_verified',
  'actual_form_reached',
  'form_inspected',
  'fields_filled',
  'files_uploaded',
  'review_required',
  'login_required',
  'human_action_required',
  'form_prepared',
  'blocked',
  'closed',
  'abandoned',
]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const TRANSITIONS = Object.freeze({
  not_opened: new Set(['listing_verified', 'login_required', 'blocked', 'closed', 'abandoned']),
  listing_verified: new Set(['actual_form_reached', 'review_required', 'login_required', 'human_action_required', 'blocked', 'closed', 'abandoned']),
  actual_form_reached: new Set(['form_inspected', 'form_prepared', 'review_required', 'login_required', 'human_action_required', 'blocked', 'closed', 'abandoned']),
  form_inspected: new Set(['fields_filled', 'review_required', 'login_required', 'blocked', 'closed', 'abandoned']),
  fields_filled: new Set(['files_uploaded', 'form_prepared', 'review_required', 'login_required', 'blocked', 'closed', 'abandoned']),
  files_uploaded: new Set(['form_prepared', 'review_required', 'login_required', 'blocked', 'closed', 'abandoned']),
  review_required: new Set(['review_required', 'actual_form_reached', 'form_inspected', 'human_action_required', 'blocked', 'closed', 'abandoned']),
  login_required: new Set(['listing_verified', 'actual_form_reached', 'review_required', 'human_action_required', 'blocked', 'closed', 'abandoned']),
  human_action_required: new Set(['actual_form_reached', 'login_required', 'blocked', 'review_required', 'abandoned']),
  form_prepared: new Set(['closed', 'abandoned']),
  blocked: new Set(['actual_form_reached', 'review_required', 'login_required', 'human_action_required', 'closed', 'abandoned']),
  closed: new Set(),
  abandoned: new Set(),
});

function inline(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

const HUMAN_ACTION_STAGES = new Set(['listing', 'application_entry', 'form_inspection', 'field_filling', 'form_progression', 'form_review']);

function validateHumanAction(value, candidateId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Human action record is required');
  assertKnownFields(value, new Set(['candidate_id', 'cause', 'stage', 'currentUrl', 'timestamp', 'evidence']), 'human action record');
  if (value.candidate_id !== candidateId) throw new Error('Human action candidate identity mismatch');
  if (!HUMAN_GATE_CAUSES.includes(value.cause)) throw new Error('Invalid human action cause');
  if (!HUMAN_ACTION_STAGES.has(value.stage)) throw new Error('Invalid human action stage');
  requireHttpUrl(value.currentUrl, 'human action current URL');
  if (value.currentUrl !== sanitizeHumanGateUrl(value.currentUrl)) throw new Error('Human action URL must be sanitized');
  if (!Number.isFinite(Date.parse(value.timestamp))) throw new Error('Invalid human action timestamp');
  if (!Array.isArray(value.evidence) || !value.evidence.length
      || value.evidence.some((signal) => !HUMAN_GATE_SIGNALS.includes(signal))) {
    throw new Error('Human action evidence must contain only classifier signal names');
  }
}

function validateHumanActionRevalidation(details, candidateId) {
  const checks = details?.humanActionRevalidation;
  if (checks?.candidate_id !== candidateId
      || !['listingLive', 'identityVerified', 'destinationCompatible', 'gateCleared', 'formVerified']
        .every((key) => checks[key] === true)) {
    throw new Error('Resuming a human action pause requires fresh exact-candidate revalidation');
  }
}

function requireSafeId(value, label) {
  const id = inline(value);
  if (!SAFE_ID.test(id)) throw new Error(`${label} must be 1-120 safe filename characters`);
  return id;
}

function requireCandidateId(value, label = 'candidate ID') {
  const id = inline(value);
  if (!isCandidateId(id)) throw new Error(`${label} is not a supported versioned candidate ID: ${id || '(empty)'}`);
  return id;
}

function requireHttpUrl(value, label) {
  const raw = inline(value);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL: ${raw || '(empty)'}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label} must use http or https: ${raw}`);
  return raw;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${path}: ${error.message}`);
  }
}

function writeJsonExclusive(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

function writeJsonAtomic(path, value) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  renameSync(temp, path);
}

function sanitizedPreparation(value) {
  const sanitized = sanitizePersistedUrls(value);
  if (JSON.stringify(sanitized) !== JSON.stringify(value)) {
    sanitized.evidenceHash = hashFormValue(JSON.stringify({ ...sanitized, evidenceHash: undefined }));
  }
  return sanitized;
}

function sanitizedBatchState(state) {
  const sanitized = sanitizePersistedUrls(state);
  for (const [index, candidate] of sanitized.candidates.entries()) {
    const original = state.candidates[index];
    if (original.formPreparation) candidate.formPreparation = sanitizedPreparation(original.formPreparation);
    candidate.formPreparationHistory = (original.formPreparationHistory || []).map(sanitizedPreparation);
  }
  return sanitized;
}

function writeBatchState(path, state) {
  writeJsonAtomic(path, sanitizedBatchState(state));
}

function assertKnownFields(value, allowed, label) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) throw new Error(`Unknown critical ${label} field: ${key}`);
  }
}

function applicationBatchRoot(root = ROOT) {
  return join(resolve(root), 'output', 'application-batches');
}

function candidateClaimPath(root, candidateId) {
  return join(applicationBatchRoot(root), '.candidate-claims', requireCandidateId(candidateId));
}

function ensureCandidateClaim(root, batchId, candidateId, now) {
  const parent = join(applicationBatchRoot(root), '.candidate-claims');
  mkdirSync(parent, { recursive: true });
  const claimPath = candidateClaimPath(root, candidateId);
  const ownerPath = join(claimPath, 'owner.json');
  try {
    mkdirSync(claimPath);
    writeJsonExclusive(ownerPath, {
      schemaVersion: 1,
      batchId,
      candidateId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const owner = readJson(ownerPath, 'candidate execution claim');
    if (owner.batchId !== batchId || owner.candidateId !== candidateId) {
      throw new Error(`Candidate ${candidateId} is already claimed by application batch ${owner.batchId}`);
    }
    owner.updatedAt = now.toISOString();
    writeJsonAtomic(ownerPath, owner);
  }
  return claimPath;
}

function releaseCandidateClaim(root, batchId, candidateId) {
  const claimPath = candidateClaimPath(root, candidateId);
  const ownerPath = join(claimPath, 'owner.json');
  if (!existsSync(ownerPath)) return;
  const owner = readJson(ownerPath, 'candidate execution claim');
  if (owner.batchId !== batchId || owner.candidateId !== candidateId) {
    throw new Error('Refusing to release a candidate claim owned by another batch');
  }
  rmSync(claimPath, { recursive: true, force: true });
}

export function inspectCandidateClaim(root, candidateId) {
  const claimPath = candidateClaimPath(root, candidateId);
  const ownerPath = join(claimPath, 'owner.json');
  return existsSync(ownerPath) ? { claimPath, owner: readJson(ownerPath, 'candidate execution claim') } : null;
}

export function sourceCandidatesPath(root, sourceRunId) {
  const runId = requireSafeId(sourceRunId, 'source run ID');
  return join(resolve(root), 'output', 'scan-runs', runId, 'candidates.json');
}

function generateBatchId(sourceRunId) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `apply-${stamp}-${requireSafeId(sourceRunId, 'source run ID').slice(0, 48)}-${randomBytes(4).toString('hex')}`;
}

function uniqueUrls(values) {
  return [...new Set(values.map(inline).filter(Boolean).map((value, index) => requireHttpUrl(value, `URL alias ${index + 1}`)))];
}

function normalizeSourceCandidate(row, runId, index) {
  const company = inline(row?.company);
  const title = inline(row?.title ?? row?.role);
  const listingUrl = requireHttpUrl(
    row?.url ?? row?.listing_url ?? row?.listingUrl ?? row?.canonical_url ?? row?.original_url ?? row?.originalUrl,
    `source candidate ${index + 1} listing URL`,
  );
  if (!company || !title) throw new Error(`Source candidate ${index + 1} is missing company or title`);
  const rowRunId = inline(row?.run_id ?? row?.runId);
  if (rowRunId && rowRunId !== runId) {
    throw new Error(`Source candidate belongs to another run: ${rowRunId}`);
  }
  const persistedId = inline(row?.candidate_id ?? row?.candidateId);
  let aliases;
  let candidateId;
  let identityStatus;
  if (persistedId) {
    candidateId = requireCandidateId(persistedId, `source candidate ${index + 1} candidate_id`);
    if (candidateId.startsWith('legacy_')) throw new Error('Merged scan artifacts may not persist legacy candidate IDs');
    let currentError = null;
    try {
      aliases = collectCandidateIdentityAliases(row);
      if (candidateIdFromAliases(aliases) === candidateId) identityStatus = 'stable';
    } catch (error) { currentError = error; }
    if (!identityStatus) {
      // Historical scan runs persisted Workday IDs derived by the pre-fix rule. Accept such a row only when the
      // old rule reproduces its exact persisted ID; it stays readable but is never selectable for a new batch.
      let previous = null;
      try { previous = collectCandidateIdentityAliases(row, { workdayRule: 'prefix_v1' }); } catch { previous = null; }
      if (!previous || candidateIdFromAliases(previous) !== candidateId) {
        if (currentError) throw currentError;
        throw new Error(`Source candidate_id does not match deterministic identity: ${candidateId}`);
      }
      aliases = previous;
      identityStatus = 'stable_prefix_workday';
    }
  } else {
    aliases = collectCandidateIdentityAliases(row);
    candidateId = deriveCandidateId(row, { legacy: true });
    identityStatus = 'legacy_derived';
  }
  const urlAliases = uniqueUrls([listingUrl, ...aliases.aliases]);
  const applyRaw = inline(row?.applyUrl ?? row?.apply_url);
  return {
    sourceIndex: index,
    sourceRow: row,
    candidate_id: candidateId,
    run_id: runId,
    identityStatus,
    company,
    title,
    listingUrl,
    applyUrl: applyRaw ? requireHttpUrl(applyRaw, `source candidate ${index + 1} apply URL`) : null,
    urlAliases,
    source: inline(row?.source ?? row?.provider) || null,
    recommendedCvVariant: inline(row?.recommendedCvVariant ?? row?.recommended_cv_variant ?? row?.cvVariant) || null,
  };
}

function sourceContext(root, runId, expectedIntegrity = null) {
  const source = assertSourceRunIntegrity(root, runId, expectedIntegrity);
  const candidates = source.candidates.map((row, index) => normalizeSourceCandidate(row, runId, index));
  const ids = new Set();
  for (const candidate of candidates) {
    if (ids.has(candidate.candidate_id)) throw new Error(`Source run contains ambiguous candidate_id: ${candidate.candidate_id}`);
    ids.add(candidate.candidate_id);
  }
  return { ...source, normalizedCandidates: candidates };
}

function manifestCandidate(candidate, order) {
  return {
    order,
    candidate_id: candidate.candidate_id,
    run_id: candidate.run_id,
    identityStatus: candidate.identityStatus,
    company: candidate.company,
    title: candidate.title,
    listingUrl: candidate.listingUrl,
    applyUrl: candidate.applyUrl,
    urlAliases: candidate.urlAliases,
    source: candidate.source,
    recommendedCvVariant: candidate.recommendedCvVariant,
    sourceCandidateSha256: sha256Canonical(candidate.sourceRow),
    initialState: 'not_opened',
    artifacts: { cv: null, coverLetter: null, coverLetterText: null, combinedDocument: null },
  };
}

function immutableManifestPayload(manifest) {
  const { scopeHash, ...payload } = manifest;
  return payload;
}

function manifestScopeHash(manifest) {
  return sha256Canonical(immutableManifestPayload(manifest));
}

function initialPreflight() {
  return {
    status: 'unconfirmed',
    confirmedAt: null,
    confirmedScopeHash: null,
    invalidatedAt: null,
    invalidationReason: null,
    history: [],
  };
}

function initialSubmission() {
  return {
    status: 'unconfirmed',
    eventId: null,
    scopeHash: null,
    confirmedAt: null,
    trackerPath: null,
    trackerRow: null,
    evidence: null,
    updatedAt: null,
    history: [],
  };
}

function initialBatchState(manifest) {
  const createdAt = manifest.createdAt;
  return {
    schemaVersion: APPLICATION_BATCH_STATE_SCHEMA_VERSION,
    batchId: manifest.batchId,
    sourceRunId: manifest.sourceRunId,
    manifestScopeHash: manifest.scopeHash || manifestScopeHash(manifest),
    revision: 0,
    updatedAt: createdAt,
    preflight: initialPreflight(),
    lockRecoveryHistory: [],
    candidates: manifest.candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      run_id: candidate.run_id,
      listingUrl: candidate.listingUrl,
      artifacts: {
        cv: candidate.artifacts?.cv || null,
        coverLetter: candidate.artifacts?.coverLetter || null,
        coverLetterText: candidate.artifacts?.coverLetterText || null,
        combinedDocument: candidate.artifacts?.combinedDocument || null,
      },
      artifactHistory: [],
      abandonmentHistory: [],
      importVerification: manifest.legacyImport ? {
        status: 'legacy_unverified',
        verifiedAt: null,
        reason: 'Imported from an explicitly selected legacy queue row; fresh listing verification is required.',
      } : null,
      submission: initialSubmission(),
      formPreparation: null,
      formPreparationHistory: [],
      state: 'not_opened',
      updatedAt: createdAt,
      currentUrl: candidate.listingUrl,
      reason: 'Batch created; browser not opened.',
      history: [{
        seq: 0,
        from: null,
        to: 'not_opened',
        timestamp: createdAt,
        currentUrl: candidate.listingUrl,
        reason: 'Batch created; browser not opened.',
      }],
    })),
  };
}

function selectSourceCandidates(context, selectedCandidateIds, selectedUrls) {
  const ids = Array.isArray(selectedCandidateIds) ? selectedCandidateIds.map((id) => requireCandidateId(id)) : [];
  const urls = Array.isArray(selectedUrls)
    ? selectedUrls.map((url, index) => requireHttpUrl(url, `selected URL ${index + 1}`))
    : [];
  if (!ids.length && !urls.length) throw new Error('At least one explicit --candidate-id or --url selection is required');
  if (ids.length && urls.length) throw new Error('Use candidate IDs or URL selectors in one batch creation, not both');
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate selected candidate IDs are not allowed');
  if (new Set(urls).size !== urls.length) throw new Error('Duplicate selected URLs are not allowed');

  const selected = (ids.length ? ids : urls).map((selector) => {
    const matches = ids.length
      ? context.normalizedCandidates.filter((candidate) => candidate.candidate_id === selector)
      : context.normalizedCandidates.filter((candidate) => candidate.urlAliases.includes(selector));
    if (matches.length === 0) {
      throw new Error(ids.length
        ? `Unknown candidate ID in source run ${context.runId}: ${selector}`
        : `Selected URL is not a member of source run ${context.runId}: ${selector}`);
    }
    if (matches.length > 1) throw new Error(`Candidate selector is ambiguous in source run ${context.runId}: ${selector}`);
    if (matches[0].identityStatus === 'stable_prefix_workday') {
      throw new Error(`Candidate ${matches[0].candidate_id} carries a pre-fix Workday identity; create the batch from a corrected derived run (see output/identity-corrections/)`);
    }
    return matches[0];
  });
  const selectedIds = selected.map((candidate) => candidate.candidate_id);
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error('Duplicate selectors or aliases resolve to the same candidate');
  }
  return selected;
}

function companyDuplicateKey(value) {
  let name = String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  const suffix = /(?:^| )(?:gmbh co kg|gmbh|ag|se|oy|oyj|ab|aps|a s|as|bv|b v|nv|ltd|limited|llc|inc|corp|corporation|plc|sa|sas|srl|spa|kg)$/;
  while (suffix.test(name)) {
    const stripped = name.replace(suffix, '').trim();
    if (!stripped) break;
    name = stripped;
  }
  return normalizeTextKey(name);
}

function roleDuplicateKey(value) {
  const role = String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/\bc\+\+/g, 'cplusplus')
    .replace(/\bc#/g, 'csharp')
    .replace(/\bf#/g, 'fsharp')
    .replace(/\.net\b/g, 'dotnet');
  return normalizeTextKey(role);
}

function assertNoDuplicateApplications(root, selected) {
  const matches = (candidate, row) => companyDuplicateKey(candidate.company) === companyDuplicateKey(row.company)
    && roleDuplicateKey(candidate.title) === roleDuplicateKey(row.role ?? row.title);
  const refuse = (candidate, conflict) => {
    throw new Error(`Duplicate application for ${candidate.company} — ${candidate.title}: ${conflict}. To override, pass --allow-duplicate "<reason>" with an explicit reason.`);
  };
  const trackerPath = join(resolve(root), 'data', 'applications.md');
  if (existsSync(trackerPath)) {
    const states = loadCanonicalStates(new URL('./templates/states.yml', import.meta.url));
    const lines = readFileSync(trackerPath, 'utf8').split('\n');
    const columns = resolveColumns(lines);
    for (const line of lines) {
      const row = parseTrackerRow(line, columns);
      if (!row) continue;
      if (resolveCanonicalState(row.status, states) === 'Evaluated') continue;
      for (const candidate of selected) {
        if (matches(candidate, row)) refuse(candidate, `tracker row #${row.num} (${row.status}) in ${trackerPath}`);
      }
    }
  }
  const batchesRoot = applicationBatchRoot(root);
  if (!existsSync(batchesRoot)) return;
  for (const entry of readdirSync(batchesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const manifestPath = join(batchesRoot, entry.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    let state;
    let conflicts;
    try {
      const loaded = loadManifest(manifestPath, { root });
      manifest = loaded.manifest;
      conflicts = selected.filter((candidate) => manifest.candidates.some((row) => matches(candidate, row)));
      if (!conflicts.length) continue;
      state = existsSync(loaded.statePath) ? loadBatchState(manifestPath, { root }).state : null;
    } catch (error) {
      throw new Error(`Cannot check duplicates against application batch ${entry.name} at ${manifestPath}: ${error.message}. Inspect/repair or abandon that batch, or use --allow-duplicate "<reason>" if this candidate is intentionally a duplicate.`, { cause: error });
    }
    for (const candidate of conflicts) {
      if (manifest.candidates.some((row, index) => matches(candidate, row)
          && state?.candidates[index]?.state !== 'abandoned')) {
        refuse(candidate, `application batch ${manifest.batchId}`);
      }
    }
  }
}

export function createApplicationBatch({
  root = ROOT,
  sourceRunId,
  selectedCandidateIds = [],
  selectedUrls = [],
  batchId = null,
  legacyImport = null,
  allowDuplicateReason = null,
  now = new Date(),
} = {}) {
  const duplicateReason = allowDuplicateReason == null ? null : inline(allowDuplicateReason);
  if (duplicateReason !== null && !duplicateReason) throw new Error('--allow-duplicate requires a non-empty reason');
  const runId = requireSafeId(sourceRunId, 'source run ID');
  const source = sourceContext(root, runId);
  const selected = selectSourceCandidates(source, selectedCandidateIds, selectedUrls);
  const id = requireSafeId(batchId || generateBatchId(runId), 'batch ID');
  const batchesRoot = applicationBatchRoot(root);
  const batchDir = join(batchesRoot, id);
  if (existsSync(batchDir)) throw new Error(`EEXIST: Application-batch directory already exists: ${batchDir}`);
  if (duplicateReason === null) assertNoDuplicateApplications(root, selected);
  const manifest = {
    schemaVersion: APPLICATION_BATCH_MANIFEST_SCHEMA_VERSION,
    batchId: id,
    sourceRunId: runId,
    createdAt: now.toISOString(),
    expectedCandidateCount: selected.length,
    sourceIntegrity: source.integrity,
    ...(legacyImport ? { legacyImport } : {}),
    ...(duplicateReason !== null ? { duplicateOverride: { reason: duplicateReason } } : {}),
    candidates: selected.map((candidate, index) => manifestCandidate(candidate, index + 1)),
  };
  manifest.scopeHash = manifestScopeHash(manifest);
  validateManifest(manifest);

  mkdirSync(batchesRoot, { recursive: true });
  mkdirSync(batchDir);
  const manifestPath = join(batchDir, 'manifest.json');
  const statePath = join(batchDir, 'state.json');
  writeJsonExclusive(manifestPath, manifest);
  writeJsonExclusive(statePath, sanitizedBatchState(initialBatchState(manifest)));
  return { manifest, manifestPath, statePath };
}

function validateManifestCandidate(candidate, index, manifest) {
  const allowed = new Set([
    'order', 'candidate_id', 'run_id', 'identityStatus', 'company', 'title', 'listingUrl', 'applyUrl',
    'urlAliases', 'source', 'recommendedCvVariant', 'sourceCandidateSha256', 'initialState', 'artifacts',
  ]);
  assertKnownFields(candidate, allowed, 'manifest candidate');
  if (candidate.order !== index + 1) throw new Error('Manifest candidate order must be contiguous and stable');
  requireCandidateId(candidate.candidate_id, `manifest candidate ${index + 1} candidate_id`);
  if (candidate.run_id !== manifest.sourceRunId) throw new Error('Manifest candidate run_id mismatch');
  if (!['stable', 'legacy_derived'].includes(candidate.identityStatus)) throw new Error('Invalid candidate identity status');
  if ((candidate.identityStatus === 'stable' && candidate.candidate_id.startsWith('legacy_'))
      || (candidate.identityStatus === 'legacy_derived' && !candidate.candidate_id.startsWith('legacy_'))) {
    throw new Error('Candidate identity status and prefix do not match');
  }
  if (!inline(candidate.company) || !inline(candidate.title)) throw new Error('Manifest candidate lacks company or title');
  const listingUrl = requireHttpUrl(candidate.listingUrl, `manifest candidate ${index + 1} listing URL`);
  if (!Array.isArray(candidate.urlAliases) || !candidate.urlAliases.includes(listingUrl)) {
    throw new Error('Manifest candidate URL aliases must include the listing URL');
  }
  if (new Set(candidate.urlAliases).size !== candidate.urlAliases.length) throw new Error('Manifest candidate URL aliases contain duplicates');
  candidate.urlAliases.forEach((url, aliasIndex) => requireHttpUrl(url, `manifest candidate ${index + 1} alias ${aliasIndex + 1}`));
  if (candidate.applyUrl != null) requireHttpUrl(candidate.applyUrl, `manifest candidate ${index + 1} apply URL`);
  if (!/^sha256:[a-f0-9]{64}$/.test(candidate.sourceCandidateSha256)) throw new Error('Invalid source candidate hash');
  if (candidate.initialState !== 'not_opened') throw new Error('Manifest candidates must start at not_opened');
  assertKnownFields(candidate.artifacts, new Set(['cv', 'coverLetter', 'coverLetterText', 'combinedDocument']), 'manifest artifact binding');
  for (const [key, type] of [
    ['cv', 'cv'], ['coverLetter', 'cover_letter'], ['coverLetterText', 'cover_letter_text'],
    ['combinedDocument', 'combined_document'],
  ]) {
    if (candidate.artifacts[key] != null) validateArtifactRecord(candidate.artifacts[key], { root: ROOT, expectedType: type });
  }
}

function validateManifestV2(manifest) {
  assertKnownFields(manifest, new Set([
    'schemaVersion', 'batchId', 'sourceRunId', 'createdAt', 'expectedCandidateCount',
    'sourceIntegrity', 'legacyImport', 'duplicateOverride', 'candidates', 'scopeHash',
  ]), 'application-batch manifest');
  if (manifest.duplicateOverride != null) {
    assertKnownFields(manifest.duplicateOverride, new Set(['reason']), 'duplicate override');
    if (typeof manifest.duplicateOverride.reason !== 'string' || !inline(manifest.duplicateOverride.reason)) {
      throw new Error('Duplicate override requires a non-empty reason');
    }
  }
  requireSafeId(manifest.batchId, 'manifest batch ID');
  requireSafeId(manifest.sourceRunId, 'manifest source run ID');
  if (!Array.isArray(manifest.candidates) || !manifest.candidates.length) throw new Error('Manifest must contain at least one candidate');
  if (manifest.expectedCandidateCount !== manifest.candidates.length) throw new Error('Manifest candidate count mismatch');
  assertKnownFields(manifest.sourceIntegrity, new Set(['algorithm', 'manifest', 'candidates']), 'source integrity');
  if (manifest.sourceIntegrity?.algorithm !== 'sha256') throw new Error('Unsupported source integrity algorithm');
  for (const key of ['manifest', 'candidates']) {
    assertKnownFields(manifest.sourceIntegrity?.[key], new Set(['filename', 'sha256', 'size']), `source ${key} integrity`);
    if (manifest.sourceIntegrity?.[key]?.filename !== `${key}.json`) throw new Error(`Invalid source ${key} filename`);
    if (!/^sha256:[a-f0-9]{64}$/.test(manifest.sourceIntegrity?.[key]?.sha256)
        || !Number.isInteger(manifest.sourceIntegrity?.[key]?.size)) {
      throw new Error(`Invalid source ${key} integrity record`);
    }
  }
  if (manifest.legacyImport != null) {
    assertKnownFields(manifest.legacyImport, new Set([
      'schemaVersion', 'queueFile', 'queueSha256', 'queueSize', 'importedAt', 'selectedRows',
    ]), 'legacy queue import');
    if (manifest.legacyImport.schemaVersion !== 1) throw new Error('Unsupported legacy queue import schema version');
    if (!isAbsolute(manifest.legacyImport.queueFile)) throw new Error('Legacy queue audit path must be absolute');
    if (!/^sha256:[a-f0-9]{64}$/.test(manifest.legacyImport.queueSha256)
        || !Number.isInteger(manifest.legacyImport.queueSize)) throw new Error('Invalid legacy queue audit hash');
    if (!Number.isFinite(Date.parse(manifest.legacyImport.importedAt))) throw new Error('Invalid legacy queue import timestamp');
    if (!Array.isArray(manifest.legacyImport.selectedRows) || !manifest.legacyImport.selectedRows.length) {
      throw new Error('Legacy queue import must retain explicit selected rows');
    }
    manifest.legacyImport.selectedRows.forEach((row) => {
      assertKnownFields(row, new Set(['rowNumber', 'candidate_id', 'selectedUrl']), 'legacy selected queue row');
      if (!Number.isInteger(row.rowNumber) || row.rowNumber < 2) throw new Error('Invalid legacy queue row number');
      requireCandidateId(row.candidate_id, 'legacy selected queue candidate ID');
      requireHttpUrl(row.selectedUrl, 'legacy selected queue URL');
    });
  }
  const ids = new Set();
  const urls = new Set();
  manifest.candidates.forEach((candidate, index) => {
    validateManifestCandidate(candidate, index, manifest);
    if (ids.has(candidate.candidate_id)) throw new Error(`Manifest contains duplicate candidate ID: ${candidate.candidate_id}`);
    if (urls.has(candidate.listingUrl)) throw new Error(`Manifest contains duplicate candidate URL: ${candidate.listingUrl}`);
    ids.add(candidate.candidate_id);
    urls.add(candidate.listingUrl);
  });
  if (manifest.scopeHash !== manifestScopeHash(manifest)) throw new Error('Application-batch manifest scope hash mismatch');
  return manifest;
}

function normalizeManifestV1(manifest) {
  assertKnownFields(manifest, new Set([
    'schemaVersion', 'batchId', 'sourceRunId', 'createdAt', 'expectedCandidateCount', 'candidates',
  ]), 'Phase 1 manifest');
  if (!Array.isArray(manifest.candidates) || !manifest.candidates.length) throw new Error('Phase 1 manifest has no candidates');
  const normalized = {
    schemaVersion: 1,
    batchId: requireSafeId(manifest.batchId, 'manifest batch ID'),
    sourceRunId: requireSafeId(manifest.sourceRunId, 'manifest source run ID'),
    createdAt: manifest.createdAt,
    expectedCandidateCount: manifest.expectedCandidateCount,
    sourceIntegrity: null,
    legacySchema: true,
    candidates: manifest.candidates.map((candidate, index) => {
      assertKnownFields(candidate, new Set([
        'order', 'company', 'title', 'listingUrl', 'applyUrl', 'source', 'initialState', 'cv', 'coverLetter',
      ]), 'Phase 1 manifest candidate');
      const listingUrl = requireHttpUrl(candidate.listingUrl, `Phase 1 candidate ${index + 1} listing URL`);
      return {
        order: index + 1,
        candidate_id: deriveCandidateId({ url: listingUrl, applyUrl: candidate.applyUrl }, { legacy: true }),
        run_id: manifest.sourceRunId,
        identityStatus: 'legacy_derived',
        company: inline(candidate.company),
        title: inline(candidate.title),
        listingUrl,
        applyUrl: candidate.applyUrl ? requireHttpUrl(candidate.applyUrl, 'Phase 1 apply URL') : null,
        urlAliases: uniqueUrls([listingUrl, candidate.applyUrl]),
        source: candidate.source || null,
        recommendedCvVariant: candidate.cv || null,
        sourceCandidateSha256: null,
        initialState: 'not_opened',
        artifacts: { cv: null, coverLetter: null, coverLetterText: null, combinedDocument: null },
      };
    }),
  };
  if (normalized.expectedCandidateCount !== normalized.candidates.length) throw new Error('Phase 1 manifest candidate count mismatch');
  normalized.scopeHash = sha256Canonical({
    legacySchemaVersion: 1,
    batchId: normalized.batchId,
    sourceRunId: normalized.sourceRunId,
    createdAt: normalized.createdAt,
    candidates: normalized.candidates,
  });
  return normalized;
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Application-batch manifest must be an object');
  if (manifest.schemaVersion === 1) return normalizeManifestV1(manifest);
  if (manifest.schemaVersion === APPLICATION_BATCH_MANIFEST_SCHEMA_VERSION) return validateManifestV2(manifest);
  if (Number.isInteger(manifest.schemaVersion) && manifest.schemaVersion > APPLICATION_BATCH_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported future application-batch manifest schema version: ${manifest.schemaVersion}`);
  }
  throw new Error(`Unsupported application-batch manifest schema version: ${manifest.schemaVersion}`);
}

function resolveManifestPath(root, manifestPath) {
  if (!manifestPath) throw new Error('Explicit --manifest path is required');
  const batchesRoot = applicationBatchRoot(root);
  const absolute = resolve(root, manifestPath);
  const rel = relative(batchesRoot, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || basename(absolute) !== 'manifest.json') {
    throw new Error('Manifest must be output/application-batches/<batch-id>/manifest.json');
  }
  const segments = rel.split(/[\\/]/).filter(Boolean);
  if (segments.length !== 2 || segments[1] !== 'manifest.json') {
    throw new Error('Manifest must be directly inside one application-batch directory');
  }
  return absolute;
}

export function loadManifest(manifestPath, { root = ROOT } = {}) {
  const absolute = resolveManifestPath(root, manifestPath);
  if (!existsSync(absolute)) throw new Error(`Application-batch manifest not found: ${absolute}`);
  const rawManifest = readJson(absolute, 'application-batch manifest');
  const manifest = validateManifest(rawManifest);
  if (basename(dirname(absolute)) !== manifest.batchId) throw new Error('Manifest batch ID does not match its directory name');
  return { manifest, rawManifest, manifestPath: absolute, statePath: join(dirname(absolute), 'state.json') };
}

function normalizeStateV1(state, manifest) {
  assertKnownFields(state, new Set([
    'schemaVersion', 'batchId', 'sourceRunId', 'updatedAt', 'preflight', 'candidates',
  ]), 'Phase 1 state');
  assertKnownFields(state.preflight || {}, new Set([
    'confirmedAt', 'confirmedBatchId', 'confirmedCandidateCount', 'confirmedListingUrls', 'confirmedCandidates',
  ]), 'Phase 1 preflight');
  const normalized = initialBatchState(manifest);
  normalized.updatedAt = state.updatedAt || normalized.updatedAt;
  normalized.candidates = state.candidates.map((candidateState, index) => {
    assertKnownFields(candidateState, new Set([
      'listingUrl', 'state', 'updatedAt', 'currentUrl', 'reason', 'history',
    ]), 'Phase 1 state candidate');
    const manifestCandidateRow = manifest.candidates[index];
    const history = candidateState.history.map((event, eventIndex) => {
      assertKnownFields(event, new Set(['state', 'timestamp', 'currentUrl', 'reason']), 'Phase 1 state history event');
      return {
        seq: eventIndex,
        from: eventIndex === 0 ? null : candidateState.history[eventIndex - 1].state,
        to: event.state,
        timestamp: event.timestamp,
        currentUrl: event.currentUrl,
        reason: event.reason,
      };
    });
    return {
      candidate_id: manifestCandidateRow.candidate_id,
      run_id: manifest.sourceRunId,
      listingUrl: manifestCandidateRow.listingUrl,
      artifacts: { cv: null, coverLetter: null, coverLetterText: null, combinedDocument: null },
      artifactHistory: [],
      abandonmentHistory: [],
      importVerification: null,
      submission: initialSubmission(),
      state: candidateState.state,
      updatedAt: candidateState.updatedAt,
      currentUrl: candidateState.currentUrl,
      reason: candidateState.reason,
      history,
    };
  });
  normalized.preflight = {
    ...initialPreflight(),
    invalidatedAt: normalized.updatedAt,
    invalidationReason: 'Phase 1 confirmation was not hash-bound and must be repeated.',
  };
  return normalized;
}

function validatePreflight(preflight) {
  assertKnownFields(preflight, new Set([
    'status', 'confirmedAt', 'confirmedScopeHash', 'invalidatedAt', 'invalidationReason', 'history',
  ]), 'preflight');
  if (!['unconfirmed', 'confirmed', 'invalidated'].includes(preflight.status)) throw new Error('Invalid preflight status');
  if (!Array.isArray(preflight.history)) throw new Error('Preflight history must be an array');
  preflight.history.forEach((event) => assertKnownFields(event, new Set([
    'event', 'timestamp', 'scopeHash', 'previousConfirmedAt', 'previousScopeHash', 'reason',
  ]), 'preflight history event'));
  if (preflight.status === 'confirmed' && (!preflight.confirmedAt || !/^sha256:[a-f0-9]{64}$/.test(preflight.confirmedScopeHash))) {
    throw new Error('Confirmed preflight is missing its scope hash');
  }
}

function normalizeStateV2(state) {
  const normalized = structuredClone(state);
  normalized.schemaVersion = APPLICATION_BATCH_STATE_SCHEMA_VERSION;
  normalized.migratedFromSchemaVersion = 2;
  normalized.lockRecoveryHistory ??= [];
  for (const candidate of normalized.candidates || []) {
    candidate.formPreparation ??= null;
    candidate.formPreparationHistory ??= [];
    candidate.abandonmentHistory ??= [];
  }
  return normalized;
}

function normalizeStateV3(state) {
  const normalized = structuredClone(state);
  normalized.schemaVersion = APPLICATION_BATCH_STATE_SCHEMA_VERSION;
  normalized.migratedFromSchemaVersion = 3;
  normalized.lockRecoveryHistory ??= [];
  for (const candidate of normalized.candidates || []) {
    candidate.abandonmentHistory ??= [];
    candidate.formPreparationHistory ??= [];
  }
  return normalized;
}

function validateFormPreparation(value) {
  if (value == null) return;
  assertKnownFields(value, new Set([
    'schemaVersion', 'inspectedAt', 'reviewedAt', 'currentUrl', 'formFingerprint',
    'requiredFieldCount', 'filledFields', 'committedSelections', 'uploadedArtifacts',
    'unresolvedFields', 'validationErrors', 'userActionRequired', 'finalAction',
    'reviewComplete', 'evidenceHash', 'passId', 'resumeMode', 'attemptLedger',
    'answerRecords', 'browserOpenRequired', 'passBudget', 'browserSession',
    'operationalArtifacts', 'uploadTopology', 'captcha',
    'progression',
    'reasoning', 'semanticVerification', 'deterministicReviewComplete',
  ]), 'form preparation');
  if (![1, 2, 3].includes(value.schemaVersion)) throw new Error('Unsupported form preparation schema version');
  for (const key of ['filledFields', 'committedSelections', 'uploadedArtifacts', 'unresolvedFields', 'validationErrors']) {
    if (!Array.isArray(value[key])) throw new Error(`Form preparation ${key} must be an array`);
  }
  if (value.schemaVersion === 2 && (!Array.isArray(value.attemptLedger) || !Array.isArray(value.answerRecords))) throw new Error('Operational form preparation ledger is invalid');
  if (value.schemaVersion === 3) {
    if (!Array.isArray(value.attemptLedger) || !Array.isArray(value.answerRecords)) throw new Error('Operational form preparation ledger is invalid');
    assertKnownFields(value.reasoning || {}, new Set([
      'schemaVersion', 'provider', 'model', 'calls', 'limits', 'semanticResolutions',
      'rejectedResolutions', 'preparedAnswerSummary',
    ]), 'form preparation reasoning');
    if (value.reasoning?.schemaVersion !== 1
        || !Array.isArray(value.reasoning?.semanticResolutions)
        || !Array.isArray(value.reasoning?.rejectedResolutions)
        || !Array.isArray(value.reasoning?.preparedAnswerSummary)) {
      throw new Error('Invalid form preparation reasoning evidence');
    }
    assertKnownFields(value.reasoning.calls || {}, new Set(['fallback', 'verifier', 'total']), 'reasoning call counters');
    assertKnownFields(value.reasoning.limits || {}, new Set([
      'fallbackCalls', 'verifierCalls', 'totalCalls', 'repairCycles', 'timeoutMs',
    ]), 'reasoning call limits');
    const counters = value.reasoning.calls || {};
    const limits = value.reasoning.limits || {};
    if (![counters.fallback, counters.verifier, counters.total].every((item) => Number.isInteger(item) && item >= 0)
        || ![limits.fallbackCalls, limits.verifierCalls, limits.totalCalls, limits.repairCycles, limits.timeoutMs]
          .every((item) => Number.isInteger(item) && item >= 0)
        || limits.fallbackCalls > 3 || limits.verifierCalls > 1 || limits.totalCalls > 4
        || limits.repairCycles > 1 || limits.timeoutMs < 1 || limits.timeoutMs > 30000
        || counters.fallback > 3 || counters.verifier > 1 || counters.total > 4
        || counters.fallback > limits.fallbackCalls || counters.verifier > limits.verifierCalls
        || counters.total > limits.totalCalls) {
      throw new Error('Reasoning call counters or limits exceed the safety ceiling');
    }
    for (const entry of value.reasoning.semanticResolutions) {
      assertKnownFields(entry, new Set([
        'schemaVersion', 'batchId', 'candidateId', 'applicationFormId', 'resolutionKey',
        'questionDigest', 'controlType', 'kind', 'optionsDigest', 'annotation',
        'provider', 'model', 'requestDigest', 'responseDigest',
      ]), 'semantic resolution record');
      if (entry.schemaVersion !== 1 || !['semantic_classification', 'option_mapping', 'narrative_routing'].includes(entry.kind)
          || !String(entry.resolutionKey || '').startsWith('resolution:')) {
        throw new Error('Invalid semantic resolution record');
      }
      const annotationFields = entry.kind === 'semantic_classification'
        ? new Set(['semantic'])
        : entry.kind === 'option_mapping'
          ? new Set(['canonicalValueHash', 'selectedVisibleOption', 'noSemanticMatch'])
          : new Set(['templateId', 'topicIds', 'evidenceIds', 'evidenceBindings']);
      assertKnownFields(entry.annotation || {}, annotationFields, 'semantic resolution annotation');
      if (entry.kind === 'semantic_classification'
          && !GENERIC_APPLICATION_CLASSIFICATION_SEMANTICS.includes(entry.annotation.semantic)) {
        throw new Error('Invalid semantic classification resolution');
      }
      if (entry.kind === 'option_mapping') {
        const refused = entry.annotation.noSemanticMatch === true;
        const selected = typeof entry.annotation.selectedVisibleOption === 'string';
        if (refused === selected || (entry.annotation.noSemanticMatch !== undefined && !refused)) {
          throw new Error('Invalid option mapping resolution disposition');
        }
      }
      if (entry.kind === 'narrative_routing') {
        if (!Array.isArray(entry.annotation.topicIds) || !Array.isArray(entry.annotation.evidenceIds)
            || !Array.isArray(entry.annotation.evidenceBindings)) {
          throw new Error('Invalid narrative routing resolution');
        }
        for (const binding of entry.annotation.evidenceBindings) {
          assertKnownFields(binding, new Set([
            'configuredEvidenceId', 'evidenceIdentity', 'evidenceHash', 'sourceHash',
          ]), 'narrative reasoning evidence binding');
        }
      }
    }
    for (const entry of value.reasoning.rejectedResolutions) {
      assertKnownFields(entry, new Set([
        'resolutionKey', 'kind', 'reasonCode', 'detailDigest',
      ]), 'rejected semantic resolution');
    }
    for (const entry of value.reasoning.preparedAnswerSummary) {
      assertKnownFields(entry, new Set([
        'resolutionKey', 'stableFieldId', 'normalizedQuestion', 'category', 'semantic',
        'committedValue', 'committedValueHash', 'selectedVisibleLabel', 'evidenceIds',
        'stepFingerprint',
      ]), 'prepared answer summary');
      if (!String(entry.resolutionKey || '').startsWith('resolution:') || !Array.isArray(entry.evidenceIds)) {
        throw new Error('Invalid prepared answer summary');
      }
    }
    assertKnownFields(value.semanticVerification || {}, new Set([
      'disposition', 'triggerReasons', 'findings', 'requestDigest', 'responseDigest', 'repair',
    ]), 'semantic verification evidence');
    if (!['not_required', 'pending', 'passed', 'review_required'].includes(value.semanticVerification?.disposition)
        || !Array.isArray(value.semanticVerification?.triggerReasons)
        || !Array.isArray(value.semanticVerification?.findings)) {
      throw new Error('Invalid semantic verification disposition');
    }
    assertKnownFields(value.semanticVerification?.repair || {}, new Set([
      'attempted', 'outcome', 'resolutionKey',
    ]), 'semantic verification repair');
    for (const finding of value.semanticVerification.findings) {
      assertKnownFields(finding, new Set([
        'code', 'resolutionKey', 'message', 'detailDigest', 'live', 'repair',
      ]), 'semantic verification finding');
      if (finding.repair != null) {
        const allowedRepair = finding.repair.kind === 'semantic_classification'
          ? new Set(['resolutionKey', 'kind', 'semantic'])
          : finding.repair.kind === 'option_mapping'
            ? new Set(['resolutionKey', 'kind', 'canonicalValueHash', 'selectedVisibleOption'])
            : finding.repair.kind === 'narrative_routing'
              ? new Set(['resolutionKey', 'kind', 'templateId', 'topicIds', 'evidenceIds'])
              : null;
        if (!allowedRepair) throw new Error('Unsupported semantic verifier repair kind');
        assertKnownFields(finding.repair, allowedRepair, 'semantic verifier repair annotation');
      }
    }
    if (typeof value.deterministicReviewComplete !== 'boolean') {
      throw new Error('Form preparation deterministic review disposition is missing');
    }
  }
  if (!Number.isInteger(value.requiredFieldCount) || value.requiredFieldCount < 0) {
    throw new Error('Form preparation required field count is invalid');
  }
  assertKnownFields(value.finalAction || {}, new Set([
    'detected', 'label', 'semanticClass', 'activated',
  ]), 'form preparation final action');
  if (value.uploadTopology != null) {
    assertKnownFields(value.uploadTopology, new Set(['mode', 'reason', 'fields']), 'form preparation upload topology');
    if (!['none', 'separate', 'single_combined', 'ambiguous'].includes(value.uploadTopology.mode) || !Array.isArray(value.uploadTopology.fields)) {
      throw new Error('Invalid form preparation upload topology');
    }
  }
  if (value.captcha != null) {
    assertKnownFields(value.captcha, new Set([
      'classification', 'type', 'present', 'completed', 'manualActionRequired',
      'formAccessible', 'observedBlockingStatus', 'evidence',
    ]), 'form preparation captcha');
    if (!['absent', 'passive_invisible', 'active_non_blocking', 'active_blocking', 'uncertain'].includes(value.captcha.classification)) {
      throw new Error('Invalid form preparation CAPTCHA classification');
    }
    assertKnownFields(value.captcha.evidence || {}, new Set([
      'visibleChallenge', 'blockingOverlay', 'totalFields', 'accessibleFields',
      'requiredDisabledFields', 'scriptCount', 'elementCount', 'textSignal',
    ]), 'form preparation captcha evidence');
  }
  if (value.progression != null) {
    assertKnownFields(value.progression, new Set([
      'stepsAdvanced', 'transitions', 'visitedFingerprints', 'maxTransitions',
      'transitionTimeoutMs', 'deadlineReached', 'progressionSubmits',
    ]), 'form preparation progression');
    if (!Number.isInteger(value.progression.stepsAdvanced) || value.progression.stepsAdvanced < 0
        || value.progression.stepsAdvanced > 8 || !Array.isArray(value.progression.transitions)
        || !Array.isArray(value.progression.visitedFingerprints)) {
      throw new Error('Invalid form preparation progression evidence');
    }
  }
  if (value.reviewComplete && (value.unresolvedFields.length || value.validationErrors.length
      || value.userActionRequired || value.finalAction?.detected !== true || value.finalAction?.activated !== false
      || (value.schemaVersion === 3 && (!value.deterministicReviewComplete
        || !['not_required', 'passed'].includes(value.semanticVerification?.disposition))))) {
    throw new Error('Completed form preparation contains unresolved or unsafe evidence');
  }
}

export function appendFormPreparationEvidence(candidateState, formPreparation) {
  formPreparation = sanitizedPreparation(formPreparation);
  validateFormPreparation(formPreparation);
  candidateState.formPreparation = formPreparation;
  candidateState.formPreparationHistory ??= [];
  if (candidateState.formPreparationHistory.at(-1)?.evidenceHash !== formPreparation.evidenceHash) {
    candidateState.formPreparationHistory.push(structuredClone(formPreparation));
  }
  return candidateState.formPreparationHistory;
}


function validateState(state, manifest) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Batch state must be an object');
  if (state.schemaVersion === 1) return validateState(normalizeStateV1(state, manifest), manifest);
  state.lockRecoveryHistory ??= [];
  for (const candidate of state.candidates || []) candidate.formPreparationHistory ??= [];
  if (state.schemaVersion === 2) return validateState(normalizeStateV2(state), manifest);
  if (state.schemaVersion === 3) return validateState(normalizeStateV3(state), manifest);
  if (state.schemaVersion === 4) {
    state = structuredClone(state);
    state.schemaVersion = APPLICATION_BATCH_STATE_SCHEMA_VERSION;
    state.migratedFromSchemaVersion ??= 4;
  }
  if (state.schemaVersion !== APPLICATION_BATCH_STATE_SCHEMA_VERSION) {
    if (Number.isInteger(state.schemaVersion) && state.schemaVersion > APPLICATION_BATCH_STATE_SCHEMA_VERSION) {
      throw new Error(`Unsupported future application-batch state schema version: ${state.schemaVersion}`);
    }
    throw new Error(`Unsupported application-batch state schema version: ${state.schemaVersion}`);
  }
  assertKnownFields(state, new Set([
    'schemaVersion', 'migratedFromSchemaVersion', 'batchId', 'sourceRunId', 'manifestScopeHash', 'revision', 'updatedAt', 'preflight', 'candidates', 'lockRecoveryHistory',
  ]), 'batch state');
  if (state.batchId !== manifest.batchId || state.sourceRunId !== manifest.sourceRunId) throw new Error('Batch state identity mismatch');
  if (state.manifestScopeHash !== manifest.scopeHash) throw new Error('Batch state manifest scope hash mismatch');
  if (!Array.isArray(state.lockRecoveryHistory)) throw new Error('Lock recovery history must be an array');
  state.lockRecoveryHistory.forEach((event) => assertKnownFields(event, new Set([
    'timestamp', 'batchId', 'candidateId', 'previousOwner', 'reason', 'claimDisposition',
  ]), 'lock recovery history event'));
  if (!Number.isInteger(state.revision) || state.revision < 0) throw new Error('Invalid batch state revision');
  validatePreflight(state.preflight);
  if (!Array.isArray(state.candidates) || state.candidates.length !== manifest.candidates.length) throw new Error('Batch state candidate set mismatch');
  state.candidates.forEach((candidateState, index) => {
    assertKnownFields(candidateState, new Set([
      'candidate_id', 'run_id', 'listingUrl', 'artifacts', 'artifactHistory', 'state', 'updatedAt',
      'currentUrl', 'reason', 'history', 'importVerification', 'submission',
      'formPreparation', 'formPreparationHistory',
      'abandonmentHistory',
      'humanAction',
    ]), 'candidate state');
    const candidate = manifest.candidates[index];
    if (candidateState.candidate_id !== candidate.candidate_id || candidateState.run_id !== manifest.sourceRunId
        || sanitizeUrl(candidateState.listingUrl) !== sanitizeUrl(candidate.listingUrl)) throw new Error('Batch state candidate identity or order mismatch');
    assertKnownFields(candidateState.artifacts, new Set(['cv', 'coverLetter', 'coverLetterText', 'combinedDocument']), 'candidate artifacts');
    if (!Array.isArray(candidateState.artifactHistory)) throw new Error('Artifact history must be an array');
    if (!Array.isArray(candidateState.abandonmentHistory)) throw new Error('Abandonment history must be an array');
    candidateState.abandonmentHistory.forEach((event) => assertKnownFields(event, new Set([
      'timestamp', 'previousState', 'newState', 'reason', 'claimRelease',
    ]), 'abandonment history event'));
    if (!Array.isArray(candidateState.formPreparationHistory)) throw new Error('Form preparation history must be an array');
    for (const preparation of candidateState.formPreparationHistory) {
      validateFormPreparation(preparation);
    }
    candidateState.artifactHistory.forEach((event) => assertKnownFields(event, new Set([
      'event', 'artifactType', 'timestamp', 'previousSha256', 'sha256', 'intendedFilename',
    ]), 'artifact history event'));
    if (candidateState.importVerification != null) {
      assertKnownFields(candidateState.importVerification, new Set(['status', 'verifiedAt', 'reason']), 'import verification');
      if (!['legacy_unverified', 'fresh_verified'].includes(candidateState.importVerification.status)) {
        throw new Error('Invalid legacy import verification status');
      }
      if (candidateState.importVerification.status === 'fresh_verified' && !candidateState.importVerification.verifiedAt) {
        throw new Error('Fresh legacy import verification is missing its timestamp');
      }
    }
    const submission = candidateState.submission || initialSubmission();
    assertKnownFields(submission, new Set([
      'status', 'eventId', 'scopeHash', 'confirmedAt', 'trackerPath', 'trackerRow', 'evidence', 'updatedAt', 'history',
    ]), 'submission confirmation');
    if (!['unconfirmed', 'confirmed_pending_tracker', 'tracker_applied'].includes(submission.status)) {
      throw new Error('Invalid submission confirmation status');
    }
    if (!Array.isArray(submission.history)) throw new Error('Submission history must be an array');
    submission.history.forEach((event) => assertKnownFields(event, new Set([
      'status', 'eventId', 'scopeHash', 'timestamp', 'trackerPath', 'trackerRow', 'evidence',
    ]), 'submission history event'));
    if (submission.status !== 'unconfirmed' && (!submission.eventId || !submission.confirmedAt
        || !submission.trackerPath || !Number.isInteger(submission.trackerRow) || !submission.evidence)) {
      throw new Error('Submission confirmation record is incomplete');
    }
    if (submission.scopeHash != null && (!/^sha256:[a-f0-9]{64}$/.test(submission.scopeHash)
        || submission.scopeHash !== `sha256:${String(submission.eventId || '').replace(/^submission_v1_/, '')}`)) {
      throw new Error('Submission confirmation scope hash is invalid');
    }
    if (submission.status !== 'unconfirmed' && state.migratedFromSchemaVersion !== 2 && !submission.scopeHash) {
      throw new Error('Phase 4 submission confirmation is missing its scope hash');
    }
    candidateState.submission = submission;
    validateFormPreparation(candidateState.formPreparation);
    if (candidateState.humanAction != null) validateHumanAction(candidateState.humanAction, candidateState.candidate_id);
    if (!EXECUTION_STATES.includes(candidateState.state)) throw new Error(`Invalid stored execution state: ${candidateState.state}`);
    if (!Array.isArray(candidateState.history) || !candidateState.history.length) throw new Error('Batch state history is missing');
    let previous = null;
    let previousTimestamp = 0;
    candidateState.history.forEach((event, eventIndex) => {
      assertKnownFields(event, new Set(['seq', 'from', 'to', 'timestamp', 'currentUrl', 'reason', 'details', 'humanAction']), 'state history event');
      if (event.seq !== eventIndex || event.from !== previous) throw new Error('Batch state history sequence is invalid');
      if (!EXECUTION_STATES.includes(event.to)) throw new Error(`Invalid history execution state: ${event.to}`);
      if (eventIndex === 0) {
        if (event.to !== 'not_opened') throw new Error('Batch state history must begin at not_opened');
      } else if (!TRANSITIONS[event.from]?.has(event.to)) {
        throw new Error(`Invalid stored state transition: ${event.from} -> ${event.to}`);
      }
      const timestamp = Date.parse(event.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < previousTimestamp) throw new Error('Batch state history timestamps are invalid');
      requireHttpUrl(event.currentUrl, 'state history current URL');
      if (event.to === 'human_action_required') {
        validateHumanAction(event.humanAction, candidateState.candidate_id);
        if (event.details != null || event.currentUrl !== event.humanAction.currentUrl
            || event.timestamp !== event.humanAction.timestamp
            || event.reason !== `Human action required: ${event.humanAction.cause}.`) {
          throw new Error('Invalid human action history record');
        }
      } else if (event.humanAction != null) throw new Error('Human action history record requires a pause transition');
      if (event.from === 'human_action_required' && event.to === 'actual_form_reached') {
        validateHumanActionRevalidation(event.details, candidateState.candidate_id);
      }
      if (!inline(event.reason)) throw new Error('State history reason is missing');
      previous = event.to;
      previousTimestamp = timestamp;
    });
    const last = candidateState.history.at(-1);
    if (candidateState.state === 'human_action_required'
        && JSON.stringify(candidateState.humanAction) !== JSON.stringify(last.humanAction)) {
      throw new Error('Candidate human action does not match its final history event');
    }
    if (candidateState.state !== last.to || candidateState.currentUrl !== last.currentUrl || candidateState.reason !== last.reason) {
      throw new Error('Candidate state does not match its final history event');
    }
  });
  return state;
}

export function loadBatchState(manifestPath, { root = ROOT } = {}) {
  const loaded = loadManifest(manifestPath, { root });
  if (!existsSync(loaded.statePath)) throw new Error(`Batch state not found: ${loaded.statePath}`);
  const state = validateState(readJson(loaded.statePath, 'batch state'), loaded.manifest);
  return { ...loaded, state };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

const CURRENT_PROCESS_START_KEY = `${process.pid}:${Math.round(Date.now() - process.uptime() * 1000)}`;

function defaultProcessStartKey(pid) {
  return pid === process.pid ? CURRENT_PROCESS_START_KEY : null;
}

function readLockOwnerIfValid(ownerPath) {
  try {
    const owner = readJson(ownerPath, 'application-batch execution lock');
    return owner && typeof owner.token === 'string' ? owner : null;
  } catch {
    return null;
  }
}

export function acquireBatchExecutionLock(manifestPath, {
  root = ROOT,
  now = new Date(),
  staleAfterMs = 15 * 60 * 1000,
  candidateId = null,
  operation = 'batch_mutation',
  processStartKeyForPid = defaultProcessStartKey,
} = {}) {
  const loaded = loadManifest(manifestPath, { root });
  const lockPath = join(dirname(loaded.manifestPath), '.execution.lock');
  const recoveryPath = `${lockPath}.recovery`;
  const token = randomBytes(16).toString('hex');
  const ownerPath = join(lockPath, 'owner.json');
  const normalizedCandidateId = candidateId == null ? null : requireCandidateId(candidateId);
  let staleRecovered = false;
  let staleRecovery = null;

  const createLock = () => {
    let created = false;
    try {
      mkdirSync(lockPath);
      created = true;
      writeJsonExclusive(ownerPath, {
        schemaVersion: 2,
        batchId: loaded.manifest.batchId,
        candidateId: normalizedCandidateId,
        operation: inline(operation) || 'batch_mutation',
        token,
        hostname: hostname(),
        pid: process.pid,
        processStartKey: CURRENT_PROCESS_START_KEY,
        acquiredAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
      });
      return true;
    } catch (error) {
      if (created) rmSync(lockPath, { recursive: true, force: true });
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };

  if (!createLock()) {
    let ownsRecovery = false;
    try {
      try {
        mkdirSync(recoveryPath);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const recoveryAgeMs = Math.max(0, now.getTime() - statSync(recoveryPath).mtimeMs);
        if (recoveryAgeMs < staleAfterMs) {
          throw new Error(`Application batch ${loaded.manifest.batchId} stale-lock recovery is already running`);
        }
        rmSync(recoveryPath, { recursive: true, force: true });
        mkdirSync(recoveryPath);
      }
      ownsRecovery = true;
      const lockStat = statSync(lockPath);
      const firstOwner = readLockOwnerIfValid(ownerPath);
      const ageMs = Math.max(0, now.getTime() - lockStat.mtimeMs);
      const live = firstOwner ? processIsAlive(firstOwner.pid) : false;
      const observedStartKey = live ? processStartKeyForPid(firstOwner.pid) : null;
      const pidReused = Boolean(live && firstOwner?.processStartKey && observedStartKey
        && firstOwner.processStartKey !== observedStartKey);
      const recoverable = firstOwner ? (!live || pidReused) : ageMs >= staleAfterMs;
      if (!recoverable) throw new Error(`Application batch ${loaded.manifest.batchId} is already executing`);

      const secondOwner = readLockOwnerIfValid(ownerPath);
      if ((firstOwner?.token || null) !== (secondOwner?.token || null)) {
        throw new Error(`Application batch ${loaded.manifest.batchId} execution lock changed during stale recovery`);
      }
      const stalePath = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
      renameSync(lockPath, stalePath);
      rmSync(stalePath, { recursive: true, force: true });
      staleRecovered = true;
      staleRecovery = {
        timestamp: now.toISOString(),
        batchId: loaded.manifest.batchId,
        candidateId: normalizedCandidateId,
        previousOwner: firstOwner,
        reason: pidReused ? 'owner_pid_reused' : firstOwner ? 'owner_process_gone' : 'owner_record_missing_and_lock_expired',
      };
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error(`Application batch ${loaded.manifest.batchId} is already executing`);
      throw error;
    } finally {
      if (ownsRecovery) rmSync(recoveryPath, { recursive: true, force: true });
    }
    if (!createLock()) throw new Error(`Application batch ${loaded.manifest.batchId} is already executing`);
  }
  const claimsCandidate = normalizedCandidateId && [
    'prepare_application', 'resume_login', 'state_transition', 'submission_confirmation', 'confirm_manual_submission',
  ].includes(operation);
  const priorClaim = claimsCandidate ? inspectCandidateClaim(root, normalizedCandidateId) : null;
  let claimPath = null;
  if (claimsCandidate) {
    try {
      claimPath = ensureCandidateClaim(root, loaded.manifest.batchId, normalizedCandidateId, now);
    } catch (error) {
      const owner = readLockOwnerIfValid(ownerPath);
      if (owner?.token === token) rmSync(lockPath, { recursive: true, force: true });
      throw error;
    }
  }
  let released = false;
  return {
    batchId: loaded.manifest.batchId,
    candidateId: normalizedCandidateId,
    token,
    lockPath,
    claimPath,
    staleRecovered,
    staleRecovery: staleRecovery ? {
      ...staleRecovery,
      claimDisposition: priorClaim?.owner?.batchId === loaded.manifest.batchId ? 'reused_same_batch_claim' : priorClaim ? 'blocked_by_other_batch' : 'created_or_not_required',
    } : null,
    heartbeat(at = new Date()) {
      const owner = readLockOwnerIfValid(ownerPath);
      if (owner?.token !== token || owner?.batchId !== loaded.manifest.batchId
          || (owner?.candidateId ?? null) !== normalizedCandidateId
          || owner?.processStartKey !== CURRENT_PROCESS_START_KEY) {
        throw new Error('Application-batch execution lock ownership changed');
      }
      owner.heartbeatAt = at.toISOString();
      writeJsonAtomic(ownerPath, owner);
      return owner.heartbeatAt;
    },
    release() {
      if (released) return;
      released = true;
      const owner = readLockOwnerIfValid(ownerPath);
      if (owner?.token === token && owner?.batchId === loaded.manifest.batchId
          && (owner?.candidateId ?? null) === normalizedCandidateId
          && owner?.processStartKey === CURRENT_PROCESS_START_KEY) {
        rmSync(lockPath, { recursive: true, force: true });
      }
    },
  };
}

function assertExecutionLock(manifestPath, lockToken, root, candidateId = null) {
  const loaded = loadManifest(manifestPath, { root });
  const ownerPath = join(dirname(loaded.manifestPath), '.execution.lock', 'owner.json');
  if (!lockToken || !existsSync(ownerPath)) throw new Error('Active application-batch execution lock is required');
  const owner = readJson(ownerPath, 'application-batch execution lock');
  if (owner.batchId !== loaded.manifest.batchId || owner.token !== lockToken
      || (candidateId != null && owner.candidateId !== candidateId)
      || (owner.pid === process.pid && owner.processStartKey !== CURRENT_PROCESS_START_KEY)) {
    throw new Error('Application-batch execution lock does not match this batch');
  }
  owner.heartbeatAt = new Date().toISOString();
  writeJsonAtomic(ownerPath, owner);
}


export function recordStaleLockRecovery(manifestPath, recovery, {
  root = ROOT,
  lockToken,
  now = new Date(),
} = {}) {
  if (!recovery) return null;
  const loaded = loadBatchState(manifestPath, { root });
  assertExecutionLock(manifestPath, lockToken, root, recovery.candidateId);
  const event = {
    timestamp: recovery.timestamp || now.toISOString(),
    batchId: loaded.manifest.batchId,
    candidateId: recovery.candidateId || null,
    previousOwner: recovery.previousOwner || null,
    reason: inline(recovery.reason) || 'stale_lock_recovered',
    claimDisposition: inline(recovery.claimDisposition) || 'unknown',
  };
  loaded.state.lockRecoveryHistory ??= [];
  loaded.state.lockRecoveryHistory.push(event);
  loaded.state.revision += 1;
  loaded.state.updatedAt = now.toISOString();
  writeBatchState(loaded.statePath, loaded.state);
  return event;
}
function sourceMembership(manifest, root) {
  const context = sourceContext(root, manifest.sourceRunId, manifest.schemaVersion === 2 ? manifest.sourceIntegrity : null);
  for (const candidate of manifest.candidates) {
    const matches = context.normalizedCandidates.filter((sourceCandidate) => (
      candidate.identityStatus === 'legacy_derived'
        ? sourceCandidate.urlAliases.includes(candidate.listingUrl)
        : sourceCandidate.candidate_id === candidate.candidate_id
    ));
    if (matches.length !== 1) throw new Error(`Manifest candidate is no longer an exact source-run member: ${candidate.candidate_id}`);
    const sourceCandidate = matches[0];
    if (!sourceCandidate.urlAliases.includes(candidate.listingUrl)) throw new Error('Manifest listing URL is not a source alias');
    if (manifest.schemaVersion === 2 && sha256Canonical(sourceCandidate.sourceRow) !== candidate.sourceCandidateSha256) {
      throw new Error(`Source candidate row integrity mismatch: ${candidate.candidate_id}`);
    }
  }
  return context;
}

function effectiveCandidates(manifest, state, { root, requireCv = false, requireCoverLetter = false } = {}) {
  return manifest.candidates.map((candidate, index) => {
    const candidateState = state.candidates[index];
    const artifacts = {
      cv: candidateState.artifacts.cv || candidate.artifacts?.cv || null,
      coverLetter: candidateState.artifacts.coverLetter || candidate.artifacts?.coverLetter || null,
      coverLetterText: candidateState.artifacts.coverLetterText || candidate.artifacts?.coverLetterText || null,
      combinedDocument: candidateState.artifacts.combinedDocument || candidate.artifacts?.combinedDocument || null,
    };
    if (requireCv && !artifacts.cv) throw new Error(`Candidate has no bound CV artifact: ${candidate.candidate_id}`);
    if (requireCoverLetter && (!artifacts.coverLetter || !artifacts.coverLetterText)) {
      throw new Error(`Candidate has no complete bound cover-letter PDF/text artifact set: ${candidate.candidate_id}`);
    }
    if (artifacts.cv) validateArtifactRecord(artifacts.cv, { root, expectedType: 'cv' });
    if (artifacts.coverLetter) validateArtifactRecord(artifacts.coverLetter, { root, expectedType: 'cover_letter' });
    if (artifacts.coverLetterText) validateArtifactRecord(artifacts.coverLetterText, { root, expectedType: 'cover_letter_text' });
    if (artifacts.combinedDocument) validateArtifactRecord(artifacts.combinedDocument, { root, expectedType: 'combined_document' });
    return { ...candidate, artifacts };
  });
}

function approvalEnvelope(manifest, source, candidates) {
  return {
    schemaVersion: 2,
    batchId: manifest.batchId,
    sourceRunId: manifest.sourceRunId,
    manifestScopeHash: manifest.scopeHash,
    sourceIntegrity: source.integrity,
    orderedCandidates: candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      run_id: candidate.run_id,
      company: candidate.company,
      title: candidate.title,
      listingUrl: candidate.listingUrl,
      applyUrl: candidate.applyUrl,
      cv: candidate.artifacts.cv && {
        intendedFilename: candidate.artifacts.cv.intendedFilename,
        resolvedPath: candidate.artifacts.cv.resolvedPath,
        sha256: candidate.artifacts.cv.sha256,
      },
      coverLetter: candidate.artifacts.coverLetter && {
        intendedFilename: candidate.artifacts.coverLetter.intendedFilename,
        resolvedPath: candidate.artifacts.coverLetter.resolvedPath,
        sha256: candidate.artifacts.coverLetter.sha256,
      },
      coverLetterText: candidate.artifacts.coverLetterText && {
        intendedFilename: candidate.artifacts.coverLetterText.intendedFilename,
        resolvedPath: candidate.artifacts.coverLetterText.resolvedPath,
        sha256: candidate.artifacts.coverLetterText.sha256,
      },
      combinedDocument: candidate.artifacts.combinedDocument && {
        intendedFilename: candidate.artifacts.combinedDocument.intendedFilename,
        resolvedPath: candidate.artifacts.combinedDocument.resolvedPath,
        sha256: candidate.artifacts.combinedDocument.sha256,
      },
    })),
  };
}

function currentScope(loaded, { root, requireCv = false, requireCoverLetter = false } = {}) {
  const source = sourceMembership(loaded.manifest, root);
  const candidates = effectiveCandidates(loaded.manifest, loaded.state, { root, requireCv, requireCoverLetter });
  const envelope = approvalEnvelope(loaded.manifest, source, candidates);
  return { source, candidates, envelope, scopeHash: sha256Canonical(envelope) };
}

export function formatPreflight(manifest, state = null) {
  const normalized = validateManifest(manifest);
  const effectiveState = state || initialBatchState(normalized);
  const candidates = normalized.candidates.map((candidate, index) => ({
    ...candidate,
    artifacts: effectiveState.candidates[index]?.artifacts || candidate.artifacts,
  }));
  const lines = [
    'APPLICATION BATCH PREFLIGHT',
    `Source run: ${normalized.sourceRunId}`,
    `Batch ID: ${normalized.batchId}`,
    `Candidate count: ${normalized.expectedCandidateCount}`,
    '',
  ];
  for (const candidate of candidates) {
    lines.push(`${candidate.order}. ${candidate.company} — ${candidate.title}`);
    lines.push(`   Candidate ID: ${candidate.candidate_id}${candidate.identityStatus === 'legacy_derived' ? ' (derived legacy identity)' : ''}`);
    lines.push(`   Listing URL: ${candidate.listingUrl}`);
    lines.push(`   Apply URL: ${candidate.applyUrl || '(same as listing / unknown)'}`);
    lines.push(`   CV: ${candidate.artifacts.cv ? `${candidate.artifacts.cv.intendedFilename} (${candidate.artifacts.cv.sha256})` : '(not bound)'}`);
    lines.push(`   Cover letter: ${candidate.artifacts.coverLetter ? `${candidate.artifacts.coverLetter.intendedFilename} (${candidate.artifacts.coverLetter.sha256})` : '(none)'}`);
    lines.push(`   Cover letter text: ${candidate.artifacts.coverLetterText ? `${candidate.artifacts.coverLetterText.intendedFilename} (${candidate.artifacts.coverLetterText.sha256})` : '(none)'}`);
    lines.push(`   Combined document: ${candidate.artifacts.combinedDocument ? `${candidate.artifacts.combinedDocument.intendedFilename} (${candidate.artifacts.combinedDocument.sha256})` : '(none)'}`);
  }
  return lines.join('\n');
}

function invalidatePreflight(state, timestamp, reason) {
  const prior = state.preflight;
  state.preflight = {
    status: prior.status === 'confirmed' ? 'invalidated' : 'unconfirmed',
    confirmedAt: null,
    confirmedScopeHash: null,
    invalidatedAt: timestamp,
    invalidationReason: reason,
    history: [
      ...prior.history,
      ...(prior.status === 'confirmed' ? [{
        event: 'invalidated',
        timestamp,
        previousConfirmedAt: prior.confirmedAt,
        previousScopeHash: prior.confirmedScopeHash,
        reason,
      }] : []),
    ],
  };
}

export function confirmPreflight(manifestPath, confirmationBatchId, { root = ROOT, now = new Date() } = {}) {
  const lock = acquireBatchExecutionLock(manifestPath, { root, now });
  try {
    const loaded = loadBatchState(manifestPath, { root });
    if (confirmationBatchId !== loaded.manifest.batchId) {
      throw new Error(`Confirmation must repeat the exact batch ID: ${loaded.manifest.batchId}`);
    }
    const scope = currentScope(loaded, { root, requireCv: false });
    const timestamp = now.toISOString();
    loaded.state.preflight = {
      status: 'confirmed',
      confirmedAt: timestamp,
      confirmedScopeHash: scope.scopeHash,
      invalidatedAt: null,
      invalidationReason: null,
      history: [...loaded.state.preflight.history, { event: 'confirmed', timestamp, scopeHash: scope.scopeHash }],
    };
    loaded.state.schemaVersion = APPLICATION_BATCH_STATE_SCHEMA_VERSION;
    loaded.state.revision += 1;
    loaded.state.updatedAt = timestamp;
    writeBatchState(loaded.statePath, loaded.state);
    return loaded.state.preflight;
  } finally {
    lock.release();
  }
}

export function assertPreflightConfirmed(manifest, state, { root = ROOT, requireCv = false, requireCoverLetter = false } = {}) {
  if (state?.preflight?.status !== 'confirmed' || !state.preflight.confirmedAt || !state.preflight.confirmedScopeHash) {
    throw new Error(`Batch ${manifest.batchId} has not passed explicit preflight confirmation`);
  }
  const loaded = { manifest, state };
  const scope = currentScope(loaded, { root, requireCv, requireCoverLetter });
  if (scope.scopeHash !== state.preflight.confirmedScopeHash) {
    throw new Error(`Batch ${manifest.batchId} confirmation scope changed; bind artifacts and confirm again`);
  }
  return { confirmation: state.preflight, ...scope };
}

function selectorKind(selector) {
  const value = inline(selector);
  if (isCandidateId(value)) return { candidateId: value, url: null };
  return { candidateId: null, url: requireHttpUrl(value, 'candidate selector URL') };
}

function findManifestCandidate(manifest, selector) {
  const parsed = selectorKind(selector);
  const matches = manifest.candidates.filter((candidate) => parsed.candidateId
    ? candidate.candidate_id === parsed.candidateId
    : candidate.urlAliases.includes(parsed.url) || candidate.applyUrl === parsed.url);
  if (!matches.length) throw new Error(`Candidate is not in the application batch: ${selector}`);
  if (matches.length > 1) throw new Error(`Candidate selector is ambiguous in the application batch: ${selector}`);
  return matches[0];
}

export function loadExecutionContract(manifestPath, selector, { root = ROOT, requireCoverLetter = false } = {}) {
  const loaded = loadBatchState(manifestPath, { root });
  const candidateId = requireCandidateId(selector);
  const verified = assertPreflightConfirmed(loaded.manifest, loaded.state, {
    root, requireCv: true, requireCoverLetter,
  });
  const candidate = findManifestCandidate(loaded.manifest, candidateId);
  const pausedOther = loaded.state.candidates.find((row) => row.candidate_id !== candidate.candidate_id
    && !['not_opened', 'closed', 'abandoned'].includes(row.state));
  if (pausedOther) {
    throw new Error(`Another candidate in this batch is paused at ${pausedOther.state}: ${pausedOther.candidate_id}`);
  }
  const stateMatches = loaded.state.candidates.filter((candidateState) => candidateState.candidate_id === candidate.candidate_id);
  if (stateMatches.length !== 1) throw new Error('Candidate state is missing or ambiguous');
  const effective = verified.candidates.find((row) => row.candidate_id === candidate.candidate_id);
  const sourceCandidate = verified.source.normalizedCandidates.find((row) => (
    candidate.identityStatus === 'legacy_derived'
      ? row.urlAliases.includes(candidate.listingUrl)
      : row.candidate_id === candidate.candidate_id
  ));
  if (!sourceCandidate) throw new Error(`Candidate source evidence is missing: ${candidate.candidate_id}`);
  return {
    ...loaded,
    sourceCandidatesPath: verified.source.candidatesPath,
    sourceCandidate,
    candidate: effective,
    candidateState: stateMatches[0],
  };
}

export function loadPreparationContract(manifestPath, candidateId, {
  root = ROOT,
  allowPausedReplacement = false,
} = {}) {
  const exactId = requireCandidateId(candidateId);
  const loaded = loadBatchState(manifestPath, { root });
  const source = sourceMembership(loaded.manifest, root);
  const candidate = findManifestCandidate(loaded.manifest, exactId);
  const candidateState = loaded.state.candidates.find((row) => row.candidate_id === exactId);
  const replacementStateAllowed = allowPausedReplacement
    && ['actual_form_reached', 'review_required', 'blocked'].includes(candidateState?.state);
  if (!candidateState || (candidateState.state !== 'not_opened' && !replacementStateAllowed)) {
    throw new Error(`Document preparation requires not_opened state for ${exactId}`);
  }
  const activeOther = loaded.state.candidates.find((row) => row.candidate_id !== exactId && !['not_opened', 'closed', 'abandoned'].includes(row.state));
  if (activeOther) throw new Error(`Another candidate is active in this batch: ${activeOther.candidate_id}`);
  const sourceCandidate = source.normalizedCandidates.find((row) => (
    candidate.identityStatus === 'legacy_derived'
      ? row.urlAliases.includes(candidate.listingUrl)
      : row.candidate_id === exactId
  ));
  if (!sourceCandidate) throw new Error(`Candidate is no longer present in source run: ${exactId}`);
  return { ...loaded, source, sourceCandidate, candidate, candidateState };
}

function artifactStateKey(artifactType) {
  const key = ({
    cv: 'cv',
    cover_letter: 'coverLetter',
    cover_letter_text: 'coverLetterText',
    combined_document: 'combinedDocument',
  })[artifactType];
  if (!key) throw new Error(`Unsupported artifact type: ${artifactType}`);
  return key;
}

export function bindCandidateArtifacts(manifestPath, candidateId, bindings, {
  root = ROOT,
  replace = false,
  now = new Date(),
} = {}) {
  if (!Array.isArray(bindings) || !bindings.length) throw new Error('At least one exact artifact binding is required');
  const exactId = requireCandidateId(candidateId);
  const lock = acquireBatchExecutionLock(manifestPath, {
    root, now, candidateId: exactId, operation: 'bind_artifacts',
  });
  try {
    const loaded = loadPreparationContract(manifestPath, exactId, { root, allowPausedReplacement: replace });
    const records = bindings.map((binding) => ({
      key: artifactStateKey(binding.artifactType),
      artifactType: binding.artifactType,
      record: createArtifactRecord({
        root,
        artifactType: binding.artifactType,
        filePath: binding.filePath,
        sourceCvVariant: binding.sourceCvVariant || loaded.candidate.recommendedCvVariant,
        createdAt: binding.createdAt || null,
        narrativeProvenance: binding.narrativeProvenance || null,
        coverLetterV2Approval: binding.coverLetterV2Approval || null,
      }),
    }));
    if (new Set(records.map((item) => item.key)).size !== records.length) throw new Error('Duplicate artifact type in one binding transaction');
    for (const item of records) {
      if (loaded.candidateState.artifacts[item.key] && !replace) {
        throw new Error(`Artifact ${item.artifactType} is already bound; use --replace explicitly`);
      }
    }
    const timestamp = now.toISOString();
    for (const item of records) {
      const previous = loaded.candidateState.artifacts[item.key];
      loaded.candidateState.artifacts[item.key] = item.record;
      loaded.candidateState.artifactHistory.push({
        event: previous ? 'replaced' : 'bound',
        artifactType: item.artifactType,
        timestamp,
        previousSha256: previous?.sha256 || null,
        sha256: item.record.sha256,
        intendedFilename: item.record.intendedFilename,
      });
    }
    invalidatePreflight(loaded.state, timestamp, `Artifact set changed for ${exactId}`);
    loaded.state.schemaVersion = APPLICATION_BATCH_STATE_SCHEMA_VERSION;
    loaded.state.revision += 1;
    loaded.state.updatedAt = timestamp;
    writeBatchState(loaded.statePath, loaded.state);
    return Object.fromEntries(records.map((item) => [item.key, item.record]));
  } finally {
    lock.release();
  }
}

export function bindCandidateArtifact(manifestPath, selector, {
  root = ROOT,
  artifactType,
  filePath,
  sourceCvVariant = null,
  createdAt = null,
  replace = false,
  now = new Date(),
} = {}) {
  const lock = acquireBatchExecutionLock(manifestPath, { root, now });
  try {
    const loaded = loadBatchState(manifestPath, { root });
    sourceMembership(loaded.manifest, root);
    const candidate = findManifestCandidate(loaded.manifest, selector);
    const candidateState = loaded.state.candidates.find((row) => row.candidate_id === candidate.candidate_id);
    if (candidateState.state !== 'not_opened') throw new Error('Artifacts can only be changed before browser execution');
    const key = artifactStateKey(artifactType);
    if (candidateState.artifacts[key] && !replace) throw new Error(`Artifact ${artifactType} is already bound; use --replace explicitly`);
    const record = createArtifactRecord({
      root,
      artifactType,
      filePath,
      sourceCvVariant: sourceCvVariant || candidate.recommendedCvVariant,
      createdAt,
    });
    const timestamp = now.toISOString();
    const previous = candidateState.artifacts[key];
    candidateState.artifacts[key] = record;
    candidateState.artifactHistory.push({
      event: previous ? 'replaced' : 'bound',
      artifactType,
      timestamp,
      previousSha256: previous?.sha256 || null,
      sha256: record.sha256,
      intendedFilename: record.intendedFilename,
    });
    invalidatePreflight(loaded.state, timestamp, `${artifactType} artifact binding changed for ${candidate.candidate_id}`);
    loaded.state.schemaVersion = APPLICATION_BATCH_STATE_SCHEMA_VERSION;
    loaded.state.revision += 1;
    loaded.state.updatedAt = timestamp;
    writeBatchState(loaded.statePath, loaded.state);
    return record;
  } finally {
    lock.release();
  }
}

export function bindVerifiedCombinedArtifact(manifestPath, candidateId, {
  root = ROOT,
  filePath,
  formEvidenceHash,
  sourceArtifacts,
  replace = false,
  lockToken = null,
  now = new Date(),
} = {}) {
  const exactId = requireCandidateId(candidateId);
  const ownedLock = lockToken ? null : acquireBatchExecutionLock(manifestPath, {
    root, now, candidateId: exactId, operation: 'bind_artifacts',
  });
  try {
    const loaded = loadBatchState(manifestPath, { root });
    sourceMembership(loaded.manifest, root);
    const candidate = findManifestCandidate(loaded.manifest, exactId);
    if (lockToken) assertExecutionLock(manifestPath, lockToken, root, exactId);
    const state = loaded.state.candidates.find((row) => row.candidate_id === exactId);
    if (state.state !== 'review_required') throw new Error('Combined document binding requires review_required state from verified form inspection');
    if (state.formPreparation?.evidenceHash !== formEvidenceHash
        || state.formPreparation?.uploadTopology?.mode !== 'single_combined') {
      throw new Error('Combined document requires exact stored single-document form evidence');
    }
    if (!state.artifacts.cv || !state.artifacts.coverLetter) throw new Error('Combined document requires exact bound CV and cover-letter artifacts');
    const expectedSources = [state.artifacts.cv, state.artifacts.coverLetter].map((row) => ({ artifactType: row.artifactType, sha256: row.sha256, size: row.size }));
    if (sha256Canonical(sourceArtifacts) !== sha256Canonical(expectedSources)) throw new Error('Combined document source artifacts do not match this candidate');
    if (state.artifacts.combinedDocument && !replace) throw new Error('Combined document is already bound; use --replace explicitly');
    const record = createArtifactRecord({ root, artifactType: 'combined_document', filePath, sourceArtifacts: expectedSources });
    const previous = state.artifacts.combinedDocument;
    const timestamp = now.toISOString();
    state.artifacts.combinedDocument = record;
    state.artifactHistory.push({
      event: previous ? 'replaced' : 'bound', artifactType: 'combined_document', timestamp,
      previousSha256: previous?.sha256 || null, sha256: record.sha256, intendedFilename: record.intendedFilename,
    });
    invalidatePreflight(loaded.state, timestamp, `Combined document changed for verified single-document form: ${exactId}`);
    loaded.state.schemaVersion = APPLICATION_BATCH_STATE_SCHEMA_VERSION;
    loaded.state.revision += 1;
    loaded.state.updatedAt = timestamp;
    writeBatchState(loaded.statePath, loaded.state);
    return record;
  } finally { ownedLock?.release(); }
}

// Save a paused pass without expanding the small human-action transition record.
export function recordPartialFormPreparation(manifestPath, candidateId, evidence, {
  root = ROOT, lockToken, now = new Date(),
} = {}) {
  const exactId = requireCandidateId(candidateId);
  assertExecutionLock(manifestPath, lockToken, root, exactId);
  const loaded = loadBatchState(manifestPath, { root });
  assertPreflightConfirmed(loaded.manifest, loaded.state, { root, requireCv: true });
  findManifestCandidate(loaded.manifest, exactId);
  const candidate = loaded.state.candidates.find((row) => row.candidate_id === exactId);
  if (candidate.state !== 'actual_form_reached') throw new Error('Partial preparation requires the exact active form');
  const partial = sanitizedPreparation({ ...evidence, userActionRequired: true,
    browserOpenRequired: true, deterministicReviewComplete: false, reviewComplete: false });
  partial.evidenceHash = hashFormValue(JSON.stringify({ ...partial, evidenceHash: undefined }));
  appendFormPreparationEvidence(candidate, partial);
  loaded.state.revision += 1;
  loaded.state.updatedAt = now.toISOString();
  writeBatchState(loaded.statePath, loaded.state);
  return candidate.formPreparation;
}

export function transitionCandidateState(manifestPath, selector, toState, {
  root = ROOT,
  currentUrl,
  reason,
  expectedFrom = null,
  lockToken = null,
  details = null,
  formPreparation = null,
  humanAction = null,
  now = new Date(),
} = {}) {
  if (!EXECUTION_STATES.includes(toState)) throw new Error(`Invalid execution state: ${toState}`);
  if (toState === 'abandoned') throw new Error('State abandoned may only be recorded by the canonical abandonment API');
  const isHumanPause = toState === 'human_action_required';
  const current = requireHttpUrl(sanitizeUrl(currentUrl), 'current URL');
  const evidence = isHumanPause ? `Human action required: ${humanAction?.cause}.` : sanitizePersistedUrls(inline(reason));
  details = sanitizePersistedUrls(details);
  if (formPreparation) formPreparation = sanitizedPreparation(formPreparation);
  if (isHumanPause && (details != null || formPreparation != null)) {
    throw new Error('Human action pause records only sanitized classifier evidence');
  }
  if (!isHumanPause && humanAction != null) throw new Error('Human action record requires a pause transition');
  if (!evidence) throw new Error('A short reason/evidence value is required for every state transition');
  if (evidence.length > 500) throw new Error('State transition reason/evidence must be 500 characters or fewer');
  const executorOnly = !['blocked', 'closed'].includes(toState);
  if (executorOnly && !lockToken) {
    throw new Error(`State ${toState} may only be recorded by the locked canonical browser executor`);
  }
  if (details != null && (typeof details !== 'object' || Array.isArray(details))) throw new Error('State transition details must be an object');
  if (formPreparation != null) validateFormPreparation(formPreparation);
  const ownedLock = lockToken ? null : acquireBatchExecutionLock(manifestPath, {
    root, now, candidateId: requireCandidateId(selector), operation: 'state_transition',
  });
  try {
    const activeToken = lockToken || ownedLock.token;
    const loaded = loadBatchState(manifestPath, { root });
    assertPreflightConfirmed(loaded.manifest, loaded.state, { root, requireCv: true });
    const candidate = findManifestCandidate(loaded.manifest, requireCandidateId(selector));
    assertExecutionLock(manifestPath, activeToken, root, candidate.candidate_id);
    const candidateState = loaded.state.candidates.find((row) => row.candidate_id === candidate.candidate_id);
    if (expectedFrom && candidateState.state !== expectedFrom) {
      throw new Error(`State changed concurrently: expected ${expectedFrom}, found ${candidateState.state}`);
    }
    if (!TRANSITIONS[candidateState.state]?.has(toState)) {
      throw new Error(`Invalid state transition: ${candidateState.state} -> ${toState}`);
    }
    if (candidateState.state === 'human_action_required' && toState === 'actual_form_reached') {
      validateHumanActionRevalidation(details, candidate.candidate_id);
    }
    const effectivePreparation = formPreparation || candidateState.formPreparation;
    if (toState === 'form_prepared' && (!effectivePreparation?.reviewComplete
        || effectivePreparation?.finalAction?.activated !== false
        || effectivePreparation?.unresolvedFields?.length
        || effectivePreparation?.validationErrors?.length
        || effectivePreparation?.userActionRequired)) {
      throw new Error('form_prepared requires complete whole-form review evidence with the final action untouched');
    }
    const timestamp = now.toISOString();
    let pauseRecord = null;
    if (isHumanPause) {
      assertKnownFields(humanAction || {}, new Set(['candidate_id', 'cause', 'stage', 'currentUrl', 'timestamp', 'evidence']), 'human action record');
      pauseRecord = {
        candidate_id: humanAction?.candidate_id ?? candidate.candidate_id,
        cause: humanAction?.cause, stage: humanAction?.stage,
        currentUrl: current, timestamp,
        evidence: [...new Set(humanAction?.evidence || [])],
      };
      validateHumanAction(pauseRecord, candidate.candidate_id);
    }
    candidateState.history.push({
      seq: candidateState.history.length,
      from: candidateState.state,
      to: toState,
      timestamp,
      currentUrl: current,
      reason: evidence,
      ...(details ? { details } : {}),
      ...(pauseRecord ? { humanAction: pauseRecord } : {}),
    });
    candidateState.state = toState;
    candidateState.updatedAt = timestamp;
    candidateState.currentUrl = current;
    candidateState.reason = evidence;
    if (pauseRecord) candidateState.humanAction = pauseRecord;
    if (formPreparation) appendFormPreparationEvidence(candidateState, formPreparation);
    if (toState === 'listing_verified' && candidateState.importVerification?.status === 'legacy_unverified') {
      candidateState.importVerification = {
        status: 'fresh_verified',
        verifiedAt: timestamp,
        reason: evidence,
      };
    }
    loaded.state.revision += 1;
    loaded.state.schemaVersion = APPLICATION_BATCH_STATE_SCHEMA_VERSION;
    loaded.state.updatedAt = timestamp;
    writeBatchState(loaded.statePath, loaded.state);
    if (toState === 'closed') releaseCandidateClaim(root, loaded.manifest.batchId, candidate.candidate_id);
    return candidateState;
  } finally {
    ownedLock?.release();
  }
}

export function abandonApplicationBatch(manifestPath, {
  root = ROOT,
  candidateId = null,
  entireBatch = false,
  reason,
  now = new Date(),
  processStartKeyForPid = defaultProcessStartKey,
} = {}) {
  if (Boolean(candidateId) === Boolean(entireBatch)) {
    throw new Error('Choose exactly one: an exact candidate ID or explicit entire-batch abandonment');
  }
  const humanReason = inline(reason);
  if (!humanReason) throw new Error('A human-provided abandonment reason is required');
  if (humanReason.length > 500) throw new Error('Abandonment reason must be 500 characters or fewer');
  const exactId = candidateId == null ? null : requireCandidateId(candidateId);
  const lock = acquireBatchExecutionLock(manifestPath, {
    root, now, candidateId: exactId, operation: entireBatch ? 'abandon_batch' : 'abandon_candidate', processStartKeyForPid,
  });
  const staged = [];
  try {
    const loaded = loadBatchState(manifestPath, { root });
    sourceMembership(loaded.manifest, root);
    const targets = entireBatch
      ? loaded.state.candidates
      : [loaded.state.candidates.find((row) => row.candidate_id === exactId)].filter(Boolean);
    if (!targets.length) throw new Error(`Candidate is not in the application batch: ${exactId}`);
    for (const target of targets) {
      if (target.submission?.status !== 'unconfirmed') {
        throw new Error(`Cannot abandon ${target.candidate_id}: final-submission confirmation is ${target.submission.status}`);
      }
      const claim = inspectCandidateClaim(root, target.candidate_id);
      if (claim && (claim.owner.batchId !== loaded.manifest.batchId || claim.owner.candidateId !== target.candidate_id)) {
        throw new Error(`Refusing to release claim for ${target.candidate_id} owned by another batch`);
      }
    }
    const timestamp = now.toISOString();
    const changed = targets.filter((target) => target.state !== 'abandoned');
    if (!changed.length) return { batchId: loaded.manifest.batchId, idempotent: true, candidates: targets.map((row) => row.candidate_id) };

    for (const target of changed) {
      if (!TRANSITIONS[target.state]?.has('abandoned')) throw new Error(`Invalid abandonment state: ${target.state}`);
      const claim = inspectCandidateClaim(root, target.candidate_id);
      let releaseEvidence = { status: 'not_claimed', owner: null };
      if (claim) {
        const stagedPath = `${claim.claimPath}.releasing-${process.pid}-${randomBytes(4).toString('hex')}`;
        renameSync(claim.claimPath, stagedPath);
        staged.push({ original: claim.claimPath, staged: stagedPath });
        releaseEvidence = { status: 'released', owner: claim.owner };
      }
      const previousState = target.state;
      target.history.push({
        seq: target.history.length, from: previousState, to: 'abandoned', timestamp,
        currentUrl: target.currentUrl, reason: humanReason,
        details: { administrative: true, claimRelease: releaseEvidence.status },
      });
      target.state = 'abandoned';
      target.updatedAt = timestamp;
      target.reason = humanReason;
      target.abandonmentHistory.push({
        timestamp, previousState, newState: 'abandoned', reason: humanReason, claimRelease: releaseEvidence,
      });
    }
    loaded.state.schemaVersion = APPLICATION_BATCH_STATE_SCHEMA_VERSION;
    loaded.state.revision += 1;
    loaded.state.updatedAt = timestamp;
    writeBatchState(loaded.statePath, loaded.state);
    for (const item of staged) rmSync(item.staged, { recursive: true, force: true });
    return { batchId: loaded.manifest.batchId, idempotent: false, candidates: changed.map((row) => row.candidate_id) };
  } catch (error) {
    for (const item of staged.reverse()) {
      if (existsSync(item.staged) && !existsSync(item.original)) renameSync(item.staged, item.original);
    }
    throw error;
  } finally {
    lock.release();
  }
}

export function recordSubmissionConfirmation(manifestPath, selector, {
  root = ROOT,
  status,
  eventId,
  trackerPath,
  trackerRow,
  evidence,
  confirmationEnvelope,
  lockToken = null,
  now = new Date(),
} = {}) {
  if (!['confirmed_pending_tracker', 'tracker_applied'].includes(status)) {
    throw new Error(`Invalid submission confirmation status: ${status}`);
  }
  const normalizedEventId = inline(eventId);
  const normalizedEvidence = inline(evidence);
  if (!/^submission_v1_[a-f0-9]{64}$/.test(normalizedEventId)) throw new Error('Invalid submission event ID');
  if (!confirmationEnvelope || typeof confirmationEnvelope !== 'object' || Array.isArray(confirmationEnvelope)) {
    throw new Error('Exact submission confirmation envelope is required');
  }
  const scopeHash = sha256Canonical(confirmationEnvelope);
  const expectedEventId = `submission_v1_${scopeHash.slice('sha256:'.length)}`;
  if (normalizedEventId !== expectedEventId) {
    throw new Error('Submission event does not match its exact confirmation envelope');
  }
  if (!normalizedEvidence || normalizedEvidence.length > 500) throw new Error('Submission evidence must be 1-500 characters');
  if (!Number.isInteger(trackerRow) || trackerRow < 1) throw new Error('Exact positive tracker row/report number is required');
  const exactTrackerPath = resolve(root, trackerPath || '');
  const exactCandidateId = requireCandidateId(selector);
  const ownedLock = lockToken ? null : acquireBatchExecutionLock(manifestPath, {
    root, now, candidateId: exactCandidateId, operation: 'submission_confirmation',
  });
  try {
    const activeToken = lockToken || ownedLock.token;
    const loaded = loadBatchState(manifestPath, { root });
    const verified = assertPreflightConfirmed(loaded.manifest, loaded.state, {
      root, requireCv: true, requireCoverLetter: true,
    });
    const candidate = findManifestCandidate(loaded.manifest, exactCandidateId);
    assertExecutionLock(manifestPath, activeToken, root, candidate.candidate_id);
    const effectiveCandidate = verified.candidates.find((row) => row.candidate_id === candidate.candidate_id);
    const candidateState = loaded.state.candidates.find((row) => row.candidate_id === candidate.candidate_id);
    if (confirmationEnvelope.batchId !== loaded.manifest.batchId
        || confirmationEnvelope.sourceRunId !== loaded.manifest.sourceRunId
        || confirmationEnvelope.candidate?.candidate_id !== candidate.candidate_id
        || confirmationEnvelope.preflightScopeHash !== loaded.state.preflight.confirmedScopeHash
        || confirmationEnvelope.tracker?.path !== exactTrackerPath
        || confirmationEnvelope.tracker?.row !== trackerRow
        || confirmationEnvelope.evidence !== normalizedEvidence) {
      throw new Error('Submission confirmation envelope no longer matches current batch, candidate, tracker, or evidence');
    }
    if (candidateState.state !== 'form_prepared') {
      throw new Error(`Submission confirmation requires form_prepared state, found ${candidateState.state}`);
    }
    if (!candidateState.formPreparation?.reviewComplete || candidateState.formPreparation?.finalAction?.activated !== false) {
      throw new Error('Submission confirmation requires validated Phase 4 whole-form review evidence');
    }
    if (candidateState.importVerification?.status === 'legacy_unverified') {
      throw new Error('Legacy-imported candidate requires fresh listing verification before submission confirmation');
    }
    const prior = candidateState.submission || initialSubmission();
    if (prior.status === 'tracker_applied') {
      if (prior.eventId === normalizedEventId && prior.trackerPath === exactTrackerPath && prior.trackerRow === trackerRow) {
        return { candidate: effectiveCandidate, candidateState, idempotent: true };
      }
      throw new Error('Candidate already has a different completed submission confirmation');
    }
    if (status === 'tracker_applied' && (prior.status !== 'confirmed_pending_tracker' || prior.eventId !== normalizedEventId)) {
      throw new Error('Tracker Applied completion requires the matching pending submission event');
    }
    if (prior.status === 'confirmed_pending_tracker' && (prior.eventId !== normalizedEventId
        || prior.trackerPath !== exactTrackerPath || prior.trackerRow !== trackerRow)) {
      throw new Error('A different submission confirmation is already pending');
    }
    const timestamp = now.toISOString();
    const confirmedAt = prior.confirmedAt || timestamp;
    candidateState.submission = {
      status,
      eventId: normalizedEventId,
      scopeHash,
      confirmedAt,
      trackerPath: exactTrackerPath,
      trackerRow,
      evidence: normalizedEvidence,
      updatedAt: timestamp,
      history: [...prior.history, {
        status,
        eventId: normalizedEventId,
        scopeHash,
        timestamp,
        trackerPath: exactTrackerPath,
        trackerRow,
        evidence: normalizedEvidence,
      }],
    };
    loaded.state.revision += 1;
    loaded.state.updatedAt = timestamp;
    writeBatchState(loaded.statePath, loaded.state);
    if (status === 'tracker_applied') releaseCandidateClaim(root, loaded.manifest.batchId, candidate.candidate_id);
    return { candidate: effectiveCandidate, candidateState, idempotent: false };
  } finally {
    ownedLock?.release();
  }
}

function parseOptions(argv, { repeated = [], allowed = [], flags = [] } = {}) {
  const result = Object.fromEntries(repeated.map((key) => [key, []]));
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected positional argument: ${arg}`);
    const key = arg.slice(2);
    if (![...allowed, ...flags].includes(key)) throw new Error(`Unknown option: ${arg}`);
    if (flags.includes(key)) {
      if (result[key]) throw new Error(`Duplicate option: ${arg}`);
      result[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (repeated.includes(key)) result[key].push(value);
    else if (result[key] !== undefined) throw new Error(`Duplicate option: ${arg}`);
    else result[key] = value;
    index += 1;
  }
  return result;
}

function selectorFromOptions(options) {
  if (options['candidate-id'] && options['candidate-url']) throw new Error('Use one exact candidate selector, not both ID and URL');
  const selector = options['candidate-id'] || options['candidate-url'];
  if (!selector) throw new Error('Explicit --candidate-id or --candidate-url is required');
  return selector;
}

function usage() {
  return [
    'Usage:',
    '  node application-batch.mjs create --source-run <run-id> [--batch-id <batch-id>] --candidate-id <exact-id> [--candidate-id <exact-id> ...]',
    '  node application-batch.mjs create --source-run <run-id> [--batch-id <batch-id>] --url <exact-url> [--url <exact-url> ...]',
    '  Creation refuses company+role duplicates in the tracker or non-abandoned batches; use --allow-duplicate "<reason>" to override.',
    '  node application-batch.mjs bind-artifact --manifest <manifest.json> (--candidate-id <id>|--candidate-url <url>) --type <cv|cover_letter|cover_letter_text|combined_document> --file <output/path> [--source-cv-variant <variant>] [--created-at <ISO>] [--replace]',
    '  node application-batch.mjs preflight --manifest <manifest.json> [--confirm-batch <exact-batch-id>]',
    '  Progress states are written only by the locked canonical browser executor; operators may not attest form_prepared.',
  ].join('\n');
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  if (command === 'create') {
    const options = parseOptions(argv, {
      repeated: ['candidate-id', 'url'],
      allowed: ['source-run', 'batch-id', 'candidate-id', 'url', 'allow-duplicate'],
    });
    const result = createApplicationBatch({
      sourceRunId: options['source-run'],
      batchId: options['batch-id'] || null,
      selectedCandidateIds: options['candidate-id'],
      selectedUrls: options.url,
      allowDuplicateReason: options['allow-duplicate'] ?? null,
    });
    console.log(JSON.stringify({
      batchId: result.manifest.batchId,
      sourceRunId: result.manifest.sourceRunId,
      candidateCount: result.manifest.expectedCandidateCount,
      manifest: result.manifestPath,
      state: result.statePath,
    }, null, 2));
    return;
  }
  if (command === 'bind-artifact') {
    const options = parseOptions(argv, {
      allowed: ['manifest', 'candidate-id', 'candidate-url', 'type', 'file', 'source-cv-variant', 'created-at'],
      flags: ['replace'],
    });
    const record = bindCandidateArtifact(options.manifest, selectorFromOptions(options), {
      artifactType: options.type,
      filePath: options.file,
      sourceCvVariant: options['source-cv-variant'] || null,
      createdAt: options['created-at'] || null,
      replace: options.replace || false,
    });
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  if (command === 'preflight') {
    const options = parseOptions(argv, { allowed: ['manifest', 'confirm-batch'] });
    const loaded = loadBatchState(options.manifest);
    currentScope(loaded, { root: ROOT, requireCv: false });
    console.log(formatPreflight(loaded.manifest, loaded.state));
    if (!options['confirm-batch']) {
      console.error(`\nNot confirmed. After explicit user approval, re-run with --confirm-batch ${loaded.manifest.batchId}`);
      process.exitCode = 2;
      return;
    }
    const confirmation = confirmPreflight(options.manifest, options['confirm-batch']);
    console.log(`\nConfirmed at ${confirmation.confirmedAt}. Browser execution is enabled for this exact hashed scope.`);
    return;
  }
  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
