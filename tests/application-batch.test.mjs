import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  EXECUTION_STATES,
  acquireBatchExecutionLock,
  bindCandidateArtifact,
  confirmPreflight,
  createApplicationBatch,
  formatPreflight,
  loadBatchState,
  loadExecutionContract,
  transitionCandidateState,
} from '../application-batch.mjs';
import { deriveCandidateId } from '../candidate-identity.mjs';

const RUN_ID = '2026-07-12-3-agent-discovery-02';
const OTHER_RUN_ID = 'different-run';
const EXCLUDED_EXAMPLE = 'https://fixture.invalid/jobs/excluded-example';
const SELECTED_SIX = [
  'https://job-boards.greenhouse.io/wolt/jobs/8035172',
  'https://job-boards.greenhouse.io/imc/jobs/4580757101',
  'https://www.arbeitnow.com/jobs/companies/nfon/machine-learning-engineer-all-genders-193991',
  'https://www.arbeitnow.com/jobs/companies/nfon/voice-ai-engineer-all-genders-193990',
  'https://himalayas.app/companies/mercor/jobs/python-developer-fully-remote',
  'https://job-boards.greenhouse.io/imc/jobs/4580758101',
];
const STALE_DANISH = 'https://example.test/danish-endurance';
const STALE_PERSOHAP = 'https://example.test/persohap';

function row(company, title, url, runId = RUN_ID, extra = {}) {
  const candidate = {
    company,
    title,
    url,
    source: url.includes('greenhouse') ? 'Greenhouse' : 'fixture-provider',
    recommendedCvVariant: 'software_backend',
    run_id: runId,
    ...extra,
  };
  candidate.candidate_id = deriveCandidateId(candidate);
  return candidate;
}

function writeRun(root, runId, candidates, { includeIds = true } = {}) {
  const runDir = join(root, 'output', 'scan-runs', runId);
  mkdirSync(runDir, { recursive: true });
  const stored = candidates.map((candidate) => {
    if (includeIds) return candidate;
    const { candidate_id, run_id, ...legacy } = candidate;
    return legacy;
  });
  writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify({ runId, run_id: runId, candidates: stored.length }, null, 2)}\n`);
  writeFileSync(join(runDir, 'candidates.json'), `${JSON.stringify(stored, null, 2)}\n`);
  return runDir;
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-application-batch-'));
  const candidates = [
    row('Excluded Example', 'Synthetic Data Intern', EXCLUDED_EXAMPLE),
    row('Wolt', 'Backend Engineer', SELECTED_SIX[0]),
    row('IMC', 'Graduate Software Engineer (2026) — Aarhus', SELECTED_SIX[1]),
    row('NFON', 'Machine Learning Engineer (all genders)', SELECTED_SIX[2]),
    row('NFON', 'Voice AI Engineer (all genders)', SELECTED_SIX[3]),
    row('Mercor', 'Python Developer - Fully Remote', SELECTED_SIX[4]),
    row('IMC', 'Graduate Software Engineer (2026) — Amsterdam', SELECTED_SIX[5]),
  ];
  writeRun(root, RUN_ID, candidates);
  writeRun(root, OTHER_RUN_ID, [row('Other', 'Unrelated Role', 'https://jobs.example.test/other/1', OTHER_RUN_ID)]);
  writeFileSync(join(root, 'output', 'apply-queue.csv'), [
    'rank,company,role,url',
    `1,DANISH ENDURANCE,Junior Analytics Engineer,${STALE_DANISH}`,
    `17,Legacy Example B GmbH,Software Engineer,${STALE_PERSOHAP}`,
  ].join('\n'));
  const docs = join(root, 'output', 'application documents');
  mkdirSync(docs, { recursive: true });
  const cv = join(docs, 'Alex Example Backend CV.pdf');
  const replacementCv = join(docs, 'Alex Example Software CV.pdf');
  const cover = join(docs, 'Wolt Cover Letter.pdf');
  writeFileSync(cv, 'cv-v1');
  writeFileSync(replacementCv, 'cv-v2');
  writeFileSync(cover, 'cover-v1');
  return { root, candidates, cv, replacementCv, cover };
}

function withFixture(callback) {
  const fixture = makeFixture();
  try {
    return callback(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function createOne(fixture, batchId = 'phase-two-one') {
  const candidate = fixture.candidates[1];
  return createApplicationBatch({
    root: fixture.root,
    sourceRunId: RUN_ID,
    batchId,
    selectedCandidateIds: [candidate.candidate_id],
    now: new Date('2026-07-01T08:00:00.000Z'),
  });
}

function bindCvAndConfirm(fixture, created) {
  const candidateId = created.manifest.candidates[0].candidate_id;
  bindCandidateArtifact(created.manifestPath, candidateId, {
    root: fixture.root,
    artifactType: 'cv',
    filePath: fixture.cv,
  });
  confirmPreflight(created.manifestPath, created.manifest.batchId, { root: fixture.root });
  return candidateId;
}

function executorTransition(fixture, created, candidateId, toState, options) {
  const lock = acquireBatchExecutionLock(created.manifestPath, {
    root: fixture.root, candidateId, operation: 'prepare_application',
  });
  try {
    return transitionCandidateState(created.manifestPath, candidateId, toState, {
      root: fixture.root, lockToken: lock.token, ...options,
    });
  } finally {
    lock.release();
  }
}

test('July 12 batch contains exactly six selected IDs and excludes the synthetic unselected row and stale queue rows', () => withFixture((fixture) => {
  const selected = fixture.candidates.slice(1).map((candidate) => candidate.candidate_id);
  const result = createApplicationBatch({
    root: fixture.root,
    sourceRunId: RUN_ID,
    batchId: 'july-12-selected-six-v2',
    selectedCandidateIds: selected,
  });
  assert.equal(result.manifest.schemaVersion, 2);
  assert.equal(result.manifest.expectedCandidateCount, 6);
  assert.deepEqual(result.manifest.candidates.map((candidate) => candidate.candidate_id), selected);
  assert.deepEqual(result.manifest.candidates.map((candidate) => candidate.run_id), Array(6).fill(RUN_ID));
  const serialized = readFileSync(result.manifestPath, 'utf8');
  assert.equal(serialized.includes('Excluded Example'), false);
  assert.equal(serialized.includes('DANISH ENDURANCE'), false);
  assert.equal(serialized.includes('Legacy Example B'), false);
  assert.match(result.manifest.sourceIntegrity.manifest.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.manifest.sourceIntegrity.candidates.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.manifest.scopeHash, /^sha256:[a-f0-9]{64}$/);
}));

test('exact ID is preferred while URL aliases remain backward compatible', () => withFixture((fixture) => {
  const selected = fixture.candidates[1];
  const byId = createApplicationBatch({
    root: fixture.root, sourceRunId: RUN_ID, batchId: 'by-id', selectedCandidateIds: [selected.candidate_id],
  });
  const byUrl = createApplicationBatch({
    root: fixture.root, sourceRunId: RUN_ID, batchId: 'by-url', selectedUrls: [selected.url],
  });
  assert.equal(byId.manifest.candidates[0].candidate_id, selected.candidate_id);
  assert.equal(byUrl.manifest.candidates[0].candidate_id, selected.candidate_id);
}));

test('application-batch directory remains immutable and cannot be overwritten', () => withFixture((fixture) => {
  const args = {
    root: fixture.root,
    sourceRunId: RUN_ID,
    batchId: 'immutable-application-batch',
    selectedCandidateIds: [fixture.candidates[1].candidate_id],
  };
  createApplicationBatch(args);
  assert.throws(() => createApplicationBatch(args), /EEXIST|file already exists/i);
}));

test('preflight confirmation requires the exact batch ID', () => withFixture((fixture) => {
  const created = createOne(fixture, 'exact-confirmation-id');
  assert.throws(
    () => confirmPreflight(created.manifestPath, 'different-batch-id', { root: fixture.root }),
    /repeat the exact batch ID/,
  );
}));

test('batch execution lock permits only one active candidate invocation', () => withFixture((fixture) => {
  const created = createOne(fixture, 'single-executor-lock');
  const first = acquireBatchExecutionLock(created.manifestPath, { root: fixture.root });
  try {
    assert.throws(
      () => acquireBatchExecutionLock(created.manifestPath, { root: fixture.root }),
      /already executing/,
    );
  } finally {
    first.release();
  }
  const next = acquireBatchExecutionLock(created.manifestPath, { root: fixture.root });
  next.release();
}));

test('dead execution locks recover conservatively and old owners cannot delete successors', () => withFixture((fixture) => {
  const created = createOne(fixture, 'stale-executor-lock');
  const first = acquireBatchExecutionLock(created.manifestPath, { root: fixture.root });
  const ownerPath = join(first.lockPath, 'owner.json');
  const deadOwner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  deadOwner.pid = 2_147_483_647;
  writeFileSync(ownerPath, `${JSON.stringify(deadOwner)}\n`);
  const recoveryPath = `${first.lockPath}.recovery`;
  mkdirSync(recoveryPath);
  utimesSync(recoveryPath, new Date('2000-01-01T00:00:00.000Z'), new Date('2000-01-01T00:00:00.000Z'));
  const successor = acquireBatchExecutionLock(created.manifestPath, { root: fixture.root, staleAfterMs: 100 });
  assert.equal(successor.staleRecovered, true);
  first.release();
  assert.throws(
    () => acquireBatchExecutionLock(created.manifestPath, { root: fixture.root }),
    /already executing/,
  );
  successor.release();
}));

test('execution lock heartbeat and process-start identity protect against PID reuse', () => withFixture((fixture) => {
  const created = createOne(fixture, 'pid-reuse-lock');
  const candidateId = bindCvAndConfirm(fixture, created);
  const first = acquireBatchExecutionLock(created.manifestPath, {
    root: fixture.root, candidateId, operation: 'prepare_application',
  });
  const ownerPath = join(first.lockPath, 'owner.json');
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  const heartbeat = first.heartbeat(new Date('2026-07-13T12:00:00.000Z'));
  assert.equal(heartbeat, '2026-07-13T12:00:00.000Z');
  const changed = JSON.parse(readFileSync(ownerPath, 'utf8'));
  changed.processStartKey = 'reused-pid-start-key';
  writeFileSync(ownerPath, JSON.stringify(changed));
  const successor = acquireBatchExecutionLock(created.manifestPath, {
    root: fixture.root,
    candidateId,
    operation: 'prepare_application',
    processStartKeyForPid: () => owner.processStartKey,
  });
  assert.equal(successor.staleRecovered, true);
  first.release();
  assert.throws(() => acquireBatchExecutionLock(created.manifestPath, {
    root: fixture.root, candidateId, operation: 'prepare_application',
  }), /already executing/);
  successor.release();
}));

test('persistent candidate claim blocks cross-batch hijacking until explicit close', () => withFixture((fixture) => {
  const firstBatch = createOne(fixture, 'candidate-claim-one');
  const secondBatch = createOne(fixture, 'candidate-claim-two');
  const candidateId = bindCvAndConfirm(fixture, firstBatch);
  bindCvAndConfirm(fixture, secondBatch);
  const first = acquireBatchExecutionLock(firstBatch.manifestPath, {
    root: fixture.root, candidateId, operation: 'prepare_application',
  });
  first.release();
  assert.throws(() => acquireBatchExecutionLock(secondBatch.manifestPath, {
    root: fixture.root, candidateId, operation: 'prepare_application',
  }), /already claimed by application batch candidate-claim-one/);
  const closeLock = acquireBatchExecutionLock(firstBatch.manifestPath, {
    root: fixture.root, candidateId, operation: 'state_transition',
  });
  transitionCandidateState(firstBatch.manifestPath, candidateId, 'closed', {
    root: fixture.root,
    currentUrl: SELECTED_SIX[0],
    reason: 'User explicitly abandoned this application.',
    expectedFrom: 'not_opened',
    lockToken: closeLock.token,
  });
  closeLock.release();
  const second = acquireBatchExecutionLock(secondBatch.manifestPath, {
    root: fixture.root, candidateId, operation: 'prepare_application',
  });
  second.release();
}));

test('a paused candidate prevents another candidate from entering browser execution', () => withFixture((fixture) => {
  const candidates = fixture.candidates.slice(1, 3);
  const created = createApplicationBatch({
    root: fixture.root,
    sourceRunId: RUN_ID,
    batchId: 'paused-candidate-exclusion',
    selectedCandidateIds: candidates.map((row) => row.candidate_id),
  });
  for (const candidate of candidates) {
    bindCandidateArtifact(created.manifestPath, candidate.candidate_id, {
      root: fixture.root, artifactType: 'cv', filePath: fixture.cv,
    });
  }
  confirmPreflight(created.manifestPath, created.manifest.batchId, { root: fixture.root });
  executorTransition(fixture, created, candidates[0].candidate_id, 'login_required', {
    currentUrl: candidates[0].url, reason: 'login gate verified',
  });
  assert.throws(
    () => loadExecutionContract(created.manifestPath, candidates[1].candidate_id, { root: fixture.root }),
    /Another candidate.*paused at login_required/,
  );
}));

test('URL selection rejects an alias shared ambiguously by two distinct candidates', () => withFixture((fixture) => {
  const runId = 'ambiguous-url-run';
  const sharedAlias = 'https://mirror.example.test/shared-role';
  const first = row('Alpha', 'Engineer', 'https://careers.alpha.test/jobs/1', runId, {
    url_aliases: ['https://careers.alpha.test/jobs/1', sharedAlias],
  });
  const second = row('Beta', 'Engineer', 'https://careers.beta.test/jobs/2', runId, {
    url_aliases: ['https://careers.beta.test/jobs/2', sharedAlias],
  });
  writeRun(fixture.root, runId, [first, second]);
  assert.throws(
    () => createApplicationBatch({ root: fixture.root, sourceRunId: runId, selectedUrls: [sharedAlias] }),
    /ambiguous in source run/,
  );
}));

test('unknown, cross-run, duplicate, and duplicate-alias selections fail', () => withFixture((fixture) => {
  const selected = fixture.candidates[1];
  const other = JSON.parse(readFileSync(join(fixture.root, 'output', 'scan-runs', OTHER_RUN_ID, 'candidates.json'), 'utf8'))[0];
  assert.throws(
    () => createApplicationBatch({ root: fixture.root, sourceRunId: RUN_ID, selectedCandidateIds: [] }),
    /At least one explicit/,
  );
  assert.throws(
    () => createApplicationBatch({ root: fixture.root, sourceRunId: RUN_ID, selectedCandidateIds: [other.candidate_id] }),
    /Unknown candidate ID in source run/,
  );
  assert.throws(
    () => createApplicationBatch({ root: fixture.root, sourceRunId: RUN_ID, selectedCandidateIds: [selected.candidate_id, selected.candidate_id] }),
    /Duplicate selected candidate IDs/,
  );

  const candidatesPath = join(fixture.root, 'output', 'scan-runs', RUN_ID, 'candidates.json');
  const candidates = JSON.parse(readFileSync(candidatesPath, 'utf8'));
  const alias = 'https://careers.wolt.example/backend';
  candidates[1].original_url = candidates[1].url;
  candidates[1].resolved_url = alias;
  candidates[1].url_aliases = [candidates[1].url, alias];
  candidates[1].candidate_id = deriveCandidateId(candidates[1]);
  writeFileSync(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`);
  assert.throws(
    () => createApplicationBatch({ root: fixture.root, sourceRunId: RUN_ID, selectedUrls: [candidates[1].url, alias] }),
    /resolve to the same candidate/,
  );
}));

test('modified source manifest or candidates fail closed before confirmation and execution', () => withFixture((fixture) => {
  const first = createOne(fixture, 'source-candidates-tamper');
  const candidatesPath = join(fixture.root, 'output', 'scan-runs', RUN_ID, 'candidates.json');
  writeFileSync(candidatesPath, `${readFileSync(candidatesPath, 'utf8')} `);
  assert.throws(
    () => confirmPreflight(first.manifestPath, first.manifest.batchId, { root: fixture.root }),
    /Source candidates\.json integrity mismatch/,
  );
}));

test('modified source run manifest fails closed', () => withFixture((fixture) => {
  const created = createOne(fixture, 'source-manifest-tamper');
  const sourceManifest = join(fixture.root, 'output', 'scan-runs', RUN_ID, 'manifest.json');
  const parsed = JSON.parse(readFileSync(sourceManifest, 'utf8'));
  parsed.note = 'tampered';
  writeFileSync(sourceManifest, `${JSON.stringify(parsed, null, 2)}\n`);
  assert.throws(
    () => confirmPreflight(created.manifestPath, created.manifest.batchId, { root: fixture.root }),
    /Source manifest\.json integrity mismatch/,
  );
}));

test('manifest scope tampering is detected before preflight', () => withFixture((fixture) => {
  const created = createOne(fixture, 'manifest-tamper');
  const manifest = JSON.parse(readFileSync(created.manifestPath, 'utf8'));
  manifest.candidates[0].title = 'Unapproved Role';
  writeFileSync(created.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => loadBatchState(created.manifestPath, { root: fixture.root }), /manifest scope hash mismatch/);
}));

test('artifact binding and replacement invalidate confirmation and bind exact hashes', () => withFixture((fixture) => {
  const created = createOne(fixture, 'artifact-reconfirmation');
  confirmPreflight(created.manifestPath, created.manifest.batchId, { root: fixture.root });
  const candidateId = created.manifest.candidates[0].candidate_id;
  const first = bindCandidateArtifact(created.manifestPath, candidateId, {
    root: fixture.root, artifactType: 'cv', filePath: fixture.cv,
  });
  assert.match(first.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(loadBatchState(created.manifestPath, { root: fixture.root }).state.preflight.status, 'invalidated');
  assert.throws(
    () => loadExecutionContract(created.manifestPath, candidateId, { root: fixture.root }),
    /has not passed explicit preflight confirmation/,
  );
  confirmPreflight(created.manifestPath, created.manifest.batchId, { root: fixture.root });
  assert.equal(loadExecutionContract(created.manifestPath, candidateId, { root: fixture.root }).candidate.artifacts.cv.sha256, first.sha256);

  const replacement = bindCandidateArtifact(created.manifestPath, candidateId, {
    root: fixture.root, artifactType: 'cv', filePath: fixture.replacementCv, replace: true,
  });
  assert.notEqual(first.sha256, replacement.sha256);
  assert.equal(loadBatchState(created.manifestPath, { root: fixture.root }).state.preflight.status, 'invalidated');
}));

test('missing CV binding and post-confirmation artifact replacement fail execution', () => withFixture((fixture) => {
  const missing = createOne(fixture, 'missing-cv');
  confirmPreflight(missing.manifestPath, missing.manifest.batchId, { root: fixture.root });
  assert.throws(
    () => loadExecutionContract(missing.manifestPath, missing.manifest.candidates[0].candidate_id, { root: fixture.root }),
    /no bound CV artifact/,
  );

  const bound = createOne(fixture, 'artifact-file-tamper');
  const candidateId = bindCvAndConfirm(fixture, bound);
  writeFileSync(fixture.cv, 'unapproved replacement bytes');
  assert.throws(
    () => loadExecutionContract(bound.manifestPath, candidateId, { root: fixture.root }),
    /hash or size mismatch/,
  );
}));

test('preflight prints IDs and exact artifact filenames and hashes', () => withFixture((fixture) => {
  const created = createOne(fixture, 'preflight-output');
  bindCandidateArtifact(created.manifestPath, created.manifest.candidates[0].candidate_id, {
    root: fixture.root, artifactType: 'cv', filePath: fixture.cv,
  });
  bindCandidateArtifact(created.manifestPath, created.manifest.candidates[0].candidate_id, {
    root: fixture.root, artifactType: 'cover_letter', filePath: fixture.cover,
  });
  const loaded = loadBatchState(created.manifestPath, { root: fixture.root });
  const output = formatPreflight(loaded.manifest, loaded.state);
  assert.match(output, new RegExp(created.manifest.candidates[0].candidate_id));
  assert.match(output, /Alex Example Backend CV\.pdf \(sha256:/);
  assert.match(output, /Wolt Cover Letter\.pdf \(sha256:/);
}));

test('state schema carries IDs and rejects invalid transitions and Applied status', () => withFixture((fixture) => {
  const created = createOne(fixture, 'state-v2');
  const candidateId = bindCvAndConfirm(fixture, created);
  assert.deepEqual(EXECUTION_STATES, [
    'not_opened', 'listing_verified', 'actual_form_reached', 'form_inspected',
    'fields_filled', 'files_uploaded', 'review_required', 'login_required',
    'form_prepared', 'blocked', 'closed', 'abandoned',
  ]);
  assert.throws(
    () => executorTransition(fixture, created, candidateId, 'actual_form_reached', {
      currentUrl: SELECTED_SIX[0], reason: 'invalid jump',
    }),
    /Invalid state transition/,
  );
  assert.throws(
    () => transitionCandidateState(created.manifestPath, candidateId, 'applied', {
      root: fixture.root, currentUrl: SELECTED_SIX[0], reason: 'not allowed',
    }),
    /Invalid execution state/,
  );
  executorTransition(fixture, created, candidateId, 'listing_verified', {
    currentUrl: SELECTED_SIX[0], reason: 'visible identity matched',
  });
  const state = loadBatchState(created.manifestPath, { root: fixture.root }).state;
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.candidates[0].candidate_id, candidateId);
  assert.equal(state.candidates[0].run_id, RUN_ID);
  assert.equal(state.candidates[0].history.at(-1).from, 'not_opened');
  assert.equal(state.candidates[0].history.at(-1).to, 'listing_verified');
}));

test('positively identified entry interaction failures may route to review_required', () => withFixture((fixture) => {
  const fromListing = createOne(fixture, 'entry-review-from-listing');
  const listingCandidate = bindCvAndConfirm(fixture, fromListing);
  executorTransition(fixture, fromListing, listingCandidate, 'listing_verified', {
    currentUrl: SELECTED_SIX[0], reason: 'identity and safe entry control verified',
  });
  executorTransition(fixture, fromListing, listingCandidate, 'review_required', {
    currentUrl: SELECTED_SIX[0], reason: 'bounded safe entry interaction needs manual review',
  });
  assert.equal(loadBatchState(fromListing.manifestPath, { root: fixture.root }).state.candidates[0].state, 'review_required');

  const fromBlocked = createApplicationBatch({
    root: fixture.root,
    sourceRunId: RUN_ID,
    batchId: 'entry-review-from-blocked',
    selectedCandidateIds: [fixture.candidates[2].candidate_id],
    now: new Date('2026-07-01T08:00:00.000Z'),
  });
  const blockedCandidate = bindCvAndConfirm(fixture, fromBlocked);
  executorTransition(fixture, fromBlocked, blockedCandidate, 'blocked', {
    currentUrl: SELECTED_SIX[1], reason: 'legacy entry interaction blocker',
  });
  executorTransition(fixture, fromBlocked, blockedCandidate, 'review_required', {
    currentUrl: SELECTED_SIX[1], reason: 'fresh safe entry control positively identified',
  });
  assert.equal(loadBatchState(fromBlocked.manifestPath, { root: fixture.root }).state.candidates[0].state, 'review_required');
}));

test('Phase 1 manifest and old scan run normalize without rewriting immutable files', () => withFixture((fixture) => {
  const legacyRun = 'legacy-scan-run';
  const legacyUrl = 'https://jobs.example.test/legacy/42?utm_source=old';
  writeRun(fixture.root, legacyRun, [row('Legacy Co', 'Legacy Role', legacyUrl, legacyRun)], { includeIds: false });
  const batchDir = join(fixture.root, 'output', 'application-batches', 'legacy-phase-one');
  mkdirSync(batchDir, { recursive: true });
  const manifestPath = join(batchDir, 'manifest.json');
  const legacyManifest = {
    schemaVersion: 1,
    batchId: 'legacy-phase-one',
    sourceRunId: legacyRun,
    createdAt: '2026-07-12T00:00:00.000Z',
    expectedCandidateCount: 1,
    candidates: [{
      order: 1, company: 'Legacy Co', title: 'Legacy Role', listingUrl: legacyUrl,
      applyUrl: null, source: 'legacy', initialState: 'not_opened', cv: 'backend', coverLetter: null,
    }],
  };
  const legacyState = {
    schemaVersion: 1,
    batchId: 'legacy-phase-one',
    sourceRunId: legacyRun,
    updatedAt: '2026-07-12T00:00:00.000Z',
    preflight: {
      confirmedAt: '2026-07-12T01:00:00.000Z', confirmedBatchId: 'legacy-phase-one',
      confirmedCandidateCount: 1, confirmedListingUrls: [legacyUrl], confirmedCandidates: [],
    },
    candidates: [{
      listingUrl: legacyUrl, state: 'not_opened', updatedAt: '2026-07-12T00:00:00.000Z',
      currentUrl: legacyUrl, reason: 'Batch created; browser not opened.',
      history: [{ state: 'not_opened', timestamp: '2026-07-12T00:00:00.000Z', currentUrl: legacyUrl, reason: 'Batch created; browser not opened.' }],
    }],
  };
  const originalManifest = `${JSON.stringify(legacyManifest, null, 2)}\n`;
  writeFileSync(manifestPath, originalManifest);
  writeFileSync(join(batchDir, 'state.json'), `${JSON.stringify(legacyState, null, 2)}\n`);

  const loaded = loadBatchState(manifestPath, { root: fixture.root });
  assert.match(loaded.manifest.candidates[0].candidate_id, /^legacy_cand_v1_[a-f0-9]{64}$/);
  assert.equal(loaded.state.preflight.status, 'unconfirmed');
  bindCandidateArtifact(manifestPath, loaded.manifest.candidates[0].candidate_id, {
    root: fixture.root, artifactType: 'cv', filePath: fixture.cv,
  });
  confirmPreflight(manifestPath, 'legacy-phase-one', { root: fixture.root });
  assert.equal(loadExecutionContract(manifestPath, loaded.manifest.candidates[0].candidate_id, { root: fixture.root }).candidate.identityStatus, 'legacy_derived');
  assert.equal(readFileSync(manifestPath, 'utf8'), originalManifest);
  assert.equal(JSON.parse(readFileSync(join(fixture.root, 'output', 'scan-runs', legacyRun, 'candidates.json'), 'utf8'))[0].candidate_id, undefined);
}));

test('unsupported future manifest and state major versions are rejected', () => withFixture((fixture) => {
  const created = createOne(fixture, 'future-schema');
  const manifest = JSON.parse(readFileSync(created.manifestPath, 'utf8'));
  manifest.schemaVersion = 99;
  writeFileSync(created.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => loadBatchState(created.manifestPath, { root: fixture.root }), /Unsupported future application-batch manifest/);

  const stateCreated = createOne(fixture, 'future-state-schema');
  const statePath = join(dirname(stateCreated.manifestPath), 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.schemaVersion = 99;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.throws(() => loadBatchState(stateCreated.manifestPath, { root: fixture.root }), /Unsupported future application-batch state/);
}));

test('Phase 2/3 state reads normalize to v4 in memory without rewriting the old state file', () => withFixture((fixture) => {
  const created = createOne(fixture, 'state-v2-migration');
  const original = JSON.parse(readFileSync(created.statePath, 'utf8'));
  original.schemaVersion = 2;
  for (const candidate of original.candidates) delete candidate.formPreparation;
  writeFileSync(created.statePath, `${JSON.stringify(original, null, 2)}\n`);
  const before = readFileSync(created.statePath, 'utf8');
  const loaded = loadBatchState(created.manifestPath, { root: fixture.root });
  assert.equal(loaded.state.schemaVersion, 4);
  assert.equal(loaded.state.migratedFromSchemaVersion, 2);
  assert.equal(loaded.state.candidates[0].formPreparation, null);
  assert.equal(readFileSync(created.statePath, 'utf8'), before);
}));
