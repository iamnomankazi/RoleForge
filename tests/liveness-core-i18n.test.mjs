import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLiveness } from '../liveness-core.mjs';

const liveBody = 'Role details and responsibilities. '.repeat(12);

test('Finnish, Swedish, and German closed posting wording is expired', () => {
  const closedWording = [
    'Pahoittelut, haku tähän avoimeen työpaikkaan on päättynyt',
    'Haku on päättynyt',
    'Hakuaika on päättynyt',
    'Ilmoitus on vanhentunut',
    'Työpaikkailmoitus ei ole enää voimassa',
    'Ansökningstiden har gått ut',
    'Annonsen har gått ut',
    'Diese Stelle ist nicht mehr verfügbar',
    'Die Stellenanzeige ist abgelaufen',
    'Bewerbungsfrist ist abgelaufen',
  ];

  for (const bodyText of closedWording) {
    assert.equal(classifyLiveness({ status: 200, bodyText }).result, 'expired', bodyText);
  }
});

test('future closing dates remain active when an apply control is visible', () => {
  for (const bodyText of ['Haku päättyy 29.11.', 'Päättyy 15.12.', 'Bewerbungsfrist: 30.11.']) {
    const result = classifyLiveness({ status: 200, bodyText: `${bodyText} ${liveBody}`, applyControls: ['Apply'] });
    assert.equal(result.result, 'active', bodyText);
    assert.equal(result.code, 'apply_control_visible', bodyText);
  }
});

test('conditional and future recruitment process clauses do not expire a live posting', () => {
  const processWording = [
    'Haku päättyy 29.11. Kun hakuaika on päättynyt, otamme yhteyttä hakijoihin.',
    'Kun haku tähän avoimeen työpaikkaan on päättynyt, käsittelemme hakemukset.',
    'Jos haku on päättynyt, voit jättää avoimen hakemuksen.',
    'Mikäli hakuaika on päättynyt, otamme yhteyttä hakijoihin.',
    'Sen jälkeen, kun hakuaika on päättynyt, haastattelemme hakijoita.',
    'Hakuajan päättymisen jälkeen otamme yhteyttä hakijoihin.',
    'We contact candidates after the application period has closed.',
    'We contact candidates after applications have closed.',
    'Once applications close, we contact candidates.',
    'Once applications are closed, we contact candidates.',
    'When this job is no longer available, we will contact candidates.',
    'Nach Ablauf der Bewerbungsfrist kontaktieren wir die Bewerber.',
  ];

  for (const bodyText of processWording) {
    const result = classifyLiveness({ status: 200, bodyText, applyControls: ['Hae paikkaa'] });
    assert.equal(result.result, 'active', bodyText);
    assert.equal(result.code, 'apply_control_visible', bodyText);
  }
});

test('definitive closure notices still win over process wording and apply controls', () => {
  for (const bodyText of [
    'Kun hakuaika on päättynyt, otamme yhteyttä hakijoihin. Hakuaika on päättynyt.',
    'Kun hakuaika on päättynyt, otamme yhteyttä hakijoihin; hakuaika on päättynyt.',
    'Hakuaika on päättynyt. Kun hakuaika on päättynyt, otamme yhteyttä hakijoihin.',
    'After applications have closed, we review candidates. Applications have closed.',
    'Nach Ablauf der Bewerbungsfrist kontaktieren wir Bewerber. Die Bewerbungsfrist ist abgelaufen.',
  ]) {
    const result = classifyLiveness({ status: 200, bodyText, applyControls: ['Apply'] });
    assert.equal(result.result, 'expired', bodyText);
    assert.equal(result.code, 'expired_body', bodyText);
  }
});

test('Finnish, Swedish, and German apply labels are recognized as visible controls', () => {
  const labels = [
    'Hae paikkaa',
    'Hae työpaikkaa',
    'Hae helposti',
    'Siirry hakemaan',
    'Hae nyt',
    'Ansök',
    'Sök jobbet',
    'Jetzt bewerben',
    'Bewerben',
  ];

  for (const label of labels) {
    const result = classifyLiveness({ status: 200, bodyText: liveBody, applyControls: [label] });
    assert.equal(result.result, 'active', label);
    assert.equal(result.code, 'apply_control_visible', label);
  }
});

test('bare Finnish search labels do not count as apply controls', () => {
  for (const label of ['Hae', 'Hae Hae', '  Hae  Hae  Hae  ']) {
    const listing = classifyLiveness({ status: 200, bodyText: '25 jobs found', applyControls: [label] });
    assert.equal(listing.result, 'uncertain', label);
    assert.equal(listing.code, 'listing_page', label);

    const posting = classifyLiveness({ status: 200, bodyText: liveBody, applyControls: [label] });
    assert.equal(posting.result, 'uncertain', label);
    assert.equal(posting.code, 'no_apply_control', label);
  }
  assert.notEqual(classifyLiveness({ status: 200, bodyText: 'Haetaan' }).result, 'active');
  assert.notEqual(classifyLiveness({ status: 200, bodyText: liveBody, applyControls: ['Haetaan'] }).result, 'active');
  assert.notEqual(classifyLiveness({ status: 200, bodyText: liveBody, applyControls: ['Haku'] }).result, 'active');
});

test('concatenated accessible labels preserve explicit application controls', () => {
  for (const label of ['Hae paikkaa', 'Hae työpaikkaa', 'Hae helposti', 'Siirry hakemaan', 'Hae nyt', 'Ansök', 'Bewerben']) {
    for (const control of [`${label} ${label}`, `  ${label} \n ${label}  ${label}  `, `${label}\t${label}`.replace(/ /g, '  ')]) {
      const result = classifyLiveness({ status: 200, bodyText: liveBody, applyControls: [control] });
      assert.equal(result.result, 'active', control);
      assert.equal(result.code, 'apply_control_visible', control);
    }
  }
});

test('Workday missing pages require a Workday final URL host', () => {
  const missingPage = 'The page you are looking for doesn\'t exist.';

  for (const host of ['myworkdayjobs.com', 'acme.wd5.myworkdayjobs.com', 'myworkdaysite.com', 'acme.myworkdaysite.com.']) {
    for (const bodyText of [missingPage, 'The page you are looking for does not exist.', `${liveBody} ${missingPage}`]) {
      const result = classifyLiveness({
        status: 200,
        finalUrl: `https://${host}/en-US/Careers/job/123`,
        bodyText,
        applyControls: ['Apply'],
      });
      assert.equal(result.result, 'expired', host);
      assert.equal(result.code, 'expired_body', host);
    }
  }
  assert.notEqual(classifyLiveness({
    status: 200,
    finalUrl: 'https://jobs.example.test/job/123',
    bodyText: 'Workday ' + missingPage,
  }).result, 'expired');
  assert.notEqual(classifyLiveness({
    status: 200,
    finalUrl: 'https://jobs.example.test/job/123',
    bodyText: missingPage,
  }).result, 'expired', 'the generic not-found text requires a Workday host');

  const livePageWithFooter = `${missingPage} ${liveBody}`;
  const result = classifyLiveness({
    status: 200,
    finalUrl: 'https://jobs.example.test/job/123',
    bodyText: livePageWithFooter,
    applyControls: ['Apply'],
  });
  assert.equal(result.result, 'active');
  assert.equal(result.code, 'apply_control_visible');

  assert.notEqual(classifyLiveness({
    status: 200,
    finalUrl: 'https://jobs.example.test/job/123',
    bodyText: livePageWithFooter,
  }).result, 'expired');
});

test('Workday role descriptions and lookalike URLs do not make footer text authoritative', () => {
  for (const finalUrl of [
    'https://jobs.example.com/123',
    'https://notmyworkdayjobs.com/123',
    'https://myworkdayjobs.com.example.com/123',
    'https://myworkdaysite.com.example.com/123',
    'https://myworkdayjobs.com@jobs.example.com/123',
    'https://jobs.example.com/myworkdaysite.com/123',
    'not a URL',
  ]) {
    const result = classifyLiveness({
      status: 200,
      finalUrl,
      bodyText: 'Workday integration engineer. ' + ('Build services. '.repeat(30)) + ' Help: The page you are looking for does not exist.',
      applyControls: ['Apply'],
    });
    assert.equal(result.result, 'active', finalUrl);
    assert.equal(result.code, 'apply_control_visible', finalUrl);
  }
});

test('a closure after "after/when" that is not about the application period stays definitive', () => {
  const filled = classifyLiveness({ status: 200, bodyText: 'After a successful search this position has been filled.', applyControls: ['Apply'] });
  assert.equal(filled.result, 'expired');
  const process = classifyLiveness({ status: 200, bodyText: 'Haku päättyy 29.11. Kun hakuaika on päättynyt, otamme yhteyttä hakijoihin.', applyControls: ['Hae paikkaa'] });
  assert.equal(process.result, 'active');
});
