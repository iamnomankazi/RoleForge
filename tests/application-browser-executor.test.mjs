import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bindCandidateArtifact,
  confirmPreflight,
  createApplicationBatch,
  loadBatchState,
  loadExecutionContract,
} from '../application-batch.mjs';
import { deriveCandidateId } from '../candidate-identity.mjs';
import {
  assertExecutorState,
  classifyFormSnapshot,
  executeCandidate,
  isCompatibleDestination,
  listingSnapshotConfirmsSafeEntry,
  parseExecutorArgs,
  preparationGateState,
  requisitionIdentity,
  selectSafeApplyContinuation,
  shouldKeepBrowserOpen,
  verifyVisibleIdentity,
} from '../application-browser-executor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const RUN_ID = 'phase-2-executor-run';
const SELECTED = 'https://job-boards.greenhouse.io/wolt/jobs/8035172';
const UNRELATED = 'https://fixture.invalid/jobs/unrelated-example';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-application-executor-'));
  const runDir = join(root, 'output', 'scan-runs', RUN_ID);
  mkdirSync(runDir, { recursive: true });
  const candidate = {
    company: 'Wolt', title: 'Backend Engineer', url: SELECTED, source: 'Greenhouse',
    recommendedCvVariant: 'software_backend', run_id: RUN_ID,
  };
  candidate.candidate_id = deriveCandidateId(candidate);
  writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify({ runId: RUN_ID, run_id: RUN_ID, candidates: 1 }, null, 2)}\n`);
  writeFileSync(join(runDir, 'candidates.json'), `${JSON.stringify([candidate], null, 2)}\n`);
  writeFileSync(join(root, 'output', 'apply-queue.csv'), `rank,company,role,url\n1,Legacy Example B,Engineer,${UNRELATED}\n`);
  const docs = join(root, 'output', 'documents');
  mkdirSync(docs, { recursive: true });
  const cv = join(docs, 'Alex Example Backend CV.pdf');
  writeFileSync(cv, 'executor-cv');
  return { root, candidate, cv };
}

function withFixture(callback) {
  const fixture = makeFixture();
  try {
    return callback(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function createConfirmed(fixture, batchId = 'confirmed-batch', options = {}) {
  const created = createApplicationBatch({
    root: fixture.root,
    sourceRunId: RUN_ID,
    batchId,
    selectedCandidateIds: [fixture.candidate.candidate_id],
    ...options,
  });
  bindCandidateArtifact(created.manifestPath, fixture.candidate.candidate_id, {
    root: fixture.root, artifactType: 'cv', filePath: fixture.cv,
  });
  confirmPreflight(created.manifestPath, batchId, { root: fixture.root });
  return created;
}

test('executor requires a manifest and never falls back to global queue', () => withFixture((fixture) => {
  assert.throws(
    () => loadExecutionContract('output/application-batches/missing/manifest.json', UNRELATED, { root: fixture.root }),
    /manifest not found/,
  );
}));

test('executor accepts only the exact candidate ID and rejects URL authority', () => withFixture((fixture) => {
  const created = createConfirmed(fixture, 'exact-id');
  assert.equal(loadExecutionContract(created.manifestPath, fixture.candidate.candidate_id, { root: fixture.root }).candidate.listingUrl, SELECTED);
  assert.throws(
    () => loadExecutionContract(created.manifestPath, UNRELATED, { root: fixture.root }),
    /not a supported versioned candidate ID/,
  );
}));

test('executor fails before browser work when preflight, source, or artifacts drift', () => withFixture((fixture) => {
  const unconfirmed = createApplicationBatch({
    root: fixture.root, sourceRunId: RUN_ID, batchId: 'unconfirmed', selectedCandidateIds: [fixture.candidate.candidate_id],
  });
  assert.throws(
    () => loadExecutionContract(unconfirmed.manifestPath, fixture.candidate.candidate_id, { root: fixture.root }),
    /has not passed explicit preflight confirmation/,
  );

  const confirmed = createConfirmed(fixture, 'source-drift', {
    allowDuplicateReason: 'Exercise source drift independently of the unconfirmed fixture batch.',
  });
  const sourceCandidates = join(fixture.root, 'output', 'scan-runs', RUN_ID, 'candidates.json');
  writeFileSync(sourceCandidates, `${readFileSync(sourceCandidates, 'utf8')} `);
  assert.throws(
    () => loadExecutionContract(confirmed.manifestPath, fixture.candidate.candidate_id, { root: fixture.root }),
    /integrity mismatch/,
  );
}));

test('executor fails when the confirmed immutable source run disappears', () => withFixture((fixture) => {
  const created = createConfirmed(fixture, 'missing-source-run');
  rmSync(join(fixture.root, 'output', 'scan-runs', RUN_ID, 'candidates.json'));
  assert.throws(
    () => loadExecutionContract(created.manifestPath, fixture.candidate.candidate_id, { root: fixture.root }),
    /does not exist|lacks manifest\.json\/candidates\.json/,
  );
}));

test('post-confirmation manifest metadata tampering fails before browser work', () => withFixture((fixture) => {
  const created = createConfirmed(fixture, 'post-confirmation-manifest-tamper');
  const manifest = JSON.parse(readFileSync(created.manifestPath, 'utf8'));
  manifest.candidates[0].title = 'Different Unapproved Role';
  writeFileSync(created.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(
    () => loadExecutionContract(created.manifestPath, fixture.candidate.candidate_id, { root: fixture.root }),
    /manifest scope hash mismatch/,
  );
}));

test('a candidate-scoped runtime failure is recorded blocked and releases execution ownership', async () => {
  const fixture = makeFixture();
  try {
    const coverPdf = join(fixture.root, 'output', 'documents', 'Wolt Backend Engineer Cover Letter.pdf');
    const coverText = join(fixture.root, 'output', 'documents', 'Wolt Backend Engineer Cover Letter.txt');
    writeFileSync(coverPdf, 'executor-cover-pdf');
    writeFileSync(coverText, 'Executor cover text');
    const created = createApplicationBatch({
      root: fixture.root,
      sourceRunId: RUN_ID,
      batchId: 'runtime-failure',
      selectedCandidateIds: [fixture.candidate.candidate_id],
    });
    for (const binding of [
      { artifactType: 'cv', filePath: fixture.cv },
      { artifactType: 'cover_letter', filePath: coverPdf },
      { artifactType: 'cover_letter_text', filePath: coverText },
    ]) {
      bindCandidateArtifact(created.manifestPath, fixture.candidate.candidate_id, {
        root: fixture.root,
        ...binding,
      });
    }
    confirmPreflight(created.manifestPath, created.manifest.batchId, { root: fixture.root });
    let launches = 0;
    await assert.rejects(
      executeCandidate({
        manifest: created.manifestPath,
        candidateId: fixture.candidate.candidate_id,
        headless: true,
        keepOpen: false,
        resumeLogin: false,
        resumePreparation: false,
        prepareForm: false,
      }, {
        root: fixture.root,
        dependencies: {
          checkLivenessViaApi: async () => {
            throw new Error('fixture liveness transport failure');
          },
          launchBrowser: async () => {
            launches += 1;
            throw new Error('browser should not launch');
          },
        },
      }),
      /fixture liveness transport failure/,
    );
    assert.equal(launches, 0);
    const state = loadBatchState(created.manifestPath, { root: fixture.root }).state.candidates[0];
    assert.equal(state.state, 'blocked');
    assert.match(state.reason, /stopped safely before opening.*fixture liveness transport failure/i);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('executor CLI prefers candidate ID and exposes no submit, Applied, or queue option', () => {
  const candidateId = `cand_v1_${'a'.repeat(64)}`;
  assert.deepEqual(
    parseExecutorArgs(['--manifest', 'output/application-batches/x/manifest.json', '--candidate-id', candidateId]),
    { headless: false, keepOpen: true, resumeLogin: false, resumePreparation: false, prepareForm: true, ephemeralBrowser: false, manifest: 'output/application-batches/x/manifest.json', candidateId },
  );
  assert.throws(
    () => parseExecutorArgs(['--manifest', 'x', '--candidate-url', SELECTED]),
    /Unknown or forbidden option/,
  );
  assert.equal(parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--ephemeral-browser',
  ]).ephemeralBrowser, true);
  assert.throws(() => parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--ephemeral-browser', '--ephemeral-browser',
  ]), /Duplicate option/);
  for (const forbidden of ['--url', '--submit', '--send', '--mark-applied', '--queue']) {
    assert.throws(
      () => parseExecutorArgs(['--manifest', 'x', '--candidate-id', candidateId, forbidden, 'value']),
      /Unknown or forbidden option/,
    );
  }
  const source = readFileSync(join(REPO, 'application-browser-executor.mjs'), 'utf8');
  for (const forbidden of ['output/apply-queue.csv', 'scripts/mark-applied.mjs', 'set-status.mjs', 'data/applications.md']) {
    assert.equal(source.includes(forbidden), false);
  }
  assert.doesNotMatch(source, /storageState|connectOverCDP|wsEndpoint|browserWSEndpoint/);
});

test('normal preparation stays headed and open, while inspect-only may close or run headless', () => {
  const candidateId = `cand_v1_${'c'.repeat(64)}`;
  assert.throws(() => parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--close-after-check',
  ]), /headed browser that remains open/);
  assert.throws(() => parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--headless',
  ]), /headed browser that remains open/);
  assert.equal(parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--inspect-only', '--close-after-check',
  ]).keepOpen, false);
  assert.equal(parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--inspect-only', '--headless',
  ]).headless, true);
});

test('CAPTCHA gate states and browser pause lifecycle preserve review ownership', () => {
  assert.equal(preparationGateState({ gate: { state: 'blocked' } }), 'blocked');
  assert.equal(preparationGateState({ gate: { state: 'review_required' } }), 'review_required');
  assert.equal(preparationGateState({ gate: { state: 'login_required' } }), 'login_required');
  assert.equal(shouldKeepBrowserOpen({ state: 'review_required' }), true);
  assert.equal(shouldKeepBrowserOpen({
    state: 'blocked',
    formPreparation: { captcha: { manualActionRequired: true } },
  }), true);
  assert.equal(shouldKeepBrowserOpen({ state: 'blocked', formPreparation: null }), false);
  assert.equal(shouldKeepBrowserOpen({ state: 'abandoned' }), false);
});

test('login resume is bound to the same exact candidate and paused state', () => {
  const candidateId = `cand_v1_${'a'.repeat(64)}`;
  const options = parseExecutorArgs([
    '--manifest', 'output/application-batches/x/manifest.json', '--candidate-id', candidateId, '--resume-login',
  ]);
  assert.equal(options.resumeLogin, true);
  assert.equal(assertExecutorState(options, { candidateState: { state: 'login_required' } }), 'login_required');
  assert.throws(() => assertExecutorState(options, { candidateState: { state: 'not_opened' } }), /requires login_required/);
  assert.throws(() => parseExecutorArgs([
    '--manifest', 'x', '--candidate-url', SELECTED, '--resume-login',
  ]), /Unknown or forbidden option/);
  assert.throws(() => parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--resume-login', '--headless',
  ]), /headed (?:task )?browser/);
  assert.throws(() => parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--resume-login', '--close-after-check',
  ]), /remains open|remains? open/);
});

test('preparation resume is limited to the same candidate review/progress/blocked states', () => {
  const candidateId = `cand_v1_${'b'.repeat(64)}`;
  const options = parseExecutorArgs([
    '--manifest', 'output/application-batches/x/manifest.json', '--candidate-id', candidateId, '--resume-preparation',
  ]);
  assert.equal(options.resumePreparation, true);
  assert.equal(assertExecutorState(options, { candidateState: { state: 'review_required' } }), 'review_required');
  assert.equal(assertExecutorState(options, { candidateState: { state: 'actual_form_reached' } }), 'actual_form_reached');
  assert.equal(assertExecutorState(options, { candidateState: { state: 'blocked' } }), 'blocked');
  assert.throws(() => assertExecutorState(options, { candidateState: { state: 'not_opened' } }), /requires actual_form_reached, review_required, or blocked/);
  assert.throws(() => parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--resume-login', '--resume-preparation',
  ]), /one resume mode/);
});

test('visible identity requires both manifest company and title', () => {
  const candidate = { company: 'Wolt', title: 'Backend Engineer' };
  assert.equal(verifyVisibleIdentity({
    documentTitle: 'Backend Engineer | Wolt Careers', headings: ['Backend Engineer'], bodyText: 'Join Wolt.',
  }, candidate).verified, true);
  assert.equal(verifyVisibleIdentity({ bodyText: 'Generic engineering jobs' }, candidate).verified, false);
});

test('compound company identity accepts only meaningful explicit slash aliases', () => {
  const candidate = { company: '1KOMMA5° / Heartbeat AI', title: 'Energy Data Analyst' };
  assert.equal(verifyVisibleIdentity({
    documentTitle: 'Energy Data Analyst | Heartbeat AI', bodyText: 'Join Heartbeat AI.',
  }, candidate).verified, true);
  assert.equal(verifyVisibleIdentity({
    documentTitle: 'Energy Data Analyst', bodyText: 'Join an AI group.',
  }, candidate).verified, false);
  assert.equal(verifyVisibleIdentity({
    documentTitle: 'Different Role | 1KOMMA5°', bodyText: 'Join 1KOMMA5°.',
  }, candidate).verified, false);
});

test('visible company identity accepts omission of a legal corporate suffix', () => {
  const candidate = { company: 'Poppe + Potthoff GmbH', title: 'Junior Data Engineer (m/w/d)' };
  assert.equal(verifyVisibleIdentity({
    documentTitle: 'Junior Data Engineer (m/w/d) - Poppe + Potthoff Karriere',
    bodyText: 'Junior Data Engineer (m/w/d) Application form',
  }, candidate).verified, true);
});

test('fresh executor DOM may confirm a delayed safe entry without changing scanner liveness', () => {
  const listingUrl = 'https://www.linkedin.com/jobs/view/4449325899';
  const candidate = { company: 'Fluxion', title: 'Data Scientist / AI Engineer' };
  const snapshot = {
    currentUrl: listingUrl,
    documentTitle: 'Fluxion hiring Data Scientist / AI Engineer',
    bodyText: 'Fluxion Data Scientist / AI Engineer',
    formCount: 0,
    fields: [],
    controls: [{ tag: 'a', text: 'Apply', visible: true, href: `${listingUrl}/application` }],
  };
  assert.equal(listingSnapshotConfirmsSafeEntry(snapshot, candidate, { listingUrl }), true);
  assert.equal(listingSnapshotConfirmsSafeEntry({ ...snapshot, controls: [{
    tag: 'button', type: 'button', text: 'Apply', visible: true, dataDestination: listingUrl,
  }] }, candidate, { listingUrl }), true);
  assert.equal(listingSnapshotConfirmsSafeEntry({ ...snapshot, bodyText: 'Other company', documentTitle: 'Other company' }, candidate, { listingUrl }), false);
});

test('listing pages, login gates, and actual forms remain distinct', () => {
  assert.equal(classifyFormSnapshot({
    currentUrl: SELECTED, bodyText: 'Backend Engineer. Apply now.', formCount: 1,
    fields: [{ type: 'search', text: 'Search jobs', visible: true }],
  }).actualForm, false);
  const login = classifyFormSnapshot({
    currentUrl: 'https://careers.example.test/login', bodyText: 'Sign in to apply', formCount: 1,
    fields: [{ type: 'password', text: 'Password', visible: true }],
  });
  assert.equal(login.loginRequired, true);
  assert.equal(login.actualForm, false);
  assert.equal(classifyFormSnapshot({
    currentUrl: `${SELECTED}/application`, bodyText: 'Application for Backend Engineer', formCount: 1,
    fields: [
      { type: 'text', text: 'First name', visible: true },
      { type: 'email', text: 'Email', visible: true },
      { type: 'file', text: 'Resume', visible: true },
    ],
  }).actualForm, true);
});

test('opaque HRworks apply form is recognized by its bounded POST terminal structure', () => {
  assert.equal(classifyFormSnapshot({
    currentUrl: 'https://career.example.test/en/apply?id=47e8ae',
    bodyText: 'Junior Data Engineer Application form First name Last name Email Mobile number',
    formCount: 2,
    fields: Array.from({ length: 8 }, (_, index) => ({ type: 'text', text: `Mandatory field-${index}`, visible: true })),
    controls: [{
      tag: 'a', text: 'Submit application', visible: true, inForm: true,
      associatedForm: true, formMethod: 'post',
    }],
  }).actualForm, true);
});

test('safe listing entries are eligible and final controls remain unavailable', () => {
  const safe = {
    index: 0, tag: 'a', type: '', text: 'Apply now', href: 'https://jobs.lever.co/acme/application', inForm: false, visible: true,
  };
  const listingScope = {
    listingUrl: SELECTED,
    applyUrl: safe.href,
    currentState: 'listing_verified',
    actualFormReached: false,
    candidateFieldSignals: 0,
  };
  assert.deepEqual(selectSafeApplyContinuation([safe], listingScope), safe);
  assert.equal(selectSafeApplyContinuation([
    { ...safe, inForm: true },
    { ...safe, tag: 'button', type: 'submit', text: 'Apply' },
    { ...safe, text: 'Submit application' },
    { ...safe, text: 'Send' },
  ], { ...listingScope, actualFormReached: true }), null);
  assert.equal(selectSafeApplyContinuation([
    { ...safe, href: 'http://127.0.0.1/application' },
    { ...safe, href: 'mailto:jobs@example.test' },
    { ...safe, href: 'https://job-boards.greenhouse.io/submit-application' },
    { ...safe, href: 'https://unrelated.example.test/application' },
  ], { ...listingScope, applyUrl: null }), null);
});

test('cross-host redirects retain requisition identity checks', () => {
  const applyUrl = 'https://ats.example.test/application/123';
  assert.equal(isCompatibleDestination({ listingUrl: SELECTED, currentUrl: `${SELECTED}/application`, identity: { verified: false } }), true);
  assert.equal(isCompatibleDestination({ listingUrl: SELECTED, applyUrl, currentUrl: applyUrl, identity: { verified: false } }), true);
  assert.equal(isCompatibleDestination({
    listingUrl: SELECTED, currentUrl: 'https://job-boards.greenhouse.io/wolt/jobs/9999999', identity: { verified: false },
  }), false);
  assert.equal(requisitionIdentity(SELECTED), 'greenhouse:wolt:8035172');
  assert.equal(requisitionIdentity(`${SELECTED}/application`), 'greenhouse:wolt:8035172');
});
