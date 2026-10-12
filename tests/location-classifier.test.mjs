import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLocationClassifier } from '../scan.mjs';

const locationFilter = {
  always_allow: [
    'Finland', 'Helsinki', 'Espoo',
    'Germany', 'Berlin', 'Hamburg', 'Bremen', 'Hanover',
    'Netherlands', 'Amsterdam',
    'Denmark', 'Copenhagen',
  ],
  allow: ['Remote Europe', 'Europe', 'Remote'],
  block: ['United States', 'USA', 'US only'],
};

const classify = buildLocationClassifier(locationFilter);

test('location classifier rejects Delaware ISO collisions and non-country uses of de', () => {
  for (const location of [
    'Wilmington, DE',
    'Dover, DE',
    'Newark, DE, US',
    'Wilmington, DE 19801',
    'Newark, DE (ICD) - R&D - Customer Processes',
    'Austin, TX - Remote',
    'Avenida de Bruselas 7, 28108 Alcobendas',
    'Rio de Janeiro',
    'Ciudad de Mexico',
  ]) {
    assert.equal(classify(location).status, 'ineligible', location);
  }
});

test('location classifier rejects target city names when another country or US state is explicit', () => {
  for (const location of [
    'Hanover, MD, US',
    'Bremen, Indiana',
    'Berlin, NH',
    'Hamburg, NY',
    'Berlin, United States',
    'Berlin, USA',
  ]) {
    assert.equal(classify(location).status, 'ineligible', location);
  }
});

test('location classifier recognizes target Finnish cities without requiring city config entries', () => {
  const finlandTarget = buildLocationClassifier({ allow: ['Finland'] });
  const cities = [
    'Oulu', 'Kuopio', 'Jyvaskyla', 'Jyväskylä', 'Lahti', 'Vaasa', 'Pori',
    'Lappeenranta', 'Hämeenlinna', 'Seinäjoki', 'Rovaniemi', 'Kajaani',
    'Kotka', 'Mikkeli', 'Porvoo', 'Salo', 'Kokkola',
  ];
  for (const city of cities) {
    assert.equal(finlandTarget(city).status, 'eligible', city);
  }

  const noFinlandTarget = buildLocationClassifier({ allow: ['Germany'] });
  for (const city of cities) {
    assert.equal(noFinlandTarget(city).status, 'ineligible', city);
  }
});

test('location classifier keeps configured country, Europe, remote, and multi-location behavior', () => {
  const eligible = [
    'Berlin, Germany',
    'Remote - Europe',
    'Helsinki',
    'Espoo, Uusimaa, Finland',
    'Copenhagen, Denmark',
    'Amsterdam, NL',
    'Rheinfelden (DE)',
    'Berlin, DE (Hybrid)',
    'Varsseveld (NL)',
    'DE',
    'Helsinki, Finland; London, UK',
    'Mountain View, California | Munich, Germany | Singapore',
    'Israel Hybrid, Europe Remote',
    'Remote • UK, France, Spain, Germany or Canada',
  ];
  for (const location of eligible) {
    assert.equal(classify(location).status, 'eligible', location);
  }
  assert.equal(classify('DE').matched, 'Germany');
  assert.equal(classify('Remote (US only)').status, 'ineligible');
  assert.equal(classify('Remote').status, 'uncertain');
});

test('explicitly allowed country names still qualify in mixed-country location text', () => {
  for (const alwaysAllow of [['Belgium'], 'belgium', ['  Belgium  ']]) {
    const mixed = buildLocationClassifier({ always_allow: alwaysAllow, block: ['France'] });
    assert.equal(mixed('Remote, Belgium or France').status, 'eligible');
  }

  const blocked = buildLocationClassifier({ allow: ['Remote'], block: ['France'] });
  assert.equal(blocked('Remote, Belgium or France').status, 'ineligible');
});
