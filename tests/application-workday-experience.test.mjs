import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  buildOperationalFormPlan,
  executeOperationalFormPlan,
  inspectOperationalApplicationForm,
} from '../application-form-engine.mjs';

const BASE = 'https://acme.wd3.myworkdayjobs.com/en-US/acme/job/Helsinki/Engineer_R100001/apply/myExperience';
const profile = {
  candidate: {}, location: {}, currentStatus: {}, compensation: {},
  education: { expected_graduation_date: '31/12/2026' },
  formRules: {}, answers: new Map(), priorApprovedAnswers: [],
  cvText: `## Education\n\n### Example University\n\n**Master of Computer Science**\n\n### Example College\n\n**Bachelor of Information Technology**\n\n## Languages\n\n- English: Fluent\n- Spanish: Beginner\n`,
};
const context = { batchId: 'workday-experience-synthetic', candidate: { candidate_id: `cand_v1_${'x'.repeat(64)}` }, jobCountry: 'Finland' };

const panel = (heading, school, id) => {
  const headingId = heading.toLowerCase().replace(/\s+/g, '-') + '-panel';
  return `<div role="group" aria-labelledby="${headingId}">
  <h5 id="${headingId}">${heading}</h5>
  <label for="school-${id}">School or University*</label>
  <input id="school-${id}" name="schoolName" value="${school}" required>
  <button type="button" id="degree-${id}" name="degree" aria-label="Degree Select One Required"
    aria-required="true" aria-haspopup="listbox">Select One</button>
  </div>`;
};

const languagePanel = (language, id, options, checked = false) => `<div role="group" aria-labelledby="Languages-${id}-panel">
  <h5 id="Languages-${id}-panel">Languages ${id}</h5>
  <button type="button" id="language-${id}" name="language" value="internal-${id}"
    aria-label="Language ${language} Required">${language}</button>
  <label for="fluent-${id}">I am fluent in this language.</label>
  <input type="checkbox" id="fluent-${id}" name="native" ${checked ? 'checked' : ''}>
  ${['Listening', 'Overall', 'Reading', 'Speaking', 'Writing'].map((skill) => `<button type="button"
    id="${id}-${skill.toLowerCase()}" name="level-${id}-${skill.toLowerCase()}"
    aria-label="${skill} Select One Required" aria-required="true" aria-haspopup="listbox">Select One</button>`).join('')}
  </div>`;

function fixture() {
  return `<div id="root"><div data-automation-id="applyFlowPage">
    <ol data-automation-id="progressBar"><li data-automation-id="progressBarActiveStep"><div>
      <label>current step 3 of 6</label><label>My Experience</label></div></li></ol>
    <main id="step">
      ${panel('Education 1', 'Example University', 'one')}
      ${panel('Education 2', 'Example College', 'two')}
      ${panel('Education 3', 'Unlisted Institute', 'three')}
      ${languagePanel('English', 'english', ['Fluent', 'Beginner'])}
      ${languagePanel('Spanish', 'spanish', ['Elementary', 'Fluent'], true)}
      <div role="group" aria-labelledby="graduation-question">
        <label id="graduation-question">What is your expected graduation date?*</label>
        <div role="group" data-automation-id="dateInputWrapper" aria-labelledby="graduation-question">
          <input id="dateSectionMonth-input" role="spinbutton" aria-label="Month" required>
          <input id="dateSectionDay-input" role="spinbutton" aria-label="Day" required>
          <input id="dateSectionYear-input" role="spinbutton" aria-label="Year" required>
        </div>
      </div>
      <div role="group" aria-labelledby="Resume/CV-section">
        <h4 id="Resume/CV-section">Resume/CV</h4>
        <div data-automation-id="attachments-FileUpload" id="resume-slot">
          <div data-automation-id="file-upload-drop-zone"><div>Drop file here</div>
            <button type="button" data-automation-id="select-files">Select files</button></div>
          <input type="file" data-automation-id="file-upload-input-ref" style="display:none">
        </div>
      </div>
    </main>
    <button type="submit" id="review-submit">Submit</button>
  </div></div>
  <script>
    window.reviewSubmitClicks = 0;
    document.getElementById('review-submit').addEventListener('click', () => { window.reviewSubmitClicks += 1; });
    const choices = {
      'degree-one': ['Bachelor of Engineering', 'Master of Science'],
      'degree-two': ['Master of Science', 'Bachelor of Engineering'],
      'degree-three': ['Master of Science', 'Bachelor of Engineering'],
      english: ['Fluent', 'Beginner'], spanish: ['Elementary', 'Fluent'],
    };
    let menuSequence = 0;
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button[aria-haspopup="listbox"]');
      if (button) {
        document.querySelectorAll('[role="listbox"]').forEach((menu) => menu.remove());
        const menu = document.createElement('div');
        menu.id = 'opened-menu-' + (++menuSequence);
        menu.setAttribute('role', 'listbox');
        menu.dataset.control = button.id;
        const group = button.closest('[role="group"]');
        const groupLanguage = group?.querySelector('[name="language"]')?.textContent.trim();
        const options = choices[button.id] || choices[groupLanguage?.toLowerCase()];
        options.forEach((text) => {
          const option = document.createElement('div');
          option.setAttribute('role', 'option'); option.textContent = text; menu.append(option);
        });
        button.after(menu); button.setAttribute('aria-controls', menu.id); return;
      }
      const option = event.target.closest('[role="option"]');
      if (!option) return;
      const menu = option.closest('[role="listbox"]');
      const control = document.getElementById(menu.dataset.control);
      control.textContent = option.textContent; menu.remove();
    });
    document.addEventListener('change', (event) => {
      if (event.target.type !== 'file') return;
      const slot = event.target.closest('#resume-slot');
      slot.innerHTML = '<div data-automation-id="file-upload-item-name">' + event.target.files[0].name + '</div>';
    });
  </script>`;
}

test('real Workday Experience panels preserve autofill, resolve opened choices, upload CV, and fill date segments', async () => {
  const browser = await chromium.launch({ headless: true });
  const dir = mkdtempSync(join(tmpdir(), 'roleforge-workday-experience-'));
  const cvPath = join(dir, 'Synthetic_CV.pdf');
  writeFileSync(cvPath, '%PDF synthetic fixture');
  const artifact = { resolvedPath: cvPath, intendedFilename: 'Synthetic_CV.pdf', sha256: 'sha256:synthetic-cv' };
  try {
    const page = await browser.newPage();
    await page.route(BASE, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture() }));
    await page.goto(BASE);
    const snapshot = await inspectOperationalApplicationForm(page);
    const plan = buildOperationalFormPlan(snapshot, profile, { cv: artifact }, { context });

    assert.equal(plan.actions.filter((action) => action.semantic === 'degree').length, 2);
    assert.ok(plan.unresolvedFields.some((field) => field.semantic === 'degree' && /Unlisted Institute/.test(field.label)));
    assert.equal(plan.actions.filter((action) => action.semantic === 'university').length, 0,
      'prefilled school inputs are never replaced');
    assert.equal(plan.actions.filter((action) => action.semantic === 'language_proficiency').length, 10);
    assert.ok(plan.actions.some((action) => action.semantic === 'language_fluent' && action.action === 'check'));
    assert.ok(plan.actions.some((action) => action.semantic === 'language_fluent' && action.action === 'uncheck'));
    assert.ok(plan.actions.some((action) => action.semantic === 'cv_upload' && action.artifact === artifact));
    assert.deepEqual(plan.actions.find((action) => action.action === 'date').dateSegments
      .map((segment) => [segment.segment, segment.value]), [['month', '12'], ['day', '31'], ['year', '2026']]);
    assert.equal(await page.locator('[role="listbox"]').count(), 0, 'choices are absent until a dropdown is opened');

    const execution = await executeOperationalFormPlan(page, plan);
    assert.equal(execution.unresolvedFields.length, 0, JSON.stringify(execution.unresolvedFields));
    assert.ok(execution.uploadedArtifacts.some((row) => row.filename === artifact.intendedFilename));
    assert.equal(await page.locator('#school-one').inputValue(), 'Example University');
    assert.equal(await page.locator('#school-two').inputValue(), 'Example College');
    assert.equal(await page.locator('#school-three').inputValue(), 'Unlisted Institute');
    assert.equal(await page.locator('#degree-one').innerText(), 'Master of Science');
    assert.equal(await page.locator('#degree-two').innerText(), 'Bachelor of Engineering');
    assert.equal(await page.locator('#english-overall').innerText(), 'Fluent');
    assert.equal(await page.locator('#spanish-overall').innerText(), 'Elementary');
    assert.equal(await page.locator('#fluent-english').isChecked(), true);
    assert.equal(await page.locator('#fluent-spanish').isChecked(), false);
    assert.deepEqual(await page.locator('[data-automation-id="dateInputWrapper"] input').evaluateAll((items) => items.map((item) => item.value)),
      ['12', '31', '2026'], 'each date segment gets only its own value');
    assert.equal(await page.locator('[data-automation-id="file-upload-item-name"]').innerText(), artifact.intendedFilename);
    assert.equal(await page.evaluate(() => window.reviewSubmitClicks), 0, 'Review Submit is never clicked');
    await page.close();

    const prefilledPage = await browser.newPage();
    const prefilledHtml = fixture().replace('id="dateSectionMonth-input" role="spinbutton" aria-label="Month" required',
      'id="dateSectionMonth-input" role="spinbutton" aria-label="Month" value="11" required');
    await prefilledPage.route(BASE, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: prefilledHtml }));
    await prefilledPage.goto(BASE);
    const prefilledPlan = buildOperationalFormPlan(await inspectOperationalApplicationForm(prefilledPage), profile, {}, { context });
    assert.equal(prefilledPlan.actions.some((action) => action.semantic === 'graduation'), false,
      'a prefilled date group is left untouched');
    assert.ok(prefilledPlan.preservedFields.some((field) => field.semantic === 'graduation'));
    await prefilledPage.close();

    const partialPage = await browser.newPage();
    await partialPage.route(BASE, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture() }));
    await partialPage.goto(BASE);
    const partialProfile = { ...profile, education: { expected_graduation_date: '12/2026' } };
    const partialPlan = buildOperationalFormPlan(await inspectOperationalApplicationForm(partialPage), partialProfile, {}, { context });
    assert.equal(partialPlan.actions.some((action) => action.semantic === 'graduation'), false);
    assert.ok(partialPlan.unresolvedFields.some((field) => field.semantic === 'graduation'),
      'a required Day segment with no grounded day leaves the whole date manual');
    await partialPage.close();
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
