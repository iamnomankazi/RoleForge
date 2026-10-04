import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TMP_ROOT = resolve(tmpdir());

function removeTempTree(directory) {
  const target = resolve(directory);
  const rel = relative(TMP_ROOT, target);
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`), `refusing to remove outside temp root: ${target}`);
  rmSync(target, { recursive: true, force: true });
}

function fixture({ companies, runId, includeUndated = false, resolverLimit = '50' }) {
  const dir = mkdtempSync(join(TMP_ROOT, 'career-ops-icims-full-'));
  const providers = join(dir, 'providers');
  const cache = join(dir, 'data', 'cache', 'ats-companies');
  mkdirSync(providers, { recursive: true });
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'icims.json'), JSON.stringify(companies));

  const resultHelper = pathToFileURL(join(ROOT, 'providers', '_result.mjs')).href;
  writeFileSync(join(providers, 'icims.mjs'), `import { appendFileSync } from 'node:fs';
import { markProviderCoverage } from ${JSON.stringify(resultHelper)};

const job = (sourceId, title = 'Backend Engineer', location = 'Remote', extra = {}) => ({
  company: 'Acme', title, url: 'https://careers-acme.icims.com/jobs/' + sourceId + '/backend-engineer/job',
  location, sourceId, ...extra,
});

export default {
  id: 'icims',
  async fetch(entry) {
    const scenario = process.env.ICIMS_FIXTURE_SCENARIO;
    if (scenario === 'mixed') {
      return [
        job(1, 'Office Manager'),
        job(2, 'Backend Engineer', 'Remote - United States'),
        job(3, 'Backend Engineer', ''),
        job(30, 'Backend Engineer', 'Remote', { url: 'https://careers-acme.icims.com/jobs/3/backend-engineer/job?utm_source=duplicate' }),
        job(4, 'Backend Engineer', 'Remote', { postedAt: Date.now() - 100 * 86_400_000 }),
        job(6), job(7), job(8),
      ];
    }
    if (scenario === 'checkpoint' && entry.name === 'resume-slug' && process.env.ICIMS_FIXTURE_RECOVER !== '1') {
      const error = new Error('fixture resolver refusal');
      error.code = 'EREFUSED';
      throw error;
    }
    const jobs = [job(entry.name === 'capslug' ? 90 : 91, 'Backend Engineer', 'Helsinki, Finland', { postedAt: Date.now() - 60_000 })];
    return scenario === 'checkpoint' && entry.name === 'capslug'
      ? markProviderCoverage(jobs, { status: 'partial', code: 'icims_page_cap', reason: 'fixture reached the page cap', pagesFetched: 30, maxPages: 30 })
      : jobs;
  },
  async enrichDate(posting) {
    appendFileSync(process.env.ICIMS_ENRICH_LOG, String(posting.sourceId) + '\\n');
    if (posting.sourceId === 6) throw new Error('fixture detail page unavailable');
    if (posting.sourceId === 7) return posting;
    posting.postedAt = Date.now() - 60_000;
    if (posting.sourceId === 8) posting.location = 'New York, United States';
    return posting;
  },
};
`);

  const portals = join(dir, 'portals.yml');
  writeFileSync(portals, 'title_filter:\n  positive: [Engineer]\nlocation_filter:\n  allow: [Finland, Europe]\n  always_allow: [Remote]\n  block: [United States, Canada]\n');
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n');
  writeFileSync(join(dir, 'data', 'scan-history.tsv'), 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n');
  const checkpoint = join(dir, 'data', 'cache', 'checkpoint.json');
  const enrichLog = join(dir, 'enrich.log');
  return { dir, providers, cache, portals, checkpoint, enrichLog, runId, includeUndated, resolverLimit, runDir: join(dir, 'output', 'scan-runs', runId) };
}

function parsed(result) {
  assert.ok(result.stdout.trim(), `expected JSON stdout; stderr was:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('iCIMS reverse scans enrich only eligible undated jobs, re-filter detail locations, and preserve source identity', () => {
  const defaultRun = fixture({ companies: ['acme'], runId: 'icims-enrich-default' });
  const includeRun = fixture({ companies: ['acme'], runId: 'icims-enrich-undated', includeUndated: true });
  try {
    for (const current of [defaultRun, includeRun]) {
      current.result = spawnSync(process.execPath, [
        join(ROOT, 'scan-ats-full.mjs'), '--run-id', current.runId, '--ats', 'icims', '--json',
        ...(current.includeUndated ? ['--include-undated'] : []),
      ], {
        cwd: current.dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          CAREER_OPS_PORTALS: current.portals,
          CAREER_OPS_ATS_PROVIDERS_DIR: current.providers,
          CAREER_OPS_ATS_CHECKPOINT: current.checkpoint,
          CAREER_OPS_NO_DNS_CACHE: '1',
          ICIMS_FIXTURE_SCENARIO: 'mixed',
          ICIMS_ENRICH_LOG: current.enrichLog,
          DOTENV_CONFIG_QUIET: 'true',
        },
      });
      assert.equal(current.result.status, 0, current.result.stderr);
      current.json = parsed(current.result);
    }

    for (const current of [defaultRun, includeRun]) {
      const attempts = readFileSync(current.enrichLog, 'utf8').trim().split(/\r?\n/).map(Number).sort((a, b) => a - b);
      assert.deepEqual(attempts, [3, 6, 7, 8, 30]);
      assert.ok(current.json.offers.some((offer) => offer.source === 'icims-full' && offer.dateStatus === 'dated' && offer.url.includes('/jobs/3/')));
      assert.equal(current.json.offers.some((offer) => offer.url.includes('/jobs/4/')), false, 'stale dated postings are always dropped');
      assert.equal(current.json.offers.some((offer) => offer.url.includes('/jobs/8/')), false, 'newly disclosed blocked countries are re-filtered');
      assert.equal(current.json.offers.some((offer) => offer.url.includes('/jobs/2/')), false, 'initially blocked countries are dropped');
      assert.equal(current.json.offers.filter((offer) => offer.url.includes('/jobs/3/')).length, 1, 'canonical URL dedup keeps one listing');
    }

    assert.equal(defaultRun.json.postingsDroppedNoDate, 4);
    assert.equal(defaultRun.json.offers.some((offer) => offer.url.includes('/jobs/6/') || offer.url.includes('/jobs/7/')), false);
    assert.ok(includeRun.json.offers.some((offer) => offer.url.includes('/jobs/6/') && offer.dateStatus === 'unknown'));
    assert.ok(includeRun.json.offers.some((offer) => offer.url.includes('/jobs/7/') && offer.dateStatus === 'unknown'));

    const manifest = JSON.parse(readFileSync(join(defaultRun.runDir, 'manifest.json'), 'utf8'));
    const candidates = JSON.parse(readFileSync(join(defaultRun.runDir, 'candidates.json'), 'utf8'));
    const sourceCandidate = candidates.find((candidate) => candidate.source_id === '3');
    assert.ok(sourceCandidate, 'numeric iCIMS sourceId reaches the canonical candidate');
    assert.ok(sourceCandidate.provenance.some((item) => item.source_id === '3'));
    assert.equal(manifest.metadata.completion_status, 'completed');
  } finally {
    removeTempTree(defaultRun.dir);
    removeTempTree(includeRun.dir);
  }
});

test('iCIMS page-cap coverage remains visible through checkpoint resume, JSON, summary, and canonical metadata', () => {
  const current = fixture({ companies: ['capslug', 'resume-slug'], runId: 'icims-cap-resume', resolverLimit: '1' });
  try {
    const first = spawnSync(process.execPath, [
      join(ROOT, 'scan-ats-full.mjs'), '--run-id', current.runId, '--ats', 'icims', '--json',
    ], {
      cwd: current.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        CAREER_OPS_PORTALS: current.portals,
        CAREER_OPS_ATS_PROVIDERS_DIR: current.providers,
        CAREER_OPS_ATS_CHECKPOINT: current.checkpoint,
        CAREER_OPS_RESOLVER_FAILURE_LIMIT: '1',
        CAREER_OPS_NO_DNS_CACHE: '1',
        ICIMS_FIXTURE_SCENARIO: 'checkpoint',
        ICIMS_ENRICH_LOG: current.enrichLog,
        DOTENV_CONFIG_QUIET: 'true',
      },
    });
    assert.notEqual(first.status, 0);
    const checkpoint = JSON.parse(readFileSync(current.checkpoint, 'utf8'));
    assert.equal(checkpoint.counters.degradedBoards, 1);
    assert.equal(checkpoint.counters.cappedBoards, 1);
    assert.equal(checkpoint.counters.totalErrors, 1, 'the page cap does not add an unreachable-board error');
    assert.deepEqual(checkpoint.cappedBoardDetails.map((board) => board.code), ['icims_page_cap']);

    const resumed = spawnSync(process.execPath, [
      join(ROOT, 'scan-ats-full.mjs'), '--resume', '--run-id', current.runId, '--ats', 'icims', '--json',
    ], {
      cwd: current.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        CAREER_OPS_PORTALS: current.portals,
        CAREER_OPS_ATS_PROVIDERS_DIR: current.providers,
        CAREER_OPS_ATS_CHECKPOINT: current.checkpoint,
        CAREER_OPS_RESOLVER_FAILURE_LIMIT: '1',
        CAREER_OPS_NO_DNS_CACHE: '1',
        ICIMS_FIXTURE_SCENARIO: 'checkpoint',
        ICIMS_FIXTURE_RECOVER: '1',
        ICIMS_ENRICH_LOG: current.enrichLog,
        DOTENV_CONFIG_QUIET: 'true',
      },
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    const json = parsed(resumed);
    assert.equal(json.status, 'partial');
    assert.equal(json.unreachableBoards, 1);
    assert.equal(json.degradedBoards, 1);
    assert.equal(json.cappedBoards, 1);
    assert.equal(json.cappedBoardDetails[0].code, 'icims_page_cap');
    assert.match(resumed.stderr, /Capped boards:\s+1 \(icims_page_cap\)/);
    const manifest = JSON.parse(readFileSync(join(json.immutableRunDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.metadata.targets_degraded, 1);
    assert.equal(manifest.metadata.targets_capped, 1);
    assert.equal(manifest.metadata.capped_boards[0].company, 'capslug');
  } finally {
    delete process.env.ICIMS_FIXTURE_SCENARIO;
    removeTempTree(current.dir);
  }
});
