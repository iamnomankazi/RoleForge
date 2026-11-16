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
    'Hae',
  ];

  for (const label of labels) {
    const result = classifyLiveness({ status: 200, bodyText: liveBody, applyControls: [label] });
    assert.equal(result.result, 'active', label);
    assert.equal(result.code, 'apply_control_visible', label);
  }
});

test('plain Hae is matched as an exact control label, not inside body words', () => {
  assert.equal(classifyLiveness({ status: 200, bodyText: liveBody, applyControls: ['Hae'] }).result, 'active');
  assert.notEqual(classifyLiveness({ status: 200, bodyText: 'Haetaan' }).result, 'active');
  assert.notEqual(classifyLiveness({ status: 200, bodyText: liveBody, applyControls: ['Haetaan'] }).result, 'active');
  assert.notEqual(classifyLiveness({ status: 200, bodyText: liveBody, applyControls: ['Haku'] }).result, 'active');
});

test('Workday missing pages are expired while footer mentions on other hosts are ignored', () => {
  const missingPage = 'The page you are looking for doesn\'t exist.';

  assert.equal(classifyLiveness({
    status: 200,
    finalUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/123',
    bodyText: missingPage,
  }).result, 'expired');
  assert.equal(classifyLiveness({
    status: 200,
    finalUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/123',
    bodyText: 'The page you are looking for does not exist.',
  }).result, 'expired');
  assert.equal(classifyLiveness({
    status: 200,
    finalUrl: 'https://jobs.example.test/job/123',
    bodyText: 'Workday ' + missingPage,
  }).result, 'expired');
  assert.equal(classifyLiveness({
    status: 200,
    finalUrl: 'https://jobs.example.test/job/123',
    bodyText: missingPage,
  }).result, 'expired', 'the generic not-found page is expired when it is the only content');

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
