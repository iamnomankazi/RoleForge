// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { requiredArray, requireUsableRows } from './_payload.mjs';
import { markProviderCoverage } from './_result.mjs';

// Welcome to the Jungle exposes the anonymous Algolia configuration through a
// small public endpoint.  The values are intentionally discovered on every
// run: both the application/search key and (occasionally) the index name are
// deployment data and may rotate.  Nothing in this provider is an API secret.
const ENV_URL = 'https://www.welcometothejungle.com/api/env';
const SITE_ORIGIN = 'https://www.welcometothejungle.com';
const ENV_HOST = 'www.welcometothejungle.com';
const DEFAULT_MAX_HITS = 100;
const MAX_HITS_CAP = 200;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 50;
const DEFAULT_MAX_JOBS = 1000;
const MAX_JOBS_CAP = 2000;
const MAX_HITS_PER_PAGE = MAX_HITS_CAP;
// The current public /api/env omits a jobs index while the live frontend and
// local provider history both use this stable production index.  Keep it only
// as a narrow compatibility fallback: a runtime-provided jobs index wins, and
// malformed supplied values still fail closed.
export const WTTJ_JOBS_INDEX_FALLBACK = 'wttj_jobs_production_en';

const INDEX_KEYS = [
  'PUBLIC_ALGOLIA_JOBS_INDEX',
  'PUBLIC_ALGOLIA_JOB_INDEX',
  'PUBLIC_ALGOLIA_SEARCH_INDEX',
  'PUBLIC_ALGOLIA_INDEX',
];
const HOST_KEYS = [
  'PUBLIC_ALGOLIA_HOST',
  'PUBLIC_ALGOLIA_SEARCH_HOST',
  'PUBLIC_ALGOLIA_DSN',
];

/**
 * Pin a provider URL to one exact HTTPS host.  Rejecting ports, credentials,
 * and host suffix tricks keeps all requests inside the intended origin.
 *
 * @param {string} url
 * @param {string} host
 * @param {string} label
 */
export function assertHost(url, host, label = 'provider') {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`wttj: invalid ${label} URL`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`wttj: ${label} URL must use HTTPS`);
  if (parsed.hostname.toLowerCase() !== String(host).toLowerCase()
      || parsed.port || parsed.username || parsed.password) {
    throw new Error(`wttj: untrusted ${label} hostname`);
  }
  return url;
}

function cleanText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const cleaned = cleanText(value);
    if (cleaned) return cleaned;
  }
  return '';
}

/**
 * Extract a JSON object from `window.env = {...}` without evaluating script.
 * The scanner handles braces in quoted strings and escaped quotes, which keeps
 * malformed/drifted endpoint payloads fail-closed rather than truncating them.
 *
 * @param {string} text
 * @returns {string}
 */
function extractObject(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('wttj: /api/env payload has no JSON object');

  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      // JSON itself only permits double quotes.  Tracking single quotes here
      // makes the error below deterministic for a JS-looking drift payload.
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
      if (depth < 0) break;
    }
  }
  throw new Error('wttj: /api/env payload has an incomplete JSON object');
}

/**
 * Read one of the documented public env fields, including a small number of
 * nested forms used by older deployments.  Values are returned only when they
 * are strings; objects/arrays are never stringified into request material.
 *
 * @param {Record<string, any>} env
 * @param {string[]} keys
 */
function envString(env, keys) {
  for (const key of keys) {
    if (typeof env?.[key] === 'string' && env[key].trim()) return env[key].trim();
  }
  for (const parent of [env?.algolia, env?.ALGOLIA, env?.public?.algolia, env?.PUBLIC_ALGOLIA]) {
    if (!parent || typeof parent !== 'object') continue;
    for (const key of keys) {
      if (typeof parent[key] === 'string' && parent[key].trim()) return parent[key].trim();
      const lower = key.toLowerCase();
      if (typeof parent[lower] === 'string' && parent[lower].trim()) return parent[lower].trim();
    }
  }
  return '';
}

function envHasKey(env, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(env || {}, key)) return true;
  }
  for (const parent of [env?.algolia, env?.ALGOLIA, env?.public?.algolia, env?.PUBLIC_ALGOLIA]) {
    if (!parent || typeof parent !== 'object') continue;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(parent, key)
          || Object.prototype.hasOwnProperty.call(parent, key.toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * Parse the public `/api/env` response and validate every value needed for a
 * search.  The returned object intentionally contains no raw payload.
 *
 * @param {string} text
 * @returns {{appId: string, apiKey: string, index: string, host: string}}
 */
export function parseEnvPayload(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('wttj: /api/env payload is empty');
  }
  let env;
  try {
    env = JSON.parse(extractObject(text));
  } catch (error) {
    if (error instanceof Error && /^wttj: \/api\/env payload/.test(error.message)) throw error;
    throw new Error('wttj: /api/env payload is not valid JSON');
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('wttj: /api/env payload must be an object');
  }

  const appId = envString(env, ['PUBLIC_ALGOLIA_APPLICATION_ID', 'applicationId', 'appId']);
  if (!/^[A-Za-z0-9]{6,32}$/.test(appId)) {
    throw new Error('wttj: /api/env payload is missing a valid Algolia application id');
  }

  const apiKey = envString(env, [
    'PUBLIC_ALGOLIA_API_KEY_CLIENT',
    'PUBLIC_ALGOLIA_SEARCH_API_KEY',
    'apiKey',
    'searchKey',
  ]);
  // Search-only Algolia keys are normally 32 characters.  Keep a lower bound
  // so a placeholder/HTML value cannot become an outbound credential, while
  // allowing future secured-key formats.
  if (apiKey.length < 16 || apiKey.length > 500) {
    throw new Error('wttj: /api/env payload is missing a valid Algolia search key');
  }

  const configuredIndex = envString(env, INDEX_KEYS)
    || envString(env, ['jobsIndex', 'jobIndex', 'indexName']);
  const indexConfigured = envHasKey(env, [...INDEX_KEYS, 'jobsIndex', 'jobIndex', 'indexName']);
  if (indexConfigured && !configuredIndex) {
    throw new Error('wttj: /api/env payload has an invalid Algolia jobs index');
  }
  const index = configuredIndex || WTTJ_JOBS_INDEX_FALLBACK;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/.test(index)) {
    throw new Error('wttj: /api/env payload is missing a valid Algolia jobs index');
  }

  const configuredHost = envString(env, HOST_KEYS);
  // Preserve the app-id's wire casing for deterministic request fixtures;
  // hostname validation remains case-insensitive per URL semantics.
  const host = `${appId}-dsn.algolia.net`;
  if (configuredHost) {
    let parsed;
    try {
      parsed = new URL(configuredHost.includes('://') ? configuredHost : `https://${configuredHost}`);
    } catch {
      throw new Error('wttj: /api/env payload has an invalid Algolia host');
    }
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== host
        || parsed.port || parsed.username || parsed.password || parsed.pathname !== '/') {
      throw new Error('wttj: /api/env payload has an untrusted Algolia host');
    }
  }
  return { appId, apiKey, index, host };
}

/**
 * Strip the small HTML fragments that occur in WTTJ descriptions while
 * retaining plain text.  This is deliberately local and bounded; no detail
 * endpoint is followed for a list result.
 *
 * @param {unknown} value
 */
export function stripDescription(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return value
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number < 1_000_000_000_000 ? number * 1000 : number;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function isFulltimeRemote(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase().replace(/[ _-]+/g, '');
  return normalized === 'fulltime' || normalized === 'remote' || normalized === 'fullyremote';
}

function safeSlug(value) {
  const slug = cleanText(value);
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(slug) ? slug : '';
}

function firstOffice(hit) {
  if (Array.isArray(hit?.offices) && hit.offices.length > 0 && hit.offices[0] && typeof hit.offices[0] === 'object') {
    return hit.offices[0];
  }
  return hit?.office && typeof hit.office === 'object' ? hit.office : null;
}

/**
 * Normalize one Algolia jobs hit.  WTTJ's list contract requires a title and
 * both organization/job slugs; malformed hits are dropped by design.
 *
 * @param {any} hit
 * @returns {Record<string, any> | null}
 */
export function normalizeWttjHit(hit) {
  if (!hit || typeof hit !== 'object') return null;
  // Preserve the WTTJ list-page survival contract: title and path slugs come
  // from the canonical Algolia fields (`name`, `slug`, and nested
  // `organization.slug`).  Additional metadata may widen, but cannot turn a
  // structurally incomplete hit into a job.
  const title = cleanText(hit.name);
  const slug = safeSlug(hit.slug);
  const organization = hit.organization && typeof hit.organization === 'object' ? hit.organization : {};
  const organizationSlug = safeSlug(organization.slug);
  if (!title || !slug || !organizationSlug) return null;

  const url = `${SITE_ORIGIN}/en/companies/${encodeURIComponent(organizationSlug)}/jobs/${encodeURIComponent(slug)}`;
  const company = firstNonEmpty(organization.name, hit.company_name, hit.company) || 'Welcome to the Jungle';
  const office = firstOffice(hit);
  const locationParts = [];
  if (office) {
    const city = firstNonEmpty(office.city, office.name);
    const country = firstNonEmpty(office.country, office.country_code, office.countryCode);
    if (city) locationParts.push(city);
    if (country && !locationParts.includes(country)) locationParts.push(country);
  }
  if (locationParts.length === 0) {
    const location = firstNonEmpty(hit.location, hit.location_name, hit.locationName);
    if (location) locationParts.push(location);
  }
  if (isFulltimeRemote(hit.remote) && !locationParts.some((part) => part.toLowerCase() === 'remote')) {
    locationParts.push('Remote');
  }

  /** @type {Record<string, any>} */
  const job = {
    title,
    url,
    company,
    location: locationParts.join(', '),
  };

  const sourceId = firstNonEmpty(hit.objectID, hit.reference, hit.id, hit.job_id, hit.jobId);
  if (sourceId) job.sourceId = sourceId;

  const postedAt = normalizeTimestamp(
    hit.published_at_timestamp ?? hit.publishedAtTimestamp ?? hit.published_at ?? hit.publishedAt,
  );
  if (postedAt !== undefined) job.postedAt = postedAt;

  const description = stripDescription(firstNonEmpty(
    hit.description,
    hit.description_html,
    hit.descriptions?.en,
    hit.descriptions?.['en-US'],
    organization.descriptions?.en,
  ));
  if (description) job.description = description;

  const min = normalizeNumber(hit.salary_yearly_minimum ?? hit.salary_minimum ?? hit.salaryMin);
  let max = normalizeNumber(hit.salary_yearly_maximum ?? hit.salary_maximum ?? hit.salaryMax);
  if (hit.salary_period && cleanText(hit.salary_period).toLowerCase() !== 'yearly') max = undefined;
  if (min !== undefined || max !== undefined) {
    job.salary = {
      min: min ?? max,
      max: max ?? min,
      currency: firstNonEmpty(hit.salary_currency, hit.salary_currency_code, hit.currency).toUpperCase(),
    };
  }
  return job;
}

function sourceIdentity(job) {
  return job.sourceId ? `id:${job.sourceId}` : `url:${job.url}`;
}

function rawIdentity(hit) {
  if (!hit || typeof hit !== 'object') return JSON.stringify(hit);
  const id = firstNonEmpty(hit.objectID, hit.reference, hit.id, hit.job_id, hit.jobId);
  if (id) return `id:${id}`;
  try { return `raw:${JSON.stringify(hit)}`; } catch { return 'raw:[unserializable]'; }
}

function sourceSearchUrl(query) {
  return `${SITE_ORIGIN}/en/jobs?query=${encodeURIComponent(query)}`;
}

function addProvenance(job, query) {
  job.sourceQuery = query;
  job.sourceQueries = [query];
  job.sourceUrl = sourceSearchUrl(query);
  return job;
}

function mergeProvenance(existing, incoming) {
  const queries = [
    ...(Array.isArray(existing.sourceQueries) ? existing.sourceQueries : []),
    ...(Array.isArray(incoming.sourceQueries) ? incoming.sourceQueries : []),
  ].filter((query, index, values) => typeof query === 'string' && query && values.indexOf(query) === index);
  if (queries.length > 0) {
    existing.sourceQueries = queries;
    existing.sourceQuery = existing.sourceQuery || queries[0];
  }
  if (!existing.description && incoming.description) existing.description = incoming.description;
  if (!existing.salary && incoming.salary) existing.salary = incoming.salary;
  if (existing.postedAt === undefined && incoming.postedAt !== undefined) existing.postedAt = incoming.postedAt;
  if (!existing.sourceId && incoming.sourceId) existing.sourceId = incoming.sourceId;
  return existing;
}

function dedupeQueries(value) {
  const queries = [];
  const seen = new Set();
  if (!Array.isArray(value)) return queries;
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const query = candidate.trim();
    const key = query.toLocaleLowerCase('en');
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
  }
  return queries;
}

/**
 * Resolve strict provider configuration.  A WTTJ board is global; silently
 * scanning the first arbitrary page would produce misleading results.
 */
export function resolveConfig(entry, ctx = {}) {
  const cfg = entry?.wttj && typeof entry.wttj === 'object' ? entry.wttj : {};
  const queries = dedupeQueries(cfg.queries);
  if (queries.length === 0) {
    throw new Error('wttj: configure explicit non-empty searches via `wttj: { queries: ["…"] }`');
  }
  const configuredHits = positiveInteger(cfg.max_hits);
  const maxHits = Math.min(configuredHits || DEFAULT_MAX_HITS, MAX_HITS_CAP);
  const configuredPages = positiveInteger(cfg.max_pages) || positiveInteger(entry?.max_pages) || DEFAULT_MAX_PAGES;
  const pageCap = Math.min(configuredPages, MAX_PAGES_CAP);
  const contextCap = positiveInteger(ctx?.maxPages);
  const maxPages = contextCap ? Math.min(pageCap, contextCap) : pageCap;
  const configuredJobs = positiveInteger(cfg.max_jobs) || positiveInteger(entry?.max_jobs);
  const maxJobs = Math.min(configuredJobs || Math.max(DEFAULT_MAX_JOBS, queries.length * maxHits), MAX_JOBS_CAP);
  return { queries, maxHits, maxPages, maxJobs };
}

function buildAlgoliaRequest(config, query, page, hitsPerPage) {
  const params = new URLSearchParams({
    query,
    hitsPerPage: String(hitsPerPage),
    page: String(page),
    attributesToRetrieve: [
      'name', 'title', 'slug', 'organization', 'organization_slug',
      'company_name', 'offices', 'office', 'location', 'remote',
      'published_at_timestamp', 'published_at', 'salary_yearly_minimum',
      'salary_yearly_maximum', 'salary_period', 'salary_currency',
      'description', 'descriptions', 'objectID', 'reference',
    ].join(','),
  });
  const url = assertHost(
    `https://${config.host}/1/indexes/${encodeURIComponent(config.index)}/query`,
    config.host,
    'algolia',
  );
  return {
    url,
    options: {
      method: 'POST',
      redirect: 'error',
      headers: {
        'x-algolia-application-id': config.appId,
        'x-algolia-api-key': config.apiKey,
        referer: `${SITE_ORIGIN}/`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ params: params.toString() }),
    },
  };
}

function searchResult(payload) {
  if (payload && typeof payload === 'object' && Array.isArray(payload.hits)) return payload;
  // Some deployments use Algolia's multi-query envelope even for one index.
  // Accept exactly one result so an unexpected fan-out cannot silently merge
  // unrelated indexes into the provider output.
  if (payload && typeof payload === 'object' && Array.isArray(payload.results)
      && payload.results.length === 1 && payload.results[0]
      && typeof payload.results[0] === 'object' && Array.isArray(payload.results[0].hits)) {
    return payload.results[0];
  }
  throw new Error('wttj: unexpected Algolia response — expected { hits: [...] }');
}

/** @type {Provider} */
export default {
  id: 'wttj',

  detect(entry) {
    return entry?.provider === 'wttj' ? { url: SITE_ORIGIN } : null;
  },

  async fetch(entry, ctx) {
    const { queries, maxHits, maxPages, maxJobs } = resolveConfig(entry, ctx);
    if (typeof ctx?.fetchText !== 'function' || typeof ctx?.fetchJson !== 'function') {
      throw new Error('wttj: HTTP context must provide fetchText and fetchJson');
    }

    const envText = await ctx.fetchText(assertHost(ENV_URL, ENV_HOST, 'env'), { redirect: 'error' });
    const config = parseEnvPayload(envText);
    const hitsPerPage = Math.min(maxHits, MAX_HITS_PER_PAGE);
    const jobsByIdentity = new Map();
    const pageSignaturesByQuery = new Map();
    let jobsFetched = 0;
    let partialCoverage = null;
    let completedQueries = 0;

    for (const query of queries) {
      if (jobsFetched >= maxJobs) {
        partialCoverage = {
          status: 'partial',
          code: 'max_jobs',
          reason: `${entry?.name || 'WTTJ'} truncated at max_jobs=${maxJobs}`,
          maxPages,
        };
        break;
      }
      const seenPageSignatures = pageSignaturesByQuery.get(query) || new Set();
      pageSignaturesByQuery.set(query, seenPageSignatures);
      let queryPages = 0;
      let reportedPages;
      let stoppedByEnd = false;

      // max_hits is the bounded page size (matching WTTJ's Algolia client),
      // while max_jobs limits aggregate retrieval across all pages/queries.
      for (let page = 0; page < maxPages && jobsFetched < maxJobs; page += 1) {
        const remaining = Math.min(maxHits, maxJobs - jobsFetched);
        const request = buildAlgoliaRequest(config, query, page, Math.min(hitsPerPage, remaining));
        const payload = await ctx.fetchJson(request.url, request.options);
        const json = searchResult(payload);
        const hits = requiredArray(json, 'hits', `wttj query ${page + 1}`);
        const rows = hits.slice(0, remaining);
        const signature = rows.map(rawIdentity).join('\u0001');
        if (seenPageSignatures.has(signature)) break;
        seenPageSignatures.add(signature);
        queryPages += 1;
        jobsFetched += rows.length;
        reportedPages = positiveInteger(json.nbPages);

        const normalized = rows.map(normalizeWttjHit).filter(Boolean);
        requireUsableRows(rows, normalized, `wttj query ${query}`);
        for (const normalizedJob of normalized) {
          const incoming = addProvenance(normalizedJob, query);
          const identity = sourceIdentity(incoming);
          const existing = jobsByIdentity.get(identity);
          if (existing) mergeProvenance(existing, incoming);
          else jobsByIdentity.set(identity, incoming);
        }

        if (rows.length === 0 || rows.length < Math.min(hitsPerPage, remaining)) {
          stoppedByEnd = true;
          break;
        }
        if (reportedPages !== undefined && page + 1 >= reportedPages) {
          stoppedByEnd = true;
          break;
        }
      }

      completedQueries += 1;
      if (!stoppedByEnd && queryPages >= maxPages && reportedPages !== undefined && queryPages < reportedPages) {
        partialCoverage = {
          status: 'partial',
          code: 'max_pages',
          reason: `${entry?.name || 'WTTJ'} truncated at max_pages=${maxPages} (${reportedPages} pages for query "${query}")`,
          pagesFetched: queryPages,
          maxPages,
          totalPages: reportedPages,
        };
      }
      if (jobsFetched >= maxJobs && (!stoppedByEnd || completedQueries < queries.length)) {
        partialCoverage = {
          status: 'partial',
          code: 'max_jobs',
          reason: `${entry?.name || 'WTTJ'} truncated at max_jobs=${maxJobs}`,
          maxPages,
        };
        break;
      }
    }

    const jobs = [...jobsByIdentity.values()];
    return partialCoverage ? markProviderCoverage(jobs, partialCoverage) : jobs;
  },
};
