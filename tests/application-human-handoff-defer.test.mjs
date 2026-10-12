import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireBatchExecutionLock, bindCandidateArtifact, confirmPreflight,
  createApplicationBatch, loadBatchState, transitionCandidateState,
} from '../application-batch.mjs';
import { deriveCandidateId } from '../candidate-identity.mjs';
import { executeCandidate, executeCandidateInBrowserContext } from '../application-browser-executor.mjs';

const LISTING = 'https://fixture.roleforge.test/apply/1';
const ENTRY = 'https://fixture.roleforge.test/application/1';
const GATES = {
  captcha: { bodyText: 'Human verification', captchaSignals: {
    present: true, elements: [{ visible: true, interactive: true, blockingOverlay: true }],
  } },
  login: { bodyText: 'Sign in to apply', fields: [{ type: 'password', label: 'Password', text: 'Password' }] },
  mfa: { bodyText: 'Enter your one-time code' },
  email_verification: { bodyText: 'Verify your email; check your inbox' },
  account_creation: { bodyText: 'Create an account to apply' },
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'roleforge-handoff-defer-'));
  const runId = 'synthetic-defer-run';
  const runDir = join(root, 'output', 'scan-runs', runId);
  mkdirSync(runDir, { recursive: true });
  const candidate = { company: 'Fixture Company', title: 'Backend Engineer', url: LISTING,
    source: 'fixture', recommendedCvVariant: 'software_backend', run_id: runId };
  candidate.candidate_id = deriveCandidateId(candidate);
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ runId, run_id: runId, candidates: 1 }));
  writeFileSync(join(runDir, 'candidates.json'), JSON.stringify([candidate]));
  const batch = createApplicationBatch({ root, sourceRunId: runId, batchId: 'handoff-defer',
    selectedCandidateIds: [candidate.candidate_id] });
  for (const [artifactType, filename] of [
    ['cv', 'Synthetic CV.pdf'], ['cover_letter', 'Synthetic Cover.pdf'], ['cover_letter_text', 'Synthetic Cover.txt'],
  ]) {
    const filePath = join(root, 'output', filename);
    writeFileSync(filePath, 'Synthetic fixture artifact.');
    bindCandidateArtifact(batch.manifestPath, candidate.candidate_id, { root, artifactType, filePath });
  }
  confirmPreflight(batch.manifestPath, batch.manifest.batchId, { root });
  return { root, candidate, batch,
    options: { manifest: batch.manifestPath, candidateId: candidate.candidate_id,
      prepareForm: true, keepOpen: true, humanWaitMs: 3000 },
    state: () => loadBatchState(batch.manifestPath, { root }).state.candidates[0],
    stateBytes: () => readFileSync(join(dirname(batch.manifestPath), 'state.json'), 'utf8'),
    assertUnlocked() {
      assert.equal(existsSync(join(dirname(batch.manifestPath), '.execution.lock')), false);
      const lock = acquireBatchExecutionLock(batch.manifestPath, { root,
        candidateId: candidate.candidate_id, operation: 'prepare_application' });
      lock.release();
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function formSnapshot() {
  return { documentTitle: 'Fixture Company Backend Engineer', headings: ['Fixture Company Backend Engineer'],
    bodyText: 'Fixture Company Backend Engineer', formCount: 1, applicationFormId: 'application',
    fields: [
      { type: 'text', text: 'Full name', label: 'Full name', formId: 'application' },
      { type: 'email', text: 'Email', label: 'Email', formId: 'application' },
    ], controls: [], captchaSignals: {} };
}

function gateSnapshot(cause) {
  return { ...formSnapshot(), formCount: 0, applicationFormId: '', fields: [], ...GATES[cause] };
}

function formEvidence(page, extra = {}) {
  return { schemaVersion: 1, inspectedAt: new Date().toISOString(), reviewedAt: new Date().toISOString(),
    currentUrl: page.url(), formFingerprint: 'sha256:fixture-form', requiredFieldCount: 2,
    filledFields: [{ fieldId: 'name', semantic: 'full_name', verified: true }], committedSelections: [],
    uploadedArtifacts: [], unresolvedFields: [], validationErrors: [], userActionRequired: false,
    finalAction: { detected: true, label: 'Submit application', semanticClass: 'form_submit', activated: false },
    reviewComplete: true, evidenceHash: 'sha256:fixture-evidence', ...extra };
}

// Both snapshot collectors use evaluate; return their DOM signals without a real browser.
function environment(f, initial = gateSnapshot('captcha')) {
  const metrics = { api: 0, liveness: 0, navigation: [], reload: 0, pageClose: 0, browserClose: 0,
    clock: 0, sleep: 0, subscribe: 0, unsubscribe: 0, reviewWait: 0, prepare: 0, snapshots: 0 };
  const logs = [];
  let now = 0;
  let completion;
  const context = { pages: () => [page], browser: () => browser, newPage: async () => page };
  const browser = { isConnected: () => true, close: async () => { metrics.browserClose++; } };
  const page = { snapshot: initial, currentUrl: LISTING, closed: false,
    url: () => page.currentUrl, context: () => context, isClosed: () => page.closed,
    evaluate: async (_callback, argument) => {
      assert.equal(page.closed, false);
      if (!argument) metrics.snapshots++;
      return structuredClone({ ...page.snapshot, url: page.currentUrl, currentUrl: page.currentUrl });
    },
    goto: async (url) => {
      metrics.navigation.push(url);
      page.currentUrl = url;
      if (url === ENTRY) page.snapshot = gateSnapshot('captcha');
    },
    reload: async () => { metrics.reload++; },
    close: async () => { metrics.pageClose++; page.closed = true; },
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
    locator: (selector) => selector === 'iframe[src]' ? {} : {
      count: async () => 1,
      evaluate: async () => structuredClone(page.snapshot.controls[0]),
      scrollIntoViewIfNeeded: async () => {},
      click: async () => { throw new Error('No control may be clicked by this fixture'); },
      focus: async () => { throw new Error('No control may be focused by this fixture'); },
    },
  };
  const dependencies = {
    checkLivenessViaApi: async () => { metrics.api++; return { result: 'active', reason: 'fixture' }; },
    checkUrlLiveness: async (active, url) => {
      assert.equal(active, page);
      metrics.liveness++;
      // The injected initial check observes a page that is already at the listing.
      assert.equal(url, LISTING);
      return { result: 'active', reason: 'fixture' };
    },
    humanClock: () => { metrics.clock++; return now; },
    humanSleep: async (ms) => { metrics.sleep++; await e.onSleep?.(completion); now += ms; },
    subscribeHumanCompletion: (callback) => {
      metrics.subscribe++;
      completion = callback;
      return () => { metrics.unsubscribe++; completion = null; };
    },
    waitForBrowserClose: async () => { metrics.reviewWait++; },
    prepareFormPassWithEvidence: async (active, suppliedContext, contract, root, options) => {
      assert.equal(active, page);
      assert.equal(suppliedContext, context);
      assert.equal(root, f.root);
      assert.equal(contract.candidate.candidate_id, f.candidate.candidate_id);
      metrics.prepare++;
      return e.onPrepare ? e.onPrepare(options) : { evidence: formEvidence(page) };
    },
    log: (line) => logs.push(line),
  };
  const e = { browser, context, page, metrics, logs, dependencies,
    run: (extra = {}) => executeCandidateInBrowserContext({ ...f.options, ...extra },
      { root: f.root, browser, context, page, dependencies }),
  };
  return e;
}

function assertNoHumanWait(e) {
  for (const metric of ['clock', 'sleep', 'subscribe', 'unsubscribe', 'reviewWait', 'reload', 'pageClose', 'browserClose']) {
    assert.equal(e.metrics[metric], 0, metric);
  }
  assert.deepEqual(e.metrics.navigation, []);
}

for (const cause of Object.keys(GATES)) {
  test(`defer listing ${cause}: persist exact pause and return without waiting or changing the tab`, async () => {
    const f = fixture();
    const e = environment(f, gateSnapshot(cause));
    try {
      const result = await e.run({ deferHumanHandoff: true, humanWaitMs: 0 });
      assert.equal(result.state, 'human_action_required');
      assert.equal(result.deferred, true);
      assert.equal(result.candidateId, f.candidate.candidate_id);
      assert.equal(result.submissionAvailable, false);
      const state = f.state();
      assert.deepEqual(state.history.map((event) => event.to), ['not_opened', 'login_required', 'human_action_required']);
      assert.equal(state.humanAction.cause, cause);
      assert.equal(state.humanAction.stage, 'listing');
      assert.equal(state.humanAction.candidate_id, f.candidate.candidate_id);
      assert.equal(state.humanAction.currentUrl, LISTING);
      assert.ok(state.humanAction.evidence.length);
      assert.equal(Object.hasOwn(state, 'deferred'), false, 'deferred is only a result marker');
      assert.equal(e.logs.length, 1);
      assert.match(e.logs[0], /paused for a human check in its own tab/);
      assert.ok(e.logs[0].includes(f.candidate.candidate_id));
      assert.equal(e.metrics.prepare, 0);
      assertNoHumanWait(e);
      f.assertUnlocked();
    } finally { f.cleanup(); }
  });
}

test('defer leaves an executor-owned browser open and skips the review wait', async () => {
  const f = fixture();
  const e = environment(f);
  try {
    const result = await executeCandidate({ ...f.options, deferHumanHandoff: true }, { root: f.root,
      dependencies: { ...e.dependencies, openBrowserProfile: async () => ({ browser: e.browser, context: e.context,
        close: async () => { await e.page.close(); await e.browser.close(); } }) } });
    assert.equal(result.deferred, true);
    assertNoHumanWait(e);
    f.assertUnlocked();
  } finally { f.cleanup(); }
});

test('defer at application entry pauses the exact entry tab after the safe listing continuation', async () => {
  const f = fixture();
  const listing = { ...formSnapshot(), formCount: 0, applicationFormId: '', fields: [], controls: [{
    controlId: 'entry-1', index: 0, tag: 'a', text: 'Apply', href: ENTRY,
    visible: true, attached: true, enabled: true, topmostMatches: true,
    boundingBox: { width: 100, height: 40 },
  }] };
  const e = environment(f, listing);
  try {
    const result = await e.run({ deferHumanHandoff: true });
    assert.equal(result.state, 'human_action_required');
    assert.equal(result.deferred, true);
    assert.equal(f.state().humanAction.stage, 'application_entry');
    assert.equal(f.state().humanAction.currentUrl, ENTRY);
    assert.deepEqual(e.metrics.navigation, [ENTRY], 'only the authorized entry navigation occurred');
    e.metrics.navigation = [];
    assertNoHumanWait(e);
    f.assertUnlocked();
  } finally { f.cleanup(); }
});

test('form progression saves partial evidence before deferring and continues preparation on the same tab', async () => {
  const f = fixture();
  const e = environment(f, formSnapshot());
  e.onPrepare = () => {
    e.page.snapshot = gateSnapshot('mfa');
    return { gate: { state: 'human_action_required', cause: 'mfa', stage: 'form_progression', evidence: ['mfa_text'] },
      evidence: formEvidence(e.page, { reviewComplete: false, progression: {
        stepsAdvanced: 1, transitions: [{ beforeUrl: LISTING, currentUrl: LISTING }], visitedFingerprints: ['step-1'],
      } }) };
  };
  try {
    const result = await e.run({ deferHumanHandoff: true });
    assert.equal(result.state, 'human_action_required');
    assert.equal(result.deferred, true);
    assert.equal(f.state().humanAction.stage, 'form_progression');
    const partial = f.state().formPreparation;
    assert.equal(partial.progression.stepsAdvanced, 1);
    assert.equal(partial.filledFields.length, 1);
    assert.equal(partial.finalAction.activated, false);
    assert.equal(partial.reviewComplete, false);
    assert.equal(partial.userActionRequired, true);
    assert.equal(partial.browserOpenRequired, true);
    assert.equal(f.state().formPreparationHistory.length, 1);
    assertNoHumanWait(e);
    f.assertUnlocked();
    e.dependencies.checkUrlLiveness = async () => { throw new Error('Same-tab resume must not navigate'); };
    e.onSleep = (signal) => {
      assert.equal(f.state().state, 'human_action_required');
      e.page.snapshot = formSnapshot();
      signal();
    };
    e.onPrepare = (options) => {
      assert.deepEqual(options.previousEvidence, partial);
      assert.equal(options.resumeMode, 'process_recovery');
      return { evidence: formEvidence(e.page) };
    };
    const resumed = await e.run({ continueOnPage: true, resumePreparation: true });
    assert.equal(resumed.state, 'form_prepared');
    assert.equal(Object.hasOwn(resumed, 'deferred'), false);
    assert.equal(e.metrics.prepare, 2);
    assert.equal(e.metrics.sleep, 1);
    assert.equal(e.metrics.subscribe, 1);
    assert.equal(e.metrics.unsubscribe, 1);
    assert.equal(e.metrics.api, 3, 'initial check, resume check, and fresh handoff revalidation');
    assert.deepEqual(e.metrics.navigation, []);
    assert.equal(e.metrics.reload + e.metrics.pageClose + e.metrics.browserClose, 0);
    const checks = f.state().history.find((event) => event.from === 'human_action_required').details.humanActionRevalidation;
    assert.deepEqual(checks, { candidate_id: f.candidate.candidate_id, listingLive: true,
      identityVerified: true, destinationCompatible: true, gateCleared: true, formVerified: true });
    f.assertUnlocked();
  } finally { f.cleanup(); }
});

test('continueOnPage resumes an already-cleared gate without waiting, navigation, or a replacement page', async () => {
  const f = fixture();
  const e = environment(f);
  try {
    await e.run({ deferHumanHandoff: true });
    e.page.snapshot = formSnapshot();
    e.context.newPage = async () => { throw new Error('No replacement page'); };
    e.dependencies.checkUrlLiveness = async () => { throw new Error('No listing navigation'); };
    const result = await e.run({ resumePreparation: true, continueOnPage: true });
    assert.equal(result.state, 'form_prepared');
    assert.equal(e.metrics.subscribe, 1);
    assert.equal(e.metrics.unsubscribe, 1);
    assert.equal(e.metrics.sleep, 0);
    assert.equal(e.metrics.api, 3);
    assert.deepEqual(e.metrics.navigation, []);
    f.assertUnlocked();
  } finally { f.cleanup(); }
});

test('fresh preparation resume also records partial evidence and returns the deferred marker', async () => {
  const f = fixture();
  const e = environment(f, formSnapshot());
  try {
    const reached = await e.run({ prepareForm: false });
    assert.equal(reached.state, 'actual_form_reached');
    e.onPrepare = () => {
      e.page.snapshot = gateSnapshot('email_verification');
      return { gate: { state: 'human_action_required', cause: 'email_verification',
        stage: 'form_review', evidence: ['email_verification_text'] }, evidence: formEvidence(e.page) };
    };
    const result = await e.run({ resumePreparation: true, deferHumanHandoff: true });
    assert.equal(result.state, 'human_action_required');
    assert.equal(result.deferred, true);
    assert.equal(f.state().humanAction.stage, 'form_review');
    assert.equal(f.state().formPreparation.reviewComplete, false);
    assert.equal(f.state().formPreparation.filledFields.length, 1);
    assert.equal(e.metrics.liveness, 2, 'default resume still checks the listing');
    assertNoHumanWait(e);
    f.assertUnlocked();
  } finally { f.cleanup(); }
});

for (const reason of ['page_closed', 'page_closed_during_snapshot', 'unrelated_host', 'unrelated_route', 'identity_mismatch']) {
  test(`continueOnPage skips ${reason} without navigation or persisted changes`, async () => {
    const f = fixture();
    const e = environment(f);
    try {
      if (reason === 'identity_mismatch') {
        // A same-origin gate route requires visible identity when it is not a manifest URL.
        e.page.currentUrl = 'https://fixture.roleforge.test/verification';
      }
      await e.run({ deferHumanHandoff: true });
      if (reason === 'page_closed') e.page.closed = true;
      else {
        e.page.snapshot = formSnapshot();
        if (reason === 'page_closed_during_snapshot') {
          const evaluate = e.page.evaluate;
          e.page.evaluate = async (...args) => {
            const snapshot = await evaluate(...args);
            if (args[1]?.gateOnly) e.page.closed = true;
            return snapshot;
          };
        }
        if (reason === 'unrelated_host') e.page.currentUrl = 'https://unrelated.roleforge.test/apply/1';
        if (reason === 'unrelated_route') e.page.currentUrl = 'https://fixture.roleforge.test/apply/2';
        if (reason === 'identity_mismatch') {
          e.page.snapshot.documentTitle = 'Different Company Different Role';
          e.page.snapshot.headings = [];
          e.page.snapshot.bodyText = 'Different Company Different Role';
        }
      }
      const before = f.stateBytes();
      const snapshots = e.metrics.snapshots;
      e.dependencies.checkUrlLiveness = async () => { throw new Error('No navigation on a skipped resume'); };
      const result = await e.run({ resumePreparation: true, continueOnPage: true });
      assert.equal(result.state, 'human_action_required');
      assert.equal(result.resumeSkipped, reason.startsWith('page_closed') ? 'page_closed' : 'incompatible_destination');
      assert.equal(f.stateBytes(), before);
      if (reason === 'page_closed') assert.equal(e.metrics.snapshots, snapshots);
      assert.equal(e.metrics.prepare, 0);
      assertNoHumanWait(e);
      f.assertUnlocked();
    } finally { f.cleanup(); }
  });
}

test('continueOnPage can defer again while preserving the original pause and stage', async () => {
  const f = fixture();
  const e = environment(f);
  try {
    await e.run({ deferHumanHandoff: true });
    const before = f.stateBytes();
    e.dependencies.checkUrlLiveness = async () => { throw new Error('No listing navigation'); };
    const result = await e.run({ resumePreparation: true, continueOnPage: true, deferHumanHandoff: true });
    assert.equal(result.deferred, true);
    assert.equal(f.stateBytes(), before);
    assertNoHumanWait(e);
    f.assertUnlocked();
  } finally { f.cleanup(); }
});

test('with both options off the handoff still subscribes and waits for human clearance', async () => {
  const f = fixture();
  const e = environment(f);
  e.onSleep = () => { assert.equal(f.state().state, 'human_action_required'); e.page.snapshot = formSnapshot(); };
  try {
    const result = await e.run({ deferHumanHandoff: false, continueOnPage: false });
    assert.equal(result.state, 'form_prepared');
    assert.equal(Object.hasOwn(result, 'deferred'), false);
    assert.equal(e.metrics.sleep, 1);
    assert.ok(e.metrics.clock > 0);
    assert.equal(e.metrics.subscribe, 1);
    assert.equal(e.metrics.unsubscribe, 1);
    assert.match(e.logs[0], /Then press Enter here/);
    f.assertUnlocked();
  } finally { f.cleanup(); }
});

test('continueOnPage is ignored for a persisted state other than human_action_required', async () => {
  const f = fixture();
  const e = environment(f, formSnapshot());
  const lock = acquireBatchExecutionLock(f.batch.manifestPath, { root: f.root,
    candidateId: f.candidate.candidate_id, operation: 'prepare_application' });
  try {
    transitionCandidateState(f.batch.manifestPath, f.candidate.candidate_id, 'listing_verified', {
      root: f.root, lockToken: lock.token, expectedFrom: 'not_opened', currentUrl: LISTING, reason: 'Fixture verified listing.',
    });
    transitionCandidateState(f.batch.manifestPath, f.candidate.candidate_id, 'actual_form_reached', {
      root: f.root, lockToken: lock.token, expectedFrom: 'listing_verified', currentUrl: LISTING, reason: 'Fixture verified form.',
    });
  } finally { lock.release(); }
  try {
    e.dependencies.checkUrlLiveness = async (page, url) => {
      e.metrics.liveness++;
      await page.goto(url);
      return { result: 'active', reason: 'fixture' };
    };
    const result = await e.run({ resumePreparation: true, continueOnPage: true });
    assert.equal(result.state, 'form_prepared');
    assert.deepEqual(e.metrics.navigation, [LISTING]);
    assert.equal(e.metrics.liveness, 1);
    assert.equal(e.metrics.subscribe, 0);
    f.assertUnlocked();
  } finally { f.cleanup(); }
});
