import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import {
  buildFormPlan,
  classifyField,
  classifyUserGate,
  inspectApplicationForm,
  isSemanticFinalAction,
  prepareApplicationForm,
} from '../application-form-core.mjs';
import { collectPageSnapshot, followSafeContinuation } from '../application-browser-executor.mjs';
import { createNarrativeProvenanceRecord, resolveFactualEvidence } from '../application-evidence.mjs';
import { attachFactualSources } from './fixtures/application-evidence-profile.mjs';
import {
  atsStyleCaptchaFixtures,
  blockingCaptchaOverlayFixture,
  captchaFixture,
  consentFixture,
  disabledPendingCaptchaFixture,
  duplicatePopupFixture,
  greenhouseFixture,
  invisibleCaptchaFixture,
  leverFixture,
  passiveCaptchaFixture,
  uncertainCaptchaFixture,
  visibleNonBlockingCaptchaFixture,
  workdayFixture,
} from './fixtures/application-form-fixtures.mjs';

const syntheticProfile = attachFactualSources({
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
  cvText: 'Grounded synthetic fixture cover letter.',
  articleDigestText: '',
  answerBankText: 'Synthetic fixture evidence only.',
  profileModeText: 'Synthetic fixture evidence only.',
});

function coverProvenance(candidateId = 'fixture-cover') {
  return createNarrativeProvenanceRecord({
    candidateId,
    normalizedQuestion: 'cover letter document',
    answer: syntheticProfile.cvText,
    wording: 'generated',
    templateId: 'cover-letter-v1',
    factualEvidence: [resolveFactualEvidence(syntheticProfile, { sourceType: 'cv', locator: 'lines:1' })],
  });
}

function createFixtureArtifacts() {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-captcha-form-'));
  const cv = join(dir, 'Alex Example Software Backend CV.pdf');
  const cover = join(dir, 'Aiven Software Engineer Cover Letter.pdf');
  writeFileSync(cv, '%PDF-1.4 fixture CV');
  writeFileSync(cover, '%PDF-1.4 fixture cover');
  return {
    dir,
    artifacts: {
      cv: { resolvedPath: cv, intendedFilename: 'Alex Example Software Backend CV.pdf', sha256: 'sha256:cv' },
      coverLetter: { resolvedPath: cover, intendedFilename: 'Aiven Software Engineer Cover Letter.pdf', sha256: 'sha256:cover' },
      coverLetterTextContent: syntheticProfile.cvText,
      coverLetterTextProvenance: coverProvenance(),
    },
  };
}

test('field and final-action semantics cover common ATS patterns', () => {
  assert.equal(classifyField({ label: 'Resume / CV', type: 'file' }), 'cv_upload');
  assert.equal(classifyField({ label: 'Motivation letter', type: 'file' }), 'cover_letter_upload');
  assert.equal(classifyField({ label: 'Phone country', tag: 'select', type: 'select-one' }), 'phone_country');
  assert.equal(classifyField({ label: 'I certify this is accurate', type: 'checkbox' }), 'legal_consent');
  assert.equal(isSemanticFinalAction({ type: 'submit', label: 'Continue' }), true);
  assert.equal(isSemanticFinalAction({ type: 'button', label: 'Apply Now', insideApplicationForm: false }), false);
  assert.equal(isSemanticFinalAction({ type: 'button', label: 'Apply Now', insideApplicationForm: true }), true);
});

test('text-only cover fields receive the complete bound letter and one-document fields require an explicit combined artifact', () => {
  const profile = syntheticProfile;
  const fullLetter = profile.cvText;
  const textPlan = buildFormPlan({
    fields: [{ fieldId: 'cover-text', tag: 'textarea', type: 'textarea', label: 'Motivation letter', required: true, visible: true }],
    controls: [{ type: 'submit', label: 'Submit', insideApplicationForm: true }],
  }, profile, { coverLetterTextContent: fullLetter, coverLetterTextProvenance: coverProvenance() }, { candidateId: 'fixture-cover' });
  assert.equal(textPlan.actions[0].value, fullLetter);
  const singlePlan = buildFormPlan({
    fields: [{ fieldId: 'one-doc', tag: 'input', type: 'file', label: 'Application document', required: true, visible: true }],
    controls: [],
  }, profile, { cv: { intendedFilename: 'CV.pdf' }, coverLetter: { intendedFilename: 'Cover Letter.pdf' } });
  assert.ok(singlePlan.unresolvedFields.some((field) => field.semantic === 'single_document_upload'));
});

test('legacy cover-text fill requires explicit current candidate identity and rejects cross-candidate provenance', () => {
  const snapshot = {
    fields: [{ fieldId: 'cover-text', tag: 'textarea', type: 'textarea', label: 'Motivation letter', required: true, visible: true }],
    controls: [],
  };
  const artifacts = {
    coverLetterTextContent: syntheticProfile.cvText,
    coverLetterTextProvenance: coverProvenance('candidate-a'),
  };
  const noIdentity = buildFormPlan(snapshot, syntheticProfile, artifacts);
  assert.equal(noIdentity.actions.length, 0);
  assert.match(noIdentity.unresolvedFields[0].reason, /no explicit current candidate identity/);
  const crossCandidate = buildFormPlan(snapshot, syntheticProfile, artifacts, { candidateId: 'candidate-b' });
  assert.equal(crossCandidate.actions.length, 0);
  assert.match(crossCandidate.unresolvedFields[0].reason, /exact candidate and question/);
  const exactCandidate = buildFormPlan(snapshot, syntheticProfile, artifacts, { candidateId: 'candidate-a' });
  assert.equal(exactCandidate.actions[0].value, syntheticProfile.cvText);
});

test('legacy Greenhouse flow fills deterministic fields but leaves draft-only narrative for review and never submits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-form-'));
  const cv = join(dir, 'Alex Example Data Engineering CV.pdf');
  const cover = join(dir, 'Acme Data Engineer Cover Letter.pdf');
  writeFileSync(cv, '%PDF-1.4 fixture CV');
  writeFileSync(cover, '%PDF-1.4 fixture cover');
  const profile = syntheticProfile;
  const artifacts = {
    cv: { resolvedPath: cv, intendedFilename: 'Alex Example Data Engineering CV.pdf', sha256: 'sha256:cv' },
    coverLetter: { resolvedPath: cover, intendedFilename: 'Acme Data Engineer Cover Letter.pdf', sha256: 'sha256:cover' },
    coverLetterTextContent: profile.cvText,
    coverLetterTextProvenance: coverProvenance(),
  };
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(greenhouseFixture);
    const result = await prepareApplicationForm(page, profile, artifacts);
    assert.equal(result.evidence.reviewComplete, false);
    assert.ok(result.evidence.unresolvedFields.some((row) => row.semantic === 'free_text'));
    assert.equal(result.evidence.finalAction.detected, true);
    assert.equal(result.evidence.finalAction.activated, false);
    assert.equal(result.evidence.uploadedArtifacts.length, 2);
    assert.ok(result.evidence.committedSelections.some((row) => row.semantic === 'city'));
    assert.equal(await page.evaluate(() => window.fixtureSubmitCount || 0), 0);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('representative Lever and Workday forms are recognized without final-action availability', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const html of [leverFixture, workdayFixture]) {
      const page = await browser.newPage();
      await page.setContent(html);
      const snapshot = await inspectApplicationForm(page);
      assert.ok(snapshot.fields.length >= 3);
      assert.ok(snapshot.controls.some(isSemanticFinalAction));
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('footer login text does not mask an accessible application form as an account gate', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const application = await browser.newPage();
    await application.setContent(`
      <form>
        <label>First name* <input name="first_name" required></label>
        <label>Last name* <input name="last_name" required></label>
        <label>Email* <input name="email" type="email" required></label>
        <label>Upload CV <input name="resume" type="file"></label>
        <button type="submit">Submit application</button>
      </form>
      <footer>Already working here? Log in</footer>
    `);
    const applicationSnapshot = await inspectApplicationForm(application);
    assert.equal(applicationSnapshot.loginGate, false);
    assert.equal(classifyUserGate(applicationSnapshot), null);

    const accountGate = await browser.newPage();
    await accountGate.setContent('<h1>Log in to apply</h1><label>Password <input type="password"></label>');
    const accountSnapshot = await inspectApplicationForm(accountGate);
    assert.equal(accountSnapshot.loginGate, true);
    assert.equal(classifyUserGate(accountSnapshot)?.state, 'login_required');
  } finally {
    await browser.close();
  }
});

test('visible non-blocking CAPTCHA is classified without preventing safe preparation, while consent remains unresolved', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const captcha = await browser.newPage();
    await captcha.setContent(captchaFixture);
    const captchaSnapshot = await inspectApplicationForm(captcha);
    assert.equal(captchaSnapshot.captcha.classification, 'active_non_blocking');
    assert.equal(classifyUserGate(captchaSnapshot), null);
    const consent = await browser.newPage();
    await consent.setContent(consentFixture);
    const profile = syntheticProfile;
    const plan = buildFormPlan(await inspectApplicationForm(consent), profile, {});
    assert.ok(plan.unresolvedFields.some((row) => row.semantic === 'legal_consent'));
  } finally {
    await browser.close();
  }
});

test('passive and invisible CAPTCHA allow grounded fields and exact uploads before manual review', async () => {
  const browser = await chromium.launch({ headless: true });
  const fixture = createFixtureArtifacts();
  const profile = syntheticProfile;
  try {
    for (const html of [invisibleCaptchaFixture, passiveCaptchaFixture]) {
      const page = await browser.newPage();
      await page.setContent(html);
      const result = await prepareApplicationForm(page, profile, fixture.artifacts);
      assert.equal(result.gate.state, 'review_required');
      assert.equal(result.evidence.captcha.classification, 'passive_invisible');
      assert.equal(result.evidence.captcha.manualActionRequired, true);
      assert.ok(result.evidence.filledFields.length >= 4);
      assert.equal(result.evidence.uploadedArtifacts.length, 2);
      assert.deepEqual(result.evidence.unresolvedFields, []);
      assert.equal(result.evidence.reviewComplete, false);
      assert.equal(result.evidence.finalAction.activated, false);
      assert.equal(await page.evaluate(() => window.fixtureSubmitCount || 0), 0);
      await page.close();
    }
  } finally {
    await browser.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('visible but non-blocking CAPTCHA permits safe preparation and remains separate from unresolved fields', async () => {
  const browser = await chromium.launch({ headless: true });
  const fixture = createFixtureArtifacts();
  const profile = syntheticProfile;
  try {
    const page = await browser.newPage();
    await page.setContent(visibleNonBlockingCaptchaFixture);
    const result = await prepareApplicationForm(page, profile, fixture.artifacts);
    assert.equal(result.evidence.captcha.classification, 'active_non_blocking');
    assert.equal(result.gate.state, 'review_required');
    assert.equal(result.evidence.uploadedArtifacts.length, 2);
    assert.deepEqual(result.evidence.unresolvedFields, []);
    assert.equal(result.evidence.finalAction.activated, false);
  } finally {
    await browser.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('blocking overlay, disabled fields, and uncertain CAPTCHA stop before filling with distinct evidence', async () => {
  const browser = await chromium.launch({ headless: true });
  const fixture = createFixtureArtifacts();
  const profile = syntheticProfile;
  try {
    for (const [html, classification, state] of [
      [blockingCaptchaOverlayFixture, 'active_blocking', 'blocked'],
      [disabledPendingCaptchaFixture, 'active_blocking', 'blocked'],
      [uncertainCaptchaFixture, 'uncertain', 'review_required'],
    ]) {
      const page = await browser.newPage();
      await page.setContent(html);
      const result = await prepareApplicationForm(page, profile, fixture.artifacts);
      assert.equal(result.evidence.captcha.classification, classification);
      assert.equal(result.gate.state, state);
      assert.equal(result.evidence.filledFields.length, 0);
      assert.equal(result.evidence.uploadedArtifacts.length, 0);
      assert.equal(result.evidence.finalAction.activated, false);
      await page.close();
    }
  } finally {
    await browser.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('same-page resume after user CAPTCHA completion revalidates evidence and never submits', async () => {
  const browser = await chromium.launch({ headless: true });
  const fixture = createFixtureArtifacts();
  const profile = syntheticProfile;
  try {
    const page = await browser.newPage();
    await page.setContent(invisibleCaptchaFixture);
    const paused = await prepareApplicationForm(page, profile, fixture.artifacts);
    assert.equal(paused.gate.state, 'review_required');
    await page.locator('textarea[name="g-recaptcha-response"]').evaluate((element) => {
      element.value = 'fixture-user-completed-token';
    });
    const resumed = await prepareApplicationForm(page, profile, fixture.artifacts);
    assert.equal(resumed.gate, undefined);
    assert.equal(resumed.evidence.captcha.completed, true);
    assert.equal(resumed.evidence.captcha.manualActionRequired, false);
    assert.equal(resumed.evidence.reviewComplete, true);
    assert.equal(resumed.evidence.finalAction.activated, false);
    assert.equal(await page.evaluate(() => window.fixtureSubmitCount || 0), 0);
  } finally {
    await browser.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('CAPTCHA policy is provider-neutral across ATS-style fixtures', async () => {
  const browser = await chromium.launch({ headless: true });
  const fixture = createFixtureArtifacts();
  const profile = syntheticProfile;
  try {
    for (const { provider, html } of atsStyleCaptchaFixtures) {
      const page = await browser.newPage();
      await page.setContent(html);
      const result = await prepareApplicationForm(page, profile, fixture.artifacts);
      assert.equal(result.evidence.captcha.classification, 'passive_invisible', provider);
      assert.equal(result.gate.state, 'review_required', provider);
      assert.ok(result.evidence.filledFields.length >= 4, provider);
      assert.equal(result.evidence.uploadedArtifacts.length, 2, provider);
      assert.equal(result.evidence.finalAction.activated, false, provider);
      await page.close();
    }
  } finally {
    await browser.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('duplicate or irrelevant task-created popups are closed without touching an unrelated tab', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', (route) => {
      const url = route.request().url();
      const body = url.endsWith('/apply/123') ? greenhouseFixture : url.endsWith('/irrelevant') ? '<h1>Irrelevant</h1>' : duplicatePopupFixture;
      return route.fulfill({ status: 200, contentType: 'text/html', body });
    });
    const sentinel = await context.newPage();
    await sentinel.setContent('<h1 id="sentinel">Unrelated tab</h1>');
    const listing = await context.newPage();
    await listing.goto('https://fixture.career-ops.invalid/jobs/123');
    const snapshot = await collectPageSnapshot(listing);
    const destination = await followSafeContinuation(context, listing, snapshot.controls.find((row) => row.text === 'Apply Now'), {
      listingUrl: 'https://fixture.career-ops.invalid/jobs/123',
      applyUrl: 'https://fixture.career-ops.invalid/apply/123',
      currentState: 'listing_verified',
      actualFormReached: false,
      candidateFieldSignals: 0,
    });
    assert.equal(destination.url(), 'https://fixture.career-ops.invalid/apply/123');
    assert.equal(context.pages().some((page) => page.url().endsWith('/irrelevant')), false);
    assert.equal(await sentinel.locator('#sentinel').textContent(), 'Unrelated tab');
  } finally {
    await browser.close();
  }
});
