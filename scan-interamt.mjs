#!/usr/bin/env node

/**
 * Bounded Interamt/Wicket discovery. Results are review-only candidates in the
 * canonical immutable scan-run format; this command never writes legacy scan
 * history or pipeline files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

import {
  buildScanRelevanceEvaluator,
  loadSeenCompanyRoles,
  loadSeenUrls,
  normalizeUrlForDedup,
  scanHistoryPolicy,
} from './scan.mjs';
import { deriveCandidateId } from './candidate-identity.mjs';
import { writeImmutableScanRun } from './scan-candidate-contract.mjs';

export const INTERAMT_HOME_URL = 'https://interamt.de/koop/app/';
export const MAX_INTERAMT_SEARCHES = 20;
export const MAX_INTERAMT_KEYWORD_LENGTH = 120;

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RESULT_ROW_SELECTOR = 'table.ia-e-table--searchresults > tbody > tr.ia-e-table__row';
const NO_RESULTS_SELECTORS = ['.ia-e-no-results', '.ia-no-results', '[class*="no-result"]'];
const LOAD_MORE_SELECTOR = 'button.ia-m-searchresults__btn-load';
const BACKDROP_SELECTORS = ['.ia-e-backdrop', '.modal-backdrop', '.ui-widget-overlay', '[class*="backdrop"]'];
const REQUIRED_FIELDS = [
  'Stellenbezeichnung', 'StellenangebotId', 'Behoerde', 'Dienstort', 'PLZOrte', 'Von', 'Bewerbungsfrist',
];
const COOKIE_ACCEPT_LABELS = new Set([
  'akzeptieren', 'alle akzeptieren', 'cookies akzeptieren', 'einverstanden', 'zustimmen',
]);

export const INTERAMT_USAGE = [
  'Usage: node scan-interamt.mjs [--dry-run] [--keyword <text>] [--keyword=<text>] [--help|-h]',
  'Search terms come from portals.yml interamt_searches or config/profile.yml target_roles.primary.',
].join('\n');

function cleanText(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseInteramtArgs(argv = []) {
  const keywords = [];
  let help = false;
  let dryRun = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      if (help) throw new Error(`repeated option ${arg}`);
      help = true;
      continue;
    }
    if (arg === '--dry-run') {
      if (dryRun) throw new Error('repeated option --dry-run');
      dryRun = true;
      continue;
    }
    if (arg === '--keyword') {
      const value = argv[index + 1];
      if (value == null || value.startsWith('-') || !value.trim()) {
        throw new Error('--keyword requires a non-empty value');
      }
      keywords.push(value.trim());
      index++;
      continue;
    }
    if (arg.startsWith('--keyword=')) {
      const value = arg.slice('--keyword='.length).trim();
      if (!value) throw new Error('--keyword requires a non-empty value');
      keywords.push(value);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    throw new Error(`unexpected positional argument ${arg}`);
  }
  return { help, dryRun, keywords };
}

function normalizeSearchEntries(value, { strings = false, label = 'interamt_searches' } = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const searches = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    const was = strings ? entry : (isPlainObject(entry) ? entry.was : null);
    if (typeof was !== 'string') throw new Error(`${label}[${index}] must contain a string was value`);
    const trimmed = was.trim();
    if (!trimmed) throw new Error(`${label}[${index}] was must not be empty`);
    if (trimmed.length > MAX_INTERAMT_KEYWORD_LENGTH) {
      throw new Error(`${label}[${index}] was exceeds ${MAX_INTERAMT_KEYWORD_LENGTH} characters`);
    }
    const key = trimmed.toLocaleLowerCase('de-DE');
    if (seen.has(key)) continue;
    seen.add(key);
    searches.push({ was: trimmed });
    if (searches.length > MAX_INTERAMT_SEARCHES) {
      throw new Error(`${label} may contain at most ${MAX_INTERAMT_SEARCHES} unique searches`);
    }
  }
  return searches;
}

export function normalizeInteramtSearches(value) {
  return normalizeSearchEntries(value, { label: 'interamt_searches' });
}

export function normalizeInteramtOptions(value = {}) {
  if (!isPlainObject(value)) throw new Error('interamt options must be an object');
  const known = new Set(['max_load_more', 'page_timeout_ms', 'wait_timeout_ms']);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new Error(`unknown interamt option ${key}`);
  }
  const boundedInteger = (key, fallback, minimum, maximum) => {
    const raw = value[key];
    if (raw == null) return fallback;
    if (!Number.isInteger(raw) || raw < minimum || raw > maximum) {
      throw new Error(`interamt.${key} must be an integer from ${minimum} to ${maximum}`);
    }
    return raw;
  };
  return {
    max_load_more: boundedInteger('max_load_more', 10, 0, 50),
    page_timeout_ms: boundedInteger('page_timeout_ms', 15_000, 1, 60_000),
    wait_timeout_ms: boundedInteger('wait_timeout_ms', 10_000, 1, 30_000),
  };
}

export function resolveInteramtPaths({ env = process.env, cwd = process.cwd(), projectRoot = PROJECT_ROOT } = {}) {
  const root = env.CAREER_OPS_SCAN_ROOT
    ? path.resolve(cwd, env.CAREER_OPS_SCAN_ROOT)
    : path.resolve(projectRoot);
  const configuredPath = (variable, fallback) => path.resolve(root, env[variable]?.trim() || fallback);
  return {
    root,
    portalsPath: configuredPath('CAREER_OPS_PORTALS', 'portals.yml'),
    profilePath: configuredPath('CAREER_OPS_PROFILE', path.join('config', 'profile.yml')),
    scanHistoryPath: path.resolve(root, 'data', 'scan-history.tsv'),
    pipelinePath: path.resolve(root, 'data', 'pipeline.md'),
    applicationsPath: path.resolve(root, 'data', 'applications.md'),
  };
}

function readYamlConfig(filePath, label, { required = false } = {}) {
  if (!existsSync(filePath)) {
    if (required) throw new Error(`${label} not found at ${filePath}`);
    return {};
  }
  let value;
  try {
    value = yaml.load(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`failed to parse ${label}: ${error.message}`, { cause: error });
  }
  if (value == null) return {};
  if (!isPlainObject(value)) throw new Error(`${label} must contain a YAML object`);
  return value;
}

export function buildInteramtConfig({ portalsConfig = {}, profileConfig = {}, args = {} } = {}) {
  const configuredSearches = portalsConfig.interamt_searches == null
    ? []
    : normalizeInteramtSearches(portalsConfig.interamt_searches);
  const searches = args.keywords?.length
    ? normalizeSearchEntries(args.keywords, { strings: true, label: '--keyword' })
    : (configuredSearches.length
      ? configuredSearches
      : normalizeSearchEntries(profileConfig.target_roles?.primary || [], { strings: true, label: 'profile.target_roles.primary' }));
  if (searches.length === 0) {
    throw new Error('no Interamt searches configured; add portals.yml interamt_searches or profile.target_roles.primary');
  }
  return {
    searches,
    options: normalizeInteramtOptions(portalsConfig.interamt ?? {}),
  };
}

export function parseInteramtDate(value, label = 'Interamt date') {
  const raw = cleanText(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) throw new Error(`${label} must use DD.MM.YYYY, received "${raw}"`);
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (year < 1000 || year > 9999 || month < 1 || month > 12) {
    throw new Error(`${label} is not a real calendar date: "${raw}"`);
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > daysInMonth) throw new Error(`${label} is not a real calendar date: "${raw}"`);
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function parseInteramtDeadline(value) {
  const raw = cleanText(value);
  // Interamt uses this known open-ended deadline marker. Keep dates strict and do not infer a date.
  if (raw === 'baldmöglichst') return null;
  return parseInteramtDate(raw, 'Interamt Bewerbungsfrist');
}

export function normalizeInteramtResultRow(row) {
  if (!isPlainObject(row) || !isPlainObject(row.fields) || !Array.isArray(row.presentFields)) {
    throw new Error('Interamt result row has an invalid extracted shape');
  }
  for (const field of REQUIRED_FIELDS) {
    if (!row.presentFields.includes(field)) throw new Error(`Interamt result row is missing td[data-field="${field}"]`);
  }
  const title = cleanText(row.fields.Stellenbezeichnung);
  const sourceId = cleanText(row.fields.StellenangebotId);
  const company = cleanText(row.fields.Behoerde);
  if (!title) throw new Error('Interamt result row has an empty Stellenbezeichnung');
  if (!company) throw new Error('Interamt result row has an empty Behoerde');
  if (!/^\d{1,18}$/.test(sourceId) || Number(sourceId) <= 0 || !Number.isSafeInteger(Number(sourceId))) {
    throw new Error(`Interamt StellenangebotId must be a positive numeric ID, received "${sourceId}"`);
  }
  const locationParts = [...new Set([row.fields.Dienstort, row.fields.PLZOrte]
    .map(cleanText).filter(Boolean))];
  const postedAt = parseInteramtDate(row.fields.Von, 'Interamt Von');
  const expiresAt = parseInteramtDeadline(row.fields.Bewerbungsfrist);
  const url = `${INTERAMT_HOME_URL}stelle?id=${sourceId}`;
  return {
    company,
    title,
    url,
    location: locationParts.join(', '),
    postedAt,
    expiresAt,
    provider: 'interamt',
    source: 'interamt',
    sourceId,
    sourceUrl: INTERAMT_HOME_URL,
  };
}

function interamtRowDataFromDom(rows) {
  return Array.from(rows, (row) => {
    const cells = Array.from(row.querySelectorAll('td[data-field]'));
    const cellByField = new Map(cells.map((cell) => [cell.getAttribute('data-field'), cell]));
    const presentFields = [...cellByField.keys()];
    const fields = {};
    for (const field of [
      'Stellenbezeichnung', 'StellenangebotId', 'Behoerde', 'Dienstort', 'PLZOrte', 'Von', 'Bewerbungsfrist',
    ]) {
      const cell = cellByField.get(field);
      const valueNode = field === 'StellenangebotId' ? (cell?.querySelector('span') || cell) : cell;
      fields[field] = valueNode?.innerText ?? '';
    }
    return { fields, presentFields };
  });
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if (await locator.count() === 0) continue;
    const first = locator.first();
    if (await first.isVisible()) return first;
  }
  return null;
}

async function waitForVisible(page, selectors, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const locator = await firstVisible(page, selectors);
    if (locator) return locator;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function clearKnownBackdrops(page, timeoutMs) {
  for (const selector of BACKDROP_SELECTORS) {
    const backdrop = await firstVisible(page, [selector]);
    if (backdrop) await backdrop.waitFor({ state: 'hidden', timeout: timeoutMs });
  }
}

async function dismissCookieConsent(page, timeoutMs) {
  const buttons = await page.locator('button').all();
  for (const button of buttons) {
    if (!(await button.isVisible())) continue;
    const label = cleanText(await button.innerText()).toLocaleLowerCase('de-DE');
    if (!COOKIE_ACCEPT_LABELS.has(label)) continue;
    await button.click();
    break;
  }
  await clearKnownBackdrops(page, timeoutMs);
}

async function readExtractedRows(page) {
  return page.locator(RESULT_ROW_SELECTOR).evaluateAll(interamtRowDataFromDom);
}

async function visibleNoResults(page) {
  return Boolean(await firstVisible(page, NO_RESULTS_SELECTORS));
}

async function waitForInitialOutcome(page, options, { beforeSignature, beforeUrl, beforeNoResults }) {
  const deadline = Date.now() + options.wait_timeout_ms;
  while (Date.now() <= deadline) {
    const currentNoResults = await visibleNoResults(page);
    const rowCount = await page.locator(RESULT_ROW_SELECTOR).count();
    if (rowCount > 0) {
      const extracted = await readExtractedRows(page);
      const signature = extracted.map((row) => row.fields.StellenangebotId || row.fields.Stellenbezeichnung).join('|');
      if (!beforeSignature || signature !== beforeSignature || page.url() !== beforeUrl) {
        return { empty: false, rows: extracted };
      }
    }
    if (currentNoResults && (!beforeNoResults || page.url() !== beforeUrl)) return { empty: true, rows: [] };
    await page.waitForTimeout(100);
  }
  throw new Error('Interamt search timed out without new result rows or an explicit no-results marker');
}

async function openInteramtSearch(page, was, options) {
  await dismissCookieConsent(page, options.wait_timeout_ms);
  let beforeUrl = page.url();
  let beforeSignature = '';
  let beforeNoResults = false;
  let criteriaLink = await firstVisible(page, [
    'a.ia-e-link--icon:has-text("Suchkriterien ändern")',
    'a:has-text("Suchkriterien ändern")',
  ]);

  if (criteriaLink) {
    await criteriaLink.click();
    await dismissCookieConsent(page, options.wait_timeout_ms);
    const input = await waitForVisible(page, [
      'input[name="stellensucheFilterAttributes.suchtextContainer:stellensucheFilterAttributes.suchText"]',
    ], options.wait_timeout_ms, 'the Interamt search criteria input');
    await input.fill(was);
    const submit = await waitForVisible(page, [
      'button.ia-e-button--primary:has-text("Detailsuche")',
    ], options.wait_timeout_ms, 'the Interamt Detailsuche button');
    const beforeRows = await readExtractedRows(page);
    beforeSignature = beforeRows.map((row) => row.fields.StellenangebotId || row.fields.Stellenbezeichnung).join('|');
    beforeNoResults = await visibleNoResults(page);
    beforeUrl = page.url();
    await submit.click();
  } else {
    let input = await firstVisible(page, ['#idOrSuchtext']);
    if (!input) {
      await page.goto(INTERAMT_HOME_URL, { waitUntil: 'domcontentloaded', timeout: options.page_timeout_ms });
      await dismissCookieConsent(page, options.wait_timeout_ms);
      input = await waitForVisible(page, ['#idOrSuchtext'], options.wait_timeout_ms, 'the Interamt landing search input');
      beforeUrl = page.url();
    }
    await input.fill(was);
    const submit = await waitForVisible(page, [
      '#ida',
      'button.ia-e-button--primary.ia-e-button--icon',
    ], options.wait_timeout_ms, 'the Interamt landing search button');
    const beforeRows = await readExtractedRows(page);
    beforeSignature = beforeRows.map((row) => row.fields.StellenangebotId || row.fields.Stellenbezeichnung).join('|');
    beforeNoResults = await visibleNoResults(page);
    beforeUrl = page.url();
    await submit.click();
  }

  await dismissCookieConsent(page, options.wait_timeout_ms);
  return waitForInitialOutcome(page, options, { beforeSignature, beforeUrl, beforeNoResults });
}

async function waitForRowGrowth(page, previousCount, options) {
  const deadline = Date.now() + options.wait_timeout_ms;
  while (Date.now() <= deadline) {
    await clearKnownBackdrops(page, options.wait_timeout_ms);
    const count = await page.locator(RESULT_ROW_SELECTOR).count();
    if (count > previousCount) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`Interamt load-more made no row growth from ${previousCount}`);
}

export function createInteramtPageOperations(page, options) {
  return {
    async search(was) {
      const initial = await openInteramtSearch(page, was, options);
      if (initial.empty) return { rows: [], empty: true, capped: false };

      const withSourceQuery = (rows) => rows.map((row) => ({
        ...normalizeInteramtResultRow(row),
        sourceQuery: was,
        sourceQueries: [was],
      }));

      let loadMoreCount = 0;
      while (true) {
        await clearKnownBackdrops(page, options.wait_timeout_ms);
        const loadMore = await firstVisible(page, [LOAD_MORE_SELECTOR]);
        if (!loadMore || !(await loadMore.isEnabled())) {
          return { rows: withSourceQuery(await readExtractedRows(page)), empty: false, capped: false };
        }
        if (loadMoreCount >= options.max_load_more) {
          return { rows: withSourceQuery(await readExtractedRows(page)), empty: false, capped: true };
        }
        const beforeCount = await page.locator(RESULT_ROW_SELECTOR).count();
        await loadMore.click();
        await waitForRowGrowth(page, beforeCount, options);
        loadMoreCount++;
      }
    },
  };
}

export async function discoverInteramtSearches({ searches, pageOperations }) {
  if (!pageOperations || typeof pageOperations.search !== 'function') {
    throw new Error('Interamt page operations must provide search(was)');
  }
  const rows = [];
  const errors = [];
  let searchesSucceeded = 0;
  let searchesEmpty = 0;
  let searchesCapped = 0;
  for (const search of searches) {
    try {
      const result = await pageOperations.search(search.was);
      if (!result || !Array.isArray(result.rows) || typeof result.empty !== 'boolean' || typeof result.capped !== 'boolean') {
        throw new Error('Interamt search returned an invalid result shape');
      }
      if (result.empty && result.rows.length !== 0) throw new Error('Interamt empty result included rows');
      if (!result.empty && result.rows.length === 0) {
        throw new Error('Interamt search had no rows and no explicit no-results marker');
      }
      const normalizedRows = result.rows.map((row) => {
        if (!isPlainObject(row)) throw new Error('Interamt search returned a non-object row');
        const sourceQuery = cleanText(row.sourceQuery) || search.was;
        const sourceQueries = [...new Set([
          ...(Array.isArray(row.sourceQueries) ? row.sourceQueries : []),
          sourceQuery,
          search.was,
        ].filter((query) => typeof query === 'string' && query.trim()).map((query) => query.trim()))];
        return { ...row, sourceQuery, sourceQueries };
      });
      searchesSucceeded++;
      if (result.empty) searchesEmpty++;
      if (result.capped) searchesCapped++;
      rows.push(...normalizedRows);
    } catch (error) {
      errors.push({ was: search.was, error: cleanText(error?.message).slice(0, 500) || 'unknown Interamt search failure' });
    }
  }
  if (searchesSucceeded === 0) {
    const details = errors.map(({ was, error }) => `${was}: ${error}`).join('; ');
    throw new Error(`all Interamt searches failed; no scan run was written${details ? ` (${details})` : ''}`);
  }
  return { rows, errors, searchesSucceeded, searchesEmpty, searchesCapped };
}

function mergeSourceQueries(candidate, incoming) {
  const incomingQueries = [
    ...(Array.isArray(incoming.sourceQueries) ? incoming.sourceQueries : []),
    incoming.sourceQuery,
  ];
  const queries = [...new Set([
    ...(Array.isArray(candidate.sourceQueries) ? candidate.sourceQueries : []),
    candidate.sourceQuery,
    ...incomingQueries,
  ].filter((query) => typeof query === 'string' && query.trim()).map((query) => query.trim()))];
  candidate.sourceQueries = queries;
  candidate.sourceQuery ||= queries[0];
}

function annotatePossibleDuplicate(row, reason) {
  row.possibleDuplicate = true;
  const note = `Possible duplicate: ${reason}`;
  const existingNotes = typeof row.notes === 'string' ? row.notes.split(' | ') : [];
  row.notes = [...new Set([...existingNotes, note])].join(' | ');
}

export function filterAndDeduplicateInteramtRows(rows, {
  evaluateRelevance,
  seenUrls = new Set(),
  seenCompanyRoles = new Set(),
  existingSeenIds = new Set(),
} = {}) {
  if (typeof evaluateRelevance !== 'function') throw new Error('Interamt relevance evaluator is required');
  const candidates = [];
  const byUrl = new Map();
  const byId = new Map();
  const byCompanyRole = new Map();
  const acceptedUrls = new Set(seenUrls);
  const acceptedIds = new Set(existingSeenIds);
  const filtered = { title: 0, posting_age: 0, tier: 0, location: 0, salary: 0, content: 0 };
  let duplicates = 0;
  for (const row of rows) {
    const relevance = evaluateRelevance(row);
    if (!relevance.eligible) {
      if (Object.prototype.hasOwnProperty.call(filtered, relevance.reason)) filtered[relevance.reason]++;
      continue;
    }
    const urlKey = normalizeUrlForDedup(row.url);
    const candidateId = deriveCandidateId(row);
    const existingCandidate = byId.get(candidateId) || byUrl.get(urlKey);
    if (existingCandidate) {
      mergeSourceQueries(existingCandidate, row);
      duplicates++;
      continue;
    }
    if (acceptedUrls.has(urlKey) || acceptedIds.has(candidateId)) {
      duplicates++;
      continue;
    }
    const companyRoleKey = `${row.company.toLowerCase()}::${row.title.toLowerCase()}`;
    if (seenCompanyRoles.has(companyRoleKey)) {
      annotatePossibleDuplicate(row, 'company and role match an applications tracker row.');
    }
    const sameRoleCandidate = byCompanyRole.get(companyRoleKey);
    if (sameRoleCandidate) {
      annotatePossibleDuplicate(sameRoleCandidate, 'another Interamt listing has the same company and role.');
      annotatePossibleDuplicate(row, 'another Interamt listing has the same company and role.');
    }
    mergeSourceQueries(row, row);
    byUrl.set(urlKey, row);
    byId.set(candidateId, row);
    byCompanyRole.set(companyRoleKey, sameRoleCandidate || row);
    acceptedUrls.add(urlKey);
    acceptedIds.add(candidateId);
    candidates.push(row);
  }
  return { candidates, filtered, duplicates };
}

async function launchInteramtBrowser() {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true });
}

function createRunId(date, pid = process.pid) {
  return `interamt-${date.toISOString().replace(/[:.]/g, '-')}-${pid}-${randomBytes(4).toString('hex')}`;
}

function writeRunWithProfileLocation(writeRun, options, profilePath) {
  const hadProfileOverride = Object.prototype.hasOwnProperty.call(process.env, 'CAREER_OPS_PROFILE');
  const previousProfileOverride = process.env.CAREER_OPS_PROFILE;
  process.env.CAREER_OPS_PROFILE = profilePath;
  try {
    return writeRun(options);
  } finally {
    if (hadProfileOverride) process.env.CAREER_OPS_PROFILE = previousProfileOverride;
    else delete process.env.CAREER_OPS_PROFILE;
  }
}

export async function runInteramtScan({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  projectRoot = PROJECT_ROOT,
  browserFactory = launchInteramtBrowser,
  pageOperationsFactory = createInteramtPageOperations,
  writeRun = writeImmutableScanRun,
  now = () => new Date(),
  pid = process.pid,
  log = console.log,
} = {}) {
  const args = parseInteramtArgs(argv);
  if (args.help) {
    log(INTERAMT_USAGE);
    return { exitCode: 0, help: true };
  }

  const paths = resolveInteramtPaths({ env, cwd, projectRoot });
  const portalsConfig = readYamlConfig(paths.portalsPath, 'portals.yml', { required: true });
  const explicitSearches = args.keywords.length > 0 || (Array.isArray(portalsConfig.interamt_searches) && portalsConfig.interamt_searches.length > 0);
  const profileConfig = explicitSearches ? {} : readYamlConfig(paths.profilePath, 'config/profile.yml');
  const { searches, options } = buildInteramtConfig({ portalsConfig, profileConfig, args });

  let classifyTier = null;
  if (Array.isArray(portalsConfig.skip_tiers) && portalsConfig.skip_tiers.some((tier) => typeof tier === 'string')) {
    const module = await import('./classify-tier.mjs');
    classifyTier = module.classifyTier || module.default;
  }
  const evaluateRelevance = buildScanRelevanceEvaluator(portalsConfig, { classifyTier, sinceMs: null });
  const current = now();
  const today = current.toISOString().slice(0, 10);
  const dedup = loadSeenUrls({ ...scanHistoryPolicy(portalsConfig), today }, {
    scanHistoryPath: paths.scanHistoryPath,
    pipelinePath: paths.pipelinePath,
    applicationsPath: paths.applicationsPath,
  });
  const seenCompanyRoles = loadSeenCompanyRoles(paths.applicationsPath);

  const browser = await browserFactory({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  let discovery;
  try {
    const page = await browser.newPage({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
    await page.goto(INTERAMT_HOME_URL, { waitUntil: 'domcontentloaded', timeout: options.page_timeout_ms });
    discovery = await discoverInteramtSearches({
      searches,
      pageOperations: pageOperationsFactory(page, options),
    });
  } finally {
    await browser.close();
  }

  const filtered = filterAndDeduplicateInteramtRows(discovery.rows, {
    evaluateRelevance,
    seenUrls: dedup.seen,
    seenCompanyRoles,
  });
  const partial = discovery.errors.length > 0 || discovery.searchesCapped > 0;
  const createdAt = current.toISOString();
  const runId = createRunId(current, pid);
  const metadata = {
    scanner: 'interamt',
    completion_status: partial ? 'partial' : 'completed',
    coverage: {
      status: partial ? 'partial' : 'complete',
      searches_attempted: searches.length,
      searches_succeeded: discovery.searchesSucceeded,
      searches_empty: discovery.searchesEmpty,
      searches_failed: discovery.errors.length,
      searches_capped: discovery.searchesCapped,
      rows_discovered: discovery.rows.length,
      rows_filtered: Object.values(filtered.filtered).reduce((sum, count) => sum + count, 0),
      rows_deduplicated: filtered.duplicates,
      candidates_written: filtered.candidates.length,
    },
    searches: searches.map(({ was }) => was),
    errors: discovery.errors,
    filtered: filtered.filtered,
  };
  let immutableRun = null;
  if (!args.dryRun) {
    immutableRun = writeRunWithProfileLocation(writeRun, {
      root: paths.root,
      runId,
      createdAt,
      sourceArchitecture: 'interamt_scan',
      inputs: [{ name: 'interamt', rows: filtered.candidates }],
      metadata,
    }, paths.profilePath);
  }
  const result = {
    exitCode: 0,
    dryRun: args.dryRun,
    runId,
    metadata,
    candidates: filtered.candidates.length,
    output: immutableRun?.runDir || null,
  };
  log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runInteramtScan().then(({ exitCode }) => {
    if (exitCode) process.exitCode = exitCode;
  }).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
