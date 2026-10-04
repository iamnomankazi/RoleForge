import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  classifyApplicationEntryAction,
  classifyFormSnapshot,
  collectPageSnapshot,
  followSafeApplicationEntryFlow,
  selectSafeApplyContinuation,
} from '../application-browser-executor.mjs';

const CANDIDATE = {
  company: 'Acme',
  title: 'Data Engineer',
};

const FORM_HTML = `<!doctype html>
<html><body>
  <h1>Acme Data Engineer</h1>
  <form action="/submit" method="post">
    <label>First name <input name="first_name"></label>
    <label>Email <input type="email" name="email"></label>
    <label>Resume <input type="file" name="resume"></label>
    <button id="final-apply" type="submit">Apply</button>
  </form>
</body></html>`;

async function withFixture(routes, callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      const body = routes[url];
      if (!body) return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' });
      return route.fulfill({ status: 200, contentType: 'text/html', body });
    });
    const page = await context.newPage();
    await callback({ context, page });
  } finally {
    await browser.close();
  }
}

test('listing-page anchor labelled Apply opens the verified actual form', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const formUrl = 'https://careers.acme.test/jobs/data-engineer/application';
  await withFixture({
    [listingUrl]: '<h1>Acme Data Engineer</h1><p>Role description</p><a href="/jobs/data-engineer/application">Apply</a>',
    [formUrl]: FORM_HTML,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const snapshot = await collectPageSnapshot(page);
    const result = await followSafeApplicationEntryFlow(context, page, snapshot, CANDIDATE, {
      listingUrl,
      applyUrl: formUrl,
    });
    assert.equal(result.form.actualForm, true);
    assert.equal(result.compatible, true);
    assert.equal(result.hops.length, 1);
    assert.equal(result.page.url(), formUrl);
  });
});

test('listing-page non-submitting button labelled Apply for this job opens the form', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const formUrl = 'https://careers.acme.test/jobs/data-engineer/application';
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1><p>Role description</p>
      <button type="button" onclick="window.location.href='${formUrl}'">Apply for this job</button>`,
    [formUrl]: FORM_HTML,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const snapshot = await collectPageSnapshot(page);
    const result = await followSafeApplicationEntryFlow(context, page, snapshot, CANDIDATE, {
      listingUrl,
      applyUrl: formUrl,
    });
    assert.equal(result.form.actualForm, true);
    assert.equal(result.hops.length, 1);
    assert.equal(result.hops[0].tag, 'button');
    assert.equal(result.page.url(), formUrl);
  });
});

test('exact inspected entry identity survives duplicate Apply controls and DOM reordering', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const formUrl = `${listingUrl}/application`;
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1>
      <button id="approved" type="button" onclick="location.href='${formUrl}'">Apply</button>
      <button id="duplicate" type="button" onclick="document.body.dataset.wrong='clicked'">Apply</button>`,
    [formUrl]: FORM_HTML,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const snapshot = await collectPageSnapshot(page);
    const selected = selectSafeApplyContinuation(snapshot.controls, {
      listingUrl, currentState: 'listing_verified', actualFormReached: false, candidateFieldSignals: 0,
    });
    assert.ok(selected.controlId);
    await page.evaluate(() => document.body.append(document.querySelector('#approved')));
    const result = await followSafeApplicationEntryFlow(context, page, snapshot, CANDIDATE, {
      listingUrl, applyUrl: formUrl,
    });
    assert.equal(result.form.actualForm, true);
    assert.equal(result.hops[0].controlId, selected.controlId);
    assert.equal(result.hops[0].duplicateCandidateCount, 2);
    assert.equal(result.hops[0].activationMethod, 'playwright_click');
  });
});

test('bounded observation detects a delayed same-page application form', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1>
      <button type="button" onclick="setTimeout(() => document.body.insertAdjacentHTML('beforeend', \`<form><label>First name <input name='first_name'></label><label>Email <input type='email' name='email'></label><label>Resume <input type='file' name='resume'></label><button type='submit'>Submit application</button></form>\`), 1200)">Apply now</button>`,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const result = await followSafeApplicationEntryFlow(
      context, page, await collectPageSnapshot(page), CANDIDATE, { listingUrl, observationWindowMs: 3_000 },
    );
    assert.equal(result.form.actualForm, true);
    assert.equal(result.hops.length, 1);
    assert.equal(result.hops[0].activationMethod, 'playwright_click');
    assert.equal(result.snapshot.controls.some((row) => row.text === 'Submit application'), true);
  });
});

test('privacy-preserving cookie clearance resnapshots before Apply opens the application', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  await withFixture({
    [listingUrl]: `<style>
        #cmp { position: fixed; inset: 0; z-index: 100; background: white; }
      </style>
      <h1>Acme Data Engineer</h1>
      <button id="apply" type="button" onclick="document.body.insertAdjacentHTML('beforeend', '<form><label>First name <input name=first_name></label><label>Email <input type=email name=email></label><label>Resume <input type=file name=resume></label><button type=submit>Submit application</button></form>')">Apply</button>
      <div id="cmp" class="cookie-consent-banner"><p>Cookie preferences</p><button type="button" onclick="cmp.remove()">Only the necessary cookies</button></div>`,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const result = await followSafeApplicationEntryFlow(
      context, page, await collectPageSnapshot(page), CANDIDATE, { listingUrl },
    );
    assert.equal(result.form.actualForm, true);
    assert.equal(result.hops.length, 1);
    assert.deepEqual(result.siteChromeActions.map((row) => row.label), ['only the necessary cookies']);
    assert.equal(await page.locator('#cmp').count(), 0);
  });
});

test('asynchronously rendered privacy-minimal preferences are saved before Apply', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  await withFixture({
    [listingUrl]: `<style>#cmp { position:fixed; inset:0; z-index:100; background:white; }</style>
      <h1>Acme Data Engineer</h1>
      <button id="delayedApply" type="button" onclick="document.body.insertAdjacentHTML('beforeend', '<form><label>First name <input name=first_name></label><label>Email <input name=email></label><label>Resume <input type=file name=resume></label><button type=submit>Submit</button></form>')">Apply</button>
      <div id="cmp" class="privacy-prompt">
        <button id="preferencesOpener" type="button" onclick="setTimeout(() => { preferencesOpener.hidden=true; preferences.hidden=false; }, 800)">Einstellungen oder ablehnen</button>
        <section id="preferences" class="consent-preferences" hidden><input type="checkbox" name="analytics">
          <button type="button" onclick="delayedApply.hidden=true; cmp.remove(); setTimeout(() => delayedApply.hidden=false, 800)">Speichern und Beenden</button>
        </section>
      </div>`,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const result = await followSafeApplicationEntryFlow(
      context, page, await collectPageSnapshot(page), CANDIDATE, { listingUrl },
    );
    assert.equal(result.form.actualForm, true);
    assert.deepEqual(result.siteChromeActions.map((row) => row.label), [
      'einstellungen oder ablehnen', 'speichern und beenden',
    ]);
  });
});

test('duplicate responsive Apply selection prefers the independently actionable equivalent control', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  await withFixture({
    [listingUrl]: `<style>
        #cover { position:absolute; left:0; top:50px; width:220px; height:80px; z-index:5; background:#fff; }
        #first { position:absolute; left:20px; top:70px; }
        #second { position:absolute; left:300px; top:70px; }
      </style>
      <h1>Acme Data Engineer</h1>
      <button id="first" type="button" onclick="document.body.dataset.clicked='first'">Apply</button>
      <div id="cover">Unrelated overlay</div>
      <button id="second" type="button" onclick="document.body.dataset.clicked='second'; document.body.insertAdjacentHTML('beforeend', '<form><label>First name <input name=first_name></label><label>Email <input type=email name=email></label><label>Resume <input type=file name=resume></label><button type=submit>Submit application</button></form>')">Apply</button>`,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const result = await followSafeApplicationEntryFlow(
      context, page, await collectPageSnapshot(page), CANDIDATE, { listingUrl },
    );
    assert.equal(result.form.actualForm, true);
    assert.equal(await page.evaluate(() => document.body.dataset.clicked), 'second');
    assert.equal(result.hops[0].duplicateCandidateCount, 2);
  });
});

test('same-page application dialog is a meaningful bounded application-surface transition', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1>
      <button type="button" onclick="document.body.insertAdjacentHTML('beforeend', '<div role=dialog aria-modal=true><label>Your name <input name=full_name></label><label>Email <input name=email></label><label>Send me email updates <input type=checkbox></label><button type=button>Apply</button></div>')">Apply now</button>`,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const result = await followSafeApplicationEntryFlow(
      context, page, await collectPageSnapshot(page), CANDIDATE, { listingUrl },
    );
    assert.equal(result.page.url(), listingUrl);
    assert.equal(result.form.actualForm, true);
    assert.equal(result.snapshot.applicationSurface.visibleDialogCount, 1);
  });
});

test('delayed StepStone authentication page is observed as a genuine post-entry login boundary', async () => {
  const listingUrl = 'https://www.stepstone.de/stellenangebote--data-engineer--123-inline.html';
  const authUrl = 'https://www.stepstone.de/job/123/application/authentication?locale=de_DE';
  const candidate = { company: 'Acme', title: 'Data Engineer' };
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1><button id="apply" type="button" onclick="window.open('${authUrl}')">Ich bin interessiert</button>`,
    [authUrl]: `<script>document.documentElement.innerHTML='<head><title></title></head><body></body>'; setTimeout(() => { document.title='Einloggen'; document.body.innerHTML='<h1>Acme Data Engineer</h1><p>Weiter mit E-Mail-Adresse oder Weiter als Gast</p><input type=email aria-label="E-Mail-Adresse eingeben"><button type=submit>Weiter mit E-Mail-Adresse</button><button type=button>Weiter als Gast</button>'; }, 900)</script>`,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const result = await followSafeApplicationEntryFlow(
      context, page, await collectPageSnapshot(page), candidate,
      { listingUrl, observationWindowMs: 3_000 },
    );
    assert.equal(result.form.loginRequired, true);
    assert.equal(result.compatible, true);
    assert.equal(result.hops.length, 1);
    assert.equal(result.page.url(), authUrl);
    assert.match(result.reason, /Login gate reached/);
  });
});

test('StepStone harmonised entry label is accepted only as a non-submit listing control', () => {
  const listingUrl = 'https://www.stepstone.de/stellenangebote--role--14207605-inline.html';
  const control = { tag: 'button', type: 'button', text: 'Ich bin interessiert', visible: true };
  assert.equal(classifyApplicationEntryAction(control, {
    listingUrl, currentState: 'listing_verified', actualFormReached: false, candidateFieldSignals: 0,
  }).safe, true);
  assert.equal(classifyApplicationEntryAction({ ...control, type: 'submit' }, {
    listingUrl, currentState: 'listing_verified', actualFormReached: false, candidateFieldSignals: 0,
  }).safe, false);
});

test('entry allowlist remains exact while semantic final actions stay forbidden', () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const classify = (text, type = 'button') => classifyApplicationEntryAction({
    tag: 'button', type, text, visible: true,
  }, {
    listingUrl, currentState: 'listing_verified', actualFormReached: false, candidateFieldSignals: 0,
  }).safe;
  for (const safe of ['Apply', 'Apply now', 'Apply here!', 'Apply for this job', 'Jetzt bewerben']) assert.equal(classify(safe), true, safe);
  for (const unsafe of ['Submit application', 'Apply and submit', 'Apply here and submit', 'Review and apply']) assert.equal(classify(unsafe), false, unsafe);
  assert.equal(classify('Apply', 'submit'), false);
});

function clickFailureFixture({ consequentialOnClick = null } = {}) {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const formUrl = `${listingUrl}/application`;
  const control = {
    controlId: 'entry-fixture', tag: 'button', type: 'button', text: 'Apply', visible: true,
    enabled: true, attached: true, topmostMatches: true,
  };
  let clicks = 0;
  let currentUrl = listingUrl;
  let evaluatedSnapshot = {
    documentTitle: 'Acme Data Engineer', headings: ['Acme Data Engineer'], bodyText: 'Acme Data Engineer',
    formCount: 0, fields: [], controls: [control],
  };
  const locator = {
    count: async () => 1,
    evaluate: async (_callback, operation) => {
      if (operation !== 'career-ops-exact-entry-click') return control;
      clicks += 1;
      if (clicks === consequentialOnClick) {
        currentUrl = formUrl;
        evaluatedSnapshot = {
          documentTitle: 'Acme Data Engineer application', headings: ['Acme Data Engineer'], bodyText: 'Application',
          formCount: 1,
          fields: [
            { type: 'text', text: 'First name', visible: true },
            { type: 'email', text: 'Email', visible: true },
            { type: 'file', text: 'Resume', visible: true },
          ],
          controls: [{ controlId: 'entry-final', tag: 'button', type: 'submit', text: 'Submit application', visible: true }],
        };
      }
      return null;
    },
    scrollIntoViewIfNeeded: async () => {},
    waitFor: async () => {},
    click: async (options = {}) => {
      if (options.trial) return;
      clicks += 1;
      if (clicks === consequentialOnClick) {
        currentUrl = formUrl;
        evaluatedSnapshot = {
          documentTitle: 'Acme Data Engineer application', headings: ['Acme Data Engineer'], bodyText: 'Application',
          formCount: 1,
          fields: [
            { type: 'text', text: 'First name', visible: true },
            { type: 'email', text: 'Email', visible: true },
            { type: 'file', text: 'Resume', visible: true },
          ],
          controls: [{ tag: 'button', type: 'submit', text: 'Submit application', visible: true }],
        };
      }
      throw new Error('simulated click timeout');
    },
  };
  const page = {
    url: () => currentUrl,
    locator: () => locator,
    evaluate: async () => evaluatedSnapshot,
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
  };
  const context = {
    pages: () => [page],
    waitForEvent: async () => null,
  };
  return { context, page, listingUrl, control, getClicks: () => clicks, getSnapshot: () => ({ ...evaluatedSnapshot, currentUrl }) };
}

test('entry click timeout is inspected before retry and preserves a form reached despite the error', async () => {
  const fixture = clickFailureFixture({ consequentialOnClick: 1 });
  const result = await followSafeApplicationEntryFlow(
    fixture.context, fixture.page, fixture.getSnapshot(), CANDIDATE,
    { listingUrl: fixture.listingUrl, observationWindowMs: 5 },
  );
  assert.equal(result.form.actualForm, true);
  assert.equal(fixture.getClicks(), 1);
  assert.equal(result.snapshot.controls[0].text, 'Submit application');
});

test('a second freshly revalidated attempt may succeed after the first has no effect', async () => {
  const fixture = clickFailureFixture({ consequentialOnClick: 2 });
  const result = await followSafeApplicationEntryFlow(
    fixture.context, fixture.page, fixture.getSnapshot(), CANDIDATE,
    { listingUrl: fixture.listingUrl, observationWindowMs: 5 },
  );
  assert.equal(result.form.actualForm, true);
  assert.equal(fixture.getClicks(), 2);
  assert.equal(result.hops[0].activationMethod, 'exact_dom_click');
});

test('verified safe entry interaction failure is bounded to two attempts and requests manual review', async () => {
  const fixture = clickFailureFixture();
  const result = await followSafeApplicationEntryFlow(
    fixture.context, fixture.page, fixture.getSnapshot(), CANDIDATE,
    { listingUrl: fixture.listingUrl, observationWindowMs: 5 },
  );
  assert.equal(fixture.getClicks(), 2);
  assert.equal(result.manualReviewRequired, true);
  assert.match(result.reason, /equivalent application-entry controls/);
  assert.deepEqual(result.diagnostics.candidates[0].attempts.map((row) => row.method), ['playwright_click', 'exact_dom_click']);
  assert.equal(result.form.actualForm, false);
});

test('unsafe final action never enters interaction retry handling', async () => {
  const fixture = clickFailureFixture();
  const snapshot = fixture.getSnapshot();
  snapshot.controls = [{ tag: 'button', type: 'button', text: 'Submit application', visible: true }];
  const result = await followSafeApplicationEntryFlow(
    fixture.context, fixture.page, snapshot, CANDIDATE,
    { listingUrl: fixture.listingUrl, observationWindowMs: 5 },
  );
  assert.equal(fixture.getClicks(), 0);
  assert.equal(result.manualReviewRequired, undefined);
  assert.match(result.reason, /No safe listing-page/);
});

test('company listing may use one verified known-ATS intermediate before the actual form', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const atsListingUrl = 'https://jobs.smartrecruiters.com/Acme/123-data-engineer';
  const formUrl = 'https://jobs.smartrecruiters.com/Acme/123-data-engineer/application';
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1><a href="${atsListingUrl}">Apply for this job</a>`,
    [atsListingUrl]: '<h1>Acme Data Engineer</h1><p>ATS role listing</p><a href="/Acme/123-data-engineer/application">Apply</a>',
    [formUrl]: FORM_HTML,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const result = await followSafeApplicationEntryFlow(
      context,
      page,
      await collectPageSnapshot(page),
      CANDIDATE,
      { listingUrl, applyUrl: atsListingUrl },
    );
    assert.equal(result.form.actualForm, true);
    assert.equal(result.compatible, true);
    assert.equal(result.hops.length, 2);
    assert.deepEqual(result.hops.map((hop) => hop.destinationUrl), [atsListingUrl, formUrl]);
  });
});

test('final form Apply and every submit-type button remain unreachable as entry actions', async () => {
  const formUrl = 'https://careers.acme.test/jobs/data-engineer/application';
  await withFixture({ [formUrl]: FORM_HTML }, async ({ page }) => {
    await page.goto(formUrl);
    const snapshot = await collectPageSnapshot(page);
    const form = classifyFormSnapshot(snapshot);
    assert.equal(form.actualForm, true);
    assert.equal(selectSafeApplyContinuation(snapshot.controls, {
      listingUrl: formUrl,
      applyUrl: formUrl,
      currentState: 'listing_verified',
      actualFormReached: form.actualForm,
      candidateFieldSignals: form.candidateFieldSignals,
    }), null);
    const submit = snapshot.controls.find((control) => control.text === 'Apply');
    assert.equal(classifyApplicationEntryAction(submit, {
      listingUrl: formUrl,
      currentState: 'listing_verified',
      actualFormReached: false,
      candidateFieldSignals: 0,
    }).safe, false);
  });
});

test('JavaScript-driven type=button Apply inside an actual application form is terminal and untouched', async () => {
  const formUrl = 'https://careers.acme.test/jobs/data-engineer/application';
  await withFixture({
    [formUrl]: `<h1>Acme Data Engineer</h1><form>
      <label>First name <input name="first_name"></label>
      <label>Email <input type="email" name="email"></label>
      <label>Resume <input type="file" name="resume"></label>
      <button id="terminal" type="button" onclick="window.terminalActivated=true">Apply</button>
    </form>`,
  }, async ({ context, page }) => {
    await page.goto(formUrl);
    const result = await followSafeApplicationEntryFlow(
      context, page, await collectPageSnapshot(page), CANDIDATE, { listingUrl: formUrl },
    );
    assert.equal(result.form.actualForm, true);
    assert.equal(result.hops.length, 0);
    assert.equal(await page.evaluate(() => Boolean(window.terminalActivated)), false);
  });
});

test('Apply CTA associated with a POST form remains blocked before any click', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1>
      <form method="post" action="/jobs/data-engineer/application">
        <button type="button">Apply now</button>
      </form>`,
  }, async ({ page }) => {
    await page.goto(listingUrl);
    const snapshot = await collectPageSnapshot(page);
    const control = snapshot.controls.find((row) => row.text === 'Apply now');
    const classification = classifyApplicationEntryAction(control, {
      listingUrl,
      currentState: 'listing_verified',
      actualFormReached: false,
      candidateFieldSignals: 0,
    });
    assert.equal(classification.safe, false);
    assert.match(classification.reason, /POST/);
  });
});

test('external or identity-mismatched entry destination is blocked', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const mismatchedUrl = 'https://jobs.smartrecruiters.com/Other/999-wrong-role';
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1><a href="${mismatchedUrl}">Apply</a>`,
    [mismatchedUrl]: '<h1>Other Company Marketing Manager</h1><p>Wrong role</p>',
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const result = await followSafeApplicationEntryFlow(
      context,
      page,
      await collectPageSnapshot(page),
      CANDIDATE,
      { listingUrl },
    );
    assert.equal(result.compatible, false);
    assert.equal(result.form.actualForm, false);
    assert.match(result.reason, /incompatible/i);
  });
  const external = {
    visible: true,
    tag: 'a',
    type: '',
    text: 'Apply',
    href: 'https://unrelated.example.test/apply',
  };
  assert.equal(classifyApplicationEntryAction(external, {
    listingUrl,
    currentState: 'listing_verified',
  }).safe, false);
});

test('repeated Apply loops stop after one click and never consume the ATS second-hop allowance', async () => {
  const listingUrl = 'https://jobs.smartrecruiters.com/Acme/123-data-engineer';
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1><p>ATS role listing</p><a href="${listingUrl}">Apply</a>`,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const result = await followSafeApplicationEntryFlow(
      context,
      page,
      await collectPageSnapshot(page),
      CANDIDATE,
      { listingUrl },
    );
    assert.equal(result.form.actualForm, false);
    assert.equal(result.hops.length, 1);
    assert.match(result.reason, /loop was prevented/i);
  });
});
