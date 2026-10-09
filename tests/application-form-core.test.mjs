import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import {
  buildFormPlan,
  classifyApplicationControl,
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
  const workflow = { insideApplicationForm: true, candidateFieldCount: 2, workflowVerified: true, hasRemainingStep: true, stepIndicator: { current: 1, total: 3 }, formId: 'application', applicationFormId: 'application' };
  assert.equal(classifyApplicationControl({ ...workflow, type: 'submit', label: 'Continue' }), 'progression');
  assert.equal(classifyApplicationControl({ ...workflow, type: 'submit', label: 'Next' }), 'progression');
  assert.equal(classifyApplicationControl({ ...workflow, type: 'submit', formAction: '/step/2', label: 'Save and continue' }), 'progression');
  assert.equal(isSemanticFinalAction({ type: 'submit', label: 'Submit application', insideApplicationForm: true }), true);
  assert.equal(isSemanticFinalAction({ type: 'button', label: 'Apply Now', insideApplicationForm: false }), false);
  assert.equal(isSemanticFinalAction({ type: 'button', label: 'Apply Now', insideApplicationForm: true }), true);
  assert.equal(classifyApplicationControl({ ...workflow, type: 'submit', label: 'Continue and submit' }), 'final');
  assert.equal(classifyApplicationControl({ ...workflow, type: 'submit', label: 'Review application' }), 'ambiguous');
  assert.equal(classifyApplicationControl({ ...workflow, type: 'button', label: 'Review application' }), 'ambiguous');
  assert.equal(classifyApplicationControl({ ...workflow, type: 'submit', label: 'Continue', hasRemainingStep: false }), 'ambiguous');
});

test('localized progression requires a numbered remaining step and all final words are terminal', () => {
  const workflow = {
    type: 'submit', insideApplicationForm: true, candidateFieldCount: 2, workflowVerified: true,
    hasRemainingStep: true, stepIndicator: { current: 1, total: 3 }, formId: 'application', applicationFormId: 'application',
  };
  for (const label of ['seuraava', 'jatka', 'nästa', 'fortsätt', 'volgende', 'doorgaan', 'næste', 'fortsæt', 'weiter']) {
    assert.equal(classifyApplicationControl({ ...workflow, label }), 'progression', label);
    assert.equal(classifyApplicationControl({ ...workflow, label, stepIndicator: null }), 'ambiguous', label);
    assert.equal(classifyApplicationControl({ ...workflow, label, stepIndicator: { current: 3, total: 3 } }), 'ambiguous', label);
  }
  for (const label of [
    'Submit', 'Send application', 'Apply now', 'Finish', 'Complete', 'Confirm',
    'Absenden', 'Senden', 'Jetzt bewerben', 'Abschicken', 'Verzenden', 'Versturen', 'Solliciteren',
    'Send', 'Indsend', 'Ansøg', 'Lähetä hakemus', 'Hae', 'Valmis', 'Skicka', 'Ansök',
    'Envoyer', 'Postuler', 'Soumettre', 'Valider', 'Continue and submit', 'Weiter und Absenden',
  ]) {
    assert.equal(classifyApplicationControl({ ...workflow, label }), 'final', label);
    assert.equal(isSemanticFinalAction({ ...workflow, label }), true, label);
  }
  assert.equal(classifyApplicationControl({ ...workflow, label: 'Continue', text: 'Lähetä hakemus' }), 'final');
  assert.equal(classifyApplicationControl({ ...workflow, label: 'Continue', stepIndicator: { current: 0, total: 3 } }), 'ambiguous');
  assert.equal(classifyApplicationControl({ ...workflow, label: 'Continue', stepIndicator: { current: 1.5, total: 3 } }), 'ambiguous');
});

test('legacy authorization uses the question jurisdiction and supplied job context without dropdown overrides', () => {
  const profile = { ...syntheticProfile, formRules: { ...syntheticProfile.formRules, work_authorization: {
    home_country: 'Finland', finland_authorized: 'Yes', finland_sponsorship: 'No',
    outside_finland_local_authorized: 'No', outside_finland_sponsorship: 'Yes', ambiguous_policy: 'manual',
  } } };
  const cases = [
    ['Are you legally authorized to work in Finland?', null, 'Yes'],
    ['Are you legally authorized to work in Finland?', 'Finland', 'Yes'],
    ['Are you legally authorized in Germany?', 'Finland', 'No'],
    ['Are you legally authorized to work in the United States?', 'United States', 'No'],
    ['Would you require sponsorship if hired in Germany?', 'Finland', 'Yes'],
    ['Do you require sponsorship for employment visa status?', 'Germany', 'Yes'],
    ['Do you require visa sponsorship?', 'Finland', 'No'],
    ['Are you legally authorized to work?', 'Germany', 'No'],
    ['Do you require visa sponsorship?', null, null],
    ['Are you legally authorized to work?', null, null],
    ['Are you legally authorized to work in Finland/Sweden?', 'Finland', null],
    ['Are you legally authorized to work in Finland, Sweden?', 'Finland', null],
    ['Are you authorized to work in the EU?', 'Finland', null],
    ['Will you currently or in the future require visa sponsorship?', 'Finland', null],
    ['Are you eligible to work without any restrictions?', 'Finland', null],
    ['Are you eligible to work without sponsorship?', 'Finland', null],
  ];
  for (const [questionText, jobCountry, expected] of cases) {
    for (const control of [
      { tag: 'select', type: 'select-one', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] },
      { tag: 'input', type: 'text', role: 'combobox' },
      { tag: 'input', type: 'text' },
    ]) {
      const snapshot = { fields: [{ ...control, fieldId: 'authorization', label: 'Answer', questionText, required: true }], controls: [] };
      for (const options of [{ jobCountry }, { context: { jobCountry } }]) {
        const plan = buildFormPlan(snapshot, profile, {}, options);
        if (expected === null) {
          assert.deepEqual(plan.actions, [], questionText);
          assert.equal(plan.unresolvedFields.length, 1, questionText);
        } else {
          assert.equal(plan.actions[0]?.value, expected, questionText);
          assert.deepEqual(plan.unresolvedFields, [], questionText);
        }
      }
    }
  }
  const snapshot = { fields: [{ fieldId: 'authorization', label: 'Work authorization', groupLabel: 'In Finland/Sweden?', required: true }], controls: [] };
  assert.deepEqual(buildFormPlan(snapshot, profile, {}, { jobCountry: 'Finland' }).actions, []);
  for (const work_authorization of [
    { home_country: 'Finland', finland_authorized: 'No' },
    { home_country: 'Finland' },
  ]) {
    const changed = { ...profile, formRules: { ...profile.formRules, work_authorization } };
    const result = buildFormPlan({ fields: [{
      fieldId: 'authorization', label: 'Are you legally authorized to work in Finland?', tag: 'select', required: true,
      options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
    }], controls: [] }, changed, {});
    if (work_authorization.finland_authorized) assert.equal(result.actions[0]?.value, 'No');
    else assert.deepEqual(result.actions, []);
  }
});

test('legacy classification keeps current city, preferred city, and travel expenses distinct', () => {
  for (const [label, semantic, value] of [
    ['Which city do you currently work in?', 'city', 'Example City'],
    ['Which city do you currently live in?', 'city', 'Example City'],
    ['Which city would you like to work in?', 'preferred_location', null],
    ['What do you expect us to pay for travel expenses?', 'free_text', null],
    ['Expected pay', 'salary', syntheticProfile.compensation.target_range],
    ['Desired pay', 'salary', syntheticProfile.compensation.target_range],
    ['Remuneration expectations', 'salary', syntheticProfile.compensation.target_range],
  ]) {
    const field = { fieldId: 'distinct', tag: 'input', type: 'text', label, required: true };
    assert.equal(classifyField(field), semantic, label);
    const plan = buildFormPlan({ fields: [field], controls: [] }, syntheticProfile, {});
    if (value === null) {
      assert.deepEqual(plan.actions, [], label);
      assert.equal(plan.unresolvedFields[0]?.semantic, semantic, label);
    } else assert.equal(plan.actions[0]?.value, value, label);
  }
});

test('legacy preparation and review retain the supplied job jurisdiction', async () => {
  const profile = { ...syntheticProfile, formRules: { ...syntheticProfile.formRules, work_authorization: {
    home_country: 'Finland', finland_authorized: 'Yes', finland_sponsorship: 'No',
    outside_finland_local_authorized: 'No', outside_finland_sponsorship: 'Yes',
  } } };
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form id="application">
      <label>Email <input name="email" type="email" required></label>
      <label>Are you legally authorized to work?
        <select id="authorization" required><option value="">Choose</option><option>Yes</option><option>No</option></select>
      </label>
      <label>Do you require sponsorship for employment visa status?
        <select id="sponsorship" required><option value="">Choose</option><option>Yes</option><option>No</option></select>
      </label>
      <button type="submit">Submit application</button>
    </form>`);
    const result = await prepareApplicationForm(page, profile, {}, { context: { jobCountry: 'Germany' } });
    assert.equal(await page.locator('#authorization').inputValue(), 'No');
    assert.equal(await page.locator('#sponsorship').inputValue(), 'Yes');
    assert.equal(result.plan.actions.find((action) => action.semantic === 'work_authorization')?.value, 'No');
    assert.equal(result.plan.actions.find((action) => action.semantic === 'sponsorship')?.value, 'Yes');
    assert.deepEqual(result.evidence.unresolvedFields, []);
    assert.equal(result.evidence.finalAction.activated, false);
  } finally {
    await browser.close();
  }
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
