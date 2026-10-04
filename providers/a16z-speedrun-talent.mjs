// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { requiredArray, requireUsableRows } from './_payload.mjs';
import { markProviderCoverage } from './_result.mjs';

// Public, zero-auth a16z speedrun/portfolio talent-network feed.
const FEED_BASE = 'https://speedrun-talent-network.com/api/v1/jobs';
const TRUSTED_HOST = 'speedrun-talent-network.com';
const PER_PAGE = 50;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 120;

function assertFeedUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`a16z-speedrun-talent: invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') throw new Error(`a16z-speedrun-talent: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`a16z-speedrun-talent: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
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

function resolveQuery(entry) {
  if (typeof entry?.q === 'string' && entry.q.trim()) return entry.q.trim();
  if (Array.isArray(entry?.keywords)) {
    const joined = entry.keywords.filter((value) => typeof value === 'string' && value.trim()).join(' ').trim();
    if (joined) return joined;
  }
  return null;
}

function toEpochMs(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function normalizeSpeedrunJob(value, fallbackCompany) {
  if (!value || typeof value !== 'object') return null;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!title) return null;

  let url = '';
  try {
    const parsed = new URL(typeof value.url === 'string' ? value.url.trim() : '');
    if (parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST) url = parsed.href;
  } catch {
    // A malformed or off-host posting URL is unusable.
  }
  if (!url) return null;

  const company = typeof value.company === 'string' && value.company.trim()
    ? value.company.trim()
    : typeof fallbackCompany === 'string' && fallbackCompany.trim()
      ? fallbackCompany.trim()
      : 'a16z speedrun talent network';
  const baseLocation = typeof value.location === 'string' ? value.location.trim() : '';
  const location = [baseLocation, value.remote === true ? 'Remote' : ''].filter(Boolean).join(', ');
  const job = { title, url, company, location };
  const postedAt = toEpochMs(value.published_at);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

/** @type {Provider} */
export default {
  id: 'a16z-speedrun-talent',

  detect(entry) {
    if (entry?.provider === 'a16z-speedrun-talent') return { url: FEED_BASE };
    for (const candidate of [entry?.careers_url, entry?.api]) {
      if (typeof candidate !== 'string' || !candidate) continue;
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST) return { url: candidate };
      } catch {
        // Not this provider.
      }
    }
    return null;
  },

  async fetch(entry, ctx) {
    assertFeedUrl(FEED_BASE);
    const maxPages = resolveMaxPages(entry, ctx);
    const query = resolveQuery(entry);
    const jobs = [];
    const seen = new Set();
    let partialCoverage = null;

    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ page: String(page), source: 'career-ops' });
      if (query) params.set('q', query);
      const url = assertFeedUrl(`${FEED_BASE}?${params}`);
      const json = await ctx.fetchJson(url, { redirect: 'error' });
      const rows = requiredArray(json, 'jobs', `a16z-speedrun-talent page ${page}`);
      const usable = rows.map((row) => normalizeSpeedrunJob(row, entry?.name)).filter(Boolean);
      requireUsableRows(rows, usable, `a16z-speedrun-talent page ${page}`);
      for (const job of usable) {
        if (!seen.has(job.url)) {
          seen.add(job.url);
          jobs.push(job);
        }
      }

      if (rows.length < PER_PAGE) break;
      if (Number.isInteger(json.total_pages) && page + 1 >= json.total_pages) break;
      if (page + 1 >= maxPages && Number.isInteger(json.total_pages) && json.total_pages > maxPages) {
        partialCoverage = {
          status: 'partial',
          code: 'max_pages',
          reason: `${entry?.name || 'board'} truncated at max_pages=${maxPages} (${json.total_pages} total pages)`,
          pagesFetched: page + 1,
          maxPages,
          totalPages: json.total_pages,
        };
        console.error(`a16z-speedrun-talent: ${partialCoverage.reason}`);
      }
    }
    return partialCoverage ? markProviderCoverage(jobs, partialCoverage) : jobs;
  },
};
