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
const decide = (label, context = {}, fieldOverrides = {}) => salaryAnswerDecision(profile, {
  field: textField(label, fieldOverrides), question: label, jobCountry: 'Finland', jdText: 'Build data pipelines in Python.', ...context,
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
  const decision = decide('What are your salary expectations?');
  assert.equal(decision.value, 'EUR 50,000-56,000/year');
  assert.equal(decision.reasonCode, 'reference_range');
  assert.equal(salaryManualNote(decision), null);
  assert.equal(decide('Expected annual salary (gross)').value, 'EUR 50,000-56,000/year');
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
  assert.equal(decide('Salary expectation', { advertisedSalary: { min: 0, max: 0 } }).value, 'EUR 50,000-56,000/year',
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
  const field = textField('What are your salary expectations?');
  const cases = [
    { jobCountry: 'Finland', jdText: 'Python role.' },
    { jobCountry: 'Finland', jdText: 'Salary EUR 60,000-70,000 per year.' },
    { jobCountry: 'Germany', jdText: 'Python role.' },
    { jobCountry: null, jdText: 'Python role.' },
    { jobCountry: 'Finland', jdText: 'Python role.', candidate: { title: 'Data Engineering Intern' } },
  ];
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
  const noJd = salaryAnswerDecision(profile, { field: textField('Salary expectation'), question: 'Salary expectation', jobCountry: 'Finland' });
  assert.equal(noJd.reasonCode, 'jd_unavailable');
  assert.equal(noJd.value, null);
  assert.equal(decide('Salary expectation', { advertisedSalary: 'EUR 60,000-70,000/year' }).value, null, 'string salary in job record');
  assert.equal(decide('Salary expectation', { advertisedSalary: 'not stated' }).value, 'EUR 50,000-56,000/year', 'text without amounts is not pay');
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
