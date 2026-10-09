import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  classifyApplicationEntryAction,
  classifyFormSnapshot,
  clearBenignListingSiteChrome,
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

test('listing-page anchor navigates to the verified form without dispatching its onclick', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const formUrl = 'https://careers.acme.test/jobs/data-engineer/application';
  await withFixture({
    [listingUrl]: '<h1>Acme Data Engineer</h1><p>Role description</p><a href="/jobs/data-engineer/application" onclick="sessionStorage.anchorClicks=Number(sessionStorage.anchorClicks||0)+1">Apply</a>',
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
    assert.equal(await page.evaluate(() => Number(sessionStorage.anchorClicks || 0)), 0);
    assert.equal(result.hops[0].activationMethod, 'verified_href_navigation');
  });
});

test('metadata-only Apply button advertising a known ATS hands off without executing saved-application JS', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const formUrl = 'https://jobs.lever.co/acme/data-engineer';
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1><p>Role description</p>
      <button data-apply-url="${formUrl}" type="button" onclick="window.applyClicks=(window.applyClicks||0)+1; fetch('/saved-application', {method:'POST'})">Apply</button>`,
    [formUrl]: FORM_HTML,
  }, async ({ context, page }) => {
    let posts = 0;
    page.on('request', (request) => { if (request.method() === 'POST') posts += 1; });
    await page.goto(listingUrl);
    const snapshot = await collectPageSnapshot(page);
    const result = await followSafeApplicationEntryFlow(context, page, snapshot, CANDIDATE, {
      listingUrl,
      applyUrl: formUrl,
    });
    assert.equal(result.form.actualForm, false);
    assert.equal(result.hops.length, 0);
    assert.equal(result.page.url(), listingUrl);
    assert.equal(result.manualReviewRequired, true);
    assert.match(result.reason, /anchor with a verified href.*metadata.*manual/);
    assert.equal(await page.evaluate(() => window.applyClicks || 0), 0);
    assert.equal(posts, 0);
  });
});

test('exact inspected entry identity survives duplicate Apply controls and DOM reordering', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const formUrl = `${listingUrl}/application`;
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1>
      <a href="${formUrl}" id="approved" onclick="sessionStorage.anchorClicks=Number(sessionStorage.anchorClicks||0)+1">Apply</a>
      <a href="${formUrl}" id="duplicate" onclick="sessionStorage.anchorClicks=Number(sessionStorage.anchorClicks||0)+1">Apply</a>`,
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
    assert.equal(result.hops[0].activationMethod, 'verified_href_navigation');
    assert.equal(await page.evaluate(() => Number(sessionStorage.anchorClicks || 0)), 0);
  });
});

test('bare Apply buttons and form-associated entry controls hand off without a click', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  for (const fixture of [
    { html: '<button id="apply" type="button" onclick="window.applyClicks=(window.applyClicks||0)+1">Apply</button>', reason: /anchor with a verified href/ },
    { html: '<button id="apply" type="button" onclick="window.applyClicks=(window.applyClicks||0)+1; location.href=\'/application\'">Apply</button>', reason: /anchor with a verified href/ },
    { html: '<button id="apply" type="button" formaction="/application" onclick="window.applyClicks=(window.applyClicks||0)+1">Apply</button>', reason: /anchor with a verified href/ },
    { html: '<a id="apply" data-apply-url="/application" onclick="window.applyClicks=(window.applyClicks||0)+1">Apply</a>', reason: /no verifiable href.*metadata/ },
    { html: '<form method="get" action="/application"><button id="apply" type="button" data-apply-url="/application" onclick="window.applyClicks=(window.applyClicks||0)+1">Apply</button></form>', reason: /form-associated/ },
    { html: '<form method="post" action="/application"><button id="apply" type="button" onclick="window.applyClicks=(window.applyClicks||0)+1">Apply</button></form>', reason: /POST-associated/ },
    { html: '<button id="apply" type="submit" data-apply-url="/application" onclick="window.applyClicks=(window.applyClicks||0)+1">Apply</button>', reason: /submit controls/ },
  ]) {
    await withFixture({ [listingUrl]: `<h1>Acme Data Engineer</h1>${fixture.html}` }, async ({ context, page }) => {
      await page.goto(listingUrl);
      const result = await followSafeApplicationEntryFlow(
        context, page, await collectPageSnapshot(page), CANDIDATE, { listingUrl },
      );
      assert.equal(await page.evaluate(() => window.applyClicks || 0), 0);
      assert.equal(result.page.url(), listingUrl);
      assert.equal(result.hops.length, 0);
      assert.equal(result.manualReviewRequired, true);
      assert.match(result.reason, fixture.reason);
    });
  }
});

test('Apply link to a verified ATS host still opens the application form', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const formUrl = 'https://jobs.lever.co/acme/data-engineer';
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1><a href="${formUrl}">Apply</a>`,
    [formUrl]: FORM_HTML,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const result = await followSafeApplicationEntryFlow(
      context, page, await collectPageSnapshot(page), CANDIDATE, { listingUrl },
    );
    assert.equal(result.form.actualForm, true, JSON.stringify({ reason: result.reason, siteChromeActions: result.siteChromeActions, diagnostics: result.diagnostics }));
    assert.equal(result.compatible, true);
    assert.equal(result.page.url(), formUrl);
    assert.equal(result.hops.length, 1);
  });
});

test('an apply URL cannot authorize an unrelated destination host', () => {
  const destination = 'https://unrelated.test/application';
  const classification = classifyApplicationEntryAction({
    tag: 'a', text: 'Apply', href: destination, visible: true,
  }, { listingUrl: 'https://careers.acme.test/jobs/123', applyUrl: destination, currentState: 'listing_verified' });
  assert.equal(classification.safe, false);
  assert.match(classification.reason, /selected company or a known ATS/);
});

test('bounded observation detects a delayed application form after href navigation', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const formUrl = `${listingUrl}/application`;
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1>
      <a href="${formUrl}">Apply now</a>`,
    [formUrl]: `<script>document.documentElement.innerHTML='<head><title></title></head><body></body>'; setTimeout(() => document.body.innerHTML='<h1>Acme Data Engineer</h1><form><label>First name <input name=first_name></label><label>Email <input type=email name=email></label><label>Resume <input type=file name=resume></label><button type=submit>Submit application</button></form>', 1200)</script>`,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const result = await followSafeApplicationEntryFlow(
      context, page, await collectPageSnapshot(page), CANDIDATE, { listingUrl, observationWindowMs: 3_000 },
    );
    assert.equal(result.form.actualForm, true);
    assert.equal(result.hops.length, 1);
    assert.equal(result.hops[0].activationMethod, 'verified_href_navigation');
    assert.equal(result.snapshot.controls.some((row) => row.text === 'Submit application'), true);
  });
});

test('privacy-preserving cookie clearance resnapshots before Apply opens the application', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const formUrl = `${listingUrl}/application`;
  await withFixture({
    [listingUrl]: `<style>
        #cmp { position: fixed; inset: 0; z-index: 100; background: white; }
      </style>
      <h1>Acme Data Engineer</h1>
      <a href="${formUrl}" id="apply">Apply</a>
      <div id="cmp" class="cookie-consent-banner"><p>Cookie preferences</p><button type="button" onclick="cmp.remove()">Only the necessary cookies</button></div>`,
    [formUrl]: FORM_HTML,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const clearance = await clearBenignListingSiteChrome(page);
    assert.equal(clearance.cleared, true);
    assert.equal(await page.locator('#cmp').count(), 0);
    const result = await followSafeApplicationEntryFlow(
      context, page, await collectPageSnapshot(page), CANDIDATE, { listingUrl },
    );
    assert.equal(result.form.actualForm, true, JSON.stringify({ reason: result.reason, siteChromeActions: result.siteChromeActions, diagnostics: result.diagnostics }));
    assert.equal(result.hops.length, 1);
    assert.deepEqual(clearance.actions.map((row) => row.label), ['only the necessary cookies']);
  });
});

test('asynchronously rendered privacy-minimal preferences are saved before Apply', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const formUrl = `${listingUrl}/application`;
  await withFixture({
    [listingUrl]: `<style>#cmp { position:fixed; inset:0; z-index:100; background:white; }</style>
      <h1>Acme Data Engineer</h1>
      <a href="${formUrl}" id="delayedApply">Apply</a>
      <div id="cmp" class="privacy-prompt">
        <button id="preferencesOpener" type="button" onclick="setTimeout(() => { preferencesOpener.hidden=true; preferences.hidden=false; }, 800)">Einstellungen oder ablehnen</button>
        <section id="preferences" class="consent-preferences" hidden><input type="checkbox" name="analytics">
          <button type="button" onclick="delayedApply.hidden=true; cmp.remove(); setTimeout(() => delayedApply.hidden=false, 800)">Speichern und Beenden</button>
        </section>
      </div>`,
    [formUrl]: FORM_HTML,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const clearance = await clearBenignListingSiteChrome(page);
    assert.equal(clearance.cleared, true);
    await page.locator('#delayedApply').waitFor({ state: 'visible' });
    const result = await followSafeApplicationEntryFlow(
      context, page, await collectPageSnapshot(page), CANDIDATE, { listingUrl },
    );
    assert.equal(result.form.actualForm, true, JSON.stringify({ reason: result.reason, siteChromeActions: result.siteChromeActions, diagnostics: result.diagnostics }));
    assert.deepEqual(clearance.actions.map((row) => row.label), [
      'einstellungen oder ablehnen', 'speichern und beenden',
    ]);
  });
});

test('duplicate responsive Apply selection prefers the independently actionable equivalent control', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const formUrl = `${listingUrl}/application`;
  await withFixture({
    [listingUrl]: `<style>
        #cover { position:absolute; left:0; top:50px; width:220px; height:80px; z-index:5; background:#fff; }
        #first { position:absolute; left:20px; top:70px; }
        #second { position:absolute; left:300px; top:70px; }
      </style>
      <h1>Acme Data Engineer</h1>
      <a href="${formUrl}" id="first" onclick="sessionStorage.clicked='first'">Apply</a>
      <div id="cover">Unrelated overlay</div>
      <a href="${formUrl}" id="second" onclick="sessionStorage.clicked='second'">Apply</a>`,
    [formUrl]: FORM_HTML,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const snapshot = await collectPageSnapshot(page);
    const secondControlId = await page.locator('#second').getAttribute('data-career-ops-entry-id');
    const result = await followSafeApplicationEntryFlow(
      context, page, snapshot, CANDIDATE, { listingUrl },
    );
    assert.equal(result.form.actualForm, true);
    assert.equal(result.hops[0].controlId, secondControlId);
    assert.equal(await page.evaluate(() => sessionStorage.clicked || ''), '');
    assert.equal(result.hops[0].duplicateCandidateCount, 2);
  });
});

test('verified href navigation observes an application dialog', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const formUrl = `${listingUrl}/application`;
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1>
      <a href="${formUrl}">Apply now</a>`,
    [formUrl]: '<h1>Acme Data Engineer</h1><div role=dialog aria-modal=true><label>Your name <input name=full_name></label><label>Email <input name=email></label><label>Send me email updates <input type=checkbox></label><button type=button>Apply</button></div>',
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const result = await followSafeApplicationEntryFlow(
      context, page, await collectPageSnapshot(page), CANDIDATE, { listingUrl },
    );
    assert.equal(result.page.url(), formUrl);
    assert.equal(result.form.actualForm, true);
    assert.equal(result.snapshot.applicationSurface.visibleDialogCount, 1);
  });
});

test('delayed StepStone authentication page is observed as a genuine post-entry login boundary', async () => {
  const listingUrl = 'https://www.stepstone.de/stellenangebote--data-engineer--123-inline.html';
  const authUrl = 'https://www.stepstone.de/job/123/application/authentication?locale=de_DE';
  const candidate = { company: 'Acme', title: 'Data Engineer' };
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1><a href="${authUrl}" id="apply" target="_blank" onclick="window.open('${authUrl}')">Ich bin interessiert</a>`,
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
    assert.equal(context.pages().length, 1);
    assert.match(result.reason, /Login gate reached/);
  });
});

test('StepStone harmonised entry label requires an anchor href', () => {
  const listingUrl = 'https://www.stepstone.de/stellenangebote--role--14207605-inline.html';
  const control = { tag: 'a', text: 'Ich bin interessiert', visible: true, href: listingUrl };
  assert.equal(classifyApplicationEntryAction(control, {
    listingUrl, currentState: 'listing_verified', actualFormReached: false, candidateFieldSignals: 0,
  }).safe, true);
  assert.equal(classifyApplicationEntryAction({ ...control, type: 'submit' }, {
    listingUrl, currentState: 'listing_verified', actualFormReached: false, candidateFieldSignals: 0,
  }).safe, false);
  assert.equal(classifyApplicationEntryAction({ ...control, tag: 'button', type: 'button', dataDestination: listingUrl }, {
    listingUrl, currentState: 'listing_verified',
  }).safe, false);
});

test('entry allowlist remains exact while semantic final actions stay forbidden', () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const classify = (text, type = 'button') => classifyApplicationEntryAction({
    tag: 'a', type, text, visible: true, href: listingUrl,
  }, {
    listingUrl, currentState: 'listing_verified', actualFormReached: false, candidateFieldSignals: 0,
  }).safe;
  for (const safe of ['Apply', 'Apply now', 'Apply here!', 'Apply for this job', 'Jetzt bewerben']) assert.equal(classify(safe), true, safe);
  for (const unsafe of ['Submit application', 'Apply and submit', 'Apply here and submit', 'Review and apply']) assert.equal(classify(unsafe), false, unsafe);
  assert.equal(classify('Apply', 'submit'), false);
});

function navigationFailureFixture({ reachesForm = false } = {}) {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer';
  const formUrl = `${listingUrl}/application`;
  const control = {
    controlId: 'entry-fixture', tag: 'a', text: 'Apply', visible: true,
    enabled: true, attached: true, topmostMatches: true, href: formUrl,
  };
  let clicks = 0;
  let navigations = 0;
  let currentUrl = listingUrl;
  let evaluatedSnapshot = {
    documentTitle: 'Acme Data Engineer', headings: ['Acme Data Engineer'], bodyText: 'Acme Data Engineer',
    formCount: 0, fields: [], controls: [control],
  };
  const locator = {
    count: async () => 1,
    evaluate: async () => control,
    scrollIntoViewIfNeeded: async () => {},
    waitFor: async () => {},
    click: async () => {
      clicks += 1;
      throw new Error('Entry controls must never be clicked');
    },
  };
  const page = {
    goto: async (url) => {
      assert.equal(url, formUrl);
      navigations += 1;
      if (reachesForm) {
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
      throw new Error('simulated navigation timeout');
    },
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
  return { context, page, listingUrl, control, getClicks: () => clicks, getNavigations: () => navigations, getSnapshot: () => ({ ...evaluatedSnapshot, currentUrl }) };
}

test('entry navigation timeout preserves a form reached despite the error without clicking', async () => {
  const fixture = navigationFailureFixture({ reachesForm: true });
  const result = await followSafeApplicationEntryFlow(
    fixture.context, fixture.page, fixture.getSnapshot(), CANDIDATE,
    { listingUrl: fixture.listingUrl, observationWindowMs: 5 },
  );
  assert.equal(result.form.actualForm, true);
  assert.equal(fixture.getNavigations(), 1);
  assert.equal(fixture.getClicks(), 0);
  assert.equal(result.snapshot.controls[0].text, 'Submit application');
});

test('verified href navigation failure requests manual review without a click fallback', async () => {
  const fixture = navigationFailureFixture();
  const result = await followSafeApplicationEntryFlow(
    fixture.context, fixture.page, fixture.getSnapshot(), CANDIDATE,
    { listingUrl: fixture.listingUrl, observationWindowMs: 5 },
  );
  assert.equal(fixture.getNavigations(), 1);
  assert.equal(fixture.getClicks(), 0);
  assert.equal(result.manualReviewRequired, true);
  assert.match(result.reason, /equivalent application-entry controls/);
  assert.deepEqual(result.diagnostics.candidates[0].attempts.map((row) => row.method), ['verified_href_navigation']);
  assert.equal(result.form.actualForm, false);
});

test('unsafe final action never enters interaction retry handling', async () => {
  const fixture = navigationFailureFixture();
  const snapshot = fixture.getSnapshot();
  snapshot.controls = [{ tag: 'button', type: 'button', text: 'Submit application', visible: true }];
  const result = await followSafeApplicationEntryFlow(
    fixture.context, fixture.page, snapshot, CANDIDATE,
    { listingUrl: fixture.listingUrl, observationWindowMs: 5 },
  );
  assert.equal(fixture.getClicks(), 0);
  assert.equal(fixture.getNavigations(), 0);
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

test('verified Greenhouse iframe for the exact gh_jid becomes the task page application form', async () => {
  const listingUrl = 'https://careers.acme.test/jobs/data-engineer?gh_jid=123';
  const embeddedUrl = 'https://job-boards.eu.greenhouse.io/embed/job_app?for=acme&token=123';
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1><iframe title="Greenhouse Job Board" src="${embeddedUrl}" style="width:800px;height:600px"></iframe><a href="#apply">Apply Now</a>`,
    [embeddedUrl]: FORM_HTML,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const result = await followSafeApplicationEntryFlow(
      context, page, await collectPageSnapshot(page), CANDIDATE, { listingUrl },
    );
    assert.equal(result.form.actualForm, true);
    assert.equal(result.compatible, true);
    assert.equal(result.page.url(), embeddedUrl);
    assert.equal(result.hops[0].controlId, 'verified-embedded-greenhouse-form');
    assert.equal(result.hops[0].activationMethod, 'verified_iframe_navigation');
  });
});

test('verified Greenhouse iframe with an exact listing backlink works without a gh_jid query', async () => {
  const listingUrl = 'https://careers.acme.test/careers/job/123';
  const embeddedUrl = `https://boards.eu.greenhouse.io/embed/job_app?for=acme&token=123&b=${encodeURIComponent(listingUrl)}`;
  await withFixture({
    [listingUrl]: `<h1>Acme Data Engineer</h1><iframe title="Greenhouse Job Board" src="${embeddedUrl}" style="width:800px;height:600px"></iframe><a href="#grnhse_app">Apply Now</a>`,
    [embeddedUrl]: FORM_HTML,
  }, async ({ context, page }) => {
    await page.goto(listingUrl);
    const result = await followSafeApplicationEntryFlow(
      context, page, await collectPageSnapshot(page), CANDIDATE, { listingUrl },
    );
    assert.equal(result.form.actualForm, true);
    assert.equal(result.compatible, true);
    assert.equal(result.page.url(), embeddedUrl);
    assert.equal(result.hops[0].controlId, 'verified-embedded-greenhouse-form');
    assert.equal(result.hops[0].activationMethod, 'verified_iframe_navigation');
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

test('an Apply link returning to the listing hands off without consuming the ATS second-hop allowance', async () => {
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
      { listingUrl, observationWindowMs: 100 },
    );
    assert.equal(result.form.actualForm, false);
    assert.equal(result.hops.length, 0);
    assert.equal(result.manualReviewRequired, true);
    assert.equal(result.diagnostics.candidates[0].attempts.length, 1);
    assert.match(result.reason, /could not reach the application surface/i);
  });
});
