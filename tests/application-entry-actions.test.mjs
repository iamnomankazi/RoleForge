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
