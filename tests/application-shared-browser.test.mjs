import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
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

function fixtureAuthority(events, states = {}) {
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
          candidates: [{ candidate_id: fixture.candidateId, state: states[fixture.batchId] || 'not_opened' }],
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

function mockBrowser(events) {
  let connected = true;
  let contextCount = 0;
  let closeCount = 0;
  const pages = [];
  const context = {
    newPage: async () => {
      assert.equal(pages.filter((page) => !page.closed).length, 0, 'close the previous candidate page before creating another');
      const page = {
        id: pages.length + 1,
        context: () => context,
        close: async () => {
          page.closed = true;
        },
        closed: false,
      };
      pages.push(page);
      events.push(`page:${page.id}`);
      return page;
    },
    pages: () => pages.filter((page) => !page.closed),
    close: async () => {
      throw new Error('Coordinator must not close the shared context');
    },
  };
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

test('one shared browser creates one active page at a time, isolates evidence, survives one failure, and stays open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-shared-browser-'));
  try {
    const events = [];
    const authority = fixtureAuthority(events, { [BATCH_IDS[0]]: 'blocked' });
    const mock = mockBrowser(events);
    let launches = 0;
    let active = 0;
    let maxActive = 0;
    let waited = false;
    const started = [];
    const completed = [];

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
        started.push({
          manifest: options.manifest,
          candidateId: options.candidateId,
          resumePreparation: options.resumePreparation,
          pageId: environment.page.id,
          pageCount: environment.context.pages().length,
        });
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
        if (environment.page.id === 3) throw new Error('fixture candidate failure');
        return {
          state: 'form_prepared',
          submissionAvailable: false,
          trackerUpdated: false,
        };
      },
      onCandidateComplete: async (entry) => {
        completed.push(entry.batchId);
      },
      waitForBrowserClose: async (browser) => {
        waited = true;
        assert.equal(browser.isConnected(), true);
      },
    });

    assert.equal(launches, 1);
    assert.deepEqual(mock.metrics(), { contextCount: 1, closeCount: 0 });
    assert.equal(mock.pages.length, 6);
    assert.ok(mock.pages.slice(0, -1).every((page) => page.closed === true));
    assert.equal(mock.pages.at(-1).closed, false, 'the final candidate page stays available for manual review');
    assert.equal(started.length, 6);
    assert.ok(started.every((row) => row.pageCount === 1));
    assert.deepEqual(started.map((row) => row.pageId), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(started.map((row) => row.resumePreparation), [true, false, false, false, false, false]);
    assert.equal(maxActive, 1);
    assert.deepEqual(completed, BATCH_IDS);
    assert.match(summary.completed[2].error, /fixture candidate failure/);
    assert.equal(summary.completed.filter((row) => row.state === 'form_prepared').length, 5);
    assert.equal(summary.browserRemainsOpen, true);
    assert.equal(summary.submissionAvailable, false);
    assert.equal(summary.trackerUpdated, false);
    assert.equal(waited, true);

    const ledgers = started.map((row) => {
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
    assert.deepEqual(ledgers.map((row) => row.value.pageId), [1, 2, 3, 4, 5, 6]);
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
