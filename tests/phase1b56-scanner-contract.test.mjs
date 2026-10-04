import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildScanRelevanceEvaluator } from '../scan.mjs';
import { classifyPostingDate } from '../scan-ats-full.mjs';
import ashby from '../providers/ashby.mjs';
import greenhouse from '../providers/greenhouse.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TMP_ROOT = resolve(tmpdir());

function removeTempTree(directory) {
  const target = resolve(directory);
  const rel = relative(TMP_ROOT, target);
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`), `refusing to remove outside temp root: ${target}`);
  rmSync(target, { recursive: true, force: true });
}

function fixture() {
  const dir = mkdtempSync(join(TMP_ROOT, 'career-ops-phase1b56-scanner-'));
  const providers = join(dir, 'providers');
  const data = join(dir, 'data');
  mkdirSync(providers, { recursive: true });
  mkdirSync(data, { recursive: true });

  const coverageHelper = pathToFileURL(join(ROOT, 'providers', '_result.mjs')).href;
  writeFileSync(join(providers, 'fixture.mjs'), `import { appendFileSync } from 'node:fs';
import { markProviderCoverage } from ${JSON.stringify(coverageHelper)};

let lastJobs;
const job = (sourceId, title, location, extra = {}) => ({
  company: 'Acme', title, location, sourceId,
  url: 'https://jobs.fixture.test/acme/' + sourceId,
  ...extra,
});

export default {
  id: 'fixture',
  async fetch(entry, ctx) {
    appendFileSync(process.env.SCANNER_FIXTURE_LOG, JSON.stringify({
      kind: 'fetch', includeUndated: ctx.includeUndated, sinceMs: Number.isFinite(ctx.sinceMs),
    }) + '\\n');
    lastJobs = [
      job('rejected-title', 'Office Manager', 'Helsinki, Finland'),
      job('rejected-location', 'Backend Engineer', 'Remote - United States'),
      job('stale-after-detail', 'Backend Engineer', 'Helsinki, Finland'),
      job('blocked-after-detail', 'Backend Engineer', 'Helsinki, Finland'),
      job('content-after-detail', 'Backend Engineer', 'Helsinki, Finland', { description: '' }),
      job('detail-failure-missing', 'Backend Engineer', 'Helsinki, Finland', { description: 'x'.repeat(5000) }),
      job('detail-failure-invalid', 'Backend Engineer', 'Helsinki, Finland', { postedAt: 'not-a-date' }),
    ];
    return lastJobs;
  },
  async enrichDate(posting, ctx) {
    appendFileSync(process.env.SCANNER_FIXTURE_LOG, JSON.stringify({
      kind: 'detail', id: posting.sourceId, includeUndated: ctx.includeUndated,
    }) + '\\n');
    if (posting.sourceId === 'stale-after-detail') {
      posting.postedAt = Date.now() - 60 * 86_400_000;
      markProviderCoverage(lastJobs, {
        status: 'partial', code: 'fixture_detail_budget', reason: 'fixture detail budget exhausted',
      });
      return posting;
    }
    if (posting.sourceId === 'blocked-after-detail') {
      posting.postedAt = Date.now();
      posting.location = 'Remote - United States';
      return posting;
    }
    if (posting.sourceId === 'content-after-detail') {
      posting.postedAt = Date.now();
      posting.description = 'The role has confidential requirements.';
      return posting;
    }
    if (posting.sourceId.startsWith('detail-failure-')) {
      posting.postedAt = Date.now() - 60 * 86_400_000;
      throw new Error('fixture detail request failed');
    }
    return posting;
  },
};
`);

  const portals = join(dir, 'portals.yml');
  writeFileSync(portals, [
    'tracked_companies:',
    '  - name: Acme',
    '    provider: fixture',
    'title_filter:',
    '  positive: [Engineer]',
    'location_filter:',
    '  allow: [Finland, Europe]',
    '  always_allow: [Remote]',
    '  block: [United States]',
    'content_filter:',
    '  negative: [confidential]',
  ].join('\n') + '\n');
  writeFileSync(join(data, 'pipeline.md'), '# Pipeline\n\n## Pending\n');
  writeFileSync(join(data, 'scan-history.tsv'), 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n');

  const runId = 'phase1b56-standard-enrichment';
  const log = join(dir, 'provider.log');
  const result = spawnSync(process.execPath, [join(ROOT, 'scan.mjs'), '--run-id', runId, '--since', '30'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAREER_OPS_PORTALS: portals,
      CAREER_OPS_PROVIDERS_DIR: providers,
      CAREER_OPS_SCAN_ROOT: dir,
      SCANNER_FIXTURE_LOG: log,
      DOTENV_CONFIG_QUIET: 'true',
    },
  });
  return { dir, runId, log, result, runDir: join(dir, 'output', 'scan-runs', runId) };
}

function reverseFixture({ includeUndated, runId }) {
  const dir = mkdtempSync(join(TMP_ROOT, 'career-ops-phase1b56-reverse-'));
  const providers = join(dir, 'providers');
  const cache = join(dir, 'data', 'cache', 'ats-companies');
  mkdirSync(providers, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const coverageHelper = pathToFileURL(join(ROOT, 'providers', '_result.mjs')).href;
  writeFileSync(join(providers, 'workday.mjs'), `import { appendFileSync } from 'node:fs';
import { markProviderCoverage } from ${JSON.stringify(coverageHelper)};

let lastJobs;
const job = (sourceId, title, location, extra = {}) => ({
  company: 'Acme', title, location, sourceId,
  url: 'https://exampleco.wd5.myworkdayjobs.com/exampleco-careers/job/' + sourceId,
  ...extra,
});

export default {
  id: 'workday',
  async fetch(entry, ctx) {
    appendFileSync(process.env.REVERSE_FIXTURE_LOG, JSON.stringify({
      kind: 'fetch', includeUndated: ctx.includeUndated, sinceMs: Number.isFinite(ctx.sinceMs),
    }) + '\\n');
    lastJobs = [
      job('rejected-title', 'Office Manager', 'Helsinki, Finland'),
      job('rejected-location', 'Backend Engineer', 'Remote - United States'),
      job('stale-after-detail', 'Backend Engineer', 'Helsinki, Finland'),
      job('blocked-after-detail', 'Backend Engineer', 'Helsinki, Finland'),
      job('detail-failure-missing', 'Backend Engineer', 'Helsinki, Finland'),
      job('detail-failure-invalid', 'Backend Engineer', 'Helsinki, Finland', { postedAt: 'invalid-date' }),
      job('detail-failure-range', 'Backend Engineer', 'Helsinki, Finland', { postedAt: 1e100 }),
    ];
    Object.defineProperty(lastJobs, 'providerDegraded', { value: true });
    Object.defineProperty(lastJobs, 'workdayNoDateSkip', { value: true });
    return lastJobs;
  },
  async enrichDate(posting, ctx) {
    appendFileSync(process.env.REVERSE_FIXTURE_LOG, JSON.stringify({
      kind: 'detail', id: posting.sourceId, includeUndated: ctx.includeUndated,
    }) + '\\n');
    if (posting.sourceId === 'stale-after-detail') {
      posting.postedAt = Date.now() - 60 * 86_400_000;
      markProviderCoverage(lastJobs, {
        status: 'partial', code: 'fixture_late_detail', reason: 'fixture Workday detail budget exhausted',
      });
      return posting;
    }
    if (posting.sourceId === 'blocked-after-detail') {
      posting.postedAt = Date.now();
      posting.location = 'Remote - United States';
      return posting;
    }
    if (posting.sourceId.startsWith('detail-failure-')) {
      posting.postedAt = Date.now() - 60 * 86_400_000;
      throw new Error('fixture detail request failed');
    }
    return posting;
  },
};
`);
  writeFileSync(join(cache, 'workday.json'), JSON.stringify(['exampleco|wd5|exampleco-careers']));

  const portals = join(dir, 'portals.yml');
  writeFileSync(portals, [
    'title_filter:',
    '  positive: [Engineer]',
    'location_filter:',
    '  allow: [Finland, Europe]',
    '  always_allow: [Remote]',
    '  block: [United States]',
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n');
  writeFileSync(join(dir, 'data', 'scan-history.tsv'), 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n');

  const log = join(dir, 'provider.log');
  const checkpoint = join(dir, 'data', 'cache', 'checkpoint.json');
  const result = spawnSync(process.execPath, [
    join(ROOT, 'scan-ats-full.mjs'), '--run-id', runId, '--ats', 'workday', '--since', '30', '--json',
    ...(includeUndated ? ['--include-undated'] : []),
  ], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAREER_OPS_PORTALS: portals,
      CAREER_OPS_ATS_PROVIDERS_DIR: providers,
      CAREER_OPS_ATS_CHECKPOINT: checkpoint,
      CAREER_OPS_NO_DNS_CACHE: '1',
      REVERSE_FIXTURE_LOG: log,
      DOTENV_CONFIG_QUIET: 'true',
    },
  });
  return {
    dir, runId, log, result, includeUndated,
    runDir: join(dir, 'output', 'scan-runs', runId),
  };
}

test('reverse posting dates accept only finite numeric epochs', () => {
  const cutoff = 10;
  assert.equal(classifyPostingDate({ postedAt: 0 }, cutoff), 'stale');
  assert.equal(classifyPostingDate({ postedAt: 10 }, cutoff), 'keep');
  assert.equal(classifyPostingDate({ postedAt: 11 }, cutoff), 'keep');
  for (const postedAt of [undefined, null, NaN, Infinity, -Infinity, 1e100, '10', '2026-10-01T00:00:00Z', 'invalid']) {
    assert.equal(classifyPostingDate({ postedAt }, cutoff), 'undated', String(postedAt));
  }
});

test('standard scan enriches only cheap-eligible undated jobs, rechecks full policy, and retains late coverage', () => {
  const current = fixture();
  try {
    assert.equal(current.result.status, 0, current.result.stderr);
    const calls = readFileSync(current.log, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], { kind: 'fetch', includeUndated: true, sinceMs: true });
    const detailIds = calls.filter((call) => call.kind === 'detail').map((call) => call.id).sort();
    assert.deepEqual(detailIds, [
      'blocked-after-detail',
      'content-after-detail',
      'detail-failure-invalid',
      'detail-failure-missing',
      'stale-after-detail',
    ].sort());

    const manifest = JSON.parse(readFileSync(join(current.runDir, 'manifest.json'), 'utf8'));
    const candidates = JSON.parse(readFileSync(join(current.runDir, 'candidates.json'), 'utf8'));
    assert.equal(manifest.metadata.completion_status, 'partial');
    assert.equal(manifest.metadata.targets_degraded, 1, 'coverage attached by enrichDate is read once after enrichment');
    assert.deepEqual(candidates.map((candidate) => candidate.source_id).sort(), [
      'detail-failure-invalid', 'detail-failure-missing',
    ]);

    const missing = candidates.find((candidate) => candidate.source_id === 'detail-failure-missing');
    const invalid = candidates.find((candidate) => candidate.source_id === 'detail-failure-invalid');
    assert.equal(missing.posted_at, null, 'failed enrichment restores an absent date and standard keeps it unknown');
    assert.equal(invalid.posted_at, 'not-a-date', 'failed enrichment restores an invalid original date');
    assert.equal(missing.description.length, 5000, 'canonical description behavior remains uncapped');
    assert.equal(missing.url, 'https://jobs.fixture.test/acme/detail-failure-missing');
    assert.equal(missing.provenance[0].source_id, 'detail-failure-missing');
    assert.equal(missing.provenance[0].source, 'fixture-api');
    assert.equal(missing.run_id, current.runId);
    assert.ok(missing.candidate_id);

    assert.match(current.result.stdout, /fixture detail budget exhausted/);
    assert.match(current.result.stdout, /Filtered by --since:\s+1 removed/);
    assert.match(current.result.stdout, /Filtered by location:\s+2 removed/);
    assert.match(current.result.stdout, /Filtered by content:\s+1 removed/);
  } finally {
    removeTempTree(current.dir);
  }
});

test('reverse CLI enriches only cheap-eligible jobs and aggregates late coverage without changing undated policy', () => {
  const defaultRun = reverseFixture({ includeUndated: false, runId: 'phase1b56-reverse-default' });
  const includeRun = reverseFixture({ includeUndated: true, runId: 'phase1b56-reverse-undated' });
  try {
    for (const current of [defaultRun, includeRun]) {
      assert.equal(current.result.status, 0, current.result.stderr);
      current.json = JSON.parse(current.result.stdout);
      const calls = readFileSync(current.log, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.deepEqual(calls[0], {
        kind: 'fetch', includeUndated: current.includeUndated, sinceMs: true,
      });
      const detailIds = calls.filter((call) => call.kind === 'detail').map((call) => call.id).sort();
      assert.deepEqual(detailIds, [
        'blocked-after-detail',
        'detail-failure-invalid',
        'detail-failure-missing',
        'detail-failure-range',
        'stale-after-detail',
      ].sort());
      assert.equal(current.json.degradedBoards, 1, 'late typed coverage is read once after enrichment');
      assert.equal(current.json.degradedBoardDetails[0].code, 'fixture_late_detail');
      assert.equal(current.json.unreachableBoards, 1, 'legacy providerDegraded adds one error for this target');
      assert.equal(current.json.offers.some((offer) => offer.url.endsWith('/stale-after-detail')), false);
      assert.equal(current.json.offers.some((offer) => offer.url.endsWith('/blocked-after-detail')), false);
      assert.equal(current.json.offers.some((offer) => offer.url.endsWith('/rejected-title')), false);
      assert.equal(current.json.offers.some((offer) => offer.url.endsWith('/rejected-location')), false);
    }

    assert.equal(defaultRun.json.postingsDroppedNoDate, 5, 'legacy ordering counts undated title/location rejects before their cheap filters');
    assert.equal(defaultRun.json.offers.length, 0);
    assert.equal(includeRun.json.postingsDroppedNoDate, 0);
    assert.deepEqual(
      includeRun.json.offers.map((offer) => offer.dateStatus).sort(),
      ['unknown', 'unknown', 'unknown'],
    );
    assert.match(defaultRun.result.stderr, /Undated dropped: 5 \(7 raw listings returned by 1 Workday board that stopped undated pagination\)/);
    assert.doesNotMatch(includeRun.result.stderr, /Undated dropped:/);

    const manifest = JSON.parse(readFileSync(join(includeRun.runDir, 'manifest.json'), 'utf8'));
    const candidates = JSON.parse(readFileSync(join(includeRun.runDir, 'candidates.json'), 'utf8'));
    assert.equal(manifest.metadata.completion_status, 'partial');
    assert.deepEqual(candidates.map((candidate) => candidate.source_id).sort(), [
      'detail-failure-invalid', 'detail-failure-missing', 'detail-failure-range',
    ]);
    assert.ok(candidates.every((candidate) => candidate.provenance.some((item) => item.source_id === candidate.source_id)));
    assert.ok(candidates.every((candidate) => candidate.run_id === includeRun.runId && candidate.candidate_id));
    const rangeCandidate = candidates.find((candidate) => candidate.source_id === 'detail-failure-range');
    const rangeOffer = includeRun.json.offers.find((offer) => offer.url.endsWith('/detail-failure-range'));
    assert.equal(rangeCandidate.posted_at, '1e+100', 'failed enrichment preserves the original out-of-range numeric value through the canonical date field');
    assert.equal(rangeOffer.postedAt, null, 'reverse JSON emits no invalid ISO date for an unusable epoch');
    assert.equal(rangeOffer.dateStatus, 'unknown');
  } finally {
    removeTempTree(defaultRun.dir);
    removeTempTree(includeRun.dir);
  }
});

test('Greenhouse and Ashby normalized rows feed the existing scanner geography and description policy', async () => {
  const config = {
    title_filter: { positive: ['Engineer'] },
    location_filter: {
      allow: ['Finland', 'Europe', 'México'],
      always_allow: ['Remote'],
      block: ['United States'],
    },
  };
  const evaluate = buildScanRelevanceEvaluator(config);
  const greenhouseJobs = await greenhouse.fetch({
    name: 'Greenhouse fixture',
    careers_url: 'https://job-boards.greenhouse.io/acme',
  }, {
    async fetchJson(url) {
      if (url.endsWith('/offices')) {
        return { offices: [
          { name: 'Helsinki', location: { name: 'Helsinki, Finland' }, departments: [{ jobs: [{ id: 1 }] }] },
        ] };
      }
      return { jobs: [
        {
          id: 1, title: 'Backend Engineer',
          absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1',
          location: { name: 'Remote' },
          content: '<p>Visa sponsorship is available for qualified applicants.</p>',
          first_published: '2026-09-30T09:30:00Z',
        },
        {
          id: 2, title: 'Backend Engineer',
          absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/2',
          location: { name: 'Remote - United States' },
          content: '<p>Remote role restricted to United States residents.</p>',
          first_published: '2026-09-30T09:30:00Z',
        },
        {
          id: 3, title: 'Backend Engineer',
          absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/3',
          location: { name: 'Ciudad de México, México' },
          content: '',
          first_published: '2026-09-30T09:30:00Z',
        },
        {
          id: 4, title: 'Backend Engineer',
          absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/4',
          location: { name: 'Helsinki, Finland' },
          first_published: '2026-09-30T09:30:00Z',
        },
        {
          id: 5, title: 'Backend Engineer',
          absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/5',
          location: { name: 'Helsinki, Finland' },
          content: `<p>${'x'.repeat(5000)}</p>`,
          first_published: '2026-09-30T09:30:00Z',
        },
      ] };
    },
  });

  const ashbyJobs = await ashby.fetch({
    name: 'Ashby fixture',
    careers_url: 'https://jobs.ashbyhq.com/acme',
  }, {
    async fetchJson() {
      return { jobs: [
        {
          title: 'Backend Engineer',
          jobUrl: 'https://jobs.ashbyhq.com/acme/job-1',
          location: 'Stockholm, Sweden',
          secondaryLocations: [{
            location: 'Helsinki, Finland',
            address: { postalAddress: { addressLocality: 'Helsinki', addressCountry: 'Finland' } },
          }],
          workplaceType: 'REMOTE',
          descriptionPlain: 'Applicants across Europe may apply.',
          publishedAt: '2026-09-30T09:30:00Z',
        },
        {
          title: 'Backend Engineer',
          jobUrl: 'https://jobs.ashbyhq.com/acme/job-2',
          location: 'Remote - United States',
          workplaceType: 'Remote',
          publishedAt: '2026-09-30T09:30:00Z',
        },
        {
          title: 'Backend Engineer',
          jobUrl: 'https://jobs.ashbyhq.com/acme/job-3',
          location: 'Ciudad de México, México',
          workplaceType: 'Remote',
          descriptionPlain: 'Visa sponsorship is available for qualified applicants.',
          publishedAt: '2026-09-30T09:30:00Z',
        },
        {
          title: 'Backend Engineer',
          jobUrl: 'https://jobs.ashbyhq.com/acme/job-4',
          location: 'Helsinki, Finland',
          descriptionPlain: '',
          publishedAt: '2026-09-30T09:30:00Z',
        },
      ] };
    },
    async sleep() {},
  });

  const ghById = Object.fromEntries(greenhouseJobs.map((job) => [job.url.split('/').at(-1), job]));
  const ashbyById = Object.fromEntries(ashbyJobs.map((job, index) => [String(index + 1), job]));
  assert.match(ghById['1'].location, /Helsinki, Finland/);
  assert.equal(evaluate(ghById['1']).eligible, true, 'Greenhouse office geography makes generic Remote targetable');
  assert.equal(evaluate(ghById['2']).reason, 'location', 'explicit US remote restriction overrides generic Remote');
  assert.equal(evaluate(ghById['3']).eligible, true, 'Unicode country names reach the existing location classifier');
  assert.equal(evaluate(ghById['4']).eligible, true, 'missing description remains eligible under the existing policy');
  assert.equal(ghById['5'].description.length, 4000, 'Greenhouse HTML normalization keeps the shared helper cap');
  assert.equal(evaluate(ghById['5']).eligible, true, 'the normalized provider description reaches the existing evaluator');
  assert.equal(ghById['3'].description, '', 'Greenhouse preserves a present empty description');
  assert.equal(Object.hasOwn(ghById['4'], 'description'), false, 'Greenhouse leaves an absent description absent');
  assert.match(ghById['1'].description, /Visa sponsorship is available/);
  assert.equal(ghById['1'].hardBlockers, undefined, 'sponsorship language alone does not invent a blocker');

  assert.match(ashbyById['1'].location, /Helsinki, Finland/);
  assert.match(ashbyById['1'].location, /Remote/);
  assert.equal(evaluate(ashbyById['1']).eligible, true, 'Ashby secondary EU location reaches the existing classifier');
  assert.equal(evaluate(ashbyById['2']).reason, 'location', 'Ashby restricted US remote role is excluded');
  assert.equal(evaluate(ashbyById['3']).eligible, true, 'Ashby Unicode country and remote fields reach the existing classifier');
  assert.equal(evaluate(ashbyById['4']).eligible, true);
  assert.equal(Object.hasOwn(ashbyById['2'], 'description'), false, 'Ashby does not invent an absent description');
  assert.equal(Object.hasOwn(ashbyById['4'], 'description'), false, 'Ashby omits empty descriptions as before');
  assert.match(ashbyById['3'].description, /Visa sponsorship is available/);
  assert.equal(ashbyById['3'].hardBlockers, undefined, 'provider output preserves sponsorship text without adding policy metadata');
});
