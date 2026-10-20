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

// Regression tests for the Sol High review findings (r261020-005650-cad8 review-01).
test('review P1s: unstructured step text, hidden/stale forms, Enter in a virtual field, held files, trigger fallback', async () => {
  const browser = await chromium.launch({ headless: true });
  const docs = documents();
  try {
    // 1. Step text that is not a structured step element never authorizes progression of a formless page.
    const loose = await servedPage(browser, `<div class="steps">Step 1 of 3</div><div id="app"><div>
      <label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required>
      <label for="em">Email*</label><input id="em" type="email" required></div>
      <button type="submit" id="next">Continue</button></div>
      <script>window.advances = 0; next.addEventListener('click', () => { window.advances += 1; });</script>`,
    'https://careers.example.test/apply/loose');
    const looseSnapshot = await inspectOperationalApplicationForm(loose);
    assert.notEqual(classifyApplicationControl(looseSnapshot.controls.find((c) => c.label === 'Continue')), 'progression');
    await prepareOperationalApplicationForm(loose, profile, {}, { context, transitionTimeoutMs: 300, transitionStabilityMs: 0 });
    assert.equal(await loose.evaluate(() => window.advances), 0);
    await loose.close();

    // 2. A hidden unrelated form and a stale virtual-form marker do not lift protection of a Workday final button.
    const review = await servedPage(browser, `<form style="display:none"><input name="q"></form>
      <div data-career-ops-virtual-form="1"><p>stale</p></div>${shell(reviewStep,
      '<button type="submit" id="submit" data-automation-id="pageFooterNextButton">Submit</button>', progress(6, 6, 'Review'))}
      <script>window.submits = 0; submit.addEventListener('click', () => { window.submits += 1; });</script>`,
    BASE.replace('autofillWithResume', 'review2'));
    await installSubmissionGuard(review);
    await review.click('#submit').catch(() => null);
    assert.equal(await review.evaluate(() => window.submits), 0);
    await review.close();

    // 3. Enter in a text field of a virtual application form never reaches the page's own submit handler.
    const enter = await servedPage(browser, `${shell(infoStep, '<button type="submit" data-automation-id="pageFooterNextButton">Save and Continue</button>', progress(2, 6, 'My Information'))}
      <script>window.submits = 0; document.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.submits += 1; });</script>`,
    BASE.replace('autofillWithResume', 'myinfo'));
    await inspectOperationalApplicationForm(enter);
    assert.equal(await enter.locator('[data-career-ops-virtual-form]').count(), 1);
    await installSubmissionGuard(enter);
    await enter.locator('#fn').press('Enter').catch(() => null);
    assert.equal(await enter.evaluate(() => window.submits), 0);
    await enter.close();

    // 4. An input already holding a different file is never overwritten, even when it accepts several files.
    const held = await servedPage(browser, shell(`<div><h3>Resume</h3><div data-automation-id="resumeUpload">
      <input type="file" multiple id="cvfile" data-automation-id="file-upload-input-ref"></div></div>
      <label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required>`,
    '<button type="submit" data-automation-id="pageFooterNextButton">Save and Continue</button>', progress(3, 6, 'My Experience')),
    BASE.replace('autofillWithResume', 'held'));
    await held.setInputFiles('#cvfile', { name: 'Other_Resume_2025.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF other') });
    const heldPlan = buildOperationalFormPlan(await inspectOperationalApplicationForm(held), profile, docs.value, { context });
    assert.equal(heldPlan.actions.some((a) => a.action === 'upload'), false);
    assert.ok(heldPlan.unresolvedFields.some((row) => /Other_Resume_2025\.pdf/.test(row.reason)));
    await held.close();

    // 5. A withheld document is not uploaded through a separate "Upload CV" trigger either.
    const trigger = await servedPage(browser, shell(`<div><h3>Resume</h3><div data-automation-id="resumeUpload">
      <input type="file" id="cvfile" data-automation-id="file-upload-input-ref"></div><div><span>Other_Resume_2025.pdf</span> successfully uploaded</div></div>
      <div><span>CV</span><button type="button" id="up" aria-label="Upload CV" onclick="document.getElementById('hidden').click()">+</button>
      <input type="file" id="hidden" hidden></div>
      <label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required>`,
    '<button type="submit" data-automation-id="pageFooterNextButton">Save and Continue</button>', progress(3, 6, 'My Experience')),
    BASE.replace('autofillWithResume', 'trigger'));
    const result = await prepareOperationalApplicationForm(trigger, profile, docs.value, { context, transitionTimeoutMs: 300, transitionStabilityMs: 0 });
    assert.equal(await trigger.evaluate(() => document.getElementById('hidden').files.length + document.getElementById('cvfile').files.length), 0);
    assert.equal(result.evidence.uploadedArtifacts.some((row) => row.sha256 === docs.value.cv.sha256), false);
    await trigger.close();
  } finally {
    await browser.close();
    rmSync(docs.dir, { recursive: true, force: true });
  }
});

test('review P2s: Workday Autofill counts as the reached form; an unrelated newsletter form does not hide the application', async () => {
  const { classifyFormSnapshot, collectPageSnapshot } = await import('../application-browser-executor.mjs');
  const browser = await chromium.launch({ headless: true });
  try {
    const autofill = await servedPage(browser, shell(autofillStep, '<button type="submit" data-automation-id="pageFooterNextButton">Continue</button>', progress(1, 6, 'Autofill with Resume')));
    assert.equal(classifyFormSnapshot(await collectPageSnapshot(autofill)).actualForm, true);
    await autofill.close();

    const newsletter = await servedPage(browser, `<form><label for="nl">Newsletter email</label><input id="nl" type="email"></form>
      ${shell(infoStep, '<button type="submit" data-automation-id="pageFooterNextButton">Save and Continue</button>', progress(2, 6, 'My Information'))}`,
    BASE.replace('autofillWithResume', 'newsletter'));
    const snapshot = await inspectOperationalApplicationForm(newsletter);
    assert.ok(snapshot.fields.filter((field) => field.applicationFormOwned).length >= 3);
    await newsletter.close();
  } finally {
    await browser.close();
  }
});

// Regression tests for the second Sol High review (r261020-005650-cad8 review-02).
test('review-02: a product-tour stepper never authorizes progression of a formless application', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const tour of [
      '<div class="tour"><span aria-current="step">Step 1 of 3</span><button type="button">Skip tour</button></div>',
      '<div role="dialog" aria-label="Welcome tour"><span aria-current="step">Step 1 of 3</span></div>',
    ]) {
      const page = await servedPage(browser, `<div id="wrapper">${tour}<div id="app"><div>
        <label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required>
        <label for="em">Email*</label><input id="em" type="email" required></div>
        <button type="button" id="next">Continue</button></div></div>
        <script>window.advances = 0; next.addEventListener('click', () => { window.advances += 1; });</script>`,
      'https://careers.example.test/apply/tour');
      const snapshot = await inspectOperationalApplicationForm(page);
      assert.equal(await page.locator('#wrapper[data-career-ops-virtual-form]').count(), 0, 'virtual form not expanded to the tour');
      assert.notEqual(classifyApplicationControl(snapshot.controls.find((c) => c.label === 'Continue')), 'progression');
      await prepareOperationalApplicationForm(page, profile, {}, { context, transitionTimeoutMs: 300, transitionStabilityMs: 0 });
      assert.equal(await page.evaluate(() => window.advances), 0);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('review-02: an unrelated newsletter form never lifts final-button protection on a structured review step', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const layout of ['footer', 'same-wrapper']) {
      const newsletter = '<form><label for="nl">Newsletter email</label><input id="nl" type="email"><button type="submit">Subscribe</button></form>';
      const page = await servedPage(browser, `<main><div id="page"><ol><li aria-current="step">Step 3 of 3: Review</li></ol>
        <section><h2>Review your application</h2></section>
        <button type="button" id="submit">Submit application</button>${layout === 'same-wrapper' ? newsletter : ''}</div></main>
        ${layout === 'footer' ? `<footer>${newsletter}</footer>` : ''}
        <script>window.submits = 0; submit.addEventListener('click', () => { window.submits += 1; });</script>`,
      `https://careers.example.test/apply/review-${layout}`);
      await installSubmissionGuard(page);
      await page.click('#submit').catch(() => null);
      assert.equal(await page.evaluate(() => window.submits), 0, layout);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('review-02: a trigger-opened dialog input already holding a different file is never replaced', async () => {
  const browser = await chromium.launch({ headless: true });
  const docs = documents();
  try {
    const page = await servedPage(browser, `<form><label for="fn">First name</label><input id="fn" required>
      <label for="ln">Last name</label><input id="ln" required><label for="em">Email</label><input id="em" type="email" required>
      <div><span>CV</span><button type="button" id="up" aria-label="Upload CV">+</button></div>
      <button type="button">Continue</button></form>
      <div id="dlg" role="dialog" aria-modal="true" style="display:none"><h3>Upload CV</h3><input type="file" id="dlgfile"></div>
      <script>up.addEventListener('click', () => { dlg.style.display = 'block'; });</script>`,
    'https://careers.example.test/apply/dialog');
    await page.setInputFiles('#dlgfile', { name: 'Other.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF other') });
    const { uploadThroughTrigger } = await import('../application-form-engine.mjs');
    const result = await uploadThroughTrigger(page, { semantic: 'cv_upload', artifact: docs.value.cv });
    assert.equal(result.status, 'withheld');
    assert.match(result.reason, /Other\.pdf/);
    assert.deepEqual(await page.evaluate(() => [...document.getElementById('dlgfile').files].map((file) => file.name)), ['Other.pdf']);
    await page.close();
  } finally {
    await browser.close();
    rmSync(docs.dir, { recursive: true, force: true });
  }
});

test('review-02: a header job-search form does not hide a formless application', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await servedPage(browser, `<header><form role="search"><input aria-label="Keyword"><input aria-label="Location">
      <select aria-label="Department"><option>All</option></select><button>Search</button></form></header>
      ${shell(infoStep, '<button type="submit" data-automation-id="pageFooterNextButton">Save and Continue</button>', progress(2, 6, 'My Information'))}`,
    BASE.replace('autofillWithResume', 'search'));
    const snapshot = await inspectOperationalApplicationForm(page);
    assert.equal(await page.locator('[data-career-ops-virtual-form]').count(), 1);
    assert.ok(snapshot.fields.filter((field) => field.applicationFormOwned).length >= 3);
    await page.close();
  } finally {
    await browser.close();
  }
});

// Regression tests for the third Sol High review (r261020-005650-cad8 review-03).
test('review-03: a tour with a Skip link never authorizes a submit-type Continue', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await servedPage(browser, `<div id="wrapper"><div class="tour"><span aria-current="step">Step 1 of 3</span>
      <a href="#skip">Skip tour</a></div><div id="app"><div>
      <label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required>
      <label for="em">Email*</label><input id="em" type="email" required></div>
      <button type="submit" id="next">Continue</button></div></div>
      <script>window.advances = 0; next.addEventListener('click', () => { window.advances += 1; });</script>`,
    'https://careers.example.test/apply/tour-link');
    const snapshot = await inspectOperationalApplicationForm(page);
    assert.equal(await page.locator('#wrapper[data-career-ops-virtual-form]').count(), 0);
    assert.notEqual(classifyApplicationControl(snapshot.controls.find((c) => c.label === 'Continue')), 'progression');
    await prepareOperationalApplicationForm(page, profile, {}, { context, transitionTimeoutMs: 300, transitionStabilityMs: 0 });
    assert.equal(await page.evaluate(() => window.advances), 0);
    await page.close();
  } finally {
    await browser.close();
  }
});

test('review-03: final Submit stays blocked beside an interactive stepper or a sibling form with its own Continue', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const layouts = {
      'interactive-stepper': `<div id="page"><nav><button type="button">Back to step 2</button><span aria-current="step">Step 3 of 3: Review</span></nav>
        <section><h2>Review your application</h2></section><button type="button" id="submit">Submit application</button></div>`,
      'sibling-account-form': `<div id="page"><ol><li aria-current="step">Step 3 of 3: Review</li></ol>
        <section><h2>Review your application</h2></section><button type="button" id="submit">Submit application</button>
        <form><label for="ae">Account email</label><input id="ae" type="email"><button type="button">Continue</button></form></div>`,
    };
    for (const [name, html] of Object.entries(layouts)) {
      const page = await servedPage(browser, `<main>${html}</main>
        <script>window.submits = 0; submit.addEventListener('click', () => { window.submits += 1; });</script>`,
      `https://careers.example.test/apply/${name}`);
      await installSubmissionGuard(page);
      await page.click('#submit').catch(() => null);
      assert.equal(await page.evaluate(() => window.submits), 0, name);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('review-03: a held file whose name merely ends with the bound filename is never replaced', async () => {
  const browser = await chromium.launch({ headless: true });
  const docs = documents();
  try {
    const page = await servedPage(browser, `<form><label for="fn">First name</label><input id="fn" required>
      <label for="ln">Last name</label><input id="ln" required><label for="em">Email</label><input id="em" type="email" required>
      <div><span>CV</span><button type="button" id="up" aria-label="Upload CV">+</button></div>
      <button type="button">Continue</button></form>
      <div id="dlg" role="dialog" aria-modal="true" style="display:none"><h3>Upload CV</h3><input type="file" id="dlgfile"></div>
      <script>up.addEventListener('click', () => { dlg.style.display = 'block'; });</script>`,
    'https://careers.example.test/apply/suffix');
    await page.setInputFiles('#dlgfile', { name: 'Old Example_CV.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF old') });
    const { uploadThroughTrigger } = await import('../application-form-engine.mjs');
    const result = await uploadThroughTrigger(page, { semantic: 'cv_upload', artifact: docs.value.cv });
    assert.equal(result.status, 'withheld');
    assert.deepEqual(await page.evaluate(() => [...document.getElementById('dlgfile').files].map((file) => file.name)), ['Old Example_CV.pdf']);
    await page.close();
  } finally {
    await browser.close();
    rmSync(docs.dir, { recursive: true, force: true });
  }
});

// Regression tests for the fourth Sol High review (r261020-005650-cad8 review-04).
test('review-04: a tour step inside a virtual application container never authorizes progression', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await servedPage(browser, `<div id="app"><div class="tour"><span aria-current="step">Step 1 of 3</span></div><div>
      <label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required>
      <label for="em">Email*</label><input id="em" type="email" required><label for="li">LinkedIn profile</label><input id="li"></div>
      <button type="submit" id="next">Continue</button></div>
      <script>window.advances = 0; next.addEventListener('click', () => { window.advances += 1; });</script>`,
    'https://careers.example.test/apply/tour-inside');
    const snapshot = await inspectOperationalApplicationForm(page);
    assert.notEqual(classifyApplicationControl(snapshot.controls.find((c) => c.label === 'Continue')), 'progression');
    await prepareOperationalApplicationForm(page, profile, {}, { context, transitionTimeoutMs: 300, transitionStabilityMs: 0 });
    assert.equal(await page.evaluate(() => window.advances), 0);
    await page.close();
  } finally {
    await browser.close();
  }
});

test('review-04: a sibling email form never owns a review section holding the stepper and Submit', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await servedPage(browser, `<main><div id="page">
      <form><label for="ae">Email</label><input id="ae" type="email"><button type="button">Continue</button></form>
      <section><ol><li aria-current="step">Step 3 of 3: Review</li></ol><h2>Review your application</h2>
      <button type="button" id="submit">Submit application</button></section></div></main>
      <script>window.submits = 0; submit.addEventListener('click', () => { window.submits += 1; });</script>`,
    'https://careers.example.test/apply/two-children');
    await installSubmissionGuard(page);
    await page.click('#submit').catch(() => null);
    assert.equal(await page.evaluate(() => window.submits), 0);
    await page.close();
  } finally {
    await browser.close();
  }
});

test('review-04: a listed non-ASCII file name is never mistaken for the bound file', async () => {
  const browser = await chromium.launch({ headless: true });
  const docs = documents();
  try {
    const html = shell(`<div><h3>Resume</h3><div data-automation-id="resumeUpload">
      <input type="file" id="cvfile" data-automation-id="file-upload-input-ref"></div><div><span>José Example_CV.pdf</span> uploaded</div></div>
      <label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required>`,
    '<button type="submit" data-automation-id="pageFooterNextButton">Save and Continue</button>', progress(3, 6, 'My Experience'));
    const page = await servedPage(browser, html, BASE.replace('autofillWithResume', 'unicode'));
    const plan = buildOperationalFormPlan(await inspectOperationalApplicationForm(page), profile, docs.value, { context });
    assert.equal(plan.actions.some((a) => a.action === 'upload'), false);
    assert.ok(plan.unresolvedFields.some((row) => row.manualUploadPath === docs.value.cv.resolvedPath));
    await page.close();

    const dialog = await servedPage(browser, `<form><label for="fn">First name</label><input id="fn" required>
      <label for="ln">Last name</label><input id="ln" required><label for="em">Email</label><input id="em" type="email" required>
      <div><span>CV</span><button type="button" id="up" aria-label="Upload CV">+</button></div>
      <button type="button">Continue</button></form>
      <div id="dlg" role="dialog" aria-modal="true" style="display:none"><h3>Upload CV</h3>
      <div><input type="file" id="dlgfile"><span>José Example_CV.pdf</span></div></div>
      <script>up.addEventListener('click', () => { dlg.style.display = 'block'; });</script>`,
    'https://careers.example.test/apply/unicode-dialog');
    const { uploadThroughTrigger } = await import('../application-form-engine.mjs');
    const result = await uploadThroughTrigger(dialog, { semantic: 'cv_upload', artifact: docs.value.cv });
    assert.equal(result.status, 'withheld');
    assert.equal(await dialog.evaluate(() => document.getElementById('dlgfile').files.length), 0);
    await dialog.close();
  } finally {
    await browser.close();
    rmSync(docs.dir, { recursive: true, force: true });
  }
});

// Regression tests for the fifth Sol High review (r261020-005650-cad8 review-05).
test('review-05: a stepper inside a form never releases a final button rendered outside it', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const container of ['<div data-career-ops-virtual-form="1">', '<form>']) {
      const close = container.startsWith('<form') ? '</form>' : '</div>';
      const page = await servedPage(browser, `<main>${container}<ol><li aria-current="step">Step 3 of 3: Review</li></ol>
        <label for="ro">Email</label><input id="ro" readonly value="alex@example.test">${close}
        <button type="button" id="submit">Submit application</button></main>
        <script>window.submits = 0; submit.addEventListener('click', () => { window.submits += 1; });</script>`,
      `https://careers.example.test/apply/outside-${close.length}`);
      await installSubmissionGuard(page);
      await page.click('#submit').catch(() => null);
      assert.equal(await page.evaluate(() => window.submits), 0, container);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('review-05: a listed name that only starts with the bound filename is a different file', async () => {
  const browser = await chromium.launch({ headless: true });
  const docs = documents();
  try {
    const page = await servedPage(browser, shell(`<div><h3>Resume</h3><div data-automation-id="resumeUpload">
      <input type="file" id="cvfile" data-automation-id="file-upload-input-ref"></div><div><span>Example_CV.pdf old.pdf</span></div></div>
      <label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required>`,
    '<button type="submit" data-automation-id="pageFooterNextButton">Save and Continue</button>', progress(3, 6, 'My Experience')),
    BASE.replace('autofillWithResume', 'prefix'));
    const plan = buildOperationalFormPlan(await inspectOperationalApplicationForm(page), profile, docs.value, { context });
    assert.equal(plan.actions.some((a) => a.action === 'upload'), false);
    assert.equal(plan.actions.some((a) => a.preserved && a.semantic === 'cv_upload'), false);
    assert.ok(plan.unresolvedFields.some((row) => row.manualUploadPath === docs.value.cv.resolvedPath));
    await page.close();

    const dialog = await servedPage(browser, `<form><label for="fn">First name</label><input id="fn" required>
      <label for="ln">Last name</label><input id="ln" required><label for="em">Email</label><input id="em" type="email" required>
      <div><span>CV</span><button type="button" id="up" aria-label="Upload CV">+</button></div>
      <button type="button">Continue</button></form>
      <div id="dlg" role="dialog" aria-modal="true" style="display:none"><h3>Upload CV</h3>
      <div><input type="file" id="dlgfile"><span>Example_CV.pdf old.pdf</span></div></div>
      <script>up.addEventListener('click', () => { dlg.style.display = 'block'; });</script>`,
    'https://careers.example.test/apply/prefix-dialog');
    const { uploadThroughTrigger } = await import('../application-form-engine.mjs');
    const result = await uploadThroughTrigger(dialog, { semantic: 'cv_upload', artifact: docs.value.cv });
    assert.equal(result.status, 'withheld');
    assert.equal(await dialog.evaluate(() => document.getElementById('dlgfile').files.length), 0);
    await dialog.close();
  } finally {
    await browser.close();
    rmSync(docs.dir, { recursive: true, force: true });
  }
});

// Regression tests for the final Sol High review (r261020-005650-cad8 review-06).
test('review-06: a final button inside an explicit wizard stays blocked beside its form', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await servedPage(browser, `<div data-career-ops-wizard><p data-career-ops-step="2" data-career-ops-total-steps="2">Step 2 of 2: Review</p>
      <form><label for="em">Email</label><input id="em" type="email"><button type="button">Continue</button></form>
      <button type="button" id="submit">Submit application</button></div>
      <script>window.submits = 0; submit.addEventListener('click', () => { window.submits += 1; });</script>`,
    'https://careers.example.test/apply/wizard-sibling');
    await installSubmissionGuard(page);
    await page.click('#submit').catch(() => null);
    assert.equal(await page.evaluate(() => window.submits), 0);
    await page.close();
  } finally {
    await browser.close();
  }
});

test('review-06: an existing HTML or extensionless Workday attachment is never replaced; type hints are not files', async () => {
  const browser = await chromium.launch({ headless: true });
  const docs = documents();
  try {
    for (const listed of ['<span>Old_Resume.html</span>', '<div data-automation-id="file-upload-item-name">Old resume</div>']) {
      const page = await servedPage(browser, shell(`<div><h3>Resume</h3><div data-automation-id="resumeUpload">
        <input type="file" id="cvfile" data-automation-id="file-upload-input-ref"></div><div>${listed}</div></div>
        <label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required>`,
      '<button type="submit" data-automation-id="pageFooterNextButton">Save and Continue</button>', progress(3, 6, 'My Experience')),
      BASE.replace('autofillWithResume', `listed-${listed.length}`));
      const plan = buildOperationalFormPlan(await inspectOperationalApplicationForm(page), profile, docs.value, { context });
      assert.equal(plan.actions.some((a) => a.action === 'upload'), false, listed);
      assert.ok(plan.unresolvedFields.some((row) => row.manualUploadPath === docs.value.cv.resolvedPath), listed);
      await page.close();
    }
    const hint = await servedPage(browser, shell(`<div><h3>Resume</h3><p>Accepted file types: .pdf, .docx, .html (5MB max)</p>
      <div data-automation-id="resumeUpload"><input type="file" id="cvfile" data-automation-id="file-upload-input-ref"></div></div>
      <label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required>`,
    '<button type="submit" data-automation-id="pageFooterNextButton">Save and Continue</button>', progress(3, 6, 'My Experience')),
    BASE.replace('autofillWithResume', 'hint'));
    const hintPlan = buildOperationalFormPlan(await inspectOperationalApplicationForm(hint), profile, docs.value, { context });
    assert.ok(hintPlan.actions.some((a) => a.action === 'upload' && a.artifact.resolvedPath === docs.value.cv.resolvedPath));
    await hint.close();
  } finally {
    await browser.close();
    rmSync(docs.dir, { recursive: true, force: true });
  }
});

// Regression test for review-07: plain step text keeps blocking final buttons on a form-less page.
test('review-07: plain "Step 3 of 3" text on a form-less page keeps the final button blocked', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await servedPage(browser, `<p>Step 3 of 3: Review</p>
      <button type="button" id="submit" onclick="window.submits++">Submit application</button>
      <script>window.submits = 0;</script>`, 'https://careers.example.test/apply/text-step');
    await installSubmissionGuard(page);
    await page.click('#submit').catch(() => null);
    await page.focus('#submit').catch(() => null);
    await page.keyboard.press('Enter').catch(() => null);
    assert.equal(await page.evaluate(() => window.submits), 0);
    await page.close();
  } finally {
    await browser.close();
  }
});

// Regression test for review-08: a direct upload re-checks the input right before setting files.
test('review-08: a file that appears after planning is never replaced by a direct upload', async () => {
  const browser = await chromium.launch({ headless: true });
  const docs = documents();
  try {
    const page = await servedPage(browser, `<form><label for="fn">First name</label><input id="fn" required>
      <label for="ln">Last name</label><input id="ln" required><label for="em">Email</label><input id="em" type="email" required>
      <label for="cv">Resume / CV</label><input type="file" id="cv"><button type="submit">Submit application</button></form>
      <script>
        // An earlier field's change handler restores a saved attachment into the (still empty at planning) CV input.
        fn.addEventListener('input', () => {
          const data = new DataTransfer(); data.items.add(new File(['%PDF old'], 'Other_Resume.pdf', { type: 'application/pdf' }));
          document.getElementById('cv').files = data.files;
        });
      </script>`, 'https://careers.example.test/apply/late-file');
    const result = await prepareOperationalApplicationForm(page, profile, docs.value, { context, transitionTimeoutMs: 300, transitionStabilityMs: 0 });
    assert.deepEqual(await page.evaluate(() => [...document.getElementById('cv').files].map((file) => file.name)), ['Other_Resume.pdf']);
    assert.equal(result.evidence.uploadedArtifacts.some((row) => row.sha256 === docs.value.cv.sha256), false);
    assert.ok(result.evidence.unresolvedFields.some((row) => row.manualUploadPath === docs.value.cv.resolvedPath
      && /Other_Resume\.pdf/.test(row.reason)));
    await page.close();
  } finally {
    await browser.close();
    rmSync(docs.dir, { recursive: true, force: true });
  }
});

// Regression tests for review-09: punctuation in listed names, and names in a container shared by several inputs.
test('review-09: "Resume++.pdf" beside an empty single-file input is an existing attachment', async () => {
  const browser = await chromium.launch({ headless: true });
  const docs = documents();
  try {
    const page = await servedPage(browser, shell(`<div><h3>Resume</h3><div data-automation-id="resumeUpload">
      <input type="file" id="cvfile" data-automation-id="file-upload-input-ref"></div><div><span>Resume++.pdf</span></div></div>
      <label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required>`,
    '<button type="submit" data-automation-id="pageFooterNextButton">Save and Continue</button>', progress(3, 6, 'My Experience')),
    BASE.replace('autofillWithResume', 'punct'));
    const plan = buildOperationalFormPlan(await inspectOperationalApplicationForm(page), profile, docs.value, { context });
    assert.equal(plan.actions.some((a) => a.action === 'upload'), false);
    assert.ok(plan.unresolvedFields.some((row) => row.manualUploadPath === docs.value.cv.resolvedPath));
    await page.close();
  } finally {
    await browser.close();
    rmSync(docs.dir, { recursive: true, force: true });
  }
});

test('review-09: a name listed in a container shared by several inputs withholds uploads; a name in a sibling\'s own area does not', async () => {
  const browser = await chromium.launch({ headless: true });
  const docs = documents();
  try {
    const shared = await servedPage(browser, `<form><label for="fn">First name</label><input id="fn" required>
      <label for="ln">Last name</label><input id="ln" required><label for="em">Email</label><input id="em" type="email" required>
      <label for="cv">Resume</label><input type="file" id="cv"><span>Other_CV.pdf</span>
      <label for="cl">Cover Letter</label><input type="file" id="cl">
      <button type="submit">Submit application</button></form>`, 'https://careers.example.test/apply/shared');
    const sharedPlan = buildOperationalFormPlan(await inspectOperationalApplicationForm(shared), profile, docs.value, { context });
    assert.equal(sharedPlan.actions.some((a) => a.action === 'upload' && a.semantic === 'cv_upload'), false);
    assert.ok(sharedPlan.unresolvedFields.some((row) => row.manualUploadPath === docs.value.cv.resolvedPath));
    await shared.close();

    const owned = await servedPage(browser, `<form><label for="fn">First name</label><input id="fn" required>
      <label for="ln">Last name</label><input id="ln" required><label for="em">Email</label><input id="em" type="email" required>
      <div><label for="cv">Resume</label><input type="file" id="cv"></div>
      <div><label for="cl">Cover Letter</label><input type="file" id="cl"><span>Other_letter.pdf</span></div>
      <button type="submit">Submit application</button></form>`, 'https://careers.example.test/apply/owned');
    const ownedPlan = buildOperationalFormPlan(await inspectOperationalApplicationForm(owned), profile, docs.value, { context });
    assert.ok(ownedPlan.actions.some((a) => a.action === 'upload' && a.artifact.resolvedPath === docs.value.cv.resolvedPath), 'CV slot is free');
    assert.equal(ownedPlan.actions.some((a) => a.action === 'upload' && a.artifact.resolvedPath === docs.value.coverLetter.resolvedPath), false);
    await owned.close();
  } finally {
    await browser.close();
    rmSync(docs.dir, { recursive: true, force: true });
  }
});

// Regression test for review-10: a listed file name split across elements is still an existing attachment.
test('review-10: "<span>Other_Resume</span><span>.pdf</span>" beside an empty input withholds the upload', async () => {
  const browser = await chromium.launch({ headless: true });
  const docs = documents();
  try {
    const page = await servedPage(browser, shell(`<div><h3>Resume</h3><div data-automation-id="resumeUpload">
      <input type="file" id="cvfile" data-automation-id="file-upload-input-ref"></div><div><span>Other_Resume</span><span>.pdf</span></div></div>
      <label for="fn">First Name*</label><input id="fn" required><label for="ln">Last Name*</label><input id="ln" required>`,
    '<button type="submit" data-automation-id="pageFooterNextButton">Save and Continue</button>', progress(3, 6, 'My Experience')),
    BASE.replace('autofillWithResume', 'split'));
    const plan = buildOperationalFormPlan(await inspectOperationalApplicationForm(page), profile, docs.value, { context });
    assert.equal(plan.actions.some((a) => a.action === 'upload'), false);
    assert.ok(plan.unresolvedFields.some((row) => row.manualUploadPath === docs.value.cv.resolvedPath));
    await page.close();
  } finally {
    await browser.close();
    rmSync(docs.dir, { recursive: true, force: true });
  }
});
