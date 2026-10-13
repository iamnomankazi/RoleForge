import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { appendFormPreparationEvidence } from '../application-batch.mjs';
import {
  buildOperationalFormPlan,
  inspectOperationalApplicationForm,
  prepareOperationalApplicationForm,
} from '../application-form-engine.mjs';
import {
  canonicalFieldValue,
  classifyFieldSemantics,
  containsUnresolvedPlaceholder,
  generateCustomNarrativeAnswer,
  narrativeReadyEvidenceText,
  resolveAuthorizationAnswer,
  validateGroundedNarrative,
} from '../application-form-policy.mjs';
import { groundedFieldValue } from '../application-profile.mjs';
import { createNarrativeProvenanceRecord, resolveFactualEvidence } from '../application-evidence.mjs';
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
    work_authorization: {
      home_country: 'Finland',
      finland_authorized: true,
      finland_sponsorship: false,
      outside_finland_local_authorized: false,
      outside_finland_sponsorship: true,
      ambiguous_policy: 'ask_user',
    },
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
  discovery: { urls: ['https://www.linkedin.com/jobs/view/1000000001'] },
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

test('factually distinct salary, location, and availability labels use only matching profile facts', () => {
  const cases = [
    ['Expected salary', 'salary', profile.compensation.target_range],
    ['Desired salary', 'salary', profile.compensation.target_range],
    ['Compensation expectations', 'salary', profile.compensation.target_range],
    ['What salary do you expect?', 'salary', profile.compensation.target_range],
    ['Pay expectation', 'salary', profile.compensation.target_range],
    ['Pay expectations', 'salary', profile.compensation.target_range],
    ['Expected pay', 'salary', profile.compensation.target_range],
    ['Desired pay', 'salary', profile.compensation.target_range],
    ['Remuneration expectations', 'salary', profile.compensation.target_range],
    ['What do you expect us to pay for travel expenses?', 'unknown', null],
    ['What relocation costs should we pay?', 'relocation', null],
    ['What reimbursement do you expect us to pay?', 'unknown', null],
    ['Current salary', 'salary_details', null],
    ['Salary history', 'salary_details', null],
    ['Previous compensation', 'salary_details', null],
    ['Current and expected salary', 'salary_details', null],
    ['Salary', 'salary_details', null],
    ['Country of residence', 'country', 'Finland'],
    ['Current country', 'country', 'Finland'],
    ['Country of citizenship', 'citizenship', null],
    ['Country of nationality', 'citizenship', null],
    ['Which country are you a citizen of?', 'citizenship', null],
    ['Nationality', 'citizenship', null],
    ['Country of birth', 'birth_place', null],
    ['City of birth', 'birth_place', null],
    ['Current city', 'city', 'Example City'],
    ['City of residence', 'city', 'Example City'],
    ['Which city do you currently work in?', 'city', 'Example City'],
    ['Which city do you currently live in?', 'city', 'Example City'],
    ['Which city do you currently work/live in?', 'city', 'Example City'],
    ['Which city would you like to work in?', 'preferred_location', null],
    ['Which city do you prefer to work in?', 'preferred_location', null],
    ['Which city are you willing to work in?', 'preferred_location', null],
    ['Would you like to work in another city?', 'preferred_location', null],
    ['Preferred work location', 'preferred_location', null],
    ['Desired city', 'preferred_location', null],
    ['Earliest start date', 'availability', profile.currentStatus.availability.start],
    ['Earliest join date', 'availability', profile.currentStatus.availability.start],
    ['Notice period', 'availability', profile.currentStatus.availability.start],
    ['When are you available to start?', 'availability', profile.currentStatus.availability.start],
    ['Date available', 'availability', profile.currentStatus.availability.start],
    ['Are you available for shift work?', 'schedule_availability', null],
    ['Are you available on weekends?', 'schedule_availability', null],
    ['Are you available for travel?', 'schedule_availability', null],
    ['Are you available for on-call work?', 'schedule_availability', null],
    ['Start date and weekend availability', 'schedule_availability', null],
    ['Are you available?', 'schedule_availability', null],
  ];
  for (const [label, semantic, expected] of cases) {
    const input = field({ id: 'distinct-question', label });
    const semantics = classifyFieldSemantics(input);
    assert.equal(semantics.semantic, semantic, label);
    assert.equal(canonicalFieldValue(profile, semantics, { field: input, context: formContext }), expected, label);
    const result = plan([input]);
    if (expected === null) {
      assert.deepEqual(result.actions, [], label);
      assert.equal(result.unresolvedFields[0]?.semantic, semantic, label);
    } else {
      assert.equal(result.actions[0]?.value, expected, label);
      assert.deepEqual(result.unresolvedFields, [], label);
    }
  }
});

test('citizenship uses explicit citizenship evidence without inferring birthplace from it', () => {
  const citizenProfile = { ...profile, candidate: { ...profile.candidate, citizenship: 'Example Republic' } };
  for (const [label, expected] of [
    ['Country of citizenship', 'Example Republic'],
    ['Nationality', 'Example Republic'],
    ['Country of residence', 'Finland'],
    ['Country of birth', null],
    ['Are you a citizen of Finland?', null],
  ]) {
    const input = field({ id: 'citizenship', label });
    const semantics = classifyFieldSemantics(input);
    assert.equal(canonicalFieldValue(citizenProfile, semantics, { field: input }), expected, label);
  }
});

test('authorization and sponsorship labels resolve from the corresponding configured profile keys', () => {
  const cases = [
    ['Do you require visa sponsorship?', 'Finland', 'sponsorship', 'No'],
    ['Do you require visa sponsorship?', 'Germany', 'sponsorship', 'Yes'],
    ['Are you legally authorized to work in Germany?', 'Germany', 'work_authorization', 'No'],
    ['Are you legally authorized to work in Finland?', 'Finland', 'work_authorization', 'Yes'],
    ['Are you eligible to work in Sweden?', 'Sweden', 'work_authorization', 'No'],
    ['Do you require employer immigration support?', 'Germany', 'sponsorship', 'Yes'],
    ['Are you legally authorized to work in Germany?', 'Finland', 'work_authorization', 'No'],
    ['Are you legally authorized in Germany?', 'Finland', 'work_authorization', 'No'],
    ['Would you require sponsorship if hired in Germany?', 'Finland', 'sponsorship', 'Yes'],
    ['Do you require sponsorship for employment visa status?', 'Germany', 'sponsorship', 'Yes'],
    ['Are you legally authorized to work in the United States?', 'United States', 'work_authorization', 'No'],
    ['Are you legally authorized to work in Finland?', 'Germany', 'work_authorization', 'Yes'],
    ['Are you legally authorized to work in Finland?', null, 'work_authorization', 'Yes'],
    ['Are you legally authorized to work in Germany?', null, 'work_authorization', 'No'],
    ['Are you legally authorized to work in Finland/Sweden?', 'Finland', 'work_authorization', null],
    ['Are you legally authorized to work in Finland, Sweden?', 'Finland', 'work_authorization', null],
    ['Are you legally authorized to work in Finland & Sweden?', 'Finland', 'work_authorization', null],
    ['Are you authorized to work in the EU?', 'Finland', 'work_authorization', null],
    ['Will you currently or in the future require visa sponsorship?', 'Finland', 'sponsorship', null],
    ['Are you eligible to work without any restrictions?', 'Finland', 'work_authorization', null],
    ['Are you legally authorized to work in any EU/EEA country?', 'Germany', 'work_authorization', null],
    ['Do you require visa sponsorship?', null, 'sponsorship', null],
    ['Do you require visa sponsorship?', 'Finland or Germany', 'sponsorship', null],
    ['Are you authorized to work in Finland or Germany?', 'Finland', 'work_authorization', null],
    ['Are you legally authorized to work without sponsorship?', 'Finland', 'sponsorship', null],
    ['Do you not require visa sponsorship?', 'Finland', 'sponsorship', null],
  ];
  for (const [label, jobCountry, semantic, expected] of cases) {
    const input = field({ id: 'authorization-question', label, tag: 'select', type: 'select-one', options: [
      { label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' },
    ] });
    assert.equal(classifyFieldSemantics(input).semantic, semantic, label);
    const result = plan([input], { ...formContext, jobCountry });
    if (expected === null) {
      assert.deepEqual(result.actions, [], label);
      assert.equal(result.unresolvedFields[0]?.semantic, semantic, label);
    } else {
      assert.equal(result.actions[0]?.value, expected, label);
      assert.deepEqual(result.unresolvedFields, [], label);
    }
  }
});

test('country names and aliases preserve distinct jurisdictions without requiring job context', () => {
  for (const country of [
    'Germany', 'Deutschland', 'Sweden', 'United States', 'United States of America', 'USA', 'US', 'U.S.',
    'United Kingdom', 'UK', 'Holland', 'Turkey', 'Czech Republic', 'Ivory Coast',
    'Equatorial Guinea', 'Papua New Guinea', 'South Sudan', '\u00c5land Islands',
  ]) {
    const question = `Are you legally authorized to work in ${country}?`;
    assert.equal(resolveAuthorizationAnswer(profile, 'work_authorization', { question }), 'No', country);
    assert.equal(groundedFieldValue(profile, 'work_authorization', { question }), 'No', country);
    assert.equal(resolveAuthorizationAnswer(profile, 'sponsorship', { question: `Do you require visa sponsorship in ${country}?` }), 'Yes', country);
  }
  for (const country of ['Finland', 'Suomi', 'Finland/Suomi']) {
    const question = `Are you legally authorized to work in ${country}?`;
    assert.equal(resolveAuthorizationAnswer(profile, 'work_authorization', { question }), 'Yes', country);
    assert.equal(groundedFieldValue(profile, 'work_authorization', { country: 'Germany', question }), 'Yes', country);
  }
  for (const separator of ['/', ', ', ' & ', '; ', ' and ', ' or ']) {
    for (const question of [
      `Are you legally authorized to work in Suomi${separator}Deutschland?`,
      `Do you require sponsorship in U.S.${separator}UK?`,
    ]) {
      assert.equal(resolveAuthorizationAnswer(profile, classifyFieldSemantics(field({ label: question })).semantic, {
        jobCountry: 'Finland', question,
      }), null, question);
    }
  }
  assert.equal(resolveAuthorizationAnswer(profile, 'sponsorship', {
    jobCountry: 'Finland', question: 'Do you require us to sponsor your visa?',
  }), 'No');
});

test('broad, future, and unrestricted scopes stay unresolved despite a known country or remote arrangement', () => {
  for (const scope of [
    'the EU', 'the EEA', 'Europe', 'the European Union', 'the European Economic Area', 'the Schengen area',
    'any country', 'any European country', 'any countries', 'worldwide', 'anywhere',
    'Finland in the future', 'Finland at any time', 'Finland now or later',
    'Finland without restrictions', 'Finland without any restrictions', 'Finland unrestricted',
    'Finland permanently', 'Finland for an indefinite period', 'Finland for any employer',
  ]) {
    for (const [semantic, question] of [
      ['work_authorization', `Are you legally authorized to work in ${scope}?`],
      ['sponsorship', `Do you require visa sponsorship in ${scope}?`],
    ]) {
      assert.equal(resolveAuthorizationAnswer(profile, semantic, {
        jobCountry: 'Finland', canEmployFromFinland: true, question,
      }), null, question);
    }
  }
  assert.equal(resolveAuthorizationAnswer(profile, 'sponsorship', {
    jobCountry: 'Finland', question: 'Will you ever require visa sponsorship?',
  }), null);
  assert.equal(resolveAuthorizationAnswer(profile, 'sponsorship', {
    jobCountry: 'Finland', question: 'Are you eligible to work without sponsorship?',
  }), null);
  for (const jobCountry of [null, '', 'Unknown', 'Exampleland', 'EU', 'EEA', 'Europe', 'Schengen', 'Remote', 'Worldwide', 'Finland/Sweden', 'Finland, Sweden', 'Finland & Sweden']) {
    for (const semantic of ['work_authorization', 'sponsorship']) {
      assert.equal(resolveAuthorizationAnswer(profile, semantic, { jobCountry }), null, `${semantic}: ${jobCountry}`);
    }
  }
  for (const context of [{ hiringArrangement: 'remote Finland' }, { canEmployFromFinland: true }, { canEmployFromHomeCountry: true }]) {
    assert.equal(resolveAuthorizationAnswer(profile, 'work_authorization', context), 'Yes');
    assert.equal(resolveAuthorizationAnswer(profile, 'sponsorship', context), 'No');
  }
});

test('configured authorization values override country defaults and incomplete policies remain unresolved', () => {
  const changed = { ...profile, formRules: { ...profile.formRules, work_authorization: {
    home_country: 'Germany',
    finland_authorized: 'No', finland_sponsorship: 'Yes',
    outside_finland_local_authorized: 'Yes', outside_finland_sponsorship: 'No',
    ambiguous_policy: 'ask_user',
  } } };
  for (const [country, semantic, expected] of [
    ['Finland', 'work_authorization', 'No'], ['Finland', 'sponsorship', 'Yes'],
    ['Germany', 'work_authorization', 'Yes'], ['Germany', 'sponsorship', 'No'],
  ]) {
    assert.equal(resolveAuthorizationAnswer(changed, semantic, { jobCountry: country }), expected);
    assert.equal(groundedFieldValue(changed, semantic, { country }), expected);
  }
  for (const value of [undefined, null, '', 'ask_user', 'depends on the permit', 'Yes if approved']) {
    const incomplete = { ...profile, formRules: { ...profile.formRules, work_authorization: {
      home_country: 'Finland', finland_authorized: value, finland_sponsorship: value,
      outside_finland_local_authorized: value, outside_finland_sponsorship: value, ambiguous_policy: 'ask_user',
    } } };
    for (const country of ['Finland', 'Germany']) {
      for (const semantic of ['work_authorization', 'sponsorship']) {
        assert.equal(resolveAuthorizationAnswer(incomplete, semantic, { jobCountry: country }), null);
        assert.equal(groundedFieldValue(incomplete, semantic, { country }), null);
      }
    }
  }
  assert.equal(groundedFieldValue(profile, 'sponsorship'), null);
  assert.equal(groundedFieldValue(profile, 'work_authorization'), null);
  assert.equal(resolveAuthorizationAnswer(changed, 'sponsorship', {}), null);
  assert.equal(resolveAuthorizationAnswer(changed, 'work_authorization', { canEmployFromHomeCountry: true }), 'Yes');
  const explicitRemoteQuestion = field({ label: 'Are you legally authorized to work in Germany?' });
  assert.equal(canonicalFieldValue(profile, classifyFieldSemantics(explicitRemoteQuestion), {
    field: explicitRemoteQuestion, context: { jobCountry: 'Germany', canEmployFromFinland: true },
  }), 'No');
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

test('multiline cover-letter text preserves paragraph breaks in the textarea', async () => {
  const page = await browser.newPage();
  const answer = 'Paragraph one.\n\nParagraph two.';
  const provenance = createNarrativeProvenanceRecord({
    candidateId: candidate.candidate_id,
    normalizedQuestion: 'cover letter document',
    answer,
    wording: 'generated',
    templateId: 'cover-letter-v1',
    factualEvidence: [resolveFactualEvidence(profile, { sourceType: 'cv', locator: 'lines:1' })],
  });
  await page.setContent(`
    <form><label for="cover">Cover letter</label><textarea id="cover"></textarea>
      <button type="button" onclick="window.finalClicked=true">Apply</button></form>
  `);
  const result = await prepareOperationalApplicationForm(page, profile, {
    coverLetterTextContent: answer,
    coverLetterTextProvenance: provenance,
  }, { context: formContext });
  assert.equal(await page.locator('#cover').inputValue(), answer);
  assert.equal(result.evidence.finalAction.activated, false);
  assert.equal(await page.evaluate(() => Boolean(window.finalClicked)), false);
  await page.close();
});

test('Markdown CV structure is rejected instead of emerging as literal cover-letter prose', () => {
  const markdownProfile = attachFactualSources({
    ...profile,
    formRules: {
      ...profile.formRules,
      narrative_evidence: [{
        id: 'mixed-markdown',
        topics: ['software_backend', 'motivation_fit'],
        provenance: [{ sourceType: 'cv', locator: 'lines:1-3' }],
      }],
    },
    cvText: '### Project\n- Built a verified backend API.\n- **Languages:** Python, SQL',
  });
  assert.throws(() => generateCustomNarrativeAnswer(markdownProfile, {
    question: 'Why are you a good fit for this software backend role?',
    candidate,
    jdText: 'Python backend APIs',
  }), /not narrative-ready/);
  assert.equal(narrativeReadyEvidenceText('### Project\n- Built a verified backend API.'), 'I built a verified backend API.');
});

test('composite phone widget keeps dial selector and telephone value type-safe', async () => {
  const page = await browser.newPage();
  const phoneProfile = {
    ...profile,
    candidate: { ...profile.candidate, phone: '+358401234567' },
    formRules: { ...profile.formRules, phone: { dial_code: '+358' } },
  };
  await page.setContent(`
    <form><fieldset><legend>Phone country code</legend>
      <label for="dial">Country / dial code</label>
      <select id="dial"><option value="">Select</option><option value="+358">+358</option></select>
      <label for="number">Phone country code Phone number</label>
      <input id="number" name="phone" type="tel">
    </fieldset><button type="button">Apply</button></form>
  `);
  const result = await prepareOperationalApplicationForm(page, phoneProfile, {}, { context: formContext });
  assert.equal(await page.locator('#dial').inputValue(), '+358');
  assert.equal(await page.locator('#number').inputValue(), '401234567');
  const controls = result.evidence.operationalArtifacts.phoneControls;
  assert.equal(controls.find((row) => row.id === 'dial').semantic, 'phone_dial_code');
  assert.equal(controls.find((row) => row.id === 'number').semantic, 'phone');
  assert.equal(controls.find((row) => row.id === 'number').value, '401234567');
  assert.notEqual(await page.locator('#number').inputValue(), 'Finland');
  await page.close();
});

test('continuous international phone never guesses a four-digit dial code', async () => {
  const page = await browser.newPage();
  const phoneProfile = { ...profile, candidate: { ...profile.candidate, phone: '+358401234567' } };
  await page.setContent(`
    <form><label for="dial">Phone dial code</label><select id="dial" required><option value="">Select</option><option value="+358">+358</option><option value="+3584">+3584</option></select>
      <label for="number">Phone number</label><input id="number" type="tel" required><button type="button">Apply</button></form>
  `);
  const result = await prepareOperationalApplicationForm(page, phoneProfile, {}, { context: formContext });
  assert.equal(await page.locator('#dial').inputValue(), '');
  assert.notEqual(await page.locator('#dial').inputValue(), '+3584');
  assert.ok(result.evidence.unresolvedFields.some((row) => row.semantic === 'phone_dial_code'));
  await page.close();
});

test('telephone verification accepts site-normalized spacing without changing the phone digits', async () => {
  const page = await browser.newPage();
  const phoneProfile = { ...profile, candidate: { ...profile.candidate, phone: '+358 40 123 4567' } };
  await page.setContent(`<form><label for="phone">Phone</label><input id="phone" type="tel"><button type="button">Apply</button></form>`);
  await page.locator('#phone').evaluate((input) => input.addEventListener('blur', () => { input.value = input.value.replace(/\s+/g, ''); }));
  const result = await prepareOperationalApplicationForm(page, phoneProfile, {}, { context: formContext });
  assert.equal(await page.locator('#phone').inputValue(), '+358401234567');
  assert.equal(result.evidence.unresolvedFields.some((row) => row.semantic === 'phone'), false);
  assert.equal(result.evidence.operationalArtifacts.phoneControls[0].value, '+358401234567');
  await page.close();
});

test('terminal type=button Apply is untouched during automation and normal user submission works after handoff', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form id="application"><label for="email">Email</label><input id="email" name="email">
      <button id="final" type="button" onclick="window.finalClicked=true">Apply</button></form>
    <script>application.addEventListener('submit', event => { event.preventDefault(); window.userSubmits=(window.userSubmits||0)+1; });</script>
  `);
  const result = await prepareOperationalApplicationForm(page, profile, {}, { context: formContext });
  assert.equal(result.evidence.finalAction.detected, true);
  assert.equal(result.evidence.finalAction.activated, false);
  assert.equal(await page.evaluate(() => Boolean(window.finalClicked)), false);
  assert.equal(await page.evaluate(() => Boolean(window.__careerOpsOperationalGuard)), false);
  assert.equal(result.evidence.operationalArtifacts.submissionGuardActiveAtHandoff, false);
  await page.locator('#application').evaluate((form) => form.requestSubmit());
  assert.equal(await page.evaluate(() => window.userSubmits || 0), 1);
  await page.close();
});

test('HRworks form-group labels bind opaque numeric controls and preserve the final anchor', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form id="application" method="post">
    <div class="form-group"><label class="control-label"><span>First name</span>:</label><input name="1-72" placeholder="Mandatory"></div>
    <div class="form-group"><label class="control-label"><span>Last name</span>:</label><input name="1-81" placeholder="Mandatory"></div>
    <div class="form-group"><label class="control-label"><span>Email</span>:</label><input name="1-91" placeholder="Mandatory"></div>
    <div class="form-group"><label class="control-label"><span>Application documents</span>:</label><input name="file" type="file" accept=".pdf"></div>
    <a class="btn" id="submit-link">Submit application</a>
  </form>`);
  const snapshot = await inspectOperationalApplicationForm(page);
  assert.equal(snapshot.fields.find((field) => field.name === '1-72').questionText, 'First name:');
  assert.equal(snapshot.fields.find((field) => field.name === '1-72').required, true);
  const result = await prepareOperationalApplicationForm(page, profile, {}, { context: formContext });
  assert.equal(await page.locator('[name="1-72"]').inputValue(), profile.candidate.full_name.split(' ')[0]);
  assert.equal(await page.locator('[name="1-81"]').inputValue(), profile.candidate.full_name.split(' ').at(-1));
  assert.equal(await page.locator('[name="1-91"]').inputValue(), profile.candidate.email);
  assert.equal(result.evidence.uploadTopology.mode, 'single_combined');
  assert.equal(result.evidence.finalAction.detected, true);
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

test('10 and 18. source follows LinkedIn discovery provenance and yes/no authorization never receives a country value', () => {
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
      <label for="location">Current location</label><input id="location" role="combobox" aria-autocomplete="list" aria-controls="options" required>
      <div id="options" role="listbox"></div>
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

test('Confirm email and Confirm phone number remain fillable with the submission guard active', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form id="application">
      <label>Confirm email<input id="email" name="confirm_email" type="email" aria-label="Confirm email" required></label>
      <label>Confirm phone number<input id="phone" name="confirm_phone" type="tel" aria-label="Confirm phone number" required></label>
      <label>LinkedIn<input name="linkedin"></label>
      <label>Send me updates<input id="updates" type="checkbox"></label>
      <button type="submit" onclick="window.finalClicks=(window.finalClicks||0)+1">Absenden</button>
    </form><script>
      updates.addEventListener('click', () => { window.updateClicks=(window.updateClicks||0)+1; });
      application.addEventListener('submit', event => { event.preventDefault(); window.submits=(window.submits||0)+1; });
    </script>
  `);
  const result = await prepareOperationalApplicationForm(page, profile, {}, { context: formContext });
  assert.equal(await page.locator('#email').inputValue(), profile.candidate.email);
  assert.equal(await page.locator('#phone').inputValue(), profile.candidate.phone);
  await page.locator('#updates').check();
  assert.equal(await page.evaluate(() => window.updateClicks || 0), 1);
  assert.equal(await page.evaluate(() => window.finalClicks || 0), 0);
  assert.equal(await page.evaluate(() => window.submits || 0), 0);
  assert.equal(result.evidence.finalAction.detected, true);
  assert.equal(result.evidence.finalAction.activated, false);
  await page.close();
});

test('untyped autocomplete options retain their handlers while native submission stays blocked', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <button id="unrelated-option" type="button" role="option">Finland</button>
    <form id="application">
      <label for="location">Location</label><input id="location" role="combobox" aria-autocomplete="list" aria-controls="location-options" required>
      <div id="location-options" role="listbox"></div>
      <button type="submit">Submit application</button>
    </form>
    <script>
      const queries = [];
      let unrelatedClicks = 0;
      let ownedClicks = 0;
      const locationInput = document.getElementById('location');
      const locationOptions = document.getElementById('location-options');
      document.getElementById('unrelated-option').onclick = () => { unrelatedClicks += 1; };
      locationInput.addEventListener('input', () => {
        queries.push(locationInput.value);
        if (locationInput.value.toLowerCase() !== 'finland') {
          locationOptions.innerHTML = '<div role="status">No options</div>';
          return;
        }
        locationOptions.innerHTML = '<button id="owned-option" role="option">Finland</button>';
        locationOptions.querySelector('[role=option]').onclick = () => {
          ownedClicks += 1;
          locationInput.value = 'Finland';
          locationOptions.innerHTML = '';
        };
      });
      window.locationQueries = () => queries;
      window.autocompleteClicks = () => ({ unrelatedClicks, ownedClicks });
      application.addEventListener('submit', event => { event.preventDefault(); window.submits=(window.submits||0)+1; });
    </script>
  `);
  const result = await prepareOperationalApplicationForm(page, profile, {}, { context: formContext });
  const attempts = result.evidence.attemptLedger.filter((row) => row.semantic === 'current_location');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].success, true);
  assert.equal(attempts[0].committedValue, 'Finland');
  assert.ok(attempts[0].visibleOptions.includes('Finland'));
  assert.ok((await page.evaluate(() => window.locationQueries())).includes('Example City, Finland'));
  assert.ok((await page.evaluate(() => window.locationQueries())).includes('Finland'));
  assert.deepEqual(await page.evaluate(() => window.autocompleteClicks()), { unrelatedClicks: 0, ownedClicks: 1 });
  assert.equal(await page.locator('#location').inputValue(), 'Finland');
  assert.deepEqual(
    result.evidence.committedSelections.filter((row) => row.semantic === 'current_location').map((row) => row.label),
    ['Finland'],
  );
  assert.equal(result.evidence.unresolvedFields.some((row) => row.semantic === 'current_location'), false);
  const verifiedSnapshot = await inspectOperationalApplicationForm(page);
  const verifiedPlan = buildOperationalFormPlan(verifiedSnapshot, profile, {}, { context: formContext });
  assert.equal(verifiedPlan.actions.some((row) => row.semantic === 'current_location'), false);
  assert.equal(verifiedPlan.preservedFields.some((row) => row.semantic === 'current_location'), true);
  assert.equal(result.evidence.finalAction.activated, false);
  assert.equal(await page.evaluate(() => window.submits || 0), 0);
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
  assert.ok(initial.evidence.unresolvedFields.some((field) => field.semantic === 'current_location'
    && field.reason === 'Autocomplete option list is not uniquely owned by current_location'));
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

test('a newly bound document revision gets one fresh controlled preparation pass', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form><label for="email">Email</label><input id="email" required><button type="submit">Submit application</button></form>
  `);
  const prior = {
    attemptLedger: [],
    answerRecords: [],
    unresolvedFields: [],
    uploadedArtifacts: [{ semantic: 'cover_letter_upload', sha256: 'sha256:old-cover' }],
    passBudget: { controlledResumeUsed: 2 },
  };
  const result = await prepareOperationalApplicationForm(page, profile, {
    coverLetter: { sha256: 'sha256:new-cover' },
  }, {
    context: formContext, previousEvidence: prior, resumeMode: 'process_recovery',
  });
  assert.equal(await page.locator('#email').inputValue(), profile.candidate.email);
  assert.equal(result.evidence.passBudget.controlledResumeUsed, 1);
  assert.equal(result.evidence.passBudget.artifactRevisionReset, true);
  await page.close();
});

test('a newly bound combined document gets one upload pass after topology review', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form><label for="email">Email</label><input id="email" required><button type="submit">Submit application</button></form>`);
  const prior = {
    attemptLedger: [], answerRecords: [], unresolvedFields: [], uploadedArtifacts: [],
    uploadTopology: { mode: 'single_combined' },
    passBudget: { controlledResumeUsed: 2 },
  };
  const result = await prepareOperationalApplicationForm(page, profile, {
    combinedDocument: { sha256: 'sha256:new-combined' },
  }, {
    context: formContext, previousEvidence: prior, resumeMode: 'process_recovery',
  });
  assert.equal(await page.locator('#email').inputValue(), profile.candidate.email);
  assert.equal(result.evidence.passBudget.controlledResumeUsed, 1);
  assert.equal(result.evidence.passBudget.artifactRevisionReset, true);
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
  assert.equal(result.gate.state, 'human_action_required');
  assert.equal(result.gate.cause, 'captcha');
  assert.equal(result.evidence.filledFields.length, 0);
  assert.equal(result.evidence.finalAction.activated, false);
  assert.equal(await page.evaluate(() => window.fixtureSubmits || 0), 0);
  await page.close();
});
