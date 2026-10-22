import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  buildOperationalFormPlan,
  inspectOperationalApplicationForm,
  prepareOperationalApplicationForm,
} from '../application-form-engine.mjs';

const BASE = 'https://acme.wd3.myworkdayjobs.com/en-US/acme/job/Helsinki/Engineer_R100001/apply/test';
const candidateContext = { batchId: 'followups', candidate: { candidate_id: `cand_v1_${'f'.repeat(64)}`, title: 'Engineer' } };
const profile = {
  candidate: { full_name: 'Alex Example', email: 'alex@example.test' },
  location: { country: 'Finland', city: 'Helsinki' },
  currentStatus: {}, compensation: {}, education: {}, formRules: {},
  answers: new Map(), priorApprovedAnswers: [],
  cvText: '## Technical Skills\nPython, SQL, Familiar with Rust\nKubernetes\nBasic: C++\n## Education\n',
};

const progress = (step, total, label) => `<ol data-automation-id="progressBar"><li data-automation-id="progressBarActiveStep"><div><label>current step ${step} of ${total}</label><label>${label}</label></div></li></ol>`;
const shell = (content, label, total = 2) => `<div data-automation-id="applyFlowPage">
  ${progress(1, total, label)}<div id="step">${content}</div>
  <div data-automation-id="pageFooter"><button type="submit" id="next" data-automation-id="pageFooterNextButton">Save and Continue</button></div>
  </div>`;

async function servedPage(browser, html) {
  const page = await browser.newPage();
  await page.route(BASE, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(BASE);
  return page;
}

test('field outcomes are logged and a step snapshot is saved before its progression click', async () => {
  const browser = await chromium.launch({ headless: true });
  const outputDir = mkdtempSync(join(tmpdir(), 'roleforge-step-snapshot-'));
  const snapshotPath = join(outputDir, 'my-information.html');
  const logs = [];
  const fields = `<h2>My Information</h2>
    <label for="first">First Name*</label><input id="first" required>
    <label for="portfolio">Portfolio URL</label><input id="portfolio" value="https://example.test">
    <label for="nickname">Optional nickname</label><input id="nickname">
    <label for="specialty">Favorite specialty*</label><input id="specialty" required>`;
  const html = `${shell(fields, 'My Information')}
    <script>window.snapshotReady = false; window.advanced = 0;
      document.getElementById('next').addEventListener('click', () => {
        if (!window.snapshotReady) throw new Error('progressed before the snapshot callback');
        window.advanced += 1;
        document.getElementById('step').innerHTML = '<h2>Review</h2>';
        document.getElementById('next').textContent = 'Submit';
        document.querySelector('[data-automation-id="progressBarActiveStep"] label:last-child').textContent = 'Review';
      });</script>`;
  try {
    const page = await servedPage(browser, html);
    const inspected = await inspectOperationalApplicationForm(page);
    assert.ok(inspected.applicationFormId, JSON.stringify({
      fields: inspected.fields.map(({ label, formId, visible }) => ({ label, formId, visible })),
      controls: inspected.controls.map(({ label, formId, workflowVerified, stepIndicator }) => ({ label, formId, workflowVerified, stepIndicator })),
    }));
    await prepareOperationalApplicationForm(page, profile, {}, {
      context: candidateContext,
      progressLog: (line) => logs.push(line),
      transitionTimeoutMs: 1_000,
      transitionStabilityMs: 0,
      awaitManualFields: async (labels) => {
        if (!labels.some((label) => /Favorite specialty/.test(label))) return false;
        await page.locator('#specialty').fill('Human choice');
        return true;
      },
      onBeforeProgression: async (activePage, stepLabel) => {
        assert.equal(stepLabel, 'My Information');
        assert.equal(await activePage.locator('#specialty').inputValue(), 'Human choice');
        writeFileSync(snapshotPath, await activePage.content());
        await activePage.evaluate(() => { window.snapshotReady = true; });
      },
    });
    assert.ok(logs.some((line) => /\[field\] My Information \| First Name\*? \| filled: Alex/.test(line)), logs.join('\n'));
    assert.ok(logs.some((line) => /\[field\] My Information \| Portfolio URL \| kept: https:\/\/example\.test/.test(line)), logs.join('\n'));
    assert.ok(logs.some((line) => /\[field\] My Information \| Optional nickname \| skipped:/.test(line)), logs.join('\n'));
    assert.ok(logs.some((line) => /\[field\] My Information \| Favorite specialty\*? \| manual:/.test(line)), logs.join('\n'));
    assert.ok(existsSync(snapshotPath));
    assert.match(readFileSync(snapshotPath, 'utf8'), /id="specialty"/);
    assert.equal(await page.evaluate(() => window.advanced), 1);
    await page.close();
  } finally {
    await browser.close();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('consent-only Workday step hands off one item, then advances with Save and Continue and never Submit', async () => {
  const browser = await chromium.launch({ headless: true });
  const checkbox = `<h2>Voluntary Disclosures</h2><label for="terms">Yes, I have read and consent to the terms and conditions *</label>
    <input id="terms" type="checkbox" required>`;
  const html = `${shell(checkbox, 'Voluntary Disclosures')}
    <script>window.advanced = 0; window.submitted = 0;
      document.getElementById('next').addEventListener('click', () => {
        if (document.getElementById('next').textContent === 'Submit') { window.submitted += 1; return; }
        if (!document.getElementById('terms').checked) return;
        window.advanced += 1;
        window.termsCheckedAtProgression = document.getElementById('terms').checked;
        document.getElementById('step').innerHTML = '<h2>Review</h2>';
        document.getElementById('next').textContent = 'Submit';
        document.querySelector('[data-automation-id="progressBarActiveStep"] label:last-child').textContent = 'Review';
      });</script>`;
  try {
    const page = await servedPage(browser, html);
    const initial = await inspectOperationalApplicationForm(page);
    assert.ok(initial.applicationFormId, 'a single legal checkbox in a verified Workday step owns a virtual form');
    const handoffs = [];
    const result = await prepareOperationalApplicationForm(page, profile, {}, {
      context: candidateContext,
      transitionTimeoutMs: 1_000,
      transitionStabilityMs: 0,
      awaitManualFields: async (labels) => {
        if (!labels.some((label) => /^Consent:/.test(label))) return false;
        handoffs.push(labels);
        await page.locator('#terms').check();
        return true;
      },
    });
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].length, 1, JSON.stringify(handoffs));
    assert.match(handoffs[0][0], /^Consent: Yes, I have read and consent to the terms and conditions/);
    assert.match(handoffs[0][0], /this is yours to tick; then press Enter \(RoleForge clicks Save and Continue\) or finish yourself$/);
    assert.ok(!result.evidence.unresolvedFields.some((row) => row.label === 'Application form'));
    assert.equal(await page.evaluate(() => window.advanced), 1);
    assert.equal(await page.evaluate(() => window.submitted), 0);
    assert.equal(await page.evaluate(() => window.termsCheckedAtProgression), true);
    await page.close();
  } finally {
    await browser.close();
  }
});

test('Workday Skills adds exact CV options, keeps existing chips, skips misses, and never blocks progression', async () => {
  const browser = await chromium.launch({ headless: true });
  const skills = `<h2>My Experience</h2><div role="group" aria-labelledby="Skills-section">
    <h3 id="Skills-section">Skills</h3><label for="skills">Type to Add Skills</label>
    <div data-automation-id="multiSelectContainer"><ul id="chips">
      <li><div data-automation-id="selectedItem">Excel</div></li></ul>
      <input id="skills" placeholder="Type to Add Skills" data-uxi-widget-type="selectinput" aria-required="true">
      <div id="options"></div></div></div>`;
  const html = `${shell(skills, 'My Experience')}
    <script>
      window.advanced = 0; const input = document.getElementById('skills'); const options = document.getElementById('options');
      const matches = { Python: ['python'], SQL: ['SQL Server'], Kubernetes: ['Kubernetes (Basic)'] };
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        const query = input.value.trim();
        options.innerHTML = (matches[query] || []).map((name) => '<div role="option" data-automation-id="promptOption">' + name + '</div>').join('');
      });
      options.addEventListener('click', (event) => {
        if (!event.target.matches('[role="option"]')) return;
        const row = document.createElement('li'); row.innerHTML = '<div data-automation-id="selectedItem">' + event.target.textContent + '</div>';
        document.getElementById('chips').append(row); options.innerHTML = ''; input.value = '';
      });
      document.getElementById('next').addEventListener('click', () => {
        window.advanced += 1;
        window.chipsAtProgression = [...document.querySelectorAll('[data-automation-id="selectedItem"]')].map((chip) => chip.textContent.trim());
        document.getElementById('step').innerHTML = '<h2>Review</h2>';
        document.getElementById('next').textContent = 'Submit';
        document.querySelector('[data-automation-id="progressBarActiveStep"] label:last-child').textContent = 'Review';
      });
    </script>`;
  try {
    const page = await servedPage(browser, html);
    const snapshot = await inspectOperationalApplicationForm(page);
    const field = snapshot.fields.find((item) => item.id === 'skills');
    assert.equal(field.workdayGroupLabelledBy, 'Skills-section');
    const plan = buildOperationalFormPlan(snapshot, profile, {}, { context: candidateContext });
    assert.deepEqual(plan.actions.map((action) => action.value), ['Python', 'SQL', 'Kubernetes']);
    assert.equal(plan.actions.every((action) => action.pickKind === 'skill'), true);
    assert.equal(plan.unresolvedFields.length, 0);
    const logs = [];
    const result = await prepareOperationalApplicationForm(page, profile, {}, {
      context: candidateContext,
      progressLog: (line) => logs.push(line),
      transitionTimeoutMs: 1_000,
      transitionStabilityMs: 0,
    });
    assert.deepEqual(await page.evaluate(() => window.chipsAtProgression), ['Excel', 'python']);
    const skillLog = logs.find((line) => line.startsWith('[field] My Experience | Type to Add Skills |'));
    assert.match(skillLog || '', /filled: Python/);
    assert.match(skillLog || '', /skipped: no exact option/);
    assert.ok(!result.evidence.unresolvedFields.some((row) => row.fieldId === field.fieldId));
    assert.equal(await page.evaluate(() => window.advanced), 1, 'an exact-option miss cannot block progression');
    await page.close();
  } finally {
    await browser.close();
  }
});
