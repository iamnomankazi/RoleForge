// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { requireUsableRows } from './_payload.mjs';
import { markProviderCoverage } from './_result.mjs';

const JOBS_ENDPOINT = 'https://app.flowxtra.com/api/central/jobs';
const ENDPOINT_HOST = 'app.flowxtra.com';
const APPLY_HOSTS = new Set(['flowxtra.com', 'www.flowxtra.com']);
const PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 50;
const DEFAULT_MAX_JOBS = 1000;
const MAX_JOBS_CAP = 5000;

function requireHttpContext(ctx) {
  if (!ctx || ctx.transport !== 'http' || typeof ctx.fetchJson !== 'function') {
    throw new Error('flowxtra: fetch() requires an http transport context with fetchJson');
  }
}

/** @param {string} url */
function assertFlowxtraEndpointUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`flowxtra: invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') throw new Error(`flowxtra: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== ENDPOINT_HOST) {
    throw new Error(`flowxtra: untrusted hostname "${parsed.hostname}" — must be ${ENDPOINT_HOST}`);
  }
  return parsed.href;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
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

function parseDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cleanUrl(value, { apply = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:') return '';
    if (apply && !APPLY_HOSTS.has(parsed.hostname.toLowerCase())) return '';
    return parsed.href;
  } catch { return ''; }
}

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return undefined;
}

function normalizeCurrency(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[\s\u00a0\u202f]/g, '').toUpperCase();
  const symbols = { '€': 'EUR', '$': 'USD', 'US$': 'USD', '£': 'GBP', 'CHF': 'CHF' };
  return symbols[normalized] || (/^[A-Z]{3}$/.test(normalized) ? normalized : '');
}

function parseSalary(row) {
  const nested = row.salary && typeof row.salary === 'object' ? row.salary : {};
  const min = firstNumber(row.salaryMin, row.salary_min, row.salaryFrom, row.minSalary, nested.min, nested.from);
  const max = firstNumber(row.salaryMax, row.salary_max, row.salaryTo, row.maxSalary, nested.max, nested.to);
  if (min === undefined && max === undefined) return null;
  const salary = { min: min ?? max, max: max ?? min };
  const currency = normalizeCurrency(row.salaryCurrency ?? row.salary_currency ?? row.currency ?? nested.currency);
  if (currency) salary.currency = currency;
  const period = text(row.salaryPeriod ?? row.salary_period ?? nested.period);
  if (period) salary.period = period;
  return salary;
}

function sourceId(row) {
  const raw = row?.sourceId ?? row?.source_id ?? row?.has_id ?? row?.jobId ?? row?.job_id ?? row?.id ?? row?.uuid;
  return raw == null || raw === '' ? '' : String(raw);
}

function sourceUrl(row, selected) {
  for (const value of [row?.sourceUrl, row?.source_url, row?.listingUrl, row?.jobUrl, row?.urlJob, row?.url]) {
    const candidate = cleanUrl(value);
    if (candidate && candidate !== selected) return candidate;
  }
  return '';
}

/** Normalize one Flowxtra row (the API spells urlJobApplay this way). */
export function normalizeFlowxtraJob(row, fallbackCompany) {
  if (!row || typeof row !== 'object') return null;
  const status = text(row.status ?? row.state).toLowerCase();
  if (['closed', 'inactive', 'expired', 'archived', 'draft'].includes(status)) return null;
  const title = text(row.title ?? row.position ?? row.name);
  if (!title) return null;
  const url = cleanUrl(row.urlJobApplay ?? row.urlJobApply ?? row.applyUrl ?? row.apply_url, { apply: true });
  if (!url) return null;

  const companyValue = row.name_company ?? row.company_name ?? row.companyName ?? row.company?.name;
  const company = text(companyValue) || (text(fallbackCompany) || 'Flowxtra');
  const locationParts = [row.city_company, row.state_company, row.country_company, row.city, row.state, row.country]
    .filter((value, index, values) => typeof value === 'string' && value.trim() && values.findIndex((v) => v === value) === index)
    .map((value) => value.trim());
  const workplace = text(row.workplace ?? row.workplaceType ?? row.workplace_type).toLowerCase();
  const model = workplace === 'remote' ? 'Remote' : workplace === 'hybrid' ? 'Hybrid' : '';
  const location = [...locationParts, model].filter(Boolean).join(', ');

  const job = { title, url, company, location };
  const id = sourceId(row);
  if (id) job.sourceId = id;
  const origin = sourceUrl(row, url);
  if (origin) job.sourceUrl = origin;
  const description = text(row.description ?? row.descriptionHtml ?? row.description_html ?? row.job_description ?? row.details);
  if (description) job.description = description;
  const postedAt = parseDate(row.date_share ?? row.postedAt ?? row.posted_at ?? row.publishedAt ?? row.createdAt);
  if (postedAt !== undefined) job.postedAt = postedAt;
  const salary = parseSalary(row);
  if (salary) job.salary = salary;
  if (workplace) job.workplace = workplace;
  return job;
}

function rowKey(row) {
  const id = sourceId(row);
  if (id) return `id:${id}`;
  const url = cleanUrl(row?.urlJobApplay ?? row?.applyUrl ?? row?.urlJobApply, { apply: true });
  if (url) return `url:${url}`;
  return `raw:${JSON.stringify(row)}`;
}

function hasMorePages(json, rows) {
  // An explicit next-page field is authoritative, including an explicit null
  // on a full page.  Only fall back to page length when the API omits all
  // pagination hints.
  if (json?.data && Object.prototype.hasOwnProperty.call(json.data, 'next_page_url')) return Boolean(json.data.next_page_url);
  if (json?.data && Object.prototype.hasOwnProperty.call(json.data, 'nextPageUrl')) return Boolean(json.data.nextPageUrl);
  if (json && Object.prototype.hasOwnProperty.call(json, 'next_page_url')) return Boolean(json.next_page_url);
  if (json?.data?.has_more === true || json?.data?.hasMore === true || json?.has_more === true || json?.hasMore === true) return true;
  const current = Number(json?.data?.current_page ?? json?.data?.page ?? json?.page);
  const total = Number(json?.data?.last_page ?? json?.data?.pages ?? json?.totalPages);
  if (Number.isFinite(current) && Number.isFinite(total) && total > current) return true;
  return rows.length >= PER_PAGE;
}

/** @type {Provider} */
export default {
  id: 'flowxtra',

  detect(entry) {
    return entry?.provider === 'flowxtra' ? { url: JOBS_ENDPOINT } : null;
  },

  async fetch(entry, ctx) {
    requireHttpContext(ctx);
    const maxPages = resolveMaxPages(entry, ctx);
    const maxJobs = resolveMaxJobs(entry);
    const jobs = [];
    const seen = new Set();
    const pageSignatures = new Set();
    let partial = null;

    for (let page = 1; page <= maxPages && jobs.length < maxJobs; page++) {
      const url = assertFlowxtraEndpointUrl(`${JOBS_ENDPOINT}?status=Live&per_page=${PER_PAGE}&page=${page}`);
      const json = await ctx.fetchJson(url, { redirect: 'error' });
      const rows = json?.data?.data;
      if (!Array.isArray(rows)) {
        throw new Error(`flowxtra: unexpected API response on page ${page} — expected { data: { data: [...] } }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
      }
      if (rows.length === 0) break;
      const signature = rows.map(rowKey).join('\u0001');
      if (pageSignatures.has(signature)) {
        partial = { status: 'partial', code: 'repeated_page', reason: `${entry?.name || 'Flowxtra'} repeated page ${page}; stopped to avoid an unbounded loop`, pagesFetched: page - 1, maxPages };
        break;
      }
      pageSignatures.add(signature);
      const normalized = rows.map((row) => normalizeFlowxtraJob(row, entry?.name)).filter(Boolean);
      requireUsableRows(rows.filter((row) => !['closed', 'inactive', 'expired', 'archived', 'draft'].includes(text(row?.status ?? row?.state).toLowerCase())), normalized, `flowxtra page ${page}`);
      for (const job of normalized) {
        if (jobs.length >= maxJobs) break;
        const key = job.sourceId ? `id:${job.sourceId}` : `url:${job.url}`;
        if (!seen.has(key)) { seen.add(key); jobs.push(job); }
      }
      const more = hasMorePages(json, rows);
      if (!more) break;
      if (page >= maxPages || jobs.length >= maxJobs) {
        partial = {
          status: 'partial',
          code: jobs.length >= maxJobs ? 'max_jobs' : 'max_pages',
          reason: `${entry?.name || 'Flowxtra'} truncated at ${jobs.length >= maxJobs ? `max_jobs=${maxJobs}` : `max_pages=${maxPages}`}`,
          pagesFetched: page,
          maxPages,
        };
        break;
      }
    }
    return partial ? markProviderCoverage(jobs, partial) : jobs;
  },
};
