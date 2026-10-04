import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildLocationFilter,
  buildLocationClassifier,
  extractHttpUrlsFromMarkdown,
  loadSeenUrls,
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
import { classifyFetchError } from '../verify-portals.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function writePortals(file, entries, { experiencePolicy = false } = {}) {
  writeFileSync(file, [
    'tracked_companies:',
    ...entries.flatMap((entry) => [
      `  - name: ${entry.name}`,
      ...(entry.provider === null ? [] : [`    provider: ${entry.provider || 'fixture'}`]),
      ...(entry.mode ? [`    mode: ${entry.mode}`] : []),
      ...(entry.careers_url ? [`    careers_url: ${entry.careers_url}`] : []),
      ...(entry.scan_method ? [`    scan_method: ${entry.scan_method}`] : []),
      ...(entry.parser ? ['    parser:', '      command: node', '      script: fixture-parser.mjs'] : []),
    ]),
    'title_filter:',
    '  positive: [Engineer]',
    ...(experiencePolicy ? [
      'experience_policy:',
      '  enabled: true',
      '  normal_max_years: 2',
      '  normal_range_max_years: 3',
      '  outside_min_years: 4',
      'content_filter:',
      '  negative: ["2+ years", "3+ years", "4+ years", "5+ years", "embedded"]',
    ] : []),
  ].join('\n') + '\n');
}

function standardScanFixture(entries, runId, { experiencePolicy = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-standard-cli-'));
  const providers = join(dir, 'providers');
  const data = join(dir, 'data');
  mkdirSync(providers);
  mkdirSync(data);
  const resultHelper = pathToFileURL(join(ROOT, 'providers', '_result.mjs')).href;
  writeFileSync(join(providers, 'fixture.mjs'), `import { markProviderCoverage } from ${JSON.stringify(resultHelper)};
  export default {
    id: 'fixture',
    async fetch(entry) {
      if (entry.mode === 'throw') throw new Error('fictional provider unavailable');
      if (entry.mode === 'two') return [1, 2].map((id) => ({ company: entry.name, title: 'Backend Engineer', url: 'https://jobs.example.test/' + entry.name + '/role-' + id, location: 'Helsinki, Finland' }));
      if (entry.mode === 'job') return [{ company: entry.name, title: 'Backend Engineer', url: 'https://jobs.example.test/' + entry.name + '/Role', location: 'Helsinki, Finland' }];
      if (entry.mode === 'experience-normal') return [{ company: entry.name, title: 'Junior Data Engineer', url: 'https://jobs.example.test/' + entry.name + '/normal', location: 'Helsinki, Finland', description: 'Python and SQL role requiring 2+ years of experience' }];
      if (entry.mode === 'experience-stretch') return [{ company: entry.name, title: 'ML Engineer II', url: 'https://jobs.example.test/' + entry.name + '/stretch', location: 'Helsinki, Finland', description: '2-5 years of industry experience with production ML and MLOps ownership' }];
      if (entry.mode === 'experience-outside') return [{ company: entry.name, title: 'Software Engineer', url: 'https://jobs.example.test/' + entry.name + '/outside', location: 'Helsinki, Finland', description: '5+ years of commercial software engineering experience' }];
      if (entry.mode === 'degraded') {
        const jobs = [{ company: entry.name, title: 'Backend Engineer', url: 'https://jobs.example.test/' + entry.name + '/partial', location: 'Helsinki, Finland' }];
        Object.defineProperty(jobs, 'providerDegraded', { value: true });
        Object.defineProperty(jobs, 'providerDegradedReason', { value: 'fixture pagination truncated' });
        return jobs;
      }
      if (entry.mode === 'typed-degraded') {
        const jobs = [{ company: entry.name, title: 'Backend Engineer', url: 'https://jobs.example.test/' + entry.name + '/typed-partial', location: 'Helsinki, Finland' }];
        return markProviderCoverage(jobs, { status: 'partial', code: 'max_pages', reason: 'fixture reached max pages', pagesFetched: 2, maxPages: 2 });
      }
      return [];
    },
  };\n`);
  writeFileSync(join(providers, 'local-parser.mjs'), `export default {
    id: 'local-parser',
    detect(entry) { return entry.parser || null; },
    async fetch() { throw new Error('primary parser exploded'); },
  };\n`);
  writeFileSync(join(providers, 'fallback.mjs'), `export default {
    id: 'fallback',
    detect(entry) { return entry.careers_url?.includes('fallback.example') || null; },
    async fetch(entry) {
      if (entry.mode === 'fallback-throws') throw new Error('fallback network exploded');
      return [{ company: entry.name, title: 'Backend Engineer', url: 'https://fallback.example/jobs/' + entry.name, location: 'Helsinki, Finland' }];
    },
  };\n`);
  const portals = join(dir, 'portals.yml');
  writePortals(portals, entries, { experiencePolicy });
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
  return {
    dir, data, pipeline, history, result,
    scanRuns: join(data, 'scan-runs.tsv'),
    runDir: join(dir, 'output', 'scan-runs', runId),
  };
}

function lastTsvRow(file) {
  const [header, ...rows] = readFileSync(file, 'utf8').trim().split(/\r?\n/);
  return Object.fromEntries(header.split('\t').map((key, index) => [key, rows.at(-1).split('\t')[index]]));
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

test('standard scan retains configured numeric experience evidence for contextual review', () => {
  const fixture = standardScanFixture([
    { name: 'Normal', mode: 'experience-normal' },
    { name: 'Stretch', mode: 'experience-stretch' },
    { name: 'Outside', mode: 'experience-outside' },
  ], 'experience-policy', { experiencePolicy: true });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const candidates = JSON.parse(readFileSync(join(fixture.runDir, 'candidates.json'), 'utf8'));
    assert.deepEqual(
      Object.fromEntries(candidates.map(candidate => [candidate.company, candidate.experience_metadata?.interpretation])),
      { Normal: 'normal', Stretch: 'stretch', Outside: 'outside' },
    );
    assert.ok(candidates.every(candidate => candidate.experience_metadata?.numeric_hard_blocker === false));
    assert.match(fixture.result.stdout, /Filtered by content:\s+0/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('URL dedup removes cosmetic presentation without changing path case', () => {
  const left = normalizeUrlForDedup('https://EXAMPLE.com/Jobs//Role/?utm_source=x&rltr=abc#apply');
  const right = normalizeUrlForDedup('https://example.com/Jobs/Role');
  assert.equal(left, right);
  assert.notEqual(normalizeUrlForDedup('https://example.com/Jobs/Role'), normalizeUrlForDedup('https://example.com/jobs/role'));
  assert.notEqual(normalizeUrlForDedup('https://example.com/jobs/role?team=one'), right);
  assert.notEqual(normalizeUrlForDedup('https://example.com/jobs/role;'), right);
});

test('application-history URL extraction respects Markdown and prose delimiters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-seen-urls-'));
  try {
    const history = join(dir, 'scan-history.tsv');
    const pipeline = join(dir, 'pipeline.md');
    const applications = join(dir, 'applications.md');
    writeFileSync(history, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\nhttps://history.example/job/1\t2026-08-08\tfixture\tRole\tCo\tadded\tFinland\n');
    writeFileSync(pipeline, '- [ ] https://pipeline.example/job/2 | Co | Role\n');
    writeFileSync(applications, [
      '| Company | Role | Notes |',
      '|---|---|---|',
      '| Hone Health | Data Engineering Intern | URL: https://himalayas.app/companies/hone-health/jobs/data-engineering-intern-fall-2026; CV variant not recorded. |',
      '| Acme | Engineer | [https://example.com/job/123](https://example.com/job/123). |',
    ].join('\n'));
    const { seen } = loadSeenUrls({}, { scanHistoryPath: history, pipelinePath: pipeline, applicationsPath: applications });
    assert.ok(seen.has(normalizeUrlForDedup('https://history.example/job/1')));
    assert.ok(seen.has(normalizeUrlForDedup('https://pipeline.example/job/2')));
    assert.ok(seen.has(normalizeUrlForDedup('https://himalayas.app/companies/hone-health/jobs/data-engineering-intern-fall-2026')));
    assert.ok(seen.has(normalizeUrlForDedup('https://example.com/job/123')));
    assert.deepEqual(extractHttpUrlsFromMarkdown('[x](https://example.com/job/123).'), ['https://example.com/job/123']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    assert.match(partial.result.stdout, /Targets failed:\s+1/);
    assert.match(partial.result.stdout, /Targets degraded:\s+0/);
    assert.match(partial.result.stdout, /Completion status:\s+partial/);
    assert.equal(existsSync(partial.runDir), true);
    assert.match(readFileSync(partial.pipeline, 'utf8'), /Backend Engineer/);
  } finally {
    for (const fixture of [healthy, failed, partial]) rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('standard scan counts partial provider coverage as degraded while retaining jobs', () => {
  const fixture = standardScanFixture([{ name: 'Truncated', mode: 'degraded' }], 'degraded-provider');
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.match(fixture.result.stdout, /Targets failed:\s+0/);
    assert.match(fixture.result.stdout, /Targets degraded:\s+1/);
    assert.match(fixture.result.stdout, /Completion status:\s+partial/);
    assert.match(readFileSync(fixture.pipeline, 'utf8'), /\/partial/);
    const manifest = JSON.parse(readFileSync(join(fixture.runDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.metadata.targets_succeeded, 1);
    assert.equal(manifest.metadata.targets_degraded, 1);
    assert.equal(manifest.metadata.targets_failed, 0);
    const health = readFileSync(join(fixture.data, 'portal-health.tsv'), 'utf8');
    assert.match(health, /Truncated\tpartial:provider_degraded/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('typed partial coverage is a degraded success, not an error', () => {
  const fixture = standardScanFixture([{ name: 'Typed', mode: 'typed-degraded' }], 'typed-degraded-provider');
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.match(fixture.result.stdout, /Targets succeeded:\s+1\/1/);
    assert.match(fixture.result.stdout, /Targets failed:\s+0/);
    assert.match(fixture.result.stdout, /Targets degraded:\s+1/);
    assert.match(fixture.result.stdout, /Completion status:\s+partial/);
    assert.doesNotMatch(fixture.result.stdout, /Errors \(/);
    assert.match(readFileSync(fixture.pipeline, 'utf8'), /typed-partial/);
    const manifest = JSON.parse(readFileSync(join(fixture.runDir, 'manifest.json'), 'utf8'));
    assert.deepEqual([
      manifest.metadata.targets_attempted,
      manifest.metadata.targets_succeeded,
      manifest.metadata.targets_failed,
      manifest.metadata.targets_degraded,
    ], [1, 1, 0, 1]);
    assert.match(readFileSync(join(fixture.data, 'portal-health.tsv'), 'utf8'), /Typed\tpartial:max_pages/);
    assert.equal(lastTsvRow(fixture.scanRuns).errors, '0');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('local parser fallback reports degraded success and preserves both causes when fallback fails', () => {
  const recovered = standardScanFixture([{
    name: 'Recovered', provider: null, parser: true, careers_url: 'https://fallback.example/jobs', mode: 'fallback-ok',
  }], 'parser-fallback-success');
  const failed = standardScanFixture([{
    name: 'DoubleBroken', provider: null, parser: true, careers_url: 'https://fallback.example/jobs', mode: 'fallback-throws',
  }], 'parser-fallback-failed');
  try {
    assert.equal(recovered.result.status, 0, recovered.result.stderr);
    assert.match(recovered.result.stdout, /Targets succeeded:\s+1\/1/);
    assert.match(recovered.result.stdout, /Targets failed:\s+0/);
    assert.match(recovered.result.stdout, /Targets degraded:\s+1/);
    assert.match(recovered.result.stdout, /succeeded through a fallback provider/);
    assert.match(readFileSync(join(recovered.data, 'portal-health.tsv'), 'utf8'), /Recovered\tpartial:fallback/);
    assert.equal(lastTsvRow(recovered.scanRuns).errors, '0');

    assert.notEqual(failed.result.status, 0);
    assert.match(failed.result.stdout + failed.result.stderr, /primary parser exploded/);
    assert.match(failed.result.stdout + failed.result.stderr, /fallback network exploded/);
    assert.match(failed.result.stdout, /Targets succeeded:\s+0\/1/);
    assert.match(failed.result.stdout, /Targets failed:\s+1/);
    assert.match(failed.result.stdout, /Targets degraded:\s+0/);
    assert.match(failed.result.stdout, /Completion status:\s+failed/);
  } finally {
    rmSync(recovered.dir, { recursive: true, force: true });
    rmSync(failed.dir, { recursive: true, force: true });
  }
});

test('provider resolution failures count as attempted failures while WebSearch handoffs do not', () => {
  const mixed = standardScanFixture([
    { name: 'Working', mode: 'job' },
    { name: 'Unresolved', provider: 'missing-provider' },
  ], 'resolution-mixed');
  const failed = standardScanFixture([{ name: 'UnresolvedOnly', provider: 'missing-provider' }], 'resolution-only');
  const handoff = standardScanFixture([{ name: 'SearchOnly', provider: null, scan_method: 'websearch' }], 'handoff-only');
  try {
    assert.equal(mixed.result.status, 0, mixed.result.stderr);
    assert.match(mixed.result.stdout, /Targets succeeded:\s+1\/2/);
    assert.match(mixed.result.stdout, /Targets failed:\s+1/);
    assert.match(mixed.result.stdout, /Targets degraded:\s+0/);
    assert.match(mixed.result.stdout, /Completion status:\s+partial/);
    const manifest = JSON.parse(readFileSync(join(mixed.runDir, 'manifest.json'), 'utf8'));
    assert.deepEqual([
      manifest.metadata.targets_attempted,
      manifest.metadata.targets_succeeded,
      manifest.metadata.targets_failed,
      manifest.metadata.targets_degraded,
    ], [2, 1, 1, 0]);
    assert.match(readFileSync(join(mixed.data, 'portal-health.tsv'), 'utf8'), /Unresolved\tprovider_resolution/);
    assert.equal(lastTsvRow(mixed.scanRuns).errors, '1');

    assert.notEqual(failed.result.status, 0);
    assert.match(failed.result.stdout, /Targets succeeded:\s+0\/1/);
    assert.match(failed.result.stdout, /Targets failed:\s+1/);
    assert.match(failed.result.stdout, /Completion status:\s+failed/);

    assert.equal(handoff.result.status, 0, handoff.result.stderr);
    assert.match(handoff.result.stdout, /Targets succeeded:\s+0\/0/);
    assert.match(handoff.result.stdout, /Targets failed:\s+0/);
    assert.match(handoff.result.stdout, /Completion status:\s+handoff_only/);
  } finally {
    for (const fixture of [mixed, failed, handoff]) rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('failed and degraded targets remain separate dimensions in the same partial run', () => {
  const fixture = standardScanFixture([
    { name: 'Typed', mode: 'typed-degraded' },
    { name: 'Broken', mode: 'throw' },
  ], 'failed-and-degraded');
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.match(fixture.result.stdout, /Targets succeeded:\s+1\/2/);
    assert.match(fixture.result.stdout, /Targets failed:\s+1/);
    assert.match(fixture.result.stdout, /Targets degraded:\s+1/);
    assert.equal(lastTsvRow(fixture.scanRuns).errors, '1');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
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
  assert.equal(remote('Madrid, Spain', 'https://jobs.example/123', 'Backend Engineer — Remote'), false);
});

test('location filtering requires explicit allowed-region evidence over blocked geography', () => {
  const filter = buildLocationFilter({ always_allow: ['remote', 'europe', 'finland'], allow: ['finland', 'europe'], block: ['united states', 'usa', 'spain'] });
  assert.equal(filter('Remote - United States', '', 'Engineer'), false);
  assert.equal(filter('Madrid, Spain', '', 'Remote Engineer'), false);
  assert.equal(filter('Remote Europe', '', 'Engineer'), true);
  assert.equal(filter('New York, United States; Helsinki, Finland', '', 'Engineer'), true);
});

test('location eligibility is source-aware across targets, restrictions, ISO codes, and non-geographic values', () => {
  const classify = buildLocationClassifier({
    always_allow: ['Finland', 'Helsinki', 'Germany', 'Berlin', 'Denmark', 'Copenhagen', 'Netherlands', 'Amsterdam'],
    allow: ['Remote Europe', 'Europe', 'European Union', 'EU', 'EEA', 'Remote', 'Worldwide'],
    block: ['United States', 'USA', 'US only'],
  });
  const eligible = [
    ['Berlin, Germany'],
    ['', '', 'Software Engineer - Berlin'],
    ['United States', '', 'Software Engineer - Berlin'],
    ['United States; Helsinki, Finland'],
    ['Remote Europe'], ['Europe'], ['EU'], ['EEA'], ['European Union'], ['European Economic Area'],
    ['Karlsruhe, DE'], ['Groningen, NL'], ['Herning, DK'], ['Kuopio, FI'],
    ['Remote', 'https://jobs.example/jobs/berlin/backend-engineer', 'Backend Engineer'],
  ];
  for (const args of eligible) assert.equal(classify(...args).status, 'eligible', args.join(' | '));

  const titleEvidence = classify('United States', '', 'Software Engineer - Berlin');
  assert.deepEqual(titleEvidence, { status: 'eligible', code: 'target_region', matched: 'Berlin', source: 'title' });
  const isoEvidence = classify('Herning, DK');
  assert.equal(isoEvidence.matched, 'Denmark');
  assert.equal(isoEvidence.source, 'location');
  const urlEvidence = classify('Remote', 'https://jobs.example/jobs/berlin/backend-engineer', 'Backend Engineer');
  assert.equal(urlEvidence.source, 'url');

  const ineligible = [
    ['US only'], ['US only', '', 'Software Engineer - Berlin'], ['Remote - US only'],
    ['Remote - Mexico'], ['Japan only'], ['North America only'], ['Madrid, Spain'],
    ['Toronto, Canada'], ['Spain, Remote'],
    ['US only', 'https://jobs.example/jobs/berlin/backend-engineer', 'Backend Engineer'],
  ];
  for (const args of ineligible) assert.equal(classify(...args).status, 'ineligible', args.join(' | '));

  const uncertain = [
    ['Remote'], ['Worldwide'], ['Global'], ['Anywhere in the World'], ['EMEA'], [''], ['Unknown'],
    ['Hybrid'], ['On-site'], ['Onsite'], ['Flexible'], ['Office / Remote'], ['Remote / Hybrid'],
    ['Remote, CET'], ['Remote, CEST'], ['Remote, GMT'], ['Remote, UTC+2'],
    ['Remote, UTC+1 to UTC+3'], ['CET'], ['UTC+2'], ['office'],
    ['Remote', 'https://jobs.example/de/jobs/backend-engineer', 'Backend Engineer'],
    ['Remote', 'https://jobs.example/eu/jobs/backend-engineer', 'Backend Engineer'],
    ['', 'https://jobs.example/jobs/de/backend-engineer', 'Backend Engineer'],
    ['', '', 'Backend Engineer DE'], ['', '', 'Backend Engineer define'],
  ];
  for (const args of uncertain) assert.equal(classify(...args).status, 'uncertain', args.join(' | '));

  for (const country of ['Finland', 'Germany', 'Denmark', 'Netherlands']) {
    const withoutCountry = buildLocationClassifier({
      allow: ['Remote'],
      always_allow: ['Finland', 'Germany', 'Denmark', 'Netherlands'].filter((value) => value !== country),
    });
    const iso = { Finland: 'FI', Germany: 'DE', Denmark: 'DK', Netherlands: 'NL' }[country];
    assert.notEqual(withoutCountry(`Somewhere, ${iso}`).status, 'eligible', country);
  }
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
    assert.equal(computeConsecutiveFailures([
      { company: 'Partial', status: 'server' },
      { company: 'Partial', status: 'partial:max_pages' },
    ]).get('Partial'), 0);
    assert.equal(computeConsecutiveFailures([{ company: 'Malformed' }]).get('Malformed'), 1);
    assert.equal(classifyFetchError({ status: 404 }), 'slug_gone');
    assert.equal(classifyFetchError({ status: 404, kind: 'endpoint_gone' }), 'endpoint_gone');
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
