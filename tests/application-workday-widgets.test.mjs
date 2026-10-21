import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  buildOperationalFormPlan,
  inspectOperationalApplicationForm,
  prepareOperationalApplicationForm,
} from '../application-form-engine.mjs';

const BASE = 'https://acme.wd3.myworkdayjobs.com/en-US/acme/job/Helsinki/Engineer_R100001/apply/myInformation';
const profile = {
  candidate: {
    full_name: 'Alex Example', email: 'alex@example.test', phone: '+358 40 123 4567',
    phone_type: 'Mobile', location: 'Example City, Finland',
  },
  location: { country: 'Finland', city: 'Example City' },
  currentStatus: {}, compensation: {}, education: {},
  formRules: { current_location: { city: 'Example City', country: 'Finland', combined: 'Example City, Finland' } },
  answers: new Map(), priorApprovedAnswers: [], cvText: '', articleDigestText: '', answerBankText: '', profileModeText: '',
};
const context = {
  batchId: 'workday-widget-fixture', candidate: { candidate_id: `cand_v1_${'x'.repeat(64)}`, companyName: 'Acme' },
  jobCountry: 'Finland', discovery: { source: 'workday', urls: [] },
};

function esc(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function pickField(id, label, options, selected = '', children = []) {
  const chip = selected
    ? `<div data-automation-id="selectedItem"><p>${esc(selected)}</p></div>` : '';
  return `<div data-automation-id="formField-${id}"><label for="${id}">${label}<abbr>*</abbr></label>
    <div data-automation-id="multiSelectContainer">${chip}<input id="${id}" aria-label="${label}" aria-required="true"
      placeholder="Search" data-uxi-widget-type="selectinput" data-options="${esc(JSON.stringify(options))}"
      data-children="${esc(JSON.stringify(children))}"></div></div>`;
}

function listbox(id, label, options, required = true) {
  return `<div><button type="button" id="${id}" aria-label="${label}" aria-haspopup="listbox"
    aria-required="${required}" data-options="${esc(JSON.stringify(options))}">Select One</button></div>`;
}

const progress = (step, total, name) => `<ol data-automation-id="progressBar"><li data-automation-id="progressBarActiveStep"><div>
  <label>current step ${step} of ${total}</label><label>${name}</label></div></li></ol>`;

function widgetFlow({ sourceOptions = ['Acme Careers Website'], sourceChildren = [], phoneOptions = ['Mobile', 'Home'], selectedSource = '' } = {}) {
  const initial = `<div data-automation-id="applyFlowMyInfoPage"><h2>My Information</h2>
    <label for="first-name">First Name*</label><input id="first-name" required>
    <label for="last-name">Last Name*</label><input id="last-name" required>
    <label for="email">Email Address*</label><input id="email" type="email" required>
    ${pickField('source--source', 'How Did You Hear About Us?', sourceOptions, selectedSource, sourceChildren)}
    ${pickField('phoneNumber--countryPhoneCode', 'Country Phone Code', ['Finland (+358)'])}
    ${listbox('phoneNumber--phoneType', 'Phone Device Type', phoneOptions)}
    <label for="phone-number">Phone Number*</label><input id="phone-number" type="tel" required></div>`;
  return `<div id="root"><div><div><div data-automation-id="applyFlowPage"><div id="progress">${progress(2, 3, 'My Information')}</div>
    <div><div><main id="step">${initial}</main></div></div><div data-automation-id="pageFooter">
      <button type="submit" id="next" data-automation-id="pageFooterNextButton">Save and Continue</button></div></div></div></div></div>
    <script>
      window.saveClicks = 0; window.submitClicks = 0; let step = 2;
      document.addEventListener('input', (event) => {
        const old = event.target;
        if (old.matches('[data-uxi-widget-type="selectinput"]') && !old.dataset.fresh) {
          const copy = old.cloneNode(true); copy.dataset.fresh = '1';
          setTimeout(() => { if (old.isConnected) old.replaceWith(copy); }, 0);
        }
      });
      document.addEventListener('keydown', (event) => {
        const input = event.target instanceof Element ? event.target.closest('[data-uxi-widget-type="selectinput"]') : null;
        if (!input) return;
        if (event.key === 'Escape') { document.querySelector('#prompt')?.remove(); return; }
        if (event.key !== 'Enter') return;
        event.preventDefault(); document.querySelector('#prompt')?.remove();
        const menu = document.createElement('div'); menu.id = 'prompt'; menu.setAttribute('role', 'listbox');
        JSON.parse(input.dataset.options || '[]').forEach((text) => {
          const option = document.createElement('div'); option.setAttribute('data-automation-id', 'promptOption');
          option.setAttribute('role', 'option'); option.textContent = text; menu.append(option);
          if (text === 'Company Website' && JSON.parse(input.dataset.children || '[]').length) option.setAttribute('aria-haspopup', 'listbox');
        });
        input.closest('[data-automation-id="multiSelectContainer"]').append(menu);
      });
      document.addEventListener('click', (event) => {
        const button = event.target.closest('button[aria-haspopup="listbox"]');
        if (button && button.id !== 'next') {
          document.querySelector('#dropdown')?.remove();
          const menu = document.createElement('div'); menu.id = 'dropdown'; menu.setAttribute('role', 'listbox');
          menu.id = 'menu-' + button.id; button.setAttribute('aria-controls', menu.id);
          JSON.parse(button.dataset.options || '[]').forEach((text) => {
            const option = document.createElement('div'); option.setAttribute('role', 'option'); option.textContent = text;
            menu.append(option);
          }); button.after(menu); return;
        }
        const option = event.target.closest('[role="option"]');
        if (option) {
          const menu = option.closest('[role="listbox"]');
          if (menu.id === 'prompt') {
            const input = menu.closest('[data-automation-id="multiSelectContainer"]').querySelector('[data-uxi-widget-type="selectinput"]');
            if (option.hasAttribute('aria-haspopup')) {
              menu.replaceChildren(...JSON.parse(input.dataset.children || '[]').map((text) => {
                const child = document.createElement('div'); child.setAttribute('data-automation-id', 'promptOption');
                child.setAttribute('role', 'option'); child.textContent = text; return child;
              }));
              return;
            }
            const chip = document.createElement('div'); chip.setAttribute('data-automation-id', 'selectedItem');
            chip.textContent = option.textContent; menu.before(chip); menu.remove(); input.value = '';
          } else {
            const button = document.getElementById(menu.id.slice(5)); button.textContent = option.textContent; menu.remove();
          }
          return;
        }
        if (event.target.closest('#next')) {
          if (step === 3) { window.submitClicks += 1; return; }
          const picksCommitted = [...document.querySelectorAll('[data-uxi-widget-type="selectinput"]')]
            .every((input) => input.closest('[data-automation-id="multiSelectContainer"]')
              .querySelector('[data-automation-id="selectedItem"]'));
          const dropdownsCommitted = [...document.querySelectorAll('button[aria-haspopup="listbox"]')]
            .every((button) => button.textContent.trim() !== 'Select One');
          if (!picksCommitted || !dropdownsCommitted) return;
          window.saveClicks += 1; step = 3;
          document.querySelector('#step').insertAdjacentHTML('afterbegin', '<div data-automation-id="applyFlowReviewPage"><h2>Review</h2></div>');
          document.querySelector('#progress').innerHTML = ${JSON.stringify(progress(3, 3, 'Review'))};
          document.querySelector('#next').textContent = 'Submit';
        }
      });
    </script>`;
}

async function servedPage(browser, html) {
  const page = await browser.newPage();
  await page.route(BASE, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(BASE);
  return page;
}

test('Workday pick chips, phone type listbox, progression, and final-submit guard work together', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await servedPage(browser, widgetFlow({
      sourceOptions: ['Company Website'], sourceChildren: ['Acme Careers Website'],
    }));
    const manualCalls = [];
    const result = await prepareOperationalApplicationForm(page, profile, {}, {
      context,
      transitionTimeoutMs: 2_000,
      transitionStabilityMs: 0,
      awaitManualFields: async (labels) => { manualCalls.push(labels); return false; },
    });
    assert.deepEqual(manualCalls, []);
    assert.equal(await page.locator('[data-automation-id="multiSelectContainer"] [data-automation-id="selectedItem"]').nth(0).innerText(),
      'Acme Careers Website');
    assert.equal(await page.locator('[data-automation-id="multiSelectContainer"] [data-automation-id="selectedItem"]').nth(1).innerText(),
      'Finland (+358)');
    assert.equal(await page.locator('#phoneNumber--phoneType').innerText(), 'Mobile');
    assert.equal(await page.evaluate(() => window.saveClicks), 1, 'Save and Continue is clicked once after all widget fields commit');
    assert.equal(await page.evaluate(() => window.submitClicks), 0, 'Review Submit is never clicked');
    assert.match(await page.locator('#step').innerText(), /Review/);
    assert.equal(result.evidence.finalAction.detected, true);
    assert.equal(result.evidence.finalAction.activated, false);
    await page.close();
  } finally {
    await browser.close();
  }
});

test('ambiguous and missing widget options are all handed off in one deduplicated manual list', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await servedPage(browser, widgetFlow({
      sourceOptions: ['Company Website', 'Company Career Site'],
      phoneOptions: ['Home', 'Office'],
    }));
    const manualCalls = [];
    await prepareOperationalApplicationForm(page, profile, {}, {
      context,
      transitionTimeoutMs: 1_000,
      transitionStabilityMs: 0,
      awaitManualFields: async (labels) => { manualCalls.push(labels); return false; },
    });
    assert.equal(manualCalls.length, 1);
    assert.equal(manualCalls[0].filter((label) => /How Did You Hear/.test(label)).length, 1);
    assert.equal(manualCalls[0].filter((label) => /Phone Device Type/.test(label)).length, 1);
    assert.equal(manualCalls[0].length, 2, JSON.stringify(manualCalls[0]));
    assert.equal(await page.locator('[data-automation-id="multiSelectContainer"] [data-automation-id="selectedItem"]').count(), 1,
      'only the unambiguous phone country chip is committed');
    assert.equal(await page.locator('#source--source').inputValue(), '', 'ambiguous source search text is cleared');
    assert.equal(await page.locator('#phoneNumber--phoneType').innerText(), 'Select One', 'an unmatched device option is not guessed');
    assert.equal(await page.evaluate(() => window.saveClicks), 0);
    assert.equal(await page.evaluate(() => window.submitClicks), 0);
    await page.close();
  } finally {
    await browser.close();
  }
});

test('a different existing selectinput chip is never replaced', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await servedPage(browser, widgetFlow({ selectedSource: 'Indeed' }));
    const snapshot = await inspectOperationalApplicationForm(page);
    const plan = buildOperationalFormPlan(snapshot, profile, {}, { context });
    assert.ok(!plan.actions.some((action) => action.action === 'pick' && /How Did You Hear/.test(action.label)));
    assert.ok(plan.unresolvedFields.some((row) => /How Did You Hear/.test(row.label)));
    let manual = [];
    await prepareOperationalApplicationForm(page, profile, {}, {
      context,
      transitionTimeoutMs: 1_000,
      transitionStabilityMs: 0,
      awaitManualFields: async (labels) => { manual = labels; return false; },
    });
    assert.equal(manual.filter((label) => /How Did You Hear/.test(label)).length, 1);
    assert.equal(await page.locator('[data-automation-id="multiSelectContainer"]').first()
      .locator('[data-automation-id="selectedItem"]').innerText(), 'Indeed');
    assert.equal(await page.evaluate(() => window.saveClicks), 0);
    await page.close();
  } finally {
    await browser.close();
  }
});

const experienceProfile = {
  ...profile,
  cvText: `## Education\n\n### Example University\n\n**Master of Computer Science**\n\n### Example College\n\n**Bachelor of Information Technology**\n\n## Languages\n\n- English: Fluent\n- Finnish: Beginner\n- Hindi: Native\n`,
};

function experienceFlow() {
  const degreePanel = (index, school, id) => `<section data-automation-id="education-${index}">
    <label for="school-${index}">School or University*</label><input id="school-${index}" value="${school}">
    ${listbox(id, 'Degree', index === 1 ? ['Master of Science', 'Bachelor of Engineering'] : ['Bachelor of Engineering', 'Master of Science'])}
    <button type="button">Add Another</button></section>`;
  const languagePanel = (language, id, options) => `<fieldset role="group" aria-labelledby="heading-${language.toLowerCase()}">
    <h3 id="heading-${language.toLowerCase()}">${language}</h3>
    ${['Overall', 'Reading', 'Writing', 'Speaking', 'Listening'].map((label) => listbox(
      `${id}-${label.toLowerCase()}`, `${label} Proficiency`, options,
    )).join('')}
    <label><input type="checkbox" aria-label="I am fluent">I am fluent</label></fieldset>`;
  const body = `<div data-automation-id="applyFlowExperiencePage"><h2>My Experience</h2>
    ${degreePanel(1, 'Example University', 'degree-master')}
    ${degreePanel(2, 'Example College', 'degree-bachelor')}
    ${languagePanel('English', 'english', ['Beginner', 'Fluent', 'Native'])}
    ${languagePanel('Hindi', 'hindi', ['Mother tongue', 'Fluent', 'Beginner'])}
    ${languagePanel('Finnish', 'finnish', ['Elementary', 'Native', 'Fluent'])}
    <input aria-label="Optional experience note"></div>`;
  return `<div id="root"><div><div><div data-automation-id="applyFlowPage"><div id="progress">${progress(3, 4, 'My Experience')}</div>
    <div><div><main id="step">${body}</main></div></div><div data-automation-id="pageFooter">
      <button type="submit" id="next" data-automation-id="pageFooterNextButton">Save and Continue</button></div></div></div></div></div>
    <script>
      window.saveClicks = 0; window.submitClicks = 0;
      document.addEventListener('click', (event) => {
        const button = event.target.closest('button[aria-haspopup="listbox"]');
        if (button) {
          const menu = document.createElement('div'); menu.id = 'menu-' + button.id;
          menu.setAttribute('role', 'listbox'); button.setAttribute('aria-controls', menu.id);
          JSON.parse(button.dataset.options || '[]').forEach((text) => {
            const option = document.createElement('div'); option.setAttribute('role', 'option'); option.textContent = text;
            menu.append(option);
          }); button.after(menu); return;
        }
        const option = event.target.closest('[role="option"]');
        if (option) {
          const menu = option.closest('[role="listbox"]'); document.getElementById(menu.id.slice(5)).textContent = option.textContent;
          menu.remove(); return;
        }
        if (event.target.closest('#next')) {
          const buttons = [...document.querySelectorAll('button[aria-haspopup="listbox"]')];
          if (buttons.some((item) => item.textContent.trim() === 'Select One')) return;
          if ([...document.querySelectorAll('input[type="checkbox"]')].slice(0, 2).some((item) => !item.checked)) return;
          window.saveClicks += 1;
          document.querySelector('#step').insertAdjacentHTML('afterbegin', '<div data-automation-id="applyFlowReviewPage"><h2>Review</h2></div>');
          document.querySelector('#progress').innerHTML = ${JSON.stringify(progress(4, 4, 'Review'))};
          document.querySelector('#next').textContent = 'Submit';
        }
      });
    </script>`;
}

test('My Experience fills only existing education and language blocks from CV entries', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await servedPage(browser, experienceFlow());
    const snapshot = await inspectOperationalApplicationForm(page);
    const plan = buildOperationalFormPlan(snapshot, experienceProfile, {}, { context });
    assert.equal(plan.actions.filter((action) => action.semantic === 'degree').length, 2);
    assert.equal(plan.actions.filter((action) => action.semantic === 'language_proficiency').length, 15);
    assert.equal(plan.actions.filter((action) => action.semantic === 'language_fluent').length, 2);
    assert.ok(!plan.actions.some((action) => /Add Another/.test(action.label)));
    const manualCalls = [];
    const result = await prepareOperationalApplicationForm(page, experienceProfile, {}, {
      context,
      transitionTimeoutMs: 2_000,
      transitionStabilityMs: 0,
      awaitManualFields: async (labels) => { manualCalls.push(labels); return false; },
    });
    assert.deepEqual(manualCalls, []);
    assert.equal(await page.locator('#degree-master').innerText(), 'Master of Science');
    assert.equal(await page.locator('#degree-bachelor').innerText(), 'Bachelor of Engineering');
    for (const language of ['english', 'hindi', 'finnish']) {
      const expected = language === 'english' ? 'Fluent' : language === 'hindi' ? 'Mother tongue' : 'Elementary';
      for (const skill of ['overall', 'reading', 'writing', 'speaking', 'listening']) {
        assert.equal(await page.locator(`#${language}-${skill}`).innerText(), expected, `${language} ${skill}`);
      }
    }
    assert.equal(await page.locator('fieldset[aria-labelledby="heading-english"] input[type="checkbox"]').isChecked(), true);
    assert.equal(await page.locator('fieldset[aria-labelledby="heading-hindi"] input[type="checkbox"]').isChecked(), true);
    assert.equal(await page.locator('fieldset[aria-labelledby="heading-finnish"] input[type="checkbox"]').isChecked(), false,
      'Beginner does not check I am fluent');
    assert.equal(await page.locator('section[data-automation-id^="education-"]').count(), 2, 'no education block is added');
    assert.equal(await page.evaluate(() => window.saveClicks), 1);
    assert.equal(await page.evaluate(() => window.submitClicks), 0);
    assert.equal(result.evidence.finalAction.activated, false);
    await page.close();
  } finally {
    await browser.close();
  }
});
