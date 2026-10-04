// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { requireUsableRows } from './_payload.mjs';

// Himalayas provider - targeted search plus a bounded board-wide latest feed.
// Browse (https://himalayas.app/jobs/api) uses offset pagination; search
// (https://himalayas.app/jobs/api/search) uses q + 1-based page pagination.
// The API currently caps the effective page size at 20, so neither path
// assumes that a requested page size was honoured. All title, seniority,
// experience, and location gating remains local to Career-Ops.
//
// Wire in via a `job_boards:` entry with `provider: himalayas`.

const FEED_URL = 'https://himalayas.app/jobs/api?limit=50';
const SEARCH_URL = 'https://himalayas.app/jobs/api/search';
const TRUSTED_HOST = 'himalayas.app';
const REQUEST_LIMIT = 50;
const DEFAULT_MAX_PAGES = 15;
const MAX_PAGES_CAP = 50;
const DEFAULT_MAX_JOBS = 300;
const MAX_JOBS_CAP = 1000;
const DEFAULT_SEARCH_MAX_PAGES = 2;
const MAX_SEARCH_PAGES_CAP = 10;
const DEFAULT_SEARCH_MAX_JOBS = 400;
const MAX_SEARCH_JOBS_CAP = 1000;
const GENERIC_FEED_SOURCE_QUERY = 'generic-latest-feed';

// Keep the retrieval vocabulary in one place at the provider boundary. The
// actual user-facing list lives in the Himalayas job-board entry in
// portals.yml, alongside its daily caps; this export gives tests and callers
// one stable label for the mode without duplicating query strings in code.
export const HIMALAYAS_SEARCH_MODE = 'targeted-plus-generic';

/** @param {string} url */
function assertHimalayasUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`himalayas: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`himalayas: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`himalayas: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
  }
  return url;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => (typeof item === 'string' || typeof item === 'number' ? String(item).trim() : ''))
    .filter(Boolean);
}

function humanizeSlug(value) {
  return cleanText(value)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase());
}

function cleanHimalayasUrl(value) {
  const raw = cleanText(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const trusted = host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
    return parsed.protocol === 'https:' && trusted ? parsed.href : '';
  } catch {
    return '';
  }
}

function locationText(value) {
  if (!Array.isArray(value)) return '';
  return value
    .filter(v => typeof v === 'string' && v.trim())
    .map(v => v.trim())
    .join(', ');
}

// Himalayas pubDate is currently epoch seconds. Accept milliseconds and
// parseable date strings too so the parser survives small API shape changes.
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isUnavailable(item, expiresAt) {
  const status = cleanText(item.status ?? item.state).toLowerCase();
  if (['closed', 'expired', 'archived', 'unavailable'].includes(status)) return true;
  if (item.isExpired === true || item.expired === true || item.isClosed === true) return true;
  return expiresAt !== undefined && expiresAt <= Date.now();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function resolveMaxPages(entry, ctx) {
  const configured = positiveInteger(entry?.max_pages) || DEFAULT_MAX_PAGES;
  const capped = Math.min(configured, MAX_PAGES_CAP);
  const contextCap = positiveInteger(ctx?.maxPages);
  return contextCap ? Math.min(capped, contextCap) : capped;
}

function resolveMaxJobs(entry) {
  const configured = positiveInteger(entry?.max_jobs) || DEFAULT_MAX_JOBS;
  return Math.min(configured, MAX_JOBS_CAP);
}

function resolveSearchMaxPages(entry, ctx) {
  const configured = positiveInteger(entry?.search_max_pages) || DEFAULT_SEARCH_MAX_PAGES;
  const capped = Math.min(configured, MAX_SEARCH_PAGES_CAP);
  const contextCap = positiveInteger(ctx?.maxPages);
  return contextCap ? Math.min(capped, contextCap) : capped;
}

function resolveSearchMaxJobs(entry) {
  const configured = positiveInteger(entry?.search_max_jobs) || DEFAULT_SEARCH_MAX_JOBS;
  return Math.min(configured, MAX_SEARCH_JOBS_CAP);
}

function normalizeSearchQueries(value) {
  const values = Array.isArray(value) ? value : [];
  const seen = new Set();
  const queries = [];
  for (const item of values) {
    const query = cleanText(typeof item === 'string' ? item : item?.query);
    const key = query.toLocaleLowerCase('en');
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
  }
  return queries;
}

function buildFeedUrl(offset, limit) {
  const url = new URL(FEED_URL);
  url.searchParams.set('limit', String(limit));
  if (offset > 0) url.searchParams.set('offset', String(offset));
  return assertHimalayasUrl(url.href);
}

function buildSearchUrl(query, page) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('page', String(page));
  return assertHimalayasUrl(url.href);
}

function rawJobKey(item) {
  if (!item || typeof item !== 'object') return JSON.stringify(item);
  const stableId = cleanText(item.id ?? item.jobId ?? item.job_id);
  if (stableId) return `id:${stableId}`;
  const url = cleanHimalayasUrl(item.applicationLink) || cleanHimalayasUrl(item.guid);
  if (url) return `url:${url}`;
  const title = cleanText(item.title);
  const company = cleanText(item.companyName) || cleanText(item.companySlug);
  return `fallback:${title}\u0000${company}\u0000${JSON.stringify(item)}`;
}

function normalizedJobIdentity(item, job) {
  const stableId = cleanText(item?.id ?? item?.jobId ?? item?.job_id);
  return stableId ? `id:${stableId}` : `url:${job.url}`;
}

function sourceQueryValues(job) {
  const values = [];
  if (Array.isArray(job?.sourceQueries)) values.push(...job.sourceQueries);
  if (typeof job?.sourceQuery === 'string') values.push(job.sourceQuery);
  return values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
}

function addSourceQuery(job, sourceQuery) {
  const queries = [...new Set([...sourceQueryValues(job), sourceQuery].filter(Boolean))];
  if (queries.length > 0) {
    job.sourceQueries = queries;
    job.sourceQuery = job.sourceQuery || queries[0];
  }
  return job;
}

function mergeHimalayasJobs(existing, incoming) {
  const mergedQueries = [...new Set([...sourceQueryValues(existing), ...sourceQueryValues(incoming)])];
  if (mergedQueries.length > 0) {
    existing.sourceQueries = mergedQueries;
    existing.sourceQuery = existing.sourceQuery || mergedQueries[0];
  }
  for (const field of ['seniority', 'locationRestrictions', 'timezoneRestrictions']) {
    if (Array.isArray(incoming[field])) {
      existing[field] = [...new Set([...(Array.isArray(existing[field]) ? existing[field] : []), ...incoming[field]])];
    }
  }
  if (!existing.location && incoming.location) existing.location = incoming.location;
  if (!existing.description && incoming.description) existing.description = incoming.description;
  if (!existing.salary && incoming.salary) existing.salary = incoming.salary;
  if (existing.postedAt === undefined && incoming.postedAt !== undefined) existing.postedAt = incoming.postedAt;
  if (existing.expiresAt === undefined && incoming.expiresAt !== undefined) existing.expiresAt = incoming.expiresAt;
  if (!existing.sourceId && incoming.sourceId) existing.sourceId = incoming.sourceId;
  return existing;
}

function annotateJobs(jobs, sourceQuery) {
  return jobs.map(job => addSourceQuery(job, sourceQuery));
}

function unexpectedResponse(json) {
  return new Error(`himalayas: unexpected API response - expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
}

/**
 * Normalize one Himalayas feed row. Exported for focused provider tests and
 * keeps the feed-specific metadata available to smoke scans without changing
 * the scanner's required { title, url, company, location } contract.
 */
export function normalizeHimalayasJob(item) {
  if (!item || typeof item !== 'object') return null;

  const title = cleanText(item.title);
  const url = cleanHimalayasUrl(item.applicationLink) || cleanHimalayasUrl(item.guid);
  const company = cleanText(item.companyName) || humanizeSlug(item.companySlug);
  if (!title || !url || !company) return null;

  const expiresAt = toEpochMs(item.expiryDate);
  if (isUnavailable(item, expiresAt)) return null;

  const locationRestrictions = cleanStringArray(item.locationRestrictions);
  const timezoneRestrictions = cleanStringArray(item.timezoneRestrictions);
  const seniority = cleanStringArray(item.seniority);
  const job = {
    title,
    url,
    company,
    location: locationText(locationRestrictions),
    locationRestrictions,
    timezoneRestrictions,
    seniority,
    employmentType: cleanText(item.employmentType),
  };

  const sourceId = cleanText(item.id ?? item.jobId ?? item.job_id);
  if (sourceId) job.sourceId = sourceId;

  const postedAt = toEpochMs(item.pubDate);
  if (postedAt !== undefined) job.postedAt = postedAt;
  if (expiresAt !== undefined) job.expiresAt = expiresAt;

  const description = cleanText(item.description);
  if (description) job.description = description;

  const min = toFiniteNumber(item.minSalary);
  const max = toFiniteNumber(item.maxSalary);
  const currency = cleanText(item.currency).toUpperCase();
  if (min !== undefined || max !== undefined) {
    job.salary = {
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(currency ? { currency } : {}),
    };
  }

  return job;
}

/**
 * Fetch and normalize bounded pages from the Himalayas public feed. The
 * returned stats are intentionally separate from the provider contract so the
 * scanner still receives a plain normalized job array.
 *
 * `entry.max_pages` and `entry.max_jobs` are provider-specific optional caps.
 * With the existing portal entry omitted, the conservative defaults fetch at
 * most 15 pages / 300 raw rows. `ctx.maxPages` is an additional probe cap used
 * by verify-portals.mjs.
 */
export async function fetchHimalayasPages(entry, ctx) {
  const maxPages = resolveMaxPages(entry, ctx);
  const maxJobs = resolveMaxJobs(entry);
  const jobs = [];
  const seenRawKeys = new Set();
  const seenUrls = new Set();
  const pageSignatures = new Set();
  const stats = {
    pagesFetched: 0,
    requests: 0,
    maxPages,
    maxJobs,
    rawJobsFetched: 0,
    normalizedJobs: 0,
    invalidRows: 0,
    unavailableRows: 0,
    duplicateRawRows: 0,
    duplicateJobs: 0,
    repeatedPages: 0,
    effectivePageSize: undefined,
    reportedTotalCount: undefined,
  };

  let offset = 0;
  for (let page = 0; page < maxPages && stats.rawJobsFetched < maxJobs; page++) {
    const remaining = maxJobs - stats.rawJobsFetched;
    const requestedLimit = Math.min(REQUEST_LIMIT, remaining);
    const feedUrl = buildFeedUrl(offset, requestedLimit);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // buildFeedUrl/assertHimalayasUrl it keeps every request pinned to
    // himalayas.app.
    const json = await ctx.fetchJson(feedUrl, { redirect: 'error' });
    if (!json || !Array.isArray(json.jobs)) throw unexpectedResponse(json);

    const responseRows = json.jobs;
    const rows = responseRows.slice(0, remaining);
    const pageOffset = nonNegativeInteger(json.offset);
    const pageLimit = positiveInteger(json.limit);
    const totalCount = nonNegativeInteger(json.totalCount);

    stats.pagesFetched += 1;
    stats.requests += 1;
    stats.rawJobsFetched += rows.length;
    if (pageLimit !== undefined) stats.effectivePageSize = pageLimit;
    if (totalCount !== undefined) {
      stats.reportedTotalCount = stats.reportedTotalCount === undefined
        ? totalCount
        : Math.max(stats.reportedTotalCount, totalCount);
    }

    if (responseRows.length === 0) break;

    const candidateRows = rows.filter((item) => !isUnavailable(item, toEpochMs(item?.expiryDate)));
    const structurallyUsable = candidateRows.map(normalizeHimalayasJob).filter(Boolean);
    requireUsableRows(candidateRows, structurallyUsable, `himalayas browse page ${page + 1}`);

    const signature = rows.map(rawJobKey).join('\u0001');
    if (pageSignatures.has(signature)) {
      stats.repeatedPages += 1;
      break;
    }
    pageSignatures.add(signature);

    let freshRawRows = 0;
    for (const item of rows) {
      const key = rawJobKey(item);
      if (seenRawKeys.has(key)) {
        stats.duplicateRawRows += 1;
        continue;
      }
      seenRawKeys.add(key);
      freshRawRows += 1;

      const expiresAt = toEpochMs(item?.expiryDate);
      const job = normalizeHimalayasJob(item);
      if (!job) {
        if (isUnavailable(item, expiresAt)) stats.unavailableRows += 1;
        else stats.invalidRows += 1;
        continue;
      }
      if (seenUrls.has(job.url)) {
        stats.duplicateJobs += 1;
        continue;
      }
      seenUrls.add(job.url);
      jobs.push(addSourceQuery(job, GENERIC_FEED_SOURCE_QUERY));
    }

    // A server that ignores offset, or a page that contains only already-seen
    // rows, must not drive an unbounded loop.
    if (freshRawRows === 0) break;

    const step = pageLimit || responseRows.length;
    if (step <= 0 || responseRows.length < step) break;

    const baseOffset = pageOffset ?? offset;
    const nextOffset = baseOffset + step;
    if (totalCount !== undefined && nextOffset >= totalCount) break;
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  stats.normalizedJobs = jobs.length;
  return { jobs, stats };
}

/**
 * Fetch bounded, page-based Himalayas searches. Search pagination is separate
 * from the browse feed: the API supports `q` + 1-based `page`, but does not
 * support a search `limit` parameter. The function therefore never adds one.
 *
 * Duplicate jobs are retained once and accumulate every query that found
 * them in `sourceQueries` (with the first query mirrored in `sourceQuery`).
 */
export async function fetchHimalayasSearchPages(entry, ctx) {
  const queries = normalizeSearchQueries(entry?.search_queries);
  const maxPages = resolveSearchMaxPages(entry, ctx);
  const maxJobs = resolveSearchMaxJobs(entry);
  const jobs = [];
  const jobsByIdentity = new Map();
  const seenRawKeys = new Set();
  const stats = {
    mode: 'targeted-search',
    queries,
    maxPages,
    maxJobs,
    pagesFetched: 0,
    requests: 0,
    rawJobsFetched: 0,
    apiRowsReturned: 0,
    normalizedJobs: 0,
    invalidRows: 0,
    unavailableRows: 0,
    duplicateRawRows: 0,
    duplicateJobs: 0,
    repeatedPages: 0,
    duplicateOnlyPages: 0,
    effectivePageSize: undefined,
    reportedTotalCount: undefined,
    queryStats: [],
  };

  for (const query of queries) {
    if (stats.rawJobsFetched >= maxJobs) break;
    const queryStats = {
      query,
      pagesFetched: 0,
      requests: 0,
      rawJobsFetched: 0,
      totalCount: undefined,
      repeatedPages: 0,
    };
    const pageSignatures = new Set();
    const responseOffsets = new Set();

    for (let page = 1; page <= maxPages; page++) {
      // Search does not expose a usable limit override. Avoid starting a page
      // when the observed/default 20-row response would exceed the configured
      // total cap; the default cap is intentionally a multiple of 20.
      const expectedPageSize = stats.effectivePageSize || 20;
      if (stats.rawJobsFetched > 0 && stats.rawJobsFetched + expectedPageSize > maxJobs) break;

      const searchUrl = buildSearchUrl(query, page);
      const json = await ctx.fetchJson(searchUrl, { redirect: 'error' });
      if (!json || !Array.isArray(json.jobs)) throw unexpectedResponse(json);

      const responseRows = json.jobs;
      const pageOffset = nonNegativeInteger(json.offset);
      const pageLimit = positiveInteger(json.limit);
      const totalCount = nonNegativeInteger(json.totalCount);
      const signature = responseRows.map(rawJobKey).join('\u0001');

      stats.pagesFetched += 1;
      stats.requests += 1;
      stats.apiRowsReturned += responseRows.length;
      queryStats.pagesFetched += 1;
      queryStats.requests += 1;
      if (pageLimit !== undefined) stats.effectivePageSize = pageLimit;
      if (totalCount !== undefined) {
        queryStats.totalCount = totalCount;
        stats.reportedTotalCount = stats.reportedTotalCount === undefined
          ? totalCount
          : Math.max(stats.reportedTotalCount, totalCount);
      }

      if (responseRows.length === 0) break;

      const candidateRows = responseRows.filter((item) => !isUnavailable(item, toEpochMs(item?.expiryDate)));
      const structurallyUsable = candidateRows.map(normalizeHimalayasJob).filter(Boolean);
      requireUsableRows(candidateRows, structurallyUsable, `himalayas search "${query}" page ${page}`);
      if (pageSignatures.has(signature) || (pageOffset !== undefined && responseOffsets.has(pageOffset))) {
        stats.repeatedPages += 1;
        queryStats.repeatedPages += 1;
        break;
      }
      pageSignatures.add(signature);
      if (pageOffset !== undefined) responseOffsets.add(pageOffset);

      const remaining = maxJobs - stats.rawJobsFetched;
      const rows = responseRows.slice(0, remaining);
      stats.rawJobsFetched += rows.length;
      queryStats.rawJobsFetched += rows.length;

      let freshRawRows = 0;
      for (const item of rows) {
        const rawKey = rawJobKey(item);
        const duplicateRaw = seenRawKeys.has(rawKey);
        if (duplicateRaw) stats.duplicateRawRows += 1;
        else {
          seenRawKeys.add(rawKey);
          freshRawRows += 1;
        }

        const expiresAt = toEpochMs(item?.expiryDate);
        const job = normalizeHimalayasJob(item);
        if (!job) {
          if (isUnavailable(item, expiresAt)) stats.unavailableRows += 1;
          else stats.invalidRows += 1;
          continue;
        }

        addSourceQuery(job, query);
        const identity = normalizedJobIdentity(item, job);
        const existing = jobsByIdentity.get(identity);
        if (existing) {
          stats.duplicateJobs += 1;
          mergeHimalayasJobs(existing, job);
        } else {
          jobsByIdentity.set(identity, job);
          jobs.push(job);
        }
      }

      if (freshRawRows === 0) {
        stats.duplicateOnlyPages += 1;
        break;
      }
      if (responseRows.length < (pageLimit || responseRows.length)) break;
      if (stats.rawJobsFetched >= maxJobs) break;
    }

    stats.queryStats.push(queryStats);
  }

  stats.normalizedJobs = jobs.length;
  return { jobs, stats };
}

/**
 * Classify Himalayas' structured location restrictions without imposing a new
 * filter. This preserves the existing three-way review policy used by the
 * discovery reports: broad Finland-compatible remote labels are confirmed,
 * unspecified/generic remote labels are potential, and explicit blocked
 * countries are blocked.
 */
export function classifyHimalayasLocation(job, locationPolicy = {}) {
  const restrictions = Array.isArray(job?.locationRestrictions)
    ? cleanStringArray(job.locationRestrictions)
    : cleanText(job?.location).split(',').map(value => value.trim()).filter(Boolean);
  const combined = restrictions.join(', ').toLowerCase();
  const alwaysAllow = cleanStringArray(locationPolicy.always_allow).map(value => value.toLowerCase());
  const block = cleanStringArray(locationPolicy.block).map(value => value.toLowerCase());

  if (/\b(worldwide|europe|european union|eea|emea|finland)\b/.test(combined)) {
    return { classification: 'Confirmed eligible', reason: 'broad remote restriction includes Finland' };
  }
  if (alwaysAllow.some(keyword => combined.includes(keyword))) {
    return { classification: 'Potential, verify Finland hiring eligibility', reason: 'at least one configured compatible country option is present' };
  }
  if (block.some(keyword => combined.includes(keyword))) {
    return { classification: 'Blocked', reason: 'explicit incompatible country restriction' };
  }
  if (restrictions.length === 0) {
    return { classification: 'Potential, verify Finland hiring eligibility', reason: 'no country restriction stated' };
  }
  return { classification: 'Potential, verify Finland hiring eligibility', reason: 'remote/hiring eligibility requires verification' };
}

/**
 * Run targeted searches first, then one bounded generic latest-feed pass. The
 * returned array remains the existing provider contract; detailed stats are
 * available to immutable verification tooling through this exported helper.
 */
export async function fetchHimalayasDiscovery(entry, ctx) {
  const targeted = await fetchHimalayasSearchPages(entry, ctx);
  const browse = await fetchHimalayasPages(entry, ctx);
  const jobs = [];
  const jobsByIdentity = new Map();
  let duplicatesAcrossModes = 0;

  for (const job of [...targeted.jobs, ...browse.jobs]) {
    const identity = job.sourceId ? `id:${job.sourceId}` : `url:${job.url}`;
    const existing = jobsByIdentity.get(identity);
    if (existing) {
      duplicatesAcrossModes += 1;
      mergeHimalayasJobs(existing, job);
    } else {
      jobsByIdentity.set(identity, job);
      jobs.push(job);
    }
  }

  return {
    jobs,
    targeted,
    browse,
    stats: {
      rawJobsFetched: targeted.stats.rawJobsFetched + browse.stats.rawJobsFetched,
      apiRequests: targeted.stats.requests + browse.stats.requests,
      uniqueJobs: jobs.length,
      duplicatesAcrossModes,
    },
  };
}

/** @type {Provider} */
export default {
  id: 'himalayas',

  detect(entry) {
    return entry?.provider === 'himalayas' ? { url: FEED_URL } : null;
  },

  /**
   * Fetches and normalizes bounded postings from the Himalayas public feed.
   * @param {{ provider?: string, max_pages?: number, max_jobs?: number }} entry - The job_boards entry being processed.
   * @param {{ fetchJson: (url: string, opts?: { redirect?: 'error'|'follow'|'manual' }) => Promise<any>, maxPages?: number }} ctx - HTTP context.
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string, postedAt?: number, expiresAt?: number, description?: string, seniority: string[], employmentType: string, locationRestrictions: string[], timezoneRestrictions: string[], salary?: object, sourceId?: string, sourceQuery?: string, sourceQueries?: string[]}>>}
   */
  async fetch(entry, ctx) {
    const result = await fetchHimalayasDiscovery(entry, ctx);
    return result.jobs;
  },
};

/**
 * Parse Himalayas' public jobs API response. Exported for unit tests.
 *
 * Shape: `{ jobs: [...] }`, where each job currently carries `title`,
 * `companyName`, `locationRestrictions`, `applicationLink`, `guid`,
 * `pubDate`, and `companySlug`. `applicationLink` is preferred over `guid`
 * and used as the dedup key after HTTPS + host validation.
 *
 * @param {unknown} json - raw parsed API response
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number, expiresAt?: number, description?: string, seniority: string[], employmentType: string, locationRestrictions: string[], timezoneRestrictions: string[], salary?: object}>}
 */
export function parseHimalayasResponse(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.jobs)) return [];
  return json.jobs.map(normalizeHimalayasJob).filter(Boolean);
}
