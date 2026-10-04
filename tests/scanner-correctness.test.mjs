import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildLocationFilter,
  normalizeUrlForDedup,
  parseSinceDays,
  shouldDedupScanHistoryRow,
} from '../scan.mjs';
import { classifyLiveness } from '../liveness-core.mjs';
import { resolveAtsApi, classifyWorkdayPosting } from '../liveness-api.mjs';
import { createCachedLookup, isResolverFailure } from '../providers/_dns-cache.mjs';
import { appendPortalHealth, loadPortalHealth, computeConsecutiveFailures } from '../portal-health.mjs';
import { parallelEach, writeAtsCheckpoint, loadAtsCheckpoint } from '../scan-ats-full.mjs';
import phenom from '../providers/phenom.mjs';
import radancy from '../providers/radancy.mjs';
import successfactors from '../providers/successfactors.mjs';
import greenhouse from '../providers/greenhouse.mjs';
import { verifyFullyRemote } from '../providers/arbeitsagentur.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function writePortals(file, entries) {
  writeFileSync(file, [
    'tracked_companies:',
    ...entries.flatMap((entry) => [
      `  - name: ${entry.name}`,
      '    provider: fixture',
      `    mode: ${entry.mode}`,
    ]),
    'title_filter:',
    '  positive: [Engineer]',
  ].join('\n') + '\n');
}

function standardScanFixture(entries, runId) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-standard-cli-'));
  const providers = join(dir, 'providers');
  const data = join(dir, 'data');
  mkdirSync(providers);
  mkdirSync(data);
  writeFileSync(join(providers, 'fixture.mjs'), `export default {
    id: 'fixture',
    async fetch(entry) {
      if (entry.mode === 'throw') throw new Error('fictional provider unavailable');
      if (entry.mode === 'two') return [1, 2].map((id) => ({ company: entry.name, title: 'Backend Engineer', url: 'https://jobs.example.test/' + entry.name + '/role-' + id, location: 'Helsinki, Finland' }));
      if (entry.mode === 'job') return [{ company: entry.name, title: 'Backend Engineer', url: 'https://jobs.example.test/' + entry.name + '/Role', location: 'Helsinki, Finland' }];
      return [];
    },
  };\n`);
  const portals = join(dir, 'portals.yml');
  writePortals(portals, entries);
  const pipeline = join(data, 'pipeline.md');
  const history = join(data, 'scan-history.tsv');
  writeFileSync(pipeline, '# Pipeline\n\n## Pending\n');
  writeFileSync(history, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n');
  const result = spawnSync(process.execPath, [join(ROOT, 'scan.mjs'), '--run-id', runId], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAREER_OPS_PORTALS: portals,
      CAREER_OPS_PROFILE: join(dir, 'missing-profile.yml'),
      CAREER_OPS_PROVIDERS_DIR: providers,
      CAREER_OPS_SCAN_ROOT: dir,
      CAREER_OPS_NO_DNS_CACHE: '1',
    },
  });
  return { dir, data, pipeline, history, result, runDir: join(dir, 'output', 'scan-runs', runId) };
}

function reverseScanFixture({ resolver = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-reverse-cli-'));
  const providers = join(dir, 'providers');
  const cache = join(dir, 'data', 'cache', 'ats-companies');
  mkdirSync(providers, { recursive: true });
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(providers, 'greenhouse.mjs'), `import { appendFileSync } from 'node:fs';
  export default {
    id: 'greenhouse',
    async fetch(entry) {
      if (process.env.FIXTURE_ATTEMPTS) appendFileSync(process.env.FIXTURE_ATTEMPTS, entry.name + '\\n');
      if (process.env.FIXTURE_RECOVER === '1') return [{ company: entry.name, title: 'Engineer', url: 'https://example.test/' + entry.name, location: 'Helsinki, Finland' }];
      const error = new Error('fictional ${resolver ? 'resolver' : 'provider'} outage');
      ${resolver ? "error.code = 'EREFUSED';" : ''}
      throw error;
    },
  };\n`);
  writeFileSync(join(cache, 'greenhouse.json'), JSON.stringify(['acme-one', 'acme-two', 'acme-three', 'acme-four']));
  const portals = join(dir, 'portals.yml');
  writeFileSync(portals, 'title_filter:\n  positive: [Engineer]\n');
  const checkpoint = join(dir, 'data', 'cache', 'checkpoint.json');
  const attempts = join(dir, 'attempts.txt');
  const runId = resolver ? 'resolver-paused' : 'providers-failed';
  const result = spawnSync(process.execPath, [
    join(ROOT, 'scan-ats-full.mjs'), '--run-id', runId, '--ats', 'greenhouse', '--json', '--include-undated',
  ], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAREER_OPS_PORTALS: portals,
      CAREER_OPS_ATS_PROVIDERS_DIR: providers,
      CAREER_OPS_ATS_CHECKPOINT: checkpoint,
      CAREER_OPS_RESOLVER_FAILURE_LIMIT: '2',
      CAREER_OPS_NO_DNS_CACHE: '1',
      FIXTURE_ATTEMPTS: attempts,
      DOTENV_CONFIG_QUIET: 'true',
    },
  });
  return { dir, checkpoint, attempts, portals, providers, result, runId, runDir: join(dir, 'output', 'scan-runs', runId) };
}

test('--since accepts zero and rejects negative or malformed values', () => {
  assert.equal(parseSinceDays([], null), null);
  assert.equal(parseSinceDays(['--since', '0'], 3), 0);
  assert.equal(parseSinceDays(['--since=2.5'], 3), 2.5);
  assert.throws(() => parseSinceDays(['--since', '-1'], 3), /non-negative/);
  assert.throws(() => parseSinceDays(['--since=soon'], 3), /non-negative/);
});

test('URL dedup removes cosmetic presentation without changing path case', () => {
  const left = normalizeUrlForDedup('https://EXAMPLE.com/Jobs//Role/?utm_source=x&rltr=abc#apply');
  const right = normalizeUrlForDedup('https://example.com/Jobs/Role');
  assert.equal(left, right);
  assert.notEqual(normalizeUrlForDedup('https://example.com/Jobs/Role'), normalizeUrlForDedup('https://example.com/jobs/role'));
  assert.notEqual(normalizeUrlForDedup('https://example.com/jobs/role?team=one'), right);
});

test('standard scan CLI distinguishes healthy empty, failed, and partial completion', () => {
  const healthy = standardScanFixture([{ name: 'Healthy', mode: 'empty' }], 'healthy-empty');
  const failed = standardScanFixture([{ name: 'BrokenA', mode: 'throw' }, { name: 'BrokenB', mode: 'throw' }], 'all-failed');
  const partial = standardScanFixture([{ name: 'Working', mode: 'job' }, { name: 'Broken', mode: 'throw' }], 'partial-run');
  try {
    assert.equal(healthy.result.status, 0, healthy.result.stderr);
    assert.match(healthy.result.stdout, /Completion status:\s+completed/);
    assert.equal(existsSync(healthy.runDir), true);

    assert.notEqual(failed.result.status, 0);
    assert.match(failed.result.stdout + failed.result.stderr, /every attempted target was unavailable/i);
    assert.equal(existsSync(failed.runDir), false);
    assert.equal(readFileSync(failed.pipeline, 'utf8'), '# Pipeline\n\n## Pending\n');
    assert.equal(readFileSync(failed.history, 'utf8'), 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n');

    assert.equal(partial.result.status, 0, partial.result.stderr);
    assert.match(partial.result.stdout, /Completion status:\s+partial \(degraded\)/);
    assert.equal(existsSync(partial.runDir), true);
    assert.match(readFileSync(partial.pipeline, 'utf8'), /Backend Engineer/);
  } finally {
    for (const fixture of [healthy, failed, partial]) rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('standard scan keeps same-title non-ATS postings at distinct canonical URLs', () => {
  const fixture = standardScanFixture([{ name: 'Acme', mode: 'two' }], 'same-title-distinct-urls');
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const pipeline = readFileSync(fixture.pipeline, 'utf8');
    assert.match(pipeline, /role-1/);
    assert.match(pipeline, /role-2/);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test('standard scan reports no executable targets without creating a candidate run', () => {
  const fixture = standardScanFixture([], 'no-targets');
  try {
    assert.notEqual(fixture.result.status, 0);
    assert.match(fixture.result.stdout, /Completion status:\s+no_executable_targets/);
    assert.equal(existsSync(fixture.runDir), false);
    assert.equal(readFileSync(fixture.pipeline, 'utf8'), '# Pipeline\n\n## Pending\n');
    assert.equal(readFileSync(fixture.history, 'utf8'), 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n');
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test('reverse ATS CLI fails closed and preserves resolver checkpoints', () => {
  const failed = reverseScanFixture();
  const paused = reverseScanFixture({ resolver: true });
  try {
    const failedJson = JSON.parse(failed.result.stdout);
    assert.notEqual(failed.result.status, 0);
    assert.equal(failedJson.status, 'failed');
    assert.equal(failedJson.immutableRunDir, null);
    assert.equal(existsSync(failed.runDir), false);

    const pausedJson = JSON.parse(paused.result.stdout);
    assert.notEqual(paused.result.status, 0);
    assert.equal(pausedJson.status, 'paused');
    assert.equal(pausedJson.immutableRunDir, null);
    assert.equal(existsSync(paused.checkpoint), true);
    assert.equal(existsSync(paused.runDir), false);
    const checkpoint = JSON.parse(readFileSync(paused.checkpoint, 'utf8'));
    const pending = checkpoint.current.pendingEntries.map((entry) => entry.name).sort();
    assert.ok(pending.length >= 2);
    writeFileSync(paused.attempts, '');
    const failedResume = spawnSync(process.execPath, [
      join(ROOT, 'scan-ats-full.mjs'), '--resume', '--run-id', paused.runId,
      '--ats', 'greenhouse', '--json', '--include-undated',
    ], {
      cwd: paused.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        CAREER_OPS_PORTALS: paused.portals,
        CAREER_OPS_ATS_PROVIDERS_DIR: paused.providers,
        CAREER_OPS_ATS_CHECKPOINT: paused.checkpoint,
        CAREER_OPS_RESOLVER_FAILURE_LIMIT: '2',
        CAREER_OPS_NO_DNS_CACHE: '1',
        DOTENV_CONFIG_QUIET: 'true',
        FIXTURE_ATTEMPTS: paused.attempts,
      },
    });
    assert.notEqual(failedResume.status, 0);
    assert.equal(JSON.parse(failedResume.stdout).status, 'paused');
    assert.equal(existsSync(paused.checkpoint), true);
    assert.equal(existsSync(paused.runDir), false);
    writeFileSync(paused.attempts, '');
    const resumed = spawnSync(process.execPath, [
      join(ROOT, 'scan-ats-full.mjs'), '--resume', '--run-id', paused.runId,
      '--ats', 'greenhouse', '--json', '--include-undated',
    ], {
      cwd: paused.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        CAREER_OPS_PORTALS: paused.portals,
        CAREER_OPS_ATS_PROVIDERS_DIR: paused.providers,
        CAREER_OPS_ATS_CHECKPOINT: paused.checkpoint,
        CAREER_OPS_RESOLVER_FAILURE_LIMIT: '2',
        CAREER_OPS_NO_DNS_CACHE: '1',
        DOTENV_CONFIG_QUIET: 'true',
        FIXTURE_ATTEMPTS: paused.attempts,
        FIXTURE_RECOVER: '1',
      },
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).status, 'completed');
    const retried = readFileSync(paused.attempts, 'utf8').trim().split(/\r?\n/).sort();
    assert.deepEqual(retried, pending);
    assert.equal(existsSync(paused.checkpoint), false);
    assert.equal(existsSync(paused.runDir), true);
  } finally {
    rmSync(failed.dir, { recursive: true, force: true });
    rmSync(paused.dir, { recursive: true, force: true });
  }
});

test('location filters use token boundaries and cannot let generic remote bypass blocked geography', () => {
  const boundary = buildLocationFilter({ block: ['land'] });
  assert.equal(boundary('Finland'), true);
  assert.equal(boundary('Land'), false);

  const finland = buildLocationFilter({ allow: ['finland'] });
  assert.equal(finland('', 'https://jobs.example/roles/helsinki-finland/123', 'Engineer'), true);

  const remote = buildLocationFilter({ always_allow: ['remote'], allow: ['finland'], block: ['spain'] });
  assert.equal(remote('Madrid, Spain', 'https://jobs.example/123', 'Backend Engineer — Remote Europe'), false);
});

test('location filtering requires explicit allowed-region evidence over blocked geography', () => {
  const filter = buildLocationFilter({ always_allow: ['remote', 'europe', 'finland'], allow: ['finland', 'europe'], block: ['united states', 'usa', 'spain'] });
  assert.equal(filter('Remote - United States', '', 'Engineer'), false);
  assert.equal(filter('Madrid, Spain', '', 'Remote Engineer'), false);
  assert.equal(filter('Remote Europe', '', 'Engineer'), true);
  assert.equal(filter('New York, United States; Helsinki, Finland', '', 'Engineer'), true);
});

test('uncertain liveness remains retryable and Workday 200 requires a posting shape', () => {
  for (const status of [401, 403, 407, 408, 425, 429, 500, 503]) {
    assert.equal(classifyLiveness({ status, bodyText: 'gateway' }).result, 'uncertain');
  }
  assert.equal(classifyLiveness({ status: 200, bodyText: 'short' }).result, 'uncertain');
  assert.equal(classifyLiveness({ status: 200, bodyText: 'x'.repeat(500), applyControls: [] }).result, 'uncertain');
  assert.equal(shouldDedupScanHistoryRow({ firstSeen: '2026-08-01', status: 'skipped_no_apply_control' }), false);
  assert.equal(shouldDedupScanHistoryRow({ firstSeen: '2026-08-01', status: 'skipped_expired' }), true);
  assert.equal(classifyWorkdayPosting({}), null);
  assert.equal(classifyWorkdayPosting({ jobPostingInfo: { title: 'Engineer' } })?.result, 'active');
  assert.equal(classifyWorkdayPosting({ errorCode: 'JOB_NOT_FOUND' })?.result, 'expired');
});

test('all transient HTTP 5xx statuses remain uncertain', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(classifyLiveness({ status, bodyText: 'error' }).result, 'uncertain');
  }
});

test('Workday posting URLs map to a guarded per-job liveness endpoint', () => {
  const resolved = resolveAtsApi('https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/Helsinki-FIN/Platform-Engineer_R12345');
  assert.equal(resolved?.ats, 'workday');
  assert.equal(resolved?.apiUrl, 'https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/Careers/job/Helsinki-FIN/Platform-Engineer_R12345');
  assert.equal(resolveAtsApi('https://acme.wd3.myworkdayjobs.com/Careers/job/../secret'), null);
});

test('providers distinguish an unreachable first page from a healthy empty board', async () => {
  const failed = { fetchJson: async () => { throw new Error('network down'); }, fetchText: async () => { throw new Error('network down'); } };
  await assert.rejects(() => phenom.fetch({ name: 'P', careers_url: 'https://p.phenompeople.com' }, failed), /network down/);
  await assert.rejects(() => radancy.fetch({ name: 'R', careers_url: 'https://jobs.example.com/en/search-jobs' }, failed), /network down/);
  await assert.rejects(() => successfactors.fetch({ name: 'S', careers_url: 'https://jobs.successfactors.com', sfVariant: 'csb' }, failed), /network down/);

  const emptyPhenom = await phenom.fetch(
    { name: 'P', careers_url: 'https://p.phenompeople.com' },
    { fetchJson: async () => ({ refineSearch: { data: { jobs: [] }, totalHits: 0 } }) },
  );
  assert.deepEqual(emptyPhenom, []);
});

test('Greenhouse office enrichment and Arbeitsagentur remote proof stay evidence-based', async () => {
  const calls = [];
  const jobs = await greenhouse.fetch({ name: 'Acme', api: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs' }, {
    fetchJson: async (url) => {
      calls.push(url);
      if (url.endsWith('/offices')) {
        return { offices: [{ name: 'Helsinki, Finland', departments: [{ jobs: [{ id: 7 }] }] }] };
      }
      return { jobs: [{ id: 7, title: 'Engineer', absolute_url: 'https://example/jobs/7', location: { name: 'Hybrid' } }] };
    },
  });
  assert.equal(calls.length, 2);
  assert.match(jobs[0].location, /Hybrid · Helsinki, Finland/);

  const confirmed = await verifyFullyRemote([{ refnr: 'full' }, { refnr: 'hybrid' }], {
    fetchJson: async (url) => ({ homeofficetyp: url.includes(Buffer.from('full').toString('base64')) ? 'VOLLSTAENDIG' : 'NACH_VEREINBARUNG' }),
  });
  assert.deepEqual([...confirmed], ['full']);
});

test('portal health appends are locked and every failure kind contributes to streaks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-portal-health-'));
  const file = join(dir, 'portal-health.tsv');
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => appendPortalHealth([
      { timestamp: `2026-08-07T00:00:${String(index).padStart(2, '0')}Z`, company: 'Acme', status: index === 11 ? 'reachable' : 'server' },
    ], file)));
    const records = loadPortalHealth(file);
    assert.equal(records.length, 12);
    assert.equal(readFileSync(file, 'utf8').split(/\r?\n/)[0], 'timestamp\tcompany\tstatus');
    assert.equal(computeConsecutiveFailures([
      { company: 'Blocked', status: 'auth' },
      { company: 'Blocked', status: 'server' },
      { company: 'Blocked', status: 'unknown' },
    ]).get('Blocked'), 3);
    assert.equal(computeConsecutiveFailures(records).get('Acme'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolver failures are cached briefly and sweep work can stop with a checkpoint', async () => {
  let calls = 0;
  let pending;
  const refusal = Object.assign(new Error('resolver refused'), { code: 'EREFUSED' });
  const lookup = createCachedLookup((_host, _opts, callback) => { calls++; pending = callback; }, { negativeTtlMs: 30_000 });
  const once = () => new Promise((resolve) => lookup('tenant.example', {}, (error) => resolve(error)));
  const first = once();
  const second = once();
  pending(refusal);
  assert.equal((await first).code, 'EREFUSED');
  assert.equal((await second).code, 'EREFUSED');
  assert.equal(calls, 1);
  assert.equal(isResolverFailure(Object.assign(new Error('fetch failed'), { cause: refusal })), true);

  let stop = false;
  let lastResumeAt = 0;
  const processed = [];
  await parallelEach(Array.from({ length: 100 }, (_, index) => index), 5, async (item) => {
    processed.push(item);
    if (processed.length >= 12) stop = true;
  }, ({ resumeAt }) => { lastResumeAt = resumeAt; }, () => stop);
  assert.ok(processed.length >= 12 && processed.length < 30);
  assert.ok(lastResumeAt > 0 && lastResumeAt <= processed.length);

  const dir = mkdtempSync(join(tmpdir(), 'career-ops-ats-checkpoint-'));
  const file = join(dir, 'checkpoint.json');
  try {
    writeAtsCheckpoint({ runId: 'scan-test', current: { name: 'workday', resumeAt: lastResumeAt }, offers: [] }, file);
    assert.equal(loadAtsCheckpoint(file).current.resumeAt, lastResumeAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
