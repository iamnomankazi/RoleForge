import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCES,
  countInvalidCatalogCoordinates,
  eligibleProviderJobs,
} from '../scan-ats-full.mjs';
import { buildLocationFilter, buildScanRelevanceEvaluator, buildTitleFilter } from '../scan.mjs';
import { prescreenJob } from '../prescreen.mjs';

const relevanceConfig = {
  title_filter: { positive: ['Engineer'] },
  location_filter: { always_allow: ['Finland'] },
  experience_policy: { normal_max_years: 2, outside_min_years: 4 },
  content_filter: { negative: ['no visa sponsorship'] },
};

function reverseOptions(config, evaluate, extra = {}) {
  return {
    provider: null,
    ctx: {},
    cutoff: 0,
    includeUndated: true,
    titleFilter: buildTitleFilter(config.title_filter),
    locationFilter: buildLocationFilter(config.location_filter),
    evaluateScanRelevance: evaluate,
    ...extra,
  };
}

test('reverse eligibility uses shared content and numeric experience policy', async () => {
  const evaluate = buildScanRelevanceEvaluator(relevanceConfig);
  const rejected = {
    title: 'Backend Engineer', company: 'Acme', url: 'https://jobs.example/rejected',
    location: 'Helsinki, Finland', postedAt: 1,
    description: 'No visa sponsorship is available.',
  };
  const blockedForAssessment = {
    title: 'Backend Engineer', company: 'Acme', url: 'https://jobs.example/experience',
    location: 'Helsinki, Finland', postedAt: 1,
    description: 'Required qualifications: 5+ years of professional backend engineering experience.',
  };

  assert.equal(evaluate({ ...rejected }).reason, 'content');
  const standardExperience = { ...blockedForAssessment };
  assert.equal(evaluate(standardExperience).eligible, true);
  assert.equal(standardExperience.experienceMetadata.numeric_hard_blocker, true);

  const rejectionCounts = {};
  const matches = await eligibleProviderJobs([rejected, blockedForAssessment], {
    ...reverseOptions(relevanceConfig, evaluate, { rejectionCounts }),
  });
  assert.deepEqual(matches.map(match => match.job.url), ['https://jobs.example/experience']);
  assert.equal(blockedForAssessment.experienceMetadata.numeric_hard_blocker, true);
  assert.match(blockedForAssessment.hardBlockers[0], /required experience starts at 5 years/);
  assert.deepEqual(rejectionCounts, { content: 1 });
});

test('reverse eligibility keeps missing-description jobs under shared content rules', async () => {
  const config = {
    ...relevanceConfig,
    content_filter: { positive: ['required phrase'] },
  };
  const evaluate = buildScanRelevanceEvaluator(config);
  const job = {
    title: 'Backend Engineer', company: 'Acme', url: 'https://jobs.example/no-description',
    location: 'Helsinki, Finland', postedAt: 1,
  };
  const matches = await eligibleProviderJobs([job], reverseOptions(config, evaluate));
  assert.equal(matches.length, 1);
});

test('reverse eligibility rechecks shared content policy after undated detail enrichment', async () => {
  const evaluate = buildScanRelevanceEvaluator(relevanceConfig);
  let enrichCalls = 0;
  const job = {
    title: 'Backend Engineer', company: 'Acme', url: 'https://jobs.example/enriched',
    location: 'Helsinki, Finland',
  };
  const rejectionCounts = {};
  const matches = await eligibleProviderJobs([job], reverseOptions(relevanceConfig, evaluate, {
    provider: {
      async enrichDate(target) {
        enrichCalls++;
        target.postedAt = 1;
        target.description = 'No visa sponsorship is available.';
      },
    },
    rejectionCounts,
  }));
  assert.equal(enrichCalls, 1);
  assert.equal(matches.length, 0);
  assert.deepEqual(rejectionCounts, { content: 1 });
});

test('pre-screen annotates eligible jobs without rejecting and deduplicates blockers', async () => {
  const profile = {
    languages: { english: 'C1' },
    home_country: 'fi',
    residence_country: 'fi',
    authorized_countries: ['fi'],
    outside_home_authorized: false,
    sponsorship_outside_home: true,
  };
  const config = relevanceConfig;
  const evaluate = buildScanRelevanceEvaluator(config, { prescreenProfile: profile });
  const description = 'C1 German required. Must already have the right to work in Germany. 5+ years of professional backend engineering experience.';
  const expected = prescreenJob({ title: 'Backend Engineer', description, location: 'Helsinki, Finland' }, profile, {
    experiencePolicy: config.experience_policy,
  });
  const duplicateBlocker = `${expected.blockers[0].code}: ${expected.blockers[0].evidence}`;
  const job = {
    title: 'Backend Engineer', company: 'Acme', url: 'https://jobs.example/prescreen',
    location: 'Helsinki, Finland', postedAt: 1, description,
    hardBlockers: [duplicateBlocker],
  };

  const matches = await eligibleProviderJobs([job], reverseOptions(config, evaluate));
  assert.equal(matches.length, 1);
  assert.deepEqual(job.prescreen, expected);
  assert.ok(job.prescreen.blockers.length > 0);
  assert.ok(job.prescreen.flags.some(flag => flag.code === 'sponsorship_unknown'));
  assert.deepEqual(job.languageRequirements, expected.language_requirements);
  assert.equal(job.hardBlockers.filter(value => value === duplicateBlocker).length, 1);
  assert.ok(job.hardBlockers.includes(job.experienceMetadata.hard_blocker_reason));
  assert.ok(job.hardBlockers.includes(`experience_outside: ${job.prescreen.blockers.find(item => item.code === 'experience_outside').evidence}`));
});

test('invalid Workday catalog coordinates are counted and never become probe entries', () => {
  const rows = ['wd103|wd1|x', 'wd5|wd1|acme', 'tenant|wd1|site'];
  assert.equal(SOURCES.workday.toEntry(rows[0]), null);
  assert.equal(SOURCES.workday.toEntry(rows[1]), null);
  assert.ok(SOURCES.workday.toEntry(rows[2]));
  assert.equal(countInvalidCatalogCoordinates('workday', rows), 2);
  assert.equal(countInvalidCatalogCoordinates('greenhouse', rows), 0);
});
