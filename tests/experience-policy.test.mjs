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
  ]) {
    assert.equal(interpretation(text), 'normal', text);
  }
});

test('bounded ranges extending above two and three-year thresholds remain stretch evidence', () => {
  for (const text of [
    '2-3 years', '2 to 3 years', 'approximately 2–3 years',
    '2-4 years', '2-5 years', '2 to 5 years', '3 years', '3+ years', '3-5 years',
  ]) {
    assert.equal(interpretation(text), 'stretch', text);
  }
});

test('required minimums beginning at four are outside-target hard blockers', () => {
  for (const text of [
    '4 years', '4+ years', 'At least 4 years', 'Minimum 4 years',
    '5 years', '5+ years', '4-6 years', '5-7 years', '7+ years',
  ]) {
    const result = classifyExperienceRequirements(text, policy);
    assert.equal(result.interpretation, 'outside', text);
    assert.equal(result.numeric_hard_blocker, true, text);
    assert.equal(result.requirements[0].hard_blocker, true, text);
    assert.match(result.hard_blocker_reason, /required experience starts at/);
  }
});

test('preferred numeric experience never becomes required or outside-target blocking evidence', () => {
  for (const text of [
    '3+ years preferred', '3 years preferred', '3 years of experience preferred',
    'Ideally 5 years of experience', 'Preferably 4+ years', '5 years is a plus',
    'Nice to have: 5+ years of experience', 'Bonus: 5+ years',
  ]) {
    const result = classifyExperienceRequirements(text, policy);
    assert.equal(result.interpretation, 'preferred_only', text);
    assert.ok(result.requirements.every(item => item.strength === 'preferred'), text);
    assert.equal(result.numeric_hard_blocker, false, text);
    assert.ok(result.requirements.every(item => item.hard_blocker === false), text);
  }
});

test('preference language on a later qualifier does not downgrade mandatory years', () => {
  for (const text of [
    '2+ years required, ideally in fintech',
    '2+ years of backend experience, preferably with SaaS products',
    'Minimum 2 years experience. GCP preferred.',
    '2+ years of experience; Kubernetes is a plus',
  ]) {
    const result = classifyExperienceRequirements(text, policy);
    assert.equal(result.interpretation, 'normal', text);
    assert.equal(result.requirements[0].strength, 'required', text);
    assert.equal(result.numeric_hard_blocker, false, text);
  }
});

test('HTML block boundaries prevent later preference words from contaminating required years', () => {
  const result = classifyExperienceRequirements(`
    <ul>
      <li>Proven experience (2+ years) in a data engineering role, preferably within a fast-paced tech company</li>
      <li>Extensive experience with cloud infrastructure, ideally GCP</li>
    </ul>
  `, policy);
  assert.equal(result.interpretation, 'normal');
  assert.equal(result.requirements.length, 1);
  assert.equal(result.requirements[0].strength, 'required');
});

test('HTML preferred sections apply only until the next heading', () => {
  const result = classifyExperienceRequirements(`
    <h3>Requirements</h3>
    <ul><li>2+ years of software engineering experience</li></ul>
    <h3>Nice to have</h3>
    <ul><li>5+ years working with distributed systems</li></ul>
    <h3>Responsibilities</h3>
    <ul><li>4+ years required for a separate responsibility</li></ul>
  `, policy);
  assert.deepEqual(result.requirements.map(item => [item.minimum_years, item.strength]), [
    [2, 'required'], [5, 'preferred'], [4, 'required'],
  ]);
  assert.equal(result.interpretation, 'outside');
  assert.equal(result.numeric_hard_blocker, true);
});

test('HTML preferred-qualifications heading makes an outside threshold non-blocking', () => {
  const result = classifyExperienceRequirements(`
    <h3>Preferred qualifications</h3>
    <ul><li>4+ years of relevant experience</li></ul>
  `, policy);
  assert.equal(result.interpretation, 'preferred_only');
  assert.equal(result.requirements[0].strength, 'preferred');
  assert.equal(result.numeric_hard_blocker, false);
});

test('non-experience durations are ignored while concise candidate requirements remain valid', () => {
  for (const text of [
    'We have operated for 10 years.',
    'The company is 10 years old.',
    'Founded 10 years ago.',
    '10 years in business.',
    '10 years of company history.',
    '10 years of service.',
    '5 years of vacation leave.',
    '2 years of employment tenure.',
  ]) {
    assert.equal(classifyExperienceRequirements(text, policy), null, text);
  }
  for (const text of [
    '5+ years building backend services',
    '4 years working with distributed systems',
    '3+ years developing production Python services',
    '5 years of customer service experience',
  ]) {
    assert.ok(classifyExperienceRequirements(text, policy), text);
  }
});

test('candidate activity context is preserved while organization and benefit durations are rejected', () => {
  for (const text of [
    'We are looking for candidates who have 5 years of professional backend experience.',
    'You have been building backend services for 5 years.',
    'Applicants should have experience operating Kubernetes clusters for 5 years.',
    '5 years of professional engineering experience, with generous vacation benefits.',
  ]) {
    const result = classifyExperienceRequirements(text, policy);
    assert.equal(result.interpretation, 'outside', text);
    assert.equal(result.requirements[0].strength, 'required', text);
    assert.equal(result.numeric_hard_blocker, true, text);
  }

  for (const text of [
    'The company has been building software for 10+ years.',
    'We have been operating for 20+ years.',
    'This role lasts 5 years.',
    '<h3>Benefits</h3><li>Minimum 5 years for pension vesting.</li>',
  ]) {
    const result = classifyExperienceRequirements(text, policy);
    assert.equal(result, null, text);
  }
});

test('section context is recognized but local evidence still controls interpretation', () => {
  const required = classifyExperienceRequirements('<h3>Requirements</h3><li>5+ years</li>', policy);
  const preferred = classifyExperienceRequirements('<h3>Preferred qualifications</h3><li>5+ years</li>', policy);
  const nonRequirement = classifyExperienceRequirements('<h3>Benefits</h3><li>5+ years</li>', policy);
  const unknown = classifyExperienceRequirements('<h3>Your profile</h3><li>5+ years</li>', policy);
  const explicitUnderMessyHeading = classifyExperienceRequirements(
    '<h3>Benefits</h3><li>Applicants must have 5+ years of professional backend experience.</li>',
    policy,
  );

  assert.equal(required.requirements[0].strength, 'required');
  assert.equal(preferred.requirements[0].strength, 'preferred');
  assert.equal(nonRequirement, null);
  assert.equal(unknown.requirements[0].strength, 'required');
  assert.equal(explicitUnderMessyHeading.numeric_hard_blocker, true);
});

test('all supported numeric range separators preserve the lower and upper bounds', () => {
  for (const separator of ['-', '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2212', 'to']) {
    const text = separator === 'to' ? '2 to 5 years' : `2${separator}5 years`;
    const requirement = classifyExperienceRequirements(text, policy)?.requirements[0];
    assert.deepEqual([
      requirement?.minimum_years,
      requirement?.maximum_years,
      requirement?.bound,
      requirement?.interpretation,
    ], [2, 5, 'range', 'stretch'], text);
  }
});

test('unsupported numeric ranges do not degrade to an upper-bound requirement', () => {
  assert.equal(classifyExperienceRequirements('2\u20155 years', policy), null);
  const standalone = classifyExperienceRequirements('Backend expertise \u2014 5 years of professional experience', policy);
  assert.equal(standalone.requirements[0].minimum_years, 5);
  assert.equal(standalone.numeric_hard_blocker, true);
});

test('malformed numeric HTML entities remain safe and do not alter experience parsing', () => {
  for (const entity of ['&#x110000;', '&#xD800;', '&#55296;', '&#999999999999999999999999;']) {
    assert.doesNotThrow(() => classifyExperienceRequirements(`${entity} 5 years of professional experience`, policy), entity);
    assert.equal(
      classifyExperienceRequirements(`${entity} 5 years of professional experience`, policy).requirements[0].minimum_years,
      5,
      entity,
    );
  }
});

test('immediate preferred variants remain nonblocking without broad clause contamination', () => {
  for (const text of [
    'Ideally, 5 years of experience',
    'Preferably, 4+ years',
    'Preferred: 5+ years',
    '5+ years, preferred',
    '5+ years (preferred)',
    'Bonus points for: 5+ years',
    '<h3>Bonus points for:</h3><li>5+ years</li>',
    "<h3>Nice to Have's:</h3><li>5+ years</li>",
  ]) {
    const result = classifyExperienceRequirements(text, policy);
    assert.equal(result.interpretation, 'preferred_only', text);
    assert.equal(result.numeric_hard_blocker, false, text);
  }
  for (const text of [
    '2+ years of backend experience, ideally in fintech',
    '2+ years of experience, preferably with SaaS',
    'Minimum 2 years experience. GCP preferred.',
    '2+ years experience; Kubernetes is a plus',
  ]) {
    const result = classifyExperienceRequirements(text, policy);
    assert.equal(result.requirements[0].strength, 'required', text);
  }
});

test('real-world condensed shapes retain normal/stretch roles and block required four-plus', () => {
  const productAnalyst = classifyExperienceRequirements('2+ years of hands-on working experience as a Product Data Analyst.', policy);
  const mlEngineer = classifyExperienceRequirements('2-5 years of industry experience with production ML deployment and MLOps.', policy);
  const ownershipRole = classifyExperienceRequirements('4+ years of engineering experience with substantial production ownership.', policy);
  assert.deepEqual(
    [productAnalyst.interpretation, mlEngineer.interpretation, ownershipRole.interpretation],
    ['normal', 'stretch', 'outside'],
  );
  assert.deepEqual(
    [productAnalyst.numeric_hard_blocker, mlEngineer.numeric_hard_blocker, ownershipRole.numeric_hard_blocker],
    [false, false, true],
  );
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
    experience_policy: { enabled: 'yes', normal_max_years: 3, normal_range_max_years: 3, outside_min_years: -1 },
  });
  assert.ok(invalid.errors.some(error => error.path === 'experience_policy.enabled'));
  assert.ok(invalid.errors.some(error => error.path === 'experience_policy.normal_range_max_years'));
  assert.ok(invalid.errors.some(error => error.path === 'experience_policy.outside_min_years'));

  const overlap = await validatePortalsConfig({
    experience_policy: { normal_max_years: 4, outside_min_years: 4 },
  });
  assert.ok(overlap.errors.some(error => error.path === 'experience_policy.outside_min_years'));
});
