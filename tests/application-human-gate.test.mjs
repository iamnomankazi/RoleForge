import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  classifyHumanGate, classifyHumanOnlyField, executeFormPlan, inspectApplicationForm, sanitizeHumanGateUrl,
} from '../application-form-core.mjs';
import {
  buildOperationalFormPlan, executeOperationalFormPlan, prepareOperationalApplicationForm,
} from '../application-form-engine.mjs';
import {
  acquireBatchExecutionLock, bindCandidateArtifact, confirmPreflight, createApplicationBatch,
  loadBatchState, transitionCandidateState, abandonApplicationBatch,
} from '../application-batch.mjs';
import { deriveCandidateId } from '../candidate-identity.mjs';
import { attachFactualSources } from './fixtures/application-evidence-profile.mjs';
import { clearApplication, humanGateFixtures } from './fixtures/application-human-gate-fixtures.mjs';

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const candidateId = `cand_v1_${'a'.repeat(64)}`;
const context = { batchId: 'human-gate-fixture', candidate: { candidate_id: candidateId } };
const profile = attachFactualSources({
  candidate: { full_name: 'Alex Example', email: 'alex@example.test', linkedin: 'https://linkedin.test/alex' },
  answers: new Map(), priorApprovedAnswers: [], formRules: {}, cvText: 'Synthetic fixture CV.',
});

async function localPage(html) {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.abort());
  await page.setContent(html);
  return page;
}

for (const fixture of humanGateFixtures) {
  test(`local HTML classifier: ${fixture.name}`, async () => {
    const page = await localPage(fixture.html);
    try {
      const snapshot = await inspectApplicationForm(page);
      const frozen = structuredClone(snapshot);
      const result = classifyHumanGate(snapshot);
      assert.equal(result.gate?.cause || null, fixture.cause);
      assert.deepEqual(snapshot, frozen, 'classification is pure');
      if (fixture.cause) {
        assert.ok(result.gate.evidence.every((signal) => /^[a-z_]+$/.test(signal)));
        const prepared = await prepareOperationalApplicationForm(page, profile, {}, { context });
        assert.equal(prepared.gate.state, 'human_action_required');
        assert.equal(prepared.humanAction.candidate_id, candidateId);
        assert.equal(prepared.humanAction.cause, fixture.cause);
        assert.equal(prepared.evidence.filledFields.length, 0);
        assert.equal(prepared.evidence.finalAction.activated, false);
        assert.equal(await page.evaluate(() => window.finalClicks || 0), 0);
      }
    } finally { await page.close(); }
  });
}

test('an application form that creates the account is fillable but its password fields stay human-only', async () => {
  const field = (label, name, type = 'text') => `<label>${label}<input type="${type}" name="${name}"></label>`;
  const applicationWithAccount = `<form id="application"><h1>Career Opportunities: Data Engineer (79647)</h1>
    ${field('Email Address', 'email', 'email')}${field('Retype Email Address', 'email2', 'email')}
    ${field('Choose Password', 'pwd', 'password')}${field('Retype Password', 'pwd2', 'password')}
    ${field('First Name', 'first')}${field('Last Name', 'last')}${field('Mobile phone', 'phone', 'tel')}
    ${field('Current or Latest Employer', 'employer')}${field('Current or Latest Role', 'role')}
    ${field('Notice period or when can you start', 'notice')}${field('LinkedIn profile link', 'linkedin')}
    <button type="submit" onclick="window.finalClicks=(window.finalClicks||0)+1">Apply</button></form>`;
  const page = await localPage(applicationWithAccount);
  try {
    assert.deepEqual(classifyHumanGate(await inspectApplicationForm(page)), { gate: null });
    const prepared = await prepareOperationalApplicationForm(page, profile, {}, { context });
    assert.notEqual(prepared.gate?.state, 'human_action_required');
    assert.ok(prepared.evidence.filledFields.length > 0, 'applicant fields are filled');
    assert.deepEqual(await page.$$eval('input[type=password]', (inputs) => inputs.map((input) => input.value)), ['', '']);
    assert.ok(prepared.evidence.unresolvedFields.some((row) => /password/i.test(row.label || '')), 'passwords are left for the human');
    assert.equal(prepared.evidence.finalAction.activated, false);
    assert.equal(await page.evaluate(() => window.finalClicks || 0), 0);
  } finally { await page.close(); }

  const login = `<form id="login">${field('Email', 'email', 'email')}${field('Password', 'pwd', 'password')}<button>Sign in</button></form>`;
  const signup = `<form id="signup">${field('First Name', 'first')}${field('Last Name', 'last')}${field('Email', 'email', 'email')}
    ${field('Choose Password', 'pwd', 'password')}<button>Create account</button></form>`;
  for (const html of [login, signup]) {
    const gated = await localPage(html);
    try {
      assert.equal(classifyHumanGate(await inspectApplicationForm(gated)).gate?.cause, 'login');
    } finally { await gated.close(); }
  }
});

test('captcha completion and passive scripts without a form are not human gates', () => {
  assert.deepEqual(classifyHumanGate({ captcha: { present: true, completed: true, classification: 'active_blocking' } }), { gate: null });
  assert.deepEqual(classifyHumanGate({ captchaSignals: { present: true, scriptCount: 1, elements: [], totalNormalFields: 0 } }), { gate: null });
  assert.equal(sanitizeHumanGateUrl('https://user:secret@fixture.invalid/apply?token=secret#otp'), 'https://fixture.invalid/apply');
});

test('footer login choices do not mask a cleared accessible application form', async () => {
  const page = await localPage(`${clearApplication}<footer>Already working here? Log in</footer>`);
  try {
    assert.deepEqual(classifyHumanGate(await inspectApplicationForm(page)), { gate: null });
  } finally { await page.close(); }
});

test('password, OTP and captcha response fields cannot compile into fill actions', () => {
  const protectedFields = [
    { type: 'password', label: 'Email', name: 'email' },
    { type: 'text', label: 'Email', autocomplete: 'one-time-code' },
    { type: 'textarea', label: 'Email', name: 'g-recaptcha-response' },
    { type: 'text', label: 'Email', name: 'otp_code' },
    { type: 'text', label: 'Email', name: 'cf-turnstile-response' },
  ];
  for (const [index, field] of protectedFields.entries()) {
    assert.ok(classifyHumanOnlyField(field));
    const plan = buildOperationalFormPlan({ fields: [{ ...field, fieldId: `protected-${index}`, visible: true }], controls: [] }, profile);
    assert.equal(plan.actions.length, 0);
    assert.ok(plan.unresolvedFields.length);
  }
});

test('stale and externally supplied plans never type into live credential or challenge controls', async () => {
  for (const attributes of ['type="password"', 'autocomplete="one-time-code"', 'name="g-recaptcha-response"']) {
    const page = await localPage(`${clearApplication}<input id="secret" data-career-ops-field-id="secret" ${attributes}>`);
    try {
      const result = await executeOperationalFormPlan(page, { actions: [{
        fieldId: 'secret', id: 'secret', label: 'Email', semantic: 'email', category: 'identity_contact',
        action: 'fill', value: 'must-not-be-typed', valueHash: 'sha256:fixture',
      }] });
      assert.equal(await page.locator('#secret').inputValue(), '');
      assert.equal(result.completed.length, 0);
      const legacy = await executeFormPlan(page, { actions: [{
        fieldId: 'secret', id: 'secret', label: 'Email', semantic: 'email',
        action: 'fill', value: 'must-not-be-typed', valueHash: 'sha256:fixture',
      }] });
      assert.equal(legacy.completed.length, 0);
      assert.equal(await page.locator('#secret').inputValue(), '');
      assert.equal(await page.evaluate(() => window.finalClicks || 0), 0);
    } finally { await page.close(); }
  }
});

test('a gate appearing after the first field stops remaining fields and progression', async () => {
  const page = await localPage(clearApplication);
  let actions = 0;
  try {
    const result = await prepareOperationalApplicationForm(page, profile, {}, {
      context,
      performActionImpl: async (_page, action) => {
        actions += 1;
        await page.locator(`[data-career-ops-field-id="${action.fieldId}"]`).fill(action.value);
        await page.evaluate(() => {
          const notice = document.createElement('h1');
          notice.textContent = 'Enter your one-time code';
          document.body.append(notice);
        });
        return action.value;
      },
    });
    assert.equal(actions, 1);
    assert.equal(result.gate.state, 'human_action_required');
    assert.equal(result.gate.cause, 'mfa');
    assert.equal(result.gate.stage, 'field_filling');
    assert.equal(await page.locator('#email').inputValue(), '');
    assert.equal(result.evidence.finalAction.activated, false);
    assert.equal(result.evidence.reviewComplete, false);
  } finally { await page.close(); }
});

test('a gate on the next application step returns a progression pause', async () => {
  const page = await localPage(`<div data-career-ops-wizard><p data-career-ops-step="1" data-career-ops-total-steps="2">Step 1 of 2</p>
    <form id="application" method="post" action="/application/step/2"><label>Email<input name="email"></label><label>LinkedIn<input name="linkedin"></label><button type="submit">Continue</button></form></div>
    <script>application.addEventListener('submit', event => { event.preventDefault(); document.body.innerHTML = '<h1>Verify your email</h1>'; });</script>`);
  try {
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context, transitionStabilityMs: 0, transitionTimeoutMs: 500 });
    assert.equal(result.gate.state, 'human_action_required', result.gate.reason);
    assert.equal(result.gate.cause, 'email_verification');
    assert.equal(result.gate.stage, 'form_progression');
    assert.equal(result.evidence.finalAction.activated, false);
  } finally { await page.close(); }
});

function batchFixture(listingUrl = 'https://fixture.invalid/jobs/1') {
  const root = mkdtempSync(join(tmpdir(), 'roleforge-human-gate-'));
  const runId = 'synthetic-human-gate-run';
  const candidate = { company: 'Example Company', title: 'Backend Engineer', url: listingUrl, source: 'fixture-provider', recommendedCvVariant: 'software_backend', run_id: runId };
  candidate.candidate_id = deriveCandidateId(candidate);
  const runDir = join(root, 'output', 'scan-runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ runId, run_id: runId, candidates: 1 }));
  writeFileSync(join(runDir, 'candidates.json'), JSON.stringify([candidate]));
  const created = createApplicationBatch({ root, sourceRunId: runId, batchId: 'human-gate-batch', selectedCandidateIds: [candidate.candidate_id] });
  const cv = join(root, 'output', 'CV.pdf');
  writeFileSync(cv, '%PDF synthetic fixture');
  bindCandidateArtifact(created.manifestPath, candidate.candidate_id, { root, artifactType: 'cv', filePath: cv });
  confirmPreflight(created.manifestPath, created.manifest.batchId, { root });
  const lock = acquireBatchExecutionLock(created.manifestPath, { root, candidateId: candidate.candidate_id, operation: 'prepare_application' });
  const transition = (to, options = {}) => transitionCandidateState(created.manifestPath, candidate.candidate_id, to, {
    root, lockToken: lock.token, currentUrl: candidate.url, reason: 'Synthetic verification.', ...options,
  });
  return { root, candidate, created, lock, transition, close() { lock.release(); rmSync(root, { recursive: true, force: true }); } };
}

const humanAction = { cause: 'captcha', stage: 'form_progression', evidence: ['captcha_blocking'] };
for (const from of ['not_opened', 'form_inspected', 'fields_filled', 'files_uploaded']) {
  test(`pause cannot enter from ${from}`, () => {
    const fixture = batchFixture();
    try {
      if (from !== 'not_opened') {
        fixture.transition('listing_verified');
        fixture.transition('actual_form_reached');
        fixture.transition('form_inspected');
        if (['fields_filled', 'files_uploaded'].includes(from)) fixture.transition('fields_filled');
        if (from === 'files_uploaded') fixture.transition('files_uploaded');
      }
      assert.throws(() => fixture.transition('human_action_required', { humanAction }), /Invalid state transition/);
    } finally { fixture.close(); }
  });
}
for (const from of ['listing_verified', 'actual_form_reached', 'review_required', 'login_required', 'blocked']) {
  test(`persisted transition ${from} -> human_action_required strips query and fragment`, () => {
    const fixture = batchFixture();
    try {
      fixture.transition('listing_verified');
      if (from !== 'listing_verified') fixture.transition(from);
      const paused = fixture.transition('human_action_required', {
        currentUrl: 'https://fixture.invalid/apply?token=do-not-store#secret',
        reason: 'Page content or token must not be retained', humanAction,
      });
      assert.equal(paused.humanAction.candidate_id, fixture.candidate.candidate_id);
      assert.equal(paused.humanAction.currentUrl, 'https://fixture.invalid/apply');
      assert.deepEqual(Object.keys(paused.humanAction).sort(), ['candidate_id', 'cause', 'currentUrl', 'evidence', 'stage', 'timestamp']);
      const stored = readFileSync(fixture.created.statePath, 'utf8');
      assert.doesNotMatch(stored, /do-not-store|#secret|Page content|\?token=/);
      assert.equal(loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state.candidates[0].state, 'human_action_required');
    } finally { fixture.close(); }
  });
}

for (const to of ['actual_form_reached', 'login_required', 'blocked', 'review_required', 'abandoned', 'form_prepared', 'form_inspected', 'listing_verified', 'closed', 'human_action_required']) {
  test(`human_action_required transition table: ${to}`, () => {
    const fixture = batchFixture();
    try {
      fixture.transition('listing_verified');
      fixture.transition('human_action_required', { humanAction });
      if (to === 'abandoned') {
        fixture.lock.release();
        abandonApplicationBatch(fixture.created.manifestPath, { root: fixture.root, candidateId: fixture.candidate.candidate_id, reason: 'Human abandoned fixture.' });
      } else if (['actual_form_reached', 'login_required', 'blocked', 'review_required'].includes(to)) {
        if (to === 'actual_form_reached') assert.throws(() => fixture.transition(to), /fresh exact-candidate revalidation/);
        fixture.transition(to, { details: { humanActionRevalidation: {
          candidate_id: fixture.candidate.candidate_id, listingLive: true, identityVerified: true,
          destinationCompatible: true, gateCleared: true, formVerified: true,
        } } });
      } else {
        assert.throws(() => fixture.transition(to, to === 'human_action_required' ? { humanAction } : {}), /Invalid state transition/);
      }
    } finally { fixture.close(); }
  });
}

test('pause persistence rejects page text, tokens and incomplete records', () => {
  const fixture = batchFixture();
  try {
    fixture.transition('listing_verified');
    for (const bad of [null, { ...humanAction, cause: 'other' }, { ...humanAction, evidence: ['secret-token'] }, { ...humanAction, token: 'secret' }, { ...humanAction, candidate_id: candidateId }]) {
      assert.throws(() => fixture.transition('human_action_required', { humanAction: bad }), /Human action|human action|Unknown/);
    }
    assert.throws(() => fixture.transition('human_action_required', { humanAction, details: { bodyText: 'secret' } }), /only sanitized classifier evidence/);
    assert.throws(() => fixture.transition('human_action_required', { humanAction, formPreparation: {} }), /only sanitized classifier evidence/);
    assert.equal(loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state.candidates[0].state, 'listing_verified');
  } finally { fixture.close(); }
});

test('schema v4 legacy states migrate in memory without rewriting the file', () => {
  const fixture = batchFixture();
  try {
    const legacy = JSON.parse(readFileSync(fixture.created.statePath, 'utf8'));
    legacy.schemaVersion = 4;
    writeFileSync(fixture.created.statePath, JSON.stringify(legacy));
    const before = readFileSync(fixture.created.statePath, 'utf8');
    const loaded = loadBatchState(fixture.created.manifestPath, { root: fixture.root });
    assert.equal(loaded.state.schemaVersion, 5);
    assert.equal(loaded.state.migratedFromSchemaVersion, 4);
    assert.equal(readFileSync(fixture.created.statePath, 'utf8'), before);
  } finally { fixture.close(); }
});

test('all batch URLs are sanitized at creation and normal transitions, and legacy trace evidence stays readable', () => {
  const fixture = batchFixture('https://fixture.invalid/jobs/1?access_token=creation-secret#creation-fragment');
  const observed = 'https://fixture.invalid/jobs/1?access_token=return-secret#verification-fragment';
  try {
    fixture.transition('listing_verified', { currentUrl: observed, details: { entryActions: [{
      sourceUrl: observed, destinationUrl: observed, frame: { url: observed },
    }] } });
    fixture.transition('actual_form_reached', { currentUrl: observed });
    const legacyPreparation = { schemaVersion: 1, currentUrl: observed, requiredFieldCount: 0,
      filledFields: [], committedSelections: [], uploadedArtifacts: [], unresolvedFields: [], validationErrors: [],
      userActionRequired: true, reviewComplete: false, finalAction: { detected: false, activated: false },
      operationalArtifacts: { trace: 'legacy-playwright-trace.zip' }, evidenceHash: 'old-unsanitized-hash' };
    fixture.transition('review_required', { currentUrl: observed, formPreparation: legacyPreparation });
    fixture.transition('blocked', { currentUrl: observed, reason: 'Transport failed for '+observed });
    const stored = readFileSync(fixture.created.statePath, 'utf8');
    assert.doesNotMatch(stored, /creation-secret|creation-fragment|return-secret|verification-fragment|access_token/);
    const state = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state.candidates[0];
    assert.equal(state.listingUrl, 'https://fixture.invalid/jobs/1');
    assert.equal(state.formPreparation.currentUrl, 'https://fixture.invalid/jobs/1');
    assert.equal(state.formPreparation.operationalArtifacts.trace, 'legacy-playwright-trace.zip');
    assert.notEqual(state.formPreparation.evidenceHash, legacyPreparation.evidenceHash);
  } finally { fixture.close(); }
});
