import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright';
import { buildOperationalFormPlan, executeOperationalFormPlan, inspectOperationalApplicationForm } from '../application-form-engine.mjs';
import { attachFactualSources } from './fixtures/application-evidence-profile.mjs';

const months = Array.from({ length: 12 }, (_, index) => new Date(Date.UTC(2000, index, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' }));
function profile({ range = '2024 - Present', expected = '15/06/2031', extra = '' } = {}) {
  return attachFactualSources({
    candidate: { full_name: 'Alex Example', email: 'alex@example.test' },
    location: {}, currentStatus: { availability: { start: 'Available immediately' } },
    education: { university: 'Example University', expected_graduation_date: expected },
    formRules: {},
    cvText: `# Alex Example\n## Education\n### Example University\n**Master of Computer Science** | ${range}\n${extra}\n### Other Example University\n**Bachelor of Engineering in Information Technology** | Sep 2017 - Jun 2021\n`,
  });
}
function fields(school = 'Example University') {
  return [
    ['degree', 'Degree', 'select', ["Bachelor's Degree", "Master's Degree", 'Doctoral Degree']],
    ['subject', 'Discipline', 'select', ['Mathematics', 'Computer Science', 'Information Technology']],
    ['start-month', 'Start date month', 'select', months],
    ['start-year', 'Start date year', 'number'],
    ['end-month', 'End date month', 'select', months],
    ['end-year', 'End date year', 'number'],
  ].map(([id, label, type, options]) => ({
    fieldId: id, id, label, questionText: label, required: true, visible: true, value: '',
    tag: type === 'select' ? 'select' : 'input', type: type === 'select' ? 'select-one' : type,
    educationContext: true, educationSchool: school,
    options: options?.map((label, index) => ({ label, value: String(index + 1) })) || [],
  }));
}
const planFor = (p = profile(), controls = fields()) => buildOperationalFormPlan({ fields: controls, controls: [] }, p);
const values = (plan) => Object.fromEntries(plan.actions.map((a) => [a.fieldId, a.value]));

test('Greenhouse education uses the unique school entry and expected end date without inventing a start month', () => {
  const plan = planFor();
  assert.deepEqual(values(plan), {
    degree: "Master's Degree", subject: 'Computer Science', 'start-year': '2024', 'end-month': 'June', 'end-year': '2031',
  });
  assert.ok(plan.unresolvedFields.some((f) => f.fieldId === 'start-month'));
  for (const action of plan.actions.filter((a) => a.type === 'number' || /year$/.test(a.fieldId))) assert.match(action.value, /^\d+$/);
  assert.equal(plan.actions.find((a) => a.fieldId === 'degree').sourceRef, 'cv.md');
  assert.equal(plan.actions.find((a) => a.fieldId === 'end-year').sourceRef, 'cv.md + config/profile.yml');
  assert.equal(values(planFor(profile({ expected: '01/02/2031' })))['end-month'], 'February');
});

test('education months are used only when explicitly present and completed degrees ignore expected graduation', () => {
  assert.equal(values(planFor(profile({ range: 'Sep 2024 - Present' })))['start-month'], 'September');
  const past = values(planFor(profile(), fields('Other Example University')));
  assert.deepEqual(past, {
    degree: "Bachelor's Degree", subject: 'Information Technology', 'start-month': 'September', 'start-year': '2017', 'end-month': 'June', 'end-year': '2021',
  });
  const yearOnly = values(planFor(profile({ range: '2020 - 2024' })));
  assert.equal(yearOnly['start-year'], '2020');
  assert.equal(yearOnly['end-year'], '2024');
  assert.equal(yearOnly['end-month'], undefined);
});

test('education leaves absent or invalid facts, unmatched schools and duplicate entries manual', () => {
  for (const expected of ['', '31/02/2031', '2031-06-15', '15/13/2031']) {
    const result = values(planFor(profile({ expected })));
    assert.equal(result['end-month'], undefined);
    assert.equal(result['end-year'], undefined);
    assert.equal(result['start-year'], '2024');
  }
  for (const school of ['', 'Example University of Other Studies']) assert.deepEqual(planFor(profile(), fields(school)).actions, []);
  const duplicate = profile({ extra: '### Example University\n**Bachelor of Computer Science** | 2018 - 2022' });
  assert.deepEqual(planFor(duplicate).actions, []);
  const missingDates = values(planFor(profile({ range: 'Dates not specified' })));
  assert.equal(missingDates['start-year'], undefined);
  assert.equal(missingDates['end-year'], undefined);
});

test('education degree and discipline selectors require a unique grounded option', () => {
  const controls = fields();
  controls[0].options = [{ label: 'Master of Computer Science', value: 'master-cs' }, { label: 'Master of Mathematics', value: 'master-math' }];
  assert.equal(values(planFor(profile(), controls)).degree, 'Master of Computer Science');
  controls[0].options = [{ label: 'Master of Mathematics', value: 'master-math' }];
  assert.equal(values(planFor(profile(), controls)).degree, undefined);
  controls[1].options = [{ label: 'Computer Science and Mathematics', value: 'combined' }];
  assert.equal(values(planFor(profile(), controls)).subject, undefined);
  controls[1].options = [{ label: 'Computer Science', value: 'first' }, { label: 'Computer Science', value: 'second' }];
  assert.equal(values(planFor(profile(), controls)).subject, undefined);
});

test('education combobox plans match degree levels and preserve grounded selected labels', () => {
  const controls = fields().map((f) => f.tag === 'select' ? { ...f, tag: 'input', type: 'text', role: 'combobox', autocomplete: 'list', options: [] } : f);
  const plan = planFor(profile(), controls);
  assert.equal(values(plan).degree, 'Master');
  assert.equal(plan.actions.find((a) => a.fieldId === 'degree').optionMatch.mode, 'degree');
  for (const f of controls) f.value = ({ degree: "Master's Degree", subject: 'Computer Science', 'start-year': '2024', 'end-month': 'Jun', 'end-year': '2031' })[f.fieldId] || '';
  const replanned = planFor(profile(), controls);
  assert.equal(replanned.actions.length, 0);
  assert.equal(replanned.preservedFields.length, 5);
});

describe('Greenhouse education DOM regressions', () => {
  let browser;
  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser?.close(); });
  const school = `<div class="select__container"><label for="school">School</label><div class="select__single-value">Example University</div><input id="school" role="combobox" style="opacity:0" value=""></div>`;
  const shell = (controls) => `<form><label>Email<input type="email" required></label><div class="education--container"><div class="education--form">${school}${controls}</div></div><button type="submit" onclick="window.finalClicks=(window.finalClicks||0)+1">Submit application</button></form>`;
  test('inspected native selects and number inputs fill the matching CV education entry', async () => {
    const page = await browser.newPage();
    await page.setContent(shell(fields().map((f) => `<label for="${f.id}">${f.label}</label>${f.tag === 'select'
      ? `<select id="${f.id}" required><option value=""></option>${f.options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}</select>`
      : `<input id="${f.id}" type="number" aria-label="${f.label}" required>`}`).join('')));
    const snapshot = await inspectOperationalApplicationForm(page);
    for (const f of snapshot.fields.filter((f) => f.educationContext)) assert.equal(f.educationSchool, 'Example University');
    assert.equal(snapshot.fields.find((f) => f.id === 'school').value, 'Example University');
    const plan = buildOperationalFormPlan(snapshot, profile());
    const byId = Object.fromEntries(plan.actions.map((a) => [snapshot.fields.find((f) => f.fieldId === a.fieldId).id, a.value]));
    assert.equal(byId.degree, "Master's Degree");
    assert.equal(byId.subject, 'Computer Science');
    assert.equal(byId['start-month'], undefined);
    assert.equal(byId['start-year'], '2024');
    assert.equal(byId['end-month'], 'June');
    assert.equal(byId['end-year'], '2031');
    const execution = await executeOperationalFormPlan(page, plan);
    assert.equal(execution.unresolvedFields.length, 0);
    assert.equal(await page.locator('#start-year').inputValue(), '2024');
    assert.equal(await page.locator('#end-year').inputValue(), '2031');
    assert.equal(await page.locator('#end-month').inputValue(), '6');
    assert.equal(await page.locator('#start-month').inputValue(), '');
    assert.equal(await page.evaluate(() => window.finalClicks || 0), 0);
    await page.close();
  });
  test('Greenhouse education autocompletes commit and preserve selected display labels', async () => {
    const page = await browser.newPage();
    const controls = [['degree', 'Degree'], ['subject', 'Discipline'], ['end-month', 'End date month']].map(([id, label]) => `<div class="select__container"><label for="${id}">${label}</label><input id="${id}" role="combobox" aria-controls="${id}-options" aria-autocomplete="list" required><div id="${id}-options" role="listbox"></div></div>`).join('');
    await page.setContent(shell(`${controls}<script>
      for (const [id, labels] of Object.entries({degree:["Bachelor's Degree","Master's Degree"],subject:['Mathematics','Computer Science'],'end-month':['May','June']})) {
        const input=document.getElementById(id),list=document.getElementById(id+'-options');
        input.oninput=()=>{list.replaceChildren();for(const label of labels){const option=document.createElement('button');option.type='button';option.role='option';option.textContent=label;
          option.onclick=()=>{const selected=document.createElement('div');selected.className='select__single-value';selected.textContent=label;input.parentElement.append(selected);input.value='';input.style.opacity='0';input.required=false;list.replaceChildren();};list.append(option);}};
      }
    </script>`));
    const plan = buildOperationalFormPlan(await inspectOperationalApplicationForm(page), profile());
    const execution = await executeOperationalFormPlan(page, plan);
    assert.equal(execution.unresolvedFields.length, 0);
    const refreshed = await inspectOperationalApplicationForm(page);
    const next = buildOperationalFormPlan(refreshed, profile());
    assert.equal(next.actions.length, 0);
    assert.ok(next.preservedFields.filter((f) => f.category === 'education').length >= 3);
    assert.equal(await page.evaluate(() => window.finalClicks || 0), 0);
    await page.close();
  });
  test('school binding stays within each repeated Greenhouse education block', async () => {
    const page = await browser.newPage();
    const block = (id, schoolName) => `<div class="education--form"><label for="${id}-school">School</label><input id="${id}-school" value="${schoolName}"><label for="${id}-degree">Degree</label><select id="${id}-degree" required><option></option><option>Master's Degree</option><option>Bachelor's Degree</option></select></div>`;
    await page.setContent(`<form>${block('first', 'Example University')}${block('second', 'Other Example University')}<button type="submit">Submit application</button></form>`);
    const snapshot = await inspectOperationalApplicationForm(page);
    const plan = buildOperationalFormPlan(snapshot, profile());
    const valueFor = (id) => plan.actions.find((a) => a.fieldId === snapshot.fields.find((f) => f.id === id).fieldId)?.value;
    assert.equal(valueFor('first-degree'), "Master's Degree");
    assert.equal(valueFor('second-degree'), "Bachelor's Degree");
    await page.close();
  });
});
