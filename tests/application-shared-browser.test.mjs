import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_SHARED_BROWSER_CANDIDATES,
  buildSharedBrowserPlan,
  parseSharedBrowserArgs,
  runSharedBrowserSession,
} from '../application-shared-browser.mjs';
import { executeCandidateInBrowserContext } from '../application-browser-executor.mjs';

const BATCH_IDS = [
  'eu4-2026-07-28-01-wolt-backend-engineer',
  'eu4-2026-07-28-02-reaktor-full-stack-developer',
  'eu4-2026-07-28-03-enpal-low-code-engineering-intern',
  'eu4-2026-07-28-04-enpal-ai-agents-automations-internship',
  'eu4-2026-07-28-05-manex-forward-deployed-engineer-internship',
  'eu4-2026-07-28-06-reonic-gtm-ai-data-intern',
];

function fixtureAuthority(events, states = {}, preparations = {}) {
  const byId = new Map(BATCH_IDS.map((batchId, index) => {
    const candidateId = `cand_v1_fixture_${String(index + 1).padStart(2, '0')}`;
    const candidate = {
      candidate_id: candidateId,
      company: `Company ${index + 1}`,
      title: `Role ${index + 1}`,
      listingUrl: `https://jobs.example.test/${index + 1}`,
      applyUrl: `https://apply.example.test/${index + 1}`,
      artifacts: {
        cv: { intendedFilename: `Company ${index + 1} Role ${index + 1} CV.pdf` },
        coverLetter: { intendedFilename: `Company ${index + 1} Role ${index + 1} Cover Letter.pdf` },
      },
    };
    return [batchId, { batchId, candidateId, candidate }];
  }));
  const identify = (manifestPath) => {
    const batchId = BATCH_IDS.find((value) => manifestPath.includes(value));
    if (!batchId) throw new Error(`Unknown fixture manifest: ${manifestPath}`);
    return byId.get(batchId);
  };
  return {
    loadState(manifestPath) {
      const fixture = identify(manifestPath);
      events.push(`state:${fixture.batchId}`);
      return {
        manifest: {
          batchId: fixture.batchId,
          expectedCandidateCount: 1,
          candidates: [{ candidate_id: fixture.candidateId }],
        },
        state: {
          candidates: [{
            candidate_id: fixture.candidateId,
            state: states[fixture.batchId] || 'not_opened',
            ...(preparations[fixture.batchId] ? { formPreparation: preparations[fixture.batchId] } : {}),
          }],
        },
      };
    },
    loadContract(manifestPath, candidateId) {
      const fixture = identify(manifestPath);
      events.push(`contract:${fixture.batchId}`);
      assert.equal(candidateId, fixture.candidateId);
      return {
        manifestPath,
        manifest: {
          batchId: fixture.batchId,
          expectedCandidateCount: 1,
          candidates: [{ candidate_id: fixture.candidateId }],
        },
        candidate: fixture.candidate,
        candidateState: {
          candidate_id: fixture.candidateId,
          state: states[fixture.batchId] || 'not_opened',
        },
      };
    },
  };
}

function mockBrowser(events, { startupPageCount = 0 } = {}) {
  let connected = true;
  let contextCount = 0;
  let closeCount = 0;
  const pages = [];
  let context;
  const makePage = (id) => {
    const page = {
      id,
      context: () => context,
      close: async () => {
        page.closed = true;
        events.push(`close:${id}`);
      },
      isClosed: () => page.closed,
      bringToFront: async () => {
        events.push(`front:${id}`);
      },
      closed: false,
    };
    return page;
  };
  context = {
    newPage: async () => {
      const page = makePage(pages.length + 1);
      pages.push(page);
      events.push(`page:${page.id}`);
      return page;
    },
    pages: () => pages.filter((page) => !page.closed),
    close: async () => {
      throw new Error('Coordinator must not close the shared context');
    },
  };
  for (let index = 0; index < startupPageCount; index += 1) {
    pages.push(makePage(pages.length + 1));
  }
  const browser = {
    isConnected: () => connected,
    newContext: async () => {
      contextCount += 1;
      events.push('context');
      return context;
    },
    once: () => {},
    close: async () => {
      closeCount += 1;
      connected = false;
    },
  };
  return {
    browser,
    context,
    pages,
    metrics: () => ({ contextCount, closeCount }),
  };
}

test('shared-browser parser requires ordered, unique exact batch IDs and caps the session at six', () => {
  assert.deepEqual(
    parseSharedBrowserArgs(BATCH_IDS.flatMap((batchId) => ['--batch-id', batchId])),
    { batchIds: BATCH_IDS },
  );
  assert.throws(
    () => parseSharedBrowserArgs(['--batch-id', BATCH_IDS[0], '--batch-id', BATCH_IDS[0]]),
    /Duplicate application batch IDs/,
  );
  assert.throws(
    () => parseSharedBrowserArgs(Array.from(
      { length: MAX_SHARED_BROWSER_CANDIDATES + 1 },
      (_, index) => ['--batch-id', `batch-${index}`],
    ).flat()),
    /at most 6/,
  );
  assert.throws(() => parseSharedBrowserArgs(['--manifest', 'anything']), /Unknown or forbidden/);
});

test('all six exact batches are independently verified before a browser can launch', () => {
  const events = [];
  const authority = fixtureAuthority(events);
  const plan = buildSharedBrowserPlan(BATCH_IDS, {
    root: 'C:\\fixture',
    ...authority,
  });
  assert.deepEqual(plan.map((entry) => entry.batchId), BATCH_IDS);
  assert.equal(events.length, 12);
  for (const batchId of BATCH_IDS) {
    assert.ok(events.includes(`state:${batchId}`));
    assert.ok(events.includes(`contract:${batchId}`));
  }
  assert.equal(new Set(plan.map((entry) => entry.candidateId)).size, 6);
  assert.equal(new Set(plan.map((entry) => entry.evidenceRoot)).size, 6);
});

test('a previously blocked exact candidate is planned as preparation-resume, not restarted', () => {
  const events = [];
  const authority = fixtureAuthority(events, { [BATCH_IDS[0]]: 'blocked' });
  const plan = buildSharedBrowserPlan(BATCH_IDS, {
    root: 'C:\\fixture',
    ...authority,
  });
  assert.equal(plan[0].resumePreparation, true);
  assert.ok(plan.slice(1).every((entry) => entry.resumePreparation === false));
});

test('candidate tabs stay open, failures are isolated, human handoffs resume after pass one, and the summary persists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-shared-browser-'));
  try {
    const events = [];
    const authority = fixtureAuthority(events, { [BATCH_IDS[0]]: 'blocked' }, {
      [BATCH_IDS[0]]: {
        unresolvedFields: [{ label: 'Work authorization' }],
        captcha: { present: true, completed: false },
        userActionRequired: true,
      },
    });
    const mock = mockBrowser(events, { startupPageCount: 1 });
    let launches = 0;
    let active = 0;
    let maxActive = 0;
    let waited = false;
    const started = [];
    const completed = [];
    const resumeLog = [];

    const summary = await runSharedBrowserSession({ batchIds: BATCH_IDS, root }, {
      ...authority,
      launchBrowser: async () => {
        launches += 1;
        events.push('launch');
        assert.equal(events.filter((event) => event.startsWith('contract:')).length, 6);
        return mock.browser;
      },
      executeCandidate: async (options, environment) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const pass = options.continueOnPage ? 'resume' : 'prepare';
        const row = {
          manifest: options.manifest,
          candidateId: options.candidateId,
          resumePreparation: options.resumePreparation,
          deferHumanHandoff: options.deferHumanHandoff,
          continueOnPage: options.continueOnPage,
          pageId: environment.page.id,
          pageCount: environment.context.pages().length,
          pass,
        };
        started.push(row);
        events.push(`execute:${row.candidateId}:${pass}`);
        if (pass === 'resume') {
          assert.equal(options.continueOnPage, true);
          assert.equal(options.deferHumanHandoff, false);
          assert.equal(started.filter((item) => item.pass === 'prepare').length, 6, 'all first passes finish before resume');
          assert.equal(row.pageId, started.find((item) => item.candidateId === row.candidateId && item.pass === 'prepare').pageId);
          active -= 1;
          return { state: 'human_action_required', resumeSkipped: 'fixture unsafe' };
        }
        const evidenceDir = join(
          dirname(options.manifest),
          'evidence',
          options.candidateId,
          'fixture-pass',
        );
        mkdirSync(evidenceDir, { recursive: true });
        writeFileSync(join(evidenceDir, 'attempt-ledger.json'), JSON.stringify({
          candidateId: options.candidateId,
          pageId: environment.page.id,
          finalActionActivated: false,
        }));
        await new Promise((resolveTurn) => setImmediate(resolveTurn));
        active -= 1;
        if (options.candidateId === 'cand_v1_fixture_03') throw new Error('fixture candidate failure');
        if (options.candidateId === 'cand_v1_fixture_01') {
          assert.equal(options.deferHumanHandoff, true);
          return { state: 'human_action_required', deferred: true };
        }
        // e.g. a document that had to be handed off for manual upload: the session moves on to the next candidate.
        if (options.candidateId === 'cand_v1_fixture_04') return { state: 'review_required' };
        return {
          state: 'form_prepared',
          submissionAvailable: false,
          trackerUpdated: false,
        };
      },
      onCandidateComplete: async (entry) => {
        completed.push(entry.batchId);
      },
      log: (message) => resumeLog.push(message),
      waitForBrowserClose: async (browser) => {
        waited = true;
        assert.equal(browser.isConnected(), true);
      },
    });

    assert.equal(launches, 1);
    assert.deepEqual(mock.metrics(), { contextCount: 1, closeCount: 0 });
    assert.equal(mock.pages.length, 7);
    assert.equal(mock.pages[0].closed, false, 'startup page is not closed by the coordinator');
    assert.deepEqual(mock.pages.slice(1).map((page) => page.closed), [false, false, true, false, false, false]);
    assert.equal(started.length, 7);
    assert.deepEqual(started.slice(0, 6).map((row) => row.pageCount), [2, 3, 4, 4, 5, 6]);
    assert.deepEqual(started.map((row) => row.pageId), [2, 3, 4, 5, 6, 7, 2]);
    assert.deepEqual(started.slice(0, 6).map((row) => row.resumePreparation), [true, false, false, false, false, false]);
    assert.ok(started.slice(0, 6).every((row) => row.deferHumanHandoff === true));
    assert.equal(started[6].pass, 'resume');
    assert.match(resumeLog[0], /\[1\/6\] Company 1 — Role 1: complete the check in this tab, then press Enter here/);
    assert.ok(events.indexOf('execute:cand_v1_fixture_06:prepare') < events.indexOf('execute:cand_v1_fixture_01:resume'));
    assert.equal(maxActive, 1);
    assert.deepEqual(completed, BATCH_IDS);
    assert.match(summary.completed[2].error, /fixture candidate failure/);
    assert.equal(summary.completed[0].state, 'human_action_required');
    assert.equal(summary.completed[0].pass1State, 'human_action_required');
    assert.equal(summary.completed[0].resumeSkipped, 'fixture unsafe');
    assert.equal(summary.completed[0].tabOpen, true);
    assert.deepEqual(summary.completed[0].needsHuman, {
      unresolvedFieldLabels: ['Work authorization'],
      captcha: true,
      userActionRequired: true,
    });
    assert.equal(summary.completed[2].tabOpen, false);
    assert.equal(summary.completed[3].state, 'review_required');
    assert.equal(summary.completed[3].tabOpen, true, 'a review-required tab stays open for the user');
    assert.ok(events.indexOf('execute:cand_v1_fixture_04:prepare') < events.indexOf('execute:cand_v1_fixture_05:prepare'));
    assert.equal(summary.completed.filter((row) => row.state === 'form_prepared').length, 3);
    assert.equal(summary.browserRemainsOpen, true);
    assert.equal(summary.submissionAvailable, false);
    assert.equal(summary.trackerUpdated, false);
    assert.equal(waited, true);

    const sessionsRoot = join(root, 'output', 'application-sessions');
    const sessionDirs = readdirSync(sessionsRoot);
    assert.equal(sessionDirs.length, 1);
    assert.match(sessionDirs[0], /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    const persistedSummary = JSON.parse(readFileSync(join(sessionsRoot, sessionDirs[0], 'summary.json'), 'utf8'));
    assert.deepEqual(persistedSummary, summary);
    assert.equal(persistedSummary.submissionAvailable, false);
    assert.equal(persistedSummary.trackerUpdated, false);

    const ledgers = started.slice(0, 6).map((row) => {
      const batchId = BATCH_IDS.find((value) => row.manifest.includes(value));
      const path = join(
        root,
        'output',
        'application-batches',
        batchId,
        'evidence',
        row.candidateId,
        'fixture-pass',
        'attempt-ledger.json',
      );
      return { path, value: JSON.parse(readFileSync(path, 'utf8')) };
    });
    assert.equal(new Set(ledgers.map((row) => relative(root, row.path))).size, 6);
    assert.deepEqual(ledgers.map((row) => row.value.pageId), [2, 3, 4, 5, 6, 7]);
    assert.ok(ledgers.every((row) => row.value.finalActionActivated === false));
    for (const { value } of ledgers) {
      const serialized = JSON.stringify(value);
      assert.doesNotMatch(serialized, /cookie|storageState|localStorage|sessionStorage|private-cookie-value/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared executor entrypoint rejects missing ownership and cross-context pages before candidate work', async () => {
  await assert.rejects(
    executeCandidateInBrowserContext({ candidateId: 'cand_v1_fixture' }),
    /existing browser, context, and exact candidate page/,
  );
  const context = {};
  await assert.rejects(
    executeCandidateInBrowserContext({
      candidateId: 'cand_v1_fixture',
      resumeLogin: true,
    }, {
      browser: {},
      context,
      page: { context: () => context },
    }),
    /Explicit --manifest path is required/,
  );
  await assert.rejects(
    executeCandidateInBrowserContext({
      candidateId: 'cand_v1_fixture',
    }, {
      browser: {},
      context,
      page: { context: () => ({}) },
    }),
    /does not belong/,
  );
});

test('shared coordinator exposes no queue, final-submission, or tracker authority', () => {
  const source = readFileSync(new URL('../application-shared-browser.mjs', import.meta.url), 'utf8');
  const executorSource = readFileSync(new URL('../application-browser-executor.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /apply-queue\.csv|application-submission\.mjs|set-status\.mjs|data[\\/]applications\.md/i);
  assert.doesNotMatch(source, /\.submit\(|requestSubmit\(|getByRole\(['"]button['"].*submit/i);
  assert.doesNotMatch(`${source}\n${executorSource}`, /storageState|\.cookies\(/i);
  assert.match(source, /submissionAvailable: false/);
  assert.match(source, /trackerUpdated: false/);
});

test('an unexpected coordinator failure still closes the owned profile session and releases its lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-shared-browser-'));
  try {
    const events = [];
    const authority = fixtureAuthority(events);
    const mock = mockBrowser(events);
    let sessionCloses = 0;
    await assert.rejects(runSharedBrowserSession({ batchIds: BATCH_IDS.slice(0, 1), root }, {
      ...authority,
      openBrowserProfile: async () => ({
        browser: mock.browser,
        context: await mock.browser.newContext(),
        close: async () => { sessionCloses += 1; },
      }),
      executeCandidate: async () => ({ state: 'review_required' }),
      writeSummary: async () => { throw new Error('summary disk full'); },
      waitForBrowserClose: async () => {},
    }), /summary disk full/);
    assert.equal(sessionCloses, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
