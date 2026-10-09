#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner with a plugin-based provider layer.
 *
 * Providers live in providers/*.mjs and are loaded at startup. Each provider
 * exports a default object with:
 *   - id: string — matched against `provider:` in portals.yml
 *   - detect(entry): {url}|null — optional auto-detection from careers_url
 *   - fetch(entry, ctx): [{title,url,company,location}] — required
 *
 * Files prefixed with _ are shared helpers (e.g. _http.mjs) and are never
 * loaded as providers. Adding a new HTTP/API source = drop a *.mjs into
 * providers/. Local executable parsers use `providers/local-parser.mjs` when
 * `parser.command` + `parser.script` are set in portals.yml.
 *
 * A tracked_companies entry can set `provider:` explicitly to bypass
 * URL-based auto-detection. The `transport:` field is reserved for future
 * transports — Phase A only ships the http transport.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 *   node scan.mjs --verify         # Playwright-check each new URL; drop expired postings
 *   node scan.mjs --verify --headed-fallback  # retry anti-bot-blocked URLs in a headed browser (needs a display)
 *   node scan.mjs --verify --throttle          # jittered ~5-10s gap between checks (stay under rate limits)
 *   node scan.mjs --verify --throttle=8000     # custom base gap in ms (waits base..2*base)
 */

import './lib/operational-cli.mjs';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';
import yaml from 'js-yaml';

import { makeHttpCtx } from './providers/_http.mjs';
import { providerCoverage } from './providers/_result.mjs';
import { buildTrustValidator } from './providers/_trust-validator.mjs';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';
import { mergeProviderPlugins } from './plugins/_engine.mjs';
import { classifyFetchError } from './verify-portals.mjs';
import { fingerprintText, findCrossListings } from './fingerprint-core.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { atsIdentityFromUrl, deriveCandidateId } from './candidate-identity.mjs';
import { writeImmutableScanRun } from './scan-candidate-contract.mjs';
import { appendPortalHealth, loadPortalHealth, computeConsecutiveFailures } from './portal-health.mjs';
import { prescreenJob, loadPrescreenProfile } from './prescreen.mjs';
import {
  classifyExperienceRequirements,
  isNumericExperienceKeyword,
  normalizeExperiencePolicy,
} from './experience-policy.mjs';

async function loadOptionalDotenv() {
  try {
    const { config } = await import('dotenv');
    config();
  } catch {
    // dotenv is optional — fall back to process.env if not installed
  }
}

const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

function resolvePortalsPath() {
  return process.env.CAREER_OPS_PORTALS || 'portals.yml';
}

function resolveProfilePath() {
  return process.env.CAREER_OPS_PROFILE || 'config/profile.yml';
}

function resolveScanRoot() {
  return process.env.CAREER_OPS_SCAN_ROOT ? path.resolve(process.env.CAREER_OPS_SCAN_ROOT) : PROJECT_ROOT;
}

function resolveProvidersDir() {
  return process.env.CAREER_OPS_PROVIDERS_DIR
    ? path.resolve(process.env.CAREER_OPS_PROVIDERS_DIR)
    : path.resolve(PROJECT_ROOT, 'providers');
}

const CONCURRENCY = 10;

// Provider loading + routing live in providers/_registry.mjs so the portal
// health check (verify-portals.mjs) can reuse the exact same layer without
// importing this module.

// ── Title filter ────────────────────────────────────────────────────

// Fold accents and match whole words/phrases at Unicode-aware boundaries.
// A trailing `*` on a token matches any continuation of that token, which
// covers inflections such as Entwickler* and Werkstudent* without matching
// the keyword in the middle of another word.
const FILTER_WORD_CHAR = String.raw`[\p{L}\p{N}\p{M}_]`;

function normalizeFilterText(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function escapeFilterRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileKeyword(kw) {
  const keyword = normalizeFilterText(kw).trim();
  if (!keyword) return () => false;

  const pieces = keyword.split(/(\s+)/u);
  let wildcardAtEnd = false;
  const pattern = pieces.map((piece, index) => {
    if (/^\s+$/u.test(piece)) return String.raw`\s+`;
    if (piece.endsWith('*')) {
      const prefix = piece.slice(0, -1);
      if (!prefix) return escapeFilterRegex(piece);
      wildcardAtEnd = index === pieces.length - 1;
      return `${escapeFilterRegex(prefix)}${FILTER_WORD_CHAR}*`;
    }
    return escapeFilterRegex(piece);
  }).join('');

  // A keyword ending in a letter also matches its plural ("api" -> "APIs").
  const plural = !wildcardAtEnd && /\p{L}$/u.test(keyword) ? '(?:e?s)?' : '';
  const source = `(?<!${FILTER_WORD_CHAR})${pattern}${wildcardAtEnd ? '' : `${plural}(?!${FILTER_WORD_CHAR})`}`;
  const re = new RegExp(source, 'u');
  return (text) => re.test(normalizeFilterText(text));
}

export function buildTitleFilter(titleFilter) {
  // Normalize defensively: a malformed title_filter (a null, numeric, or otherwise
  // non-string entry in the YAML) must not crash the scan via k.toLowerCase().
  const normalize = (arr) => (Array.isArray(arr) ? arr : [])
    .filter(k => typeof k === 'string')
    .map(k => k.trim())
    .filter(k => k.length > 0)
    .map(compileKeyword);
  const positive = normalize(titleFilter?.positive);
  const negative = normalize(titleFilter?.negative);

  return (title) => {
    const lower = normalizeFilterText(title || '');
    const hasPositive = positive.length === 0 || positive.some(m => m(lower));
    const hasNegative = negative.some(m => m(lower));
    return hasPositive && !hasNegative;
  };
}

// Compiled-matcher cache for matchedTitleKeywords(), keyed by the
// `title_filter.positive` array reference. The scan loop calls this once per
// job with the same titleFilter config object, so caching avoids recompiling
// every keyword (compileKeyword()) on every single job.
const compiledPositiveCache = new WeakMap();

function compiledPositiveMatchers(positiveList) {
  if (compiledPositiveCache.has(positiveList)) return compiledPositiveCache.get(positiveList);
  const compiled = positiveList
    .filter(k => typeof k === 'string' && k.trim().length > 0)
    .map(k => ({ raw: k, match: compileKeyword(k.trim().toLowerCase()) }));
  compiledPositiveCache.set(positiveList, compiled);
  return compiled;
}

// Returns the raw (as-written in portals.yml) `title_filter.positive` keywords
// that matched a given title — used to scope `content_filter.by_title_keyword`
// overrides to only the categories that opted into a stricter content check.
export function matchedTitleKeywords(title, titleFilter) {
  const raw = Array.isArray(titleFilter?.positive) ? titleFilter.positive : [];
  const lower = normalizeFilterText(title || '');
  return compiledPositiveMatchers(raw)
    .filter(({ match }) => match(lower))
    .map(({ raw: kw }) => kw);
}

// ── Location filter ─────────────────────────────────────────────────
// Optional source-aware tri-state classifier. Structured location and title
// are strong evidence; a job-specific URL is only a fallback for missing or
// non-geographic metadata. Explicit geographic restrictions take precedence.

// Normalize a keyword list from portals.yml: tolerates a bare string
// (wrapped to a 1-item array), null/undefined (→ []), and non-string
// entries (filtered out). Survivors are lowercased, trimmed, and any
// resulting empty strings are dropped — an empty keyword would otherwise
// match every location via String.includes(''), silently bypassing the
// other tiers.
function normalizeKeywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter(k => typeof k === 'string')
    .map(k => k.toLowerCase().trim())
    .filter(Boolean);
}

const GENERIC_LOCATION_TERMS = new Set([
  'remote', 'worldwide', 'global', 'anywhere', 'anywhere in the world', 'work from anywhere', 'emea',
]);
const EUROPE_WIDE_TERMS = new Set([
  'remote europe', 'europe', 'european union', 'european economic area', 'eu', 'eea',
]);

const TARGET_COUNTRY_ISO = new Map([
  ['finland', 'fi'],
  ['germany', 'de'],
  ['denmark', 'dk'],
  ['netherlands', 'nl'],
]);

const FINNISH_BUILTIN_CITIES = [
  'Oulu', 'Kuopio', 'Jyväskylä', 'Lahti', 'Vaasa', 'Pori', 'Lappeenranta',
  'Hämeenlinna', 'Seinäjoki', 'Rovaniemi', 'Kajaani', 'Kotka', 'Mikkeli',
  'Porvoo', 'Salo', 'Kokkola',
];

const US_STATE_NAMES = new Map([
  ['alabama', 'al'], ['alaska', 'ak'], ['arizona', 'az'], ['arkansas', 'ar'],
  ['california', 'ca'], ['colorado', 'co'], ['connecticut', 'ct'], ['delaware', 'de'],
  ['florida', 'fl'], ['georgia', 'ga'], ['hawaii', 'hi'], ['idaho', 'id'],
  ['illinois', 'il'], ['indiana', 'in'], ['iowa', 'ia'], ['kansas', 'ks'],
  ['kentucky', 'ky'], ['louisiana', 'la'], ['maine', 'me'], ['maryland', 'md'],
  ['massachusetts', 'ma'], ['michigan', 'mi'], ['minnesota', 'mn'], ['mississippi', 'ms'],
  ['missouri', 'mo'], ['montana', 'mt'], ['nebraska', 'ne'], ['nevada', 'nv'],
  ['new hampshire', 'nh'], ['new jersey', 'nj'], ['new mexico', 'nm'], ['new york', 'ny'],
  ['north carolina', 'nc'], ['north dakota', 'nd'], ['ohio', 'oh'], ['oklahoma', 'ok'],
  ['oregon', 'or'], ['pennsylvania', 'pa'], ['rhode island', 'ri'], ['south carolina', 'sc'],
  ['south dakota', 'sd'], ['tennessee', 'tn'], ['texas', 'tx'], ['utah', 'ut'],
  ['vermont', 'vt'], ['virginia', 'va'], ['washington', 'wa'], ['west virginia', 'wv'],
  ['wisconsin', 'wi'], ['wyoming', 'wy'], ['district of columbia', 'dc'],
]);
const US_STATE_CODES = new Set(US_STATE_NAMES.values());

const LOCATION_COUNTRY_NAMES = [];
const LOCATION_REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
for (let first = 97; first <= 122; first += 1) {
  for (let second = 97; second <= 122; second += 1) {
    const code = String.fromCharCode(first, second);
    const name = LOCATION_REGION_NAMES.of(code.toUpperCase());
    if (name && name.toLowerCase() !== code) LOCATION_COUNTRY_NAMES.push([name.toLowerCase(), code]);
  }
}
LOCATION_COUNTRY_NAMES.sort((left, right) => right[0].length - left[0].length);
const LOCATION_COUNTRY_CODES = new Set(LOCATION_COUNTRY_NAMES.map(([, code]) => code));
const LOCATION_NON_COUNTRY_CODES = new Set(['eu', 'ez', 'un', 'xa', 'xb', 'xu', 'zz']);
const LOCATION_TOKEN_PATTERN_CACHE = new Map();

function locationKeywordEntries(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => ({ raw: entry.trim(), normalized: entry.toLowerCase().trim() }));
}

function escapeLocationPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeLocationText(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function locationTextMatches(text, keyword) {
  if (!text || !keyword) return false;
  const normalizedText = normalizeLocationText(text);
  const normalizedKeyword = normalizeLocationText(keyword);
  if (!/^[\p{L}\p{N}]+$/u.test(normalizedKeyword)) return normalizedText.includes(normalizedKeyword);
  let pattern = LOCATION_TOKEN_PATTERN_CACHE.get(normalizedKeyword);
  if (!pattern) {
    pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeLocationPattern(normalizedKeyword)}(?=$|[^\\p{L}\\p{N}])`, 'u');
    LOCATION_TOKEN_PATTERN_CACHE.set(normalizedKeyword, pattern);
  }
  return pattern.test(normalizedText);
}

function structuredIsoFieldMatches(text, iso) {
  if (text.trim().toLowerCase() === iso) return true;
  return new RegExp(`(?:^|[,;(/-])\\s*${escapeLocationPattern(iso)}(?=$|[\\s,;)/-])`, 'i').test(text);
}

function createExplicitNonTargetLocationMatcher(targetEntries) {
  const targetNames = new Set([
    ...TARGET_COUNTRY_ISO.keys(),
    ...targetEntries.map((entry) => entry.normalized),
  ]);
  const nonTargetCountries = LOCATION_COUNTRY_NAMES
    .filter(([name, code]) => (
      !targetNames.has(name) && !EUROPE_WIDE_TERMS.has(name) && name !== 'europe' && !LOCATION_NON_COUNTRY_CODES.has(code)
    ))
    .map(([name]) => name);
  const countryPattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])(?:${nonTargetCountries.map((name) => escapeLocationPattern(normalizeLocationText(name))).join('|')})(?=$|[^\\p{L}\\p{N}])`,
    'u',
  );
  const statePattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])(?:${[...US_STATE_NAMES.keys()].map(escapeLocationPattern).join('|')})(?=$|[^\\p{L}\\p{N}])`,
    'u',
  );
  const nonTargetCountryCodes = new Set([...LOCATION_COUNTRY_CODES]
    .filter((code) => ![...TARGET_COUNTRY_ISO.values()].includes(code) && !LOCATION_NON_COUNTRY_CODES.has(code)));
  const usAliasPattern = /(?:^|[^\p{L}\p{N}])(?:u\.?s\.?a?\.?|usa)(?=$|[^\p{L}\p{N}])/iu;

  return (text) => {
    const lower = normalizeLocationText(text);
    if (countryPattern.test(lower) || statePattern.test(lower) || usAliasPattern.test(text)) return true;

    // Country abbreviations and state abbreviations are meaningful only as
    // comma-separated location fields, never as arbitrary short words.
    const fields = text.split(',').slice(1).map((field) => normalizeLocationText(field).trim());
    for (const field of fields) {
      const code = field.match(/^([a-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/)?.[1];
      if (!code) continue;
      if (US_STATE_CODES.has(code)) {
        // Delaware's code is also Germany's ISO alias. Keep the established
        // country-code form while recognizing the audited Delaware locations.
        if (code === 'de' && /(?:^|[,;])\s*(?:wilmington|dover|newark)\s*(?:,|$)/i.test(text)) return true;
        if (code === 'de' && /,\s*de\s+\d{5}(?:-\d{4})?\s*$/i.test(text)) return true;
        if (code !== 'de') return true;
      }
      if (nonTargetCountryCodes.has(code)) return true;
    }
    return false;
  };
}

function nonGeographicLocation(value, generic) {
  const lower = value.toLowerCase().trim();
  if (!lower || /^(?:unknown|unspecified|not specified|n\/?a|multiple locations)$/i.test(lower)) return true;
  let remainder = lower;
  let timezoneSeen = false;
  remainder = remainder.replace(/\b(?:utc|gmt)(?:\s*[+-]\s*\d{1,2}(?::\d{2})?)?\b|\b(?:cet|cest)\b/gi, () => {
    timezoneSeen = true;
    return ' ';
  });
  if (timezoneSeen) remainder = remainder.replace(/\bto\b/g, ' ');
  for (const term of [...generic].sort((a, b) => b.length - a.length)) {
    remainder = remainder.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeLocationPattern(term)}(?=$|[^\\p{L}\\p{N}])`, 'gu'), ' ');
  }
  remainder = remainder
    .replace(/\b(?:hybrid|on[- ]?site|onsite|flexible|office|fully|full|primarily|mostly|100\s*%)\b/g, ' ')
    .replace(/[\s,;:()[\]{}\-/–—]+/g, ' ')
    .trim();
  return !remainder;
}

function explicitRestrictionScope(value) {
  const text = value.trim();
  const patterns = [
    /(?:^|[,;])\s*(?:remote\s*[-:–—]\s*)?(.+?)\s+(?:residents?\s+)?only\b/i,
    /\bmust\s+(?:be\s+)?(?:based|located|reside|resident)\s+in\s+([^,;]+)/i,
    /\b(?:remote|work)\s+within\s+([^,;]+)/i,
    /\bremote\s*[-:–—]\s*([^,;]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].replace(/\s+(?:residents?\s+)?only\b.*$/i, '').trim();
  }
  return '';
}

export function buildLocationClassifier(locationFilter) {
  if (!locationFilter) return () => ({ status: 'eligible', code: 'filter_disabled' });
  const alwaysAllowEntries = locationKeywordEntries(locationFilter.always_allow);
  const allowEntries = locationKeywordEntries(locationFilter.allow);
  const alwaysAllow = alwaysAllowEntries.map((entry) => entry.normalized);
  const allow = allowEntries.map((entry) => entry.normalized);
  const block = normalizeKeywordList(locationFilter.block);
  const configuredEuropeWide = normalizeKeywordList(locationFilter.europe_wide);
  const configuredUncertain = normalizeKeywordList(locationFilter.uncertain);
  const generic = new Set([...GENERIC_LOCATION_TERMS, ...configuredUncertain]);
  const configuredWideTerms = configuredEuropeWide.length
    ? configuredEuropeWide
    : allow.filter((keyword) => EUROPE_WIDE_TERMS.has(keyword));
  const europeWide = new Set([
    ...configuredWideTerms,
    ...(configuredWideTerms.some((keyword) => EUROPE_WIDE_TERMS.has(keyword)) ? EUROPE_WIDE_TERMS : []),
  ]);
  const targetEntries = [...alwaysAllowEntries, ...allowEntries]
    .filter((entry) => !generic.has(entry.normalized) && !europeWide.has(entry.normalized))
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.normalized === entry.normalized) === index);
  const configuredIso = [...TARGET_COUNTRY_ISO]
    .filter(([country]) => targetEntries.some((entry) => entry.normalized === country))
    .map(([country, iso]) => ({ iso, raw: targetEntries.find((entry) => entry.normalized === country).raw }));
  const explicitNonTargetLocation = createExplicitNonTargetLocationMatcher(targetEntries);
  const targetCountryEntries = targetEntries.filter((entry) => (
    TARGET_COUNTRY_ISO.has(entry.normalized)
    || LOCATION_COUNTRY_NAMES.some(([name]) => normalizeLocationText(name) === normalizeLocationText(entry.normalized))
  ));
  const hasConfiguredFinland = targetEntries.some((entry) => entry.normalized === 'finland');

  const findTarget = (text, { structured = false, permitShort = true } = {}) => {
    const entry = targetEntries.find((candidate) => (
      (permitShort || candidate.normalized.length > 3) && locationTextMatches(text, candidate.normalized)
    ));
    if (entry) return entry.raw;
    if (structured) {
      const alias = configuredIso.find(({ iso }) => (
        structuredIsoFieldMatches(text, iso) && locationTextMatches(text, iso)
      ));
      if (alias) return alias.raw;
    }
    return '';
  };
  const findTargetCountryName = (text) => targetCountryEntries.find((entry) => (
    locationTextMatches(text, entry.normalized)
  ))?.raw || '';
  const findEurope = (text) => [...europeWide].find((keyword) => locationTextMatches(text, keyword)) || '';
  const findFinnishCity = (text) => hasConfiguredFinland
    ? FINNISH_BUILTIN_CITIES.find((city) => locationTextMatches(text, city)) || ''
    : '';
  const isTargetScope = (scope) => Boolean(
    findTarget(scope.toLowerCase(), { structured: true }) || findEurope(scope.toLowerCase()),
  );

  return (location, url = '', title = '') => {
    const locationText = typeof location === 'string' ? location.trim() : '';
    const titleText = typeof title === 'string' ? title.trim() : '';
    const locationLower = locationText.toLowerCase();
    const titleLower = titleText.toLowerCase();

    for (const [source, value] of [['location', locationText], ['title', titleText]]) {
      const restriction = explicitRestrictionScope(value);
      if (restriction && !isTargetScope(restriction)) {
        return { status: 'ineligible', code: 'remote_restricted_elsewhere', matched: restriction, source };
      }
    }

    let locationTarget = '';
    let locationEurope = '';
    for (const part of locationText.split(/[;|·•]|\s+\/\s+/).map((entry) => entry.trim()).filter(Boolean)) {
      locationEurope = findEurope(part.toLowerCase());
      if (locationEurope) break;
      locationTarget = findTargetCountryName(part.toLowerCase());
      if (locationTarget) break;
      if (explicitNonTargetLocation(part)) continue;
      locationTarget = findTarget(part.toLowerCase(), { structured: true }) || findFinnishCity(part.toLowerCase());
      if (locationTarget) break;
    }
    if (locationTarget) return { status: 'eligible', code: 'target_region', matched: locationTarget, source: 'location' };
    if (locationEurope) return { status: 'eligible', code: 'europe_wide', matched: 'Europe', source: 'location' };
    const titleTarget = findTarget(titleLower);
    if (titleTarget) return { status: 'eligible', code: 'target_region', matched: titleTarget, source: 'title' };
    if (findEurope(titleLower)) return { status: 'eligible', code: 'europe_wide', matched: 'Europe', source: 'title' };

    // With no allow-list, retain the historical block-only behavior.
    if (targetEntries.length === 0 && europeWide.size === 0 && allow.length === 0 && alwaysAllow.length === 0) {
      const blockedMatch = block.find((keyword) => locationTextMatches(locationLower, keyword));
      if (blockedMatch) return { status: 'ineligible', code: 'blocked_region', matched: blockedMatch, source: 'location' };
      return { status: 'eligible', code: 'allowlist_disabled' };
    }

    const blockedMatch = block.find((keyword) => locationTextMatches(locationLower, keyword));
    if (blockedMatch) return { status: 'ineligible', code: 'blocked_region', matched: blockedMatch, source: 'location' };

    const genericMatch = [...generic].find((keyword) => locationTextMatches(locationLower, keyword));
    const unknownLocation = !locationText || /^(?:unknown|unspecified|not specified|n\/?a|multiple locations)$/i.test(locationText);

    if (unknownLocation || nonGeographicLocation(locationText, generic)) {
      let urlText = '';
      try {
        const path = decodeURIComponent(new URL(url).pathname);
        const jobPath = path.match(/(?:^|\/)(?:jobs?|careers?|roles?|positions?|openings?|vacancies|apply)(?:\/|$)/i);
        if (jobPath) {
          urlText = path.slice(jobPath.index).replace(/[-_/]+/g, ' ').toLowerCase();
        }
      } catch {}
      const urlTarget = findTarget(urlText, { permitShort: false });
      if (urlTarget) return { status: 'eligible', code: 'target_region', matched: urlTarget, source: 'url' };
      if (findEurope(urlText)) return { status: 'eligible', code: 'europe_wide', matched: 'Europe', source: 'url' };
      if (unknownLocation && !genericMatch) return { status: 'uncertain', code: 'missing_location' };
      return { status: 'uncertain', code: genericMatch ? 'generic_remote_only' : 'non_geographic_location' };
    }

    return { status: 'ineligible', code: 'outside_target_region' };
  };
}

export function buildLocationFilter(locationFilter) {
  const classify = buildLocationClassifier(locationFilter);
  const filter = (location, url = '', title = '') => classify(location, url, title).status !== 'ineligible';
  filter.classify = classify;
  return filter;
}

export function parseSinceDays(args, defaultDays = null) {
  const index = args.indexOf('--since');
  const equals = args.find((arg) => arg.startsWith('--since='));
  const raw = index >= 0 ? args[index + 1] : (equals ? equals.slice('--since='.length) : null);
  if (raw == null) return defaultDays;
  if (raw === '' || (index >= 0 && raw.startsWith('--'))) throw new Error('--since requires a non-negative number of days');
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) throw new Error(`--since requires a non-negative number of days, got "${raw}"`);
  return days;
}

const COSMETIC_QUERY_KEYS = new Set([
  'gh_src', 'lever-source', 'source', 'ref', 'referrer', 'rltr',
]);

export function normalizeUrlForDedup(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || COSMETIC_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return String(rawUrl ?? '').trim();
  }
}

function stripBareProsePunctuation(value) {
  return value.replace(/[.,;!]+$/, '');
}

export function extractHttpUrlsFromMarkdown(text) {
  if (typeof text !== 'string' || !text) return [];
  const urls = new Set();
  const add = (value, { prose = false } = {}) => {
    const candidate = prose ? stripBareProsePunctuation(value) : value;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') urls.add(parsed.href);
    } catch {}
  };

  for (const match of text.matchAll(/\[[^\]]*\]\(\s*<?(https?:\/\/[^\s>)]+)>?\s*\)/gi)) add(match[1]);
  for (const match of text.matchAll(/<(https?:\/\/[^\s<>]+)>/gi)) add(match[1]);
  // Tracker notes use an explicit `URL:` label and semicolons to separate the
  // following prose field. Parse that grammar before the generic fallback.
  for (const match of text.matchAll(/\bURL:\s*(https?:\/\/[^\s|;]+)/gi)) add(match[1]);
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'()[\]|]+/gi)) add(match[0], { prose: true });
  return [...urls];
}

// ── Content filter ──────────────────────────────────────────────────
// Optional. If `content_filter` is absent from portals.yml, all jobs pass.
// Filters on the job DESCRIPTION text to separate same-titled roles with
// different stacks (a "Software Engineer" listing that mentions "PHP" vs one
// that mentions "Rust"). Semantics (case-insensitive substring, in order):
//   - Empty / whitespace-only / non-string description → PASS. The scanner is
//     zero-token and only sees descriptions a provider already returns in its
//     list payload; providers without one must never be silently dropped.
//   - any `negative` keyword present → reject
//   - `positive` empty → pass (already cleared negatives)
//   - `positive` non-empty → at least one keyword must be present
//
// `content_filter.by_title_keyword` (optional): scopes a stricter positive/
// negative pair to only the jobs whose title matched a specific
// `title_filter.positive` keyword, so e.g. an "AI Engineer" title-match can
// require the description to actually mention a concrete AI tool, without
// that requirement leaking onto unrelated categories like "Instructional
// Designer". When one or more of a job's matched title keywords has an
// override, the overrides govern (any override passing is enough); the
// global `positive`/`negative` pair is the fallback for jobs whose matched
// keyword(s) have no override entry.
//
// Provider support: only providers whose list API ships the description for
// free (no extra per-job request, which would break the zero-token design)
// populate `job.description`. Lever (`descriptionPlain`) does today; others
// leave it empty and therefore always pass this filter.

export function buildContentFilter(contentFilter, { experiencePolicy = null } = {}) {
  if (!contentFilter) return () => true;
  const positive = normalizeKeywordList(contentFilter.positive).map(compileKeyword);
  const preserveNumericExperience = Boolean(experiencePolicy);
  const negative = normalizeKeywordList(contentFilter.negative)
    .filter(keyword => !(preserveNumericExperience && isNumericExperienceKeyword(keyword)))
    .map(compileKeyword);

  const byTitleKeyword = new Map();
  if (contentFilter.by_title_keyword && typeof contentFilter.by_title_keyword === 'object' && !Array.isArray(contentFilter.by_title_keyword)) {
    for (const [kw, rule] of Object.entries(contentFilter.by_title_keyword)) {
      if (typeof kw !== 'string' || !kw.trim()) continue;
      byTitleKeyword.set(normalizeFilterText(kw.trim()), {
        positive: normalizeKeywordList(rule?.positive).map(compileKeyword),
        negative: normalizeKeywordList(rule?.negative)
          .filter(keyword => !(preserveNumericExperience && isNumericExperienceKeyword(keyword)))
          .map(compileKeyword),
      });
    }
  }

  return (description, matchedKeywords = []) => {
    if (typeof description !== 'string' || description.trim() === '') return true;
    const lower = normalizeFilterText(description);

    const overrides = matchedKeywords
      .filter(k => typeof k === 'string')
      .map(k => byTitleKeyword.get(normalizeFilterText(k.trim())))
      .filter(Boolean);

    if (overrides.length > 0) {
      return overrides.some(rule => {
        if (rule.negative.length > 0 && rule.negative.some(match => match(lower))) return false;
        if (rule.positive.length === 0) return true;
        return rule.positive.some(match => match(lower));
      });
    }

    if (negative.length > 0 && negative.some(match => match(lower))) return false;
    if (positive.length === 0) return true;
    return positive.some(match => match(lower));
  };
}

// ── Salary filter ───────────────────────────────────────────────────
// Optional. If `salary_filter` is absent from portals.yml, all salaries pass.
// Semantics:
//   - min/max are annual compensation filters (use annualized values)
//   - max: 0 means "no upper limit"
//   - If no salary data exists on a job, it passes (conservative behavior)
//   - If both currencies are known and mismatch (e.g., USD filter, EUR job), it fails
//   - Partial ranges (min only or max only) work correctly via overlap logic
// Uses null-safe checks (!= null, ??) to preserve 0 values correctly.

export function buildSalaryFilter(salaryFilter) {
  if (!salaryFilter) return () => true;

  // Coerce and validate bounds — malformed YAML must not silently mis-filter
  const min = Number(salaryFilter.min ?? 0);
  const max = Number(salaryFilter.max ?? 0);
  const filterCurrency = (salaryFilter.currency || '').trim().toUpperCase();

  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) {
    console.error('Warning: salary_filter.min/max must be non-negative numbers — salary filter disabled');
    return () => true;
  }
  if (max > 0 && min > max) {
    console.error('Warning: salary_filter.min cannot exceed salary_filter.max — salary filter disabled');
    return () => true;
  }

  // If both min and max are 0, no filtering applied
  if (min === 0 && max === 0) return () => true;

  return (salary) => {
    // If no salary data exists, pass (conservative - many providers don't expose salary)
    if (!salary) return true;

    const jobMin = salary.min ?? salary.max ?? null;
    const jobMax = salary.max ?? salary.min ?? null;

    // If we have no usable salary values, pass conservatively
    if (jobMin == null && jobMax == null) return true;

    // Currency handling - reject only if BOTH currencies exist and mismatch
    const jobCurrency = (salary.currency || '').trim().toUpperCase();
    if (filterCurrency && jobCurrency && filterCurrency !== jobCurrency) {
      return false;
    }

    // Range overlap logic - reject ONLY if job is completely outside filter range
    // Job entirely below user minimum
    if (min > 0 && jobMax != null && jobMax < min) {
      return false;
    }
    // Job entirely above user maximum
    if (max > 0 && jobMin != null && jobMin > max) {
      return false;
    }

    // Otherwise pass (overlap exists or no valid range to compare)
    return true;
  };
}

/**
 * Build the shared, config-driven relevance policy used by all discovery
 * scanners. The filter order and the missing-description behavior intentionally
 * match the standard scanner: title, posting age, tier, location, salary,
 * experience evidence, then content. Experience evidence is attached before
 * content filtering so canonical review rows retain numeric requirements and
 * blockers.
 */
export function buildScanRelevanceEvaluator(config = {}, { classifyTier = null, sinceMs = null, prescreenProfile = null } = {}) {
  const titleFilter = buildTitleFilter(config.title_filter);
  const skipTiers = Array.isArray(config.skip_tiers)
    ? config.skip_tiers.filter(value => typeof value === 'string').map(value => value.toLowerCase())
    : [];
  const locationFilter = buildLocationFilter(config.location_filter);
  const salaryFilter = buildSalaryFilter(config.salary_filter);
  const experiencePolicy = normalizeExperiencePolicy(config.experience_policy);
  const contentFilter = buildContentFilter(config.content_filter, { experiencePolicy });

  return (job) => {
    const titleFilterValue = [
      job.title,
      ...(Array.isArray(job.seniority) ? job.seniority : []),
    ].filter(value => typeof value === 'string').join(' ');
    if (!titleFilter(titleFilterValue)) return { eligible: false, reason: 'title' };

    if (sinceMs != null && job.postedAt != null) {
      const postedMs = typeof job.postedAt === 'number' ? job.postedAt : Date.parse(job.postedAt);
      if (Number.isFinite(postedMs) && postedMs < sinceMs) return { eligible: false, reason: 'posting_age' };
    }

    if (classifyTier && skipTiers.includes(classifyTier(job.title))) {
      return { eligible: false, reason: 'tier' };
    }

    const locationEligibility = locationFilter.classify(job.location, job.url, job.title);
    job.locationEligibility = locationEligibility.status;
    job.locationEligibilityCode = locationEligibility.code;
    job.locationEligibilityMatch = locationEligibility.matched;
    job.locationEligibilitySource = locationEligibility.source;
    if (locationEligibility.status === 'ineligible') {
      return { eligible: false, reason: 'location', locationEligibility };
    }

    if (!salaryFilter(job.salary)) return { eligible: false, reason: 'salary', locationEligibility };

    const experienceMetadata = classifyExperienceRequirements(job.description, experiencePolicy);
    if (experienceMetadata) {
      job.experienceMetadata = experienceMetadata;
      if (experienceMetadata.numeric_hard_blocker) {
        const existingBlockers = job.hardBlockers ?? job.hard_blockers;
        const blockers = Array.isArray(existingBlockers)
          ? existingBlockers
          : (existingBlockers ? [existingBlockers] : []);
        job.hardBlockers = [...new Set([...blockers, experienceMetadata.hard_blocker_reason])];
      }
    }

    if (!contentFilter(job.description, matchedTitleKeywords(job.title, config.title_filter))) {
      return { eligible: false, reason: 'content', locationEligibility, experienceMetadata };
    }

    if (prescreenProfile) {
      const prescreen = prescreenJob({
        title: job.title,
        description: job.description,
        location: job.location,
        country: job.country,
      }, prescreenProfile, { experiencePolicy });
      job.prescreen = prescreen;

      const existingLanguages = job.languageRequirements ?? job.language_requirements;
      const languages = Array.isArray(existingLanguages)
        ? existingLanguages
        : (existingLanguages == null ? [] : [existingLanguages]);
      const languageKeys = new Set(languages.map(value => typeof value === 'string' ? value : JSON.stringify(value)));
      for (const requirement of prescreen.language_requirements || []) {
        const key = typeof requirement === 'string' ? requirement : JSON.stringify(requirement);
        if (!languageKeys.has(key)) {
          languages.push(requirement);
          languageKeys.add(key);
        }
      }
      if (languages.length) job.languageRequirements = languages;

      const existingBlockers = job.hardBlockers ?? job.hard_blockers;
      const blockers = Array.isArray(existingBlockers)
        ? existingBlockers
        : (existingBlockers == null ? [] : [existingBlockers]);
      const uniqueBlockers = new Set(blockers);
      for (const blocker of prescreen.blockers || []) {
        // The coded prescreen entry replaces the uncoded experience reason added above.
        if (blocker.code === 'experience_outside' && experienceMetadata?.numeric_hard_blocker) {
          uniqueBlockers.delete(experienceMetadata.hard_blocker_reason);
        }
        const value = `${blocker.code}: ${blocker.evidence ?? ''}`;
        uniqueBlockers.add(value);
      }
      if (uniqueBlockers.size) job.hardBlockers = [...uniqueBlockers];
    }
    return { eligible: true, reason: null, locationEligibility, experienceMetadata };
  };
}

function hasUsablePostingDate(postedAt) {
  if (typeof postedAt === 'number') return Number.isFinite(postedAt);
  if (typeof postedAt === 'string') return Number.isFinite(Date.parse(postedAt));
  return false;
}

export function companyMatch(jobCompany, windowCompany) {
  const cleanNoSpaces = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const c1NoSpaces = cleanNoSpaces(jobCompany);
  const c2NoSpaces = cleanNoSpaces(windowCompany);
  if (c1NoSpaces === c2NoSpaces) return true;

  const cleanWithSpaces = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const c1WithSpaces = cleanWithSpaces(jobCompany);
  const c2WithSpaces = cleanWithSpaces(windowCompany);
  if (!c1WithSpaces || !c2WithSpaces) return false;

  const regex1 = new RegExp('\\b' + c2WithSpaces.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b');
  const regex2 = new RegExp('\\b' + c1WithSpaces.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b');
  return regex1.test(c1WithSpaces) || regex2.test(c2WithSpaces);
}

export function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function loadReApplyWindows(profilePath = resolveProfilePath()) {
  if (!existsSync(profilePath)) return {};
  try {
    const raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    const windows = raw.re_apply_windows || {};
    const validWindows = {};
    for (const [company, win] of Object.entries(windows)) {
      if (!win || typeof win !== 'object') continue;
      const lastApplyDate = win.last_apply_date;
      if (typeof lastApplyDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastApplyDate)) continue;
      if (isNaN(Date.parse(lastApplyDate))) continue;
      
      const sameRoleDays = win.same_role_days;
      if (sameRoleDays !== undefined && (!Number.isInteger(sameRoleDays) || sameRoleDays < 0)) continue;

      if (win.applied_to !== undefined && !Array.isArray(win.applied_to)) continue;
      if (win.applied_to !== undefined && win.applied_to.some(x => typeof x !== 'string')) continue;

      if (win.cross_role_bucket !== undefined && typeof win.cross_role_bucket !== 'string') continue;

      validWindows[company] = win;
    }
    return validWindows;
  } catch {
    return {};
  }
}

export function buildCooldownFilter(windows, today) {
  if (!windows || Object.keys(windows).length === 0) {
    return () => ({ skip: false });
  }

  const genericKeywords = new Set(['all', 'roles', 'role', 'family', 'bucket', 'group', 'team']);

  return (job) => {
    const jobCompany = job.company || '';
    const jobTitleLower = (job.title || '').toLowerCase();

    for (const [windowCompany, window] of Object.entries(windows)) {
      if (companyMatch(jobCompany, windowCompany)) {
        const lastApplyDate = window.last_apply_date;
        const sameRoleDays = Number(window.same_role_days || 0);
        if (!lastApplyDate) continue;

        const cooldownUntil = addDays(lastApplyDate, sameRoleDays);
        if (today >= cooldownUntil) {
          continue;
        }

        if (Array.isArray(window.applied_to)) {
          const matchesApplied = window.applied_to.some(role => {
            const roleLower = role.toLowerCase();
            return jobTitleLower.includes(roleLower);
          });
          if (matchesApplied) {
            return { skip: true, reason: `cooldown:${windowCompany}:${cooldownUntil}`, cooldownUntil };
          }
        }

        if (window.cross_role_bucket) {
          const bucketKeywords = window.cross_role_bucket
            .toLowerCase()
            .split('_')
            .filter(kw => kw && !genericKeywords.has(kw));

          const matchesBucket = bucketKeywords.some(kw => {
            if (kw === 'em') {
              return /\bem\b/i.test(jobTitleLower) || jobTitleLower.includes('engineering manager');
            }
            return jobTitleLower.includes(kw);
          });

          if (matchesBucket) {
            return { skip: true, reason: `cooldown:${windowCompany}:${cooldownUntil}`, cooldownUntil };
          }
        }
      }
    }

    return { skip: false };
  };
}


// ── URL rediscovery (--rediscover-404) ──────────────────────────────
// When a tracked company's job URL returns 404/410, the role may have just
// moved to a new URL (Workday/Greenhouse rotate URLs without closing roles).
// These helpers back an opt-in search-and-reverify fallback before giving up.

// extractCareersUrlDomain returns the hostname of a company's careers_url, or
// null when it's missing/unparseable. The presence of a domain is what gates
// the fallback — broad-discovery offers without a careers_url stay ineligible.
export function extractCareersUrlDomain(careersUrl) {
  if (!careersUrl) return null;
  try {
    return new URL(careersUrl).hostname;
  } catch {
    return null;
  }
}

// resolveSearchHref unwraps a DuckDuckGo HTML redirect (`/l/?uddg=<encoded>`)
// to its real destination, so domain matching sees the actual host instead of
// duckduckgo.com. Non-redirect hrefs pass through unchanged.
function resolveSearchHref(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const isDdgHost = u.hostname === 'duckduckgo.com' || u.hostname.endsWith('.duckduckgo.com');
    if (isDdgHost && u.pathname === '/l/') {
      const target = u.searchParams.get('uddg');
      if (target) return target;
    }
  } catch {
    /* fall through to the raw href */
  }
  return href;
}

// pickRediscoveredUrl chooses the first result whose hostname *exactly* equals
// the careers domain (no substring/look-alike matches), unwrapping search-engine
// redirects first. Pure + exported so result-matching is unit-testable without
// driving a real browser. Returns null when nothing matches.
export function pickRediscoveredUrl(hrefs, domain) {
  if (!domain || !Array.isArray(hrefs)) return null;
  for (const raw of hrefs) {
    const href = resolveSearchHref(raw);
    let host;
    try {
      host = new URL(href).hostname;
    } catch {
      continue;
    }
    if (host === domain) return href;
  }
  return null;
}

// REDISCOVER_TIMEOUT_MS bounds the single fallback search so a slow or blocked
// search engine can't stall the sequential verify loop.
const REDISCOVER_TIMEOUT_MS = 10_000;

// searchForNewUrl runs one site-scoped search for a moved tracked role and
// returns a same-domain URL if found, else null. Every failure path returns
// null — the fallback must never throw into the verify loop. Leaves the page on
// a blank document so the next checkUrlLiveness call starts clean.
async function searchForNewUrl(page, offer) {
  const domain = offer.careersUrlDomain;
  if (!domain) return null;
  const query = `"${offer.title}" "${offer.company}" site:${domain}`;
  try {
    await page.goto(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { waitUntil: 'domcontentloaded', timeout: REDISCOVER_TIMEOUT_MS },
    );
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a.result__a'))
        .map((a) => a.getAttribute('href'))
        .filter(Boolean),
    );
    return pickRediscoveredUrl(hrefs, domain);
  } catch {
    return null;
  } finally {
    try {
      await page.goto('about:blank');
    } catch {
      /* ignore — best-effort cleanup */
    }
  }
}

// ── Dedup ───────────────────────────────────────────────────────────

const PERMANENT_SCAN_HISTORY_STATUSES = new Set([
  'skipped_invalid_url',
  'skipped_blocked_host',
  'skipped_expired',
]);

function daysBetweenIsoDates(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (startDate.toISOString().slice(0, 10) !== start || endDate.toISOString().slice(0, 10) !== end) return null;
  return Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));
}

export function shouldDedupScanHistoryRow({ firstSeen, status = 'added' }, { recheckAfterDays = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (PERMANENT_SCAN_HISTORY_STATUSES.has(status)) return true;
  if (status.startsWith('cooldown:')) {
    const parts = status.split(':');
    const cooldownUntil = parts[parts.length - 1];
    return today < cooldownUntil;
  }
  if (status !== 'added') return false;
  if (recheckAfterDays == null) return true;
  const ageDays = daysBetweenIsoDates(firstSeen, today);
  if (ageDays == null) return true;
  return ageDays < recheckAfterDays;
}

export function scanHistoryPolicy(config = {}) {
  const raw = config.scan_history?.recheck_after_days;
  const parsed = Number.parseInt(raw, 10);
  return {
    recheckAfterDays: Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
  };
}

export function loadSeenUrls(policy = {}, paths = {}) {
  const seen = new Set();
  let recheckEligible = 0;
  const scanHistoryPath = paths.scanHistoryPath || SCAN_HISTORY_PATH;
  const pipelinePath = paths.pipelinePath || PIPELINE_PATH;
  const applicationsPath = paths.applicationsPath || APPLICATIONS_PATH;

  // scan-history.tsv
  if (existsSync(scanHistoryPath)) {
    const lines = readFileSync(scanHistoryPath, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const [url, firstSeen, , , , status = 'added'] = line.split('\t');
      if (!url) continue;
      if (shouldDedupScanHistoryRow({ firstSeen, status }, policy)) seen.add(normalizeUrlForDedup(url));
      else recheckEligible++;
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(pipelinePath)) {
    const text = readFileSync(pipelinePath, 'utf-8');
    for (const url of extractHttpUrlsFromMarkdown(text)) seen.add(normalizeUrlForDedup(url));
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(applicationsPath)) {
    const text = readFileSync(applicationsPath, 'utf-8');
    for (const url of extractHttpUrlsFromMarkdown(text)) seen.add(normalizeUrlForDedup(url));
  }

  return { seen, recheckEligible };
}

export function loadSeenCompanyRoles(appsPath = APPLICATIONS_PATH) {
  const seen = new Set();
  if (existsSync(appsPath)) {
    // Header-aware parse (tracker-parse.mjs, #954) — the old positional regex
    // captured the wrong cells on customized layouts (e.g. with a Location
    // column), so the seen-set keyed on garbage and dedup misfired.
    const lines = readFileSync(appsPath, 'utf-8').split('\n');
    const colmap = resolveColumns(lines);
    for (const line of lines) {
      const row = parseTrackerRow(line, colmap);
      if (!row) continue;
      const company = row.company.trim().toLowerCase();
      const role = row.role.trim().toLowerCase();
      if (company && role) seen.add(`${company}::${role}`);
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function normalizeScanScalar(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function normalizeScanUrl(value) {
  return String(value ?? '').trim().split(/\s+/)[0] || '';
}

function mergeSourceQueryMetadata(target, incoming) {
  const values = [];
  if (Array.isArray(target?.sourceQueries)) values.push(...target.sourceQueries);
  if (typeof target?.sourceQuery === 'string') values.push(target.sourceQuery);
  if (Array.isArray(incoming?.sourceQueries)) values.push(...incoming.sourceQueries);
  if (typeof incoming?.sourceQuery === 'string') values.push(incoming.sourceQuery);
  const queries = [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
  if (queries.length > 0) {
    target.sourceQueries = queries;
    target.sourceQuery = target.sourceQuery || queries[0];
  }
  if (!target.sourceId && incoming?.sourceId) target.sourceId = incoming.sourceId;
}

function evidenceBlockers(record) {
  return [record?.hardBlockers, record?.hard_blockers]
    .flatMap((value) => Array.isArray(value) ? value : (value == null ? [] : [value]))
    .filter((value) => value !== '' && value != null);
}

function evidenceExperienceMetadata(record) {
  const values = [record?.experienceMetadata, record?.experience_metadata];
  return values.find((value) => value != null && (typeof value !== 'string' || value.trim())) ?? null;
}

function evidenceDescription(record) {
  const values = [record?.description, record?.jobDescription, record?.job_description];
  return values.find((value) => typeof value === 'string' && value.trim()) || '';
}

function mergeDuplicateEvidence(target, incoming) {
  mergeSourceQueryMetadata(target, incoming);

  const blockers = [...new Set([...evidenceBlockers(target), ...evidenceBlockers(incoming)])];
  const hasCamelBlockers = Object.prototype.hasOwnProperty.call(target, 'hardBlockers')
    || Object.prototype.hasOwnProperty.call(incoming, 'hardBlockers');
  const hasSnakeBlockers = Object.prototype.hasOwnProperty.call(target, 'hard_blockers')
    || Object.prototype.hasOwnProperty.call(incoming, 'hard_blockers');
  if (hasCamelBlockers || (!hasSnakeBlockers && blockers.length > 0)) target.hardBlockers = blockers;
  if (hasSnakeBlockers) target.hard_blockers = blockers;

  const existingExperience = evidenceExperienceMetadata(target);
  const incomingExperience = evidenceExperienceMetadata(incoming);
  if (!existingExperience && incomingExperience) {
    target.experienceMetadata = incomingExperience;
    if (Object.prototype.hasOwnProperty.call(target, 'experience_metadata')) {
      target.experience_metadata = incomingExperience;
    }
  }

  if (!evidenceDescription(target)) {
    const incomingDescription = evidenceDescription(incoming);
    if (incomingDescription) target.description = incomingDescription;
  }
}

const MARKDOWN_ESCAPE_CHARS = {
  '\\': '\\\\',
  '[': '\\[',
  ']': '\\]',
};

export function sanitizeMarkdownField(value) {
  return normalizeScanScalar(value)
    .replace(/[\\[\]]/g, char => MARKDOWN_ESCAPE_CHARS[char])
    .replace(/\|/g, '/');
}

function sanitizePipelineUrl(value) {
  return normalizeScanUrl(value)
    .replace(/[\\[\]]/g, char => MARKDOWN_ESCAPE_CHARS[char])
    .replace(/\|/g, '%7C');
}

export function sanitizeTsvField(value) {
  const normalized = normalizeScanScalar(value);
  return /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
}

// Format an offer's parsed compensation (the annualized {min,max,currency} that
// providers like Ashby attach as `offer.salary`) into a compact, sanitized cell
// such as `120000-160000 USD`. Returns '' when there is no usable salary data.
// Non-positive bounds are dropped (a 0 min/max is meaningless comp data, not "$0").
export function formatCompensation(salary) {
  if (!salary || typeof salary !== 'object') return '';
  const num = (n) => (Number.isFinite(n) && n > 0 ? String(Math.round(n)) : null);
  const lo = num(salary.min);
  const hi = num(salary.max);
  const range = lo && hi && lo !== hi ? `${lo}-${hi}` : (lo || hi || '');
  if (!range) return '';
  const currency = typeof salary.currency === 'string' ? salary.currency.trim() : '';
  return sanitizeMarkdownField(currency ? `${range} ${currency}` : range);
}

export function formatPipelineOffer(offer) {
  const url = sanitizePipelineUrl(offer.url);
  const company = sanitizeMarkdownField(offer.company);
  const title = sanitizeMarkdownField(offer.title);
  // Optional trailing columns, each sanitized like every other field:
  //   4th = location, 5th = compensation.
  // Gate location on an actual string so malformed provider data (a number or
  // object) degrades to the 3-column form instead of stringifying into a
  // spurious column. The columns are positional, so a present compensation
  // forces the (possibly empty) location cell to keep comp in column 5.
  // loadSeenUrls dedups on the URL and ignores trailing columns (backward-compatible).
  const location = typeof offer.location === 'string' ? sanitizeMarkdownField(offer.location) : '';
  const compensation = formatCompensation(offer.salary);
  const base = `- [ ] ${url} | ${company} | ${title}`;
  let line = base;
  if (compensation) line = `${base} | ${location} | ${compensation}`;
  else if (location) line = `${base} | ${location}`;
  // Optional free-text ranking signal (e.g. a curated-list flag an importer
  // attaches). Labeled — not positional like location/compensation — so it can
  // ride on any row shape (bare URL, 3-, 4-, or 5-column) without a reader
  // confusing it for a positional cell, and it stays generic: nothing here is
  // source-specific, and an offer without `note` produces byte-identical output.
  const note = typeof offer.note === 'string' ? sanitizeMarkdownField(offer.note) : '';
  return note ? `${line} | note: ${note}` : line;
}

export function formatScanHistoryRow(offer, date, status = 'added') {
  return [
    normalizeScanUrl(offer.url),
    date,
    offer.source,
    offer.title,
    offer.company,
    status,
    offer.location || '',
    // JD-content fingerprint (#1597): 16 hex chars when the provider's list
    // API shipped a usable description, '' otherwise. Lets later scans flag
    // the same body re-posted under a different company (agency cross-listing)
    // without storing the body. All readers tolerate the extra column.
    offer.fingerprint ?? fingerprintText(offer.description),
  ].map(sanitizeTsvField).join('\t');
}

/**
 * Read scan-history.tsv rows that carry a fingerprint, for the cross-listing
 * check. Older rows without the 8th column simply never match.
 *
 * @param {string} [historyPath] - Override for tests.
 * @returns {Array<{url: string, dateStr: string, company: string, title: string, fingerprint: string}>}
 */
export function loadFingerprintHistory(historyPath = SCAN_HISTORY_PATH) {
  if (!existsSync(historyPath)) return [];
  const rows = [];
  for (const line of readFileSync(historyPath, 'utf-8').split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 8 || !cols[7].trim()) continue;
    rows.push({
      url: (cols[0] || '').trim(),
      dateStr: (cols[1] || '').trim(),
      title: (cols[3] || '').trim(),
      company: (cols[4] || '').trim(),
      fingerprint: cols[7].trim(),
    });
  }
  return rows;
}

// Standard skeleton created on fresh install — matches the format documented
// in modes/pipeline.md and expected by /career-ops pipeline.
const PIPELINE_SKELETON = `# Pipeline — Pending URLs

Paste job URLs below as \`- [ ] {url}\` then run \`/career-ops pipeline\`.

## Pending

## Processed
`;

// Current section names (English). Legacy Spanish names are checked as fallback
// so existing pipeline.md files created before this change keep working.
const PENDING_MARKERS = ['## Pending', '## Pendientes'];
const PROCESSED_MARKERS = ['## Processed', '## Procesadas'];

export function appendToPipeline(offers) {
  if (offers.length === 0) return;

  // Auto-create with standard skeleton if missing (fresh-install guard).
  if (!existsSync(PIPELINE_PATH)) {
    writeFileSync(PIPELINE_PATH, PIPELINE_SKELETON, 'utf-8');
  }

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  const marker = PENDING_MARKERS.find(m => text.includes(m)) ?? null;
  const idx = marker !== null ? text.indexOf(marker) : -1;

  if (idx === -1) {
    // No Pending section found — insert one before Processed (or at end)
    const procIdx = PROCESSED_MARKERS.reduce((found, m) => {
      const i = text.indexOf(m);
      return (found === -1 || (i !== -1 && i < found)) ? i : found;
    }, -1);
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n## Pending\n\n` + offers.map(formatPipelineOffer).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pending content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(formatPipelineOffer).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

export function appendToScanHistory(offers, date, status = 'added') {
  // Ensure file + header exist. Location appended as 7th column for non-breaking
  // backward compat — older scan-history.tsv files with 6 columns still parse fine
  // since loadSeenUrls only reads column 0. `status` is parameterized so callers
  // can record verify outcomes (`skipped_expired`, etc.) without the legacy
  // `(expired)` suffix in `source`.
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }

  const lines = offers.map(o => formatScanHistoryRow(o, date, status)).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Scan-run persistence (#1604) ────────────────────────────────────

const SCAN_RUNS_PATH = 'data/scan-runs.tsv';

// One row of run counters per non-dry scan — today these numbers are printed
// once in the summary and lost when the terminal scrolls. Full ISO timestamp
// (two scans in one day must not collapse). `status` is reserved: always
// 'completed' in v1; a follow-up wires failure-path writes so trend stats can
// exclude survivorship bias. Consumers MUST parse by header name, never by
// position — columns may be appended in later versions.
export const SCAN_RUNS_HEADER = 'timestamp\tstatus\tcompanies\tboards\tfound\tfiltered_title\tfiltered_tier\tfiltered_location\tfiltered_salary\tfiltered_content\tfiltered_cooldown\tdupes\tnew_added\terrors\n';

export function appendScanRunSummary(c, filePath = SCAN_RUNS_PATH) {
  if (!existsSync(filePath)) writeFileSync(filePath, SCAN_RUNS_HEADER, 'utf-8');
  const row = [
    c.timestamp, c.status ?? 'completed', c.companies, c.boards, c.found,
    c.filteredTitle, c.filteredTier, c.filteredLocation, c.filteredSalary,
    c.filteredContent, c.filteredCooldown, c.dupes, c.newAdded, c.errors,
  ].join('\t') + '\n';
  appendFileSync(filePath, row, 'utf-8');
}

export function generateStandardScanRunId(now = new Date(), pid = process.pid) {
  return `scan-${now.toISOString().replace(/[:.]/g, '-')}-${pid}`;
}

export function persistStandardScanRun({
  runId,
  offers,
  root = resolveScanRoot(),
  createdAt = new Date().toISOString(),
  metadata = {},
}) {
  return writeImmutableScanRun({
    root,
    runId,
    createdAt,
    sourceArchitecture: 'standard_scan',
    inputs: [{ name: 'standard-scan', rows: offers }],
    metadata,
  });
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function verifyOffers(offers, { headedFallback = false, throttleBaseMs = 0, rediscover = false } = {}) {
  // Dynamic imports keep the default zero-token path free of Playwright startup
  let chromium;
  let checkUrlLiveness;
  let checkUrlLivenessWithFallback;
  let createHeadedPageProvider;
  let newLivenessPage;
  let jitteredDelayMs;
  let sleep;
  try {
    ({ chromium } = await import('playwright'));
    ({ checkUrlLiveness, checkUrlLivenessWithFallback, createHeadedPageProvider, newLivenessPage, jitteredDelayMs, sleep } = await import('./liveness-browser.mjs'));
  } catch (err) {
    throw new Error(
      `--verify requires Playwright with Chromium (run "npx playwright install chromium"): ${err.message}`,
      { cause: err },
    );
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(
      `--verify could not launch Chromium (run "npx playwright install chromium" or re-run without --verify): ${err.message}`,
      { cause: err },
    );
  }

  // Routing buckets. Only definitive expired and URL-guard failures are
  // permanent in scan-history; uncertain/no-Apply outcomes remain retryable.
  //   verified  → active pages and transient uncertainty (retry next scan)
  //   expired   → 404/410, explicit closure, or authoritative ATS removal
  //   dropped   → page loaded but no visible Apply control (retryable)
  //   invalid   → up-front URL guard rejections (malformed / non-http / private)
  const verified = [];
  const expired = [];
  const dropped = [];
  const invalid = [];
  const migrated = [];

  const headed = headedFallback ? createHeadedPageProvider(chromium) : null;
  const getHeadedPage = headed ? () => headed.get() : undefined;

  try {
    const page = await newLivenessPage(browser);
    // Sequential — project rule: never Playwright in parallel
    for (let i = 0; i < offers.length; i++) {
      const offer = offers[i];
      const { result, code, reason } = headed
        ? await checkUrlLivenessWithFallback(page, offer.url, { getHeadedPage })
        : await checkUrlLiveness(page, offer.url);
      if (result === 'expired') {
        // 404/410 on a tracked company may just be a moved role — run one
        // search + re-verify before giving up (opt-in via --rediscover-404).
        // Only http_gone (HTTP 404/410) qualifies; soft-expiry signals
        // (redirect/body/listing) are real closures, not URL moves.
        if (rediscover && code === 'http_gone' && offer.tracked && offer.careersUrlDomain) {
          const newUrl = await searchForNewUrl(page, offer);
          if (newUrl) {
            // Mirror the primary check: without the headed fallback, a
            // challenge-prone domain would flag the rediscovered URL as
            // expired just because the recheck hit the same anti-bot wall.
            const recheck = headed
              ? await checkUrlLivenessWithFallback(page, newUrl, { getHeadedPage })
              : await checkUrlLiveness(page, newUrl);
            // Require a *confirmed* live page before migrating. A transient
            // 'uncertain' (timeout/DNS/5xx) must not commit an unverified URL —
            // fall through to expired (the original 404/410 is a real closure).
            if (recheck.result === 'active') {
              migrated.push({
                ...offer,
                url: newUrl,
                previousUrl: offer.url,
                livenessStatus: recheck.result,
                livenessCode: recheck.code,
                livenessReason: recheck.reason,
              });
              console.log(`  🔄 migrated  ${offer.company} | ${offer.title} → ${newUrl}`);
              continue;
            }
          }
        }
        expired.push({ ...offer, reason });
        console.log(`  ❌ expired   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && GUARD_CODES.has(code)) {
        // Guard failures are permanent (not transient like a timeout) — record them
        // separately so they don't end up in pipeline.md but DO appear in scan-history
        // with a precise status, dedup-blocking them on subsequent scans.
        invalid.push({ ...offer, code, reason });
        console.log(`  ⛔ invalid   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && code === 'no_apply_control') {
        // Page loaded but classifier could not find an Apply control. Treat like
        // expired for this run's routing, but record a retryable history status.
        dropped.push({ ...offer, reason });
        console.log(`  ⚠️ no-apply  ${offer.company} | ${offer.title} (${reason})`);
      } else {
        // 'active' or 'uncertain' due to navigation_error (transient — retry next scan)
        verified.push({
          ...offer,
          livenessStatus: result,
          livenessCode: code,
          livenessReason: reason,
        });
        const icon = result === 'active' ? '✅' : '⚠️';
        console.log(`  ${icon} ${result.padEnd(9)} ${offer.company} | ${offer.title}`);
      }

      const wait = i < offers.length - 1 ? jitteredDelayMs(throttleBaseMs) : 0;
      if (wait) await sleep(wait);
    }
  } finally {
    if (headed) await headed.close();
    await browser.close();
  }

  return { verified, expired, dropped, invalid, migrated };
}

// Stable codes from liveness-browser's up-front URL guard. Routing dispatches
// on these codes (not on regex over reason strings) so wording can change
// without breaking the pipeline.
const GUARD_CODES = new Set(['invalid_url', 'unsupported_protocol', 'blocked_host']);

// guardStatusFor maps a guard code to the canonical scan-history status string.
function guardStatusFor(code) {
  if (code === 'blocked_host') return 'skipped_blocked_host';
  // invalid_url and unsupported_protocol both surface as malformed input
  return 'skipped_invalid_url';
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const sinceDays = parseSinceDays(args);
  const sinceMs = sinceDays == null ? null : Date.now() - sinceDays * 86_400_000;
  const runIdFlag = args.indexOf('--run-id');
  const requestedRunId = runIdFlag === -1 ? '' : args[runIdFlag + 1];
  if (runIdFlag !== -1 && (!requestedRunId || requestedRunId.startsWith('--'))) {
    throw new Error('--run-id requires an explicit value');
  }
  const runId = requestedRunId || generateStandardScanRunId();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(runId)) {
    throw new Error('run ID must be 1-120 safe filename characters');
  }
  const verify = args.includes('--verify');
  // Opt-in: on an anti-bot challenge (e.g. pracuj.pl Cloudflare wall), retry the
  // URL in a headed browser. Off by default — headed Chromium needs a display, so
  // scheduled/unattended scans should not rely on it.
  const headedFallback = args.includes('--headed-fallback');
  // --throttle or --throttle=<ms>: jittered gap between --verify checks to stay
  // under rate-based WAF limits (pracuj.pl flags the session after a few rapid
  // hits). Default base 5000ms. Off by default — most ATS feeds don't need it.
  const throttleArg = args.find((a) => a === '--throttle' || a.startsWith('--throttle='));
  const throttleBaseMs = throttleArg ? (Number(throttleArg.split('=')[1]) || 5000) : 0;
  // --rediscover-404: when a tracked company's URL 404/410s, search for the
  // moved role and re-verify before marking it expired. Opt-in; rides on --verify.
  const rediscover = args.includes('--rediscover-404');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  await loadOptionalDotenv();

  // 1. Load providers
  const providersDir = resolveProvidersDir();
  const providers = await loadProviders(providersDir);
  // Opt-in: merge enabled keyed/auth-gated provider plugins. Returns immediately
  // (no discovery, no dotenv, no process.env mutation) when config/plugins.yml is
  // absent — so a plain scan with no plugins configured stays byte-identical.
  await mergeProviderPlugins(providers, { root: path.dirname(providersDir) });
  if (providers.size === 0) {
    console.error('Error: no providers loaded from providers/');
    process.exit(1);
  }

  // 2. Read portals.yml
  const portalsPath = resolvePortalsPath();
  if (!existsSync(portalsPath)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  let rawConfig;
  try {
    rawConfig = parseYaml(readFileSync(portalsPath, 'utf-8'));
  } catch (err) {
    console.error(`Error: failed to parse ${portalsPath}: ${err.message}`);
    process.exit(1);
  }
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const companies = Array.isArray(config.tracked_companies) ? config.tracked_companies : [];
  const boards = Array.isArray(config.job_boards) ? config.job_boards : [];
  // Seniority tier classifier integration
  let classifyTier = null;
  const skipTiers = Array.isArray(config.skip_tiers)
    ? config.skip_tiers.filter(t => typeof t === 'string').map(t => t.toLowerCase())
    : [];
  if (skipTiers.length > 0) {
    const mod = await import('./classify-tier.mjs');
    classifyTier = mod.classifyTier || mod.default;
  }

  const trustValidator = buildTrustValidator(config.trust_filter);
  const prescreenProfilePath = resolveProfilePath();
  const prescreenProfile = existsSync(prescreenProfilePath)
    ? loadPrescreenProfile(prescreenProfilePath)
    : null;
  if (!prescreenProfile) {
    console.error(`Warning: prescreen profile not found at ${prescreenProfilePath}; candidate pre-screen annotations are disabled.`);
  }
  const evaluateScanRelevance = buildScanRelevanceEvaluator(config, { classifyTier, sinceMs, prescreenProfile });
  const enrichmentTitleFilter = buildTitleFilter(config.title_filter);
  const enrichmentLocationFilter = buildLocationFilter(config.location_filter);

  // 3. Resolve a provider for each enabled company / board
  const targets = [];
  let skippedCount = 0;
  let boardCount = 0;
  const resolveErrors = [];
  const agentHandoff = [];

  /**
   * Processes a list of configuration entries, resolves their appropriate data providers,
   * and appends valid entries to the global scanning targets list.
   * @param {Array<{ name?: string, enabled?: boolean, [key: string]: unknown }>} entries - List of entries.
   * @param {{ isBoard?: boolean }} [options={}] - Configuration options.
   */
  function resolveEntries(entries, { isBoard = false } = {}) {
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.enabled === false) continue;
      if (typeof entry.name !== 'string' || !entry.name.trim()) {
        console.error(`⚠️  Skipping entry — missing or non-string 'name' field: ${JSON.stringify(entry)}`);
        continue;
      }
      if (filterCompany && !entry.name.toLowerCase().includes(filterCompany)) continue;
      
      const resolved = resolveProvider(entry, providers);
      if (!resolved) {
        skippedCount++;
        if (entry.scan_method === 'websearch') {
          agentHandoff.push({
            company: entry.name,
            method: 'websearch',
            query: entry.scan_query || entry.search_query || entry.careers_url || '',
          });
        }
        continue;
      }
      
      if (resolved.error) { 
        resolveErrors.push({ company: entry.name, error: resolved.error, kind: 'provider_resolution' });
        continue; 
      }
      
      targets.push({ ...entry, _provider: resolved.provider, _isBoard: isBoard });
      if (isBoard) boardCount++;
    }
  }

  resolveEntries(companies);
  resolveEntries(boards, { isBoard: true });

  const localParserCount = targets.filter(t => t._provider.id === 'local-parser').length;
  const companyCount = targets.length - boardCount;
  const parts = [`${companyCount} companies`];
  if (boardCount > 0) parts.push(`${boardCount} job boards`);
  parts.push(`${localParserCount} local parser`);
  parts.push(`${skippedCount} skipped — no provider matched`);
  console.log(`Scanning ${parts.join('; ')} via providers`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 4. Load dedup sets
  const historyPolicy = scanHistoryPolicy(config);
  const seenUrlState = loadSeenUrls(historyPolicy);
  const seenUrls = seenUrlState.seen;
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 5. Fetch from each target
  const date = new Date().toISOString().slice(0, 10);
  const windows = loadReApplyWindows();
  const cooldownFilter = buildCooldownFilter(windows, date);
  let totalFilteredCooldown = 0;
  const cooldownOffers = [];
  let totalFound = 0;
  let totalFilteredTitle = 0;
  let totalFilteredTier = 0;
  let totalFilteredLocation = 0;
  let totalFilteredPostingAge = 0;
  let totalFilteredSalary = 0;
  let totalFilteredContent = 0;
  let totalDupes = 0;
  const newOffers = [];
  const newOffersByUrl = new Map();
  const newOffersByCompanyRole = new Map();
  const newOffersByCandidateId = new Map();
  const errors = [...resolveErrors];
  const degradedDiagnostics = [];
  const emptyTargets = [];
  const degradedTargetHealth = new Map();
  let successfulTargets = 0;
  let failedTargets = resolveErrors.length;
  let degradedTargets = 0;

  const tasks = targets.map(company => async () => {
    let provider = company._provider;
    let targetDegraded = false;
    // The standard scan retains unknown dates; providers may use this signal to
    // avoid dropping records before the scanner's authoritative date gate.
    const ctx = { ...makeHttpCtx(), includeUndated: true, ...(sinceMs == null ? {} : { sinceMs }) };
    let sourceName = provider.id === 'local-parser' ? 'local-parser' : `${provider.id}-api`;
    try {
      let jobs;
      try {
        jobs = await provider.fetch(company, ctx);
      } catch (parserErr) {
        if (provider.id !== 'local-parser') throw parserErr;
        const fallback = resolveProvider(company, providers, { skipIds: ['local-parser'] });
        if (!fallback || fallback.error) {
          const fallbackReason = fallback?.error || 'no fallback provider matched';
          const combined = new Error(`local parser failed: ${parserErr.message}; fallback failed: ${fallbackReason}`);
          combined.scanKind = fallback?.error ? 'provider_resolution' : classifyFetchError(parserErr);
          throw combined;
        }
        provider = fallback.provider;
        sourceName = `${provider.id}-api`;
        try {
          jobs = await provider.fetch(company, ctx);
        } catch (fallbackErr) {
          const combined = new Error(`local parser failed: ${parserErr.message}; ${provider.id} fallback failed: ${fallbackErr.message}`);
          combined.status = fallbackErr.status;
          combined.kind = fallbackErr.kind;
          combined.scanKind = classifyFetchError(fallbackErr);
          throw combined;
        }
        degradedDiagnostics.push({
          company: company.name,
          error: `local parser failed, used API fallback: ${parserErr.message}`,
          kind: 'fallback',
        });
        degradedTargetHealth.set(company.name, 'partial:fallback');
        targetDegraded = true;
      }
      if (!Array.isArray(jobs)) {
        throw new Error(`${provider.id}: fetch() did not return an array`);
      }
      successfulTargets++;
      totalFound += jobs.length;
      if (!company._isBoard && jobs.length === 0) {
        emptyTargets.push(company.name);
      }

      for (const job of jobs) {
        // Trust enrichment — runs before filters, never drops
        const trustResult = trustValidator(job);
        job.trustScore = trustResult.score;
        job.trustFlags = trustResult.flags;
        job.trustLevel = trustResult.level;

        // Date detail lookups are opt-in per provider. Run them only for jobs
        // with no usable date that pass the existing cheap title, tier, and
        // location checks. Salary/content/experience remain solely in the
        // authoritative evaluator below because detail data can complete them.
        if (!hasUsablePostingDate(job.postedAt) && typeof provider?.enrichDate === 'function') {
          const titleFilterValue = [
            job.title,
            ...(Array.isArray(job.seniority) ? job.seniority : []),
          ].filter(value => typeof value === 'string').join(' ');
          const titleEligible = enrichmentTitleFilter(titleFilterValue);
          const tierEligible = !classifyTier || !skipTiers.includes(classifyTier(job.title));
          const locationEligibility = enrichmentLocationFilter.classify(job.location, job.url, job.title);
          if (titleEligible && tierEligible && locationEligibility.status !== 'ineligible') {
            const originalPostedAt = job.postedAt;
            try {
              await provider.enrichDate(job, ctx);
            } catch {
              // A detail lookup is enrichment, not a board-fetch failure.
              // Preserve the original unknown-date behavior if it fails.
              job.postedAt = originalPostedAt;
            }
          }
        }

        const relevance = evaluateScanRelevance(job);
        if (!relevance.eligible) {
          if (relevance.reason === 'title') totalFilteredTitle++;
          else if (relevance.reason === 'posting_age') totalFilteredPostingAge++;
          else if (relevance.reason === 'tier') totalFilteredTier++;
          else if (relevance.reason === 'location') totalFilteredLocation++;
          else if (relevance.reason === 'salary') totalFilteredSalary++;
          else if (relevance.reason === 'content') totalFilteredContent++;
          continue;
        }
        const scanCandidateId = deriveCandidateId(job);
        const urlKey = normalizeUrlForDedup(job.url);
        if (seenUrls.has(urlKey) || newOffersByCandidateId.has(scanCandidateId)) {
          const existingOffer = newOffersByUrl.get(urlKey);
          const identityOffer = newOffersByCandidateId.get(scanCandidateId);
          if (existingOffer || identityOffer) mergeDuplicateEvidence(existingOffer || identityOffer, job);
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        // Company/title is only a legacy compatibility signal. A reliable ATS
        // requisition identity must not be collapsed merely because another
        // requisition has the same presentation title.
        if (seenCompanyRoles.has(key) && !atsIdentityFromUrl(job.url)) {
          const existingOffer = newOffersByCompanyRole.get(key);
          if (existingOffer) existingOffer.possibleDuplicate = true;
          job.possibleDuplicate = true;
        }
        const cooldownResult = cooldownFilter(job);
        if (cooldownResult.skip) {
          totalFilteredCooldown++;
          cooldownOffers.push({
            job: { ...job, source: sourceName },
            status: cooldownResult.reason,
          });
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(urlKey);
        seenCompanyRoles.add(key);
        // Tag with the company's careers domain so verify can offer a 404/410
        // rediscovery fallback. A null domain (no careers_url) marks the offer
        // as broad-discovery — ineligible for the fallback, per the issue scope.
        const careersUrlDomain = extractCareersUrlDomain(company.careers_url);
        const offer = {
          ...job,
          source: sourceName,
          tracked: Boolean(careersUrlDomain),
          careersUrlDomain,
        };
        newOffersByUrl.set(urlKey, offer);
        newOffersByCompanyRole.set(key, offer);
        newOffersByCandidateId.set(scanCandidateId, offer);
        newOffers.push(offer);
      }

      // Providers may discover additional partial coverage while performing
      // per-job detail lookups, so read the array metadata after enrichment.
      const coverage = providerCoverage(jobs);
      if (coverage?.status === 'partial') {
        targetDegraded = true;
        if (!degradedTargetHealth.has(company.name)) {
          degradedTargetHealth.set(company.name, `partial:${coverage.code}`);
        }
        degradedDiagnostics.push({
          company: company.name,
          error: `${provider.id}: ${coverage.reason}`,
          kind: 'partial',
          coverage,
        });
      }
      if (targetDegraded) degradedTargets++;
    } catch (err) {
      failedTargets++;
      errors.push({
        company: company.name,
        error: err.message,
        kind: err.scanKind || classifyFetchError(err),
      });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);
  const attemptedTargets = targets.length + resolveErrors.length;
  const completionStatus = attemptedTargets === 0
    ? (agentHandoff.length > 0 ? 'handoff_only' : 'no_executable_targets')
    : successfulTargets === 0
      ? 'failed'
      : (failedTargets > 0 || degradedTargets > 0 ? 'partial' : 'completed');
  const terminalFailure = completionStatus === 'failed' || completionStatus === 'no_executable_targets';

  // 5.5. Optional liveness verification — drop expired and guard-rejected postings
  let verifiedOffers = newOffers;
  let expiredOffers = [];
  let droppedOffers = [];
  let invalidOffers = [];
  let migratedOffers = [];
  if (verify && newOffers.length > 0) {
    console.log(`\nVerifying liveness of ${newOffers.length} new offer(s) with Playwright (sequential)...`);
    const result = await verifyOffers(newOffers, { headedFallback, throttleBaseMs, rediscover });
    verifiedOffers = result.verified;
    expiredOffers = result.expired;
    droppedOffers = result.dropped;
    invalidOffers = result.invalid;
    migratedOffers = result.migrated;
    // Migrated offers re-enter the pipeline at their newly discovered URL.
    if (migratedOffers.length > 0) {
      verifiedOffers = [...verifiedOffers, ...migratedOffers];
    }
  }

  // 5.7. Cross-listing check (#1597): fingerprint each new offer's JD body and
  // compare against recent history rows from a DIFFERENT company — the same
  // requirements text under two names is usually an agency re-post of a direct
  // listing (or vice versa), which URL and company+role dedup both miss.
  // Fingerprints are computed once here and reused by appendToScanHistory.
  for (const offer of verifiedOffers) {
    offer.fingerprint = fingerprintText(offer.description);
  }
  const crossListings = findCrossListings(verifiedOffers, loadFingerprintHistory());

  // 6. Write results
  let immutableRun = null;
  if (!dryRun && successfulTargets > 0) {
    // Immutable authority is committed first. A repeated run ID or incomplete
    // run write fails before legacy pipeline/history outputs can be mutated.
    immutableRun = persistStandardScanRun({
      runId,
      offers: verifiedOffers,
      metadata: {
        liveness_verified: verify,
        rediscovery_enabled: rediscover,
        source: 'scan.mjs',
        completion_status: completionStatus,
        targets_attempted: attemptedTargets,
        targets_succeeded: successfulTargets,
        targets_failed: failedTargets,
        targets_degraded: degradedTargets,
      },
    });
  }
  if (!dryRun && successfulTargets > 0) mkdirSync('data', { recursive: true });
  if (!dryRun && verifiedOffers.length > 0) {
    appendToPipeline(verifiedOffers);
    appendToScanHistory(verifiedOffers, date);
  }
  if (!dryRun && cooldownOffers.length > 0) {
    const cooldownGroups = {};
    for (const item of cooldownOffers) {
      if (!cooldownGroups[item.status]) {
        cooldownGroups[item.status] = [];
      }
      cooldownGroups[item.status].push(item.job);
    }
    for (const [status, group] of Object.entries(cooldownGroups)) {
      appendToScanHistory(group, date, status);
    }
  }
  // Expired postings — plus the old URLs of migrated offers — are recorded as
  // skipped_expired so subsequent scans dedup-skip the dead URLs.
  const expiredForHistory = [
    ...expiredOffers,
    ...migratedOffers.map(o => ({ ...o, url: o.previousUrl })),
  ];
  if (!dryRun && expiredForHistory.length > 0) {
    appendToScanHistory(expiredForHistory, date, 'skipped_expired');
  }
  // Pages that loaded but had no Apply control do not reach this run's pipeline.
  // Their status remains retryable in shouldDedupScanHistoryRow.
  if (!dryRun && droppedOffers.length > 0) {
    appendToScanHistory(droppedOffers, date, 'skipped_no_apply_control');
  }
  // Guard-rejected URLs (invalid / unsupported protocol / blocked host) are
  // recorded with a precise status so subsequent scans dedup-skip them via
  // loadSeenUrls, but they never reach pipeline.md.
  if (!dryRun && invalidOffers.length > 0) {
    // Group by code so the TSV reflects the actual reason category.
    const byStatus = new Map();
    for (const o of invalidOffers) {
      const status = guardStatusFor(o.code);
      if (!byStatus.has(status)) byStatus.set(status, []);
      byStatus.get(status).push(o);
    }
    for (const [status, group] of byStatus) {
      appendToScanHistory(group, date, status);
    }
  }

  // 7. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  const summaryCompanies = targets.filter(t => !t._isBoard).length;
  const summaryBoards = targets.filter(t => t._isBoard).length;
  console.log(`Companies scanned:     ${summaryCompanies}`);
  if (summaryBoards > 0) console.log(`Job boards scanned:    ${summaryBoards}`);
  console.log(`Targets succeeded:     ${successfulTargets}/${attemptedTargets}`);
  console.log(`Targets failed:        ${failedTargets}`);
  console.log(`Targets degraded:      ${degradedTargets}`);
  console.log(`Completion status:     ${completionStatus}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFilteredTitle} removed`);
  if (skipTiers.length > 0) {
    console.log(`Filtered by tier:      ${totalFilteredTier} removed`);
  }
  console.log(`Filtered by location:  ${totalFilteredLocation} removed`);
  if (sinceDays != null) console.log(`Filtered by --since:   ${totalFilteredPostingAge} removed (older than ${sinceDays}d)`);
  console.log(`Filtered by salary:   ${totalFilteredSalary} removed`);
  console.log(`Filtered by content:  ${totalFilteredContent} removed`);
  if (Object.keys(windows).length > 0 || totalFilteredCooldown > 0) {
    console.log(`Filtered by cooldown:  ${totalFilteredCooldown} removed`);
  }
  console.log(`Duplicates:            ${totalDupes} skipped`);
  if (crossListings.length > 0) {
    console.log(`\n⚠️  Possible cross-listings (same JD text, different company) — warn only, nothing was dropped:`);
    for (const { offer, row, score } of crossListings) {
      console.log(`  - ${offer.company} — ${offer.title}`);
      console.log(`    ≈ ${Math.round(score * 100)}% of ${row.company} — ${row.title} (seen ${row.dateStr})`);
      console.log(`    ${offer.url}`);
      console.log(`    vs ${row.url}`);
    }
    console.log(`  If one side is an agency, apply through ONE channel only — a double submission burns both (#1596).`);
  }
  if (historyPolicy.recheckAfterDays != null) {
    console.log(`Recheck eligible:      ${seenUrlState.recheckEligible} old scan-history URL(s)`);
  }
  if (verify) {
    console.log(`Expired (verified):    ${expiredOffers.length} dropped`);
    console.log(`Rediscovered (moved):  ${migratedOffers.length} migrated`);
    console.log(`No apply control:      ${droppedOffers.length} dropped`);
    console.log(`Invalid (guarded):     ${invalidOffers.length} dropped`);
  }
  console.log(`New offers added:      ${verifiedOffers.length}`);

  // Trust validation summary (only when trust_filter is configured)
  if (config.trust_filter && config.trust_filter.enabled !== false && verifiedOffers.length > 0) {
    const trustHigh = verifiedOffers.filter(o => o.trustLevel === 'high').length;
    const trustMedium = verifiedOffers.filter(o => o.trustLevel === 'medium').length;
    const trustLow = verifiedOffers.filter(o => o.trustLevel === 'low').length;
    console.log(`Trust validation:      ${trustHigh} high, ${trustMedium} medium, ${trustLow} low`);
    // Flag breakdown
    /** @type {Record<string, number>} */
    const flagCounts = {};
    for (const o of verifiedOffers) {
      for (const f of (o.trustFlags || [])) {
        flagCounts[f] = (flagCounts[f] || 0) + 1;
      }
    }
    if (Object.keys(flagCounts).length > 0) {
      const parts = Object.entries(flagCounts).map(([k, v]) => `${k}: ${v}`);
      console.log(`Trust flags:           ${parts.join(', ')}`);
    }
  }

  if (agentHandoff.length > 0) {
    console.log(`Agent/WebSearch handoff: ${agentHandoff.length} compan${agentHandoff.length === 1 ? 'y' : 'ies'} not handled by zero-token providers`);
    for (const item of agentHandoff.slice(0, 25)) {
      const hint = item.query ? ` — ${item.query}` : '';
      console.log(`  • ${item.company} (${item.method})${hint}`);
    }
    if (agentHandoff.length > 25) {
      console.log(`  … ${agentHandoff.length - 25} more omitted; narrow with --company or inspect portals.yml`);
    }
  }

  const unreachableTargets = errors.filter((e) => e.kind === 'slug_gone');
  const endpointGoneTargets = errors.filter((e) => e.kind === 'endpoint_gone');
  const networkTargets = errors.filter((e) => e.kind === 'network');
  const partialTargets = degradedDiagnostics.filter((e) => e.kind === 'partial');
  const fallbackTargets = degradedDiagnostics.filter((e) => e.kind === 'fallback');
  const otherErrors = errors.filter((e) => !['slug_gone', 'endpoint_gone', 'network'].includes(e.kind));
  const nowStr = new Date().toISOString();
  const errorKindByCompany = new Map(errors.filter((error) => error.kind).map((error) => [error.company, error.kind]));
  const healthByCompany = new Map(targets.map((target) => [target.name, {
    timestamp: nowStr,
    company: target.name,
    status: degradedTargetHealth.get(target.name)
      || errorKindByCompany.get(target.name)
      || (emptyTargets.includes(target.name) ? 'empty' : 'reachable'),
  }]));
  for (const error of resolveErrors) {
    healthByCompany.set(error.company, { timestamp: nowStr, company: error.company, status: 'provider_resolution' });
  }
  const healthRecords = [...healthByCompany.values()];
  const streaks = computeConsecutiveFailures([...loadPortalHealth(), ...healthRecords]);
  const threshold = Number(config.portal_health_threshold) > 0 ? Number(config.portal_health_threshold) : 3;
  const persistent = [...new Set(errors.filter((error) => (streaks.get(error.company) || 0) >= threshold).map((error) => error.company))];
  if (persistent.length > 0) console.log(`\n🚨 Persistent portal failures (${threshold}+ runs): ${persistent.join(', ')}`);

  if (unreachableTargets.length > 0) {
    const names = unreachableTargets.map((e) => e.company).join(', ');
    console.log(`\n⚠️  ${unreachableTargets.length} target(s) unreachable (slug?): ${names} — run: node verify-portals.mjs`);
  }
  if (endpointGoneTargets.length > 0) {
    const names = endpointGoneTargets.map((e) => e.company).join(', ');
    console.log(`\n⚠️  ${endpointGoneTargets.length} provider endpoint(s) gone: ${names} — inspect provider support before replacing the endpoint`);
  }
  if (partialTargets.length > 0) {
    console.log(`\n🟠 ${partialTargets.length} target(s) returned partial coverage while retaining fetched jobs:`);
    for (const e of partialTargets) console.log(`  ◐ ${e.company}: ${e.error}`);
  }
  if (fallbackTargets.length > 0) {
    console.log(`\n🟠 ${fallbackTargets.length} target(s) succeeded through a fallback provider:`);
    for (const e of fallbackTargets) console.log(`  ◐ ${e.company}: ${e.error}`);
  }
  if (emptyTargets.length > 0) {
    console.log(`🟡 ${emptyTargets.length} target(s) live but empty: ${emptyTargets.join(', ')}`);
  }
  if (networkTargets.length > 0) {
    console.log(`\nNetwork errors (${networkTargets.length}):`);
    for (const e of networkTargets) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }
  if (otherErrors.length > 0) {
    console.log(`\nErrors (${otherErrors.length}):`);
    for (const e of otherErrors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (verifiedOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of verifiedOffers) {
      const trustSuffix = o.trustScore != null && o.trustScore < 100
        ? ` [Trust: ${o.trustScore}/100${o.trustFlags?.length ? ' — ' + o.trustFlags.join(', ') : ''}]`
        : '';
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}${trustSuffix}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
      console.log(`Immutable scan run: ${immutableRun.runDir}`);
    }
  } else if (!dryRun && immutableRun) {
    console.log(`\nImmutable empty scan run: ${immutableRun.runDir}`);
  } else if (terminalFailure) {
    console.error('\n❌ Scan failed: every attempted target was unavailable; no completed candidate run was created.');
  }

  // Persist this run's counters (#1604) — guarded exactly like the other
  // writes; a --dry-run must leave no trace.
  if (!dryRun && successfulTargets > 0) {
    await appendPortalHealth(healthRecords);
    appendScanRunSummary({
      timestamp: new Date().toISOString(), status: completionStatus,
      companies: summaryCompanies, boards: summaryBoards, found: totalFound,
      filteredTitle: totalFilteredTitle, filteredTier: totalFilteredTier,
      filteredLocation: totalFilteredLocation, filteredSalary: totalFilteredSalary,
      filteredContent: totalFilteredContent, filteredCooldown: totalFilteredCooldown,
      dupes: totalDupes, newAdded: verifiedOffers.length, errors: errors.length,
    });
  }

  if (terminalFailure) {
    process.exitCode = 1;
    return;
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

// Only run main() when invoked directly (`node scan.mjs`), not when imported by tests.
// `|| ''` guards the case where Node is invoked without a script arg (e.g. `node -e`).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
