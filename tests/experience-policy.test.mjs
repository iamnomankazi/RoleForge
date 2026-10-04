import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContentFilter, buildTitleFilter } from '../scan.mjs';
import {
  classifyExperienceRequirements,
  normalizeExperiencePolicy,
} from '../experience-policy.mjs';
import { validatePortalsConfig } from '../validate-portals.mjs';

const policyConfig = {
  enabled: true,
  normal_max_years: 2,
  normal_range_max_years: 3,
  outside_min_years: 4,
};
const policy = normalizeExperiencePolicy(policyConfig);

function interpretation(text) {
  return classifyExperienceRequirements(text, policy)?.interpretation;
}

test('low and bounded low experience requirements remain normal-range evidence', () => {
  for (const text of [
    '0 years', '1 year of experience', '1+ years', '1-2 years', '1–2 years',
    '2 years', '2+ years', 'At least 2 years', 'Minimum 2 years',
    '2-3 years', '2 to 3 years', 'approximately 2–3 years',
  ]) {
    assert.equal(interpretation(text), 'normal', text);
  }
});

test('wide low-start ranges and three-year thresholds remain stretch evidence', () => {
  for (const text of ['2-4 years', '2-5 years', '2 to 5 years', '3 years', '3+ years']) {
    assert.equal(interpretation(text), 'stretch', text);
  }
});

test('four-plus minimums remain outside-target evidence without becoming numeric hard blockers', () => {
  for (const text of ['4+ years', '5+ years', '4-6 years', '5-7 years', '7+ years']) {
    const result = classifyExperienceRequirements(text, policy);
    assert.equal(result.interpretation, 'outside', text);
    assert.equal(result.numeric_hard_blocker, false, text);
  }
});

test('preferred numeric experience never becomes required or outside-target blocking evidence', () => {
  for (const text of ['3+ years preferred', 'ideally 3 years', '2 years is a plus', 'nice to have: 5 years']) {
    const result = classifyExperienceRequirements(text, policy);
    assert.equal(result.interpretation, 'preferred_only', text);
    assert.ok(result.requirements.every(item => item.strength === 'preferred'), text);
    assert.equal(result.numeric_hard_blocker, false, text);
  }
});

test('multiple requirements remain separate and are never summed', () => {
  const result = classifyExperienceRequirements('2+ years Python and 1+ year AWS', policy);
  assert.equal(result.interpretation, 'normal');
  assert.deepEqual(result.requirements.map(item => item.minimum_years), [2, 1]);
  assert.equal(result.requirements.some(item => item.minimum_years === 3), false);
});

test('an unbounded 2+ threshold is not collapsed into a bounded 2-5 range', () => {
  const lowerBound = classifyExperienceRequirements('2+ years', policy).requirements[0];
  const bounded = classifyExperienceRequirements('2-5 years', policy).requirements[0];
  assert.deepEqual([lowerBound.bound, lowerBound.minimum_years, lowerBound.maximum_years], ['minimum', 2, null]);
  assert.deepEqual([bounded.bound, bounded.minimum_years, bounded.maximum_years], ['range', 2, 5]);
});

test('numeric content negatives become review evidence while qualitative negatives still reject', () => {
  const filter = buildContentFilter({
    negative: ['2+ years', '5+ years', 'embedded', 'extensive production experience'],
  }, { experiencePolicy: policy });
  assert.equal(filter('Junior Data Engineer requiring 2+ years with Python and SQL'), true);
  assert.equal(filter('Product Data Analyst; 2+ years of hands-on analytics experience'), true);
  assert.equal(filter('ML Engineer II; 2-5 years and production MLOps ownership'), true);
  assert.equal(filter('Engineer with 5+ years'), true);
  assert.equal(filter('Vehicle OS engineer with embedded systems experience'), false);
  assert.equal(filter('Engineer needing extensive production experience'), false);
});

test('existing seniority title exclusions remain authoritative', () => {
  const filter = buildTitleFilter({
    positive: ['Software Engineer', 'Data Engineer', 'ML Engineer'],
    negative: ['Senior', 'Staff', 'Lead'],
  });
  assert.equal(filter('Junior Data Engineer'), true);
  assert.equal(filter('Senior Software Engineer'), false);
  assert.equal(filter('Staff Data Engineer'), false);
  assert.equal(filter('Lead ML Engineer'), false);
});

test('experience policy config validates numeric ordering and types', async () => {
  const valid = await validatePortalsConfig({ experience_policy: policyConfig });
  assert.deepEqual(valid.errors, []);
  const invalid = await validatePortalsConfig({
    experience_policy: { enabled: 'yes', normal_max_years: 3, normal_range_max_years: 2, outside_min_years: -1 },
  });
  assert.ok(invalid.errors.some(error => error.path === 'experience_policy.enabled'));
  assert.ok(invalid.errors.some(error => error.path === 'experience_policy.normal_range_max_years'));
  assert.ok(invalid.errors.some(error => error.path === 'experience_policy.outside_min_years'));
});
