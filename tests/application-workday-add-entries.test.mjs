import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { prepareOperationalApplicationForm } from '../application-form-engine.mjs';

const BASE = 'https://acme.wd3.myworkdayjobs.com/en-US/acme/job/Helsinki/Engineer_R100001/apply/my-experience';
const context = { batchId: 'workday-add-entries-fixture', candidate: { candidate_id: `cand_v1_${'a'.repeat(64)}` } };
const profile = {
  candidate: {
    full_name: 'Taylor Sample', email: 'taylor@example.test',
    linkedin: 'https://www.linkedin.com/in/taylor-sample', github: 'https://github.com/taylor-sample',
  },
  location: { city: 'Sample City', country: 'Finland' }, currentStatus: {}, compensation: {},
  education: { expected_graduation_date: '2026-06' }, formRules: {}, answers: new Map(),
  cvText: `## Experience
### Current Analyst | Example Labs
**Mar 2024 - Present**
- Built reliable tools
- Improved reporting

### Data Assistant | Sample Group
**Jan 2020 - Dec 2021**
- Prepared weekly reports

### Community Volunteer
- Helped at local events

## Education
### Example University
**Master's, Applied Mathematics** | 2022 - Present

### Sample College
**Bachelor's, Computer Science** | 2018 - 2022

### Exchange Semester
**Exchange programme** | 2017

### Summer Institute
**Summer school** | 2016

## Languages
- English: Fluent
- Finnish: Beginner
`,
  articleDigestText: '', answerBankText: '', profileModeText: '',
};

const stepBar = (step, label, nextLabel = 'Next step') => `<ol data-automation-id="progressBar">
  <li data-automation-id="progressBarActiveStep"><div><label>current step ${step} of 6</label><label>${label}</label></div></li>
  <li data-automation-id="progressBarInactiveStep"><div><label>step ${step + 1} of 6</label><label>${nextLabel}</label></div></li>
</ol>`;

function emptyExperienceStep() {
  return `<div data-automation-id="applyFlowMyExperiencePage"><h2>My Experience</h2>
    <div role="group" aria-labelledby="Work-Experience-section"><h4 id="Work-Experience-section">Work Experience</h4>
      <button type="button" data-automation-id="add-button" id="work-add">Add</button></div>
    <div role="group" aria-labelledby="Education-section"><h4 id="Education-section">Education</h4>
      <button type="button" data-automation-id="add-button" id="education-add">Add</button></div>
    <div role="group" aria-labelledby="Languages-section"><h4 id="Languages-section">Languages</h4>
      <button type="button" data-automation-id="add-button" id="languages-add">Add</button></div>
    <div role="group" aria-labelledby="Websites-section"><h4 id="Websites-section">Websites</h4><p>Add any relevant websites.</p>
      <button type="button" data-automation-id="add-button" id="websites-add">Add</button></div>
  </div>`;
}

async function servedPage(browser, body = emptyExperienceStep()) {
  const next = '<button type="submit" id="next" data-automation-id="pageFooterNextButton">Save and Continue</button>';
  const html = `<div data-automation-id="applyFlowPage">
    <div id="progress">${stepBar(3, 'My Experience', 'Application Questions')}</div>
    <div id="step">${body}</div>
    <div data-automation-id="pageFooter">${next}</div></div>
    <script>
      window.adds = { work: 0, education: 0, languages: 0, websites: 0 };
      window.saves = 0; window.submitAttempts = 0; window.savedValues = null; let popupNumber = 0;
      const sectionFor = (button) => button.closest('[role="group"][aria-labelledby$="-section"]');
      const panelsFor = (section) => section.querySelectorAll('[role="group"][aria-labelledby$="-panel"]');
      const dateGroup = (prefix, label, required = true) => '<span id="' + prefix + '-label">' + label + '</span>'
        + '<div id="' + prefix + '" role="group" aria-labelledby="' + prefix + '-label" data-automation-id="dateInputWrapper">'
        + '<input type="text" role="spinbutton" aria-label="Month" ' + (required ? 'required' : '') + ' id="' + prefix + '-dateSectionMonth-input">'
        + '<input type="text" role="spinbutton" aria-label="Year" ' + (required ? 'required' : '') + ' id="' + prefix + '-dateSectionYear-input"></div>';
      const yearGroup = (prefix, label) => '<span id="' + prefix + '-label">' + label + '</span>'
        + '<div id="' + prefix + '" role="group" aria-labelledby="' + prefix + '-label" data-automation-id="dateInputWrapper">'
        + '<input type="text" role="spinbutton" aria-label="Year" required id="' + prefix + '-dateSectionYear-input"></div>';
      const workPanel = (n) => {
        const p = 'workExperience-' + n;
        return '<div role="group" aria-labelledby="Work-Experience-' + n + '-panel">'
          + '<h5 id="Work-Experience-' + n + '-panel">Work Experience ' + n + '</h5>'
          + '<label for="' + p + '--jobTitle">Job Title</label><input required id="' + p + '--jobTitle">'
          + '<label for="' + p + '--companyName">Company</label><input required id="' + p + '--companyName">'
          + '<label for="' + p + '--location">Location</label><input id="' + p + '--location">'
          + '<label><input type="checkbox" id="' + p + '--currentlyWorkHere">I currently work here</label>'
          + dateGroup(p + '--startDate', 'Start Date') + dateGroup(p + '--endDate', 'End Date', false)
          + '<label for="' + p + '--roleDescription">Role Description</label><textarea id="' + p + '--roleDescription"></textarea></div>';
      };
      const educationPanel = (n) => {
        const p = 'education-' + n;
        return '<div role="group" aria-labelledby="Education-' + n + '-panel">'
          + '<h5 id="Education-' + n + '-panel">Education ' + n + '</h5>'
          + '<label for="' + p + '--schoolName">School Name</label><input required id="' + p + '--schoolName" name="schoolName">'
          + '<label for="' + p + '--degree">Degree</label><button type="button" required aria-required="true" aria-haspopup="listbox" name="degree" id="' + p + '--degree">Select One</button>'
          + '<label for="' + p + '--fieldOfStudy">Field of Study</label><div data-automation-id="multiSelectContainer">'
          + '<input id="' + p + '--fieldOfStudy" aria-label="Field of Study" placeholder="Search" data-uxi-widget-type="selectinput"></div>'
          + '<label for="' + p + '--firstYearAttended-dateSectionYear-input">First Year Attended</label>'
          + yearGroup(p + '--firstYearAttended', 'First Year Attended')
          + '<label for="' + p + '--lastYearAttended-dateSectionYear-input">Last Year Attended</label>'
          + yearGroup(p + '--lastYearAttended', 'Last Year Attended') + '</div>';
      };
      const languagePanel = (n) => {
        const p = 'language-' + n;
        const dropdown = (name, label) => '<div><label for="' + p + '--' + name + '">' + label + '</label>'
          + '<button type="button" aria-haspopup="listbox" name="' + name + '" id="' + p + '--' + name + '">Select One</button></div>';
        return '<div role="group" aria-labelledby="Languages-' + n + '-panel">'
          + '<h5 id="Languages-' + n + '-panel">Languages ' + n + '</h5>'
          + dropdown('language', 'Language')
          + '<label><input type="checkbox" name="native" id="' + p + '--native">I am fluent in this language.</label>'
          + dropdown('listening', 'Listening') + dropdown('overall', 'Overall') + dropdown('reading', 'Reading')
          + dropdown('speaking', 'Speaking') + dropdown('writing', 'Writing') + '</div>';
      };
      const addPanel = (button, html) => {
        const section = sectionFor(button); const n = panelsFor(section).length + 1;
        const wrapper = document.createElement('div'); wrapper.innerHTML = html(n);
        section.insertBefore(wrapper.firstElementChild, button);
      };
      document.addEventListener('click', (event) => {
        const add = event.target.closest('[data-automation-id="add-button"]');
        if (add) {
          const section = sectionFor(add); const id = section.getAttribute('aria-labelledby');
          const key = id === 'Work-Experience-section' ? 'work'
            : id === 'Education-section' ? 'education' : id === 'Languages-section' ? 'languages' : 'websites';
          window.adds[key]++;
          if (key === 'work') addPanel(add, workPanel);
          if (key === 'education') addPanel(add, educationPanel);
          if (key === 'languages') addPanel(add, languagePanel);
          if (key === 'websites') {
            const n = panelsFor(section).length + 1; const panel = document.createElement('div');
            panel.setAttribute('role', 'group'); panel.setAttribute('aria-labelledby', 'Websites-' + n + '-panel');
            panel.innerHTML = '<h5 id="Websites-' + n + '-panel">Websites ' + n + '</h5><label for="url-' + n + '">URL</label><input type="text" id="url-' + n + '">';
            section.insertBefore(panel, add);
          }
        }
        const button = event.target.closest('button[aria-haspopup="listbox"]');
        if (button) {
          const old = document.querySelector('[data-test-popup="listbox"]'); old?.remove();
          const popup = document.createElement('div'); popup.dataset.testPopup = 'listbox'; popup.setAttribute('role', 'listbox');
          popup.id = 'listbox-' + (++popupNumber); button.setAttribute('aria-controls', popup.id);
          const choices = button.name === 'degree' ? ['Bachelor', 'Master']
            : button.name === 'language' ? ['English', 'Finnish'] : ['Native', 'Fluent', 'Beginner'];
          for (const value of choices) { const option = document.createElement('div'); option.setAttribute('role', 'option'); option.textContent = value; popup.append(option); }
          document.body.append(popup);
        }
        const option = event.target.closest('[role="option"]');
        if (option) {
          const popup = option.closest('[role="listbox"]'); const control = document.querySelector('[aria-controls="' + popup.id + '"]');
          if (control) control.textContent = option.textContent;
          popup.remove();
        }
        const pick = event.target.closest('[data-automation-id="promptOption"]');
        if (pick) {
          const input = document.getElementById(pick.closest('[data-test-popup="pick"]').dataset.fieldId);
          const container = input.closest('[data-automation-id="multiSelectContainer"]');
          const chip = document.createElement('span'); chip.dataset.automationId = 'selectedItem'; chip.textContent = pick.textContent;
          container.append(chip); input.value = '';
          document.querySelector('[data-test-popup="pick"]')?.remove();
        }
        if (event.target.id === 'next' && event.target.textContent === 'Save and Continue') {
          window.saves++;
          const read = (selector) => [...document.querySelectorAll(selector)].map((item) => item.value || item.textContent || '');
          window.savedValues = {
            jobs: read('[role="group"][aria-labelledby^="Work-Experience-"][aria-labelledby$="-panel"] input[id$="--jobTitle"]'),
            companies: read('[role="group"][aria-labelledby^="Work-Experience-"][aria-labelledby$="-panel"] input[id$="--companyName"]'),
            descriptions: read('[role="group"][aria-labelledby^="Work-Experience-"][aria-labelledby$="-panel"] textarea'),
            startDates: [...document.querySelectorAll('[role="group"][aria-labelledby^="Work-Experience-"][aria-labelledby$="-panel"] [id$="--startDate"] input[role="spinbutton"]')].map((item) => item.value),
            endDates: [...document.querySelectorAll('[role="group"][aria-labelledby^="Work-Experience-"][aria-labelledby$="-panel"] [id$="--endDate"] input[role="spinbutton"]')].map((item) => item.value),
            currentlyWorking: [...document.querySelectorAll('[role="group"][aria-labelledby^="Work-Experience-"][aria-labelledby$="-panel"] input[id$="--currentlyWorkHere"]')].map((item) => item.checked),
            schools: read('[role="group"][aria-labelledby^="Education-"][aria-labelledby$="-panel"] input[id$="--schoolName"]'),
            degrees: read('[role="group"][aria-labelledby^="Education-"][aria-labelledby$="-panel"] button[name="degree"]'),
            fieldsOfStudy: [...document.querySelectorAll('[role="group"][aria-labelledby^="Education-"][aria-labelledby$="-panel"] [data-automation-id="multiSelectContainer"] [data-automation-id="selectedItem"]')].map((item) => item.textContent),
            educationYears: [...document.querySelectorAll('[role="group"][aria-labelledby^="Education-"][aria-labelledby$="-panel"] [id$="YearAttended"] input[role="spinbutton"]')].map((item) => item.value),
            languages: read('[role="group"][aria-labelledby^="Languages-"][aria-labelledby$="-panel"] button[name="language"]'),
            languageLevels: [...document.querySelectorAll('[role="group"][aria-labelledby^="Languages-"][aria-labelledby$="-panel"] button:not([name="language"])')].map((item) => item.textContent),
            websites: read('[role="group"][aria-labelledby="Websites-section"] input[id^="url-"]'),
            native: [...document.querySelectorAll('[role="group"][aria-labelledby^="Languages-"][aria-labelledby$="-panel"] input[name="native"]')].map((item) => item.checked),
          };
          document.querySelector('#progress').innerHTML = '<ol data-automation-id="progressBar"><li data-automation-id="progressBarActiveStep"><div><label>current step 6 of 6</label><label>Review</label></div></li></ol>';
          document.querySelector('#step h2').textContent = 'Review';
          event.target.textContent = 'Submit';
        } else if (event.target.id === 'next' && event.target.textContent === 'Submit') window.submitAttempts++;
      });
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.target.getAttribute('data-uxi-widget-type') !== 'selectinput') return;
        event.preventDefault(); document.querySelector('[data-test-popup="pick"]')?.remove();
        const popup = document.createElement('div'); popup.dataset.testPopup = 'pick'; popup.style.cssText = 'position:fixed;top:5px;left:5px';
        popup.dataset.fieldId = event.target.id;
        const exact = event.target.closest('[data-automation-id="multiSelectContainer"]')?.querySelector('input') === event.target;
        const choices = exact && /Computer Science/i.test(event.target.value)
          ? ['Computer Science', 'Computer Science and Engineering']
          : exact && /Applied Mathematics/i.test(event.target.value) ? ['Applied Mathematics'] : [];
        for (const value of choices) { const option = document.createElement('div'); option.dataset.automationId = 'promptOption'; option.textContent = value; popup.append(option); }
        document.body.append(popup);
      });
    </script>`;
  const page = await browser.newPage();
  await page.route(BASE, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(BASE);
  return page;
}

test('empty Workday entry sections are populated from grounded CV entries and the safe continuation proceeds', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await servedPage(browser);
    const log = [];
    const result = await prepareOperationalApplicationForm(page, profile, {}, {
      context, transitionTimeoutMs: 1_000, transitionStabilityMs: 0, progressLog: (line) => log.push(line),
    });

    assert.deepEqual(await page.evaluate(() => window.adds), { work: 2, education: 2, languages: 2, websites: 2 });
    const savedValues = await page.evaluate(() => window.savedValues);
    assert.deepEqual(savedValues.jobs, ['Current Analyst', 'Data Assistant']);
    assert.deepEqual(savedValues.companies, ['Example Labs', 'Sample Group']);
    assert.deepEqual(savedValues.descriptions, ['- Built reliable tools\n- Improved reporting', '- Prepared weekly reports']);
    assert.deepEqual(savedValues.startDates, ['03', '2024', '01', '2020']);
    assert.deepEqual(savedValues.endDates, ['', '', '12', '2021']);
    assert.deepEqual(savedValues.currentlyWorking, [true, false]);
    assert.deepEqual(savedValues.schools, ['Example University', 'Sample College']);
    assert.deepEqual(savedValues.degrees, ['Master', 'Bachelor']);
    assert.deepEqual(savedValues.fieldsOfStudy, ['Applied Mathematics', 'Computer Science']);
    assert.deepEqual(savedValues.educationYears, ['2022', '2026', '2018', '2022']);
    assert.deepEqual(savedValues.languages, ['English', 'Finnish']);
    assert.deepEqual(savedValues.languageLevels, ['Fluent', 'Fluent', 'Fluent', 'Fluent', 'Fluent', 'Beginner', 'Beginner', 'Beginner', 'Beginner', 'Beginner']);
    assert.deepEqual(savedValues.websites, [profile.candidate.linkedin, profile.candidate.github]);
    assert.deepEqual(savedValues.native, [true, false]);
    assert.equal(await page.evaluate(() => window.saves), 1, JSON.stringify({ gate: result.gate, unresolved: result.evidence.unresolvedFields }));
    assert.equal(await page.evaluate(() => window.submitAttempts), 0, 'Review Submit is never clicked');
    assert.deepEqual(result.evidence.unresolvedFields.map((item) => item.label), []);
    assert.ok(log.some((line) => /Current Analyst/.test(line) && /added Work Experience 1/.test(line)));
    assert.ok(log.some((line) => /Community Volunteer/.test(line) && /left for user review/.test(line)));
    assert.ok(log.some((line) => /Exchange Semester/.test(line) && /left for user review/.test(line)));
    assert.ok(log.some((line) => /Summer Institute/.test(line) && /left for user review/.test(line)));
    await page.close();
  } finally {
    await browser.close();
  }
});

function existingExperienceStep() {
  const sections = [
    ['Work-Experience-section', 'Work Experience', 'Work-Experience-1-panel', 'Work Experience 1'],
    ['Education-section', 'Education', 'Education-1-panel', 'Education 1'],
    ['Languages-section', 'Languages', 'Languages-1-panel', 'Languages 1'],
  ].map(([sectionId, title, panelId, panelTitle]) => `<div role="group" aria-labelledby="${sectionId}">
    <h4 id="${sectionId}">${title}</h4><div role="group" aria-labelledby="${panelId}"><h5 id="${panelId}">${panelTitle}</h5></div>
    <button type="button" data-automation-id="add-button">Add</button></div>`).join('');
  return `<div data-automation-id="applyFlowMyExperiencePage"><h2>My Experience</h2>
    <label for="existing-first">First Name</label><input id="existing-first" value="Taylor">
    <label for="existing-last">Last Name</label><input id="existing-last" value="Sample">
    <label for="existing-email">Email Address</label><input id="existing-email" type="email" value="taylor@example.test">${sections}
    <div role="group" aria-labelledby="Websites-section"><h4 id="Websites-section">Websites</h4>
      <div role="group" aria-labelledby="Websites-1-panel"><h5 id="Websites-1-panel">Websites 1</h5><label for="existing-linkedin">URL</label><input id="existing-linkedin" type="text" value="${profile.candidate.linkedin}"></div>
      <div role="group" aria-labelledby="Websites-2-panel"><h5 id="Websites-2-panel">Websites 2</h5><label for="existing-github">URL</label><input id="existing-github" type="text" value="${profile.candidate.github}"></div>
      <button type="button" data-automation-id="add-button">Add Another</button></div></div>`;
}

test('parsed Workday entry panels prevent duplicate Add clicks', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await servedPage(browser, existingExperienceStep());
    const result = await prepareOperationalApplicationForm(page, profile, {}, {
      context, transitionTimeoutMs: 1_000, transitionStabilityMs: 0,
    });
    assert.deepEqual(await page.evaluate(() => window.adds), { work: 0, education: 0, languages: 0, websites: 0 });
    assert.equal(await page.evaluate(() => window.saves), 1, JSON.stringify({ gate: result.gate, unresolved: result.evidence.unresolvedFields }));
    assert.equal(await page.evaluate(() => window.submitAttempts), 0);
    assert.equal(result.evidence.finalAction.activated, false);
    await page.close();
  } finally {
    await browser.close();
  }
});
