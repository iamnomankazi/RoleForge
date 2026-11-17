// Shared salary-answer policy: auto-fill only for a verified Finnish job with no advertised pay and a free-text annual
// question; every other case is manual with a reason and, where the rules allow, a proposal. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAdvertisedSalary, parseSalaryText, referenceRange, salaryAnswerDecision, salaryManualNote } from '../salary-policy.mjs';
import { canonicalFieldValue, classifyFieldSemantics } from '../application-form-policy.mjs';
import { groundedFieldValue } from '../application-profile.mjs';
import { buildFormPlan } from '../application-form-core.mjs';
import { buildCandidateFormContext } from '../application-browser-executor.mjs';

const profile = {
  candidate: { full_name: 'Alex Example' },
  location: { city: 'Example City', country: 'Finland' },
  currentStatus: {},
  education: {},
  formRules: {},
  compensation: { target_range: 'EUR 50,000-56,000/year', currency: 'EUR', basis: 'Gross annual salary' },
};
const textField = (label, overrides = {}) => ({ fieldId: 'pay', id: 'pay', label, questionText: label, tag: 'input', type: 'text', required: true, ...overrides });
const JD = 'Build data pipelines in Python.';
// Verified evidence: a complete posting capture with no pay and no report compensation for this exact candidate.
const verified = {
  jobCountry: 'Finland', jdText: JD,
  postingEvidence: { complete: true, text: JD, basis: 'synthetic api capture' },
  reportCompensation: { status: 'none', values: [] },
};
const ANNUAL = 'Expected annual gross salary range (EUR)';
const decide = (label, context = {}, fieldOverrides = {}) => salaryAnswerDecision(profile, {
  field: textField(label, fieldOverrides), question: label, ...verified, ...context,
});

test('parser reads the profile format, ranges, periods and currencies without guessing', () => {
  assert.deepEqual(parseSalaryText('EUR 50,000-56,000/year'), { currency: 'EUR', period: 'year', net: false, min: 50000, max: 56000 });
  assert.deepEqual(parseSalaryText('3 800 – 4 200 € / kk'), { currency: 'EUR', period: 'month', net: false, min: 3800, max: 4200 });
  assert.equal(parseSalaryText('45-50k USD').min, 45000);
  assert.equal(parseSalaryText('USD 30 per hour').period, 'hour');
  assert.equal(parseSalaryText('2 500 € netto kuukaudessa').net, true);
  assert.equal(parseSalaryText('competitive salary'), null);
  assert.equal(parseSalaryText('Since 2019'), null, 'a year is not an amount');
  assert.equal(parseSalaryText('Salary 4,000').period, 'unknown');
  assert.equal(referenceRange(profile).ok, true);
  assert.equal(referenceRange({ compensation: { target_range: 'EUR 4,000/month' } }).ok, false, 'a monthly reference is not an annual range');
  assert.equal(referenceRange({ compensation: { target_range: 'competitive' } }).ok, false);
});

test('no advertised salary in a Finnish job: the reference range is filled verbatim', () => {
  const decision = decide(ANNUAL);
  assert.equal(decision.value, 'EUR 50,000-56,000/year');
  assert.equal(decision.reasonCode, 'reference_range');
  assert.equal(salaryManualNote(decision), null);
  assert.equal(decide('Vuosipalkkatoive (EUR, brutto)').value, 'EUR 50,000-56,000/year');
});

test('an advertised range above the reference proposes the employer range and stays manual', () => {
  const decision = decide('Salary expectation', { jdText: 'Data Engineer.\nSalary range: €60,000 – €70,000 per year depending on experience.' });
  assert.equal(decision.value, null);
  assert.equal(decision.reasonCode, 'advertised_higher');
  assert.equal(decision.proposal, 'EUR 60,000-70,000/year');
  assert.match(decision.reason, /budget, not an offer/);
});

test('an overlapping advertised range proposes the overlap', () => {
  const decision = decide('Salary expectation', { jdText: 'We pay 4 500 - 5 000 EUR per month.' });
  assert.equal(decision.reasonCode, 'advertised_overlap');
  assert.equal(decision.proposal, 'EUR 54,000-56,000/year', 'monthly advert converted with 12 for comparison');
  assert.match(decision.reason, /multiplied by 12/);
});

test('a lower advertised range is flagged for the owner with no proposal', () => {
  const decision = decide('Salary expectation', { jdText: 'Salary: EUR 38,000-42,000 per year.' });
  assert.equal(decision.reasonCode, 'advertised_lower');
  assert.equal(decision.value, null);
  assert.equal(decision.proposal, null);
});

test('unreadable or structured pay is treated as advertised and left manual', () => {
  const unclear = decide('Salary expectation', { jdText: 'Palkkaus TES:n mukaan.' });
  assert.equal(unclear.reasonCode, 'advertised_uncertain');
  assert.equal(unclear.value, null);
  const noPeriod = decide('Salary expectation', { jdText: 'Salary 4,000 EUR plus benefits.' });
  assert.equal(noPeriod.reasonCode, 'advertised_uncertain');
  const structured = decide('Salary expectation', { jdText: '', advertisedSalary: { min: 85, max: 85, currency: 'USD' } });
  assert.equal(structured.reasonCode, 'advertised_uncertain');
  assert.equal(decide(ANNUAL, { advertisedSalary: { min: 0, max: 0 } }).value, 'EUR 50,000-56,000/year',
    'an empty structured salary is not an advertised salary');
  assert.equal(detectAdvertisedSalary({ jdText: 'A competitive salary and great benefits.' }).status, 'none');
});

test('a single-figure question gets a proposal, never the top of the range', () => {
  const decision = decide('Expected salary (numbers only)');
  assert.equal(decision.value, null);
  assert.equal(decision.reasonCode, 'single_figure_requested');
  assert.equal(decision.proposal, 'EUR 53,000/year gross');
  assert.equal(decide('Expected salary', {}, { type: 'number' }).reasonCode, 'single_figure_requested');
});

test('a monthly question converts with 12 and shows the 12.5 alternative', () => {
  const decision = decide('Palkkatoive (€/kk)');
  assert.equal(decision.reasonCode, 'monthly_requested');
  assert.equal(decision.proposal, 'EUR 4,170-4,670/month gross (÷12), or EUR 4,000-4,480/month (÷12.5)');
  assert.match(salaryManualNote(decision), /Proposed for your approval/);
  assert.equal(decide('Hourly rate expectation').reasonCode, 'hourly_requested');
  assert.equal(decide('Expected net salary').reasonCode, 'net_requested');
  assert.equal(decide('Salary band', {}, { tag: 'select', options: [{ label: '40-50k' }] }).reasonCode, 'options_question');
});

test('trainee roles keep their own answer and never receive the reference range', () => {
  assert.equal(decide('Salary expectation', { trainee: true }).reasonCode, 'trainee_role');
  assert.equal(salaryAnswerDecision({ ...profile, compensation: { ...profile.compensation, trainee_answer: 'Per programme terms' } },
    { question: 'Salary expectation', jobCountry: 'Finland', trainee: true }).value, 'Per programme terms');
});

test('outside Finland or an unverified country stays manual; residence never stands in for job country', () => {
  const germany = decide('Salary expectation', { jobCountry: 'Germany' });
  assert.equal(germany.reasonCode, 'outside_finland');
  assert.match(germany.reason, /starting point/);
  const unknown = decide('Salary expectation', { jobCountry: null });
  assert.equal(unknown.reasonCode, 'job_country_unverified');
  assert.equal(decide('Salary expectation in USD').reasonCode, 'question_currency_mismatch');
});

test('both form paths give the same salary answer for the same job', () => {
  const field = textField(ANNUAL);
  const ok = { postingEvidence: { complete: true, text: 'Python role.', basis: 'synthetic' }, reportCompensation: { status: 'none', values: [] } };
  const cases = [
    { jobCountry: 'Finland', jdText: 'Python role.', ...ok },
    { jobCountry: 'Finland', jdText: 'Python role.' },
    { jobCountry: 'Finland', jdText: 'Python role.', ...ok, postingEvidence: { complete: false, reason: 'excerpt' } },
    { jobCountry: 'Finland', jdText: 'Python role.', ...ok, reportCompensation: { status: 'matched', values: [{ report: 7, value: 'EUR 60,000-70,000 per year' }] } },
    { jobCountry: 'Finland', jdText: 'Salary EUR 60,000-70,000 per year.', ...ok },
    { jobCountry: 'Germany', jdText: 'Python role.' },
    { jobCountry: null, jdText: 'Python role.' },
    { jobCountry: 'Finland', jdText: 'Python role.', candidate: { title: 'Data Engineering Intern' } },
  ];
  const filled = cases.map((context) => canonicalFieldValue(profile, classifyFieldSemantics(field), { field, context }));
  assert.deepEqual(filled.map(Boolean), [true, false, false, false, false, false, false, false], 'only the fully verified case fills');
  for (const context of cases) {
    const modern = canonicalFieldValue(profile, classifyFieldSemantics(field), { field, context });
    const legacy = groundedFieldValue(profile, 'salary', { ...context, question: field.label, field });
    const plan = buildFormPlan({ fields: [field], controls: [] }, profile, {}, { context });
    assert.equal(legacy, modern, JSON.stringify(context));
    assert.equal(plan.actions[0]?.value ?? null, modern, JSON.stringify(context));
    if (!modern) assert.match(plan.unresolvedFields[0].reason, /\S/, 'legacy plan explains the manual salary');
  }
});

test('an optional salary field that stays manual is still listed with its reason (legacy plan)', () => {
  const field = textField('Salary expectation', { required: false });
  const plan = buildFormPlan({ fields: [field], controls: [] }, profile, {}, { context: { jobCountry: 'Germany' } });
  assert.deepEqual(plan.actions, []);
  assert.match(plan.unresolvedFields[0].reason, /Germany/);
});

test('the browser form context carries structured job-record pay to the policy', () => {
  const context = buildCandidateFormContext({
    manifest: { batchId: 'b' },
    candidate: { listingUrl: 'https://jobs.example.test/1' },
    sourceCandidate: { sourceRow: { location: 'Example, Finland', jobCountry: 'Finland', description: 'Role text', salary: { min: 60000, max: 70000, currency: 'EUR' } } },
  });
  assert.deepEqual(context.advertisedSalary, { min: 60000, max: 70000, currency: 'EUR' });
  assert.equal(decide('Salary expectation', { advertisedSalary: context.advertisedSalary, jdText: context.jdText }).value, null);
});

test('review regressions: unverified bases, missing JD, string and net pay, small hourly amounts never auto-fill', () => {
  assert.equal(decide('Expected weekly salary range (EUR)').value, null, 'weekly');
  assert.equal(decide('Expected daily rate').reasonCode, 'period_not_annual');
  assert.equal(decide('Expected annual salary range (CAD)').reasonCode, 'question_currency_mismatch');
  const noJd = salaryAnswerDecision(profile, { field: textField(ANNUAL), question: ANNUAL, jobCountry: 'Finland', reportCompensation: { status: 'none', values: [] } });
  assert.equal(noJd.reasonCode, 'jd_unavailable');
  assert.equal(noJd.value, null);
  assert.equal(decide('Salary expectation', { advertisedSalary: 'EUR 60,000-70,000/year' }).value, null, 'string salary in job record');
  assert.equal(decide(ANNUAL, { advertisedSalary: 'not stated' }).value, 'EUR 50,000-56,000/year', 'text without amounts is not pay');
  for (const compensation of [{ ...profile.compensation, basis: 'Net annual salary' }, { target_range: 'EUR 50,000/year', currency: 'EUR' }]) {
    assert.equal(referenceRange({ compensation }).ok, false, JSON.stringify(compensation));
  }
  assert.equal(decide('Salary expectation', { jdText: 'The salary is 25 per hour.' }).reasonCode, 'advertised_uncertain');
  const counted = decide('Salary expectation', { jdText: 'With 3 years of experience, the salary is EUR 60,000-70,000 per year.' });
  assert.equal(counted.reasonCode, 'advertised_higher', 'the count of years is not the amount');
  assert.equal(counted.proposal, 'EUR 60,000-70,000/year');
  const net = decide('Expected salary (numbers only)', { advertisedSalary: { min: 60000, max: 70000, currency: 'EUR', period: 'year', net: true } });
  assert.equal(net.reasonCode, 'advertised_uncertain');
  assert.doesNotMatch(net.proposal || '', /65,000/);
});

test('review regression: the legacy country alias is not job-country evidence for salary', () => {
  const field = textField('Salary expectation');
  assert.equal(groundedFieldValue(profile, 'salary', { country: 'Finland', jdText: 'Python role.', question: field.label, field }), null);
  const plan = buildFormPlan({ fields: [field], controls: [] }, profile, {}, { context: { country: 'Finland', jdText: 'Python role.' } });
  assert.deepEqual(plan.actions, []);
});

test('second review: "pcm" questions and non-EUR advertised codes stay manual', () => {
  assert.equal(decide('Expected salary (EUR pcm)').reasonCode, 'monthly_requested');
  assert.equal(decide('Salary expectation', { jdText: 'CAD 90,000-110,000 per annum.' }).value, null);
});

test('question wording: only an explicit annual EUR range question in a free-text box is filled', () => {
  for (const label of [ANNUAL, 'Annual salary expectation in EUR', 'Palkkatoive vuodessa (€)', 'Gewünschtes Jahresgehalt (EUR)']) {
    assert.equal(decide(label).value, 'EUR 50,000-56,000/year', label);
  }
  for (const [label, code] of [
    ['Salary expectations (EUR)', 'period_unverified'],
    ['What are your salary expectations?', 'period_unverified'],
    ['Expected pay', 'period_unverified'],
    ['Expected annual salary', 'currency_unverified'],
    ['Expected annual salary range', 'currency_unverified'],
    ['Expected salary gross / month', 'monthly_requested'],
    ['Expected annual salary (USD)', 'question_currency_mismatch'],
    ['Expected annual net salary (EUR)', 'net_requested'],
    ['Expected annual salary in EUR (numbers only)', 'single_figure_requested'],
  ]) {
    const decision = decide(label);
    assert.equal(decision.value, null, label);
    assert.equal(decision.reasonCode, code, label);
  }
  assert.equal(decide('Salary expectations (EUR)').proposal, 'EUR 50,000-56,000/year', 'ambiguous wording still gets a proposal');
});

test('field constraints: a range needs a plain text input or textarea', () => {
  assert.equal(decide(ANNUAL, {}, { tag: 'textarea', type: 'textarea' }).value, 'EUR 50,000-56,000/year');
  for (const overrides of [{ type: 'number' }, { inputMode: 'numeric' }, { pattern: '[0-9]*' }, { pattern: String.raw`\d+` }, { type: '' }, { tag: '', type: '' }]) {
    assert.equal(decide(ANNUAL, {}, overrides).value, null, JSON.stringify(overrides));
  }
  assert.equal(decide(ANNUAL, {}, { maxLength: 6 }).reasonCode, 'answer_too_long');
});

test('posting completeness: a stored excerpt is not proof that the posting has no salary', () => {
  for (const postingEvidence of [null, { complete: false, text: '', reason: 'excerpt' }, { complete: true, text: '' }]) {
    const decision = decide(ANNUAL, { postingEvidence, jdText: 'Short teaser text for a data role in Helsinki.' });
    assert.equal(decision.value, null, JSON.stringify(postingEvidence));
    assert.equal(decision.reasonCode, 'posting_unverified');
  }
  const captured = decide(ANNUAL, { jdText: 'Short teaser.', postingEvidence: { complete: true, text: 'Full posting. Salary 4 200 - 4 600 EUR per month.', basis: 'api' } });
  assert.equal(captured.reasonCode, 'advertised_overlap', 'pay found only in the full capture still counts');
});

test('report compensation: exact-candidate evidence is required and used', () => {
  assert.equal(decide(ANNUAL, { reportCompensation: null }).reasonCode, 'report_evidence_unverified');
  assert.equal(decide(ANNUAL, { reportCompensation: { status: 'conflict', values: [], reason: 'report 9 unreadable' } }).reasonCode, 'report_evidence_unverified');
  const higher = decide(ANNUAL, { reportCompensation: { status: 'matched', values: [{ report: 9, value: 'EUR 60,000-70,000 per year' }] } });
  assert.equal(higher.reasonCode, 'advertised_higher');
  assert.equal(higher.proposal, 'EUR 60,000-70,000/year');
  const twoReports = decide(ANNUAL, { reportCompensation: { status: 'matched', values: [
    { report: 9, value: 'EUR 60,000-70,000 per year' }, { report: 12, value: 'EUR 52,000-58,000 per year' }] } });
  assert.equal(twoReports.reasonCode, 'advertised_uncertain', 'disagreeing reports are never merged');
  const same = decide(ANNUAL, { jdText: 'Salary EUR 60,000-70,000 per year.', reportCompensation: { status: 'matched', values: [{ report: 9, value: 'EUR 60,000-70,000 per year' }] } });
  assert.equal(same.reasonCode, 'advertised_higher', 'the same range in posting and report is one statement');
});

test('a range that only touches the reference at one end is higher or lower, never a one-point overlap', () => {
  assert.equal(decide(ANNUAL, { jdText: 'Salary EUR 56,000-62,000 per year.' }).reasonCode, 'advertised_higher');
  assert.equal(decide(ANNUAL, { jdText: 'Salary EUR 44,000-50,000 per year.' }).reasonCode, 'advertised_lower');
});

test('third review: digits-only, take-home and patterned fields never receive the gross range (both paths)', () => {
  const cases = [
    ['Expected annual salary (EUR, digits only)', {}, 'single_figure_requested'],
    ['Expected annual salary in EUR (numbers only)', {}, 'single_figure_requested'],
    ['Expected annual take-home salary (EUR)', {}, 'net_requested'],
    ['Expected annual salary after tax (EUR)', {}, 'net_requested'],
    [ANNUAL, { pattern: '[0123456789]+' }, 'field_not_range_compatible'],
    [ANNUAL, { pattern: '.{1,40}' }, 'field_not_range_compatible'],
  ];
  for (const [label, overrides, code] of cases) {
    const decision = decide(label, {}, overrides);
    assert.equal(decision.value, null, label);
    assert.equal(decision.reasonCode, code, label);
    const field = textField(label, overrides);
    const context = { ...verified };
    assert.equal(canonicalFieldValue(profile, classifyFieldSemantics(field), { field, context }) ?? null, null, `engine: ${label}`);
    assert.equal(groundedFieldValue(profile, 'salary', { ...context, question: field.label, field }) ?? null, null, `legacy: ${label}`);
    const plan = buildFormPlan({ fields: [field], controls: [] }, profile, {}, { context });
    assert.equal(plan.actions.length, 0, `legacy plan: ${label}`);
    assert.match(plan.unresolvedFields[0]?.reason || '', /./, `legacy plan lists it: ${label}`);
  }
  assert.equal(decide(ANNUAL).value, 'EUR 50,000-56,000/year', 'the plain annual question still fills');
});

test('third review: pay evidence that cannot be parsed is uncertain, never "no pay"', () => {
  const report = (value) => ({ reportCompensation: { status: 'matched', values: [{ report: 1, value }] } });
  for (const value of ['According to collective agreement', 'Salary Competitive', 'EUR 1/year depending on equity mix k']) {
    const decision = decide(ANNUAL, report(value));
    assert.equal(decision.value, null, value);
    assert.match(decision.reasonCode, /^advertised_/, value);
  }
  for (const value of ['not stated', 'Not disclosed', 'N/A']) {
    assert.equal(decide(ANNUAL, report(value)).value, 'EUR 50,000-56,000/year', `explicit no-pay marker: ${value}`);
  }
  const record = decide(ANNUAL, { advertisedSalary: 'Salary 2000 per month' });
  assert.equal(record.value, null);
  assert.equal(record.reasonCode, 'advertised_uncertain', 'a year-shaped job-record amount is still pay evidence');
  assert.equal(decide(ANNUAL, { advertisedSalary: 'TES' }).reasonCode, 'advertised_uncertain');
  assert.equal(detectAdvertisedSalary({ advertisedSalary: 'not stated' }).status, 'none');
});

test('fourth review: compound net-pay words stay manual', () => {
  for (const label of ['Nettogehalt pro Jahr in EUR', 'Nettopalkkatoive (EUR / vuosi)', 'Käteenjäävä palkka vuodessa (EUR)', 'Önskad nettolön per år (EUR)']) {
    const decision = decide(label);
    assert.equal(decision.value, null, label);
    assert.equal(decision.reasonCode, 'net_requested', label);
  }
  assert.equal(decide('Expected annual gross salary range for this network role (EUR)').value, 'EUR 50,000-56,000/year', '"network" is not net');
});

test('final pass: unfamiliar job-record salary schemas are uncertain; recognised no-pay values still fill (both paths)', () => {
  const field = textField(ANNUAL);
  const unknown = [
    { range: { min: 80000, max: 90000 } }, { min_salary: 80000, max_salary: 90000 }, { amount: 'EUR 80,000/year' },
    { min: 0, max: 0, note: 'EUR 80,000' }, ['EUR 80,000'], 80000, { min: '0', max: '0' },
  ];
  for (const advertisedSalary of unknown) {
    const decision = decide(ANNUAL, { advertisedSalary });
    assert.equal(decision.value, null, JSON.stringify(advertisedSalary));
    assert.equal(decision.reasonCode, 'advertised_uncertain', JSON.stringify(advertisedSalary));
    assert.ok(decision.proposal, 'a proposal is still offered');
    const context = { ...verified, advertisedSalary };
    assert.equal(canonicalFieldValue(profile, classifyFieldSemantics(field), { field, context }) ?? null, null, `engine ${JSON.stringify(advertisedSalary)}`);
    assert.equal(groundedFieldValue(profile, 'salary', { ...context, question: field.label, field }) ?? null, null, `legacy ${JSON.stringify(advertisedSalary)}`);
  }
  for (const advertisedSalary of [null, undefined, '', 'not stated', [], {}, { min: 0, max: 0 }, { min: 0, max: 0, currency: 'USD' }, { min: null, max: null }]) {
    assert.equal(decide(ANNUAL, { advertisedSalary }).value, 'EUR 50,000-56,000/year', `recognised no pay: ${JSON.stringify(advertisedSalary)}`);
    const context = { ...verified, advertisedSalary };
    assert.equal(canonicalFieldValue(profile, classifyFieldSemantics(field), { field, context }), 'EUR 50,000-56,000/year');
    assert.equal(groundedFieldValue(profile, 'salary', { ...context, question: field.label, field }), 'EUR 50,000-56,000/year');
  }
});

test('final pass review: pay text in descriptive keys is not a placeholder; salary and compensation are both read', async () => {
  for (const advertisedSalary of [
    { currency: 'EUR', basis: 'EUR 80,000-90,000 per year' }, { min: 0, max: 0, type: 'Salary 4000 per month' },
    { period: 'According to collective agreement' }, { min: 0, max: 0, currency: 'EUR', net: 'EUR 3,500 net/month' },
    { min: 0, max: 0, currency: 'EUR 80000' },
  ]) {
    assert.equal(detectAdvertisedSalary({ advertisedSalary }).status, 'uncertain', JSON.stringify(advertisedSalary));
  }
  for (const advertisedSalary of [{ min: 0, max: 0, currency: 'EUR', period: 'year', net: false, basis: 'gross' }]) {
    assert.equal(detectAdvertisedSalary({ advertisedSalary }).status, 'none', JSON.stringify(advertisedSalary));
  }
  const { jobRecordSalary } = await import('../salary-policy.mjs');
  const status = (row) => detectAdvertisedSalary({ advertisedSalary: jobRecordSalary(row) }).status;
  assert.equal(status({ salary: { min: 0, max: 0 }, compensation: 'EUR 80,000 per year' }), 'advertised', 'placeholder salary does not hide compensation');
  assert.equal(status({ salary: '', compensation: { range: { min: 1, max: 2 } } }), 'uncertain');
  assert.equal(status({ salary: { min: 80000, max: 90000, currency: 'EUR', period: 'year' }, compensation: 'TES' }), 'uncertain', 'both present: manual');
  assert.equal(status({ salary: null, compensation: null }), 'none');
  assert.equal(status({ salary: { min: 0, max: 0 }, compensation: 'not stated' }), 'none');
});
