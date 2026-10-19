// Workday application steps, replicated from captured RELX/ASML pages (structure only, no personal data): no <form>,
// fields nested under applyFlowPage, a progress bar whose text glues the step name ("current step 2 of 6My
// Information"), footer buttons type="submit" driven by JavaScript, and a final Review whose Submit is the same
// footer button as Continue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  buildOperationalFormPlan,
  inspectOperationalApplicationForm,
  installSubmissionGuard,
  prepareOperationalApplicationForm,
} from '../application-form-engine.mjs';
import { classifyApplicationControl } from '../application-form-core.mjs';

const BASE = 'https://acme.wd3.myworkdayjobs.com/en-US/acme/job/Helsinki/Data-Engineer_R100001/apply/autofillWithResume';
const profile = {
  candidate: { full_name: 'Alex Example', email: 'alex@example.test', phone: '+358 40 123 4567', location: 'Example City, Finland' },
  location: { country: 'Finland', city: 'Example City' },
  currentStatus: {}, compensation: {}, education: {},
  formRules: { current_location: { city: 'Example City', country: 'Finland', combined: 'Example City, Finland' } },
  answers: new Map(), priorApprovedAnswers: [], cvText: '', articleDigestText: '', answerBankText: '', profileModeText: '',
};
const context = { batchId: 'workday-fixture', candidate: { candidate_id: `cand_v1_${'w'.repeat(64)}`, title: 'Data Engineer' }, jobCountry: 'Finland' };

function documents() {
  const dir = mkdtempSync(join(tmpdir(), 'roleforge-workday-'));
  const file = (name) => {
    const resolvedPath = join(dir, name);
    writeFileSync(resolvedPath, '%PDF fixture');
    return { resolvedPath, intendedFilename: name, sha256: `sha256:${name}` };
  };
  return { dir, value: { cv: file('Example_CV.pdf'), coverLetter: file('example_cover_letter.pdf') } };
}

const progress = (n, total, name) => `<ol data-automation-id="progressBar"><li data-automation-id="progressBarActiveStep"><div><label>current step ${n} of ${total}</label><label>${name}</label></div></li>${
  n < total ? `<li data-automation-id="progressBarInactiveStep"><div><label>step ${n + 1} of ${total}</label><label>Next step</label></div></li>` : ''}</ol>`;
const shell = (body, footer, bar = '') => `<div id="root"><div><div><div data-automation-id="applyFlowPage">
  <div id="progress">${bar}</div><div><div><div id="step">${body}</div></div>
  <div data-automation-id="pageFooter"><button type="submit" data-automation-id="pageFooterBackButton">Back</button>${footer}</div></div>
  </div></div></div></div>`;
const autofillStep = `<div data-automation-id="applyFlowAutoFillPage"><h2>Autofill with Resume</h2><p>Please Upload your resume for parsing</p>
  <div data-automation-id="formField-"><div><div><p>Upload either DOC, DOCX, HTML, PDF, or TXT file types (5MB max)</p>
  <div data-automation-id="resumeUpload"><div><div><input type="file" data-automation-id="file-upload-input-ref"><span id="picked"></span></div></div></div></div></div></div></div>`;
const infoStep = `<div data-automation-id="applyFlowMyInfoPage"><h2>My Information</h2>
  <div data-automation-id="formField-legalName--firstName"><label for="fn">First Name*</label><input id="fn" required></div>
  <div data-automation-id="formField-legalName--lastName"><label for="ln">Last Name*</label><input id="ln" required></div>
  <div data-automation-id="formField-email"><label for="em">Email Address*</label><input id="em" type="email" required></div></div>`;
const reviewStep = '<div data-automation-id="applyFlowReviewPage"><h2>Review</h2><p>Check your answers before submitting.</p></div>';

// A three-step Workday flow driven by the footer button, like the real SPA (no navigation, no <form>).
const flowPage = `${shell(autofillStep, '<button type="submit" id="next" data-automation-id="pageFooterNextButton">Continue</button>')}
<script>
  window.submits = 0; window.advances = 0; let step = 1;
  const steps = { 2: ${JSON.stringify(infoStep)}, 3: ${JSON.stringify(reviewStep)} };
  const render = () => {
    document.getElementById('progress').innerHTML = ${JSON.stringify(progress(1, 3, 'Autofill with Resume'))}
      .replace('current step 1 of 3', 'current step ' + step + ' of 3').replace('Autofill with Resume', ['', 'Autofill with Resume', 'My Information', 'Review'][step]);
    if (step === 3) { document.getElementById('progress').querySelector('[data-automation-id="progressBarInactiveStep"]')?.remove(); }
  };
  render();
  document.addEventListener('change', (e) => { if (e.target.type === 'file') document.getElementById('picked').textContent = e.target.files[0].name; });
  document.getElementById('next').addEventListener('click', () => {
    if (step === 3) { window.submits += 1; return; }
    if (step === 2 && ['fn', 'ln', 'em'].some((id) => !document.getElementById(id).value)) return;
    step += 1; window.advances += 1;
    document.getElementById('step').innerHTML = steps[step];
    document.getElementById('next').textContent = step === 3 ? 'Submit' : 'Save and Continue';
    render();
  });
</script>`;

async function servedPage(browser, html, url = BASE) {
  const page = await browser.newPage();
  await page.route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(url);
  return page;
}

test('Workday flow: CV on Autofill, fields on My Information, verified Continue, stop before Review Submit', async () => {
  const browser = await chromium.launch({ headless: true });
  const docs = documents();
  try {
    const page = await servedPage(browser, flowPage);
    const result = await prepareOperationalApplicationForm(page, profile, docs.value, {
      context, transitionTimeoutMs: 2_000, transitionStabilityMs: 0,
    });
    assert.equal(await page.evaluate(() => window.advances), 2, 'Autofill -> My Information -> Review');
    assert.ok(result.evidence.uploadedArtifacts.some((row) => row.sha256 === docs.value.cv.sha256), 'bound CV uploaded on Autofill');
    assert.match(await page.locator('#step').innerText(), /Review/);
    assert.equal(await page.evaluate(() => window.submits), 0, 'Review Submit never clicked');
    assert.equal(result.evidence.finalAction.activated, false);
    assert.equal(result.gate?.state, 'review_required');
    assert.ok(result.evidence.unresolvedFields.some((row) => row.manualUploadPath === docs.value.coverLetter.resolvedPath),
      'a cover letter the flow never asked for is handed off, not dropped');
    await page.close();
  } finally {
    await browser.close();
    rmSync(docs.dir, { recursive: true, force: true });
  }
});

test('a freshly loaded Workday Review page (no fields, no virtual form) cannot be submitted under the guard', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await servedPage(browser, `${shell(reviewStep,
      '<button type="submit" id="submit" data-automation-id="pageFooterNextButton" onclick="window.inline=(window.inline||0)+1">Submit</button>', progress(6, 6, 'Review'))}
      <script>window.submits = 0; document.getElementById('submit').addEventListener('click', () => { window.submits += 1; });</script>`,
    BASE.replace('autofillWithResume', 'review'));
    assert.equal(await page.locator('[data-career-ops-virtual-form]').count(), 0);
    // Control: without the guard the same click submits.
    await page.click('#submit');
    assert.equal(await page.evaluate(() => window.submits), 1);
    await page.evaluate(() => { window.submits = 0; window.inline = 0; });
    await installSubmissionGuard(page);
    await page.click('#submit').catch(() => null);
    await page.keyboard.press('Enter').catch(() => null);
    assert.equal(await page.evaluate(() => (window.submits || 0) + (window.inline || 0)), 0);
    const snapshot = await inspectOperationalApplicationForm(page);
    const submit = snapshot.controls.find((control) => /submit/i.test(control.label));
    assert.notEqual(classifyApplicationControl(submit), 'progression');
    await page.close();
  } finally {
    await browser.close();
  }
});

test('Workday upload fields: adds the missing cover letter, never replaces a different file, Back is never progression', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const experience = (input, listed) => shell(`<div data-automation-id="applyFlowMyExpPage"><h2>My Experience</h2>
      <div><h3>Resume (Required) and Cover Letter</h3><p>Please share the Resume and Cover Letter</p>
      <div data-automation-id="formField-"><div><p>Upload a file (5MB max)*</p><div data-automation-id="attachments-FileUpload"><div>${input}</div>
      ${listed ? `<div data-automation-id="file-upload-item"><span>${listed}</span> successfully uploaded</div>` : ''}</div></div></div></div></div>`,
    '<button type="submit" data-automation-id="pageFooterNextButton">Save and Continue</button>', progress(3, 6, 'My Experience'));
    const cv = { resolvedPath: 'C:/docs/Example_CV.pdf', intendedFilename: 'Example_CV.pdf', sha256: 'sha256:cv' };
    const cover = { resolvedPath: 'C:/docs/example_cover_letter.pdf', intendedFilename: 'example_cover_letter.pdf', sha256: 'sha256:cover' };

    const multi = await servedPage(browser, experience('<input type="file" multiple data-automation-id="file-upload-input-ref">', 'Example_CV.pdf'));
    const multiPlan = buildOperationalFormPlan(await inspectOperationalApplicationForm(multi), profile, { cv, coverLetter: cover }, { context });
    assert.deepEqual(multiPlan.actions.filter((a) => a.action === 'upload').map((a) => a.artifact.intendedFilename), ['example_cover_letter.pdf']);
    const snapshot = await inspectOperationalApplicationForm(multi);
    assert.equal(classifyApplicationControl(snapshot.controls.find((c) => c.label === 'Save and Continue')), 'progression');
    assert.equal(classifyApplicationControl(snapshot.controls.find((c) => c.label === 'Back')), 'ambiguous');
    await multi.close();

    const single = await servedPage(browser, `${shell(`<div><h3>Resume</h3><div data-automation-id="formField-"><div data-automation-id="resumeUpload">
      <input type="file" data-automation-id="file-upload-input-ref"></div><div><span>Other_Resume_2025.pdf</span> successfully uploaded</div></div>
      <label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required></div>`,
    '<button type="submit" data-automation-id="pageFooterNextButton">Save and Continue</button>', progress(3, 6, 'My Experience'))}`);
    const singlePlan = buildOperationalFormPlan(await inspectOperationalApplicationForm(single), profile, { cv, coverLetter: cover }, { context });
    assert.equal(singlePlan.actions.some((a) => a.action === 'upload'), false, 'a different CV is never overwritten');
    assert.ok(singlePlan.unresolvedFields.some((row) => /different file is already attached/i.test(row.reason) && row.manualUploadPath === cv.resolvedPath));
    await single.close();
  } finally {
    await browser.close();
  }
});

test('Workday steps with an unanswerable question or a validation error stop without clicking Continue', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const body of [
      `<div data-automation-id="formField-q1"><label for="q1">Describe a time you handled conflicting priorities*</label><textarea id="q1" required></textarea></div>
       <label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required>`,
      `<label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required>
       <label for="em">Email Address*</label><input id="em" type="email" aria-invalid="true" required><div role="alert">Error: Email Address is invalid</div>`,
    ]) {
      const page = await servedPage(browser, `${shell(body,
        '<button type="submit" id="next" data-automation-id="pageFooterNextButton">Save and Continue</button>', progress(4, 6, 'Application Questions'))}
        <script>window.advances = 0; document.getElementById('next').addEventListener('click', () => { window.advances += 1; });</script>`);
      const result = await prepareOperationalApplicationForm(page, profile, {}, { context, transitionTimeoutMs: 500, transitionStabilityMs: 0 });
      assert.equal(await page.evaluate(() => window.advances), 0);
      assert.equal(result.gate?.state, 'review_required');
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
