import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { resolveFactualEvidence } from '../application-evidence.mjs';
import { attachFactualSources } from './fixtures/application-evidence-profile.mjs';
const syntheticEvidence = [
  {
    id: 'fictional-example-warehouse',
    topics: ['data_engineering', 'analytics', 'python_sql'],
    provenance: [{ sourceType: 'cv', locator: 'lines:1' }],
  },
  {
    id: 'fictional-example-vision-lab',
    topics: ['ai_ml'],
    provenance: [{ sourceType: 'cv', locator: 'lines:2' }],
  },
  {
    id: 'fictional-example-api',
    topics: ['software_backend', 'motivation_fit'],
    provenance: [{ sourceType: 'cv', locator: 'lines:3' }],
  },
];
const syntheticCorpus = [
  'In the fictional Example Warehouse project, I validated 250K synthetic inventory records with Python, pandas, SQL, PostgreSQL, Power BI, Tableau, and Excel.',
  'In the fictional Example Vision Lab project, I evaluated Vision Transformers with PyTorch and Hugging Face.',
  'In the fictional Example API project, I built Django APIs with explicit validation and reproducible tests.',
].join('\n');
const profile = attachFactualSources({
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
    narrative_evidence: syntheticEvidence,
  },
  answers: new Map(),
  priorApprovedAnswers: [],
  cvText: syntheticCorpus,
  articleDigestText: '',
  answerBankText: syntheticCorpus,
  profileModeText: 'Synthetic fixture evidence only.',
});
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

test('1–2. current location is canonical Example City while preferred location remains manual', () => {
  const result = plan([
    field({ id: 'city', label: 'Current city' }),
    field({ id: 'country', label: 'Country of residence' }),
    field({ id: 'location', label: 'Current location' }),
    field({ id: 'preferred', label: 'Preferred office location' }),
  ]);
  assert.equal(result.actions.find((row) => row.semantic === 'city').value, 'Example City');
  assert.equal(result.actions.find((row) => row.semantic === 'country').value, 'Finland');
  assert.equal(result.actions.find((row) => row.semantic === 'current_location').value, 'Example City, Finland');
  assert.equal(result.actions.some((row) => row.semantic === 'preferred_location'), false);
  assert.match(result.unresolvedFields.find((row) => row.semantic === 'preferred_location').reason, /application-specific/);
});

test('education institution is derived from the synthetic profile rather than source literals', () => {
  const result = plan([field({ id: 'university', label: 'University' })]);
  assert.equal(result.actions.find((row) => row.semantic === 'university').value, 'Example University');
});

test('German-university enrollment never receives an institution name as a Yes/No answer', () => {
  const result = plan([field({
    id: 'german-university',
    tag: 'select',
    type: 'select-one',
    label: 'Are you enrolled in a full-time degree program at a German university?* (required)',
    options: [{ label: 'Please select', value: '' }, { label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
  })]);
  assert.equal(result.actions.some((row) => row.value === 'Example University'), false);
  assert.equal(result.actions.some((row) => row.semantic === 'german_university_enrollment'), false);
  assert.match(result.unresolvedFields.find((row) => row.semantic === 'german_university_enrollment').reason, /explicit grounded Yes or No/);
});

test('visible starred fields are treated as required when the site omits native required attributes', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <label for="choice">Relocation choice* (required)</label>
      <select id="choice"><option value="">Please select</option><option>No</option></select>
      <button type="submit">Submit application</button>
    </form>
  `);
  const result = await prepareOperationalApplicationForm(page, profile, {}, { context: formContext });
  assert.equal(result.evidence.requiredFieldCount, 1);
  assert.ok(result.evidence.unresolvedFields.some((row) => row.label.includes('Relocation choice')));
  assert.equal(result.evidence.finalAction.activated, false);
  await page.close();
});

test('hidden exact CV and cover inputs receive distinct bound artifacts and verify their own files', async () => {
  const artifactDir = mkdtempSync(join(tmpdir(), 'career-ops-hidden-uploads-'));
  const cvName = 'Approved Data CV.pdf';
  const coverName = 'Approved Cover Letter.pdf';
  const cvPath = join(artifactDir, cvName);
  const coverPath = join(artifactDir, coverName);
  writeFileSync(cvPath, 'cv bytes');
  writeFileSync(coverPath, 'cover bytes');
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <form>
        <label for="resume">Attach</label><input id="resume" name="resume" type="file" style="display:none">
        <label for="cover_letter">Attach</label><input id="cover_letter" name="cover_letter" type="file" style="display:none">
        <button type="submit">Submit application</button>
      </form>
      <script>
        resume.addEventListener('change', function () {
          window.resumeUpload = [...this.files].map(file => file.name);
          this.remove();
        });
        cover_letter.addEventListener('change', function () {
          window.coverUpload = [...this.files].map(file => file.name);
          this.remove();
        });
      </script>
    `);
    const result = await prepareOperationalApplicationForm(page, profile, {
      cv: { intendedFilename: cvName, sha256: 'sha256:cv', resolvedPath: cvPath },
      coverLetter: { intendedFilename: coverName, sha256: 'sha256:cover', resolvedPath: coverPath },
    }, { context: formContext });
    assert.deepEqual(await page.evaluate(() => window.resumeUpload), [cvName]);
    assert.deepEqual(await page.evaluate(() => window.coverUpload), [coverName]);
    assert.deepEqual(
      result.evidence.uploadedArtifacts.map((row) => [row.semantic, row.filename]),
      [['cv_upload', cvName], ['cover_letter_upload', coverName]],
    );
    assert.equal(result.evidence.attemptLedger.some((row) => row.semantic === 'cv_upload' && row.committedValue === coverName), false);
    assert.equal(result.evidence.attemptLedger.some((row) => row.semantic === 'cover_letter_upload' && row.committedValue === cvName), false);
    assert.equal(result.evidence.finalAction.activated, false);
  } finally {
    await page.close();
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test('Career-Ops field identity outranks a later duplicate site name', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <label for="first">First name</label><input id="first" name="first_name">
      <label for="email">Email</label><input id="email" name="email" type="email">
      <button type="submit">Submit application</button>
    </form>
    <script>
      first.addEventListener('input', () => {
        if (document.querySelector('#decoy')) return;
        const decoy = document.createElement('input');
        decoy.id = 'decoy'; decoy.name = 'email'; decoy.type = 'email';
        email.before(decoy);
      });
    </script>
  `);
  const result = await prepareOperationalApplicationForm(page, profile, {}, { context: formContext });
  assert.equal(await page.locator('#email').inputValue(), profile.candidate.email);
  assert.equal(await page.locator('#decoy').inputValue(), '');
  assert.equal(result.evidence.finalAction.activated, false);
  await page.close();
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
  assert.match(generated.answer, /250K|synthetic inventory/);
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
    () => validateGroundedNarrative(
      'I delivered 99M production records.',
      profile,
      [resolveFactualEvidence(profile, { sourceType: 'cv', locator: 'lines:1' })],
      { candidate },
    ),
    /wording not established/,
  );
  assert.equal(containsUnresolvedPlaceholder('I used [tool] on [real project].'), true);
  assert.throws(
    () => validateGroundedNarrative(
      'I used [related skill].',
      profile,
      [resolveFactualEvidence(profile, { sourceType: 'cv', locator: 'lines:1' })],
      { candidate },
    ),
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

test('unproven narrative remains review_required while deterministic fields are prepared', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <label for="email">Email</label><input id="email" type="email" required>
      <label for="why">Why are you a good fit for this backend role?</label><textarea id="why" required></textarea>
      <button type="submit">Submit application</button>
    </form>
  `);
  const legacy = {
    ...profile,
    formRules: {
      ...profile.formRules,
      narrative_evidence: [{
        id: 'legacy-unproven', topics: ['software_backend'], text: 'Unsupported draft prose.', evidence_refs: ['cv.md'],
      }],
    },
  };
  const result = await prepareOperationalApplicationForm(page, legacy, {}, { context: formContext });
  assert.equal(result.gate.state, 'review_required');
  assert.equal(await page.locator('#email').inputValue(), profile.candidate.email);
  assert.equal(await page.locator('#why').inputValue(), '');
  assert.match(result.evidence.unresolvedFields.find((row) => row.semantic === 'custom_narrative').reason, /legacy unproven prose/);
  assert.equal(result.evidence.finalAction.activated, false);
  await page.close();
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
        options.innerHTML = '<button type="button" role="option">Example City, Example Region, Finland</button>';
        options.querySelector('[role=option]').onclick = () => {
          chosen += 1;
          locationInput.value = chosen === 1 ? 'Helsinki, Finland' : 'Example City, Example Region, Finland';
          options.innerHTML = '';
        };
      });
      window.locationChoices = () => chosen;
    </script>
  `);
  const result = await prepareOperationalApplicationForm(page, profile, {}, { context: formContext });
  const attempts = result.evidence.attemptLedger.filter((row) => row.semantic === 'current_location');
  assert.equal(attempts.length, 2);
  assert.ok(attempts.flatMap((row) => row.visibleOptions).includes('Example City, Example Region, Finland'), JSON.stringify(attempts));
  assert.equal(await page.locator('#name').inputValue(), 'Alex');
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
  await page.locator('#location').fill('Example City, Finland');
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

test('a second controlled recovery supports an existing reviewed batch and then exhausts the bound', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form><label for="email">Email</label><input id="email" required><button type="submit">Submit application</button></form>
  `);
  const prior = {
    attemptLedger: [],
    answerRecords: [],
    unresolvedFields: [],
    passBudget: { controlledResumeUsed: 1 },
  };
  const second = await prepareOperationalApplicationForm(page, profile, {}, {
    context: formContext, previousEvidence: prior, resumeMode: 'process_recovery',
  });
  assert.equal(second.evidence.passBudget.controlledResumeUsed, 2);
  assert.equal(second.evidence.passBudget.controlledResumeAllowed, 2);
  assert.equal(await page.locator('#email').inputValue(), profile.candidate.email);
  await page.locator('#email').fill('');
  const exhausted = await prepareOperationalApplicationForm(page, profile, {}, {
    context: formContext, previousEvidence: second.evidence, resumeMode: 'process_recovery',
  });
  assert.match(exhausted.gate.reason, /budget is exhausted/);
  assert.equal(exhausted.evidence.finalAction.activated, false);
  await page.close();
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

test('28–30. final Submit and blocking CAPTCHA protections remain untouched without reading runtime data', async () => {
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
  await page.close();
});
