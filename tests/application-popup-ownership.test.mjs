import test from 'node:test';
import assert from 'node:assert/strict';
import { followSafeContinuation } from '../application-browser-executor.mjs';

const LISTING_URL = 'https://careers.acme.test/jobs/data-engineer';
const FORM_URL = `${LISTING_URL}/application`;
const CONTROL = {
  controlId: 'entry-popup', tag: 'button', type: 'button', text: 'Apply',
  visible: true, enabled: true, attached: true, topmostMatches: true,
};
const SCOPE = { listingUrl: LISTING_URL, currentState: 'listing_verified' };

function mockPage({ url = FORM_URL, opener = null, form = true } = {}) {
  const snapshot = {
    documentTitle: form ? 'Acme Data Engineer application' : '',
    headings: [], bodyText: form ? 'Application' : '',
    formCount: form ? 1 : 0,
    fields: form ? [
      { type: 'text', text: 'Full name', visible: true },
      { type: 'email', text: 'Email', visible: true },
    ] : [],
    controls: form ? [{ tag: 'button', type: 'submit', text: 'Submit application' }] : [],
  };
  return {
    snapshotCalls: 0, loadCalls: 0, closeCalls: 0, openerCalls: 0,
    url: () => url,
    opener: async function () { this.openerCalls += 1; return opener; },
    evaluate: async function () { this.snapshotCalls += 1; return snapshot; },
    waitForLoadState: async function () { this.loadCalls += 1; },
    waitForTimeout: async () => {},
    close: async function () { this.closeCalls += 1; },
  };
}

function fixture() {
  const active = mockPage({ url: LISTING_URL, form: false });
  const retained = mockPage({ url: LISTING_URL, form: false });
  let pages = [retained, active];
  let created = [];
  let clicks = 0;
  active.locator = () => ({
    count: async () => 1,
    evaluate: async () => CONTROL,
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { clicks += 1; pages = [...pages, ...created]; },
  });
  return {
    active, retained,
    createOnClick: (...popups) => { created = popups; },
    addPage: (popup) => { pages.push(popup); },
    follow: (observationWindowMs = 0) => followSafeContinuation(
      { pages: () => pages }, active, CONTROL, SCOPE, { observationWindowMs },
    ),
    getClicks: () => clicks,
  };
}

function assertIgnored(...pages) {
  for (const page of pages) {
    assert.equal(page.snapshotCalls, 0, 'unowned pages must never be snapshotted');
    assert.equal(page.loadCalls, 0, 'unowned pages must never be inspected for a destination');
    assert.equal(page.closeCalls, 0, 'unowned pages must never be closed');
  }
}

test('foreign and noopener popups are ignored while the active popup is selected and owned extras are closed', async () => {
  const f = fixture();
  const foreign = mockPage({ opener: f.retained });
  const noopener = mockPage();
  const own = mockPage({ opener: f.active });
  const extra = mockPage({ opener: f.active });
  // Foreign forms appear first, reproducing the shared-context selection race.
  f.createOnClick(foreign, noopener, own, extra);

  assert.equal(await f.follow(), own);
  assert.equal(f.getClicks(), 1);
  assert.ok(own.snapshotCalls > 0);
  assert.equal(own.closeCalls, 0);
  assert.equal(extra.closeCalls, 1);
  assert.equal(f.active.closeCalls, 0);
  assertIgnored(foreign, noopener, f.retained);
  assert.deepEqual(own.__careerOpsEntryInteractionEvidence.attempts[0].observation.observedUrls, [LISTING_URL, FORM_URL]);
});

test('foreign forms cannot end observation before a later owned popup appears', async () => {
  const f = fixture();
  const foreign = mockPage({ opener: f.retained, url: `${FORM_URL}/foreign` });
  const own = mockPage({ opener: f.active });
  f.createOnClick(foreign);
  let waits = 0;
  f.active.waitForTimeout = async () => {
    if (++waits === 1) f.addPage(own);
  };

  assert.equal(await f.follow(1_000), own);
  assertIgnored(foreign, f.retained);
  assert.equal(own.closeCalls, 0);
  assert.ok(waits > 0);
});

test('nested owned popups are selected through their opener chain and owned intermediates are cleaned up', async () => {
  const f = fixture();
  const intermediate = mockPage({ url: 'about:blank', opener: f.active, form: false });
  const nested = mockPage({ opener: intermediate });
  const foreignIntermediate = mockPage({ opener: f.retained, form: false });
  const foreignNested = mockPage({ opener: foreignIntermediate });
  f.createOnClick(foreignNested, foreignIntermediate, intermediate, nested);

  assert.equal(await f.follow(), nested);
  assert.equal(nested.closeCalls, 0);
  assert.equal(intermediate.closeCalls, 1);
  assertIgnored(foreignNested, foreignIntermediate, f.retained);
});

test('without an owned destination the flow fails closed and cleans up only owned popups', async () => {
  const f = fixture();
  const foreign = mockPage({ opener: f.retained, url: `${FORM_URL}/foreign` });
  const noopener = mockPage({ url: `${FORM_URL}/noopener` });
  const extra = mockPage({ url: 'about:blank', opener: f.active, form: false });
  f.createOnClick(foreign, noopener, extra);

  await assert.rejects(f.follow(), (error) => {
    assert.equal(error.code, 'application_entry_interaction_failed');
    assert.deepEqual(error.entryDiagnostics.attempts[0].observation.observedUrls, [LISTING_URL, 'about:blank']);
    return true;
  });
  assert.equal(extra.closeCalls, 1);
  assert.equal(f.active.closeCalls, 0);
  assertIgnored(foreign, noopener, f.retained);
});

test('unverifiable, cyclic and overlong opener chains fail closed without inspecting or closing pages', async () => {
  const f = fixture();
  const unavailable = mockPage();
  unavailable.opener = async () => { throw new Error('opener unavailable'); };
  const cyclic = mockPage();
  cyclic.opener = async () => cyclic;
  let distant = f.active;
  for (let index = 0; index < 5; index += 1) distant = mockPage({ opener: distant });
  f.createOnClick(unavailable, cyclic, distant);

  await assert.rejects(f.follow(), { code: 'application_entry_interaction_failed' });
  assert.equal(distant.openerCalls, 1);
  assertIgnored(unavailable, cyclic, distant, f.retained);
});
