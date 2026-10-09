#!/usr/bin/env node

/**
 * scan-ats-full.mjs — Reverse ATS discovery scanner. Part of #230.
 *
 * Where scan.mjs scans the companies you track in portals.yml, this script
 * inverts the direction: it walks public directories of companies per ATS
 * (Greenhouse, Lever, Ashby, Workday, iCIMS) and surfaces fresh postings that match
 * your portals.yml `title_filter` / `location_filter` — no manual company
 * curation needed.
 *
 * Company directories come from the public job-board-aggregator dataset
 * (github.com/Feashliaa/job-board-aggregator), cached in data/cache/ for 24h.
 *
 * Zero LLM tokens — pure HTTP + JSON, same providers/ modules as scan.mjs.
 * Postings without a usable publish date are skipped: a reverse scan is only
 * useful for fresh postings, and stale results would flood the pipeline.
 *
 * Usage:
 *   node scan-ats-full.mjs                      # scan default ATS directories, last 3 days
 *   node scan-ats-full.mjs --since 7            # postings from the last 7 days
 *   node scan-ats-full.mjs --ats greenhouse,workday  # subset of sources
 *   node scan-ats-full.mjs --ats icims          # opt in to iCIMS (disabled by default)
 *   node scan-ats-full.mjs --limit 200          # max companies per ATS (default: all)
 *   node scan-ats-full.mjs --dry-run            # preview without writing files
 *   node scan-ats-full.mjs --liveness           # Playwright-verify matches before writing
 *   node scan-ats-full.mjs --verbose            # log per-board fetch failures
 *   node scan-ats-full.mjs --md-out <dir>       # also write a dated markdown digest to <dir>
 *   node scan-ats-full.mjs --help               # print this usage block and exit
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { pathToFileURL } from 'url';
import path from 'path';
import yaml from 'js-yaml';

import { makeHttpCtx, fetchJson } from './providers/_http.mjs';
import greenhouse from './providers/greenhouse.mjs';
import lever from './providers/lever.mjs';
import ashby from './providers/ashby.mjs';
import workday from './providers/workday.mjs';
import icims from './providers/icims.mjs';
import { providerCoverage } from './providers/_result.mjs';
import { buildTitleFilter, buildLocationFilter, loadSeenUrls, appendToPipeline, appendToScanHistory, normalizeUrlForDedup, parseSinceDays } from './scan.mjs';
import { SEED_SOURCES, toPortalEntry } from './seeds/vc-portfolios.mjs';
import { writeImmutableScanRun } from './scan-candidate-contract.mjs';
import { isResolverFailure } from './providers/_dns-cache.mjs';

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';
const PIPELINE_PATH = 'data/pipeline.md';
const CACHE_DIR = 'data/cache/ats-companies';
const CACHE_TTL_HOURS = 24;
// Tracks `main` deliberately: the dataset's value is freshness (new boards
// appear weekly), so pinning a commit would defeat the purpose. Integrity rests
// on two layers instead: SLUG_RE validates every entry against a safe charset
// before interpolation, and entryOnHost (below) re-parses each finished
// careers_url and drops anything that doesn't resolve to the ATS's own host —
// so a tampered dataset can at worst name boards that don't exist.
const DATASET_BASE = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data';
const CONCURRENCY = 20;
const RESOLVER_FAILURE_LIMIT = Number(process.env.CAREER_OPS_RESOLVER_FAILURE_LIMIT) || 50;
const CHECKPOINT_PATH = process.env.CAREER_OPS_ATS_CHECKPOINT || 'data/cache/ats-full-checkpoint.json';

// Dataset entries are external input destined for URL interpolation — reject
// anything outside a conservative slug charset.
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

// SSRF guard / defense in depth: confirm a constructed careers_url actually
// resolves to the expected ATS host before it reaches provider.fetch. Returns
// the synthetic entry, or null if the URL won't parse or the host isn't canonical.
export function entryOnHost(name, careersUrl, isCanonicalHost) {
  let hostname;
  try {
    ({ hostname } = new URL(careersUrl));
  } catch {
    return null;
  }
  return isCanonicalHost(hostname) ? { name, careers_url: careersUrl } : null;
}

// Each source: the provider module that does the fetching, plus how to turn a
// dataset entry into a synthetic PortalEntry the provider can detect/fetch.
const DNS_LABEL_RE = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function isDnsHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host.length <= 253 && host.split('.').every(label => DNS_LABEL_RE.test(label));
}

// Build only validated iCIMS hostnames. The source directory contains
// company slugs rather than canonical tenant hostnames, so keep the ordered
// alternate as a provider fallback that is used only after a first-page 404.
export function icimsHostCandidates(value) {
  const name = String(value ?? '');
  if (!SLUG_RE.test(name) || /[\r\n]/.test(name)) return [];
  const slug = name.replace(/^-+/, '').toLowerCase();
  if (!slug || !SLUG_RE.test(slug)) return [];

  let candidates;
  if (slug.startsWith('careers-')) {
    candidates = [slug];
  } else if (slug.includes('careers')) {
    candidates = [slug, `careers-${slug}`];
  } else {
    candidates = [`careers-${slug}`, slug];
  }

  return candidates.map((candidate) => {
    const hostname = `${candidate}.icims.com`;
    const entry = entryOnHost(name, `https://${hostname}`, host =>
      host === hostname && isDnsHostname(host) && host.endsWith('.icims.com'));
    return entry ? new URL(entry.careers_url).hostname : null;
  }).filter(Boolean);
}

// The catalog does not identify Lever's region. Retry a missing global board
// once on the EU host, keeping this discovery behavior out of tracked scans.
async function fetchLeverBoard(entry, ctx) {
  try {
    return await lever.fetch(entry, ctx);
  } catch (error) {
    if (error?.status !== 404) throw error;
    const url = new URL(entry.careers_url);
    if (url.hostname !== 'jobs.lever.co') throw error;
    url.hostname = 'jobs.eu.lever.co';
    return lever.fetch({ ...entry, careers_url: url.href }, ctx);
  }
}

export const SOURCES = {
  greenhouse: {
    provider: greenhouse,
    dataset: `${DATASET_BASE}/greenhouse_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://job-boards.greenhouse.io/${slug}`, h => h === 'job-boards.greenhouse.io')
      : null,
  },
  lever: {
    provider: { ...lever, fetch: fetchLeverBoard },
    dataset: `${DATASET_BASE}/lever_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://jobs.lever.co/${slug}`, h => h === 'jobs.lever.co')
      : null,
  },
  ashby: {
    provider: ashby,
    dataset: `${DATASET_BASE}/ashby_companies.json`,
    toEntry: (slug) => SLUG_RE.test(String(slug))
      ? entryOnHost(String(slug), `https://jobs.ashbyhq.com/${slug}`, h => h === 'jobs.ashbyhq.com')
      : null,
  },
  workday: {
    provider: workday,
    dataset: `${DATASET_BASE}/workday_companies.json`,
    // Dataset entries are "tenant|instance|site" triples.
    toEntry: (line) => {
      const [tenant, instance, site] = String(line).split('|');
      if (![tenant, instance, site].every(p => p && SLUG_RE.test(p))) return null;
      return entryOnHost(
        tenant,
        `https://${tenant}.${instance}.myworkdayjobs.com/${site}`,
        h => h === `${tenant}.${instance}.myworkdayjobs.com` && h.endsWith('.myworkdayjobs.com'),
      );
    },
  },
  icims: {
    provider: icims,
    dataset: `${DATASET_BASE}/icims_companies.json`,
    toEntry: (slug) => {
      const candidates = icimsHostCandidates(slug);
      if (!candidates.length) return null;
      return {
        name: String(slug),
        careers_url: `https://${candidates[0]}`,
        ...(candidates.length > 1 ? { fallback_urls: candidates.slice(1).map(host => `https://${host}`) } : {}),
      };
    },
  },
};

async function runtimeSources() {
  const fixtureDir = process.env.CAREER_OPS_ATS_PROVIDERS_DIR;
  if (!fixtureDir) return SOURCES;
  const resolved = {};
  for (const [name, source] of Object.entries(SOURCES)) {
    const modulePath = path.resolve(fixtureDir, `${name}.mjs`);
    if (!existsSync(modulePath)) {
      resolved[name] = source;
      continue;
    }
    const provider = (await import(pathToFileURL(modulePath).href)).default;
    if (!provider || typeof provider.fetch !== 'function') throw new Error(`fixture provider ${name} must export { fetch }`);
    resolved[name] = { ...source, provider };
  }
  return resolved;
}

// ── CLI args ────────────────────────────────────────────────────────

const KNOWN_FLAGS = [
  '--run-id', '--since', '--limit', '--ats', '--seeds', '--dry-run', '--liveness',
  '--verbose', '--md-out', '--json', '--include-undated', '--shuffle', '--resume',
  '--help', '-h',
];

// Flags that consume the next argv token as a value (space-separated form —
// the `--flag=value` form is self-contained and never needs this).
const VALUE_FLAGS = ['--run-id', '--since', '--limit', '--ats', '--seeds', '--md-out'];

const USAGE = `Usage:
  node scan-ats-full.mjs --run-id <id>        # scan default ATS directories, last 3 days
  node scan-ats-full.mjs --since 7            # postings from the last 7 days
  node scan-ats-full.mjs --ats greenhouse,workday  # subset of sources
  node scan-ats-full.mjs --ats icims          # opt in to iCIMS (disabled by default)
  node scan-ats-full.mjs --limit 200          # max companies per ATS (default: all)
  node scan-ats-full.mjs --dry-run            # preview without writing files
  node scan-ats-full.mjs --liveness           # Playwright-verify matches before writing
  node scan-ats-full.mjs --verbose            # log per-board fetch failures
  node scan-ats-full.mjs --md-out <dir>       # also write a dated markdown digest to <dir>
  node scan-ats-full.mjs --help               # print this usage block and exit`;

export function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  // A value-taking flag's space-separated value (e.g. the `-tmp` in
  // `--md-out -tmp`) must not be mistaken for an unrecognized flag just
  // because it happens to start with `-`. Mirrors valueOf()'s own adjacency
  // rule below so `--flag value` and `--flag=value` are validated consistently.
  const consumedValueIndices = new Set();
  args.forEach((a, idx) => {
    if (VALUE_FLAGS.includes(a) && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')) {
      consumedValueIndices.add(idx + 1);
    }
  });

  const unknownFlags = args.filter((a, idx) =>
    a.startsWith('-') && !consumedValueIndices.has(idx) && !KNOWN_FLAGS.includes(a.split('=')[0]));
  if (unknownFlags.length) {
    console.error(`Error: unrecognized flag(s): ${unknownFlags.join(', ')}. Valid flags: ${KNOWN_FLAGS.join(', ')}`);
    process.exit(1);
  }

  const valueOf = (flag) => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
    const kv = args.find(a => a.startsWith(flag + '='));
    return kv ? kv.split('=').slice(1).join('=') : null;
  };
  const sinceDays = parseSinceDays(args, 3);
  const runId = valueOf('--run-id');
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(runId)) {
    throw new Error('Explicit --run-id with 1-120 safe filename characters is required');
  }
  const limit = Number(valueOf('--limit')) || Infinity;
  const atsArg = valueOf('--ats');
  // --seeds: optional comma-separated VC portfolio sources (e.g. yc,a16z).
  // When set, the seed companies are fetched and probed via the ATS providers
  // instead of (or in addition to) the regular ATS directory walk.
  const seedsArg = valueOf('--seeds');
  const seeds = seedsArg
    ? seedsArg.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];
  const unknownSeeds = seeds.filter(s => !SEED_SOURCES[s]);
  if (unknownSeeds.length) {
    console.error(`Error: unknown seed source(s): ${unknownSeeds.join(', ')}. Valid: ${Object.keys(SEED_SOURCES).join(', ')}`);
    process.exit(1);
  }
  // When --seeds is the only discovery flag (no --ats), default --ats to none
  // so we don't also walk the full ATS directories unintentionally.
  const ats = atsArg
    ? atsArg.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : (seeds.length > 0 ? [] : Object.keys(SOURCES).filter(name => name !== 'icims'));
  const unknown = ats.filter(a => !SOURCES[a]);
  if (unknown.length) {
    console.error(`Error: unknown ATS source(s): ${unknown.join(', ')}. Valid: ${Object.keys(SOURCES).join(', ')}`);
    process.exit(1);
  }
  return {
    runId,
    sinceDays,
    limit,
    ats,
    seeds,
    dryRun: args.includes('--dry-run'),
    liveness: args.includes('--liveness'),
    verbose: args.includes('--verbose'),
    mdOut: valueOf('--md-out'),
    json: args.includes('--json'),
    includeUndated: args.includes('--include-undated'),
    shuffle: args.includes('--shuffle'),
    resume: args.includes('--resume'),
  };
}

export function writeAtsCheckpoint(payload, filePath = CHECKPOINT_PATH) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(temporary, filePath);
  return true;
}

export function loadAtsCheckpoint(filePath = CHECKPOINT_PATH) {
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, 'utf8')); } catch { return null; }
}

export function persistFullAtsScanRun({ root = process.cwd(), runId, offers, createdAt = new Date().toISOString(), metadata = {} }) {
  return writeImmutableScanRun({
    root,
    runId,
    createdAt,
    sourceArchitecture: 'reverse_ats_full',
    inputs: [{ name: 'scan-ats-full', rows: offers }],
    metadata,
  });
}

// ── Company list cache (24h TTL) ────────────────────────────────────

// Returns { list, status } where status is:
//   'ok'    — fresh fetch, or a cache entry still within TTL
//   'stale' — network fetch failed; falling back to an expired cache
//   'empty' — no data at all (no cache, fetch failed/non-array)
// The status lets callers (and --json) distinguish a degraded scan from an empty one.
async function loadCompanyList(name, url) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${name}.json`);
  if (existsSync(cacheFile)) {
    const ageHours = (Date.now() - statSync(cacheFile).mtimeMs) / 3_600_000;
    if (ageHours < CACHE_TTL_HOURS) {
      try { return { list: JSON.parse(readFileSync(cacheFile, 'utf-8')), status: 'ok' }; } catch { /* refetch below */ }
    }
  }
  try {
    const data = await fetchJson(url, { timeoutMs: 30_000 });
    if (Array.isArray(data)) {
      writeFileSync(cacheFile, JSON.stringify(data), 'utf-8');
      return { list: data, status: 'ok' };
    }
  } catch (err) {
    console.error(`⚠️  ${name}: could not download company list — ${err.message}`);
  }
  // Stale cache beats nothing.
  if (existsSync(cacheFile)) {
    try { return { list: JSON.parse(readFileSync(cacheFile, 'utf-8')), status: 'stale' }; } catch { /* fall through */ }
  }
  return { list: [], status: 'empty' };
}

// Date gate for one posting in a reverse (fresh-first) scan:
//   'stale'   — dated, but older than the cutoff → always dropped
//   'undated' — no usable publish date → dropped by default, kept with --include-undated
//   'keep'    — dated and within the window
function isUsablePostingEpoch(postedAt) {
  return Number.isFinite(postedAt) && Number.isFinite(new Date(postedAt).getTime());
}

function formatPostingDate(postedAt, fallback = 'n/a') {
  if (!isUsablePostingEpoch(postedAt)) return fallback;
  return new Date(postedAt).toISOString().slice(0, 10);
}

export function classifyPostingDate(job, cutoff) {
  const postedAt = job?.postedAt;
  if (!isUsablePostingEpoch(postedAt)) return 'undated';
  if (postedAt < cutoff) return 'stale';
  return 'keep';
}

async function eligibleProviderJobs(jobs, {
  provider,
  ctx,
  cutoff,
  includeUndated,
  titleFilter,
  locationFilter,
  onUndatedDrop = null,
}) {
  const eligible = [];
  for (const job of jobs) {
    if (!job.url || !job.title) continue;
    let dateClass = classifyPostingDate(job, cutoff);
    if (dateClass === 'stale') continue;

    const titleEligible = titleFilter(job.title, job.company);
    let locationEligible = locationFilter(job.location, job.url, job.title);
    if (dateClass === 'undated' && titleEligible && locationEligible && typeof provider?.enrichDate === 'function') {
      const originalPostedAt = job.postedAt;
      try {
        await provider.enrichDate(job, ctx);
      } catch {
        // Detail-page failure is not a board-fetch failure. Keep the job
        // undated and let the existing --include-undated policy decide it.
        job.postedAt = originalPostedAt;
      }
      dateClass = classifyPostingDate(job, cutoff);
      locationEligible = locationFilter(job.location, job.url, job.title);
      if (dateClass === 'stale') continue;
    }

    // Re-check location after a detail lookup, which may reveal a country
    // restriction that was not present on the search result card.
    if (dateClass === 'undated' && !includeUndated) {
      onUndatedDrop?.(job);
      continue;
    }
    if (!titleEligible || !locationEligible) continue;
    eligible.push({ job, dateStatus: dateClass === 'keep' ? 'dated' : 'unknown' });
  }
  return eligible;
}

function coverageBoard(source, company, coverage) {
  return {
    source,
    company,
    code: coverage.code,
    reason: coverage.reason,
    ...(Number.isInteger(coverage.pagesFetched) ? { pagesFetched: coverage.pagesFetched } : {}),
    ...(Number.isInteger(coverage.maxPages) ? { maxPages: coverage.maxPages } : {}),
    ...(Number.isInteger(coverage.totalPages) ? { totalPages: coverage.totalPages } : {}),
  };
}

function recordCoverage(coverage, source, company, degradedBoards, cappedBoards) {
  if (coverage?.status !== 'partial') return;
  const board = coverageBoard(source, company, coverage);
  degradedBoards.push(board);
  if (coverage.code === 'icims_page_cap') cappedBoards.push(board);
}

// Cap-aware company sampling. Default: the dataset's natural (alphabetical)
// prefix. With --shuffle: a random sample of `limit` companies, so a capped
// scan isn't always biased to the same alphabetical-first slice. Pure; returns
// a new array and never mutates `list`.
export function sampleCompanies(list, limit, shuffle) {
  if (!shuffle || limit >= list.length) return list.slice(0, limit);
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, limit);
}

// ── VC portfolio seed scan ──────────────────────────────────────────

// ATS providers that can auto-detect from a careers_url, in probe order.
// Workday is excluded: its URL format requires a tenant|instance|site triple
// that can't be derived from a portfolio slug alone.
const SEED_PROVIDERS = [greenhouse, lever, ashby, icims];

/**
 * Scan a VC portfolio seed source and return matching job offers.
 * Companies are converted to PortalEntry shape, then each ATS provider's
 * detect() is tried in order (greenhouse → lever → ashby). The first hit
 * wins and its fetch() is called — identical to how portals.yml tracked
 * companies flow through scan.mjs.
 *
 * @param {string}   seedId      Key from SEED_SOURCES (e.g. 'yc').
 * @param {object}   opts        Parsed CLI options.
 * @param {object}   ctx         HTTP context from makeHttpCtx().
 * @param {Set}      seenUrls    Shared dedup set (mutated in place).
 * @param {string}   label       Human-readable source label for logs.
 * @returns {Promise<{offers: object[], errors: number, total: number,
 *   attempted: number, succeeded: number, sourceUnavailable: boolean}>}
 */
export async function runSeedScan(seedId, opts, ctx, seenUrls, label) {
  const source = SEED_SOURCES[seedId];
  if (!source) throw new Error(`runSeedScan: unknown seed "${seedId}"`);

  let companies;
  try {
    companies = await source.fetch();
  } catch (err) {
    console.error(`⚠️  ${seedId}: could not fetch portfolio — ${err.message}`);
    return { offers: [], errors: 1, total: 0, attempted: 0, succeeded: 0, sourceUnavailable: true };
  }

  // Apply the --limit cap here too (by slug, consistent with sampleCompanies).
  const capped = opts.limit < companies.length
    ? (opts.shuffle
      ? (() => { const c = companies.slice(); for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c.slice(0, opts.limit); })()
      : companies.slice(0, opts.limit))
    : companies;

  const cutoff = Date.now() - opts.sinceDays * 86_400_000;
  const offers = [];
  let errors = 0;
  let attempted = 0;
  let succeeded = 0;
  let droppedNoDate = 0;
  const degradedBoardDetails = [];
  const cappedBoardDetails = [];

  await parallelEach(capped, CONCURRENCY, async (company) => {
    const entry = toPortalEntry(company);
    if (!entry.careers_url) return;

    // Try each ATS provider's detect() — first hit wins.
    let provider = null;
    for (const p of SEED_PROVIDERS) {
      if (p.id === 'icims' && !opts.ats?.includes('icims')) continue;
      try {
        if (p.detect?.(entry)) { provider = p; break; }
      } catch { /* no-op */ }
    }
    if (!provider) return; // No ATS detected — skip silently (or log in --verbose).

    let jobs;
    attempted++;
    try {
      jobs = await provider.fetch(entry, ctx);
      if (!Array.isArray(jobs)) throw new Error(`${provider.id}: fetch() did not return an array`);
      succeeded++;
    } catch (err) {
      errors++;
      if (opts.verbose) console.error(`  ✗ ${seedId}/${entry.name}: ${err.message}`);
      return;
    }

    const sourceName = `${seedId}-seed`;
    const matches = await eligibleProviderJobs(jobs, {
      provider,
      ctx,
      cutoff,
      includeUndated: opts.includeUndated,
      titleFilter: opts.titleFilter,
      locationFilter: opts.locationFilter,
      onUndatedDrop: () => { droppedNoDate++; },
    });
    if (jobs.providerDegraded) errors++;
    recordCoverage(providerCoverage(jobs), sourceName, entry.name, degradedBoardDetails, cappedBoardDetails);
    for (const { job, dateStatus } of matches) {
      const urlKey = normalizeUrlForDedup(job.url);
      if (seenUrls.has(urlKey)) continue;
      seenUrls.add(urlKey);
      offers.push({ ...job, source: sourceName, dateStatus });
    }
  });

  return {
    offers, errors, total: capped.length, attempted, succeeded, droppedNoDate,
    degradedBoardDetails, cappedBoardDetails, sourceUnavailable: capped.length === 0,
  };
}

// ── Parallel fetch with concurrency limit ───────────────────────────

export async function parallelEach(items, limit, fn, onItemDone = null, shouldStop = null) {
  let i = 0;
  let done = 0;
  const inFlight = new Set();
  let resumeAt = 0;
  async function worker() {
    while (i < items.length) {
      if (shouldStop?.()) return;
      const index = i++;
      inFlight.add(index);
      try { await fn(items[index], index); } finally {
        inFlight.delete(index);
        done++;
        resumeAt = inFlight.size > 0 ? Math.min(...inFlight) : i;
        onItemDone?.({ done, resumeAt });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return { done, resumeAt };
}

// ── Liveness verification (reuses liveness-browser.mjs) ────────────

async function filterLive(offers) {
  let chromium, checkUrlLiveness, newLivenessPage;
  try {
    ({ chromium } = await import('playwright'));
    ({ checkUrlLiveness, newLivenessPage } = await import('./liveness-browser.mjs'));
  } catch (err) {
    throw new Error(
      `--liveness requires Playwright with Chromium (run "npx playwright install chromium"): ${err.message}`,
      { cause: err },
    );
  }
  console.error(`\nVerifying liveness of ${offers.length} match(es) with Playwright (sequential)...`);
  const browser = await chromium.launch({ headless: true });
  const live = [];
  try {
    const page = await newLivenessPage(browser);
    // Sequential — project rule: never Playwright in parallel
    for (const offer of offers) {
      const { result, reason } = await checkUrlLiveness(page, offer.url);
      const icon = result === 'active' ? '✅' : result === 'expired' ? '❌' : '⚠️';
      console.error(`  ${icon} ${result.padEnd(9)} ${offer.company} | ${offer.title}${result === 'expired' ? ` (${reason})` : ''}`);
      if (result !== 'expired') live.push(offer); // keep 'uncertain' — transient errors retry next scan
    }
  } finally {
    await browser.close();
  }
  console.error(`  → ${live.length}/${offers.length} passed liveness`);
  return live;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  const activeSources = await runtimeSources();
  const cutoff = Date.now() - opts.sinceDays * 86_400_000;
  // In --json mode, stdout is reserved for the single machine-readable result,
  // so every human-facing line goes to stderr instead.
  const log = opts.json ? (...a) => console.error(...a) : (...a) => console.log(...a);
  const progress = (s) => { if (!opts.json) process.stdout.write(s); };

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first — the reverse scan reuses its title_filter/location_filter.');
    process.exit(1);
  }
  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const titleFilter = buildTitleFilter(config?.title_filter);
  const locationFilter = buildLocationFilter(config?.location_filter);
  if (!config?.title_filter?.positive?.length) {
    console.error('⚠️  portals.yml has no title_filter.positive — every fresh posting on every board will match. Consider adding keywords.');
  }
  // Attach filters to opts so runSeedScan can use them without extra parameters.
  opts.titleFilter = titleFilter;
  opts.locationFilter = locationFilter;

  const atsSummary = opts.ats.length ? `ats: ${opts.ats.join(', ')}` : '';
  const seedsSummary = opts.seeds.length ? `seeds: ${opts.seeds.join(', ')}` : '';
  const sourcesSummary = [atsSummary, seedsSummary].filter(Boolean).join(' | ');
  log(`Reverse ATS scan — ${sourcesSummary} | since ${opts.sinceDays}d${opts.limit < Infinity ? ` | limit ${opts.limit}/ats` : ''}${opts.shuffle ? ' | shuffled' : ''}${opts.includeUndated ? ' | +undated' : ''}${opts.liveness ? ' | liveness' : ''}${opts.dryRun ? ' | DRY RUN' : ''}`);

  const { seen: seenUrls } = loadSeenUrls();
  // sinceMs and includeUndated let providers (currently only workday.mjs)
  // stop paginating a tenant early instead of always walking to max_pages:
  // sinceMs once postings are confidently past the --since window, and
  // includeUndated (when false) for a tenant that exposes no postedOn at
  // all, since its postings would all be dropped as undated below anyway.
  const ctx = { ...makeHttpCtx(), sinceMs: cutoff, includeUndated: opts.includeUndated };
  const date = new Date().toISOString().slice(0, 10);

  const checkpoint = opts.resume ? loadAtsCheckpoint() : null;
  if (opts.resume && !checkpoint) throw new Error('--resume requested but no readable ATS checkpoint exists');
  if (checkpoint && checkpoint.runId !== opts.runId) {
    throw new Error(`checkpoint belongs to run ${checkpoint.runId}; resume with --run-id ${checkpoint.runId}`);
  }
  const newOffers = Array.isArray(checkpoint?.offers) ? checkpoint.offers : [];
  for (const offer of newOffers) {
    if (offer?.url) seenUrls.add(normalizeUrlForDedup(offer.url));
  }
  const completedSources = new Set(checkpoint?.completedSources || []);
  let totalCompaniesScanned = checkpoint?.counters?.totalCompaniesScanned || 0;
  let totalCompaniesAvailable = checkpoint?.counters?.totalCompaniesAvailable || 0;
  let totalErrors = checkpoint?.counters?.totalErrors || 0;
  const errorsAtStart = totalErrors;
  let totalAttemptedTargets = checkpoint?.counters?.totalAttemptedTargets || 0;
  let totalSuccessfulTargets = checkpoint?.counters?.totalSuccessfulTargets || 0;
  let droppedNoDate = checkpoint?.counters?.droppedNoDate || 0;
  const degradedBoardDetails = Array.isArray(checkpoint?.degradedBoardDetails) ? checkpoint.degradedBoardDetails : [];
  const cappedBoardDetails = Array.isArray(checkpoint?.cappedBoardDetails) ? checkpoint.cappedBoardDetails : [];
  let capHit = false;
  // Aggregated from providers/workday.mjs's jobs.workdayNoDateSkip tag — see
  // there for why this is a counter instead of a per-company console.error
  // (thousands of tenants hit this on a full directory scan; one line each
  // would just be the same message repeated thousands of times).
  let noDateSkipCompanies = 0;
  let noDateSkipJobs = 0;
  const datasetStatus = {};
  let unavailableSources = 0;
  let stoppedByOutage = false;
  let checkpointCanClear = Boolean(checkpoint);

  for (const name of opts.ats) {
    if (completedSources.has(name)) continue;
    const source = activeSources[name];
    const { list, status } = await loadCompanyList(name, source.dataset);
    datasetStatus[name] = status;
    if (list.length === 0) unavailableSources++;
    const resumingCurrent = checkpoint?.current?.name === name;
    if (!resumingCurrent) totalCompaniesAvailable += list.length;
    if (opts.limit < list.length) capHit = true;
    const startAt = 0;
    const sampledEntries = sampleCompanies(list, opts.limit, opts.shuffle).map(source.toEntry).filter(Boolean);
    const entries = resumingCurrent && Array.isArray(checkpoint.current.pendingEntries)
      ? checkpoint.current.pendingEntries
      : resumingCurrent && Array.isArray(checkpoint.current.remainingEntries)
        ? checkpoint.current.remainingEntries
        : sampledEntries;
    totalCompaniesScanned += entries.length;
    log(`\n⚙  ${name} — ${entries.length} companies${status !== 'ok' ? ` (dataset: ${status})` : ''}${startAt ? ` (resuming at ${startAt})` : ''}`);

    let errors = 0;
    let consecutiveResolverFailures = 0;
    let resolverOutage = false;
    let outageCompany = null;
    let lastDone = 0;
    let lastResumeAt = 0;
    const unresolved = new Set(entries.map((_, index) => index));
    await parallelEach(entries, CONCURRENCY, async (entry, entryIndex) => {
      totalAttemptedTargets++;
      try {
        const jobs = await source.provider.fetch(entry, ctx);
        if (!Array.isArray(jobs)) throw new Error(`${source.provider.id}: fetch() did not return an array`);
        totalSuccessfulTargets++;
        consecutiveResolverFailures = 0;
        const matches = await eligibleProviderJobs(jobs, {
          provider: source.provider,
          ctx,
          cutoff,
          includeUndated: opts.includeUndated,
          titleFilter,
          locationFilter,
          onUndatedDrop: () => { droppedNoDate++; },
        });
        if (jobs.providerDegraded) errors++;
        recordCoverage(providerCoverage(jobs), name, entry.name, degradedBoardDetails, cappedBoardDetails);
        if (jobs.workdayNoDateSkip) { noDateSkipCompanies++; noDateSkipJobs += jobs.length; }
        for (const { job, dateStatus } of matches) {
          const urlKey = normalizeUrlForDedup(job.url);
          if (seenUrls.has(urlKey)) continue;
          seenUrls.add(urlKey); // intra-scan dedup
          newOffers.push({ ...job, source: `${name}-full`, dateStatus });
        }
        unresolved.delete(entryIndex);
      } catch (err) {
        // Mostly defunct boards in the public dataset — expected noise, so the
        // default stays quiet; --verbose surfaces per-board failures.
        errors++;
        if (isResolverFailure(err)) {
          if (++consecutiveResolverFailures >= RESOLVER_FAILURE_LIMIT && !resolverOutage) {
            resolverOutage = true;
            outageCompany = entry.name;
          }
        } else {
          consecutiveResolverFailures = 0;
        }
        if (opts.verbose) console.error(`  ✗ ${name}/${entry.name}: ${err.message}`);
      }
    }, ({ done, resumeAt }) => {
      lastDone = done;
      lastResumeAt = resumeAt;
      if (done % 200 === 0 || done === entries.length) {
        progress(`  ${done}/${entries.length} scanned, ${newOffers.length} total matches\r`);
      }
    }, () => resolverOutage);
    totalErrors += errors;
    if (resolverOutage) {
      stoppedByOutage = true;
      totalCompaniesScanned -= entries.length - lastDone;
      if (!opts.dryRun) {
        writeAtsCheckpoint({
          version: 1,
          runId: opts.runId,
          current: {
            name,
            pendingEntries: [...unresolved].sort((a, b) => a - b).map((index) => entries[index]),
          },
          completedSources: [...completedSources],
          counters: {
            totalCompaniesScanned, totalCompaniesAvailable, totalErrors, totalAttemptedTargets,
            totalSuccessfulTargets, droppedNoDate,
            degradedBoards: degradedBoardDetails.length, cappedBoards: cappedBoardDetails.length,
          },
          degradedBoardDetails,
          cappedBoardDetails,
          offers: newOffers,
        });
      }
      log(`\n  ⛔ stopped ${name}/${outageCompany}: ${RESOLVER_FAILURE_LIMIT} consecutive resolver failures; checkpoint preserved for --resume`);
      break;
    }
    if (resumingCurrent && unresolved.size > 0) {
      checkpointCanClear = false;
      if (!opts.dryRun) {
        writeAtsCheckpoint({
          version: 1,
          runId: opts.runId,
          current: { name, pendingEntries: [...unresolved].sort((a, b) => a - b).map((index) => entries[index]) },
          completedSources: [...completedSources],
          counters: {
            totalCompaniesScanned, totalCompaniesAvailable, totalErrors, totalAttemptedTargets,
            totalSuccessfulTargets, droppedNoDate,
            degradedBoards: degradedBoardDetails.length, cappedBoards: cappedBoardDetails.length,
          },
          degradedBoardDetails,
          cappedBoardDetails,
          offers: newOffers,
        });
      }
    } else if (resumingCurrent) {
      checkpointCanClear = true;
    }
    if (!resumingCurrent || unresolved.size === 0) completedSources.add(name);
    log(`\n  done (${errors} unreachable boards skipped)`);
  }

  // ── VC portfolio seed sources (--seeds flag) ───────────────────────
  for (const seedId of stoppedByOutage ? [] : opts.seeds) {
    const seedSource = SEED_SOURCES[seedId];
    log(`\n🌱 ${seedSource.label} (${seedId}-seed) — fetching portfolio...`);
    const result = await runSeedScan(seedId, opts, ctx, seenUrls, seedSource.label);
    if (result && result.offers) {
      totalCompaniesScanned += result.total || 0;
      totalErrors += result.errors || 0;
      totalAttemptedTargets += result.attempted || 0;
      totalSuccessfulTargets += result.succeeded || 0;
      droppedNoDate += result.droppedNoDate || 0;
      degradedBoardDetails.push(...(result.degradedBoardDetails || []));
      cappedBoardDetails.push(...(result.cappedBoardDetails || []));
      if (result.sourceUnavailable) unavailableSources++;
      newOffers.push(...result.offers);
      log(`  done — ${result.total} companies probed, ${result.offers.length} matches (${result.errors} errors)`);
    }
  }

  const degradedDataset = Object.values(datasetStatus).some((status) => status !== 'ok');
  const resumeIncomplete = Boolean(checkpoint) && !checkpointCanClear;
  const noExecutableTargets = !stoppedByOutage && totalAttemptedTargets === 0;
  const allUnavailable = !stoppedByOutage && totalAttemptedTargets > 0 && totalSuccessfulTargets === 0;
  const completionStatus = stoppedByOutage || resumeIncomplete
    ? 'paused'
    : noExecutableTargets
      ? 'no_executable_targets'
    : allUnavailable
      ? 'failed'
      : (totalErrors > errorsAtStart || degradedDataset || unavailableSources > 0 || degradedBoardDetails.length > 0 ? 'partial' : 'completed');

  let offers = newOffers;
  if (offers.length && opts.liveness && !stoppedByOutage && !resumeIncomplete) offers = await filterLive(newOffers);
  offers.sort((a, b) => (
    (isUsablePostingEpoch(b.postedAt) ? b.postedAt : 0)
    - (isUsablePostingEpoch(a.postedAt) ? a.postedAt : 0)
  ));

  log(`\n${'━'.repeat(45)}`);
  log(`Reverse ATS Scan — ${date}`);
  log(`${'━'.repeat(45)}`);
  log(`Companies scanned:  ${totalCompaniesScanned}${capHit ? ` of ${totalCompaniesAvailable} (capped)` : ''}`);
  log(`Targets succeeded:  ${totalSuccessfulTargets}/${totalAttemptedTargets}`);
  log(`Unreachable boards: ${totalErrors}`);
  if (degradedBoardDetails.length) log(`Degraded boards:     ${degradedBoardDetails.length}`);
  if (cappedBoardDetails.length) {
    const capCodes = [...new Set(cappedBoardDetails.map(board => board.code))].join(', ');
    log(`Capped boards:       ${cappedBoardDetails.length} (${capCodes})`);
  }
  log(`Completion status:  ${completionStatus}${completionStatus === 'partial' ? ' (degraded)' : ''}`);
  // This counts raw listings from boards that stopped further undated
  // pagination. It is not a subset of droppedNoDate: detail enrichment can
  // recover dates for some listings before the final date gate. Report it as
  // raw-listing count labeled separately from the undated-drop total.
  if (droppedNoDate) {
    const breakdown = noDateSkipCompanies
      ? ` (${noDateSkipJobs} raw listings returned by ${noDateSkipCompanies} Workday board${noDateSkipCompanies === 1 ? '' : 's'} that stopped undated pagination)`
      : '';
    log(`Undated dropped: ${droppedNoDate}${breakdown}${opts.includeUndated ? '' : '. Use --include-undated to keep'}`);
  }
  log(`New matches:        ${offers.length}`);

  if (offers.length) {
    log('\nNew offers:');
    for (const o of offers) {
      const posted = formatPostingDate(o.postedAt);
      log(`  + [${o.source}] ${posted} | ${o.company} | ${o.title} | ${o.location || 'N/A'}\n    ${o.url}`);
    }
  }

  // Persist (unless dry-run, or nothing to save).
  let saved = false;
  let immutableRun = null;
  if (!opts.dryRun && totalSuccessfulTargets > 0 && !stoppedByOutage && !resumeIncomplete) {
    immutableRun = persistFullAtsScanRun({
      runId: opts.runId,
      offers,
      metadata: {
        sources: opts.ats, seeds: opts.seeds, since_days: opts.sinceDays,
        artifact_authority: 'review_only', completion_status: completionStatus,
        targets_attempted: totalAttemptedTargets, targets_succeeded: totalSuccessfulTargets,
        targets_degraded: degradedBoardDetails.length, targets_capped: cappedBoardDetails.length,
        degraded_boards: degradedBoardDetails, capped_boards: cappedBoardDetails,
      },
    });
    log(`\nImmutable canonical run: ${immutableRun.runDir}`);
  }
  if (offers.length && !opts.dryRun && totalSuccessfulTargets > 0 && !stoppedByOutage && !resumeIncomplete) {
    // appendToPipeline assumes the file exists (onboarding creates it) — cover fresh setups.
    if (!existsSync(PIPELINE_PATH)) {
      mkdirSync(path.dirname(PIPELINE_PATH), { recursive: true });
      writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pendientes\n', 'utf-8');
    }
    appendToPipeline(offers);
    appendToScanHistory(offers, date);
    saved = true;
    log(`\nResults saved to ${PIPELINE_PATH} and data/scan-history.tsv`);

    if (opts.mdOut) {
      try {
        mkdirSync(opts.mdOut, { recursive: true });
        const digest = [
          `# Reverse ATS Scan — ${date}`,
          `> ${offers.length} jobs | since ${opts.sinceDays}d | ${opts.liveness ? 'liveness ✓' : 'no liveness check'}`,
          '',
          ...offers.map(o => {
            const posted = formatPostingDate(o.postedAt);
            return `- [${o.title} @ ${o.company}](${o.url}) — ${o.location || 'N/A'} | ${o.source} | ${posted}`;
          }),
          '',
        ].join('\n');
        writeFileSync(path.join(opts.mdOut, `${date}.md`), digest, 'utf-8');
        log(`Markdown digest saved to ${path.join(opts.mdOut, `${date}.md`)}`);
      } catch (err) {
        console.error(`⚠️  Could not write markdown digest: ${err.message}`);
      }
    }
  }

  // The authoritative machine-readable result: lets a caller (e.g. the web)
  // tell a *degraded* scan (capped / stale dataset / undated dropped) apart
  // from a genuinely *empty* one. In --json mode stdout carries ONLY this.
  if (checkpoint && checkpointCanClear && !opts.dryRun && !stoppedByOutage && existsSync(CHECKPOINT_PATH)) unlinkSync(CHECKPOINT_PATH);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      date,
      sources: opts.ats,
      sinceDays: opts.sinceDays,
      companiesAvailable: totalCompaniesAvailable,
      companiesScanned: totalCompaniesScanned,
      capHit,
      datasetStatus,
      degradedBoards: degradedBoardDetails.length,
      cappedBoards: cappedBoardDetails.length,
      degradedBoardDetails,
      cappedBoardDetails,
      postingsKept: offers.length,
      postingsDroppedNoDate: droppedNoDate,
      unreachableBoards: totalErrors,
      saved,
      runId: opts.runId,
      immutableRunDir: immutableRun?.runDir || null,
      stoppedByOutage,
      checkpointRetained: stoppedByOutage || resumeIncomplete,
      status: completionStatus,
      targetsAttempted: totalAttemptedTargets,
      targetsSucceeded: totalSuccessfulTargets,
      resumed: Boolean(checkpoint),
      offers: offers.map(o => ({
        company: o.company,
        title: o.title,
        url: o.url,
        location: o.location || null,
        postedAt: formatPostingDate(o.postedAt, null),
        dateStatus: o.dateStatus || (isUsablePostingEpoch(o.postedAt) ? 'dated' : 'unknown'),
        source: o.source,
      })),
    }) + '\n');
    if (stoppedByOutage || resumeIncomplete || allUnavailable || noExecutableTargets) process.exitCode = 1;
    return;
  }

  if (stoppedByOutage || resumeIncomplete) {
    log(`\nSweep paused by resolver outage. Resume with --resume --run-id ${opts.runId}.`);
    process.exitCode = 1;
    return;
  }
  if (allUnavailable) {
    log('\nSweep failed: every selected dataset/provider was unavailable; no completed candidate run was created.');
    process.exitCode = 1;
    return;
  }
  if (noExecutableTargets) {
    log('\nSweep produced no executable provider targets; no candidate run was created.');
    process.exitCode = 1;
    return;
  }
  if (!offers.length) {
    log('\nNothing new.');
    return;
  }
  if (opts.dryRun) {
    log('\n(dry run — run without --dry-run to save results)');
    return;
  }
  log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
}

// Only run main() when invoked directly, not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
