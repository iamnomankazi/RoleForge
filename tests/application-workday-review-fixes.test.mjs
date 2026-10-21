import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  buildOperationalFormPlan, executeOperationalFormPlan, inspectOperationalApplicationForm,
  prepareOperationalApplicationForm, reviewOperationalApplicationForm,
} from '../application-form-engine.mjs';
import { verifyApplicationContinuity } from '../application-browser-executor.mjs';

const URL = 'https://example.wd1.myworkdayjobs.com/en-US/jobs/job/Example/Engineer_R100001/apply/questions';
const profile = {
  candidate: { full_name: 'Alex Example', email: 'alex@example.test', phone_type: 'Mobile' },
  location: { city: 'Example City', country: 'Finland' },
  currentStatus: {}, compensation: {}, education: {}, answers: new Map(),
  formRules: { current_location: { city: 'Example City', country: 'Finland', combined: 'Example City, Finland' } },
  cvText: '## Education\n\n### Example University\n\n**Master of Computer Science**\n\n### Example College\n\n**Bachelor of Information Technology**\n\n## Languages\n\n- English: Fluent\n- Hindi: Native\n- Spanish: Beginner\n',
};
const context = { batchId: 'review-fixes', candidate: { candidate_id: `cand_v1_${'a'.repeat(64)}` },
  discovery: { source: 'workday', urls: [] }, verifyApplicationContinuity };
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

const firstName = '<label for="first">First Name*</label><input id="first" required>';
const shell = (body) => `<div data-automation-id="applyFlowPage"><h2>Application Questions</h2>
  <label for="anchor">Last Name</label><input id="anchor" value="Example">${body}
  <button type="submit" id="submit">Submit</button></div>
  <script>window.submits = 0; document.getElementById('submit').onclick = () => window.submits++;</script>`;
async function served(body) {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.request().resourceType() === 'document'
    ? route.fulfill({ contentType: 'text/html', body: shell(body) }) : route.abort());
  await page.goto(URL);
  return page;
}
const dropdown = (id, label, options, selected = 'Select One') => `<button type="button" id="${id}"
  aria-label="${label} Select One Required" aria-required="true" aria-haspopup="listbox"
  data-options='${JSON.stringify(options).replaceAll("'", '&#39;')}'>${selected}</button>`;
const education = (options, selected) => `<div id="education-one" role="group" aria-labelledby="education-one-panel">
  <h3 id="education-one-panel">Education 1</h3><label for="school">School or University</label>
  <input id="school" name="schoolName" value="Example College">${dropdown('degree', 'Degree', options, selected)}</div>`;
const language = (name, options, selected, checked = false) => `<div id="language-${name}" role="group" aria-labelledby="${name}-panel">
  <h3 id="${name}-panel">Languages ${name}</h3><button type="button" name="language">${name}</button>
  ${dropdown(`${name}-level`, 'Overall', options, selected)}
  <label for="${name}-fluent">I am fluent in this language.</label><input id="${name}-fluent" type="checkbox" ${checked ? 'checked' : ''}></div>`;
const dropdownScript = `<script>document.addEventListener('click', (event) => {
  const button = event.target.closest('button[aria-haspopup="listbox"]');
  if (button) {
    document.querySelectorAll('[role="listbox"]').forEach((menu) => menu.remove());
    const menu = document.createElement('div'); menu.setAttribute('role', 'listbox');
    menu.id = 'options-' + button.id; menu.dataset.control = button.id; button.setAttribute('aria-controls', menu.id);
    JSON.parse(button.dataset.options).forEach((text) => {
      const option = document.createElement('div'); option.setAttribute('role', 'option'); option.textContent = text; menu.append(option);
    }); button.after(menu); return;
  }
  const option = event.target.closest('[role="option"]');
  if (option) { const menu = option.parentElement; document.getElementById(menu.dataset.control).textContent = option.textContent; menu.remove(); }
});</script>`;
async function planFor(page, customProfile = profile) {
  return buildOperationalFormPlan(await inspectOperationalApplicationForm(page), customProfile, {}, { context });
}

test('manual continuation verifies requisition, origin, and the same application form before filling again', async () => {
  for (const change of ['requisition', 'fallback-requisition', 'origin', 'form']) {
    const page = await served(`${firstName}<label for="manual">Favorite office*</label><input id="manual" required>`);
    try {
      let pauses = 0;
      const result = await prepareOperationalApplicationForm(page, profile, {}, {
        context: change === 'fallback-requisition' ? { ...context, verifyApplicationContinuity: undefined }
          : change === 'origin' ? { ...context, verifyApplicationContinuity: async () => ({ verified: true }) } : context,
        awaitManualFields: async () => {
          pauses++;
          if (pauses > 1) return false;
          if (change === 'origin') await page.goto(URL.replace('example.wd1', 'other.wd1'));
          else await page.evaluate((kind) => {
            if (kind.includes('requisition')) history.pushState({}, '', location.href.replace('R100001', 'R200002'));
            if (kind === 'form') {
              const old = document.querySelector('[data-automation-id="applyFlowPage"]');
              const copy = old.cloneNode(true); copy.removeAttribute('data-career-ops-form-id');
              copy.removeAttribute('data-career-ops-virtual-form'); old.replaceWith(copy);
            }
          }, change);
          await page.locator('#first').fill('');
          await page.locator('#manual').fill('User answer');
          return true;
        },
      });
      assert.equal(await page.locator('#first').inputValue(), '', `${change}: no further fill`);
      assert.equal(result.gate?.state, 'review_required');
      assert.match(result.gate.reason, /identity|continuity|verified form/i);
      assert.equal(pauses, 1);
      assert.equal(await page.evaluate(() => window.submits), 0);
    } finally { await page.close(); }
  }
});

test('stable DOM id reacquisition requires the original form, repeated block, label, and field semantics', async () => {
  for (const change of ['fresh', 'other-form', 'other-block', 'semantics', 'label', 'planned-stamp', 'duplicate-id']) {
    // Planned outside a repeated entry (entries only get per-entry answers), then the blocks become entries.
    const page = await served(`${firstName}<div id="block-a" role="group" aria-labelledby="work-a-heading">
      <h3 id="work-a-heading">Work Experience 1</h3><label for="city">City</label><input id="city">
      <label for="other-city">City</label><input id="other-city"></div>
      <div id="block-b" role="group" aria-labelledby="work-b-heading"><h3 id="work-b-heading">Work Experience 2</h3></div>`);
    try {
      const plan = await planFor(page);
      plan.actions = plan.actions.filter((action) => action.id === 'city');
      assert.equal(plan.actions.length, 1);
      await page.evaluate(() => {
        for (const id of ['a', 'b']) {
          document.getElementById(`work-${id}-heading`).id = `work-${id}-panel`;
          document.getElementById(`block-${id}`).setAttribute('aria-labelledby', `work-${id}-panel`);
        }
      });
      Object.assign(plan.actions[0], { workdayBlockId: 'block-a', workdayBlockLabelledBy: 'work-a-panel' });
      await page.evaluate((kind) => {
        const original = document.getElementById('city');
        const copy = original.cloneNode(true); copy.removeAttribute('data-career-ops-field-id'); original.replaceWith(copy);
        if (kind === 'other-form') {
          const form = document.createElement('form'); form.setAttribute('data-career-ops-form-id', 'other-form');
          document.body.append(form); form.append(copy);
        }
        if (kind === 'other-block') document.getElementById('block-b').append(copy);
        if (kind === 'semantics' || kind === 'label') document.querySelector('label[for="city"]').textContent = kind === 'semantics' ? 'Country' : 'Current City';
        if (kind === 'planned-stamp') {
          copy.remove(); document.getElementById('other-city').id = 'city';
        }
        if (kind === 'duplicate-id') document.getElementById('block-a').append(copy.cloneNode(true));
      }, change);
      const execution = await executeOperationalFormPlan(page, plan);
      if (change === 'fresh') {
        assert.deepEqual(execution.unresolvedFields, []);
        assert.equal(await page.locator('#city').inputValue(), 'Example City');
      } else {
        assert.equal(execution.unresolvedFields.length, 1, change);
        assert.match(execution.unresolvedFields[0].reason, /could not be reacquired|ambiguous/);
        assert.ok((await page.locator('[id="city"]').evaluateAll((items) => items.map((item) => item.value))).every((value) => value === ''), change);
      }
    } finally { await page.close(); }
  }
});

test('degree subjects and whole-word positive proficiency options must each have exactly one acceptable choice', async () => {
  const cases = [
    [education(['Bachelor of Engineering']), 'degree', null],
    [education(['Bachelor of Engineering', 'Bachelor of Information Technology']), 'degree', 'Bachelor of Information Technology'],
    ...["Bachelor's Degree", 'Bachelors', 'Bachelor'].map((value) => [education([value]), 'degree', value]),
    [education(['Bachelor', "Bachelor's Degree"]), 'degree', null],
    ...["Master's Degree", 'Masters', 'Master'].map((value) => [education([value]).replace('Example College', 'Example University'), 'degree', value]),
    [education(['Master of Engineering']).replace('Example College', 'Example University'), 'degree', null],
    [language('English', ['Not Proficient']), 'English-level', null],
    [language('English', ['Proficiently']), 'English-level', null],
    [language('English', ['Not Proficient', 'No Fluent', 'Limited Advanced', 'Fluent']), 'English-level', 'Fluent'],
    [language('English', ['Advanced', 'Fluent']), 'English-level', null],
    [language('Hindi', ['Not Native', 'Non-native', 'Native']), 'Hindi-level', 'Native'],
    [language('Spanish', ['Elementary', 'Fluent']), 'Spanish-level', 'Elementary'],
  ];
  for (const [body, id, expected] of cases) {
    const page = await served(`${firstName}${body}${dropdownScript}`);
    try {
      const plan = await planFor(page);
      plan.actions = plan.actions.filter((action) => action.id === id);
      assert.equal(plan.actions.length, 1);
      const execution = await executeOperationalFormPlan(page, plan);
      assert.equal(await page.locator(`[id="${id}"]`).innerText(), expected || 'Select One', body);
      assert.equal(execution.unresolvedFields.length, expected ? 0 : 1);
      assert.equal(await page.evaluate(() => window.submits), 0);
    } finally { await page.close(); }
  }
});

test('differing existing degree, language, checkbox, and pick selections stay intact with both conflict values', async () => {
  const page = await served(`${firstName}${education(['Bachelor'], 'Master')}
    ${dropdown('phone-type', 'Phone Device Type', ['Mobile', 'Home'], 'Home')}
    ${language('English', ['Fluent', 'Beginner'], 'Beginner')}${language('Spanish', ['Basic'], 'Basic', true)}
    <div role="group" aria-labelledby="experience-panel"><h3 id="experience-panel">Work Experience 1</h3>
    <label for="description">Role Description</label><textarea id="description">Existing synthetic description</textarea></div>
    <label for="source">How Did You Hear About Us?*</label><div data-automation-id="multiSelectContainer">
    <div data-automation-id="selectedItem">Indeed</div><input id="source" data-uxi-widget-type="selectinput" value="Company website"></div>${dropdownScript}`);
  try {
    const plan = await planFor(page);
    assert.ok(!plan.actions.some((action) => action.id === 'description'));
    for (const [id, existingValue, groundedValue] of [
      ['degree', 'Master', 'Bachelor of Information Technology'], ['English-level', 'Beginner', 'Fluent'],
      ['Spanish-fluent', 'Fluent', 'Beginner'], ['source', 'Indeed', 'Company website'],
      ['phone-type', 'Home', 'Mobile'],
    ]) {
      const field = (await inspectOperationalApplicationForm(page)).fields.find((item) => item.id === id);
      assert.ok(!plan.actions.some((action) => action.id === id), id);
      const conflict = plan.unresolvedFields.find((row) => row.fieldId === field.fieldId);
      assert.equal(conflict?.existingValue, existingValue, id);
      assert.equal(conflict?.groundedValue, groundedValue, id);
    }
    await executeOperationalFormPlan(page, plan);
    assert.equal(await page.locator('#degree').innerText(), 'Master');
    assert.equal(await page.locator('#phone-type').innerText(), 'Home');
    assert.equal(await page.locator('#English-level').innerText(), 'Beginner');
    assert.equal(await page.locator('#Spanish-fluent').isChecked(), true);
    assert.equal(await page.locator('#description').inputValue(), 'Existing synthetic description');
    assert.equal(await page.locator('[data-automation-id="selectedItem"]').innerText(), 'Indeed');
  } finally { await page.close(); }
  const lateCorrection = await served(`${firstName}${language('English', ['Fluent', 'Beginner'])}${dropdownScript}`);
  try {
    const plan = await planFor(lateCorrection);
    plan.actions = plan.actions.filter((action) => action.id === 'English-level');
    await lateCorrection.locator('#English-level').evaluate((element) => { element.textContent = 'Beginner'; });
    const execution = await executeOperationalFormPlan(lateCorrection, plan);
    assert.equal(await lateCorrection.locator('#English-level').innerText(), 'Beginner');
    assert.match(execution.unresolvedFields[0]?.reason, /Beginner.*Fluent/);
  } finally { await lateCorrection.close(); }
});

test('manual continuation removes corrected execution failures while retaining unresolved failures and the attempt ledger', async () => {
  const page = await served(`${firstName}<label for="email">Email Address*</label><input id="email" type="email" required>`);
  try {
    const pauses = [];
    const result = await prepareOperationalApplicationForm(page, profile, {}, {
      context,
      performActionImpl: async () => { throw new Error('Synthetic execution failure'); },
      awaitManualFields: async (labels) => {
        pauses.push(labels);
        if (pauses.length > 1) return false;
        await page.locator('#first').fill('Alex');
        return true;
      },
    });
    assert.equal(pauses.length, 2);
    assert.ok(!pauses[1].some((label) => /First Name/.test(label)), JSON.stringify(pauses));
    assert.ok(!result.evidence.unresolvedFields.some((row) => row.semantic === 'first_name'));
    assert.ok(result.evidence.unresolvedFields.some((row) => row.semantic === 'email'));
    assert.equal(result.evidence.attemptLedger.filter((row) => row.semantic === 'first_name' && !row.success).length, 2);
  } finally { await page.close(); }
});

test('pick-from-list search text is never an answer or a substitute for a required selected chip', async () => {
  for (const chip of ['', '<div data-automation-id="selectedItem">User selection</div>']) {
    const page = await served(`${firstName}<label for="pick">Favorite color*</label>
      <div data-automation-id="multiSelectContainer">${chip}<input id="pick" data-uxi-widget-type="selectinput"
      placeholder="Search" value="Uncommitted search" required></div>`);
    try {
      const reviewed = await reviewOperationalApplicationForm(page, profile, {}, { unresolvedFields: [] });
      const field = reviewed.snapshot.fields.find((item) => item.id === 'pick');
      assert.equal(field.value, chip ? 'User selection' : '');
      assert.equal(reviewed.evidence.unresolvedFields.some((row) => row.fieldId === field.fieldId
        && row.reason === 'Required field remains empty.'), !chip);
      assert.equal(reviewed.plan.unresolvedFields.some((row) => row.fieldId === field.fieldId), !chip);
    } finally { await page.close(); }
  }
});

test('required Workday date groups leave every segment manual without an explicitly grounded day', async () => {
  const body = `${firstName}<div role="group" aria-labelledby="graduation" aria-required="true">
    <label id="graduation">What is your expected graduation date?</label>
    <div data-automation-id="dateInputWrapper" aria-labelledby="graduation">
    ${['Month', 'Day', 'Year'].map((segment) => `<input id="dateSection${segment}-input" role="spinbutton" aria-label="${segment}">`).join('')}
    </div></div>`;
  for (const date of ['12/2026', 'December 2026', null, '2026-12', '2026-12-17']) {
    const page = await served(body);
    try {
      const plan = await planFor(page, { ...profile, education: { expected_graduation_date: date },
        cvText: `${profile.cvText}\nGraduation expected December 2026` });
      const action = plan.actions.find((item) => item.semantic === 'graduation');
      if (date === '2026-12-17') {
        assert.deepEqual(action?.dateSegments.map((item) => item.value), ['12', '17', '2026']);
      } else {
        assert.equal(action, undefined, String(date));
        assert.ok(plan.unresolvedFields.some((item) => item.semantic === 'graduation'), String(date));
        await executeOperationalFormPlan(page, plan);
        assert.deepEqual(await page.locator('[role="spinbutton"]').evaluateAll((items) => items.map((item) => item.value)), ['', '', '']);
      }
    } finally { await page.close(); }
  }
});
