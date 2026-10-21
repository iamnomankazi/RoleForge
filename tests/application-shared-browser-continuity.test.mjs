import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import {
  awaitManualFieldsInTerminal, continueReviewRequiredOnPage, executeCandidate,
  buildCandidateFormContext,
} from '../application-browser-executor.mjs';
import { runSharedBrowserSession } from '../application-shared-browser.mjs';
import {
  createApplicationBatch, bindCandidateArtifact, confirmPreflight, loadBatchState,
  acquireBatchExecutionLock,
} from '../application-batch.mjs';
import { deriveCandidateId } from '../candidate-identity.mjs';
import { prepareOperationalApplicationForm } from '../application-form-engine.mjs';
import { attachFactualSources } from './fixtures/application-evidence-profile.mjs';

function terminalPage() {
  const input = new PassThrough();
  input.isTTY = true;
  const browser = new EventEmitter();
  browser.connected = true;
  browser.isConnected = () => browser.connected;
  const page = new EventEmitter();
  page.closed = false;
  page.isClosed = () => page.closed;
  page.context = () => ({ browser: () => browser });
  page.bringToFront = async () => {};
  return { input, browser, page };
}

test('review continuation waits for each Enter, prints pass diagnostics, and stops at Review or a human gate', async () => {
  for (const end of ['form_prepared', 'human_action_required']) {
    const { input, browser, page } = terminalPage();
    const logs = [];
    let passes = 0;
    const continuation = continueReviewRequiredOnPage({
      page, browser, state: { state: 'review_required' },
      readPreparation: () => ({ unresolvedFields: [{ label: `Question ${passes}`, reason: 'Manual answer' }],
        validationErrors: [`Error ${passes}`] }),
      resume: async () => ({ state: ++passes === 2 ? end : 'review_required' }),
    }, { input, log: (line) => logs.push(line) });
    await new Promise(setImmediate);
    assert.equal(passes, 0);
    input.write('\n');
    await new Promise(setImmediate);
    assert.equal(passes, 1);
    assert.ok(logs.some((line) => line.includes('Question 1')));
    assert.ok(logs.some((line) => line.includes('Error 1')));
    input.write('\n');
    assert.equal((await continuation).state, end);
    assert.equal(passes, 2);
    assert.equal(page.listenerCount('close'), 0);
    assert.equal(browser.listenerCount('disconnected'), 0);
    input.destroy();
  }
});

test('closing the page or browser ends review continuation without another pass', async () => {
  for (const close of ['page', 'browser']) {
    const { input, browser, page } = terminalPage();
    let passes = 0;
    const continuation = continueReviewRequiredOnPage({
      page, browser, state: { state: 'review_required' }, readPreparation: () => ({}),
      resume: async () => { passes++; return { state: 'form_prepared' }; },
    }, { input, log() {} });
    await new Promise(setImmediate);
    if (close === 'page') { page.closed = true; page.emit('close'); }
    else { browser.connected = false; browser.emit('disconnected'); }
    assert.equal((await continuation).state, 'review_required');
    assert.equal(passes, 0);
    assert.equal(page.listenerCount('close'), 0);
    assert.equal(browser.listenerCount('disconnected'), 0);
    input.destroy();
  }
});

test('non-TTY and headless review passes keep the existing behavior', async () => {
  for (const headless of [false, true]) {
    const { input, browser, page } = terminalPage();
    input.isTTY = headless;
    const state = { state: 'review_required' };
    assert.equal(await continueReviewRequiredOnPage({
      page, browser, state, headless,
      readPreparation: () => assert.fail('must not prompt'), resume: () => assert.fail('must not resume'),
    }, { input, log: () => assert.fail('must not log') }), state);
    input.destroy();
  }
});

test('interactive manual fields wait beyond ten minutes and preserve the Enter log', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { input, page } = terminalPage();
  const logs = [];
  let settled = false;
  const wait = awaitManualFieldsInTerminal({ candidate: { company: 'Fixture', title: 'Engineer' } },
    ['Question', 'Question'], { page, input, log: (line) => logs.push(line) });
  wait.then(() => { settled = true; });
  t.mock.timers.tick(11 * 60 * 1000);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(logs.filter((line) => line === '  - Question').length, 1);
  input.write('\n');
  assert.equal(await wait, true);
  assert.ok(logs.some((line) => /Enter received at .*; re-checking the step\./.test(line)));
  input.destroy();
});

test('manual fields stop when the page or browser closes or terminal input ends', async () => {
  for (const close of ['page', 'browser', 'input']) {
    const { input, page, browser } = terminalPage();
    const wait = awaitManualFieldsInTerminal({ candidate: { company: 'Fixture', title: 'Engineer' } },
      ['Question'], { page, input, log() {} });
    if (close === 'page') { page.closed = true; page.emit('close'); }
    else if (close === 'browser') { browser.connected = false; browser.emit('disconnected'); }
    else input.end();
    assert.equal(await wait, false);
    assert.equal(page.listenerCount('close'), 0);
    assert.equal(browser.listenerCount('disconnected'), 0);
    input.destroy();
  }
});

function confirmedFixture() {
  const root = mkdtempSync(join(tmpdir(), 'roleforge-continuity-'));
  const runId = 'synthetic-continuity';
  const runDir = join(root, 'output', 'scan-runs', runId);
  mkdirSync(runDir, { recursive: true });
  const row = { company: 'Fixture Company', title: 'Backend Engineer',
    url: 'https://jobs.fixture.test/jobs/123', source: 'fixture',
    recommendedCvVariant: 'software_backend', run_id: runId };
  const candidate = { ...row, candidate_id: deriveCandidateId(row) };
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ runId, run_id: runId, candidates: 1 }));
  writeFileSync(join(runDir, 'candidates.json'), JSON.stringify([candidate]));
  const batch = createApplicationBatch({ root, sourceRunId: runId, batchId: 'continuity',
    selectedCandidateIds: [candidate.candidate_id] });
  const docs = join(root, 'output', 'documents');
  mkdirSync(docs, { recursive: true });
  for (const [artifactType, name] of [['cv', 'CV.pdf'], ['cover_letter', 'Cover.pdf'], ['cover_letter_text', 'Cover.txt']]) {
    const path = join(docs, name);
    writeFileSync(path, 'Synthetic fixture artifact.');
    bindCandidateArtifact(batch.manifestPath, candidate.candidate_id, { root, artifactType, filePath: path });
  }
  confirmPreflight(batch.manifestPath, batch.manifest.batchId, { root });
  return { root, batch, candidate,
    state: () => loadBatchState(batch.manifestPath, { root }).state.candidates[0],
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

for (const mode of ['shared', 'single']) {
for (const closePage of [false, true]) {
  test(`${mode} executor ${closePage ? 'ends the candidate cleanly when its page closes' : 'resumes the exact candidate twice on the same page without navigation, retaining lock checks and evidence'}`, { timeout: 60_000 }, async () => {
    const f = confirmedFixture();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const input = new PassThrough();
    input.isTTY = true;
    const pages = [];
    const navigations = [];
    const passes = [];
    const manualActions = [];
    const profile = attachFactualSources({ candidate: { full_name: 'Alex Example', email: 'alex@example.test' },
      cvText: 'Synthetic fixture CV.', answers: new Map(), priorApprovedAnswers: [], formRules: {} });
    context.on('page', (page) => {
      pages.push(page);
      page.on('framenavigated', (frame) => navigations.push(frame.url()));
    });
    await context.route('https://jobs.fixture.test/**', (route) => route.fulfill({ contentType: 'text/html', body: `
      <title>Fixture Company Backend Engineer</title><h1>Fixture Company Backend Engineer</h1>
      <form><label>Full name<input name="full_name" required></label><label>Email<input name="email" required></label>
      <label>Favorite constellation<input id="question1" required></label>
      <label>Preferred observatory<input id="question2" required></label>
      <button type="submit" onclick="window.finalClicks++">Submit application</button></form>
      <script>window.finalClicks=0;document.addEventListener('submit',e=>e.preventDefault())</script>` }));
    const dependencies = {
      input,
      checkLivenessViaApi: async () => ({ result: 'active', reason: 'Synthetic live listing' }),
      checkUrlLiveness: async (page, url) => {
        await page.goto(url);
        return { result: 'active', reason: 'Synthetic live listing' };
      },
      prepareFormPassWithEvidence: async (page, _context, contract, _root, options) => {
        assert.equal(contract.candidate.candidate_id, f.candidate.candidate_id);
        assert.throws(() => acquireBatchExecutionLock(f.batch.manifestPath,
          { root: f.root, candidateId: f.candidate.candidate_id, operation: 'competing-test' }), /lock|execut/i);
        passes.push({ page, options });
        return prepareOperationalApplicationForm(page, profile, {}, {
          ...options, context: buildCandidateFormContext(contract),
        });
      },
      log: (line) => {
        if (!line.startsWith('Fix these in the browser')) return;
        const pass = passes.length;
        assert.ok(pass === 1 || pass === 2, `unexpected prompt after ${pass} passes: ${f.state().reason}`);
        assert.equal(f.state().state, 'review_required');
        // Let the prompt subscribe before the synthetic user edits and presses Enter.
        manualActions.push(new Promise((resolve, reject) => setImmediate(async () => {
          try {
            assert.equal(passes.length, pass, 'no new form pass before Enter');
            if (closePage) await pages[0].close();
            else {
              await pages[0].locator(`#question${pass}`).fill(`Synthetic answer ${pass}`);
              input.write('\n');
            }
            resolve();
          } catch (error) { input.end(); reject(error); }
        })));
      },
      beforeBrowserClose: async () => {
        if (!pages[0].isClosed()) assert.equal(await pages[0].evaluate(() => window.finalClicks), 0);
      },
    };
    try {
      let result;
      if (mode === 'shared') {
        const summary = await runSharedBrowserSession({ batchIds: ['continuity'], root: f.root }, {
          input, log: dependencies.log,
          openBrowserProfile: async () => ({ browser, context }),
          executorDependencies: async () => dependencies,
          writeSummary() {}, waitForBrowserClose: async () => {},
        });
        result = summary.completed[0];
        assert.equal(result.resumeError, null);
      } else {
        result = await executeCandidate({ manifest: f.batch.manifestPath, candidateId: f.candidate.candidate_id,
          headless: false, keepOpen: true, prepareForm: true }, { root: f.root, dependencies: {
          ...dependencies, openBrowserProfile: async () => ({ browser, context, close: () => browser.close() }),
          waitForBrowserClose: async () => {},
        } });
      }
      await Promise.all(manualActions);
      assert.equal(result.state, closePage ? 'review_required' : 'form_prepared');
      assert.equal(pages.length, 1);
      assert.equal(passes.length, closePage ? 1 : 3);
      assert.ok(passes.every((pass) => pass.page === pages[0]));
      assert.deepEqual(passes.map((pass) => pass.options.resumeMode), closePage ? ['initial'] : ['initial', 'same_page_resume', 'same_page_resume']);
      assert.deepEqual(navigations, [f.candidate.url]);
      const state = f.state();
      assert.equal(state.formPreparationHistory.length, passes.length);
      assert.equal(new Set(state.formPreparationHistory.map((pass) => pass.passId)).size, passes.length);
      assert.ok(state.formPreparationHistory.every((pass) => pass.finalAction.activated === false));
      assert.equal(state.history.filter((event) => event.from === 'review_required' && event.to === 'actual_form_reached').length, closePage ? 0 : 2);
    } finally {
      input.destroy();
      await browser.close();
      f.cleanup();
    }
  });
}
}
