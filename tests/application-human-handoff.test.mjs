import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  bindCandidateArtifact, confirmPreflight, createApplicationBatch, loadBatchState,
  acquireBatchExecutionLock, transitionCandidateState,
} from '../application-batch.mjs';
import { deriveCandidateId } from '../candidate-identity.mjs';
import { executeCandidate, buildCandidateFormContext, parseExecutorArgs } from '../application-browser-executor.mjs';
import { runSharedBrowserSession } from '../application-shared-browser.mjs';
import { openPersistentBrowserProfile } from '../browser-profile.mjs';
import { prepareOperationalApplicationForm } from '../application-form-engine.mjs';
import { attachFactualSources } from './fixtures/application-evidence-profile.mjs';

let server;
let origin;
const modes = new Map();
const form = '<form method="post"><label>Full name<input name="full_name" required></label><label>Email<input type="email" name="email" required></label><button type="submit" onclick="window.finalClicks++">Submit application</button></form>';
const gates = {
  captcha: `${form}<div class="g-recaptcha" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white">Human verification required</div>`,
  login: '<h2>Sign in to apply</h2><form><input type="email" name="email"><input type="password" name="password"></form>',
  account_creation: '<h2>Create an account to apply</h2><form><input type="email" name="email"><input type="password" name="password"></form>',
  mfa: '<h2>Enter your one-time code</h2><input autocomplete="one-time-code" name="otp">',
  email_verification: '<h2>Verify your email; check your inbox</h2>',
};
function html(path) {
  const mode = modes.get(path);
  const content = mode === 'listing' ? '<p>Role description</p><a href="/application/1">Apply</a>'
    : mode === 'no_form' ? '<p>No application form here.</p>' : gates[mode] || form;
  return `<!doctype html><title>Fixture Company Backend Engineer</title><h1>Fixture Company — Backend Engineer</h1>${content}<script>window.finalClicks=0;window.credentialInputs=0;document.addEventListener('input',e=>{if(e.target.type==='password'||e.target.autocomplete==='one-time-code')window.credentialInputs++});document.addEventListener('submit',e=>e.preventDefault())</script>`;
}
before(async () => {
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(html(request.url));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((done) => server.close(done)); });

function fixture(count = 1, urlOrigin = origin) {
  const root = mkdtempSync(join(tmpdir(), 'roleforge-human-handoff-'));
  const runId = 'synthetic-handoff-run';
  const runDir = join(root, 'output', 'scan-runs', runId);
  mkdirSync(runDir, { recursive: true });
  const candidates = Array.from({ length: count }, (_, index) => {
    const row = { company: 'Fixture Company', title: 'Backend Engineer', url: `${urlOrigin}/apply/${index + 1}`,
      source: 'fixture', recommendedCvVariant: 'software_backend', run_id: runId };
    return { ...row, candidate_id: deriveCandidateId(row) };
  });
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ runId, run_id: runId, candidates: count }));
  writeFileSync(join(runDir, 'candidates.json'), JSON.stringify(candidates));
  const docs = join(root, 'output', 'documents');
  mkdirSync(docs, { recursive: true });
  const bindings = [['cv', 'Synthetic CV.pdf'], ['cover_letter', 'Synthetic Cover.pdf'], ['cover_letter_text', 'Synthetic Cover.txt']];
  const batches = candidates.map((candidate, index) => {
    const batch = createApplicationBatch({ root, sourceRunId: runId, batchId: `handoff-${index + 1}`,
      selectedCandidateIds: [candidate.candidate_id],
      ...(index ? { allowDuplicateReason: 'Independent synthetic same-title candidate tests shared sequential execution.' } : {}) });
    for (const [artifactType, filename] of bindings) {
      const filePath = join(docs, filename);
      writeFileSync(filePath, 'Synthetic fixture artifact.');
      bindCandidateArtifact(batch.manifestPath, candidate.candidate_id, { root, artifactType, filePath });
    }
    confirmPreflight(batch.manifestPath, batch.manifest.batchId, { root });
    return batch;
  });
  return { root, candidates, batches,
    state(index = 0) { return loadBatchState(batches[index].manifestPath, { root }).state.candidates[0]; },
    cleanup() { rmSync(root, { recursive: true, force: true }); } };
}
const profile = attachFactualSources({ candidate: { full_name: 'Alex Example', email: 'alex@example.test' },
  cvText: 'Synthetic fixture CV.', answers: new Map(), priorApprovedAnswers: [], formRules: {} });

function environment(f, { onSleep, onPrepare, live = 'active' } = {}) {
  let now = 0;
  let signal;
  let page;
  let session;
  const logs = [];
  const observations = [];
  let subscriptions = 0;
  let unsubscriptions = 0;
  const dependencies = {
    openBrowserProfile: async () => {
      session = await openPersistentBrowserProfile({ root: f.root, headless: true });
      return session;
    },
    onCandidatePage: async (active) => { page = active; },
    configureContext: async (context) => {
      await context.route('http://fixture.roleforge.test/**', async (route) => {
        const response = await fetch(`${origin}${new URL(route.request().url()).pathname}`);
        await route.fulfill({ status: response.status, contentType: 'text/html', body: await response.text() });
      });
    },
    checkLivenessViaApi: async () => ({ result: live, reason: 'fixture posting check' }),
    checkUrlLiveness: async (active, url) => {
      await active.goto(url);
      return { result: live, reason: 'fixture browser posting check' };
    },
    humanClock: () => now,
    humanSleep: async (ms) => {
      observations.push(f.state().state);
      if (page && !page.isClosed()) observations.push(await page.evaluate(() => ({
        finalClicks: window.finalClicks || 0, credentialInputs: window.credentialInputs || 0,
        secretValues: [...document.querySelectorAll('input[type=password],input[autocomplete="one-time-code"]')].map((e) => e.value),
      })));
      await onSleep?.({ page, signal: () => signal?.(), now, f });
      now += ms;
    },
    subscribeHumanCompletion: (callback) => {
      subscriptions++;
      signal = callback;
      return () => { signal = null; unsubscriptions++; };
    },
    log: (line) => logs.push(line),
    prepareFormPassWithEvidence: async (active, _context, contract, _root, options) => {
      onPrepare?.(contract);
      return prepareOperationalApplicationForm(active, profile, {}, {
        ...options, context: buildCandidateFormContext(contract),
      });
    },
    beforeBrowserClose: async ({ context }) => {
      for (const active of context.pages()) {
        observations.push(await active.evaluate(() => ({ finalClicks: window.finalClicks || 0,
          credentialInputs: window.credentialInputs || 0,
          secretValues: [...document.querySelectorAll('input[type=password],input[autocomplete="one-time-code"]')].map((e) => e.value) })));
      }
    },
  };
  return { dependencies, logs, observations,
    ownership() { return { session, subscriptions, unsubscriptions }; } };
}
function options(f, index = 0, extra = {}) {
  return { manifest: f.batches[index].manifestPath, candidateId: f.candidates[index].candidate_id,
    headless: true, keepOpen: false, prepareForm: true, humanWaitMs: 3000, ...extra };
}
function assertSafe(e) {
  for (const observation of e.observations.filter((row) => typeof row === 'object')) {
    assert.equal(observation.finalClicks, 0);
    assert.equal(observation.credentialInputs, 0);
    assert.ok(observation.secretValues.every((value) => value === ''));
  }
  assert.equal(e.ownership().subscriptions, e.ownership().unsubscriptions);
  assert.equal(existsSync(e.ownership().session.lockPath), false, 'profile lock released');
}

for (const cause of Object.keys(gates)) {
  test(`${cause}: persisted pause, detected clearance, fresh revalidation, safe preparation`, async () => {
    const f = fixture();
    modes.set('/apply/1', cause);
    let prepCalls = 0;
    const e = environment(f, { onPrepare: () => { prepCalls++; }, onSleep: async ({ page }) => {
      assert.equal(f.state().state, 'human_action_required');
      assert.equal(f.state().humanAction.cause, cause);
      modes.delete('/apply/1');
      await page.reload();
    } });
    try {
      const result = await executeCandidate(options(f), { root: f.root, dependencies: e.dependencies });
      assert.equal(result.state, 'form_prepared');
      assert.equal(prepCalls, 1);
      const history = f.state().history;
      const resumed = history.find((event) => event.from === 'human_action_required' && event.to === 'actual_form_reached');
      assert.equal(resumed.details.humanActionRevalidation.candidate_id, f.candidates[0].candidate_id);
      assert.ok(Object.entries(resumed.details.humanActionRevalidation).filter(([key]) => key !== 'candidate_id').every(([, value]) => value === true));
      assert.match(e.logs[0], /Fixture Company.*Backend Engineer.*cause:/);
      assert.ok(e.logs[0].includes(f.candidates[0].candidate_id));
      assert.match(e.logs[0], /Never click the final application button.*press Enter/);
      assertSafe(e);
    } finally { f.cleanup(); modes.clear(); }
  });
}

test('Enter while still gated stays paused; timeout releases locks and same-profile exact resume works', async () => {
  const f = fixture();
  modes.set('/apply/1', 'login');
  const e = environment(f, { onSleep: ({ signal }) => signal() });
  try {
    const result = await executeCandidate(options(f), { root: f.root, dependencies: e.dependencies });
    assert.equal(result.state, 'human_action_required');
    assert.equal(f.state().history.filter((event) => event.to === 'human_action_required').length, 1);
    assert.ok(e.observations.includes('human_action_required'));
    assert.match(e.logs.at(-1), /--resume-preparation/);
    assert.equal(existsSync(join(f.root, 'output', 'application-batches', 'handoff-1', '.execution.lock')), false);
    assertSafe(e);
    modes.clear();
    const recovery = environment(f);
    const resumed = await executeCandidate(options(f, 0, { resumeLogin: true }), { root: f.root, dependencies: recovery.dependencies });
    assert.equal(resumed.state, 'form_prepared');
    assert.equal(recovery.ownership().session.profileDir, e.ownership().session.profileDir);
    assertSafe(recovery);
  } finally { f.cleanup(); modes.clear(); }
});

test('human destination moving to an unrelated host is blocked even with copied candidate identity', async () => {
  const f = fixture();
  modes.set('/apply/1', 'captcha');
  const e = environment(f, { onSleep: async ({ page, signal }) => {
    modes.clear();
    await page.goto(`${origin.replace('127.0.0.1', 'localhost')}/unrelated`);
    signal();
  } });
  try {
    const result = await executeCandidate(options(f), { root: f.root, dependencies: e.dependencies });
    assert.equal(result.state, 'blocked');
    assert.match(f.state().reason, /outside.*destination/);
    assert.equal(f.state().formPreparation, null);
    assertSafe(e);
  } finally { f.cleanup(); modes.clear(); }
});

test('closing the page preserves human_action_required and releases ownership', async () => {
  const f = fixture();
  modes.set('/apply/1', 'captcha');
  const e = environment(f, { onSleep: ({ page }) => page.close() });
  try {
    const result = await executeCandidate(options(f), { root: f.root, dependencies: e.dependencies });
    assert.equal(result.state, 'human_action_required');
    assert.match(e.logs.at(-1), /closed.*--resume-preparation/);
    assertSafe(e);
  } finally { f.cleanup(); modes.clear(); }
});

test('gate appearing during preparation uses the same page and resumes the real safe form engine', async () => {
  const f = fixture();
  modes.clear();
  let first = true;
  const e = environment(f, { onSleep: async ({ page }) => { modes.clear(); await page.reload(); } });
  const prepare = e.dependencies.prepareFormPassWithEvidence;
  e.dependencies.prepareFormPassWithEvidence = async (...args) => {
    if (first) { first = false; modes.set('/apply/1', 'mfa'); await args[0].reload(); }
    return prepare(...args);
  };
  try {
    const result = await executeCandidate(options(f), { root: f.root, dependencies: e.dependencies });
    assert.equal(result.state, 'form_prepared');
    assert.equal(f.state().humanAction.cause, 'mfa');
    assertSafe(e);
  } finally { f.cleanup(); modes.clear(); }
});

test('shared runner waits for first timeout before preparing second exact candidate', async () => {
  const f = fixture(2);
  modes.set('/apply/1', 'captcha');
  const e = environment(f);
  let session;
  const completed = [];
  try {
    const result = await runSharedBrowserSession({ root: f.root, batchIds: ['handoff-1', 'handoff-2'], humanWaitMs: 3000 }, {
      openBrowserProfile: async () => { session = await e.dependencies.openBrowserProfile(); return session; },
      executorDependencies: async () => e.dependencies,
      onCandidateComplete: (entry) => completed.push(entry.result.state),
      waitForBrowserClose: async () => {
        assert.deepEqual(completed, ['human_action_required', 'form_prepared']);
        assert.equal(session.context.pages().length, 1);
        assert.equal(await session.context.pages()[0].evaluate(() => window.finalClicks), 0);
        await session.close();
      },
    });
    assert.deepEqual(result.completed.map((row) => row.state), ['human_action_required', 'form_prepared']);
    assert.equal(f.state().state, 'human_action_required');
    assert.equal(f.state(1).state, 'form_prepared');
    assertSafe(e);
  } finally { await session?.close(); f.cleanup(); modes.clear(); }
});

test('manifest drift during the human step prevents preparation and preserves the pause', async () => {
  const f = fixture();
  modes.set('/apply/1', 'captcha');
  const e = environment(f, { onSleep: async ({ page }) => {
    writeFileSync(f.batches[0].manifestPath, readFileSync(f.batches[0].manifestPath, 'utf8').replace('Fixture Company', 'Unapproved Company'));
    modes.clear(); await page.reload();
  } });
  try {
    await assert.rejects(executeCandidate(options(f), { root: f.root, dependencies: e.dependencies }), /scope hash mismatch/);
    const statePath = join(f.root, 'output', 'application-batches', 'handoff-1', 'state.json');
    assert.equal(JSON.parse(readFileSync(statePath)).candidates[0].state, 'human_action_required');
    assertSafe(e);
  } finally { f.cleanup(); modes.clear(); }
});

test('legacy login_required resumes through human handoff and CLI accepts a separate wait budget', async () => {
  const f = fixture();
  modes.set('/apply/1', 'login');
  const lock = acquireBatchExecutionLock(f.batches[0].manifestPath, { root: f.root,
    candidateId: f.candidates[0].candidate_id, operation: 'prepare_application' });
  transitionCandidateState(f.batches[0].manifestPath, f.candidates[0].candidate_id, 'login_required', {
    root: f.root, lockToken: lock.token, currentUrl: f.candidates[0].url, expectedFrom: 'not_opened', reason: 'legacy fixture login gate',
  });
  lock.release();
  const e = environment(f, { onSleep: async ({ page, signal }) => { modes.clear(); await page.reload(); signal(); } });
  try {
    const parsed = parseExecutorArgs(['--manifest', f.batches[0].manifestPath, '--candidate-id', f.candidates[0].candidate_id,
      '--resume-login', '--human-wait-ms', '1234']);
    assert.equal(parsed.humanWaitMs, 1234);
    const result = await executeCandidate(options(f, 0, { resumeLogin: true }), { root: f.root, dependencies: e.dependencies });
    assert.equal(result.state, 'form_prepared');
    assert.ok(f.state().history.some((event) => event.from === 'login_required' && event.to === 'human_action_required'));
    assertSafe(e);
  } finally { f.cleanup(); modes.clear(); }
});

test('application-entry CAPTCHA timeout recovers from the manifest listing through its safe Apply link', async () => {
  const f = fixture(1, 'http://fixture.roleforge.test');
  modes.set('/apply/1', 'listing');
  modes.set('/application/1', 'captcha');
  const e = environment(f);
  try {
    const paused = await executeCandidate(options(f), { root: f.root, dependencies: e.dependencies });
    assert.equal(paused.state, 'human_action_required');
    assert.equal(f.state().humanAction.stage, 'application_entry');
    assertSafe(e);
    modes.delete('/application/1');
    const recovery = environment(f);
    const resumed = await executeCandidate(options(f, 0, { resumePreparation: true }), { root: f.root, dependencies: recovery.dependencies });
    assert.equal(resumed.state, 'form_prepared');
    assert.match(resumed.currentUrl, /\/application\/1$/);
    assertSafe(recovery);
  } finally { f.cleanup(); modes.clear(); }
});

test('non-interactive stdin watches clearance without an Enter subscriber', async () => {
  assert.equal(Boolean(process.stdin.isTTY), false);
  const f = fixture();
  modes.set('/apply/1', 'captcha');
  const e = environment(f, { onSleep: async ({ page }) => { modes.clear(); await page.reload(); } });
  delete e.dependencies.subscribeHumanCompletion;
  try {
    const result = await executeCandidate(options(f), { root: f.root, dependencies: e.dependencies });
    assert.equal(result.state, 'form_prepared');
    assert.equal(e.ownership().subscriptions, 0);
    assertSafe(e);
  } finally { f.cleanup(); modes.clear(); }
});

test('cleared gate without an actual form requires review', async () => {
  const f = fixture();
  modes.set('/apply/1', 'captcha');
  const e = environment(f, { onSleep: async ({ page }) => { modes.set('/apply/1', 'no_form'); await page.reload(); } });
  try {
    const result = await executeCandidate(options(f), { root: f.root, dependencies: e.dependencies });
    assert.equal(result.state, 'review_required');
    assert.match(f.state().reason, /no actual candidate application form/);
    assertSafe(e);
  } finally { f.cleanup(); modes.clear(); }
});

test('fresh posting expiry after clearance blocks preparation', async () => {
  const f = fixture();
  modes.set('/apply/1', 'captcha');
  const e = environment(f, { onSleep: async ({ page }) => {
    modes.clear(); await page.reload();
    e.dependencies.checkLivenessViaApi = async () => ({ result: 'expired', reason: 'fixture posting expired' });
  } });
  try {
    const result = await executeCandidate(options(f), { root: f.root, dependencies: e.dependencies });
    assert.equal(result.state, 'blocked');
    assert.match(f.state().reason, /posting liveness failed.*expired/);
    assertSafe(e);
  } finally { f.cleanup(); modes.clear(); }
});

test('posting revalidation transport failure blocks the cleared candidate', async () => {
  const f = fixture();
  modes.set('/apply/1', 'captcha');
  const e = environment(f, { onSleep: async ({ page }) => {
    modes.clear(); await page.reload();
    e.dependencies.checkLivenessViaApi = async () => { throw new Error('fixture transport failed'); };
  } });
  try {
    const result = await executeCandidate(options(f), { root: f.root, dependencies: e.dependencies });
    assert.equal(result.state, 'blocked');
    assert.match(f.state().reason, /liveness failed.*transport failed/);
    assertSafe(e);
  } finally { f.cleanup(); modes.clear(); }
});

test('last shared candidate timeout closes the profile and returns without waiting for browser review', async () => {
  const f = fixture();
  modes.set('/apply/1', 'captcha');
  const e = environment(f);
  try {
    const result = await runSharedBrowserSession({ root: f.root, batchIds: ['handoff-1'], humanWaitMs: 1000 }, {
      openBrowserProfile: e.dependencies.openBrowserProfile,
      executorDependencies: async () => e.dependencies,
      waitForBrowserClose: async () => assert.fail('Timeout must exit instead of waiting for manual browser close'),
    });
    assert.equal(result.completed[0].state, 'human_action_required');
    assert.equal(result.browserRemainsOpen, false);
    assert.equal(existsSync(join(f.root, 'output', 'application-batches', 'handoff-1', '.execution.lock')), false);
    assertSafe(e);
  } finally { f.cleanup(); modes.clear(); }
});
