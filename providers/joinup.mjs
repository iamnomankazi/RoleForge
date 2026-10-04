// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { requireHtmlContract, requireUsableRows } from './_payload.mjs';
import { htmlToText } from './_html-to-text.mjs';

// joinup.ch is a Swiss startup board.  Its public browse page is a Next.js
// server-rendered page backed by Typesense; the SSR payload contains the
// newest result page, so no private search key or browser runtime is needed.
const TRUSTED_HOST = 'joinup.ch';
const BROWSE_URL = 'https://joinup.ch/browse/jobs';
const NEXT_DATA_MARKER = /<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>/i;
const NEXT_DATA_SCRIPT = /<script\b[^>]*\bid\s*=\s*(["'])__NEXT_DATA__\1[^>]*>([\s\S]*?)<\/script\s*>/i;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function trustedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
}

function assertJoinupUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`joinup: invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') throw new Error(`joinup: URL must use HTTPS: ${url}`);
  if (!trustedHost(parsed.hostname)) {
    throw new Error(`joinup: untrusted hostname "${parsed.hostname}" - must be joinup.ch`);
  }
  return parsed;
}

function scalarName(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (!value || typeof value !== 'object') return '';
  return cleanText(value.name) || cleanText(value.label) || cleanText(value.title)
    || cleanText(value.cityName) || cleanText(value.countryName)
    || cleanText(value.city) || cleanText(value.country);
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
      const text = scalarName(value);
      if (text) values.push(text);
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
    ?? raw?.remoteType ?? (raw?.remote === true ? 'REMOTE' : '');
  if (value && typeof value === 'object') return scalarName(value);
  return typeof value === 'boolean' ? (value ? 'REMOTE' : '') : cleanText(value);
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
      const values = text.replace(/,/g, '').match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
      if (values.length > 0) min = values[0];
      if (values.length > 1) max = values[1];
      const code = text.match(/\b(CHF|EUR|USD|GBP|PLN|SEK|DKK|NOK)\b/i);
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
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) return htmlToText(value);
    if (value && typeof value === 'object') return add(value.html ?? value.text ?? value.content ?? value.value);
    return '';
  };
  for (const key of ['descriptionHtml', 'description', 'jobDescription', 'descriptionMarkdown', 'excerpt']) {
    const text = add(raw?.[key]);
    if (text) return text;
  }
  return '';
}

function sourceIdValue(raw) {
  const value = raw?.sourceId ?? raw?.jobId ?? raw?.job_id ?? raw?.id ?? raw?.uuid ?? raw?.slug;
  return value == null ? '' : String(value).trim();
}

function urlFieldValue(raw) {
  for (const key of ['url', 'jobUrl', 'publicUrl', 'href', 'link', 'applyUrl', 'apply_url']) {
    if (typeof raw?.[key] === 'string' && raw[key].trim()) return raw[key].trim();
  }
  return '';
}

function cleanJobUrl(value) {
  if (!value) return '';
  let parsed;
  try { parsed = new URL(value, BROWSE_URL); } catch { return ''; }
  return parsed.protocol === 'https:' && trustedHost(parsed.hostname) ? parsed.href : '';
}

/** Normalize one hit from the Joinup Typesense result. */
export function normalizeJoinupJob(raw, fallbackCompany = '', sourceUrl = BROWSE_URL) {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw.document && typeof raw.document === 'object' ? { ...raw, ...raw.document } : raw;
  const title = cleanText(row.title ?? row.headline ?? row.name);
  const slug = cleanText(row.slug ?? row.jobSlug ?? row.job_slug);
  if (!title || (!slug && !urlFieldValue(row))) return null;
  const suppliedUrl = urlFieldValue(row);
  let url = cleanJobUrl(suppliedUrl);
  if (suppliedUrl && !url) return null;
  if (!url) {
    if (!slug || /[/?#]/.test(slug)) return null;
    url = `https://joinup.ch/job/${encodeURIComponent(slug)}`;
  }
  const status = cleanText(row.status ?? row.state).toLowerCase();
  if (['closed', 'offline', 'archived', 'inactive', 'expired', 'removed'].includes(status)) return null;

  const company = scalarName(row.startup) || cleanText(row.startupName) || scalarName(row.company)
    || cleanText(row.companyName) || scalarName(row.employer)
    || (cleanText(fallbackCompany) || 'Joinup');
  const model = workModelValue(row);
  let location = locationText(row);
  if (model && /remote/i.test(model) && !/remote/i.test(location)) location = [location, 'Remote'].filter(Boolean).join(', ');
  if (!location && /remote/i.test(model)) location = 'Remote';

  const job = {
    title,
    url,
    company,
    location,
    sourceUrl,
  };
  const sourceId = sourceIdValue(row) || slug || (() => {
    try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1) || ''); } catch { return ''; }
  })();
  if (sourceId) job.sourceId = sourceId;
  const postedAt = toEpochMs(row.created ?? row.createdAt ?? row.created_at ?? row.publishedAt ?? row.published_at ?? row.datePosted);
  if (postedAt !== undefined) job.postedAt = postedAt;
  const description = descriptionValue(row);
  if (description) job.description = description;
  if (model) job.workModel = model;
  const employmentType = scalarName(row.employmentType ?? row.employment_type ?? row.jobType ?? row.type);
  if (employmentType) job.employmentType = employmentType;
  const salary = salaryValue(row);
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

const RESULT_PATHS = [
  ['props', 'pageProps', 'serverState', 'initialResults', 'jobs', 'results'],
  ['props', 'pageProps', 'serverState', 'initialResults', 'jobs'],
  ['props', 'pageProps', 'initialResults', 'jobs', 'results'],
  ['props', 'pageProps', 'jobs', 'results'],
];

function extractRows(data) {
  for (const path of RESULT_PATHS) {
    const value = getPath(data, path);
    if (Array.isArray(value)) {
      if (path.at(-1) === 'results' && value.every((group) => group && typeof group === 'object' && 'hits' in group)) {
        return value.flatMap((group) => {
          if (!Array.isArray(group.hits)) throw new Error('joinup: malformed __NEXT_DATA__ payload (results.hits array expected)');
          return group.hits;
        });
      }
      return value;
    }
    if (value && typeof value === 'object' && Array.isArray(value.hits)) return value.hits;
  }
  throw new Error('joinup: malformed __NEXT_DATA__ payload (expected Typesense results)');
}

/** Parse a validated joinup __NEXT_DATA__ object into one normalized page. */
export function parseJoinupPage(data, fallbackCompany = '', sourceUrl = BROWSE_URL) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('joinup: malformed __NEXT_DATA__ payload');
  const rows = extractRows(data);
  const jobs = rows.map((row) => normalizeJoinupJob(row, fallbackCompany, sourceUrl)).filter(Boolean);
  requireUsableRows(rows, jobs, 'joinup');
  return { jobs, rows };
}

/** Parse a validated joinup __NEXT_DATA__ object into normalized jobs. */
export function parseJoinupResponse(data, fallbackCompany = '', sourceUrl = BROWSE_URL) {
  if (typeof data === 'string') return parseJoinupHtml(data, fallbackCompany, sourceUrl);
  return parseJoinupPage(data, fallbackCompany, sourceUrl).jobs;
}

export function extractJoinupNextData(html) {
  requireHtmlContract(html, [NEXT_DATA_MARKER], 'joinup');
  const match = NEXT_DATA_SCRIPT.exec(html);
  if (!match) throw new Error('joinup: malformed HTML response (invalid __NEXT_DATA__ script)');
  try {
    const data = JSON.parse(match[2]);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('payload is not an object');
    return data;
  } catch (error) {
    throw new Error(`joinup: failed to parse __NEXT_DATA__ - ${error.message}`);
  }
}

export function parseJoinupHtml(html, fallbackCompany = '', sourceUrl = BROWSE_URL) {
  return parseJoinupResponse(extractJoinupNextData(html), fallbackCompany, sourceUrl);
}

/** @type {Provider} */
export default {
  id: 'joinup',

  detect(entry) {
    const candidate = entry?.careers_url || entry?.api || '';
    if (entry?.provider === 'joinup' && !candidate) return { url: BROWSE_URL };
    if (typeof candidate !== 'string' || !candidate.trim()) return null;
    try {
      const parsed = assertJoinupUrl(candidate);
      return { url: BROWSE_URL || parsed.href };
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const candidate = entry?.careers_url || entry?.api || BROWSE_URL;
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new Error('joinup: careers_url must be a trusted joinup.ch URL');
    }
    try { assertJoinupUrl(candidate); } catch {
      throw new Error('joinup: careers_url must be a trusted joinup.ch URL');
    }
    const html = await ctx.fetchText(assertJoinupUrl(BROWSE_URL).href, { redirect: 'error' });
    return parseJoinupHtml(html, entry?.name, BROWSE_URL);
  },
};
