import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { inspectOperationalApplicationForm, prepareOperationalApplicationForm } from '../application-form-engine.mjs';

const BASE = 'https://acme.wd3.myworkdayjobs.com/en-US/acme/job/Helsinki/Engineer_R100001/apply/autofillWithResume';
const context = { batchId: 'workday-entries-fixture', candidate: { candidate_id: `cand_v1_${'e'.repeat(64)}`, title: 'Engineer' } };
const profile = (overrides = {}) => ({
  candidate: {
    full_name: 'Alex Example', email: 'alex@example.test', phone: '+358 40 123 4567',
    linkedin: 'https://www.linkedin.com/in/alex-example', github: 'https://github.com/alex-example',
    ...overrides.candidate,
  },
  location: { country: 'Finland', city: 'Example City' },
  currentStatus: {}, compensation: {}, education: {}, formRules: {}, answers: new Map(),
  cvText: overrides.cvText || '', articleDigestText: '', answerBankText: '', profileModeText: '',
});

function documents() {
  const dir = mkdtempSync(join(tmpdir(), 'roleforge-workday-entries-'));
  const resolvedPath = join(dir, 'Bound_CV.pdf');
  writeFileSync(resolvedPath, '%PDF synthetic');
  return { dir, cv: { resolvedPath, intendedFilename: 'Bound_CV.pdf', sha256: 'sha256:bound-cv' } };
}

const progress = (step, total, name) => `<ol data-automation-id="progressBar"><li data-automation-id="progressBarActiveStep"><div><label>current step ${step} of ${total}</label><label>${name}</label></div></li>${step < total ? `<li data-automation-id="progressBarInactiveStep"><div><label>step ${step + 1} of ${total}</label><label>Next step</label></div></li>` : ''}</ol>`;
const shell = (body, button = 'Continue', step = 2, name = 'My Experience') => `<div data-automation-id="applyFlowPage">
  <div id="progress">${progress(step, 3, name)}</div><div id="step">${body}</div>
  <div data-automation-id="pageFooter"><button type="submit" id="next" data-automation-id="pageFooterNextButton">${button}</button></div></div>`;
const parsedExperience = `<div data-automation-id="applyFlowMyExperiencePage">
  <h2>My Experience</h2>
  <div role="group" aria-labelledby="Work-Experience-section"><h4 id="Work-Experience-section">Work Experience</h4>
    <div role="group" aria-labelledby="work-experience-1-panel"><h5 id="work-experience-1-panel">Work Experience 1</h5>
      <label for="employer">Employer</label><input id="employer" value="Example Co">
      <label for="role">Job Title</label><input id="role" value="Engineer">
      <label for="work-location">Location</label><input id="work-location" value="Example City"></div></div>
  <div role="group" aria-labelledby="Education-section"><h4 id="Education-section">Education</h4>
    <div role="group" aria-labelledby="education-1-panel"><h5 id="education-1-panel">Education 1</h5></div></div>
  <div role="group" aria-labelledby="Languages-section"><h4 id="Languages-section">Languages</h4>
    <div role="group" aria-labelledby="languages-1-panel"><h5 id="languages-1-panel">Languages 1</h5></div></div>
</div>`;
const review = '<div data-automation-id="applyFlowReviewPage"><h2>Review</h2></div>';

async function servedPage(browser, html) {
  const page = await browser.newPage();
  await page.route(BASE, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(BASE);
  return page;
}

const cvText = `## Experience\n### Example role\nEngineer\n\n## Education\n### Example University\n**Bachelor of Science**\n\n## Languages\n- English: Fluent\n`;

test('Workday reparses an exact bound Autofill tile and never deletes a different filename', async () => {
  const browser = await chromium.launch({ headless: true });
  const docs = documents();
  try {
    const initialAutofill = `<div data-automation-id="applyFlowAutoFillPage"><h2>Autofill with Resume</h2>
      <div data-automation-id="resumeUpload"><div data-automation-id="file-upload-item">
        <span data-automation-id="file-upload-item-name">Bound_CV.pdf</span><span>Successfully Uploaded</span>
        <button type="button" aria-label="Delete Other_CV.pdf" id="delete-other"></button>
        <button type="button" aria-label="Delete Bound_CV.pdf" id="delete-resume"></button></div></div></div>`;
    const html = `${shell(initialAutofill, 'Continue', 1, 'Autofill with Resume').replace(/<button[^>]*id="next"[^>]*>[\s\S]*?<\/button>/, '<button type="submit" id="next" data-automation-id="pageFooterNextButton">Continue</button>')}
      <script>
        window.deleted = 0; window.otherDeletes = 0; window.parsed = 0; window.advances = 0; window.submits = 0; let current = 1;
        const experience = ${JSON.stringify(parsedExperience)};
        const barTemplate = ${JSON.stringify(progress(1, 3, 'Autofill with Resume'))};
        const render = () => {
          document.querySelector('#progress').innerHTML = barTemplate
            .replace('step 2 of 3', 'step ' + (current + 1) + ' of 3')
            .replace('current step 1 of 3', 'current step ' + current + ' of 3')
            .replace('Autofill with Resume', ['', 'Autofill with Resume', 'My Experience', 'Review'][current]);
          if (current === 3) document.querySelector('[data-automation-id="progressBarInactiveStep"]')?.remove();
        };
        document.getElementById('delete-resume').addEventListener('click', (event) => {
          window.deleted += 1;
          const upload = event.target.closest('[data-automation-id="resumeUpload"]');
          upload.innerHTML = '<div data-automation-id="file-upload-drop-zone"><button type="button">Select file</button></div><input type="file" data-automation-id="file-upload-input-ref" style="display:none">';
        });
        document.getElementById('delete-other').addEventListener('click', () => { window.otherDeletes += 1; });
        document.addEventListener('change', (event) => {
          if (event.target.type !== 'file') return;
          window.parsed += 1;
          const name = event.target.files[0].name;
          event.target.closest('[data-automation-id="resumeUpload"]').innerHTML = '<div data-automation-id="file-upload-item"><span data-automation-id="file-upload-item-name">' + name + '</span><span>Successfully Uploaded</span></div>';
        });
        document.getElementById('next').addEventListener('click', () => {
          if (current === 3) { window.submits += 1; return; }
          if (current === 1 && !window.parsed) return;
          current += 1; window.advances += 1; render();
          if (current === 2) document.getElementById('step').innerHTML = experience;
          if (current === 3) document.getElementById('step').innerHTML = ${JSON.stringify(review)};
          document.getElementById('next').textContent = current === 3 ? 'Submit' : 'Save and Continue';
        });
        render();
      </script>`;
    const page = await servedPage(browser, html);
    const log = [];
    const result = await prepareOperationalApplicationForm(page, profile({ cvText }), { cv: docs.cv }, {
      context, transitionTimeoutMs: 1_500, transitionStabilityMs: 0, progressLog: (line) => log.push(line),
    });
    assert.equal(await page.evaluate(() => window.deleted), 1);
    assert.equal(await page.evaluate(() => window.otherDeletes), 0, 'a different Delete button in the tile is never clicked');
    assert.equal(await page.evaluate(() => window.parsed), 1);
    assert.equal(await page.evaluate(() => window.advances), 2, JSON.stringify({
      gate: result.gate, stepsAdvanced: result.evidence.progression?.stepsAdvanced,
      progressionActions: result.plan?.progressionActions?.map((item) => item.label),
      unresolved: result.evidence.unresolvedFields.map((item) => ({ label: item.label, reason: item.reason })),
    }));
    assert.equal(await page.evaluate(() => window.submits), 0, 'Review Submit is never clicked');
    assert.ok(log.some((line) => /deleting its exact tile/.test(line)));
    assert.ok(result.evidence.uploadedArtifacts.some((item) => item.sha256 === docs.cv.sha256));
    await page.close();

    const different = `<div data-automation-id="applyFlowAutoFillPage"><h2>Autofill with Resume</h2>
      <div data-automation-id="resumeUpload"><div data-automation-id="file-upload-item">
        <span data-automation-id="file-upload-item-name">Another_CV.pdf</span><span>Successfully Uploaded</span>
        <button type="button" aria-label="Delete Another_CV.pdf" id="delete-resume"></button>
        <input type="file" data-automation-id="file-upload-input-ref" style="display:none"></div></div></div>`;
    const differentHtml = `${shell(different, 'Continue', 1, 'Autofill with Resume')}
      <script>window.deleted=0;window.advances=0;document.getElementById('delete-resume').addEventListener('click',()=>window.deleted++);document.getElementById('next').addEventListener('click',()=>{window.advances++});</script>`;
    const other = await servedPage(browser, differentHtml);
    const otherResult = await prepareOperationalApplicationForm(other, profile({ cvText }), { cv: docs.cv }, {
      context, transitionTimeoutMs: 300, transitionStabilityMs: 0,
    });
    assert.equal(await other.evaluate(() => window.deleted), 0, 'a different file is never deleted');
    assert.equal(await other.locator('[data-automation-id="file-upload-item-name"]').innerText(), 'Another_CV.pdf');
    assert.ok(otherResult.evidence.unresolvedFields.some((item) => /different file is already attached/.test(item.reason)));
    await other.close();
  } finally {
    await browser.close();
    rmSync(docs.dir, { recursive: true, force: true });
  }
});

test('empty Workday entry sections with matching CV sections pause and do not save-and-continue', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const empty = `<div data-automation-id="applyFlowMyExperiencePage"><h2>My Experience</h2>
      <div role="group" aria-labelledby="Work-Experience-section"><h4 id="Work-Experience-section">Work Experience</h4></div>
      <div role="group" aria-labelledby="Education-section"><h4 id="Education-section">Education</h4></div>
      <div role="group" aria-labelledby="Languages-section"><h4 id="Languages-section">Languages</h4></div></div>`;
    const html = `${shell(empty, 'Save and Continue')}<script>window.advances=0;document.getElementById('next').addEventListener('click',()=>window.advances++);</script>`;
    const page = await servedPage(browser, html);
    const snapshot = await inspectOperationalApplicationForm(page);
    assert.deepEqual(snapshot.workdayEmptySections.map((item) => item.label), ['Work Experience', 'Education', 'Languages']);
    let pausedLabels = [];
    const result = await prepareOperationalApplicationForm(page, profile({ cvText }), {}, {
      context, transitionTimeoutMs: 300, transitionStabilityMs: 0,
      awaitManualFields: async (labels) => { pausedLabels = labels; return false; },
    });
    assert.equal(await page.evaluate(() => window.advances), 0, 'empty sections never trigger Save and Continue');
    for (const section of ['Work Experience', 'Education', 'Languages']) {
      const label = `${section} has no entries (Workday did not parse the CV); add them or press Enter to continue`;
      assert.ok(pausedLabels.includes(label));
      assert.ok(result.evidence.unresolvedFields.some((item) => item.label === label));
    }
    await page.close();
  } finally {
    await browser.close();
  }
});

test('Workday Websites adds missing profile URLs through its own Add button exactly once', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const makePage = async (existing = []) => {
      const existingPanels = existing.map((url, index) => `<div role="group" aria-labelledby="website-${index + 1}-panel">
        <h4 id="website-${index + 1}-panel">Websites ${index + 1}</h4><input type="url" aria-label="URL" value="${url}"></div>`).join('');
      const websiteStep = `<div data-automation-id="applyFlowMyExperiencePage"><h2>My Experience</h2>
        <div><label for="given">First Name</label><input id="given" value="Alex"></div>
        <div><label for="family">Last Name</label><input id="family" value="Example"></div>
        <div><label for="email">Email Address</label><input id="email" type="email" value="alex@example.test"></div>
        <div role="group" aria-labelledby="Websites-section"><h4 id="Websites-section">Websites</h4><p>Add any relevant websites.</p>
          ${existingPanels}<button type="button" data-automation-id="add-button" id="website-add">Add</button></div>
        <div role="group" aria-labelledby="Languages-section"><h4 id="Languages-section">Languages</h4>
          <button type="button" data-automation-id="add-button" id="other-add">Add</button></div></div>`;
      const html = `${shell(websiteStep, 'Save and Continue')}<script>
        window.addClicks=0;window.otherAdds=0;window.submits=0;window.advances=0;
        document.getElementById('website-add').addEventListener('click',(event)=>{
          window.addClicks++;const button=event.target;const section=button.closest('[aria-labelledby="Websites-section"]');const n=section.querySelectorAll('[role="group"][aria-labelledby$="-panel"]').length+1;
          const panel=document.createElement('div');panel.setAttribute('role','group');panel.setAttribute('aria-labelledby','website-'+n+'-panel');
          panel.innerHTML='<h4 id="website-'+n+'-panel">Websites '+n+'</h4><input type="url" aria-label="URL">';section.insertBefore(panel,button);
        });
        document.getElementById('other-add').addEventListener('click',()=>window.otherAdds++);
        document.getElementById('next').addEventListener('click',()=>{window.advances++;});
      </script>`;
      return servedPage(browser, html);
    };
    const page = await makePage();
    const result = await prepareOperationalApplicationForm(page, profile(), {}, {
      context, transitionTimeoutMs: 500, transitionStabilityMs: 0,
    });
    assert.equal(await page.evaluate(() => window.addClicks), 2, 'LinkedIn and GitHub each use the Websites Add control once');
    assert.equal(await page.evaluate(() => window.otherAdds), 0, 'the Languages Add control is never used for websites');
    assert.deepEqual(await page.locator('[role="group"][aria-labelledby="Websites-section"] input[type="url"]').evaluateAll((items) => items.map((item) => item.value)), [
      'https://www.linkedin.com/in/alex-example', 'https://github.com/alex-example',
    ]);
    assert.equal(await page.evaluate(() => window.submits), 0);
    assert.equal(await page.evaluate(() => window.advances), 1, JSON.stringify({
      gate: result.gate, stepsAdvanced: result.evidence.progression?.stepsAdvanced,
      progressionActions: result.plan?.progressionActions?.map((item) => item.label),
      unresolved: result.evidence.unresolvedFields.map((item) => ({ label: item.label, reason: item.reason })),
    }));
    assert.equal(result.evidence.finalAction.activated, false);
    await page.close();

    const linkedin = 'https://www.linkedin.com/in/alex-example';
    const github = 'https://github.com/alex-example';
    const existing = await makePage([linkedin, github]);
    await prepareOperationalApplicationForm(existing, profile(), {}, {
      context, transitionTimeoutMs: 500, transitionStabilityMs: 0,
    });
    assert.equal(await existing.evaluate(() => window.addClicks), 0, 'already present URLs are not duplicated');
    assert.deepEqual(await existing.locator('[role="group"][aria-labelledby="Websites-section"] input[type="url"]').evaluateAll((items) => items.map((item) => item.value)), [linkedin, github]);
    await existing.close();
  } finally {
    await browser.close();
  }
});
