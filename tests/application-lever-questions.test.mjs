// Regression tests for Lever custom question cards: the question text lives in a sibling
// <div class="application-label"><div class="text"> rather than a <label>, and a multiple-select question is a set
// of same-name checkboxes whose labels are only the options.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { buildOperationalFormPlan, inspectOperationalApplicationForm } from '../application-form-engine.mjs';

const profile = {
  candidate: { full_name: 'Alex Example', email: 'alex.example@example.test', phone: '+358 40 0000000', citizenship: 'Exampleland' },
  location: { country: 'Finland', city: 'Example City' },
  currentStatus: { summary: "Master's student in Computer Science at the Example University", availability: { start: 'Available immediately' } },
  compensation: {},
  education: { expected_graduation_date: '31/05/2027', university: 'Example University' },
  formRules: {
    current_location: { city: 'Example City', country: 'Finland', combined: 'Example City, Finland' },
    work_authorization: {
      home_country: 'Finland', finland_authorized: 'Yes', finland_sponsorship: 'No',
      outside_finland_local_authorized: 'No', outside_finland_sponsorship: 'Yes', ambiguous_policy: 'manual',
    },
  },
  answers: new Map(),
  priorApprovedAnswers: [],
  cvText: '# Alex Example',
  articleDigestText: '',
  answerBankText: '',
  profileModeText: '',
};
const context = { company: 'Example Bank', role: 'Backend Engineer - Internship', jobCountry: 'Germany' };

const card = (name, question, control) => `<li class="application-question custom-question"><div>
  <div class="application-label full-width textarea"><div class="text">${question}<span class="required">✱</span></div></div>
  <div class="application-field full-width required-field">${control || `<textarea class="card-field-input" name="${name}" required></textarea>`}</div>
</div></li>`;
const visaOptions = [
  'Yes - I need a visa and I would like to relocate',
  'Yes - I need a visa but I have already relocated to one of your locations',
  'No - I already have a visa or a European nationality so I can relocate',
  'No - I do not want to relocate',
  'No - I already have a visa or a European nationality &amp; I already live in one of your locations',
];
const FORM = `<!doctype html><html><body><form id="application-form">
<h4>Internship questions</h4><ul>
${card('cards[a][field0]', 'What school will provide you with your internship agreement? (mandatory)')}
${card('cards[a][field1]', 'What level of study will you be in when you start the internship?')}
${card('cards[a][field2]', 'How long will you be available for an internship?')}
</ul>
<h4>Visa sponsorship</h4><ul>
${card('cards[b][field0]', 'Do you need a visa sponsorship to work in one of our locations?', `<ul data-qa="checkboxes">${visaOptions
    .map((option) => `<li><label><input type="checkbox" name="cards[b][field0]" value="${option}"><span class="application-answer-alternative">${option}</span></label></li>`)
    .join('')}</ul>`)}
</ul>
<button type="button">Submit application</button>
</form></body></html>`;

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function snapshotOf(html) {
  const page = await browser.newPage();
  await page.setContent(html);
  const snapshot = await inspectOperationalApplicationForm(page);
  await page.close();
  return snapshot;
}

test('Lever question cards are read from the sibling label block', async () => {
  const snapshot = await snapshotOf(FORM);
  const byName = (name) => snapshot.fields.find((field) => field.name === name);
  assert.equal(byName('cards[a][field0]').questionText, 'What school will provide you with your internship agreement? (mandatory)');
  assert.equal(byName('cards[a][field1]').questionText, 'What level of study will you be in when you start the internship?');
  const visa = snapshot.fields.filter((field) => field.name === 'cards[b][field0]');
  assert.equal(visa.length, 5);
  for (const field of visa) assert.equal(field.groupLabel, 'Do you need a visa sponsorship to work in one of our locations?');
});

test('a multiple-select visa question gets exactly the one consistent option, never a nationality value', async () => {
  const snapshot = await snapshotOf(FORM);
  const plan = buildOperationalFormPlan(snapshot, profile, {}, { context });
  const visaIds = new Set(snapshot.fields.filter((field) => field.name === 'cards[b][field0]').map((field) => field.fieldId));
  const checked = plan.actions.filter((action) => visaIds.has(action.fieldId));
  assert.equal(checked.length, 1);
  const option = snapshot.fields.find((field) => field.fieldId === checked[0].fieldId).optionLabel;
  assert.equal(option, 'Yes - I need a visa and I would like to relocate');
  assert.ok(!plan.actions.some((action) => /Exampleland/.test(String(action.value))));
});

test('study level and school are answered; an ungrounded availability duration stays manual', async () => {
  const snapshot = await snapshotOf(FORM);
  const plan = buildOperationalFormPlan(snapshot, profile, {}, { context });
  const valueFor = (name) => {
    const field = snapshot.fields.find((item) => item.name === name);
    return plan.actions.find((action) => action.fieldId === field.fieldId)?.value;
  };
  assert.equal(valueFor('cards[a][field0]'), 'Example University');
  assert.equal(valueFor('cards[a][field1]'), "Master's student in Computer Science at the Example University (graduation expected May 2027)");
  assert.equal(valueFor('cards[a][field2]'), undefined);
});
