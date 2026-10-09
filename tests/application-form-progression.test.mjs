import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  activateProgressionControl,
  buildOperationalFormPlan,
  executeOperationalFormPlan,
  grantProgressionPermit,
  inspectOperationalApplicationForm,
  inspectOperationalUploadTopology,
  MAX_PROGRESSION_TRANSITIONS,
  prepareOperationalApplicationForm,
  removeOperationalSubmissionGuard,
} from '../application-form-engine.mjs';
import { applicationFormStateFingerprint, classifyApplicationControl } from '../application-form-core.mjs';
import { verifyApplicationContinuity } from '../application-browser-executor.mjs';
import { attachFactualSources } from './fixtures/application-evidence-profile.mjs';
import { multiStepApplicationFixture } from './fixtures/application-form-fixtures.mjs';

const profile = attachFactualSources({
  candidate: {
    full_name: 'Alex Example', email: 'alex@example.test', phone: '+358 40 123 4567',
    location: 'Example City, Finland', linkedin: 'https://linkedin.test/alex', github: 'https://github.test/alex',
  },
  location: { country: 'Finland', city: 'Example City' },
  currentStatus: { availability: { start: 'Available immediately' } },
  compensation: { target_range: 'EUR 50,000-55,000/year' },
  education: { expected_graduation_date: '31/12/2030' },
  formRules: { source: { value: 'LinkedIn' }, current_location: { city: 'Example City', country: 'Finland', combined: 'Example City, Finland' }, work_authorization: { home_country: 'Finland' }, narrative_evidence: [] },
  answers: new Map(), priorApprovedAnswers: [], cvText: 'Synthetic fixture CV evidence.', articleDigestText: '', answerBankText: '', profileModeText: '',
});
const context = { batchId: 'fixture-batch', candidate: { candidate_id: `cand_v1_${'a'.repeat(64)}` }, jobCountry: 'Finland', jdText: '' };
const narrativeCvText = 'In the fictional Warehouse project, I built validated Python and SQL data pipelines.';
const narrativeProfile = attachFactualSources({
  ...profile,
  cvText: narrativeCvText,
  formRules: {
    ...profile.formRules,
    narrative_evidence: [{
      id: 'warehouse-proof',
      topics: ['data_engineering', 'python_sql'],
      provenance: [{ sourceType: 'cv', locator: 'lines:1' }],
    }],
  },
}, { cvText: narrativeCvText });

function artifacts() {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-progression-'));
  const cv = join(dir, 'CV.pdf');
  const cover = join(dir, 'Cover.pdf');
  writeFileSync(cv, '%PDF fixture');
  writeFileSync(cover, '%PDF fixture');
  return { dir, value: { cv: { resolvedPath: cv, intendedFilename: 'CV.pdf', sha256: 'sha256:cv' }, coverLetter: { resolvedPath: cover, intendedFilename: 'Cover.pdf', sha256: 'sha256:cover' } } };
}

test('three-way classifier separates progression, final, and ambiguous controls', () => {
  const workflow = { insideApplicationForm: true, candidateFieldCount: 1, workflowVerified: true, hasRemainingStep: true, stepIndicator: { current: 1, total: 3 }, formId: 'application', applicationFormId: 'application' };
  assert.equal(classifyApplicationControl({ ...workflow, type: 'submit', label: 'Continue' }), 'progression');
  assert.equal(classifyApplicationControl({ ...workflow, type: 'submit', label: 'Next' }), 'progression');
  assert.equal(classifyApplicationControl({ ...workflow, type: 'submit', formAction: '/application/step/2', label: 'Save and continue' }), 'progression');
  assert.equal(classifyApplicationControl({ ...workflow, type: 'submit', label: 'Submit application' }), 'final');
  assert.equal(classifyApplicationControl({ ...workflow, type: 'button', label: 'Apply' }), 'final');
  assert.equal(classifyApplicationControl({ ...workflow, type: 'submit', label: 'Continue and submit' }), 'final');
  assert.equal(classifyApplicationControl({ ...workflow, type: 'submit', label: 'Review application' }), 'ambiguous');
  assert.equal(classifyApplicationControl({ ...workflow, type: 'submit', label: 'Continue', hasRemainingStep: false }), 'ambiguous');
  assert.equal(classifyApplicationControl({ ...workflow, type: 'button', label: 'Continue' }), 'ambiguous');
});

test('localized controls stop at review unless a remaining numbered step authorizes progression', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const { label, step, extraControl, expectedClicks, final } of [
      { label: 'Continue', step: 3, expectedClicks: 0, final: false },
      { label: 'Continue', step: null, expectedClicks: 0, final: false },
      { label: 'Continue', step: 1, extraControl: 'Weiter', expectedClicks: 0, final: false },
      { label: 'Weiter', step: 1, expectedClicks: 1, final: false },
      { label: 'Absenden', step: 1, expectedClicks: 0, final: true },
      { label: 'Lähetä hakemus', step: 1, expectedClicks: 0, final: true },
    ]) {
      const page = await browser.newPage();
      const fixtureUrl = 'https://fixture.career-ops.invalid/application/localized';
      await page.route(fixtureUrl, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <div data-career-ops-wizard>${step ? `<p data-career-ops-step="${step}" data-career-ops-total-steps="3">Step ${step} of 3</p>` : ''}
        <form id="application" method="post" action="/application/step/2">
          <label>First name<input id="first" name="first_name" required></label>
          <label>Email<input id="email" name="email" type="email" required></label>
          <label>LinkedIn<input name="linkedin"></label>
          <button id="action" type="submit"${label === 'Continue' ? ' aria-label="Continue application"' : ''}>${label}</button>
          ${extraControl ? `<button type="button">${extraControl}</button>` : ''}
        </form></div><script>
          action.addEventListener('click', () => { window.actionClicks=(window.actionClicks||0)+1; });
          application.addEventListener('submit', event => { event.preventDefault(); });
        </script>` }));
      await page.goto(fixtureUrl);
      const result = await prepareOperationalApplicationForm(page, profile, {}, {
        context, transitionTimeoutMs: 150, transitionStabilityMs: 0,
      });
      assert.equal(await page.evaluate(() => window.actionClicks || 0), expectedClicks, label);
      if (!final) assert.equal(result.gate?.state, 'review_required', label);
      assert.equal(result.evidence.finalAction.detected, final, label);
      assert.equal(result.evidence.finalAction.activated, false, label);
      assert.equal(await page.locator('#email').inputValue(), profile.candidate.email, label);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('the click guard rechecks the step and final label after a progression permit was granted', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const mutation of ['last-step', 'removed-step', 'hidden-step', 'absenden', 'lähetä']) {
      const page = await browser.newPage();
      await page.setContent(`
        <div data-career-ops-wizard><p id="step" data-career-ops-step="1" data-career-ops-total-steps="3">Step 1 of 3</p>
        <form id="application"><label>Email<input name="email"></label>
          <button id="continue" type="submit" aria-label="Continue application">Continue</button>
        </form></div><script>
          document.getElementById('continue').addEventListener('click', () => { window.clicks=(window.clicks||0)+1; });
          application.addEventListener('submit', event => { event.preventDefault(); window.submits=(window.submits||0)+1; });
        </script>
      `);
      const snapshot = await inspectOperationalApplicationForm(page);
      const control = snapshot.controls.find((row) => row.text === 'Continue');
      const options = { applicationIdentity: 'fixture', stateFingerprint: applicationFormStateFingerprint(snapshot) };
      assert.equal(await grantProgressionPermit(page, control, options), true);
      await page.evaluate((mutation) => {
        const step = document.getElementById('step');
        if (mutation === 'last-step') { step.dataset.careerOpsStep='3'; step.textContent='Step 3 of 3'; }
        if (mutation === 'removed-step') step.remove();
        if (mutation === 'hidden-step') step.hidden=true;
        if (mutation === 'absenden') document.getElementById('continue').textContent='Absenden';
        if (mutation === 'lähetä') document.getElementById('continue').textContent='Lähetä hakemus';
      }, mutation);
      await page.locator('#continue').click();
      assert.equal(await page.evaluate(() => window.clicks || 0), 0, mutation);
      assert.equal(await page.evaluate(() => window.submits || 0), 0, mutation);
      assert.equal((await inspectOperationalApplicationForm(page)).progressionSubmits, 0, mutation);
      await removeOperationalSubmissionGuard(page);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('untyped option and Add another buttons keep their handlers under the guard without submitting', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div data-career-ops-wizard><p data-career-ops-step="1" data-career-ops-total-steps="2">Step 1 of 2</p>
      <form id="application"><label>Email<input name="email"></label>
        <button id="country-option" role="option">Finland</button>
        <button id="add-another">Add another</button>
        <label>Send me updates<input id="updates" type="checkbox"></label>
        <button id="continue" type="submit" aria-label="Continue application">Continue</button>
      </form></div><script>
        document.getElementById('country-option').onclick = () => { window.optionClicks=(window.optionClicks||0)+1; };
        document.getElementById('add-another').onclick = () => { window.addClicks=(window.addClicks||0)+1; };
        updates.onclick = () => { window.updateClicks=(window.updateClicks||0)+1; };
        application.addEventListener('submit', event => { event.preventDefault(); window.submits=(window.submits||0)+1; });
      </script>
    `);
    const snapshot = await inspectOperationalApplicationForm(page);
    const control = snapshot.controls.find((row) => row.text === 'Continue');
    assert.equal(await grantProgressionPermit(page, control, {
      applicationIdentity: 'fixture', stateFingerprint: applicationFormStateFingerprint(snapshot),
    }), true);
    await page.locator('#country-option').click();
    await page.locator('#add-another').click();
    await page.locator('#updates').check();
    assert.equal(await page.evaluate(() => window.optionClicks || 0), 1);
    assert.equal(await page.evaluate(() => window.addClicks || 0), 1);
    assert.equal(await page.evaluate(() => window.updateClicks || 0), 1);
    assert.equal(await page.evaluate(() => window.submits || 0), 0);
    assert.equal((await inspectOperationalApplicationForm(page)).submitAttempts, 2);
    await removeOperationalSubmissionGuard(page);
  } finally {
    await browser.close();
  }
});

test('capture guards recheck every early activation event against the live final label and step', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const activation of ['pointerdown', 'mousedown', 'touchstart', 'click', 'auxclick', 'Enter', ' ']) {
      const type = ['Enter', ' '].includes(activation) ? 'keydown' : activation;
      for (const mutation of ['label', 'last-step']) {
        const page = await browser.newPage();
        await page.setContent(`
          <div data-career-ops-wizard><p id="step" data-career-ops-step="1" data-career-ops-total-steps="2">Step 1 of 2</p>
          <form id="application"><label>Email<input name="email"></label>
            <button id="continue" type="submit" aria-label="Continue application">Continue</button>
          </form></div><script>
            document.getElementById('continue').addEventListener('${type}', () => {
              window.handlerCalls=(window.handlerCalls||0)+1;
              application.requestSubmit(document.getElementById('continue'));
            });
            application.addEventListener('submit', event => { event.preventDefault(); window.submits=(window.submits||0)+1; });
          </script>
        `);
        const snapshot = await inspectOperationalApplicationForm(page);
        const control = snapshot.controls.find((row) => row.text === 'Continue');
        assert.equal(await grantProgressionPermit(page, control, {
          applicationIdentity: 'fixture', stateFingerprint: applicationFormStateFingerprint(snapshot),
        }), true);
        const dispatched = await page.evaluate(({ type, mutation, activation }) => {
          const control = document.getElementById('continue');
          if (mutation === 'label') control.textContent = 'Absenden';
          else { step.dataset.careerOpsStep = '2'; step.textContent = 'Step 2 of 2'; }
          control.focus();
          const event = type === 'keydown'
            ? new KeyboardEvent(type, { key: activation, bubbles: true, cancelable: true })
            : new Event(type, { bubbles: true, cancelable: true });
          return control.dispatchEvent(event);
        }, { type, mutation, activation });
        assert.equal(dispatched, false, `${activation}: ${mutation}`);
        assert.equal(await page.evaluate(() => window.handlerCalls || 0), 0, `${activation}: ${mutation}`);
        assert.equal(await page.evaluate(() => window.submits || 0), 0, `${activation}: ${mutation}`);
        await removeOperationalSubmissionGuard(page);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test('mousedown mutation into a final action blocks requestSubmit and the subsequent click', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const mutation of ['label', 'last-step']) {
      const page = await browser.newPage();
      await page.setContent(`
        <div data-career-ops-wizard><p id="step" data-career-ops-step="1" data-career-ops-total-steps="2">Step 1 of 2</p>
        <form id="application" action="/application/step/2">
          <label>Email<input name="email" type="email" required></label>
          <button id="continue" type="submit" aria-label="Continue application">Continue</button>
        </form></div><script>
          const control = document.getElementById('continue');
          control.addEventListener('mousedown', () => {
            window.mouseDowns=(window.mouseDowns||0)+1;
            if ('${mutation}' === 'label') control.textContent='Lähetä hakemus';
            else { step.dataset.careerOpsStep='2'; step.textContent='Step 2 of 2'; }
            application.requestSubmit(control);
          });
          control.addEventListener('click', () => { window.clicks=(window.clicks||0)+1; });
          application.addEventListener('submit', event => { event.preventDefault(); window.submits=(window.submits||0)+1; });
        </script>
      `);
      const result = await prepareOperationalApplicationForm(page, profile, {}, {
        context, transitionTimeoutMs: 150, transitionStabilityMs: 0,
      });
      assert.equal(await page.evaluate(() => window.mouseDowns || 0), 1, mutation);
      assert.equal(await page.evaluate(() => window.clicks || 0), 0, mutation);
      assert.equal(await page.evaluate(() => window.submits || 0), 0, mutation);
      assert.equal(result.evidence.finalAction.activated, false, mutation);
      assert.equal(result.evidence.progression.stepsAdvanced, 0, mutation);
      assert.equal(result.gate.state, 'review_required', mutation);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('progression permit is exact, rejects other/final controls, and is single-use', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div data-career-ops-wizard><p data-career-ops-step="1" data-career-ops-total-steps="2">Step 1 of 2</p>
      <form><label>Email<input name="email"></label>
      <button id="continue" type="submit" aria-label="Continue application">Continue</button>
      <button id="final" type="submit">Submit application</button></form></div>
      <script>document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();window.submits=(window.submits||0)+1;});</script>
    `);
    const snapshot = await inspectOperationalApplicationForm(page);
    const progression = snapshot.controls.find((control) => control.text === 'Continue');
    const final = snapshot.controls.find((control) => control.text === 'Submit application');
    const fingerprint = applicationFormStateFingerprint(snapshot);
    assert.equal(await grantProgressionPermit(page, progression, { applicationIdentity: 'fixture', stateFingerprint: fingerprint }), true);
    await page.locator('#final').evaluate((element) => element.click());
    let guarded = await inspectOperationalApplicationForm(page);
    assert.equal(guarded.submitAttempts, 1);
    assert.equal(await page.evaluate(() => window.submits || 0), 0);
    await assert.rejects(() => grantProgressionPermit(page, final, { applicationIdentity: 'fixture', stateFingerprint: fingerprint }), /non-progression/);
    await activateProgressionControl(page, progression, { applicationIdentity: 'fixture', stateFingerprint: fingerprint });
    assert.equal(await page.evaluate(() => window.submits || 0), 1);
    await page.locator('#continue').evaluate((element) => element.click());
    guarded = await inspectOperationalApplicationForm(page);
    assert.equal(guarded.submitAttempts, 2);
    assert.equal(guarded.progressionSubmits, 1);
    assert.equal(await page.evaluate(() => window.submits || 0), 1);
    await page.evaluate(() => document.querySelector('form').requestSubmit()).catch(() => {});
    guarded = await inspectOperationalApplicationForm(page);
    assert.equal(guarded.submitAttempts, 3);
    assert.equal(await grantProgressionPermit(page, progression, { applicationIdentity: 'fixture', stateFingerprint: fingerprint }), true);
    await page.locator('#continue').evaluate((element) => element.replaceWith(element.cloneNode(true)));
    await page.locator('#continue').evaluate((element) => element.click());
    guarded = await inspectOperationalApplicationForm(page);
    assert.equal(guarded.submitAttempts, 4);
    assert.equal(await page.evaluate(() => window.submits || 0), 1);
    await removeOperationalSubmissionGuard(page);
    await page.locator('#final').click();
    assert.equal(await page.evaluate(() => window.submits || 0), 2);
  } finally {
    await browser.close();
  }
});

test('requestSubmit permits only the exact authorized progression submitter', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const mode of ['exact', 'other', 'final', 'bare', 'raw']) {
      const page = await browser.newPage();
      await page.setContent(`
        <div data-career-ops-wizard><p data-career-ops-step="1" data-career-ops-total-steps="2">Step 1 of 2</p>
        <form id="application"><label>Email<input name="email"></label>
          <button id="continue" type="submit" aria-label="Continue application">Continue</button>
          <button id="other" type="submit">Next</button>
          <button id="final" type="submit">Submit application</button>
        </form></div><script>application.addEventListener('submit',event=>{event.preventDefault();window.submits=(window.submits||0)+1;});</script>
      `);
      const snapshot = await inspectOperationalApplicationForm(page);
      const progression = snapshot.controls.find((control) => control.text === 'Continue');
      const fingerprint = applicationFormStateFingerprint(snapshot);
      assert.equal(await grantProgressionPermit(page, progression, { applicationIdentity: 'fixture', stateFingerprint: fingerprint }), true);
      await page.evaluate((selected) => {
        const form = document.getElementById('application');
        if (selected === 'exact') form.requestSubmit(document.getElementById('continue'));
        else if (selected === 'other') form.requestSubmit(document.getElementById('other'));
        else if (selected === 'final') form.requestSubmit(document.getElementById('final'));
        else if (selected === 'bare') form.requestSubmit();
        else form.submit();
      }, mode).catch(() => {});
      const after = await inspectOperationalApplicationForm(page);
      assert.equal(await page.evaluate(() => window.submits || 0), mode === 'exact' ? 1 : 0, mode);
      assert.equal(after.progressionSubmits, mode === 'exact' ? 1 : 0, mode);
      assert.equal(after.submitAttempts, mode === 'exact' ? 0 : 1, mode);
      await removeOperationalSubmissionGuard(page);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('critical same-node Continue to Submit mutation is re-reviewed and never activated', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div data-career-ops-wizard><p data-career-ops-step="1" data-career-ops-total-steps="2">Step 1 of 2</p>
      <form id="application" action="/application/step/2"><label>Email<input id="email" name="email" type="email" required></label>
        <button id="continue" type="submit" aria-label="Continue application">Continue</button></form></div>
      <script>
        document.getElementById('email').addEventListener('input',()=>{const button=document.getElementById('continue');button.textContent='Submit application';button.setAttribute('aria-label','Submit application');const form=document.getElementById('application');form.action='/application/submit';form.method='post';});
        document.getElementById('application').addEventListener('submit',event=>{event.preventDefault();window.finalSubmits=(window.finalSubmits||0)+1;});
      </script>
    `);
    const initial = await inspectOperationalApplicationForm(page);
    const original = initial.controls.find((control) => control.controlId);
    assert.equal(classifyApplicationControl(original), 'progression');
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context });
    const after = await inspectOperationalApplicationForm(page);
    assert.equal(after.controls[0].controlId, original.controlId);
    assert.equal(after.controls[0].label, 'Submit application');
    assert.equal(result.gate.state, 'review_required');
    assert.match(result.gate.reason, /changed after form filling/);
    assert.equal(await page.evaluate(() => window.finalSubmits || 0), 0);
    assert.equal(result.evidence.progression.stepsAdvanced, 0);
    assert.equal(result.evidence.finalAction.activated, false);
  } finally {
    await browser.close();
  }
});

test('live signature rejects label, action, type, form, replacement, and expired permits', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const mutation of ['label', 'action', 'type', 'form', 'replacement', 'expired']) {
      const page = await browser.newPage();
      await page.setContent(`
        <div data-career-ops-wizard><p data-career-ops-step="1" data-career-ops-total-steps="2">Step 1 of 2</p>
        <form id="application" action="/step/2"><label>Email<input name="email"></label><button id="continue" type="submit" aria-label="Continue application">Continue</button></form></div>
        <form id="other-form"></form>
        <script>application.addEventListener('submit',event=>{event.preventDefault();window.submits=(window.submits||0)+1;});</script>
      `);
      const snapshot = await inspectOperationalApplicationForm(page);
      const progression = snapshot.controls.find((control) => control.text === 'Continue');
      const fingerprint = applicationFormStateFingerprint(snapshot);
      assert.equal(await grantProgressionPermit(page, progression, { applicationIdentity: 'fixture', stateFingerprint: fingerprint, timeoutMs: mutation === 'expired' ? 10 : 1_000 }), true);
      if (mutation === 'label') await page.locator('#continue').evaluate((element) => { element.textContent = 'Submit application'; element.setAttribute('aria-label', 'Submit application'); });
      if (mutation === 'action') await page.locator('#application').evaluate((form) => { form.action = '/application/submit'; form.method = 'post'; });
      if (mutation === 'type') await page.locator('#continue').evaluate((element) => { element.type = 'button'; });
      if (mutation === 'form') await page.locator('#continue').evaluate((element) => document.getElementById('other-form').append(element));
      if (mutation === 'replacement') await page.locator('#continue').evaluate((element) => element.replaceWith(element.cloneNode(true)));
      if (mutation === 'expired') await new Promise((resolve) => setTimeout(resolve, 30));
      await page.locator('#continue').click().catch(() => {});
      assert.equal(await page.evaluate(() => window.submits || 0), 0, mutation);
      const after = await inspectOperationalApplicationForm(page);
      assert.equal(after.progressionSubmits, 0, mutation);
      await removeOperationalSubmissionGuard(page);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('wizard evidence is scoped to the unique application form', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="progressbar" aria-valuenow="1" aria-valuemax="5"></div><div class="progress">Step 1 of 5</div>
      <form id="newsletter"><label>Newsletter email<input name="newsletter"></label><button type="submit">Continue</button></form>
      <div data-career-ops-wizard><p data-career-ops-step="1" data-career-ops-total-steps="2">Step 1 of 2</p>
        <form id="application"><label>First name<input name="first_name"></label><label>Email<input type="email" name="email"></label><button type="submit" aria-label="Continue application">Continue</button></form>
      </div>
    `);
    const snapshot = await inspectOperationalApplicationForm(page);
    const newsletter = snapshot.controls.find((control) => control.formId !== snapshot.applicationFormId);
    const application = snapshot.controls.find((control) => control.formId === snapshot.applicationFormId);
    assert.equal(classifyApplicationControl(newsletter), 'ambiguous');
    assert.equal(classifyApplicationControl(application), 'progression');
  } finally {
    await browser.close();
  }
});

test('dynamic application fields keep persistent collision-safe identities and join planning', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form id="application"><label>First name<input id="first" name="first_name" required></label><label>Email<input id="email" type="email" name="email" required></label><button type="submit">Submit application</button></form>`);
    const first = await inspectOperationalApplicationForm(page);
    const originalIds = Object.fromEntries(first.fields.map((field) => [field.id, field.fieldId]));
    await page.locator('#application').evaluate((form) => form.insertAdjacentHTML('beforeend', '<label>LinkedIn<input id="linkedin-dynamic" name="linkedin" required></label>'));
    const second = await inspectOperationalApplicationForm(page);
    assert.equal(second.fields.find((field) => field.id === 'first').fieldId, originalIds.first);
    assert.equal(second.fields.find((field) => field.id === 'email').fieldId, originalIds.email);
    const dynamic = second.fields.find((field) => field.id === 'linkedin-dynamic');
    assert.ok(dynamic.fieldId);
    assert.equal(new Set(second.fields.map((field) => field.fieldId)).size, second.fields.length);
    assert.equal(dynamic.formId, second.applicationFormId);
    assert.equal(dynamic.applicationFormOwned, true);
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context });
    assert.equal(await page.locator('#linkedin-dynamic').inputValue(), profile.candidate.linkedin);
    assert.equal(result.evidence.requiredFieldCount, 3);
  } finally {
    await browser.close();
  }
});

test('dynamically inserted unrelated fields get unique ownership and remain untouched', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form id="newsletter"><label>Newsletter email<input id="newsletter-email" type="email"></label><button type="submit">Subscribe</button></form>
      <form id="application"><label>First name<input id="first" name="first_name" required></label><label>Email<input id="email" type="email" name="email" required></label><button type="submit">Submit application</button></form>
    `);
    const before = await inspectOperationalApplicationForm(page);
    await page.locator('#newsletter').evaluate((form) => form.insertAdjacentHTML('beforeend', '<label>LinkedIn<input id="newsletter-linkedin" name="linkedin"></label>'));
    const after = await inspectOperationalApplicationForm(page);
    const dynamic = after.fields.find((field) => field.id === 'newsletter-linkedin');
    assert.equal(new Set(after.fields.map((field) => field.fieldId)).size, after.fields.length);
    assert.equal(before.fields.some((field) => field.fieldId === dynamic.fieldId), false);
    assert.notEqual(dynamic.formId, after.applicationFormId);
    assert.equal(dynamic.applicationFormOwned, false);
    await prepareOperationalApplicationForm(page, profile, {}, { context });
    assert.equal(await page.locator('#newsletter-linkedin').inputValue(), '');
  } finally {
    await browser.close();
  }
});

test('duplicate or tampered Career-Ops field identities fail closed', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form><label>First name<input name="first_name" data-career-ops-field-id="field-tampered"></label><label>Email<input type="email" name="email" data-career-ops-field-id="field-tampered"></label><button type="submit">Submit application</button></form>`);
    await assert.rejects(() => inspectOperationalApplicationForm(page), /Duplicate Career-Ops field identity/);
    await assert.rejects(() => prepareOperationalApplicationForm(page, profile, {}, { context }), /Duplicate Career-Ops field identity/);
  } finally {
    await browser.close();
  }
});

test('hidden stale application forms cannot beat the visible active form', async () => {
  const fixture = artifacts();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <section aria-hidden="true"><form id="stale"><p data-career-ops-step="1" data-career-ops-total-steps="2">Step 1 of 2</p>
        <label>First name<input id="stale-first" name="first_name"></label><label>Last name<input name="last_name"></label><label>Email<input type="email" name="email"></label>
        <label>Resume / CV<input id="stale-cv" type="file"></label><label>Cover letter<input id="stale-cover" type="file"></label><button type="submit">Continue</button></form></section>
      <form id="active"><label>First name<input id="active-first" name="first_name" required></label><label>Email<input id="active-email" type="email" name="email" required></label><button type="submit">Submit application</button></form>
    `);
    const snapshot = await inspectOperationalApplicationForm(page);
    assert.equal(snapshot.applicationFormId, await page.locator('#active').getAttribute('data-career-ops-form-id'));
    const result = await prepareOperationalApplicationForm(page, profile, fixture.value, { context });
    assert.equal(await page.locator('#active-first').inputValue(), 'Alex');
    assert.equal(await page.locator('#stale-first').inputValue(), '');
    assert.equal(await page.locator('#stale-cv').evaluate((input) => input.files.length), 0);
    assert.equal(await page.locator('#stale-cover').evaluate((input) => input.files.length), 0);
    assert.equal(result.evidence.progression.stepsAdvanced, 0);
    assert.equal(result.evidence.finalAction.activated, false);
  } finally {
    await browser.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('ambiguous competing visible application forms fail closed without filling', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form id="application-a"><label>First name<input id="a-first" name="first_name"></label><label>Email<input id="a-email" type="email" name="email"></label><button type="submit">Submit application</button></form>
      <form id="application-b"><label>First name<input id="b-first" name="first_name"></label><label>Email<input id="b-email" type="email" name="email"></label><button type="submit">Submit application</button></form>
    `);
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context });
    assert.equal(result.snapshot.applicationFormId, '');
    assert.equal(await page.locator('#a-first').inputValue(), '');
    assert.equal(await page.locator('#b-first').inputValue(), '');
    assert.equal(result.gate.state, 'review_required');
  } finally {
    await browser.close();
  }
});

test('unrelated form fields and required controls are isolated from the operational runtime', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form id="newsletter"><label>Newsletter email<input id="newsletter-email" type="email" required></label><button id="newsletter-continue" type="submit">Continue</button></form>
      <form id="application"><label>First name<input id="first-name" name="first_name" required></label><label>Email<input id="application-email" type="email" name="email" required></label><button type="submit">Submit application</button></form>
      <script>newsletter.addEventListener('submit',event=>{event.preventDefault();window.newsletterSubmits=(window.newsletterSubmits||0)+1;});</script>
    `);
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context });
    assert.equal(await page.locator('#first-name').inputValue(), 'Alex');
    assert.equal(await page.locator('#application-email').inputValue(), profile.candidate.email);
    assert.equal(await page.locator('#newsletter-email').inputValue(), '');
    assert.equal(await page.evaluate(() => window.newsletterSubmits || 0), 0);
    assert.equal(result.evidence.unresolvedFields.some((row) => row.label.includes('Newsletter')), false);
    assert.equal(result.evidence.requiredFieldCount, 2);
  } finally {
    await browser.close();
  }
});

test('newsletter and contact forms alone never become an application workflow', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form id="newsletter"><label>Newsletter email<input id="newsletter-email" type="email" required></label><button type="submit">Subscribe</button></form>
      <form id="contact"><label>Your name<input id="contact-name" required></label><label>Email<input id="contact-email" type="email" required></label><button type="submit">Send</button></form>
    `);
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context });
    assert.equal(result.snapshot.applicationFormId, '');
    assert.equal(await page.locator('#newsletter-email').inputValue(), '');
    assert.equal(await page.locator('#contact-name').inputValue(), '');
    assert.equal(await page.locator('#contact-email').inputValue(), '');
    assert.equal(result.gate.state, 'review_required');
    assert.match(result.evidence.unresolvedFields[0].reason, /No uniquely verified application form/);
  } finally {
    await browser.close();
  }
});

test('generic markerless signup wizard fails closed in the operational runtime', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="signup-shell"><div>Step 1 of 3</div>
        <form id="signup"><label>Email<input id="signup-email" name="email" type="email"></label>
          <button id="signup-continue" type="submit">Continue</button></form>
      </div>
      <script>signup.addEventListener('submit',event=>{event.preventDefault();window.signupSubmits=(window.signupSubmits||0)+1;});</script>
    `);
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context });
    assert.equal(result.snapshot.applicationFormId, '');
    assert.equal(await page.locator('#signup-email').inputValue(), '');
    assert.equal(await page.evaluate(() => window.signupSubmits || 0), 0);
    assert.equal(result.gate.state, 'review_required');
    assert.match(result.evidence.unresolvedFields[0].reason, /No uniquely verified application form/);
  } finally {
    await browser.close();
  }
});

test('operational locator never transfers a planned field identity across DOM replacement', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const mutation of ['missing-stamp', 'different-stamp', 'duplicate-stamp', 'unchanged']) {
      const page = await browser.newPage();
      await page.setContent(`
        <form id="application"><label for="email">Email</label><input id="email" name="email" type="email" required>
          <button type="submit">Submit application</button></form>
      `);
      const snapshot = await inspectOperationalApplicationForm(page);
      const plan = buildOperationalFormPlan(snapshot, profile, {}, { context });
      const fieldId = plan.actions[0].fieldId;
      if (mutation === 'missing-stamp') {
        await page.locator('#email').evaluate((element) => {
          const replacement = element.cloneNode(true);
          replacement.removeAttribute('data-career-ops-field-id');
          element.replaceWith(replacement);
        });
      } else if (mutation === 'different-stamp') {
        await page.locator('#email').evaluate((element) => {
          const replacement = element.cloneNode(true);
          replacement.setAttribute('data-career-ops-field-id', 'field-replacement');
          element.replaceWith(replacement);
        });
      } else if (mutation === 'duplicate-stamp') {
        await page.locator('#email').evaluate((element) => {
          const duplicate = element.cloneNode(true);
          duplicate.id = 'email-duplicate';
          duplicate.name = 'email_duplicate';
          element.after(duplicate);
        });
      }
      const execution = await executeOperationalFormPlan(page, plan, { limits: { maxAttempts: 1 } });
      const values = await page.locator(`input[data-career-ops-field-id="${fieldId}"]`).evaluateAll((elements) => elements.map((element) => element.value));
      if (mutation === 'unchanged') {
        assert.deepEqual(values, [profile.candidate.email], mutation);
        assert.equal(execution.unresolvedFields.length, 0, mutation);
      } else {
        assert.equal(await page.locator('#email').inputValue(), '', mutation);
        assert.equal(values.every((value) => value === ''), true, mutation);
        assert.equal(execution.unresolvedFields.some((row) => row.semantic === 'email'), true, mutation);
        assert.match(execution.attemptLedger.at(-1).validationEvidence, mutation === 'duplicate-stamp'
          ? /exact field identity is ambiguous/
          : /could not be reacquired/);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('unrelated upload is untouched and cannot make application topology ambiguous', async () => {
  const fixture = artifacts();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form id="support"><label>Support attachment<input id="support-file" type="file" required></label><button type="submit">Send support request</button></form>
      <form id="application"><label>First name<input name="first_name" required></label><label>Resume / CV<input id="application-cv" type="file" required></label><label>Cover letter<input id="application-cover" type="file" required></label><button type="submit">Submit application</button></form>
    `);
    const snapshot = await inspectOperationalApplicationForm(page);
    const topology = inspectOperationalUploadTopology(snapshot);
    assert.equal(topology.mode, 'separate');
    assert.deepEqual(topology.fields.map((row) => row.fieldId).sort(), [
      await page.locator('#application-cover').getAttribute('data-career-ops-field-id'),
      await page.locator('#application-cv').getAttribute('data-career-ops-field-id'),
    ].sort());
    const result = await prepareOperationalApplicationForm(page, profile, fixture.value, { context });
    assert.deepEqual(await page.locator('#application-cv').evaluate((input) => [...input.files].map((file) => file.name)), ['CV.pdf']);
    assert.deepEqual(await page.locator('#application-cover').evaluate((input) => [...input.files].map((file) => file.name)), ['Cover.pdf']);
    assert.equal(await page.locator('#support-file').evaluate((input) => input.files.length), 0);
    assert.equal(result.evidence.uploadTopology.mode, 'separate');
  } finally {
    await browser.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('validation errors are application-associated, while unrelated-form errors are ignored', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form id="newsletter"><label>Newsletter email<input type="email"></label><p class="error">Newsletter email is required</p></form>
      <form id="application"><label>First name<input name="first_name" required></label><label>Email<input type="email" name="email" required></label><button type="submit">Submit application</button></form>
    `);
    let result = await prepareOperationalApplicationForm(page, profile, {}, { context });
    assert.deepEqual(result.evidence.validationErrors, []);
    assert.equal(result.evidence.reviewComplete, true);
    await page.locator('#application').evaluate((form) => form.insertAdjacentHTML('beforeend', '<p class="error">Application email is invalid</p>'));
    result = await prepareOperationalApplicationForm(page, profile, {}, { context });
    assert.deepEqual(result.evidence.validationErrors, ['Application email is invalid']);
    assert.equal(result.evidence.reviewComplete, false);
    assert.equal(result.gate.state, 'review_required');
  } finally {
    await browser.close();
  }
});

test('application fingerprint ignores unrelated form and page mutations', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="unrelated-text">Before</div><div class="progress" id="unrelated-progress">Step 1 of 9</div>
      <form id="newsletter"><label>Newsletter email<input id="newsletter-email" type="email"></label><button id="newsletter-button" type="submit">Continue</button></form>
      <form id="application"><label>First name<input name="first_name"></label><label>Email<input type="email" name="email"></label><button type="submit">Submit application</button></form>
    `);
    const before = applicationFormStateFingerprint(await inspectOperationalApplicationForm(page));
    await page.locator('#newsletter-email').fill('news@example.test');
    await page.locator('#newsletter-button').evaluate((button) => { button.textContent = 'Subscribe'; });
    await page.locator('#unrelated-text').evaluate((element) => { element.textContent = 'After'; });
    await page.locator('#unrelated-progress').evaluate((element) => { element.textContent = 'Step 8 of 9'; });
    const after = applicationFormStateFingerprint(await inspectOperationalApplicationForm(page));
    assert.equal(after, before);
  } finally {
    await browser.close();
  }
});

test('a global stepper cannot authorize Continue, but an explicit application wizard can', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="steps">Step 1 of 5</div>
      <form id="application"><label>First name<input name="first_name"></label><label>Email<input type="email" name="email"></label><button type="submit">Continue</button></form>
    `);
    let snapshot = await inspectOperationalApplicationForm(page);
    assert.equal(snapshot.stepIndicator, null);
    assert.equal(classifyApplicationControl(snapshot.controls.find((control) => control.formId === snapshot.applicationFormId)), 'ambiguous');
    await page.setContent(`
      <div data-career-ops-wizard><div class="steps">Step 1 of 3</div>
        <form id="application"><label>First name<input name="first_name"></label><label>Email<input type="email" name="email"></label><button type="submit" aria-label="Continue application">Continue</button></form>
      </div>
    `);
    snapshot = await inspectOperationalApplicationForm(page);
    assert.deepEqual(snapshot.stepIndicator, { current: 1, total: 3, text: 'Step 1 of 3' });
    assert.equal(classifyApplicationControl(snapshot.controls.find((control) => control.formId === snapshot.applicationFormId)), 'progression');
  } finally {
    await browser.close();
  }
});

test('a narrow local structural wizard provides step authority only with independent application evidence', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="application-shell"><div class="step-indicator">Step 1 of 3</div>
        <form id="application"><label>First name<input name="first_name"></label><label>Email<input type="email" name="email"></label><button type="submit" aria-label="Continue application">Continue</button></form>
      </div>
    `);
    const snapshot = await inspectOperationalApplicationForm(page);
    assert.deepEqual(snapshot.stepIndicator, { current: 1, total: 3, text: 'Step 1 of 3' });
    assert.equal(classifyApplicationControl(snapshot.controls.find((control) => control.formId === snapshot.applicationFormId)), 'progression');

    await page.setContent(`
      <div class="broad-shell"><div class="step-indicator">Step 1 of 3</div><aside>Unrelated navigation</aside>
        <form id="application"><label>First name<input name="first_name"></label><label>Email<input type="email" name="email"></label><button type="submit">Continue</button></form>
      </div>
    `);
    const broad = await inspectOperationalApplicationForm(page);
    assert.equal(broad.stepIndicator, null);
    assert.equal(classifyApplicationControl(broad.controls.find((control) => control.formId === broad.applicationFormId)), 'ambiguous');

    await page.setContent(`
      <div class="competing-shell"><div class="step-indicator">Step 1 of 3</div>
        <form id="application"><label>First name<input name="first_name"></label><label>Email<input type="email" name="email"></label><button type="submit">Continue</button></form>
        <form id="other"><label>Candidate email<input type="email"></label><button type="submit">Submit application</button></form>
      </div>
    `);
    const competing = await inspectOperationalApplicationForm(page);
    assert.equal(competing.stepIndicator, null);
    const application = competing.controls.find((control) => control.formId === competing.applicationFormId);
    assert.notEqual(classifyApplicationControl(application), 'progression');
  } finally {
    await browser.close();
  }
});

test('attempt-ledger form fingerprint ignores unrelated-form changes', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const html = (newsletterField = '') => `
      <form id="newsletter"><label>Newsletter email<input type="email" name="newsletter"></label>${newsletterField}<button type="submit">Subscribe</button></form>
      <form id="application"><label>First name<input name="first_name" required></label><label>Email<input type="email" name="email" required></label><button type="submit">Submit application</button></form>`;
    await page.setContent(html());
    const first = await prepareOperationalApplicationForm(page, profile, {}, { context });
    const firstFingerprint = first.evidence.attemptLedger[0].formFingerprint;
    await page.setContent(html('<label>Newsletter city<input name="newsletter_city"></label>'));
    const second = await prepareOperationalApplicationForm(page, profile, {}, { context });
    assert.equal(second.evidence.attemptLedger[0].formFingerprint, firstFingerprint);
    await page.setContent(`${html()}<script>document.querySelector('#application').insertAdjacentHTML('afterbegin','<label>LinkedIn<input name="linkedin" required></label>')</script>`);
    const third = await prepareOperationalApplicationForm(page, profile, {}, { context });
    assert.notEqual(third.evidence.attemptLedger[0].formFingerprint, firstFingerprint);
  } finally {
    await browser.close();
  }
});

test('transition waits through transient loading until the settled state is stable', async () => {
  const sequence = [
    { url: 'https://fixture.test/step/1', fields: [{ name: 'email', label: 'Email', type: 'email' }], controls: [] },
    { url: 'https://fixture.test/loading', fields: [], controls: [] },
    { url: 'https://fixture.test/step/2', fields: [{ name: 'resume', label: 'Resume', type: 'file' }], controls: [] },
    { url: 'https://fixture.test/step/2', fields: [{ name: 'resume', label: 'Resume', type: 'file' }], controls: [] },
  ];
  let index = 0;
  let now = 0;
  const page = { evaluate: async () => {}, context: () => null };
  const result = await (await import('../application-form-engine.mjs')).waitForApplicationStateTransition(
    page,
    applicationFormStateFingerprint(sequence[0]),
    {
      timeoutMs: 1_000,
      pollMs: 0,
      stabilityMs: 200,
      clock: () => { now += 100; return now; },
      inspect: async () => sequence[Math.min(++index, sequence.length - 1)],
    },
  );
  assert.equal(result.snapshot.url, 'https://fixture.test/step/2');
  assert.equal(result.timedOut, undefined);
});

test('application continuity rejects another requisition on the same ATS origin', () => {
  const candidate = { company: 'Acme', title: 'Engineer', listingUrl: 'https://jobs.ashbyhq.com/acme/requisition-123' };
  assert.equal(verifyApplicationContinuity({
    beforeUrl: 'https://jobs.ashbyhq.com/acme/requisition-123/application',
    currentUrl: 'https://jobs.ashbyhq.com/acme/requisition-999/application',
    snapshot: { bodyText: 'Acme Engineer' }, candidate,
  }).verified, false);
  assert.equal(verifyApplicationContinuity({
    beforeUrl: 'https://jobs.ashbyhq.com/acme/requisition-123/application',
    currentUrl: 'https://jobs.ashbyhq.com/acme/requisition-123/application?step=2',
    snapshot: { bodyText: '' }, candidate,
  }).verified, true);
});

async function runFixture(options = {}) {
  const fixture = artifacts();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const requests = [];
    if (options.post) {
      await page.route('**/application/background/*', async (route) => {
        requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
        await route.fulfill({ body: 'saved' });
      });
    }
    await page.route('**/application/step/*', async (route) => {
      const step = Number(new URL(route.request().url()).pathname.split('/').pop());
      let body = multiStepApplicationFixture(step, options);
      if (options.post) {
        requests.push({ step, method: route.request().method() });
        body = body.replace(/<form id="application" action=/g, '<form id="application" method="post" enctype="multipart/form-data" action=');
        body += `<script>
          document.querySelector('form').addEventListener('input', event => {
            if (event.target.type !== 'file') fetch('/application/background/autosave', { method:'POST', body:event.target.value });
          });
          for (const input of document.querySelectorAll('input[type=file]')) input.addEventListener('change', () => {
            fetch('/application/background/upload', { method:'POST', body:input.files[0] });
          });
        </script>`;
      }
      await route.fulfill({ contentType: 'text/html', body });
    });
    await page.goto('https://fixture.career-ops.invalid/application/step/1');
    const result = await prepareOperationalApplicationForm(page, profile, fixture.value, {
      context, transitionTimeoutMs: 1_500, progressionSessionMs: 15_000,
    });
    return { page, result, browser, fixture, requests };
  } catch (error) {
    await browser.close();
    rmSync(fixture.dir, { recursive: true, force: true });
    throw error;
  }
}

test('realistic four-step form fills, advances three times, and stops before final Submit', { timeout: 30_000 }, async () => {
  const run = await runFixture();
  try {
    assert.equal(run.result.gate, undefined, JSON.stringify({ gate: run.result.gate, url: run.page.url(), progression: run.result.evidence.progression }));
    assert.equal(run.result.evidence.progression.stepsAdvanced, 3);
    assert.equal(run.result.evidence.finalAction.detected, true);
    assert.equal(run.result.evidence.finalAction.activated, false);
    assert.equal(run.result.evidence.reviewComplete, true);
    assert.equal(new URL(run.page.url()).pathname, '/application/step/4');
    assert.equal(await run.page.locator('#linkedin-final').inputValue(), profile.candidate.linkedin);
    assert.equal(await run.page.evaluate(() => window.fixtureFinalSubmits || 0), 0);
    await run.page.locator('#final-submit').click();
    assert.equal(await run.page.evaluate(() => window.fixtureFinalSubmits || 0), 1);
  } finally {
    await run.browser.close();
    rmSync(run.fixture.dir, { recursive: true, force: true });
  }
});

test('multi-step POSTs, upload requests, and autosave keep working without final activation', { timeout: 30_000 }, async () => {
  const run = await runFixture({ post: true });
  try {
    assert.equal(run.result.gate, undefined);
    assert.equal(run.result.evidence.progression.stepsAdvanced, 3);
    assert.deepEqual(run.requests.filter((request) => request.step > 1).map((request) => request.method), ['POST', 'POST', 'POST']);
    assert.ok(run.requests.some((request) => request.url?.endsWith('/autosave') && request.method === 'POST' && request.body === profile.candidate.email));
    const uploads = run.requests.filter((request) => request.url?.endsWith('/upload'));
    assert.equal(uploads.length, 2);
    assert.ok(uploads.every((request) => request.method === 'POST' && request.body === '%PDF fixture'));
    assert.equal(run.result.evidence.uploadedArtifacts.length, 2);
    assert.equal(await run.page.locator('#linkedin-final').inputValue(), profile.candidate.linkedin);
    assert.equal(run.result.evidence.finalAction.detected, true);
    assert.equal(run.result.evidence.finalAction.activated, false);
    assert.equal(await run.page.evaluate(() => window.fixtureFinalSubmits || 0), 0);
  } finally {
    await run.browser.close();
    rmSync(run.fixture.dir, { recursive: true, force: true });
  }
});

test('narrative provenance survives a real step transition after its field leaves the DOM', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  let annotateCalls = 0;
  let verifierCalls = 0;
  try {
    const page = await browser.newPage();
    await page.route('**/application/narrative-step/*', async (route) => {
      const step = Number(new URL(route.request().url()).pathname.split('/').pop());
      const body = step === 1
        ? `<div data-career-ops-wizard><p data-career-ops-step="1" data-career-ops-total-steps="2">Step 1 of 2</p>
          <form id="application" action="/application/narrative-step/2">
            <label>Why are you a good fit for this data engineering role?<textarea id="why-fit" required></textarea></label>
            <button id="continue" type="submit" aria-label="Continue application">Continue</button>
          </form></div>`
        : `<div data-career-ops-wizard><p data-career-ops-step="2" data-career-ops-total-steps="2">Step 2 of 2</p>
          <form id="application" action="/application/submit" method="post">
            <label>Email<input id="email" type="email" required></label>
            <button id="final-submit" type="submit">Submit application</button>
          </form></div><script>document.getElementById('application').addEventListener('submit',event=>{window.fixtureFinalSubmits=(window.fixtureFinalSubmits||0)+1;event.preventDefault();});</script>`;
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>${body}</body></html>` });
    });
    await page.goto('https://fixture.career-ops.invalid/application/narrative-step/1');
    const provider = {
      identity: { provider: 'fake', model: 'fake-luna' },
      annotate: async () => { annotateCalls += 1; throw new Error('deterministic narrative must not request annotation'); },
      verify: async () => { verifierCalls += 1; return { schemaVersion: 1, disposition: 'pass', findings: [] }; },
    };
    const result = await prepareOperationalApplicationForm(page, narrativeProfile, {}, {
      context,
      reasoningProvider: provider,
      transitionTimeoutMs: 1_500,
      progressionSessionMs: 15_000,
    });
    assert.equal(result.gate, undefined, JSON.stringify(result.gate));
    assert.equal(result.evidence.reviewComplete, true);
    assert.equal(result.evidence.progression.stepsAdvanced, 1);
    assert.equal(result.evidence.finalAction.detected, true);
    assert.equal(result.evidence.finalAction.activated, false);
    assert.equal(await page.locator('#why-fit').count(), 0);
    assert.equal(await page.locator('#email').inputValue(), profile.candidate.email);
    assert.equal(await page.evaluate(() => window.fixtureFinalSubmits || 0), 0);
    assert.equal(annotateCalls, 0);
    assert.equal(verifierCalls, 1);
    assert.equal(result.evidence.semanticVerification.disposition, 'passed');

    const records = result.evidence.answerRecords.filter((record) => (
      record.normalizedQuestion === 'why are you a good fit for this data engineering role'
    ));
    assert.equal(records.length, 1);
    assert.equal(records[0].candidateId, context.candidate.candidate_id);
    assert.equal(records[0].templateId, 'role-fit-v1');
    assert.match(records[0].answerHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(records[0].factualSources.length, 1);
    assert.equal(records[0].factualSources[0].configuredEvidenceId, 'warehouse-proof');
    assert.ok(result.evidence.reasoning.preparedAnswerSummary.some((row) => (
      row.normalizedQuestion === records[0].normalizedQuestion
      && row.category === 'custom_motivation_experience_narrative'
    )));
    assert.equal(JSON.stringify(result.evidence.reasoning).includes(records[0].answer), false);
  } finally {
    await browser.close();
  }
});

test('unchanged transition and visited-state loops stop safely', { timeout: 30_000 }, async () => {
  for (const options of [{ unchanged: true }, { loop: true }]) {
    const run = await runFixture(options);
    try {
      assert.equal(run.result.gate.state, 'review_required');
      assert.match(run.result.gate.reason, /transition|loop/i);
      assert.equal(run.result.evidence.finalAction.activated, false);
    } finally {
      await run.browser.close();
      rmSync(run.fixture.dir, { recursive: true, force: true });
    }
  }
});

test('maximum eight transitions hands off safely', { timeout: 30_000 }, async () => {
  assert.equal(MAX_PROGRESSION_TRANSITIONS, 8);
  const run = await runFixture({ total: 10 });
  try {
    assert.equal(run.result.gate.state, 'review_required');
    assert.match(run.result.gate.reason, /Maximum of 8/);
    assert.equal(run.result.evidence.progression.stepsAdvanced, 8);
    assert.equal(run.result.evidence.finalAction.activated, false);
  } finally {
    await run.browser.close();
    rmSync(run.fixture.dir, { recursive: true, force: true });
  }
});

test('CAPTCHA or login appearing later stops before another activation', { timeout: 30_000 }, async () => {
  for (const [options, state] of [[{ captchaAt: 3 }, 'blocked'], [{ loginAt: 3 }, 'login_required']]) {
    const run = await runFixture(options);
    try {
      assert.equal(run.result.gate.state, state);
      assert.equal(run.result.evidence.progression.stepsAdvanced, 2);
      assert.equal(run.result.evidence.finalAction.activated, false);
    } finally {
      await run.browser.close();
      rmSync(run.fixture.dir, { recursive: true, force: true });
    }
  }
});
