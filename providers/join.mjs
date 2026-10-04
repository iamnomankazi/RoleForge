// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { requireHtmlContract, requireUsableRows } from './_payload.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { markProviderCoverage } from './_result.mjs';

// JOIN-hosted company career pages are rendered by Next.js.  There is no
// unauthenticated list API, so the provider reads the page's __NEXT_DATA__ and
// follows the board's own page=N pagination.  Keep every request pinned to the
// public JOIN origin; a caller supplied URL is used only after this check.
const TRUSTED_HOST = 'join.com';
const BOARD_PATH = /^\/companies\/([^/]+)(?:\/.*)?$/i;
const DEFAULT_MAX_PAGES = 50;
const MAX_PAGES_CAP = 50;
const DEFAULT_PAGE_SIZE = 10;

const NEXT_DATA_MARKER = /<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>/i;
const NEXT_DATA_SCRIPT = /<script\b[^>]*\bid\s*=\s*(["'])__NEXT_DATA__\1[^>]*>([\s\S]*?)<\/script\s*>/i;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function trustedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
}

/** @param {string} url */
function assertJoinUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`join: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`join: URL must use HTTPS: ${url}`);
  if (!trustedHost(parsed.hostname)) {
    throw new Error(`join: untrusted hostname "${parsed.hostname}" - must be join.com`);
  }
  const match = BOARD_PATH.exec(parsed.pathname);
  if (!match || !cleanText(match[1])) {
    throw new Error(`join: URL path must be /companies/<slug>: ${url}`);
  }
  return parsed;
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function resolveMaxPages(entry, ctx) {
  const configured = positiveInteger(entry?.max_pages) || DEFAULT_MAX_PAGES;
  const capped = Math.min(configured, MAX_PAGES_CAP);
  const contextCap = positiveInteger(ctx?.maxPages);
  return contextCap ? Math.min(capped, contextCap) : capped;
}

function toEpochMs(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number' || (typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n < 1_000_000_000_000 ? n * 1000 : n;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

function scalarName(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (!value || typeof value !== 'object') return '';
  return cleanText(value.name)
    || cleanText(value.label)
    || cleanText(value.title)
    || cleanText(value.cityName)
    || cleanText(value.countryName)
    || cleanText(value.city)
    || cleanText(value.country);
}

function locationText(raw) {
  const values = [];
  const add = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      if (text) values.push(text);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const city = cleanText(value.cityName) || cleanText(value.city) || (value.country ? cleanText(value.name) : '');
    const country = cleanText(value.countryName) || cleanText(value.country);
    const pair = [city, country].filter(Boolean).join(', ');
    if (pair) values.push(pair);
    else {
      const direct = scalarName(value);
      if (direct) values.push(direct);
    }
  };
  add(raw?.location);
  add(raw?.locations);
  add(raw?.city);
  add(raw?.country);
  return [...new Set(values.filter(Boolean))].join(', ');
}

function workModelValue(raw) {
  const value = raw?.workModel ?? raw?.workplaceType ?? raw?.workLocation?.type
    ?? raw?.workLocationType ?? raw?.remoteType;
  if (typeof value === 'boolean') return value ? 'REMOTE' : '';
  if (value && typeof value === 'object') return scalarName(value);
  return cleanText(value);
}

function employmentTypeValue(raw) {
  const value = raw?.employmentType ?? raw?.employment_type ?? raw?.contractType;
  return scalarName(value);
}

function salaryValue(raw) {
  const candidate = raw?.salary && typeof raw.salary === 'object' ? raw.salary
    : raw?.compensation && typeof raw.compensation === 'object' ? raw.compensation : raw;
  const number = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  let min = number(candidate?.min ?? candidate?.minimum ?? candidate?.from ?? candidate?.low ?? raw?.salaryMin);
  let max = number(candidate?.max ?? candidate?.maximum ?? candidate?.to ?? candidate?.high ?? raw?.salaryMax);
  let currency = cleanText(candidate?.currency ?? candidate?.currencyCode ?? raw?.salaryCurrency).toUpperCase();
  if (min === undefined && max === undefined) {
    const text = cleanText(raw?.salary ?? raw?.compensation);
    if (text) {
      const matches = text.replace(/,/g, '').match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
      if (matches.length > 0) min = matches[0];
      if (matches.length > 1) max = matches[1];
      const code = text.match(/\b(EUR|USD|GBP|CHF|PLN|SEK|DKK|NOK|CZK)\b/i);
      if (code) currency = code[1].toUpperCase();
    }
  }
  if (min === undefined && max === undefined) return undefined;
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(currency ? { currency } : {}),
  };
}

function descriptionValue(raw) {
  const parts = [];
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) parts.push(htmlToText(value));
    else if (value && typeof value === 'object') add(value.html ?? value.text ?? value.content ?? value.value);
  };
  for (const key of ['descriptionHtml', 'description', 'unifiedDescription', 'jobDescription', 'descriptionMarkdown']) {
    add(raw?.[key]);
    if (parts.length > 0) break;
  }
  if (parts.length === 0) {
    for (const key of ['intro', 'tasks', 'requirements', 'benefits', 'outro']) add(raw?.[key]);
  }
  return parts.filter(Boolean).join(' ').trim();
}

function statusUnavailable(raw) {
  const status = cleanText(raw?.status ?? raw?.state).toLowerCase();
  return ['offline', 'closed', 'archived', 'inactive', 'expired', 'removed'].includes(status)
    || raw?.isClosed === true || raw?.isExpired === true;
}

function sourceIdValue(raw) {
  const value = raw?.idParam ?? raw?.id_param ?? raw?.sourceId ?? raw?.jobId ?? raw?.job_id
    ?? raw?.id ?? raw?.uuid ?? raw?.slug ?? raw?.jobSlug;
  return value == null ? '' : String(value).trim();
}

function urlFieldValue(raw) {
  for (const key of ['url', 'jobUrl', 'publicUrl', 'href', 'link', 'applyUrl', 'apply_url']) {
    if (typeof raw?.[key] === 'string' && raw[key].trim()) return raw[key].trim();
  }
  return '';
}

function cleanJobUrl(value, baseUrl) {
  if (!value) return '';
  let parsed;
  try { parsed = new URL(value, baseUrl); } catch { return ''; }
  return parsed.protocol === 'https:' && trustedHost(parsed.hostname) ? parsed.href : '';
}

/**
 * Normalize one row from a JOIN SSR payload.  The third argument is optional
 * context used by the provider; the two-argument form remains convenient for
 * focused tests and callers.
 */
export function normalizeJoinJob(raw, fallbackCompany = '', context = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (statusUnavailable(raw)) return null;
  const title = cleanText(raw.title ?? raw.headline ?? raw.name ?? raw.positionTitle);
  if (!title) return null;

  const boardUrl = typeof context === 'string' ? context : context?.sourceUrl || 'https://join.com/companies';
  const companySlug = typeof context === 'object' ? cleanText(context?.companySlug) : '';
  const suppliedUrl = urlFieldValue(raw);
  let url = cleanJobUrl(suppliedUrl, boardUrl);
  if (suppliedUrl && !url) return null; // Never replace an explicitly off-host URL with a guessed one.
  if (!url) {
    const idParam = cleanText(raw.idParam ?? raw.id_param ?? raw.slug ?? raw.jobSlug ?? raw.id ?? raw.jobId);
    const slug = companySlug || cleanText(raw.companySlug ?? raw.company?.slug);
    if (!idParam || !slug || /[/?#]/.test(idParam) || /[/?#]/.test(slug)) return null;
    let origin = 'https://join.com';
    try { origin = new URL(boardUrl).origin; } catch { /* default is trusted */ }
    url = `${origin}/companies/${encodeURIComponent(slug)}/${encodeURIComponent(idParam)}`;
  }

  const company = scalarName(raw.company) || cleanText(raw.companyName) || scalarName(raw.employer)
    || scalarName(raw.organization) || (cleanText(fallbackCompany) || 'JOIN');
  const model = workModelValue(raw);
  let location = locationText(raw);
  if (model && /remote/i.test(model) && !/remote/i.test(location)) location = [location, 'Remote'].filter(Boolean).join(', ');
  if (!location && /remote/i.test(model)) location = 'Remote';

  const job = {
    title,
    url,
    company,
    location,
    sourceUrl: typeof context === 'object' && context?.sourceUrl ? context.sourceUrl : boardUrl,
  };
  const sourceId = sourceIdValue(raw) || (() => {
    try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1) || ''); } catch { return ''; }
  })();
  if (sourceId) job.sourceId = sourceId;
  const postedAt = toEpochMs(raw.publishedAt ?? raw.published_at ?? raw.createdAt ?? raw.created_at ?? raw.created ?? raw.datePosted);
  if (postedAt !== undefined) job.postedAt = postedAt;
  const description = descriptionValue(raw);
  if (description) job.description = description;
  const employmentType = employmentTypeValue(raw);
  if (employmentType) job.employmentType = employmentType;
  if (model) {
    job.workModel = model;
    const workplaceType = cleanText(raw.workplaceType);
    const remoteType = cleanText(raw.remoteType);
    if (workplaceType) job.workplaceType = workplaceType;
    if (remoteType) job.remoteType = remoteType;
  }
  const salary = salaryValue(raw);
  if (salary) job.salary = salary;
  return job;
}

function getPath(value, path) {
  let cursor = value;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

// These are the known server-rendered shapes observed on JOIN company pages.
// Keep the allowlist explicit: arbitrary recursive "find a jobs array" logic
// would accept unrelated page state and hide a markup/API contract break.
const ROW_PATHS = [
  ['props', 'pageProps', 'jobs'],
  ['props', 'pageProps', 'openPositions'],
  ['props', 'pageProps', 'company', 'jobs'],
  ['props', 'pageProps', 'company', 'openPositions'],
  ['props', 'pageProps', 'publicJobs', 'items'],
  ['props', 'pageProps', 'company', 'publicJobs', 'items'],
  ['props', 'pageProps', 'companyData', 'jobs'],
  ['props', 'pageProps', 'companyData', 'openPositions'],
  ['props', 'pageProps', 'jobs', 'items'],
  ['props', 'pageProps', 'data', 'jobs'],
  ['props', 'pageProps', 'data', 'company', 'jobs'],
  ['props', 'pageProps', 'initialData', 'jobs'],
  ['props', 'pageProps', 'initialData', 'company', 'jobs'],
];

function pageInfo(data) {
  const candidates = [
    getPath(data, ['props', 'pageProps', 'pageInfo']),
    getPath(data, ['props', 'pageProps', 'pagination']),
    getPath(data, ['props', 'pageProps', 'meta']),
    getPath(data, ['props', 'pageProps', 'jobs', 'pageInfo']),
    getPath(data, ['props', 'pageProps', 'company', 'jobs', 'pageInfo']),
    getPath(data, ['props', 'pageProps', 'companyData', 'jobs', 'pageInfo']),
  ];
  return candidates.find((value) => value && typeof value === 'object') || null;
}

/** Parse a validated JOIN __NEXT_DATA__ object into a page result. */
export function parseJoinPage(data, fallbackCompany = '', sourceUrl = 'https://join.com/companies', companySlug = '') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('join: malformed __NEXT_DATA__ payload');
  let rows;
  for (const path of ROW_PATHS) {
    const value = getPath(data, path);
    if (Array.isArray(value)) { rows = value; break; }
  }
  if (!rows) throw new Error('join: malformed __NEXT_DATA__ payload (expected jobs array)');
  const context = { sourceUrl, companySlug };
  const normalized = rows.map((row) => normalizeJoinJob(row, fallbackCompany, context)).filter(Boolean);
  requireUsableRows(rows, normalized, 'join');
  return { jobs: normalized, rows, info: pageInfo(data) };
}

/** Parse a validated JOIN __NEXT_DATA__ object into normalized jobs. */
export function parseJoinResponse(data, fallbackCompany = '', sourceUrl = 'https://join.com/companies', companySlug = '') {
  if (typeof data === 'string') return parseJoinHtml(data, fallbackCompany, sourceUrl, companySlug);
  return parseJoinPage(data, fallbackCompany, sourceUrl, companySlug).jobs;
}

/** Extract the JSON object from a Next.js __NEXT_DATA__ script tag. */
export function extractJoinNextData(html) {
  requireHtmlContract(html, [NEXT_DATA_MARKER], 'join');
  const match = NEXT_DATA_SCRIPT.exec(html);
  if (!match) throw new Error('join: malformed HTML response (invalid __NEXT_DATA__ script)');
  try {
    const data = JSON.parse(match[2]);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('payload is not an object');
    return data;
  } catch (error) {
    throw new Error(`join: failed to parse __NEXT_DATA__ - ${error.message}`);
  }
}

export function parseJoinHtml(html, fallbackCompany = '', sourceUrl = 'https://join.com/companies', companySlug = '') {
  return parseJoinResponse(extractJoinNextData(html), fallbackCompany, sourceUrl, companySlug);
}

function pageNumber(info) {
  const n = Number(info?.page ?? info?.currentPage);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function totalPages(info) {
  const n = Number(info?.pageCount ?? info?.totalPages ?? info?.pages);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function hasNextPage(info) {
  if (!info || typeof info !== 'object') return undefined;
  if (typeof info.hasNext === 'boolean') return info.hasNext;
  if (typeof info.hasMore === 'boolean') return info.hasMore;
  if (info.nextPage != null) return true;
  return undefined;
}

function rowSignature(rows) {
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return JSON.stringify(row);
    const id = sourceIdValue(row);
    const rawUrl = urlFieldValue(row);
    return id ? `id:${id}` : rawUrl ? `url:${rawUrl}` : JSON.stringify(row);
  }).join('\u0001');
}

/** @type {Provider} */
export default {
  id: 'join',

  detect(entry) {
    const candidate = entry?.careers_url || entry?.api || '';
    if (entry?.provider === 'join' && !candidate) return { url: 'https://join.com/companies' };
    if (typeof candidate !== 'string' || !candidate.trim()) return null;
    try {
      const parsed = assertJoinUrl(candidate);
      return { url: parsed.href };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const candidate = entry?.careers_url || entry?.api || '';
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new Error('join: careers_url is required and must be a trusted join.com company URL');
    }
    const parsedBase = assertJoinUrl(candidate);
    const companySlug = BOARD_PATH.exec(parsedBase.pathname)?.[1] || '';
    const sourceUrl = `${parsedBase.origin}${parsedBase.pathname.replace(/\/$/, '')}`;
    const maxPages = resolveMaxPages(entry, ctx);
    const jobs = [];
    const seenUrls = new Set();
    const seenPages = new Set();
    let coverage = null;
    let previousReportedPage;

    for (let page = 1; page <= maxPages; page++) {
      const pageUrl = new URL(sourceUrl);
      pageUrl.searchParams.set('page', String(page));
      const html = await ctx.fetchText(assertJoinUrl(pageUrl.href).href, { redirect: 'error' });
      const parsed = parseJoinPage(extractJoinNextData(html), entry?.name, sourceUrl, companySlug);
      const signature = rowSignature(parsed.rows);
      if (seenPages.has(signature)) break;
      seenPages.add(signature);

      for (const job of parsed.jobs) {
        if (!seenUrls.has(job.url)) {
          seenUrls.add(job.url);
          jobs.push(job);
        }
      }

      const info = parsed.info;
      const reportedPage = pageNumber(info);
      if (reportedPage !== undefined) {
        if (previousReportedPage !== undefined && reportedPage <= previousReportedPage) break;
        previousReportedPage = reportedPage;
      }
      const pages = totalPages(info);
      const next = hasNextPage(info);
      if (parsed.rows.length === 0 || next === false || (pages !== undefined && page >= pages)) break;
      if (page >= maxPages) {
        const more = next === true || (pages !== undefined && pages > maxPages) || parsed.rows.length >= DEFAULT_PAGE_SIZE;
        if (more) {
          coverage = {
            status: 'partial',
            code: 'max_pages',
            reason: `${entry?.name || 'JOIN board'} truncated at max_pages=${maxPages}${pages !== undefined ? ` (${pages} total pages)` : ''}`,
            pagesFetched: page,
            maxPages,
            ...(pages !== undefined ? { totalPages: pages } : {}),
          };
        }
        break;
      }
      if (next === undefined && pages === undefined && parsed.rows.length < DEFAULT_PAGE_SIZE) break;
    }
    return coverage ? markProviderCoverage(jobs, coverage) : jobs;
  },
};
