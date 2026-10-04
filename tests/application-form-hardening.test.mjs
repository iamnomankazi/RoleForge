import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { appendFormPreparationEvidence } from '../application-batch.mjs';
import {
  buildOperationalFormPlan,
  prepareOperationalApplicationForm,
} from '../application-form-engine.mjs';
import {
  classifyFieldSemantics,
  containsUnresolvedPlaceholder,
  generateCustomNarrativeAnswer,
  resolveAuthorizationAnswer,
  validateGroundedNarrative,
} from '../application-form-policy.mjs';
import { loadApplicationProfile } from '../application-profile.mjs';

const profile = loadApplicationProfile(resolve('.'));
const candidate = {
  candidate_id: `cand_v1_${'a'.repeat(64)}`,
  company: 'Acme Data',
  title: 'Data & AI Engineer',
};
const formContext = {
  batchId: 'fixture-batch',
  candidate,
  jobCountry: 'Finland',
  jdText: 'Build reliable Python and SQL data pipelines, analytics products, APIs, and applied AI workflows.',
};
const controls = [{ type: 'submit', label: 'Submit application', insideApplicationForm: true }];
let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

function field(overrides = {}) {
  return {
    fieldId: overrides.id || `field-${Math.random()}`,
    id: overrides.id || '',
    name: overrides.name || '',
    tag: overrides.tag || 'input',
    type: overrides.type || 'text',
    role: overrides.role || '',
    autocomplete: overrides.autocomplete || '',
    label: overrides.label || '',
    questionText: overrides.questionText || overrides.label || '',
    required: overrides.required ?? true,
    disabled: false,
    visible: true,
    value: overrides.value || '',
    checked: overrides.checked || false,
    files: overrides.files || [],
    options: overrides.options || [],
    maxLength: overrides.maxLength || null,
    optionLabel: overrides.optionLabel || '',
    selectedLabel: overrides.selectedLabel || '',
  };
}

function plan(fields, context = formContext, artifacts = {}) {
  return buildOperationalFormPlan({ fields, controls }, profile, artifacts, { context });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('1–2. current location is canonical Joensuu while preferred location remains manual', () => {
  const result = plan([
    field({ id: 'city', label: 'Current city' }),
    field({ id: 'country', label: 'Country of residence' }),
    field({ id: 'location', label: 'Current location' }),
    field({ id: 'preferred', label: 'Preferred office location' }),
  ]);
  assert.equal(result.actions.find((row) => row.semantic === 'city').value, 'Joensuu');
  assert.equal(result.actions.find((row) => row.semantic === 'country').value, 'Finland');
  assert.equal(result.actions.find((row) => row.semantic === 'current_location').value, 'Joensuu, Finland');
  assert.equal(result.actions.some((row) => row.semantic === 'preferred_location'), false);
  assert.match(result.unresolvedFields.find((row) => row.semantic === 'preferred_location').reason, /application-specific/);
});

test('3–6. authorization and sponsorship are exact Yes/No decisions by verified jurisdiction', () => {
  assert.equal(resolveAuthorizationAnswer(profile, 'work_authorization', { jobCountry: 'Finland' }), 'Yes');
  assert.equal(resolveAuthorizationAnswer(profile, 'sponsorship', { jobCountry: 'Finland' }), 'No');
  assert.equal(resolveAuthorizationAnswer(profile, 'work_authorization', { jobCountry: 'Germany' }), 'No');
  assert.equal(resolveAuthorizationAnswer(profile, 'sponsorship', { jobCountry: 'Germany' }), 'Yes');
  assert.equal(resolveAuthorizationAnswer(profile, 'work_authorization', { canEmployFromFinland: true }), 'Yes');
  assert.equal(resolveAuthorizationAnswer(profile, 'sponsorship', {}), null);
});

test('7–9. required privacy is accepted, marketing is declined, and EEO stays blank or Prefer not to say', () => {
  const privacy = plan([field({ id: 'privacy', type: 'checkbox', label: 'I acknowledge the required Privacy and Data Processing Notice' })]);
  assert.equal(privacy.actions[0].action, 'check');
  const marketing = plan([field({ id: 'marketing', type: 'checkbox', label: 'Send me newsletters and marketing', required: false })]);
  assert.deepEqual(marketing.actions, []);
  const optionalEeo = plan([field({ id: 'gender', tag: 'select', type: 'select-one', label: 'Gender', required: false })]);
  assert.deepEqual(optionalEeo.actions, []);
  const requiredEeo = plan([field({
    id: 'gender-required',
    tag: 'select',
    type: 'select-one',
    label: 'Gender',
    options: [{ label: 'Woman', value: 'woman' }, { label: 'Prefer not to say', value: 'decline' }],
  })]);
  assert.equal(requiredEeo.actions[0].value, 'Prefer not to say');
});

test('10 and 18. source is LinkedIn and yes/no authorization never receives a country value', () => {
  const result = plan([
    field({
      id: 'source',
      tag: 'select',
      type: 'select-one',
      label: 'How did you hear about us?',
      options: [{ label: 'LinkedIn', value: 'linkedin' }, { label: 'Other', value: 'other' }],
    }),
    field({
      id: 'auth',
      tag: 'select',
      type: 'select-one',
      label: 'Are you legally authorized to work in Finland?',
      options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
    }),
  ]);
  assert.equal(result.actions.find((row) => row.semantic === 'application_source').value, 'LinkedIn');
  assert.equal(result.actions.find((row) => row.semantic === 'work_authorization').value, 'Yes');
  assert.equal(result.actions.some((row) => row.value === 'Finland' && row.semantic === 'work_authorization'), false);
});

test('11. source dropdown receives one retry and then commits LinkedIn', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <label for="source">How did you hear about us?</label>
      <select id="source" required>
        <option value="">Choose</option><option value="linkedin">LinkedIn</option><option value="other">Other</option>
      </select>
      <button type="submit">Submit application</button>
    </form>
    <script>
      let changes = 0;
      source.addEventListener('change', () => {
        changes += 1;
        if (changes === 1) source.value = '';
        window.sourceChanges = changes;
      });
    </script>
  `);
  const result = await prepareOperationalApplicationForm(page, profile, {}, { context: formContext });
  const attempts = result.evidence.attemptLedger.filter((row) => row.semantic === 'application_source');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].success, false);
  assert.equal(attempts[1].success, true);
  assert.equal(await page.locator('#source').inputValue(), 'linkedin');
  await page.close();
});

test('12–14. data-engineering narrative is role-specific, evidence-rich, and length-bounded', () => {
  const question = 'Tell us briefly about your experience in data analytics, data engineering, or analytics engineering and why you are a good fit for this Data & AI Engineer role.';
  const generated = generateCustomNarrativeAnswer(profile, {
    question,
    candidate,
    jdText: formContext.jdText,
  });
  assert.match(generated.answer, /Acme Data|Data & AI Engineer/);
  assert.match(generated.answer, /1\.1M|procurement/);
  assert.match(generated.answer, /Python|pandas/);
  assert.match(generated.answer, /SQL|PostgreSQL/);
  assert.match(generated.answer, /Power BI|Tableau|Excel/);
  assert.match(generated.answer, /Vision Transformers|PyTorch|Hugging Face/);
  const bounded = generateCustomNarrativeAnswer(profile, {
    question,
    candidate,
    jdText: formContext.jdText,
    maxLength: 240,
  });
  assert.ok(bounded.answer.length <= 240);
});

test('15–16. unsupported claims and unresolved placeholders are rejected', () => {
  assert.throws(
    () => validateGroundedNarrative('I delivered 99M production records.', profile, ['cv.md']),
    /unsupported numeric claim/,
  );
  assert.equal(containsUnresolvedPlaceholder('I used [tool] on [real project].'), true);
  assert.throws(
    () => validateGroundedNarrative('I used [related skill].', profile, ['cv.md']),
    /placeholder/,
  );
});

test('17. Data Notice never receives a project paragraph or free text', () => {
  const notice = field({ id: 'notice', label: 'Data Notice and privacy acknowledgement', type: 'text' });
  assert.deepEqual(classifyFieldSemantics(notice), {
    category: 'privacy_data_processing_consent',
    semantic: 'privacy_processing',
  });
  const result = plan([notice]);
  assert.deepEqual(result.actions, []);
  assert.match(result.unresolvedFields[0].reason, /asks for text/);
});

test('19–20. verified fields and verified uploads are preserved without refill or re-upload', () => {
  const result = plan([
    field({ id: 'email', label: 'Email', value: profile.candidate.email }),
    field({ id: 'cv', label: 'Resume / CV', type: 'file', files: ['Approved CV.pdf'] }),
  ], formContext, {
    cv: { intendedFilename: 'Approved CV.pdf', sha256: 'sha256:cv', resolvedPath: 'fixture.pdf' },
  });
  assert.equal(result.actions.some((row) => row.semantic === 'email'), false);
  assert.equal(result.actions.some((row) => row.semantic === 'cv_upload'), false);
  assert.ok(result.preservedFields.some((row) => row.semantic === 'email'));
  assert.ok(result.preservedUploads.some((row) => row.filename === 'Approved CV.pdf'));
});

test('21–24. autocomplete captures options, retries once, preserves other fields, and stops without a full restart', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <label for="name">First name</label><input id="name" required>
      <label for="location">Current location</label><input id="location" role="combobox" aria-autocomplete="list" required>
      <div id="options"></div>
      <button type="submit">Submit application</button>
    </form>
    <script>
      let chosen = 0;
      const locationInput = document.getElementById('location');
      locationInput.addEventListener('input', () => {
        options.innerHTML = '<button type="button" role="option">Joensuu, North Karelia, Finland</button>';
        options.querySelector('[role=option]').onclick = () => {
          chosen += 1;
          locationInput.value = chosen === 1 ? 'Helsinki, Finland' : 'Joensuu, North Karelia, Finland';
          options.innerHTML = '';
        };
      });
      window.locationChoices = () => chosen;
    </script>
  `);
  const result = await prepareOperationalApplicationForm(page, profile, {}, { context: formContext });
  const attempts = result.evidence.attemptLedger.filter((row) => row.semantic === 'current_location');
  assert.equal(attempts.length, 2);
  assert.ok(attempts.flatMap((row) => row.visibleOptions).includes('Joensuu, North Karelia, Finland'), JSON.stringify(attempts));
  assert.equal(await page.locator('#name').inputValue(), 'Noman');
  assert.equal(await page.evaluate(() => window.locationChoices()), 2);
  assert.equal(result.evidence.passBudget.fullPassesUsed, 1);
  assert.equal(result.evidence.passBudget.perFieldAttemptsAllowed, 2);
  assert.equal(result.evidence.finalAction.activated, false);
  await page.close();
});

test('22–25. unresolved location leaves the same browser page open for manual continuation', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <label for="email">Email</label><input id="email" required>
      <label for="location">Current location</label><input id="location" role="combobox" aria-autocomplete="list" required>
      <div role="option">Helsinki, Finland</div>
      <button type="submit">Submit application</button>
    </form>
  `);
  const initial = await prepareOperationalApplicationForm(page, profile, {}, { context: formContext });
  assert.equal(initial.gate.state, 'review_required');
  assert.equal(initial.evidence.browserOpenRequired, true);
  assert.equal(page.isClosed(), false);
  const emailBefore = await page.locator('#email').inputValue();
  await page.locator('#location').fill('Joensuu, Finland');
  assert.equal(await page.locator('#email').inputValue(), emailBefore);
  assert.equal(initial.evidence.browserSession.manualContinuation, true);
  await page.close();
});

test('26. process recovery carries the persisted ledger and restores only live-empty fields', async () => {
  const first = await browser.newPage();
  await first.setContent(`
    <form><label for="email">Email</label><input id="email" required><button type="submit">Submit application</button></form>
  `);
  const initial = await prepareOperationalApplicationForm(first, profile, {}, { context: formContext });
  await first.close();
  const recovered = await browser.newPage();
  await recovered.setContent(`
    <form><label for="email">Email</label><input id="email" required><button type="submit">Submit application</button></form>
  `);
  const result = await prepareOperationalApplicationForm(recovered, profile, {}, {
    context: formContext,
    previousEvidence: initial.evidence,
    resumeMode: 'process_recovery',
  });
  assert.ok(result.evidence.attemptLedger.length > initial.evidence.attemptLedger.length);
  assert.equal(await recovered.locator('#email').inputValue(), profile.candidate.email);
  assert.equal(result.evidence.browserSession.processRecovery, true);
  await recovered.close();
});

test('27. append-only form evidence preserves earlier unique passes', () => {
  const state = { formPreparation: null, formPreparationHistory: [] };
  const base = {
    schemaVersion: 2,
    passId: 'pass-1',
    resumeMode: 'initial',
    inspectedAt: '2026-07-27T00:00:00.000Z',
    reviewedAt: '2026-07-27T00:00:01.000Z',
    currentUrl: 'https://fixture.invalid/apply',
    formFingerprint: 'sha256:fixture',
    requiredFieldCount: 0,
    filledFields: [],
    committedSelections: [],
    uploadedArtifacts: [],
    unresolvedFields: [],
    validationErrors: [],
    attemptLedger: [],
    answerRecords: [],
    userActionRequired: false,
    browserOpenRequired: false,
    finalAction: { detected: true, label: 'Submit', semanticClass: 'form_submit', activated: false },
    reviewComplete: true,
    evidenceHash: 'sha256:one',
    uploadTopology: { mode: 'none', reason: 'none', fields: [] },
    captcha: null,
    passBudget: {},
    browserSession: {},
    operationalArtifacts: {},
  };
  appendFormPreparationEvidence(state, base);
  appendFormPreparationEvidence(state, base);
  appendFormPreparationEvidence(state, { ...base, passId: 'pass-2', evidenceHash: 'sha256:two' });
  assert.deepEqual(state.formPreparationHistory.map((row) => row.passId), ['pass-1', 'pass-2']);
  assert.equal(state.formPreparation.passId, 'pass-2');
});

test('28–30. final Submit, tracker, and blocking CAPTCHA protections remain untouched', async () => {
  const trackerBefore = sha256(resolve('data/applications.md'));
  const page = await browser.newPage();
  await page.setContent(`
    <form onsubmit="window.fixtureSubmits=(window.fixtureSubmits||0)+1">
      <label for="email">Email</label><input id="email" required disabled>
      <div class="hcaptcha">Human verification required</div>
      <script src="https://hcaptcha.com/1/api.js"></script>
      <button type="submit">Submit application</button>
    </form>
  `);
  const result = await prepareOperationalApplicationForm(page, profile, {}, { context: formContext });
  assert.equal(result.gate.state, 'blocked');
  assert.equal(result.evidence.filledFields.length, 0);
  assert.equal(result.evidence.finalAction.activated, false);
  assert.equal(await page.evaluate(() => window.fixtureSubmits || 0), 0);
  assert.equal(sha256(resolve('data/applications.md')), trackerBefore);
  await page.close();
});
