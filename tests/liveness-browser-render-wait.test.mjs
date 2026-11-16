import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUrlLiveness } from '../liveness-browser.mjs';
import { classifyLiveness } from '../liveness-core.mjs';

const WORKDAY_URL = 'https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/Engineer_R123';
const LOADING = 'Cookie preferences\nAccept cookies\n  Loading  \nPrivacy policy';
const JOB_TEXT = 'Software Engineer\nBuild and maintain services for our customers.\n'.repeat(15);

function fakePage(snapshots, { finalUrl = WORKDAY_URL, status = 200 } = {}) {
  const waits = [];
  const navigations = [];
  let bodyReads = 0;
  let controlReads = 0;
  let snapshot;
  return {
    waits,
    navigations,
    get bodyReads() { return bodyReads; },
    get controlReads() { return controlReads; },
    async goto(url, options) {
      navigations.push({ url, options });
      return { status: () => status };
    },
    url() { return finalUrl; },
    async waitForTimeout(ms) { waits.push(ms); },
    async evaluate(fn) {
      if (fn.toString().includes('document.body?.innerText')) {
        assert.equal(controlReads, 0, 'collect controls only after the body settles');
        const nextSnapshot = snapshots[Math.min(bodyReads, snapshots.length - 1)];
        bodyReads += 1;
        if (nextSnapshot instanceof Error) throw nextSnapshot;
        snapshot = nextSnapshot;
        return snapshot.bodyText;
      }
      assert.match(fn.toString(), /document\.querySelectorAll/);
      controlReads += 1;
      return snapshot.applyControls ?? [];
    },
  };
}

test('Workday Loading twice then a rendered job uses the final Apply control', async () => {
  const page = fakePage([
    { bodyText: LOADING },
    { bodyText: LOADING },
    { bodyText: JOB_TEXT, applyControls: ['Apply'] },
  ]);

  const result = await checkUrlLiveness(page, WORKDAY_URL);

  assert.equal(result.result, 'active');
  assert.equal(result.code, 'apply_control_visible');
  assert.deepEqual(page.waits, [2_000, 500, 500]);
  assert.equal(page.bodyReads, 3);
  assert.equal(page.controlReads, 1);
  assert.deepEqual(page.navigations, [{
    url: WORKDAY_URL,
    options: { waitUntil: 'domcontentloaded', timeout: 45_000 },
  }]);
});

test('persistent Loading stops at the default cap and preserves classification', async () => {
  const page = fakePage([{ bodyText: LOADING }]);

  const result = await checkUrlLiveness(page, WORKDAY_URL);

  assert.deepEqual(result, classifyLiveness({
    status: 200, finalUrl: WORKDAY_URL, bodyText: LOADING, applyControls: [],
  }));
  assert.equal(result.code, 'insufficient_content');
  assert.deepEqual(page.waits, [2_000, ...Array(20).fill(500)]);
  assert.equal(page.bodyReads, 21);
  assert.equal(page.controlReads, 1);
});

test('custom step is shortened to fit the cap and extra settle time is preserved', async () => {
  const page = fakePage([{ bodyText: LOADING }]);

  await checkUrlLiveness(page, WORKDAY_URL, {
    extraSettleMs: 3_000, renderWaitStepMs: 400, renderWaitMaxMs: 950,
  });

  assert.deepEqual(page.waits, [5_000, 400, 400, 150]);
  assert.equal(page.bodyReads, 4);
});

test('zero cap disables polling', async () => {
  const page = fakePage([{ bodyText: LOADING }]);

  await checkUrlLiveness(page, WORKDAY_URL, { renderWaitMaxMs: 0 });

  assert.deepEqual(page.waits, [2_000]);
  assert.equal(page.bodyReads, 1);
});

for (const host of ['myworkdayjobs.com', 'acme.wd3.myworkdayjobs.com', 'myworkdaysite.com', 'acme.myworkdaysite.com.']) {
  test(`short content on ${host} waits even without Loading`, async () => {
    const url = `https://${host}/Careers/job/Engineer`;
    const page = fakePage([
      { bodyText: 'Cookie preferences\nPrivacy policy' },
      { bodyText: JOB_TEXT, applyControls: ['Apply'] },
    ], { finalUrl: url });

    const result = await checkUrlLiveness(page, url);

    assert.equal(result.result, 'active');
    assert.deepEqual(page.waits, [2_000, 500]);
    assert.equal(page.bodyReads, 2);
  });
}

test('Loading line triggers polling on other hosts even with a long body', async () => {
  const url = 'https://example.com/job/123';
  const page = fakePage([
    { bodyText: `${JOB_TEXT}\n\tloading\r\n`, applyControls: [] },
    { bodyText: JOB_TEXT, applyControls: ['Apply'] },
  ], { finalUrl: url });

  const result = await checkUrlLiveness(page, url);

  assert.equal(result.result, 'active');
  assert.deepEqual(page.waits, [2_000, 500]);
});

for (const url of [WORKDAY_URL, 'https://example.com/job/123']) {
  test(`rendered content on ${new URL(url).hostname} has one body read and no polling`, async () => {
    const page = fakePage([{
      bodyText: `${JOB_TEXT}\nExperience loading data into services.`,
      applyControls: ['Apply'],
    }], { finalUrl: url });

    const result = await checkUrlLiveness(page, url);

    assert.equal(result.result, 'active');
    assert.deepEqual(page.waits, [2_000]);
    assert.equal(page.bodyReads, 1);
    assert.equal(page.controlReads, 1);
  });
}

for (const host of ['example.com', 'notmyworkdayjobs.com', 'myworkdaysite.com.example.com']) {
  test(`short content on unrelated host ${host} has no polling`, async () => {
    const url = `https://${host}/job/123`;
    const page = fakePage([{ bodyText: 'Short page' }], { finalUrl: url });

    await checkUrlLiveness(page, url);

    assert.deepEqual(page.waits, [2_000]);
    assert.equal(page.bodyReads, 1);
  });
}

test('rendered error text after Loading is classified after the bounded wait', async () => {
  const page = fakePage([
    { bodyText: LOADING },
    { bodyText: "The page you are looking for doesn't exist." },
  ]);

  const result = await checkUrlLiveness(page, WORKDAY_URL, { renderWaitMaxMs: 1_000 });

  assert.equal(result.result, 'expired');
  assert.equal(result.code, 'expired_body');
  assert.deepEqual(page.waits, [2_000, 500, 500]);
});

for (const status of [404, 410]) {
  test(`HTTP ${status} is classified before any render reads or waits`, async () => {
    const page = fakePage([
      { bodyText: "The page you are looking for doesn't exist." },
      new Error('Execution context was destroyed'),
    ], { status });

    const result = await checkUrlLiveness(page, WORKDAY_URL);

    assert.deepEqual(result, { result: 'expired', code: 'http_gone', reason: `HTTP ${status}` });
    assert.deepEqual(page.waits, []);
    assert.equal(page.bodyReads, 0);
    assert.equal(page.controlReads, 0);
  });
}

for (const startsLoading of [false, true]) {
  test(`polling failure preserves the last successful body${startsLoading ? ' after Loading' : ''}`, async () => {
    const bodyText = "The page you are looking for doesn't exist.";
    const page = fakePage([
      ...(startsLoading ? [{ bodyText: LOADING }] : []),
      { bodyText },
      new Error('Execution context was destroyed'),
    ]);

    const result = await checkUrlLiveness(page, WORKDAY_URL);

    assert.deepEqual(result, classifyLiveness({ status: 200, finalUrl: WORKDAY_URL, bodyText }));
    assert.equal(result.result, 'expired');
    assert.equal(result.code, 'expired_body');
    assert.deepEqual(page.waits, startsLoading ? [2_000, 500, 500] : [2_000, 500]);
    assert.equal(page.bodyReads, startsLoading ? 3 : 2);
    assert.equal(page.controlReads, 0);
  });
}

test('polling failure with only Loading evidence remains uncertain', async () => {
  const page = fakePage([
    { bodyText: LOADING },
    new Error('Execution context was destroyed'),
  ]);

  const result = await checkUrlLiveness(page, WORKDAY_URL);

  assert.deepEqual(result, classifyLiveness({ status: 200, finalUrl: WORKDAY_URL, bodyText: LOADING }));
  assert.equal(result.result, 'uncertain');
  assert.equal(result.code, 'insufficient_content');
});

test('initial body read failure still returns navigation_error', async () => {
  const page = fakePage([new Error('Execution context was destroyed')]);

  const result = await checkUrlLiveness(page, WORKDAY_URL);

  assert.deepEqual(result, {
    result: 'uncertain',
    code: 'navigation_error',
    reason: 'navigation error: Execution context was destroyed',
  });
  assert.equal(page.bodyReads, 1);
  assert.equal(page.controlReads, 0);
});
