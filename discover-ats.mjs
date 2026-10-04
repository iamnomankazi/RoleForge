#!/usr/bin/env node

/**
 * Resolve company names to live, scanner-readable ATS boards.
 *
 * The default is a preview. `--write` is the only option that appends to the
 * user-owned portals.yml, and it does so with a byte-preserving text splice
 * followed by the repository's atomic-write helper.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { writeFileAtomic } from './tracker-utils.mjs';
import { makeHttpCtx } from './providers/_http.mjs';
import greenhouse from './providers/greenhouse.mjs';
import ashby from './providers/ashby.mjs';
import lever from './providers/lever.mjs';
import workday from './providers/workday.mjs';
import workable from './providers/workable.mjs';
import smartrecruiters from './providers/smartrecruiters.mjs';
import recruitee from './providers/recruitee.mjs';
import breezy from './providers/breezy.mjs';
import bamboohr from './providers/bamboohr.mjs';
import pinpoint from './providers/pinpoint.mjs';
import rippling from './providers/rippling.mjs';
import joinProvider from './providers/join.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VENDOR_ORDER = Object.freeze([
  'gh', 'ashby', 'lever', 'workable', 'smartrecruiters', 'recruitee',
  'bamboohr', 'breezy', 'pinpoint', 'rippling', 'join',
]);
const DEFAULT_CONCURRENCY = 8;
const WORKDAY_INSTANCES = Object.freeze(['wd1', 'wd2', 'wd3', 'wd5', 'wd10', 'wd12', 'wd101', 'wd103']);
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const DNS_LABEL_RE = /^(?=.{1,63}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const WORKDAY_INSTANCE_RE = /^wd\d{1,3}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/i;
const WORKDAY_SITE_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_NAME_LENGTH = 200;
const INPUT_KEYS = new Set(['name', 'slug', 'website', 'careers_url', 'workday']);
const lower = (value) => String(value).toLowerCase();

const VENDORS = Object.freeze({
  gh: {
    id: 'greenhouse', provider: greenhouse, host: 'job-boards.greenhouse.io',
    buildUrl: (slug) => `https://job-boards.greenhouse.io/${slug}`,
    api: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
  },
  ashby: { id: 'ashby', provider: ashby, host: 'jobs.ashbyhq.com', buildUrl: (slug) => `https://jobs.ashbyhq.com/${slug}` },
  lever: { id: 'lever', provider: lever, host: 'jobs.lever.co', buildUrl: (slug) => `https://jobs.lever.co/${slug}` },
  workable: { id: 'workable', provider: workable, host: 'apply.workable.com', buildUrl: (slug) => `https://apply.workable.com/${slug}` },
  smartrecruiters: { id: 'smartrecruiters', provider: smartrecruiters, host: 'careers.smartrecruiters.com', buildUrl: (slug) => `https://careers.smartrecruiters.com/${slug}` },
  rippling: { id: 'rippling', provider: rippling, host: 'ats.rippling.com', buildUrl: (slug) => `https://ats.rippling.com/${slug}/jobs` },
  join: { id: 'join', provider: joinProvider, host: 'join.com', buildUrl: (slug) => `https://join.com/companies/${slug}` },
  recruitee: { id: 'recruitee', provider: recruitee, hostFor: (slug) => `${lower(slug)}.recruitee.com`, buildUrl: (slug) => `https://${lower(slug)}.recruitee.com` },
  breezy: { id: 'breezy', provider: breezy, hostFor: (slug) => `${lower(slug)}.breezy.hr`, buildUrl: (slug) => `https://${lower(slug)}.breezy.hr` },
  bamboohr: { id: 'bamboohr', provider: bamboohr, hostFor: (slug) => `${lower(slug)}.bamboohr.com`, buildUrl: (slug) => `https://${lower(slug)}.bamboohr.com` },
  pinpoint: { id: 'pinpoint', provider: pinpoint, hostFor: (slug) => `${lower(slug)}.pinpointhq.com`, buildUrl: (slug) => `https://${lower(slug)}.pinpointhq.com` },
});
const ALL_PROVIDERS = Object.freeze([...Object.values(VENDORS).map((vendor) => vendor.provider), workday]);

export const USAGE = `Usage:
  node discover-ats.mjs --in companies.yml            # preview; writes nothing
  node discover-ats.mjs --in companies.yml --write    # append confirmed boards to portals.yml
  node discover-ats.mjs Stripe Ramp Mollie            # company names as positional arguments
  node discover-ats.mjs --in companies.yml --vendors gh,ashby,lever
  node discover-ats.mjs --help

Input YAML is a companies: list with name and optional slug, website, or workday
hint. Workday requires a full HTTPS board URL or {tenant, site[, instance]}.
Only boards that return valid, nonempty jobs from their real provider are added.
Vendors are checked in this order: ${VENDOR_ORDER.join(', ')}, then Workday hints.
`;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertCompanyName(name, origin = 'company') {
  if (typeof name !== 'string') throw new TypeError(`${origin}: name must be a string`);
  const clean = name.trim();
  if (!clean || clean.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new TypeError(`${origin}: name must be nonempty, at most ${MAX_NAME_LENGTH} characters, and contain no control characters`);
  }
  return clean;
}

function explicitAuthorityHasPort(raw, parsed) {
  const match = /^https:\/\/([^/?#]+)/i.exec(raw);
  return !match || match[1].includes('@') || match[1].toLowerCase() !== parsed.hostname.toLowerCase();
}

function validateDisplayUrl(value, origin) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${origin} must be a nonempty HTTPS URL`);
  const raw = value.trim();
  const normalized = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try { parsed = new URL(normalized); } catch { throw new TypeError(`${origin} is not a valid URL`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || explicitAuthorityHasPort(normalized, parsed)) {
    throw new TypeError(`${origin} must use HTTPS and must not contain credentials or a port`);
  }
  if (!parsed.hostname || parsed.hostname.includes('..')) throw new TypeError(`${origin} has an invalid host`);
  return raw;
}

function validateSlug(slug, origin = 'slug') {
  if (typeof slug !== 'string' || slug.length < 1 || slug.length > 120 || !SLUG_RE.test(slug) || slug === '.' || slug === '..') {
    throw new TypeError(`${origin} must be 1–120 letters, digits, dots, underscores, or hyphens and cannot be a dot segment`);
  }
  return slug;
}

function validateWorkdayParts(tenant, site, instance, hasInstance) {
  if (typeof tenant !== 'string' || !DNS_LABEL_RE.test(tenant)) {
    throw new TypeError('Workday tenant must be one valid DNS label');
  }
  if (typeof site !== 'string' || !WORKDAY_SITE_RE.test(site) || site === '.' || site === '..') {
    throw new TypeError('Workday site must be one safe path segment');
  }
  if (hasInstance && (typeof instance !== 'string' || !WORKDAY_INSTANCE_RE.test(instance))) {
    throw new TypeError('Workday instance must be a valid wd-number instance such as wd5');
  }
  return { tenant: tenant.toLowerCase(), instance: hasInstance ? instance.toLowerCase() : null, site };
}

function parseWorkdayUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new TypeError('Workday URL must be a nonempty HTTPS board URL');
  const text = raw.trim();
  let parsed;
  try { parsed = new URL(text); } catch { throw new TypeError('Workday URL is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || explicitAuthorityHasPort(text, parsed)) {
    throw new TypeError('Workday URL must use HTTPS and must not contain credentials or a port');
  }
  if (parsed.search || parsed.hash) throw new TypeError('Workday URL cannot contain a query string or fragment');
  const host = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(wd\d{1,3}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?)\.myworkdayjobs\.com$/i.exec(parsed.hostname);
  if (!host) throw new TypeError('Workday URL host must be <tenant>.<instance>.myworkdayjobs.com');

  const rawPath = /^https:\/\/[^/?#]+([^?#]*)/i.exec(text)?.[1] || '';
  const rawSegments = rawPath.split('/').filter(Boolean);
  let segments;
  try { segments = rawSegments.map((part) => decodeURIComponent(part)); } catch { throw new TypeError('Workday URL path has invalid escaping'); }
  if (segments.some((part) => part === '.' || part === '..' || part.includes('/') || part.includes('\\') || !WORKDAY_SITE_RE.test(part))) {
    throw new TypeError('Workday URL path contains an unsafe segment');
  }

  let site;
  if (segments[0]?.toLowerCase() === 'wday' && segments[1]?.toLowerCase() === 'cxs') {
    if (segments.length < 4) throw new TypeError('Workday CXS URL must include a site segment');
    site = segments[3];
  } else {
    let siteIndex = 0;
    if (/^[a-z]{2}-[A-Z]{2}$/.test(segments[0] || '')) siteIndex = 1;
    site = segments[siteIndex];
  }
  return validateWorkdayParts(host[1], site, host[2], true);
}

/** Parse a strict full URL or explicit coordinate object; invalid explicit hints throw. */
export function parseWorkdayHint(company) {
  if (!isObject(company)) return null;
  if (Object.hasOwn(company, 'workday')) {
    const hint = company.workday;
    if (typeof hint === 'string') return parseWorkdayUrl(hint);
    if (!isObject(hint)) throw new TypeError('workday must be an HTTPS board URL or {tenant, site[, instance]}');
    const unknownKeys = Object.keys(hint).filter((key) => !['tenant', 'site', 'instance'].includes(key));
    if (unknownKeys.length) throw new TypeError(`Workday hint has unknown field(s): ${unknownKeys.join(', ')}`);
    const hasInstance = Object.hasOwn(hint, 'instance');
    return validateWorkdayParts(hint.tenant, hint.site, hint.instance, hasInstance);
  }

  for (const field of ['careers_url', 'website']) {
    const value = company[field];
    if (typeof value === 'string' && /myworkdayjobs\.com/i.test(value)) return parseWorkdayUrl(value);
  }
  return null;
}

export function deriveSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Parse a companies YAML input and positional names. Invalid input throws before probing or writing. */
export function parseCompanyInput(rawYaml, cliNames = []) {
  const byName = new Map();
  let entries = [];
  if (typeof rawYaml !== 'string') throw new TypeError('input YAML must be text');
  if (rawYaml.trim()) {
    let doc;
    try { doc = yaml.load(rawYaml); } catch (error) { throw new Error(`input YAML is malformed: ${error.message}`); }
    if (Array.isArray(doc)) entries = doc;
    else if (isObject(doc) && Array.isArray(doc.companies)) entries = doc.companies;
    else throw new TypeError('input YAML must contain a top-level companies list (or be a YAML list)');
  }

  const add = (raw, origin) => {
    if (typeof raw === 'string') raw = { name: raw };
    if (!isObject(raw)) throw new TypeError(`${origin} must be a company object or name string`);
    const unknownKeys = Object.keys(raw).filter((key) => !INPUT_KEYS.has(key));
    if (unknownKeys.length) throw new TypeError(`${origin} has unknown field(s): ${unknownKeys.join(', ')}`);
    const name = assertCompanyName(raw.name, origin);
    const entry = { name };
    if (Object.hasOwn(raw, 'slug')) entry.slug = validateSlug(raw.slug, `${origin} slug`);
    if (Object.hasOwn(raw, 'website')) entry.website = validateDisplayUrl(raw.website, `${origin} website`);
    if (Object.hasOwn(raw, 'careers_url')) entry.careers_url = validateDisplayUrl(raw.careers_url, `${origin} careers_url`);
    if (Object.hasOwn(raw, 'workday')) {
      entry.workday = raw.workday;
      entry.workdayCoordinates = parseWorkdayHint(entry);
    } else {
      entry.workdayCoordinates = parseWorkdayHint(entry);
    }
    const key = normalizeName(name);
    if (!byName.has(key)) byName.set(key, entry);
  };

  for (const [index, entry] of entries.entries()) add(entry, `input companies[${index}]`);
  if (!Array.isArray(cliNames)) throw new TypeError('company arguments must be an array');
  for (const [index, name] of cliNames.entries()) add(name, `argument ${index + 1}`);
  return [...byName.values()];
}

function normalizeName(value) {
  const normalized = String(value ?? '').trim().normalize('NFC').toLowerCase();
  const key = normalized.replace(/[^\p{L}\p{N}]+/gu, '');
  return key || normalized;
}

function safeHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port;
  } catch { return false; }
}

/** Build guarded URLs in stable provider order, and preflight each with its real detect() contract. */
export function buildCandidateUrls(company, vendors = VENDOR_ORDER) {
  const slug = company.slug || deriveSlug(company.name);
  const candidates = [];
  const skipped = [];
  const unsupported = [];
  for (const vendor of vendors) {
    const config = VENDORS[vendor];
    if (!config) continue;
    if (!SLUG_RE.test(slug) || slug === '.' || slug === '..' || slug.length > 120) {
      skipped.push(vendor);
      continue;
    }
    const careers_url = config.buildUrl(slug);
    let parsed;
    try { parsed = new URL(careers_url); } catch { skipped.push(vendor); continue; }
    const expectedHost = config.hostFor ? config.hostFor(slug) : config.host;
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
      || parsed.hostname !== expectedHost || explicitAuthorityHasPort(careers_url, parsed)) {
      skipped.push(vendor);
      continue;
    }
    const detected = config.provider.detect({ name: company.name, careers_url });
    if (!detected || typeof detected.url !== 'string' || !safeHttpsUrl(detected.url)) {
      unsupported.push(vendor);
      continue;
    }
    candidates.push({ vendor, slug, careers_url });
  }
  return { candidates, skipped, unsupported };
}

export function buildWorkdayCandidates(coords) {
  const validated = validateWorkdayParts(coords.tenant, coords.site, coords.instance, coords.instance !== null);
  const instances = validated.instance ? [validated.instance] : WORKDAY_INSTANCES;
  return instances.map((instance) => ({
    instance,
    careers_url: `https://${validated.tenant}.${instance}.myworkdayjobs.com/${validated.site}`,
  }));
}

function validJobCount(jobs) {
  if (!Array.isArray(jobs)) return { count: 0, invalid: true };
  if (jobs.length === 0) return { count: 0, invalid: false };
  let count = 0;
  for (const job of jobs) {
    if (!isObject(job) || typeof job.title !== 'string' || !job.title.trim() || typeof job.url !== 'string' || !safeHttpsUrl(job.url)) continue;
    count += 1;
  }
  return { count, invalid: count === 0 };
}

function errorStatus(error) {
  for (let current = error; current && typeof current === 'object'; current = current.cause) {
    if (Number.isInteger(current.status)) return current.status;
  }
  return undefined;
}

function refusedRedirect(error) {
  // providers/_http.mjs marks this condition explicitly. Do not infer it from
  // generic error text such as “redirect mode is set to error”.
  for (let current = error; current && typeof current === 'object'; current = current.cause) {
    if (current.redirectRefused === true || current.code === 'ECAREEROPS_REDIRECT_REFUSED') return true;
  }
  return false;
}

export function isDefinitiveAbsence(error) {
  return error?.httpStatus === 404 || error?.httpStatus === 410;
}

async function probeVendor(company, candidate, ctx) {
  const config = VENDORS[candidate.vendor];
  const entry = { name: company.name, careers_url: candidate.careers_url };
  const detected = config?.provider.detect(entry);
  if (!config || !detected || !safeHttpsUrl(detected.url)) {
    return { status: 'error', jobCount: 0, error: 'provider rejected the candidate URL' };
  }
  try {
    const jobs = await config.provider.fetch(entry, ctx);
    const validation = validJobCount(jobs);
    if (validation.invalid) return { status: 'error', jobCount: 0, error: 'provider returned no valid job records' };
    return { status: validation.count ? 'match' : 'empty', jobCount: validation.count };
  } catch (error) {
    const out = { status: 'error', jobCount: 0, error: error?.message || String(error) };
    const status = errorStatus(error);
    if (status !== undefined) out.httpStatus = status;
    if (refusedRedirect(error)) {
      out.refusedRedirect = true;
      out.error = `${out.error}${error?.cause?.message ? ` (${error.cause.message})` : ''}`;
    }
    return out;
  }
}

async function resolveWorkday(company, coords, ctx) {
  const candidates = buildWorkdayCandidates(coords);
  const probeCtx = { ...ctx, maxPages: 1 };
  const tried = [];
  const errors = [];
  let emptyUrl = null;
  for (const candidate of candidates) {
    tried.push(candidate.careers_url);
    const entry = { name: company.name, careers_url: candidate.careers_url };
    const detected = workday.detect(entry);
    if (!detected || !safeHttpsUrl(detected.url)) {
      errors.push({ careers_url: candidate.careers_url, error: 'Workday provider rejected the candidate URL' });
      continue;
    }
    try {
      const validation = validJobCount(await workday.fetch(entry, probeCtx));
      if (validation.count > 0) {
        return { resolved: { name: company.name, vendor: 'workday', provider: 'workday', slug: coords.tenant, careers_url: candidate.careers_url, jobCount: validation.count } };
      }
      if (validation.invalid) errors.push({ careers_url: candidate.careers_url, error: 'Workday provider returned no valid job records' });
      else if (!emptyUrl) emptyUrl = candidate.careers_url;
    } catch (error) {
      const detail = error?.message || String(error);
      const refused = refusedRedirect(error);
      const status = errorStatus(error);
      errors.push({
        careers_url: candidate.careers_url,
        error: refused && error?.cause?.message ? `${detail} (${error.cause.message})` : detail,
        ...(status !== undefined ? { httpStatus: status } : {}),
        ...(refused ? { refusedRedirect: true } : {}),
      });
    }
  }
  const refused = errors.some((error) => error.refusedRedirect === true);
  if (emptyUrl) return { status: 'empty', tried, careers_url: emptyUrl, errors, refusedRedirect: refused };
  return {
    status: 'error', tried,
    detail: errors.length ? errors[errors.length - 1].error : 'no valid Workday response',
    errors, refusedRedirect: refused,
  };
}

export async function resolveCompany(company, { vendors = VENDOR_ORDER, ctx, includeWorkday = true } = {}) {
  const { candidates, skipped, unsupported } = buildCandidateUrls(company, vendors);
  const triedVendors = [];
  const emptyBoards = [];
  const errors = [];
  for (const candidate of candidates) {
    triedVendors.push(candidate.vendor);
    const result = await probeVendor(company, candidate, ctx);
    if (result.status === 'match') {
      const config = VENDORS[candidate.vendor];
      const resolved = { name: company.name, vendor: config.id, slug: candidate.slug, careers_url: candidate.careers_url, jobCount: result.jobCount };
      if (config.api) resolved.api = config.api(candidate.slug);
      return { resolved };
    }
    // SmartRecruiters returns a successful empty response for arbitrary slugs.
    if (result.status === 'empty' && candidate.vendor === 'smartrecruiters') continue;
    if (result.status === 'empty') emptyBoards.push({ vendor: candidate.vendor, careers_url: candidate.careers_url });
    else {
      const error = { vendor: candidate.vendor, error: result.error };
      if (result.httpStatus !== undefined) error.httpStatus = result.httpStatus;
      if (result.refusedRedirect) error.refusedRedirect = true;
      if (isDefinitiveAbsence(result)) error.definitive = true;
      errors.push(error);
    }
  }

  const coords = includeWorkday ? (company.workdayCoordinates || parseWorkdayHint(company)) : null;
  if (coords) {
    triedVendors.push('workday');
    const result = await resolveWorkday(company, coords, ctx);
    if (result.resolved) return { resolved: result.resolved };
    if (result.status === 'empty') emptyBoards.push({ vendor: 'workday', careers_url: result.careers_url });
    if (Array.isArray(result.errors)) {
      errors.push(...result.errors.map((error) => ({ vendor: 'workday', ...error })));
    } else if (result.status === 'error' && result.detail) {
      errors.push({ vendor: 'workday', error: result.detail, ...(result.refusedRedirect ? { refusedRedirect: true } : {}) });
    }
  }

  const settled = (error) => isDefinitiveAbsence(error) || error.refusedRedirect === true;
  const workdayHintProvided = includeWorkday && (Object.hasOwn(company, 'workday')
    || ['careers_url', 'website'].some((field) => typeof company[field] === 'string' && /myworkdayjobs\.com/i.test(company[field])));
  let reason;
  if (errors.some((error) => error.refusedRedirect)) reason = 'a provider refused a redirect; the candidate board is unresolved, check the slug and retry';
  else if (emptyBoards.length) reason = 'board(s) returned a valid empty job list; re-run later or add a board manually';
  else if (errors.length && errors.some((error) => !settled(error))) reason = 'probe error(s) occurred; board status is unknown, see errors[] and re-run';
  else if (workdayHintProvided && !coords) reason = 'Workday hint was rejected; check tenant, site, instance, and URL';
  else if (coords) reason = 'Workday coordinates did not return a valid nonempty board';
  else if (!candidates.length && unsupported.length) reason = `slug is not supported by the probed providers (${unsupported.join(', ')}); nothing was probed`;
  else reason = 'no supported ATS board resolved; add an explicit Workday hint if applicable';

  const unresolved = { name: company.name, triedVendors, reason };
  if (skipped.length) unresolved.skippedUnsafeSlug = skipped;
  if (unsupported.length) unresolved.unsupportedSlugShape = unsupported;
  if (emptyBoards.length) unresolved.emptyBoards = emptyBoards;
  if (errors.length) unresolved.errors = errors;
  if (company.website) unresolved.website = company.website;
  return { unresolved };
}

async function parallelEach(items, limit, callback) {
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const current = index++;
      await callback(items[current], current);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function runDiscovery(companies, { vendors = VENDOR_ORDER, ctx, concurrency = DEFAULT_CONCURRENCY, includeWorkday = true } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new TypeError('concurrency must be an integer from 1 to 32');
  const results = new Array(companies.length);
  const httpCtx = ctx || makeHttpCtx();
  await parallelEach(companies, concurrency, async (company, index) => {
    results[index] = await resolveCompany(company, { vendors, ctx: httpCtx, includeWorkday });
  });
  return {
    resolved: results.flatMap((result) => result?.resolved ? [result.resolved] : []),
    unresolved: results.flatMap((result) => result?.unresolved ? [result.unresolved] : []),
  };
}

function yamlScalar(value) {
  const text = String(value ?? '');
  if (!text || /^[\s]|[\s]$/.test(text) || /[:#"'{}\[\],&*!|>%@`]/.test(text)) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return text;
}

export function renderPortalEntry(match, eol = '\n') {
  const lines = [`  - name: ${yamlScalar(match.name)}`, `    careers_url: ${match.careers_url}`];
  if (match.api) lines.push(`    api: ${match.api}`);
  if (match.provider) lines.push(`    provider: ${match.provider}`);
  lines.push('    enabled: true');
  if (match.notes) lines.push(`    notes: ${yamlScalar(match.notes)}`);
  return lines.join(eol);
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname}`.replace(/\/$/, '');
  } catch { return value.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, ''); }
}

function entryUrlValues(entry) {
  const values = [];
  for (const key of ['careers_url', 'career_url', 'api', 'url', 'board_url', 'careers_urls', 'api_urls', 'aliases', 'url_aliases']) {
    const asApi = key === 'api' || key === 'api_urls';
    const value = entry?.[key];
    if (typeof value === 'string' && value.trim()) values.push({ value: value.trim(), asApi });
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item.trim()) values.push({ value: item.trim(), asApi });
    }
  }
  return values;
}

function boardKeys(entry) {
  const keys = new Set();
  const name = normalizeName(entry?.name);
  if (name) keys.add(`name:${name}`);
  for (const { value, asApi } of entryUrlValues(entry)) {
    const normalized = normalizeUrl(value);
    if (normalized) keys.add(`url:${normalized}`);
    for (const provider of ALL_PROVIDERS) {
      let detected = null;
      const probeEntry = { name: String(entry?.name || 'board'), careers_url: value, provider: entry?.provider };
      if (asApi) probeEntry.api = value;
      try { detected = provider.detect(probeEntry); } catch {}
      if (typeof detected?.url === 'string') {
        const api = normalizeUrl(detected.url);
        if (api) keys.add(`provider:${provider.id}:${api}`);
      }
    }
  }
  return keys;
}

export function dedupeAgainstPortals(matches, existingEntries) {
  const seen = new Set();
  for (const entry of existingEntries) for (const key of boardKeys(entry)) seen.add(key);
  const fresh = [];
  const duplicates = [];
  for (const match of matches) {
    const keys = boardKeys(match);
    if ([...keys].some((key) => seen.has(key))) {
      duplicates.push(match);
    } else {
      fresh.push(match);
      for (const key of keys) seen.add(key);
    }
  }
  return { fresh, duplicates };
}

function parsePortalsText(fileText, pathLabel = 'portals.yml') {
  let parsed;
  try { parsed = yaml.load(fileText); } catch (error) { throw new Error(`${pathLabel} is malformed: ${error.message}`); }
  if (!isObject(parsed)) throw new TypeError(`${pathLabel} must be a YAML mapping`);
  for (const key of ['tracked_companies', 'job_boards']) {
    if (Object.hasOwn(parsed, key) && !Array.isArray(parsed[key])) throw new TypeError(`${pathLabel} ${key} must be a list when present`);
    if (Array.isArray(parsed[key])) {
      for (const [index, entry] of parsed[key].entries()) {
        if (!isObject(entry)) throw new TypeError(`${pathLabel} ${key}[${index}] must be a mapping`);
        if (Object.hasOwn(entry, 'name') && (typeof entry.name !== 'string' || !entry.name.trim())) {
          throw new TypeError(`${pathLabel} ${key}[${index}].name must be a nonempty string`);
        }
      }
    }
  }
  return parsed;
}

function topLevelKeyIndex(text, startAt) {
  const tail = text.slice(startAt);
  const match = /^(?![ \t#])[A-Za-z_][A-Za-z0-9_-]*:[^\r\n]*(?:\r?\n|$)/m.exec(tail);
  return match ? startAt + match.index : text.length;
}

/** Insert entries into tracked_companies without serializing or reformatting YAML. */
export function insertIntoTrackedCompanies(fileText, snippets) {
  if (!snippets.length) return fileText;
  const eol = fileText.includes('\r\n') ? '\r\n' : '\n';
  const block = snippets.join(eol);
  const header = /^tracked_companies:[ \t]*(\[\])?[ \t]*(?:#.*)?$/m.exec(fileText);
  if (!header) {
    const separator = fileText.endsWith(eol) ? eol : `${eol}${eol}`;
    const prefix = fileText ? `${fileText}${separator}` : '';
    return `${prefix}tracked_companies:${eol}${block}${eol}`;
  }

  const headerStart = header.index;
  const lineEnd = fileText.indexOf('\n', headerStart);
  const afterHeader = lineEnd === -1 ? fileText.length : lineEnd + 1;
  if (header[1] === '[]') {
    const contentEnd = lineEnd === -1 ? fileText.length : (fileText[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd);
    const line = fileText.slice(headerStart, contentEnd);
    const replaced = line.replace(/\[\]/, '');
    const base = fileText.slice(0, headerStart) + replaced;
    const suffix = lineEnd === -1 ? '' : fileText.slice(lineEnd + 1);
    return `${base}${eol}${block}${eol}${suffix}`;
  }

  const sectionEnd = topLevelKeyIndex(fileText, afterHeader);
  const before = fileText.slice(0, sectionEnd);
  const after = fileText.slice(sectionEnd);
  const prefix = before.endsWith(eol) || !before ? before : `${before}${eol}`;
  return `${prefix}${block}${eol}${after}`;
}

function loadPortals(path, { required, exists = existsSync, readFile = readFileSync } = {}) {
  if (!exists(path)) {
    if (required) throw new Error(`portals.yml is required for --write: ${path}`);
    return { text: null, parsed: { tracked_companies: [], job_boards: [] } };
  }
  let text;
  try { text = readFile(path, 'utf8'); } catch (error) { throw new Error(`cannot read portals.yml at ${path}: ${error.message}`); }
  return { text, parsed: parsePortalsText(text, path) };
}

function verifyUpdatedPortals(text, path, matches) {
  const parsed = parsePortalsText(text, path);
  const entries = Array.isArray(parsed.tracked_companies) ? parsed.tracked_companies : [];
  for (const match of matches) {
    const exists = entries.some((entry) => normalizeName(entry.name) === normalizeName(match.name)
      || [...boardKeys(entry)].some((key) => boardKeys(match).has(key)));
    if (!exists) throw new Error(`updated portals.yml did not retain the new board for ${match.name}`);
  }
  return parsed;
}

/** Injectable end-to-end runner used by the CLI and deterministic tests. */
export async function runDiscoverAts({
  rawInput = '', cliNames = [], vendors = VENDOR_ORDER, includeWorkday = true,
  write = false, portalsPath = process.env.CAREER_OPS_PORTALS || join(ROOT, 'portals.yml'),
  discover = runDiscovery, exists = existsSync, readFile = readFileSync,
  atomicWrite = writeFileAtomic, concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  if (typeof write !== 'boolean') throw new TypeError('write must be a boolean');
  if (typeof portalsPath !== 'string' || !portalsPath.trim()) throw new TypeError('portalsPath must be a nonempty path');
  if (typeof discover !== 'function' || typeof exists !== 'function' || typeof readFile !== 'function' || typeof atomicWrite !== 'function') {
    throw new TypeError('discover and filesystem dependencies must be functions');
  }
  if (!Array.isArray(vendors) || vendors.some((vendor) => !VENDOR_ORDER.includes(vendor))) throw new TypeError('vendors must be supported slug vendors');
  if (typeof includeWorkday !== 'boolean') throw new TypeError('includeWorkday must be a boolean');
  const companies = parseCompanyInput(rawInput, cliNames);
  const initial = loadPortals(portalsPath, { required: write, exists, readFile });
  if (companies.length === 0) {
    return { metadata: { resolved: 0, unresolved: 0, duplicatesSkipped: 0, fresh: 0, freshWritten: 0, written: false, previewOnly: true, portalsPath }, resolved: [], unresolved: [], pendingEntries: '' };
  }

  const discovery = await discover(companies, { vendors, includeWorkday, concurrency });
  if (!discovery || !Array.isArray(discovery.resolved) || !Array.isArray(discovery.unresolved)) {
    throw new TypeError('discovery runner must return resolved and unresolved arrays');
  }
  const resolved = discovery.resolved;
  const unresolved = discovery.unresolved;
  let active = initial;
  if (write) active = loadPortals(portalsPath, { required: true, exists, readFile });
  const existing = [...(Array.isArray(active.parsed.tracked_companies) ? active.parsed.tracked_companies : []),
    ...(Array.isArray(active.parsed.job_boards) ? active.parsed.job_boards : [])];
  const { fresh, duplicates } = dedupeAgainstPortals(resolved, existing);
  const eol = active.text?.includes('\r\n') ? '\r\n' : '\n';
  const snippets = fresh.map((match) => renderPortalEntry(match, eol));
  let written = false;
  if (write && fresh.length) {
    if (active.text === null) throw new Error(`portals.yml is required for --write: ${portalsPath}`);
    const updated = insertIntoTrackedCompanies(active.text, snippets);
    verifyUpdatedPortals(updated, portalsPath, fresh);
    atomicWrite(portalsPath, updated);
    written = true;
  }

  return {
    metadata: {
      resolved: resolved.length, unresolved: unresolved.length, duplicatesSkipped: duplicates.length,
      fresh: fresh.length, freshWritten: written ? fresh.length : 0,
      written, previewOnly: !written, portalsPath,
    },
    resolved, unresolved, pendingEntries: written ? '' : snippets.join(eol),
  };
}

export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  const args = argv.slice(2);
  const knownFlags = new Set(['--in', '--vendors', '--write', '--dry-run', '--summary', '--help', '-h']);
  const values = new Map();
  const positional = [];
  let write = false;
  let dryRun = false;
  let summary = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--write') { write = true; continue; }
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--summary') { summary = true; continue; }
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    const equalIndex = arg.indexOf('=');
    const flag = equalIndex > 0 ? arg.slice(0, equalIndex) : arg;
    if (arg.startsWith('-') && !knownFlags.has(flag)) throw new Error(`unrecognized flag: ${arg}`);
    if (flag === '--in' || flag === '--vendors') {
      if (values.has(flag)) throw new Error(`${flag} may be specified only once`);
      let value = equalIndex > 0 ? arg.slice(equalIndex + 1) : args[++index];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) throw new Error(`${flag} requires a value`);
      values.set(flag, value.trim());
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unrecognized flag: ${arg}`);
    positional.push(arg);
  }
  if (write && dryRun) throw new Error('--write and --dry-run cannot be combined');

  const requested = values.has('--vendors') ? values.get('--vendors').split(',').map((value) => value.trim().toLowerCase()) : [...VENDOR_ORDER, 'workday'];
  const valid = new Set([...VENDOR_ORDER, 'workday']);
  if (!requested.length || requested.some((value) => !value)) throw new Error('--vendors must list at least one vendor');
  const invalid = requested.filter((value) => !valid.has(value));
  if (invalid.length) throw new Error(`unknown vendor(s): ${invalid.join(', ')}`);
  if (new Set(requested).size !== requested.length) throw new Error('--vendors cannot repeat a vendor');
  if (!help && !values.has('--in') && positional.length === 0) throw new Error('provide --in <file> or at least one company name');
  return {
    inPath: values.get('--in') || null,
    vendors: requested.filter((value) => VENDORS[value]),
    includeWorkday: requested.includes('workday'),
    write, summary, help, names: positional,
  };
}

function printSummary(result) {
  const { resolved, unresolved, metadata } = result;
  console.log(`ATS discovery: ${resolved.length} resolved, ${unresolved.length} unresolved, ${metadata.duplicatesSkipped} duplicates`);
  for (const board of resolved) console.log(`  ${board.name}: ${board.vendor} (${board.jobCount} jobs) ${board.careers_url}`);
  for (const company of unresolved) console.log(`  ${company.name}: ${company.reason}`);
  if (result.pendingEntries) console.log(`\nPending portals.yml entries:\n${result.pendingEntries}`);
}

export async function main(argv = process.argv) {
  const options = parseArgs(argv);
  if (options.help) { console.log(USAGE); return 0; }
  let rawInput = '';
  if (options.inPath) {
    const inputPath = resolve(process.cwd(), options.inPath);
    try { rawInput = readFileSync(inputPath, 'utf8'); } catch (error) { throw new Error(`cannot read input file ${options.inPath}: ${error.message}`); }
  }
  const result = await runDiscoverAts({
    rawInput, cliNames: options.names, vendors: options.vendors, includeWorkday: options.includeWorkday,
    write: options.write,
  });
  if (options.summary) printSummary(result);
  else console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`discover-ats: ${error?.stack || error?.message || error}`);
    process.exitCode = 1;
  });
}
