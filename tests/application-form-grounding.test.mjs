import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright';
import { buildOperationalFormPlan, executeOperationalFormPlan, inspectOperationalApplicationForm } from '../application-form-engine.mjs';
import { canonicalFieldValue, classifyFieldSemantics, generateCustomNarrativeAnswer, normalizeFormQuestion, resolveAuthorizationAnswer, validatePlannedValueForControl } from '../application-form-policy.mjs';
import { validateNarrativeProvenanceRecord } from '../application-evidence.mjs';
import { attachFactualSources } from './fixtures/application-evidence-profile.mjs';

const cvText = [
  '# Alex Example',
  '## Technical Skills',
  '- **Programming:** Python, SQL, JavaScript; familiarity with Rust',
  '- **Languages:** TypeScript, Bash; Java concepts',
  '- **Tools:** Docker, Git',
  '## Projects',
  '### Example Reporting Project',
  '- Built SQL reports for synthetic inventory records.',
  '### Example Security Project',
  '- Built Python APIs for a security prototype.',
  '- Implemented validation and failure handling for ambiguous API responses.',
  '- Tested the security prototype with synthetic inputs.',
  '## Education',
  'Example University',
].join('\n');
const profile = attachFactualSources({
  candidate: { full_name: 'Alex Example', email: 'alex@example.test', phone: '+358 40 0000000' },
  location: { city: 'Example City', country: 'Finland' },
  currentStatus: { availability: { start: 'Available immediately' } },
  formRules: {
    current_location: { city: 'Example City', country: 'Finland', combined: 'Example City, Finland' },
    work_authorization: { home_country: 'Finland', finland_authorized: 'Yes', outside_finland_local_authorized: 'No' },
    narrative_evidence: [{ id: 'example-backend', topics: ['software_backend', 'motivation_fit'], provenance: [{ sourceType: 'cv', locator: 'lines:10' }] }],
  },
  cvText,
});
const context = {
  candidate: { candidate_id: 'cand_v1_example_grounding', company: 'Example Company', title: 'Backend Engineer' },
  jobCountry: 'Germany',
  jdText: 'Build Python backend APIs and security tooling. Work with ambiguous API responses.',
};
const field = (question, overrides = {}) => ({
  fieldId: 'example-field', id: 'example-field', label: question, questionText: question,
  type: 'text', tag: 'input', required: true, visible: true, value: '', options: [], ...overrides,
});
const answer = (question, p = profile, overrides = {}) => {
  const f = field(question, overrides);
  return canonicalFieldValue(p, classifyFieldSemantics(f), { field: f, context });
};
const interested = 'Why are you interested in Example Company?';
const projectQuestion = 'Briefly describe a recent project, problem, or challenge you are proud of, especially working within ambiguity in a start-up environment.';

test('education date segments never resolve to availability, including numeric years', () => {
  for (const question of ['Start date month', 'Start date year', 'End date month', 'End date year']) {
    const f = field(question, { type: question.endsWith('year') ? 'number' : 'text' });
    assert.equal(classifyFieldSemantics(f).semantic, 'education_date');
    assert.equal(answer(question, profile, f), null);
  }
  assert.equal(answer('Start date', profile, { educationContext: true }), null);
  assert.throws(() => validatePlannedValueForControl(field('Start date', { type: 'number' }), { category: 'availability' }, 'Available immediately'), /numeric/);
  assert.equal(answer('How quickly are you looking to start a new role?'), 'Available immediately');
});

test('current-country authorization resolves residence while broad and lasting rights stay manual', () => {
  for (const ending of ['currently living', 'currently residing', 'living', 'residing']) {
    assert.equal(answer(`Are you authorized to work in the European country where you are ${ending}?`), 'Yes');
  }
  for (const question of [
    'Are you authorized to work anywhere in Europe?',
    'Are you authorized to work permanently in the European country where you are currently living?',
    'Are you authorized to work in Germany, the country where you are currently living?',
    'Are you authorized to work in any European country where you are currently living?',
  ]) assert.equal(answer(question), null, question);
  assert.equal(answer('Are you authorized to work in the European country where you are currently living?', { ...profile, location: {} }), null);
  assert.equal(resolveAuthorizationAnswer(profile, 'work_authorization', { question: 'Are you authorized to work in Germany?', jobCountry: 'Finland' }), 'No');
});

test('coding languages come only from the CV language lines, excluding familiarity segments', () => {
  for (const question of ['What languages are you most comfortable coding in?', 'Which programming languages are you proficient in?']) {
    assert.equal(answer(question), 'Python, SQL, JavaScript, TypeScript, Bash');
  }
  assert.equal(answer('Which programming languages are you proficient in?', { ...profile, cvText: '# Example\nPython was mentioned elsewhere.' }), null);
  assert.equal(answer('Are you proficient in Rust?', profile, { tag: 'select', options: [{ label: 'Yes' }, { label: 'No' }] }), null);
  assert.equal(classifyFieldSemantics(field('Which spoken languages are you comfortable with?')).semantic, 'unknown');
});

test('adult confirmation requires an explicit positive profile fact', () => {
  const question = 'Are you over 18 years of age?';
  assert.equal(answer(question), null);
  assert.equal(answer(question, { ...profile, formRules: { ...profile.formRules, adult_confirmed: 'Yes' } }), 'Yes');
  assert.equal(answer(question, { ...profile, formRules: { adult_confirmed: 'unknown' } }), null);
});

test('committed regional city and phone-country labels use the same grounded matching on replans', () => {
  for (const [question, value, preserved] of [
    ['Location (City)', 'Example City, Example Region, Finland', true],
    ['Location (City)', 'Example City, Sweden', false],
    ['Location (City)', 'Example City', false],
    ['Phone Country', 'Finland +358', true],
    ['Phone Country', 'Finland+358', true],
    ['Phone Country', 'Finland (+358)', true],
    ['Phone Country', 'Finlandia +358', false],
  ]) {
    const f = field(question, { role: 'combobox', autocomplete: 'list', value });
    const plan = buildOperationalFormPlan({ fields: [f], controls: [] }, profile, {}, { context });
    assert.equal(plan.preservedFields.length === 1, preserved, value);
    assert.equal(plan.actions.length === 1, !preserved, value);
  }
});

test('interest and project answers are distinct and retain exact factual provenance', () => {
  const motivation = generateCustomNarrativeAnswer(profile, { question: interested, ...context });
  const project = generateCustomNarrativeAnswer(profile, { question: projectQuestion, ...context });
  assert.notEqual(motivation.answer, project.answer);
  assert.match(motivation.answer, /interested.*Example Company.*security/);
  assert.match(project.answer, /Example Security Project/);
  assert.match(project.answer, /ambiguous API responses/);
  assert.doesNotMatch(project.answer, /Reporting Project|inventory|worked in a start-up|strongest fit/);
  assert.doesNotMatch(motivation.answer, /strongest fit/);
  for (const record of [motivation, project]) {
    validateNarrativeProvenanceRecord(profile, record, { candidateId: context.candidate.candidate_id, normalizedQuestion: record.normalizedQuestion, answer: record.answer });
    const reused = generateCustomNarrativeAnswer({ ...profile, priorApprovedAnswers: [record] }, {
      question: record === project ? projectQuestion : interested, ...context,
    });
    assert.equal(reused.answer, record.answer);
    assert.equal(reused.wording, 'reused');
  }
  assert.throws(() => generateCustomNarrativeAnswer(attachFactualSources({ ...profile, priorApprovedAnswers: [project], cvText: `${cvText}\nchanged` }), { question: projectQuestion, ...context }), /stale|mismatched/);
  assert.throws(() => generateCustomNarrativeAnswer(profile, { question: projectQuestion, ...context, maxLength: 30 }), /complete project/);
  assert.throws(() => generateCustomNarrativeAnswer(profile, { question: interested, candidate: context.candidate }), /JD focus/);
});

test('a company-interest answer has a readable opening and at most three distinct complete sentences', () => {
  const repetitive = attachFactualSources({
    ...profile,
    cvText: [
      '# Alex Example', '## Experience', '### Developer Intern | Example Labs',
      '- I built Python backend APIs for an internal security tool, improving validation and error handling.',
      '- I added Python backend APIs to an internal security tool, including validation and error handling.',
      '- Thesis work.',
      '- I tested the security tool with synthetic inputs and documented the failure cases.',
      '- I wrote SQL reports for synthetic inventory records.',
      '- I reviewed backend code changes for the security tool with the team.',
    ].join('\n'),
    formRules: { ...profile.formRules, narrative_evidence: [{ id: 'example-intern', topics: ['software_backend', 'motivation_fit'], provenance: [{ sourceType: 'cv', locator: 'lines:4-9' }] }] },
  });
  const result = generateCustomNarrativeAnswer(repetitive, { question: interested, ...context });
  assert.match(result.answer, /^I am interested in the Backend Engineer role at Example Company because of its focus on [^.]+\./);
  assert.doesNotMatch(result.answer, / and [^,.]+ and /);
  const body = result.answer.split(': ').slice(1).join(': ');
  const sentences = body.split(/(?<=\.)\s+/);
  assert.ok(sentences.length >= 1 && sentences.length <= 3, body);
  assert.doesNotMatch(body, /Thesis work\./);
  assert.ok(!(/I built Python backend APIs/.test(body) && /I added Python backend APIs/.test(body)), body);
  validateNarrativeProvenanceRecord(repetitive, result, { candidateId: context.candidate.candidate_id, normalizedQuestion: result.normalizedQuestion, answer: result.answer });
});

test('a salary question asked in dollars never receives a EUR target', () => {
  const salaryProfile = { ...profile, compensation: { target_range: 'EUR 55,000-60,000/year' } };
  assert.equal(answer('What are your salary expectations? (in $)', salaryProfile), null);
  assert.equal(answer('What are your salary expectations?', salaryProfile), 'EUR 55,000-60,000/year');
});

test('different narrative questions cannot receive the same generated text in one plan', () => {
  const plan = buildOperationalFormPlan({ fields: [
    field('Why are you a good fit for this backend role?', { fieldId: 'first' }),
    field('Describe your backend experience.', { fieldId: 'second' }),
  ].map((f) => ({ ...f, tag: 'textarea', type: 'textarea' })), controls: [] }, profile, {}, { context });
  const texts = plan.actions.filter((a) => a.semantic === 'custom_narrative').map((a) => a.value);
  assert.equal(new Set(texts).size, texts.length);
  assert.match(plan.unresolvedFields.find((f) => f.fieldId === 'second')?.reason || '', /duplicates/);
});

test('valid legacy fit prose is regenerated for interest and project questions on resume', () => {
  const legacy = generateCustomNarrativeAnswer(profile, { question: 'Why are you a good fit for this backend role?', ...context });
  for (const [question, template] of [[interested, 'company-interest-v2'], [projectQuestion, 'project-example-v1']]) {
    const oldRecord = { ...legacy, normalizedQuestion: normalizeFormQuestion(question) };
    const refreshed = generateCustomNarrativeAnswer({ ...profile, priorApprovedAnswers: [oldRecord] }, { question, ...context });
    assert.equal(refreshed.templateId, template);
    assert.notEqual(refreshed.answer, legacy.answer);
    assert.throws(() => generateCustomNarrativeAnswer({ ...profile, priorApprovedAnswers: [{ ...oldRecord, answer: 'Unsupported replacement' }] }, { question, ...context }), /answer hash/);
  }
});

describe('operational DOM grounding regressions', () => {
  let browser;
  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser?.close(); });
  async function inspect(html) {
    const page = await browser.newPage();
    await page.setContent(html);
    const snapshot = await inspectOperationalApplicationForm(page);
    return { page, snapshot, plan: buildOperationalFormPlan(snapshot, profile, {}, { context }) };
  }
  const form = (body) => `<form><label>Email<input type="email" required></label>${body}<button type="submit" onclick="window.finalClicks=(window.finalClicks||0)+1">Submit application</button></form>`;
  test('Greenhouse education dates, coding languages, residence rights, start and adult questions', async () => {
    const { page, snapshot, plan } = await inspect(form(`
      <div class="education--container"><div class="education--form">
        <input id="start-month" aria-label="Start date month" role="combobox" required>
        <input id="start-year" aria-label="Start date year" type="number" required>
        <input id="end-month" aria-label="End date month" role="combobox" required>
        <input id="end-year" aria-label="End date year" type="number" required>
      </div></div>
      <textarea id="coding" aria-label="What languages are you most comfortable coding in?" required></textarea>
      <textarea id="start" aria-label="How quickly are you looking to start a new role?" required></textarea>
      <label for="rights">Are you authorized to work in the European country where you are currently living?</label>
      <select id="rights" required><option></option><option>Yes</option><option>No</option></select>
      <label for="adult">Are you over 18 years of age?</label><select id="adult" required><option></option><option>Yes</option><option>No</option></select>`));
    const action = (id, p = plan) => p.actions.find((a) => a.fieldId === snapshot.fields.find((f) => f.id === id).fieldId);
    for (const id of ['start-month', 'start-year', 'end-month', 'end-year']) {
      assert.equal(snapshot.fields.find((f) => f.id === id).educationContext, true);
      assert.equal(action(id), undefined);
    }
    assert.equal(action('coding').value, 'Python, SQL, JavaScript, TypeScript, Bash');
    assert.equal(action('coding').sourceRef, 'cv.md');
    assert.equal(action('start').value, 'Available immediately');
    assert.equal(action('rights').value, 'Yes');
    assert.equal(action('adult'), undefined);
    const adultPlan = buildOperationalFormPlan(snapshot, { ...profile, formRules: { ...profile.formRules, adult_confirmed: 'Yes' } }, {}, { context });
    assert.equal(action('adult', adultPlan).value, 'Yes');
    assert.ok(plan.finalActions.length);
    await page.close();
  });
  test('Ashby motivation and ambiguity questions select distinct grounded answers', async () => {
    const { page, plan } = await inspect(form(`<label>${interested}<textarea required></textarea></label><label>${projectQuestion}<textarea required></textarea></label>`));
    const narratives = plan.actions.filter((a) => a.semantic === 'custom_narrative');
    assert.equal(narratives.length, 2);
    assert.notEqual(narratives[0].value, narratives[1].value);
    assert.match(narratives[1].value, /Example Security Project/);
    assert.equal(await page.evaluate(() => window.finalClicks || 0), 0);
    await page.close();
  });

  async function autocompleteFixture({ label, options, phone = false }) {
    return inspect(form(`${phone ? '<fieldset><legend>Phone</legend>' : ''}
      <label for="choice">${label}</label><input id="choice" role="combobox" aria-autocomplete="list" aria-controls="owned-options" required>
      <div id="owned-options" role="listbox"></div>${phone ? '</fieldset>' : ''}
      <script>
        const input = document.getElementById('choice'), list = document.getElementById('owned-options');
        input.addEventListener('input', () => {
          list.replaceChildren();
          for (const label of ${JSON.stringify(options)}) {
            const option = document.createElement('button'); option.type='button'; option.role='option'; option.textContent=label;
            option.onclick=()=>{input.value=label;list.replaceChildren();window.optionClicks=(window.optionClicks||0)+1;}; list.append(option);
          }
        });
      </script>`));
  }
  test('Location (City) selects the unique city+country option despite foreign-city alternatives', async () => {
    const { page, plan } = await autocompleteFixture({ label: 'Location (City)', options: ['Example City, Sweden', 'Example City, Example Region, Finland'] });
    const execution = await executeOperationalFormPlan(page, plan);
    assert.equal(execution.unresolvedFields.length, 0);
    assert.equal(await page.locator('#choice').inputValue(), 'Example City, Example Region, Finland');
    assert.equal(await page.evaluate(() => window.optionClicks), 1);
    assert.equal(await page.evaluate(() => window.finalClicks || 0), 0);
    await page.close();
  });
  test('multiple grounded city options remain manual rather than choosing the first', async () => {
    const { page, plan } = await autocompleteFixture({ label: 'Location (City)', options: ['Example City, First Region, Finland', 'Example City, Second Region, Finland'] });
    const execution = await executeOperationalFormPlan(page, plan);
    assert.match(execution.unresolvedFields.find((f) => f.semantic === 'city')?.reason || '', /ambiguous/);
    assert.equal(await page.evaluate(() => window.optionClicks || 0), 0);
    await page.close();
  });
  for (const label of ['Finland +358', 'Finland+358', 'Finland (+358)']) {
    test(`phone country accepts the visible country/dial label ${label}`, async () => {
      const { page, plan } = await autocompleteFixture({ label: 'Country', options: ['Exampleland +999', label], phone: true });
      assert.equal(plan.actions.find((a) => a.semantic === 'phone_country').value, 'Finland');
      const execution = await executeOperationalFormPlan(page, plan);
      assert.equal(execution.unresolvedFields.length, 0);
      assert.equal(await page.locator('#choice').inputValue(), label);
      const nextPlan = buildOperationalFormPlan(await inspectOperationalApplicationForm(page), profile, {}, { context });
      assert.equal(nextPlan.actions.some((a) => a.semantic === 'phone_country'), false);
      assert.equal(await page.evaluate(() => window.finalClicks || 0), 0);
      await page.close();
    });
  }
});
