import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  acquireBatchExecutionLock,
  bindCandidateArtifact,
  confirmPreflight,
  createApplicationBatch,
  loadBatchState,
  loadExecutionContract,
  loadPreparationContract,
  transitionCandidateState,
} from '../application-batch.mjs';
import { deriveCandidateId } from '../candidate-identity.mjs';
import {
  assertExecutorState,
  classifyFormSnapshot,
  executeCandidate,
  isCompatibleDestination,
  listingSnapshotConfirmsSafeEntry,
  parseExecutorArgs,
  preparationGateState,
  requisitionIdentity,
  selectSafeApplyContinuation,
  shouldKeepBrowserOpen,
  verifyVisibleIdentity,
} from '../application-browser-executor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const RUN_ID = 'phase-2-executor-run';
const SELECTED = 'https://job-boards.greenhouse.io/wolt/jobs/8035172';
const UNRELATED = 'https://fixture.invalid/jobs/unrelated-example';

test('job-identifying query parameters compare before URL sanitization', () => {
  for (const param of ['job', 'jobId', 'job_id', 'gh_jid', 'jid', 'id', 'req', 'requisition', 'posting']) {
    const listingUrl = `https://fixture.test/apply?${param}=111&access_token=secret`;
    const currentUrl = `https://fixture.test/apply?${param}=222`;
    assert.notEqual(requisitionIdentity(listingUrl), requisitionIdentity(currentUrl), param);
    assert.equal(isCompatibleDestination({ listingUrl, currentUrl, identity: { verified: true } }), false, param);
    assert.equal(requisitionIdentity(listingUrl), requisitionIdentity(`https://fixture.test/apply?${param}=111&access_token=changed`));
    assert.doesNotMatch(requisitionIdentity(listingUrl), /secret|access_token/);
  }
  assert.equal(requisitionIdentity('https://fixture.test/apply?lever-origin=111'), '');
});

function makeFixture(candidateOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-application-executor-'));
  const runDir = join(root, 'output', 'scan-runs', RUN_ID);
  mkdirSync(runDir, { recursive: true });
  const candidate = {
    company: 'Wolt', title: 'Backend Engineer', url: SELECTED, source: 'Greenhouse',
    recommendedCvVariant: 'software_backend', run_id: RUN_ID,
    ...candidateOverrides,
  };
  candidate.candidate_id = deriveCandidateId(candidate);
  writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify({ runId: RUN_ID, run_id: RUN_ID, candidates: 1 }, null, 2)}\n`);
  writeFileSync(join(runDir, 'candidates.json'), `${JSON.stringify([candidate], null, 2)}\n`);
  writeFileSync(join(root, 'output', 'apply-queue.csv'), `rank,company,role,url\n1,Legacy Example B,Engineer,${UNRELATED}\n`);
  const docs = join(root, 'output', 'documents');
  mkdirSync(docs, { recursive: true });
  const cv = join(docs, 'Alex Example Backend CV.pdf');
  writeFileSync(cv, 'executor-cv');
  return { root, candidate, cv };
}

function withFixture(callback) {
  const fixture = makeFixture();
  try {
    return callback(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function createConfirmed(fixture, batchId = 'confirmed-batch', options = {}) {
  const created = createApplicationBatch({
    root: fixture.root,
    sourceRunId: RUN_ID,
    batchId,
    selectedCandidateIds: [fixture.candidate.candidate_id],
    ...options,
  });
  bindCandidateArtifact(created.manifestPath, fixture.candidate.candidate_id, {
    root: fixture.root, artifactType: 'cv', filePath: fixture.cv,
  });
  confirmPreflight(created.manifestPath, batchId, { root: fixture.root });
  return created;
}

function makeAttemptFixture() {
  const fixture = makeFixture({
    company: 'Example Oy', url: 'https://jobs.example.test/backend-101', source: 'fixture-provider',
  });
  const created = createConfirmed(fixture, 'execution-attempts');
  for (const [artifactType, filename] of [
    ['cover_letter', 'Jane Example Cover Letter.pdf'],
    ['cover_letter_text', 'Jane Example Cover Letter.txt'],
  ]) {
    const filePath = join(fixture.root, 'output', 'documents', filename);
    writeFileSync(filePath, 'Fictional application document');
    bindCandidateArtifact(created.manifestPath, fixture.candidate.candidate_id, {
      root: fixture.root, artifactType, filePath,
    });
  }
  confirmPreflight(created.manifestPath, created.manifest.batchId, { root: fixture.root });
  const options = {
    manifest: created.manifestPath, candidateId: fixture.candidate.candidate_id,
    headless: true, keepOpen: false, prepareForm: false,
  };
  return { ...fixture, created, options };
}

function fakeAttemptBrowser(fixture, snapshotOverrides = {}) {
  let currentUrl = 'about:blank';
  let connected = true;
  const snapshot = {
    documentTitle: 'Example Oy Backend Engineer', headings: ['Example Oy Backend Engineer'],
    bodyText: 'Example Oy Backend Engineer application', formCount: 1,
    fields: [{ type: 'email', text: 'Email', visible: true }, { type: 'file', text: 'Resume', visible: true }],
    controls: [], applicationFormId: 'fictional-form', ...snapshotOverrides,
  };
  const frame = {};
  const page = Object.assign(new EventEmitter(), {
    url: () => currentUrl,
    mainFrame: () => frame,
    context: () => context,
    isClosed: () => false,
    goto: async (url) => {
      currentUrl = url;
      page.emit('framenavigated', frame);
      page.emit('domcontentloaded');
      return { status: () => 200 };
    },
    waitForLoadState: async () => {},
    waitForTimeout: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    evaluate: async (fn, args) => {
      if (String(fn).includes('document.documentElement?.innerHTML.length')) return currentUrl === 'about:blank';
      if (args?.gateOnly || String(fn).includes('__careerOpsEntryControlCounter')) return snapshot;
      if (String(fn).includes('document.body?.innerText')) return snapshot.bodyText;
      return [];
    },
  });
  const context = Object.assign(new EventEmitter(), { newPage: async () => page });
  const browser = { isConnected: () => connected, close: async () => { connected = false; } };
  return {
    browser, context, page,
    dependencies: {
      checkLivenessViaApi: async () => ({ result: 'active', reason: 'Fictional posting is live' }),
      launchBrowser: async () => browser,
      createContext: async () => context,
      checkUrlLiveness: async (target, url) => {
        assert.equal(url, fixture.candidate.url);
        await target.goto(url);
        return { result: 'active', reason: 'Fictional listing loaded' };
      },
    },
  };
}

function blockAttemptFixture(fixture) {
  const lock = acquireBatchExecutionLock(fixture.created.manifestPath, {
    root: fixture.root, candidateId: fixture.options.candidateId,
  });
  try {
    transitionCandidateState(fixture.created.manifestPath, fixture.options.candidateId, 'blocked', {
      root: fixture.root, currentUrl: fixture.candidate.url, reason: 'Initial fictional blocker',
      expectedFrom: 'not_opened', lockToken: lock.token,
    });
  } finally {
    lock.release();
  }
}

test('a transient pre-open liveness timeout records a retryable attempt', async () => {
  const fixture = makeAttemptFixture();
  try {
    const before = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state;
    const failure = Object.assign(new Error('Liveness request timed out'), { name: 'TimeoutError' });
    await assert.rejects(executeCandidate(fixture.options, {
      root: fixture.root,
      dependencies: { checkLivenessViaApi: async () => { throw failure; } },
    }), (error) => error === failure);
    const after = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state;
    const candidate = after.candidates[0];
    assert.equal(candidate.state, 'not_opened');
    assert.equal(after.revision, before.revision + 1);
    assert.equal(candidate.history.length, before.candidates[0].history.length + 1);
    assert.equal(candidate.history.at(-1).from, 'not_opened');
    assert.equal(candidate.history.at(-1).to, 'not_opened');
    assert.equal(candidate.history.at(-1).currentUrl, fixture.candidate.url);
    assert.equal(candidate.history.at(-1).reason, 'Transient failure before opening: Liveness request timed out');
    assert.deepEqual(candidate.history.at(-1).details, { attempt: 'pre_open', errorClass: 'timeout' });
    assert.equal(loadPreparationContract(fixture.created.manifestPath, fixture.options.candidateId,
      { root: fixture.root }).candidateState.state, 'not_opened');
    bindCandidateArtifact(fixture.created.manifestPath, fixture.options.candidateId, {
      root: fixture.root, artifactType: 'cv', filePath: fixture.cv, replace: true,
    });
    confirmPreflight(fixture.created.manifestPath, fixture.created.manifest.batchId, { root: fixture.root });
    const fake = fakeAttemptBrowser(fixture);
    const result = await executeCandidate(fixture.options, { root: fixture.root, dependencies: fake.dependencies });
    assert.equal(result.state, 'actual_form_reached');
    const retried = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state.candidates[0];
    assert.deepEqual(retried.history.map((entry) => entry.to),
      ['not_opened', 'not_opened', 'listing_verified', 'actual_form_reached']);
    assert.equal(fake.page.listenerCount('domcontentloaded'), 0);
    assert.equal(fake.page.listenerCount('framenavigated'), 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a failed resume from blocked records another blocked history entry', async () => {
  const fixture = makeAttemptFixture();
  try {
    blockAttemptFixture(fixture);
    const before = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state;
    const browser = { isConnected: () => true, close: async () => {} };
    const page = { url: () => 'about:blank' };
    const context = { newPage: async () => page };
    let result;
    let failure;
    try {
      result = await executeCandidate({ ...fixture.options, resumePreparation: true }, {
        root: fixture.root,
        dependencies: {
          checkLivenessViaApi: async () => ({ result: 'active', reason: 'Fictional posting is live' }),
          launchBrowser: async () => browser,
          createContext: async () => context,
          checkUrlLiveness: async () => { throw new Error('Fictional resume navigation failed'); },
        },
      });
    } catch (error) {
      failure = error;
    }
    const after = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state;
    assert.equal(after.candidates[0].history.length, before.candidates[0].history.length + 1,
      `Resume must persist its result; thrown error: ${failure?.message || 'none'}`);
    assert.equal(failure, undefined);
    assert.equal(result.state, 'blocked');
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.candidates[0].history.at(-1).from, 'blocked');
    assert.equal(after.candidates[0].history.at(-1).to, 'blocked');
    assert.match(after.candidates[0].history.at(-1).reason, /Preparation resume stopped safely: Fictional resume navigation failed/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('pre-open transient classification is limited to transport, liveness, and launch failures', async (t) => {
  const cases = [
    ['DNS code', { code: 'ENOTFOUND' }, 'liveness', 'dns'],
    ['DNS navigation', { message: 'page.goto: net::ERR_NAME_NOT_RESOLVED' }, 'navigation', 'dns'],
    ['connection refused', { code: 'ECONNREFUSED' }, 'liveness', 'connection'],
    ...['ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_ADDRESS_UNREACHABLE',
      'ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED', 'ERR_PROXY_CONNECTION_FAILED']
      .map((code) => [code, { code }, 'liveness', 'connection']),
    ['name resolution code', { code: 'ERR_NAME_RESOLUTION_FAILED' }, 'liveness', 'dns'],
    ['name resolution navigation', { message: 'net::ERR_NAME_RESOLUTION_FAILED' }, 'navigation', 'dns'],
    ...['ERR_ADDRESS_UNREACHABLE', 'ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED', 'ERR_PROXY_CONNECTION_FAILED']
      .map((code) => [`navigation ${code}`, { message: `page.goto: net::${code}` }, 'navigation', 'connection']),
    ['connection reset cause', { cause: { code: 'ECONNRESET' } }, 'liveness', 'connection'],
    ['browser connection reset', { message: 'net::ERR_CONNECTION_RESET' }, 'navigation', 'connection'],
    ['connection refused message', { message: 'Connection refused' }, 'navigation', 'connection'],
    ['transport timeout', { code: 'ETIMEDOUT' }, 'liveness', 'timeout'],
    ['navigation timeout', { name: 'TimeoutError', message: 'page.goto: Timeout 30000ms exceeded' }, 'navigation', 'timeout'],
    ['TLS code', { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'liveness', 'tls'],
    ['SSL navigation', { message: 'net::ERR_SSL_PROTOCOL_ERROR' }, 'navigation', 'tls'],
    ['TLS handshake message', { message: 'TLS handshake failed' }, 'liveness', 'tls'],
    ['certificate navigation', { message: 'net::ERR_CERT_AUTHORITY_INVALID' }, 'navigation', 'tls'],
    ['browser launch', { message: 'browserType.launch: Failed to launch the browser process!' }, 'browser', 'browser_launch'],
    ['context launch', { message: 'browser.newContext: Target page, context or browser has been closed' }, 'context', 'context_launch'],
    ['profile browser launch', { message: 'browserType.launchPersistentContext: Failed to launch the browser process!' }, 'profile', 'browser_launch'],
    ['browser spawn missing executable', { message: 'spawn fictional-browser ENOENT', code: 'ENOENT' }, 'browser', 'browser_launch'],
    ['browser spawn denied', { message: 'spawn fictional-browser EACCES', code: 'EACCES' }, 'browser', 'browser_launch'],
    ['structured spawn failure', { code: 'ENOENT', syscall: 'spawn fictional-browser' }, 'browser', 'browser_launch'],
    ['missing launch configuration file', { code: 'ENOENT', message: 'Missing fictional configuration file' }, 'browser', null],
    ['unreadable launch configuration file', { code: 'EACCES', syscall: 'open', message: 'Cannot read fictional configuration file' }, 'browser', null],
    ['launch timeout', { name: 'TimeoutError' }, 'browser', 'browser_launch'],
    ['context timeout', { message: 'browser.newContext: Timeout 30000ms exceeded' }, 'context', 'context_launch'],
    ['bare timeout word', { message: 'Unexpected timeout setting' }, 'navigation', null],
    ['timeout in URL only', { message: 'page.goto: Navigation failed at https://jobs.example.test/timeout-engineer-101' }, 'navigation', null],
    ['blocked timeout URL', { message: 'page.goto: net::ERR_BLOCKED_BY_ADMINISTRATOR at https://jobs.example.test/timeout-engineer-101' }, 'navigation', null],
    ['blocked timeout name', { name: 'TimeoutError', message: 'page.goto: net::ERR_BLOCKED_BY_ADMINISTRATOR; timed out' }, 'navigation', null],
    ['blocked with transient cause', { message: 'net::ERR_ACCESS_DENIED', cause: { code: 'ETIMEDOUT' } }, 'navigation', null],
    ['blocked structured code', { name: 'TimeoutError', code: 'ERR_BLOCKED_BY_ADMINISTRATOR' }, 'navigation', null],
    ['blocked structured net code', { name: 'TimeoutError', code: 'net::ERR_BLOCKED_BY_ADMINISTRATOR' }, 'navigation', null],
    ['non-network code in URL', { message: 'net::ERR_CONNECTION_RESET at https://jobs.example.test/net::ERR_BLOCKED_BY_ADMINISTRATOR' }, 'navigation', 'connection'],
    ['anchored timeout', { message: 'page.goto: Timeout 30000ms exceeded at https://jobs.example.test/engineer-101' }, 'navigation', 'timeout'],
    ...['browser', 'context', 'profile'].flatMap((stage) => [
      [`${stage} missing dependency`, { code: 'ERR_MODULE_NOT_FOUND', message: "Cannot find package 'playwright'" }, stage, null],
      [`${stage} import failure`, { message: 'Failed to import playwright' }, stage, null],
      ...['TypeError', 'ReferenceError', 'SyntaxError'].map((name) => [
        `${stage} ${name}`, { name, message: 'browserType.launch: Failed to launch due to fictional program bug' }, stage, null,
      ]),
      [`${stage} invalid options`, { message: 'browserType.launch: Invalid options' }, stage, null],
      [`${stage} option type error`, { message: 'browserType.launch: headless: expected boolean, got string' }, stage, null],
      [`${stage} invalid argument code`, { code: 'ERR_INVALID_ARG_TYPE', message: 'browserType.launch: Failed to launch' }, stage, null],
      [`${stage} unexpected error`, { message: 'Fictional process failed to start' }, stage, null],
    ]),
    ['unexpected error', { message: 'Unexpected fictional error' }, 'liveness', null],
    ['identity mismatch', { message: 'Candidate identity mismatch' }, 'liveness', null],
    ['unknown transport error', { message: 'Fictional transport failure' }, 'liveness', null],
    ['unrelated timeout', { name: 'TimeoutError', message: 'Locator inspection timed out' }, 'inspection', null],
    ['context configuration', { message: 'Unexpected context configuration failure' }, 'configuration', null],
  ];
  for (const [name, properties, stage, errorClass] of cases) {
    await t.test(name, async () => {
      const fixture = makeAttemptFixture();
      try {
        const failure = Object.assign(new Error('Fictional transport error'), properties);
        const fake = fakeAttemptBrowser(fixture);
        const fail = async () => { throw failure; };
        if (stage === 'liveness') fake.dependencies.checkLivenessViaApi = fail;
        if (stage === 'navigation') fake.dependencies.checkUrlLiveness = fail;
        if (stage === 'browser') fake.dependencies.launchBrowser = fail;
        if (stage === 'context') fake.dependencies.createContext = fail;
        if (stage === 'profile') fake.dependencies.openBrowserProfile = fail;
        if (stage === 'inspection') fake.dependencies.onCandidatePage = fail;
        if (stage === 'configuration') fake.dependencies.configureContext = fail;
        const before = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state;
        await assert.rejects(executeCandidate(fixture.options, {
          root: fixture.root, dependencies: fake.dependencies,
        }), (error) => error === failure);
        const after = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state;
        const entry = after.candidates[0].history.at(-1);
        assert.equal(after.revision, before.revision + 1);
        assert.equal(after.candidates[0].history.length, before.candidates[0].history.length + 1);
        assert.equal(entry.from, 'not_opened');
        assert.equal(entry.to, errorClass ? 'not_opened' : 'blocked');
        if (errorClass) assert.deepEqual(entry.details, { attempt: 'pre_open', errorClass });
        else assert.match(entry.reason, /^Candidate execution stopped safely before opening:/);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test('the liveness helper navigation-error result is audited as a bounded retryable attempt', async () => {
  const fixture = makeAttemptFixture();
  try {
    const fake = fakeAttemptBrowser(fixture);
    const failure = Object.assign(new Error(`page.goto: Timeout 30000ms exceeded ${'x'.repeat(600)}`), { name: 'TimeoutError' });
    fake.page.goto = async () => { throw failure; };
    delete fake.dependencies.checkUrlLiveness;
    await assert.rejects(executeCandidate(fixture.options, {
      root: fixture.root, dependencies: fake.dependencies,
    }), /navigation error: page.goto: Timeout/);
    const candidate = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state.candidates[0];
    assert.equal(candidate.state, 'not_opened');
    assert.equal(candidate.history.length, 2);
    assert.equal(candidate.reason.length, 500);
    assert.deepEqual(candidate.history.at(-1).details, { attempt: 'pre_open', errorClass: 'timeout' });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a transient failure after a candidate page loads cannot record a pre-open retry', async (t) => {
  for (const kind of ['domcontentloaded', 'committed_navigation', 'existing_shared_page', 'shared_API_failure', 'unobservable_page', 'after_listing_transition']) {
    await t.test(kind, async () => {
      const fixture = makeAttemptFixture();
      try {
        const fake = fakeAttemptBrowser(fixture);
        const failure = Object.assign(new Error('page liveness timed out after opening'), { name: 'TimeoutError' });
        if (['existing_shared_page', 'shared_API_failure'].includes(kind)) {
          await fake.page.goto(fixture.candidate.url);
          fake.dependencies.browserSession = { browser: fake.browser, context: fake.context, page: fake.page };
        }
        if (['domcontentloaded', 'committed_navigation'].includes(kind)) {
          const suppressed = kind === 'domcontentloaded' ? 'framenavigated' : 'domcontentloaded';
          const emit = fake.page.emit.bind(fake.page);
          fake.page.emit = (event, ...args) => event === suppressed ? false : emit(event, ...args);
        }
        if (kind === 'unobservable_page') {
          fake.page.url = () => { throw new Error('Fictional page URL is unavailable'); };
          fake.dependencies.checkUrlLiveness = async () => { throw failure; };
        }
        if (kind === 'after_listing_transition') {
          fake.dependencies.onCandidatePage = async () => {
            const candidate = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state.candidates[0];
            if (candidate.state === 'listing_verified') throw failure;
          };
        } else if (kind === 'shared_API_failure') {
          fake.dependencies.checkLivenessViaApi = async () => { throw failure; };
        } else if (kind !== 'unobservable_page') {
          fake.dependencies.checkUrlLiveness = async (page, url) => { await page.goto(url); throw failure; };
        }
        await assert.rejects(executeCandidate(fixture.options, {
          root: fixture.root, dependencies: fake.dependencies,
        }), (error) => error === failure);
        const candidate = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state.candidates[0];
        assert.equal(candidate.state, 'blocked');
        assert.equal(candidate.history.some((entry) => entry.from === 'not_opened' && entry.to === 'not_opened'), false);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test('shared blank documents and candidate popups bound pre-open retries', async (t) => {
  const cases = [
    ['empty shared document', 'about:blank', '', '', 'api', false],
    ['shared HTML without navigation', 'about:blank', '<main>Fictional form</main>', '', 'api', true],
    ['shared body text', 'about:blank', '', 'Fictional form', 'api', true],
    ['unreadable shared document', 'about:blank', '', '', 'evaluate_error', true],
    ['shared data URL', 'data:text/html,Fictional', '', '', 'api', true],
    ['shared file URL', 'file:///fictional-form.html', '', '', 'api', true],
    ['shared blank fragment', 'about:blank#fictional', '', '', 'api', true],
    ['unreadable shared URL', null, '', '', 'api', true],
    ['empty shared URL', '', '', '', 'api', true],
    ['popup during shared API request', 'about:blank', '', '', 'api_popup', true],
    ['popup during shared document check', 'about:blank', '', '', 'evaluate_popup', true],
    ['popup during owned navigation', 'about:blank', '', '', 'owned_popup', true],
  ];
  for (const [name, url, html, text, kind, loaded] of cases) {
    await t.test(name, async () => {
      const fixture = makeAttemptFixture();
      try {
        const fake = fakeAttemptBrowser(fixture);
        const failure = Object.assign(new Error('Fictional request timed out'), { name: 'TimeoutError' });
        fake.page.url = () => {
          if (url === null) throw new Error('Fictional URL access failed');
          return url;
        };
        fake.page.evaluate = async (fn) => {
          if (kind === 'evaluate_error') throw new Error('Fictional document access failed');
          if (kind === 'evaluate_popup') fake.context.emit('page', {});
          return runInNewContext(`(${fn})()`, {
            document: { documentElement: { innerHTML: html }, body: { innerText: text } },
          });
        };
        if (kind === 'owned_popup') {
          fake.dependencies.checkUrlLiveness = async () => {
            fake.context.emit('page', {});
            throw failure;
          };
        } else {
          fake.dependencies.browserSession = { browser: fake.browser, context: fake.context, page: fake.page };
          fake.dependencies.checkLivenessViaApi = async () => {
            if (kind === 'api_popup') fake.context.emit('page', {});
            throw failure;
          };
        }
        await assert.rejects(executeCandidate(fixture.options, {
          root: fixture.root, dependencies: fake.dependencies,
        }), (error) => error === failure);
        const candidate = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state.candidates[0];
        assert.equal(candidate.state, loaded ? 'blocked' : 'not_opened');
        assert.equal(candidate.history.length, 2);
        assert.equal(fake.context.listenerCount('page'), 0);
        assert.equal(fake.page.listenerCount('domcontentloaded'), 0);
        assert.equal(fake.page.listenerCount('framenavigated'), 0);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test('blocked resume audit failures preserve the original error and are attempted once', async (t) => {
  for (const kind of ['API_failure', 'launch_failure', 'navigation_failure', 'shared_navigation_failure']) {
    await t.test(kind, async () => {
      const fixture = makeAttemptFixture();
      const rename = fs.renameSync;
      try {
        blockAttemptFixture(fixture);
        const before = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state;
        const fake = fakeAttemptBrowser(fixture);
        const failure = new Error('Original fictional resume failure');
        const auditFailure = new Error('Fictional audit persistence failure');
        let auditWrites = 0;
        const fail = async () => {
          fs.renameSync = (source, destination) => {
            if (destination === fixture.created.statePath) {
              auditWrites += 1;
              throw auditFailure;
            }
            return rename(source, destination);
          };
          syncBuiltinESMExports();
          throw failure;
        };
        if (kind === 'API_failure') fake.dependencies.checkLivenessViaApi = fail;
        else if (kind === 'launch_failure') fake.dependencies.launchBrowser = fail;
        else fake.dependencies.checkUrlLiveness = fail;
        if (kind === 'shared_navigation_failure') {
          fake.dependencies.browserSession = { browser: fake.browser, context: fake.context, page: fake.page };
        }
        await assert.rejects(executeCandidate({ ...fixture.options, resumePreparation: true }, {
          root: fixture.root, dependencies: fake.dependencies,
        }), (error) => {
          assert.equal(error, failure);
          assert.equal(error.auditFailure, auditFailure);
          return true;
        });
        assert.equal(auditWrites, 1);
        assert.deepEqual(loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state, before);
      } finally {
        fs.renameSync = rename;
        syncBuiltinESMExports();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test('failed blocked listing revalidation and pre-browser resume failures are persisted', async (t) => {
  for (const kind of ['listing_revalidation', 'API_failure', 'launch_failure', 'shared_navigation_failure']) {
    await t.test(kind, async () => {
      const fixture = makeAttemptFixture();
      try {
        blockAttemptFixture(fixture);
        const before = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state;
        const fake = fakeAttemptBrowser(fixture, { headings: [], documentTitle: '', bodyText: 'Unrelated fictional posting' });
        const failure = new Error('Fictional resume failure');
        if (kind === 'API_failure') fake.dependencies.checkLivenessViaApi = async () => { throw failure; };
        if (kind === 'launch_failure') fake.dependencies.launchBrowser = async () => { throw failure; };
        if (kind === 'shared_navigation_failure') {
          fake.dependencies.browserSession = { browser: fake.browser, context: fake.context, page: fake.page };
          fake.dependencies.checkUrlLiveness = async () => { throw failure; };
        }
        const execution = executeCandidate({ ...fixture.options, resumePreparation: true }, {
          root: fixture.root, dependencies: fake.dependencies,
        });
        if (['API_failure', 'launch_failure'].includes(kind)) {
          await assert.rejects(execution, (error) => error === failure);
        } else {
          assert.equal((await execution).state, 'blocked');
        }
        const after = loadBatchState(fixture.created.manifestPath, { root: fixture.root }).state;
        assert.equal(after.revision, before.revision + 1);
        assert.equal(after.candidates[0].history.length, before.candidates[0].history.length + 1);
        const entry = after.candidates[0].history.at(-1);
        assert.equal(entry.from, 'blocked');
        assert.equal(entry.to, 'blocked');
        assert.match(entry.reason, kind === 'listing_revalidation'
          ? /^Preparation resume listing revalidation failed:/ : /^Preparation resume stopped safely: Fictional resume failure/);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test('executor requires a manifest and never falls back to global queue', () => withFixture((fixture) => {
  assert.throws(
    () => loadExecutionContract('output/application-batches/missing/manifest.json', UNRELATED, { root: fixture.root }),
    /manifest not found/,
  );
}));

test('executor accepts only the exact candidate ID and rejects URL authority', () => withFixture((fixture) => {
  const created = createConfirmed(fixture, 'exact-id');
  assert.equal(loadExecutionContract(created.manifestPath, fixture.candidate.candidate_id, { root: fixture.root }).candidate.listingUrl, SELECTED);
  assert.throws(
    () => loadExecutionContract(created.manifestPath, UNRELATED, { root: fixture.root }),
    /not a supported versioned candidate ID/,
  );
}));

test('executor fails before browser work when preflight, source, or artifacts drift', () => withFixture((fixture) => {
  const unconfirmed = createApplicationBatch({
    root: fixture.root, sourceRunId: RUN_ID, batchId: 'unconfirmed', selectedCandidateIds: [fixture.candidate.candidate_id],
  });
  assert.throws(
    () => loadExecutionContract(unconfirmed.manifestPath, fixture.candidate.candidate_id, { root: fixture.root }),
    /has not passed explicit preflight confirmation/,
  );

  const confirmed = createConfirmed(fixture, 'source-drift', {
    allowDuplicateReason: 'Exercise source drift independently of the unconfirmed fixture batch.',
  });
  const sourceCandidates = join(fixture.root, 'output', 'scan-runs', RUN_ID, 'candidates.json');
  writeFileSync(sourceCandidates, `${readFileSync(sourceCandidates, 'utf8')} `);
  assert.throws(
    () => loadExecutionContract(confirmed.manifestPath, fixture.candidate.candidate_id, { root: fixture.root }),
    /integrity mismatch/,
  );
}));

test('executor fails when the confirmed immutable source run disappears', () => withFixture((fixture) => {
  const created = createConfirmed(fixture, 'missing-source-run');
  rmSync(join(fixture.root, 'output', 'scan-runs', RUN_ID, 'candidates.json'));
  assert.throws(
    () => loadExecutionContract(created.manifestPath, fixture.candidate.candidate_id, { root: fixture.root }),
    /does not exist|lacks manifest\.json\/candidates\.json/,
  );
}));

test('post-confirmation manifest metadata tampering fails before browser work', () => withFixture((fixture) => {
  const created = createConfirmed(fixture, 'post-confirmation-manifest-tamper');
  const manifest = JSON.parse(readFileSync(created.manifestPath, 'utf8'));
  manifest.candidates[0].title = 'Different Unapproved Role';
  writeFileSync(created.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(
    () => loadExecutionContract(created.manifestPath, fixture.candidate.candidate_id, { root: fixture.root }),
    /manifest scope hash mismatch/,
  );
}));

test('a candidate-scoped runtime failure is recorded blocked and releases execution ownership', async () => {
  const fixture = makeFixture();
  try {
    const coverPdf = join(fixture.root, 'output', 'documents', 'Wolt Backend Engineer Cover Letter.pdf');
    const coverText = join(fixture.root, 'output', 'documents', 'Wolt Backend Engineer Cover Letter.txt');
    writeFileSync(coverPdf, 'executor-cover-pdf');
    writeFileSync(coverText, 'Executor cover text');
    const created = createApplicationBatch({
      root: fixture.root,
      sourceRunId: RUN_ID,
      batchId: 'runtime-failure',
      selectedCandidateIds: [fixture.candidate.candidate_id],
    });
    for (const binding of [
      { artifactType: 'cv', filePath: fixture.cv },
      { artifactType: 'cover_letter', filePath: coverPdf },
      { artifactType: 'cover_letter_text', filePath: coverText },
    ]) {
      bindCandidateArtifact(created.manifestPath, fixture.candidate.candidate_id, {
        root: fixture.root,
        ...binding,
      });
    }
    confirmPreflight(created.manifestPath, created.manifest.batchId, { root: fixture.root });
    let launches = 0;
    await assert.rejects(
      executeCandidate({
        manifest: created.manifestPath,
        candidateId: fixture.candidate.candidate_id,
        headless: true,
        keepOpen: false,
        resumeLogin: false,
        resumePreparation: false,
        prepareForm: false,
      }, {
        root: fixture.root,
        dependencies: {
          checkLivenessViaApi: async () => {
            throw new Error('fixture liveness transport failure');
          },
          launchBrowser: async () => {
            launches += 1;
            throw new Error('browser should not launch');
          },
        },
      }),
      /fixture liveness transport failure/,
    );
    assert.equal(launches, 0);
    const state = loadBatchState(created.manifestPath, { root: fixture.root }).state.candidates[0];
    assert.equal(state.state, 'blocked');
    assert.match(state.reason, /stopped safely before opening.*fixture liveness transport failure/i);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('executor CLI prefers candidate ID and exposes no submit, Applied, or queue option', () => {
  const candidateId = `cand_v1_${'a'.repeat(64)}`;
  assert.deepEqual(
    parseExecutorArgs(['--manifest', 'output/application-batches/x/manifest.json', '--candidate-id', candidateId]),
    { headless: false, keepOpen: true, resumeLogin: false, resumePreparation: false, prepareForm: true, ephemeralBrowser: false, manifest: 'output/application-batches/x/manifest.json', candidateId },
  );
  assert.throws(
    () => parseExecutorArgs(['--manifest', 'x', '--candidate-url', SELECTED]),
    /Unknown or forbidden option/,
  );
  assert.equal(parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--ephemeral-browser',
  ]).ephemeralBrowser, true);
  assert.throws(() => parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--ephemeral-browser', '--ephemeral-browser',
  ]), /Duplicate option/);
  for (const forbidden of ['--url', '--submit', '--send', '--mark-applied', '--queue']) {
    assert.throws(
      () => parseExecutorArgs(['--manifest', 'x', '--candidate-id', candidateId, forbidden, 'value']),
      /Unknown or forbidden option/,
    );
  }
  const source = readFileSync(join(REPO, 'application-browser-executor.mjs'), 'utf8');
  for (const forbidden of ['output/apply-queue.csv', 'scripts/mark-applied.mjs', 'set-status.mjs', 'data/applications.md']) {
    assert.equal(source.includes(forbidden), false);
  }
  assert.doesNotMatch(source, /storageState|connectOverCDP|wsEndpoint|browserWSEndpoint/);
});

test('normal preparation stays headed and open, while inspect-only may close or run headless', () => {
  const candidateId = `cand_v1_${'c'.repeat(64)}`;
  assert.throws(() => parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--close-after-check',
  ]), /headed browser that remains open/);
  assert.throws(() => parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--headless',
  ]), /headed browser that remains open/);
  assert.equal(parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--inspect-only', '--close-after-check',
  ]).keepOpen, false);
  assert.equal(parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--inspect-only', '--headless',
  ]).headless, true);
});

test('CAPTCHA gate states and browser pause lifecycle preserve review ownership', () => {
  assert.equal(preparationGateState({ gate: { state: 'blocked' } }), 'blocked');
  assert.equal(preparationGateState({ gate: { state: 'review_required' } }), 'review_required');
  assert.equal(preparationGateState({ gate: { state: 'login_required' } }), 'login_required');
  assert.equal(shouldKeepBrowserOpen({ state: 'review_required' }), true);
  assert.equal(shouldKeepBrowserOpen({
    state: 'blocked',
    formPreparation: { captcha: { manualActionRequired: true } },
  }), true);
  assert.equal(shouldKeepBrowserOpen({ state: 'blocked', formPreparation: null }), false);
  assert.equal(shouldKeepBrowserOpen({ state: 'abandoned' }), false);
});

test('login resume is bound to the same exact candidate and paused state', () => {
  const candidateId = `cand_v1_${'a'.repeat(64)}`;
  const options = parseExecutorArgs([
    '--manifest', 'output/application-batches/x/manifest.json', '--candidate-id', candidateId, '--resume-login',
  ]);
  assert.equal(options.resumeLogin, true);
  assert.equal(assertExecutorState(options, { candidateState: { state: 'login_required' } }), 'login_required');
  assert.throws(() => assertExecutorState(options, { candidateState: { state: 'not_opened' } }), /requires login_required/);
  assert.throws(() => parseExecutorArgs([
    '--manifest', 'x', '--candidate-url', SELECTED, '--resume-login',
  ]), /Unknown or forbidden option/);
  assert.throws(() => parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--resume-login', '--headless',
  ]), /headed (?:task )?browser/);
  assert.throws(() => parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--resume-login', '--close-after-check',
  ]), /remains open|remains? open/);
});

test('preparation resume is limited to the same candidate review/progress/blocked states', () => {
  const candidateId = `cand_v1_${'b'.repeat(64)}`;
  const options = parseExecutorArgs([
    '--manifest', 'output/application-batches/x/manifest.json', '--candidate-id', candidateId, '--resume-preparation',
  ]);
  assert.equal(options.resumePreparation, true);
  assert.equal(assertExecutorState(options, { candidateState: { state: 'review_required' } }), 'review_required');
  assert.equal(assertExecutorState(options, { candidateState: { state: 'actual_form_reached' } }), 'actual_form_reached');
  assert.equal(assertExecutorState(options, { candidateState: { state: 'blocked' } }), 'blocked');
  assert.throws(() => assertExecutorState(options, { candidateState: { state: 'not_opened' } }), /requires actual_form_reached, review_required, or blocked/);
  assert.throws(() => parseExecutorArgs([
    '--manifest', 'x', '--candidate-id', candidateId, '--resume-login', '--resume-preparation',
  ]), /one resume mode/);
});

test('visible identity requires both manifest company and title', () => {
  const candidate = { company: 'Wolt', title: 'Backend Engineer' };
  assert.equal(verifyVisibleIdentity({
    documentTitle: 'Backend Engineer | Wolt Careers', headings: ['Backend Engineer'], bodyText: 'Join Wolt.',
  }, candidate).verified, true);
  assert.equal(verifyVisibleIdentity({ bodyText: 'Generic engineering jobs' }, candidate).verified, false);
});

test('compound company identity accepts only meaningful explicit slash aliases', () => {
  const candidate = { company: '1KOMMA5° / Heartbeat AI', title: 'Energy Data Analyst' };
  assert.equal(verifyVisibleIdentity({
    documentTitle: 'Energy Data Analyst | Heartbeat AI', bodyText: 'Join Heartbeat AI.',
  }, candidate).verified, true);
  assert.equal(verifyVisibleIdentity({
    documentTitle: 'Energy Data Analyst', bodyText: 'Join an AI group.',
  }, candidate).verified, false);
  assert.equal(verifyVisibleIdentity({
    documentTitle: 'Different Role | 1KOMMA5°', bodyText: 'Join 1KOMMA5°.',
  }, candidate).verified, false);
});

test('visible company identity accepts omission of a legal corporate suffix', () => {
  const candidate = { company: 'Poppe + Potthoff GmbH', title: 'Junior Data Engineer (m/w/d)' };
  assert.equal(verifyVisibleIdentity({
    documentTitle: 'Junior Data Engineer (m/w/d) - Poppe + Potthoff Karriere',
    bodyText: 'Junior Data Engineer (m/w/d) Application form',
  }, candidate).verified, true);
});

test('fresh executor DOM may confirm a delayed safe entry without changing scanner liveness', () => {
  const listingUrl = 'https://www.linkedin.com/jobs/view/4449325899';
  const candidate = { company: 'Fluxion', title: 'Data Scientist / AI Engineer' };
  const snapshot = {
    currentUrl: listingUrl,
    documentTitle: 'Fluxion hiring Data Scientist / AI Engineer',
    bodyText: 'Fluxion Data Scientist / AI Engineer',
    formCount: 0,
    fields: [],
    controls: [{ tag: 'a', text: 'Apply', visible: true, href: `${listingUrl}/application` }],
  };
  assert.equal(listingSnapshotConfirmsSafeEntry(snapshot, candidate, { listingUrl }), true);
  assert.equal(listingSnapshotConfirmsSafeEntry({ ...snapshot, controls: [{
    tag: 'button', type: 'button', text: 'Apply', visible: true, dataDestination: listingUrl,
  }] }, candidate, { listingUrl }), true);
  assert.equal(listingSnapshotConfirmsSafeEntry({ ...snapshot, bodyText: 'Other company', documentTitle: 'Other company' }, candidate, { listingUrl }), false);
});

test('listing pages, login gates, and actual forms remain distinct', () => {
  assert.equal(classifyFormSnapshot({
    currentUrl: SELECTED, bodyText: 'Backend Engineer. Apply now.', formCount: 1,
    fields: [{ type: 'search', text: 'Search jobs', visible: true }],
  }).actualForm, false);
  const login = classifyFormSnapshot({
    currentUrl: 'https://careers.example.test/login', bodyText: 'Sign in to apply', formCount: 1,
    fields: [{ type: 'password', text: 'Password', visible: true }],
  });
  assert.equal(login.loginRequired, true);
  assert.equal(login.actualForm, false);
  assert.equal(classifyFormSnapshot({
    currentUrl: `${SELECTED}/application`, bodyText: 'Application for Backend Engineer', formCount: 1,
    fields: [
      { type: 'text', text: 'First name', visible: true },
      { type: 'email', text: 'Email', visible: true },
      { type: 'file', text: 'Resume', visible: true },
    ],
  }).actualForm, true);
});

test('opaque HRworks apply form is recognized by its bounded POST terminal structure', () => {
  assert.equal(classifyFormSnapshot({
    currentUrl: 'https://career.example.test/en/apply?id=47e8ae',
    bodyText: 'Junior Data Engineer Application form First name Last name Email Mobile number',
    formCount: 2,
    fields: Array.from({ length: 8 }, (_, index) => ({ type: 'text', text: `Mandatory field-${index}`, visible: true })),
    controls: [{
      tag: 'a', text: 'Submit application', visible: true, inForm: true,
      associatedForm: true, formMethod: 'post',
    }],
  }).actualForm, true);
});

test('safe listing entries are eligible and final controls remain unavailable', () => {
  const safe = {
    index: 0, tag: 'a', type: '', text: 'Apply now', href: 'https://jobs.lever.co/acme/application', inForm: false, visible: true,
  };
  const listingScope = {
    listingUrl: SELECTED,
    applyUrl: safe.href,
    currentState: 'listing_verified',
    actualFormReached: false,
    candidateFieldSignals: 0,
  };
  assert.deepEqual(selectSafeApplyContinuation([safe], listingScope), safe);
  assert.equal(selectSafeApplyContinuation([
    { ...safe, inForm: true },
    { ...safe, tag: 'button', type: 'submit', text: 'Apply' },
    { ...safe, text: 'Submit application' },
    { ...safe, text: 'Send' },
  ], { ...listingScope, actualFormReached: true }), null);
  assert.equal(selectSafeApplyContinuation([
    { ...safe, href: 'http://127.0.0.1/application' },
    { ...safe, href: 'mailto:jobs@example.test' },
    { ...safe, href: 'https://job-boards.greenhouse.io/submit-application' },
    { ...safe, href: 'https://unrelated.example.test/application' },
  ], { ...listingScope, applyUrl: null }), null);
});

test('cross-host redirects retain requisition identity checks', () => {
  const applyUrl = 'https://ats.example.test/application/123';
  assert.equal(isCompatibleDestination({ listingUrl: SELECTED, currentUrl: `${SELECTED}/application`, identity: { verified: false } }), true);
  assert.equal(isCompatibleDestination({ listingUrl: SELECTED, applyUrl, currentUrl: applyUrl, identity: { verified: false } }), true);
  assert.equal(isCompatibleDestination({
    listingUrl: SELECTED, currentUrl: 'https://job-boards.greenhouse.io/wolt/jobs/9999999', identity: { verified: false },
  }), false);
  assert.equal(requisitionIdentity(SELECTED), 'greenhouse:wolt:8035172');
  assert.equal(requisitionIdentity(`${SELECTED}/application`), 'greenhouse:wolt:8035172');
});

test('same-origin requisition mismatch cannot fall back to identical visible company and title', () => {
  const listingUrl = 'https://job-boards.greenhouse.io/fixture/jobs/111';
  const currentUrl = 'https://job-boards.greenhouse.io/fixture/jobs/222/application';
  assert.equal(isCompatibleDestination({ listingUrl, currentUrl, identity: { verified: true } }), false);
  assert.equal(isCompatibleDestination({ listingUrl, currentUrl: listingUrl+'/application', identity: { verified: true } }), true);
});
