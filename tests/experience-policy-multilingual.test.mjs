import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyExperienceRequirements } from '../experience-policy.mjs';

const policy = { normalMaxYears: 2, outsideMinYears: 4 };

function assertRequired(text, expectedInterpretation) {
  const result = classifyExperienceRequirements(text, policy);
  assert.ok(result, text);
  assert.equal(result.requirements.length, 1, text);
  assert.equal(result.requirements[0].strength, 'required', text);
  assert.equal(result.interpretation, expectedInterpretation, text);
  assert.equal(result.numeric_hard_blocker, expectedInterpretation === 'outside', text);
}

function assertPreferred(text) {
  const result = classifyExperienceRequirements(text, policy);
  assert.ok(result, text);
  assert.equal(result.requirements.length, 1, text);
  assert.equal(result.requirements[0].strength, 'preferred', text);
  assert.equal(result.interpretation, 'preferred_only', text);
  assert.equal(result.numeric_hard_blocker, false, text);
}

test('German numeric phrases and requirement headings keep the existing thresholds', () => {
  assertRequired('mindestens 5 Jahre Berufserfahrung', 'outside');
  assertRequired('mind. 4 Jahre', 'outside');
  assertRequired('5+ Jahre', 'outside');
  assertRequired('3-5 Jahre Erfahrung', 'stretch');
  assert.equal(classifyExperienceRequirements('mehrjährige Berufserfahrung', policy), null);

  for (const heading of ['Anforderungen', 'Dein Profil', 'Was du mitbringst']) {
    assertRequired(`<h3>${heading}</h3><li>5 Jahre Berufserfahrung</li>`, 'outside');
  }
});

test('German preference phrases and headings keep outside thresholds nonblocking', () => {
  for (const text of [
    'Wünschenswert: 5 Jahre Berufserfahrung',
    '5 Jahre Berufserfahrung von Vorteil',
    'Idealerweise 5 Jahre Berufserfahrung',
    '5 Jahre Berufserfahrung ein Plus',
  ]) assertPreferred(text);

  for (const heading of ['Wünschenswert', 'Von Vorteil', 'Nice to have']) {
    assertPreferred(`<h3>${heading}</h3><li>5 Jahre Berufserfahrung</li>`);
  }
});

test('Finnish numeric phrases and requirement headings keep the existing thresholds', () => {
  assertRequired('vähintään 4 vuoden kokemus', 'outside');
  assertRequired('yli 5 vuoden', 'outside');
  assertRequired('5 vuoden kokemus', 'outside');
  assertRequired('3-5 vuotta', 'stretch');
  assertRequired('2+ vuotta', 'normal');

  for (const heading of ['Vaatimukset', 'Odotamme sinulta']) {
    assertRequired(`<h3>${heading}</h3><li>5 vuoden kokemus</li>`, 'outside');
  }
});

test('Finnish preference phrases and headings keep outside thresholds nonblocking', () => {
  for (const text of [
    '5 vuoden kokemus eduksi',
    '5 vuoden kokemus plussaa',
    'Toivomme, että sinulla on 5 vuoden kokemus',
  ]) assertPreferred(text);

  for (const heading of ['Eduksi katsotaan', 'Plussaa']) {
    assertPreferred(`<h3>${heading}</h3><li>5 vuoden kokemus</li>`);
  }
});

test('French numeric phrases and preference cues classify required and preferred evidence', () => {
  assertRequired("5 ans d'expérience", 'outside');
  assertRequired('5+ ans', 'outside');
  assertRequired('au moins 3 ans', 'stretch');
  assertRequired('minimum 4 ans', 'outside');

  for (const text of [
    '5 ans d\u0027expérience, un atout',
    'Un atout: 5 ans',
    '5 ans d\u0027expérience souhaité',
    'Souhaité: 5 ans',
  ]) assertPreferred(text);
});

test('Swedish numeric phrases and preference cues classify required and preferred evidence', () => {
  assertRequired('minst 5 års erfarenhet', 'outside');
  assertRequired('3-5 år', 'stretch');
  assertPreferred('5 år meriterande');
  assertPreferred('Meriterande: 5 år');
});

test('localized month durations are converted to years before classification', () => {
  const cases = [
    ['60 months', 5, 'outside'],
    ['18 months', 1.5, 'normal'],
    ['6 Monate', 0.5, 'normal'],
    ['12 kuukautta', 1, 'normal'],
    ['24 mois', 2, 'normal'],
  ];

  for (const [text, years, expected] of cases) {
    assertRequired(text, expected);
    const result = classifyExperienceRequirements(text, policy);
    assert.equal(result.requirements[0].minimum_years, years, text);
    assert.equal(result.requirements[0].maximum_years, null, text);
  }
});

test('German and Finnish spelled-out numbers through ten retain numeric classification', () => {
  assertRequired('f\u00fcnf Jahre Berufserfahrung', 'outside');
  assertRequired('viisi vuotta kokemusta', 'outside');
  assertRequired('zwei Jahre Erfahrung', 'normal');
  assertRequired('kaksi vuotta kokemusta', 'normal');
});

test('company age, fixed contracts, project duration, and benefit duration are ignored', () => {
  for (const text of [
    'seit 20 Jahren am Markt',
    'befristet auf 2 Jahre',
    'Projekt dauert 3 Jahre',
    'yli 30 vuotta kokemusta yrityksenä',
    '24 mois de cong\u00e9 parental',
    '24 months of parental leave',
  ]) assert.equal(classifyExperienceRequirements(text, policy), null, text);
});
