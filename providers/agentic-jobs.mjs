// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';
import { requiredArray, requireUsableRows } from './_payload.mjs';

const SITE_ORIGIN = 'https://agentic-engineering-jobs.com';
const API_BASE = `${SITE_ORIGIN}/api/v1`;
const TRUSTED_HOST = 'agentic-engineering-jobs.com';
const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 40;
const MAX_PAGES_CAP = 40;
const MAX_JOBS = 2000;
const PAGE_DELAY_MS = 2100;

function assertAgenticUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`agentic-jobs: invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') throw new Error(`agentic-jobs: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`agentic-jobs: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
  }
  return url;
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

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

export function countryName(code) {
  if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code)) return '';
  try {
    const name = regionNames.of(code.toUpperCase());
    return name && name !== code.toUpperCase() ? name : '';
  } catch {
    return '';
  }
}

export function stripHtml(html) {
  if (typeof html !== 'string' || !html) return '';
  const noMedia = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  return decodeEntities(noMedia.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function normalizeAgenticLocation(value) {
  if (typeof value?.location === 'string' && value.location.trim()) return value.location.trim();
  const countries = Array.isArray(value?.countries) ? value.countries : [];
  const names = [...new Set(countries.map(countryName).filter(Boolean))];
  if (names.length > 0) return names.join(' / ');
  return typeof value?.geoRegion === 'string' ? value.geoRegion.trim() : '';
}

export function normalizeAgenticSalary(value) {
  const hasMin = typeof value?.salaryMin === 'number' && Number.isFinite(value.salaryMin);
  const hasMax = typeof value?.salaryMax === 'number' && Number.isFinite(value.salaryMax);
  if (!hasMin && !hasMax) return null;
  const salary = {};
  if (hasMin) salary.min = value.salaryMin;
  if (hasMax) salary.max = value.salaryMax;
  const currency = typeof value?.salaryCurrency === 'string' ? value.salaryCurrency.trim().toUpperCase() : '';
  if (currency) salary.currency = currency;
  return salary;
}

export function normalizeAgenticJob(value) {
  if (!value || typeof value !== 'object') return null;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const company = typeof value.companyName === 'string' ? value.companyName.trim() : '';
  const slug = typeof value.slug === 'string' ? value.slug.trim() : '';
  if (!title || !company || !slug || !/^[A-Za-z0-9_-]+$/.test(slug)) return null;

  const job = {
    title,
    url: `${SITE_ORIGIN}/jobs/${slug}`,
    company,
    location: normalizeAgenticLocation(value),
  };
  const description = stripHtml(value.description);
  if (description) job.description = description;
  const postedAt = typeof value.postedAt === 'string' ? Date.parse(value.postedAt) : NaN;
  if (Number.isFinite(postedAt)) job.postedAt = postedAt;
  const salary = normalizeAgenticSalary(value);
  if (salary) job.salary = salary;
  return job;
}

/** @type {Provider} */
export default {
  id: 'agentic-jobs',

  detect(entry) {
    return entry?.provider === 'agentic-jobs' ? { url: SITE_ORIGIN } : null;
  },

  async fetch(entry, ctx) {
    const wait = (ms) => ctx.sleep ? ctx.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
    const maxPages = resolveMaxPages(entry, ctx);
    const jobs = [];
    const seen = new Set();
    let total = null;

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await wait(PAGE_DELAY_MS);
      const url = assertAgenticUrl(`${API_BASE}/jobs?page=${page}`);
      const json = await ctx.fetchJson(url, {
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
      const rows = requiredArray(json, 'data', `agentic-jobs page ${page}`);
      const normalized = rows.map(normalizeAgenticJob).filter(Boolean);
      requireUsableRows(rows, normalized, `agentic-jobs page ${page}`);
      if (total === null) total = typeof json.meta?.total === 'number' ? json.meta.total : null;
      const effectivePageSize = typeof json.meta?.per_page === 'number' && json.meta.per_page > 0
        ? json.meta.per_page
        : PAGE_SIZE;

      for (const job of normalized) {
        if (!seen.has(job.url)) {
          seen.add(job.url);
          jobs.push(job);
        }
      }

      if (jobs.length >= MAX_JOBS) break;
      if (rows.length < effectivePageSize) break;
      if (total !== null && page * effectivePageSize >= total) break;
    }

    return jobs.slice(0, MAX_JOBS);
  },
};
