// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { markProviderCoverage } from './_result.mjs';

// Arbeitnow provider — board-wide aggregator feed (EU/DACH-heavy, but
// international): https://www.arbeitnow.com/api/job-board-api
// Response shape: { data: [ { slug, company_name, title, description, remote,
//   url, tags, job_types, location, created_at } ], links, meta }
//
// Jobs are ordered newest-first. Live responses can use unusual page sizes
// and overlapping windows, so `links.next` is the authoritative continuation
// signal when present. The API echoes a rotating
// featured `?search=` term into links.next, so page URLs are built directly as
// `?page=N` (never by following links.next) to keep the FULL board in view —
// scan.mjs's title_filter then gates on the configured titles. Pages are fetched
// until one comes back short/empty or the page cap is reached (default 3,
// override with `max_pages` on the portal entry).
//
// Wire in via a `job_boards:` entry with `provider: arbeitnow`.

const FEED_BASE = 'https://www.arbeitnow.com/api/job-board-api';
const TRUSTED_HOST = 'www.arbeitnow.com';
const LEGACY_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 50;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;
const RETRY_AFTER_MAX_DELAY_MS = 32_000;
const INTER_PAGE_DELAY_MS = 150;

/** @param {string} url */
function assertArbeitnowUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`arbeitnow: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`arbeitnow: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`arbeitnow: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses Retry-After seconds or an HTTP date into milliseconds. */
function parseRetryAfterMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const dateMs = Date.parse(String(value));
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function isRetryableError(error) {
  const status = error?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  return status === undefined || status === null;
}

async function fetchPageWithRetry(ctx, url, options) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await ctx.fetchJson(url, options);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES || !isRetryableError(error)) throw error;
      const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
      const retryAfter = parseRetryAfterMs(error?.retryAfter);
      const delay = retryAfter === null ? backoff : Math.min(retryAfter, RETRY_AFTER_MAX_DELAY_MS);
      await sleep(delay, ctx);
    }
  }
  throw lastError;
}

/**
 * Normalize a single Arbeitnow job. Exported for unit tests.
 *
 * Field mapping → the normalized Job shape:
 *   - title:    `title`, trimmed (items without one are dropped).
 *   - url:      `url` — an absolute `https:` posting URL host-locked to
 *               www.arbeitnow.com (an off-host or non-https URL is untrusted and
 *               drops the item). It is the dedup key and is display-only (written
 *               to the pipeline/history, never server-fetched here).
 *   - company:  `company_name`, falling back to the portal entry name, then
 *               "Arbeitnow".
 *   - location: `location`, with "Remote" appended when `remote` is true.
 *   - description: `description`, trimmed and preserved when non-empty because
 *                  it is already present in the list payload.
 *   - postedAt: `created_at` (epoch SECONDS) → epoch ms (omitted when absent).
 *
 * @param {any} j
 * @param {string} [fallbackCompany]
 * @returns {{ title: string, url: string, company: string, location: string, description?: string, postedAt?: number } | null}
 */
export function normalizeArbeitnowJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;

  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  // url must be an absolute https posting link on www.arbeitnow.com — Arbeitnow
  // always serves postings there, so an off-host URL is untrusted and dropped.
  let url = '';
  const rawUrl = typeof j.url === 'string' ? j.url.trim() : '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST) url = parsed.href;
    } catch {
      // malformed URL → leave url = '' → dropped below
    }
  }
  if (!url) return null;

  const company =
    typeof j.company_name === 'string' && j.company_name.trim()
      ? j.company_name.trim()
      : fallbackCompany || 'Arbeitnow';

  const baseLocation = typeof j.location === 'string' ? j.location.trim() : '';
  const location = [baseLocation, j.remote === true ? 'Remote' : ''].filter(Boolean).join(', ');

  /** @type {{ title: string, url: string, company: string, location: string, description?: string, postedAt?: number }} */
  const job = { title, url, company, location };
  const description = typeof j.description === 'string' ? j.description.trim() : '';
  if (description) job.description = description;
  if (Number.isFinite(j.created_at)) job.postedAt = j.created_at * 1000; // epoch seconds → ms
  return job;
}

/** @type {Provider} */
export default {
  id: 'arbeitnow',

  async fetch(entry, ctx) {
    assertArbeitnowUrl(FEED_BASE);
    const maxPages = resolveMaxPages(entry);
    const fallbackCompany = entry?.name;
    const out = [];
    let partialCoverage = null;

    for (let page = 1; page <= maxPages; page++) {
      // Build the page URL directly (do NOT follow links.next — it carries a
      // featured `?search=` term that would narrow the board).
      const url = `${FEED_BASE}?page=${page}`;
      // redirect:'error' prevents SSRF via server-side redirects
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      let json;
      try {
        json = await fetchPageWithRetry(ctx, url, { redirect: 'error' });
      } catch (error) {
        if (page === 1) throw error;
        const code = error?.status === 429 ? 'rate_limited' : 'fetch_error';
        const reason = `arbeitnow: page ${page} failed after ${MAX_RETRIES + 1} attempts: ${error?.message || String(error)}`;
        return markProviderCoverage(out, {
          status: 'partial',
          code,
          reason,
          pagesFetched: page - 1,
          maxPages,
        });
      }
      if (!json || !Array.isArray(json.data)) {
        throw new Error(
          `arbeitnow: unexpected API response on page ${page} — expected { data: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
        );
      }
      for (const j of json.data) {
        const normalized = normalizeArbeitnowJob(j, fallbackCompany);
        if (normalized) out.push(normalized);
      }
      const hasNextMetadata = json.links && typeof json.links === 'object'
        && Object.prototype.hasOwnProperty.call(json.links, 'next');
      const hasNext = hasNextMetadata
        ? typeof json.links.next === 'string' && json.links.next.trim() !== ''
        : json.data.length >= LEGACY_PER_PAGE;

      if (!hasNext) break;
      if (page >= maxPages) {
        partialCoverage = {
          status: 'partial',
          code: 'max_pages',
          reason: `${entry?.name || 'board'} truncated at max_pages=${maxPages} (API reported another page)`,
          pagesFetched: page,
          maxPages,
        };
        break;
      }
    }
    return partialCoverage ? markProviderCoverage(out, partialCoverage) : out;
  },
};
