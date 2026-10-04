// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { requireUsableRows } from './_payload.mjs';
import { markProviderCoverage } from './_result.mjs';

// Remotli is a Swiss remote board.  Its public endpoint returns a jobs array
// plus a separate companies array (jobs reference companies by id).  The
// remote=all parameter is intentional: omitting it hides a large portion of
// the board's non-remote-first listings.
const FEED_BASE = 'https://remotli.ch/api/jobs';
const TRUSTED_HOST = 'remotli.ch';
const BOARD_ORIGIN = 'https://remotli.ch';
const PER_PAGE = 50;
const DEFAULT_MAX_PAGES = 20;
const MAX_PAGES_CAP = 100;
const DEFAULT_MAX_JOBS = 2000;
const MAX_JOBS_CAP = 5000;

function requireHttpContext(ctx) {
  if (!ctx || ctx.transport !== 'http' || typeof ctx.fetchJson !== 'function') {
    throw new Error('remotli: fetch() requires an http transport context with fetchJson');
  }
}

/** @param {string} url */
function assertRemotliUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`remotli: invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') throw new Error(`remotli: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`remotli: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return parsed.href;
}

function positiveInteger(value) { return Number.isInteger(value) && value > 0 ? value : undefined; }
function resolveMaxPages(entry, ctx) {
  const configured = positiveInteger(entry?.max_pages) || DEFAULT_MAX_PAGES;
  const cap = Math.min(configured, MAX_PAGES_CAP);
  const contextCap = positiveInteger(ctx?.maxPages);
  return contextCap ? Math.min(cap, contextCap) : cap;
}
function resolveMaxJobs(entry) {
  const configured = positiveInteger(entry?.max_jobs) || DEFAULT_MAX_JOBS;
  return Math.min(configured, MAX_JOBS_CAP);
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function parseDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cleanHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch { return ''; }
}

function finitePositive(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return undefined;
}

function normalizeCurrency(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[\s\u00a0\u202f]/g, '').toUpperCase();
  const symbols = { '€': 'EUR', '$': 'USD', 'US$': 'USD', '£': 'GBP', CHF: 'CHF' };
  return symbols[normalized] || (/^[A-Z]{3}$/.test(normalized) ? normalized : '');
}

export function parseRemotliSalary(row) {
  const nested = row?.salary && typeof row.salary === 'object' ? row.salary : {};
  const min = finitePositive(row?.salaryMin, row?.salary_min, row?.salaryFrom, row?.minSalary, nested.min, nested.from);
  const max = finitePositive(row?.salaryMax, row?.salary_max, row?.salaryTo, row?.maxSalary, nested.max, nested.to);
  if (min === undefined && max === undefined) return null;
  const salary = { min: min ?? max, max: max ?? min };
  const currency = normalizeCurrency(row?.salaryCurrency ?? row?.salary_currency ?? row?.currency ?? nested.currency);
  if (currency) salary.currency = currency;
  const period = text(row?.salaryPeriod ?? row?.salary_period ?? nested.period);
  if (period) salary.period = period;
  return salary;
}

function sourceId(row) {
  const raw = row?.sourceId ?? row?.source_id ?? row?.jobId ?? row?.job_id ?? row?.id ?? row?.uuid;
  return raw == null || raw === '' ? '' : String(raw);
}

function companyFor(row, companies, fallback) {
  const direct = row?.company && typeof row.company === 'object' ? row.company : null;
  const key = row?.companyId ?? row?.company_id ?? row?.employerId ?? row?.employer_id;
  const joined = key == null ? null : companies.find((company) => company && typeof company === 'object'
    && String(company.id ?? company.companyId ?? company.company_id) === String(key));
  const value = direct?.name ?? direct?.companyName ?? row?.companyName ?? row?.company_name
    ?? joined?.name ?? joined?.companyName ?? joined?.company_name;
  return text(value) || text(fallback) || 'Remotli';
}

function boardUrl(row) {
  for (const value of [row?.url, row?.jobUrl, row?.job_url, row?.listingUrl, row?.listing_url, row?.remotliUrl, row?.sourceUrl]) {
    const candidate = cleanHttpsUrl(value);
    if (candidate && new URL(candidate).hostname === TRUSTED_HOST) return candidate;
  }
  const slug = text(row?.slug ?? row?.jobSlug ?? row?.job_slug ?? row?.id);
  return slug ? `${BOARD_ORIGIN}/jobs/${encodeURIComponent(slug)}` : '';
}

function locationFor(row) {
  const nested = row?.location && typeof row.location === 'object' ? row.location : null;
  const direct = text(typeof row?.location === 'string' ? row.location : '');
  const parts = direct ? [direct] : [nested?.city, nested?.region, nested?.country, row?.city, row?.region, row?.country]
    .filter((value) => text(value));
  const model = text(row?.workplace ?? row?.workplaceType ?? row?.work_model ?? row?.remoteType).toLowerCase();
  const remote = row?.remote === true || row?.isRemote === true || model === 'remote' || model === 'hybrid';
  if (model === 'hybrid' && !parts.some((value) => /hybrid/i.test(String(value)))) parts.push('Hybrid');
  if (remote && !parts.some((value) => /remote/i.test(String(value)))) parts.push('Remote');
  return parts.map((value) => text(value)).filter(Boolean).join(', ');
}

/** Normalize a single active Remotli job, optionally joined to companies. */
export function normalizeRemotliJob(row, companies = [], fallbackCompany) {
  if (!row || typeof row !== 'object') return null;
  const status = text(row.status ?? row.state).toLowerCase();
  if (status !== 'active') return null;
  const title = text(row.title ?? row.position ?? row.name);
  if (!title) return null;

  const applyUrl = cleanHttpsUrl(row.applyUrl ?? row.apply_url ?? row.applicationUrl ?? row.application_url);
  const listingUrl = boardUrl(row);
  const url = applyUrl || listingUrl;
  if (!url) return null;

  const job = { title, url, company: companyFor(row, Array.isArray(companies) ? companies : [], fallbackCompany), location: locationFor(row) };
  const id = sourceId(row);
  if (id) job.sourceId = id;
  if (applyUrl && listingUrl && applyUrl !== listingUrl) job.sourceUrl = listingUrl;
  const description = text(row.description ?? row.descriptionHtml ?? row.description_html ?? row.details ?? row.content);
  if (description) job.description = description;
  const postedAt = parseDate(row.publishedAt ?? row.published_at ?? row.postedAt ?? row.posted_at ?? row.createdAt);
  if (postedAt !== undefined) job.postedAt = postedAt;
  const salary = parseRemotliSalary(row);
  if (salary) job.salary = salary;
  const employmentType = text(row.employmentType ?? row.employment_type ?? row.type);
  if (employmentType) job.employmentType = employmentType;
  return job;
}

function rowKey(row) {
  const id = sourceId(row);
  if (id) return `id:${id}`;
  return `url:${cleanHttpsUrl(row?.applyUrl ?? row?.apply_url ?? row?.url) || JSON.stringify(row)}`;
}

function hasMore(json, rows) {
  if (json && Object.prototype.hasOwnProperty.call(json, 'next_page_url')) return Boolean(json.next_page_url);
  if (json && Object.prototype.hasOwnProperty.call(json, 'nextPageUrl')) return Boolean(json.nextPageUrl);
  if (json?.pagination && Object.prototype.hasOwnProperty.call(json.pagination, 'next')) return Boolean(json.pagination.next);
  if (json?.meta && Object.prototype.hasOwnProperty.call(json.meta, 'next')) return Boolean(json.meta.next);
  if (json?.hasMore === true || json?.has_more === true || json?.pagination?.hasNext === true || json?.meta?.hasNext === true) return true;
  const page = Number(json?.page ?? json?.pagination?.page ?? json?.meta?.page);
  const totalPages = Number(json?.totalPages ?? json?.total_pages ?? json?.pagination?.totalPages ?? json?.meta?.totalPages);
  if (Number.isFinite(page) && Number.isFinite(totalPages) && totalPages > page) return true;
  return rows.length >= PER_PAGE;
}

/** @type {Provider} */
export default {
  id: 'remotli',

  detect(entry) {
    return entry?.provider === 'remotli' ? { url: `${FEED_BASE}?page=1&limit=${PER_PAGE}&remote=all` } : null;
  },

  async fetch(entry, ctx) {
    requireHttpContext(ctx);
    const maxPages = resolveMaxPages(entry, ctx);
    const maxJobs = resolveMaxJobs(entry);
    const jobs = [];
    const seen = new Set();
    const signatures = new Set();
    let partial = null;

    for (let page = 1; page <= maxPages && jobs.length < maxJobs; page++) {
      const url = assertRemotliUrl(`${FEED_BASE}?page=${page}&limit=${PER_PAGE}&remote=all`);
      const json = await ctx.fetchJson(url, { redirect: 'error' });
      if (!json || !Array.isArray(json.jobs)) {
        throw new Error(`remotli: unexpected API response on page ${page} — expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
      }
      if (Object.prototype.hasOwnProperty.call(json, 'companies') && !Array.isArray(json.companies)) {
        throw new Error(`remotli: unexpected API response on page ${page} — expected companies to be an array when present`);
      }
      const rows = json.jobs;
      if (rows.length === 0) break;
      const signature = rows.map(rowKey).join('\u0001');
      if (signatures.has(signature)) {
        partial = { status: 'partial', code: 'repeated_page', reason: `${entry?.name || 'Remotli'} repeated page ${page}; stopped to avoid an unbounded loop`, pagesFetched: page - 1, maxPages };
        break;
      }
      signatures.add(signature);
      const companies = Array.isArray(json.companies) ? json.companies : [];
      const activeRows = rows.filter((row) => text(row?.status ?? row?.state).toLowerCase() === 'active');
      const normalized = activeRows.map((row) => normalizeRemotliJob(row, companies, entry?.name)).filter(Boolean);
      requireUsableRows(activeRows, normalized, `remotli page ${page}`);
      for (const job of normalized) {
        if (jobs.length >= maxJobs) break;
        const key = job.sourceId ? `id:${job.sourceId}` : `url:${job.url}`;
        if (!seen.has(key)) { seen.add(key); jobs.push(job); }
      }
      const more = hasMore(json, rows);
      if (!more) break;
      if (page >= maxPages || jobs.length >= maxJobs) {
        partial = {
          status: 'partial', code: jobs.length >= maxJobs ? 'max_jobs' : 'max_pages',
          reason: `${entry?.name || 'Remotli'} truncated at ${jobs.length >= maxJobs ? `max_jobs=${maxJobs}` : `max_pages=${maxPages}`}`,
          pagesFetched: page, maxPages,
        };
        break;
      }
    }
    return partial ? markProviderCoverage(jobs, partial) : jobs;
  },
};
