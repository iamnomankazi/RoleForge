// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { htmlToText } from './_html-to-text.mjs';
import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry, fetchTextWithRetry } from './_http.mjs';
import { requiredArray, requireUsableRows } from './_payload.mjs';
import { markProviderCoverage } from './_result.mjs';

const API_HOST = 'api.getro.com';
const API_BASE = `https://${API_HOST}/api/v2/collections`;
const HITS_PER_PAGE = 20;
const DEFAULT_MAX_PAGES = 40;
const HARD_MAX_PAGES = 1_500;
const DEFAULT_MAX_AGE_DAYS = 90;
const INTER_PAGE_DELAY_MS = 150;
const MAX_DESCRIPTION_CHARS = 4_000;

function resolveCollectionOverride(entry) {
  const raw = entry?.getro_collection ?? entry?.collection_id ?? entry?.getro?.collection_id ?? entry?.getro?.collection;
  if (raw == null) return null;
  const value = String(raw).trim();
  return /^\d+$/.test(value) && /[1-9]/.test(value) ? value : null;
}

/**
 * Parse a public HTTPS careers URL. Vanity hosts are expected; private and
 * local targets are rejected before any request is attempted.
 * @param {unknown} value
 * @returns {URL|null}
 */
export function resolveGetroCareersUrl(value) {
  let parsed;
  try { parsed = new URL(typeof value === 'string' ? value : ''); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host || host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  if (host === 'localhost' || host === 'localhost.localdomain') return null;
  if (host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return null;
  return parsed;
}

/** Extract `network.id` from a Getro frontend's __NEXT_DATA__ payload. */
export function extractCollectionId(html) {
  if (typeof html !== 'string') return null;
  const match = html.match(/<script\b[^>]*\sid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  let data;
  try { data = JSON.parse(match[1]); } catch { return null; }
  const candidates = [
    data?.props?.pageProps?.network?.id,
    data?.props?.pageProps?.network?.collection_id,
    data?.props?.pageProps?.collection?.id,
    data?.network?.id,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^\d+$/.test(value) && /[1-9]/.test(value)) return value;
  }
  return null;
}

async function resolveCollectionId(entry, ctx, careersUrl) {
  const override = resolveCollectionOverride(entry);
  if (override) return override;
  if (typeof ctx?.fetchText !== 'function') {
    throw new Error(`getro: ${entry?.name || careersUrl.href} needs ctx.fetchText to resolve collection id`);
  }
  const html = await fetchTextWithRetry(ctx, careersUrl.href, {
    redirect: 'error',
    headers: { accept: 'text/html', 'user-agent': BROWSER_LIKE_USER_AGENT },
  });
  const id = extractCollectionId(html);
  if (!id) {
    throw new Error(`getro: ${entry?.name || careersUrl.href} — could not resolve collection_id from ${careersUrl.href}`);
  }
  return id;
}

function toEpochMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function safeUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim(), base);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch { return null; }
}

function locationString(job) {
  const values = [];
  for (const key of ['locations', 'searchable_locations']) {
    if (!Array.isArray(job?.[key])) continue;
    for (const location of job[key]) {
      if (typeof location === 'string' && location.trim()) values.push(location.trim());
      else if (location && typeof location === 'object') {
        const label = [location.label, location.name, location.value, location.city, location.country]
          .find((value) => typeof value === 'string' && value.trim());
        if (label) values.push(label.trim());
      }
    }
    if (values.length) break;
  }
  if ((String(job?.work_mode || '').toLowerCase() === 'remote' || job?.remote === true)
      && !values.some((value) => /remote/i.test(value))) values.push('Remote');
  return [...new Set(values)].join(', ');
}

function salary(job) {
  const period = typeof job?.compensation_period === 'string' ? job.compensation_period.trim().toLowerCase() : '';
  if (period && period !== 'year') return null;
  const minimum = Number(job?.compensation_amount_min_cents);
  const maximum = Number(job?.compensation_amount_max_cents);
  const min = Number.isFinite(minimum) && minimum > 0 ? minimum / 100 : null;
  const max = Number.isFinite(maximum) && maximum > 0 ? maximum / 100 : null;
  if (min === null && max === null) return null;
  return {
    min: min ?? max,
    max: max ?? min,
    currency: typeof job?.compensation_currency === 'string' ? job.compensation_currency.trim() : '',
  };
}

/** Normalize one Getro API job while preserving board provenance. */
export function normalizeGetroJob(value, sourceUrl, fallbackCompany = 'Getro') {
  if (!value || typeof value !== 'object') return null;
  const row = /** @type {Record<string, any>} */ (value);
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const rawRowUrl = safeUrl(row.url, sourceUrl);
  const rawApplyUrl = safeUrl(row.applyUrl || row.apply_url, sourceUrl);
  const destination = rawApplyUrl || rawRowUrl;
  if (!title || !destination) return null;
  const rowSource = safeUrl(row.sourceUrl || row.source_url || row.jobUrl || row.listingUrl, sourceUrl)
    || (rawApplyUrl && rawRowUrl && rawRowUrl !== rawApplyUrl ? rawRowUrl : sourceUrl);
  const company = [row.organization?.name, row.organization_name, row.company?.name, row.companyName, fallbackCompany]
    .find((candidate) => typeof candidate === 'string' && candidate.trim()) || fallbackCompany;
  const job = {
    title,
    url: destination,
    company: typeof company === 'string' && company.trim() ? company.trim() : 'Getro',
    location: locationString(row),
    sourceUrl: rowSource,
  };
  const id = row.id ?? row.jobId ?? row.job_id;
  if ((typeof id === 'string' && id.trim()) || (typeof id === 'number' && Number.isFinite(id))) job.sourceId = String(id).trim();
  const postedAt = toEpochMs(row.created_at ?? row.createdAt ?? row.published_at ?? row.timeStamp);
  if (postedAt !== null) job.postedAt = postedAt;
  const description = htmlToText(row.description ?? row.descriptionHtml ?? row.description_html);
  if (description) job.description = description.slice(0, MAX_DESCRIPTION_CHARS);
  const pay = salary(row);
  if (pay) job.salary = pay;
  return job;
}

function pageSignature(rows) {
  return rows.map((row) => String(row?.id ?? row?.jobId ?? row?.url ?? '')).join('|');
}

/** @type {Provider} */
export default {
  id: 'getro',

  detect(entry) {
    const id = resolveCollectionOverride(entry);
    if (id) return { url: `${API_BASE}/${id}/search/jobs` };
    // Explicit provider config is sufficient when the collection id will be
    // resolved from the board's own __NEXT_DATA__ during fetch().
    if (entry?.provider === 'getro' && resolveGetroCareersUrl(entry?.careers_url)) {
      return { url: resolveGetroCareersUrl(entry.careers_url).href };
    }
    return null;
  },

  async fetch(entry, ctx) {
    if (typeof ctx?.fetchJson !== 'function') throw new Error('getro: ctx.fetchJson transport is required');
    const careersUrl = resolveGetroCareersUrl(entry?.careers_url);
    if (!careersUrl) throw new Error(`getro: ${entry?.name || 'entry'} needs an https careers_url on a public host`);
    const collectionId = await resolveCollectionId(entry, ctx, careersUrl);
    const endpoint = `${API_BASE}/${collectionId}/search/jobs`;
    const requestedMax = positivePages(entry?.getro_max_pages, DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
    const contextMax = positivePages(ctx?.maxPages, requestedMax, requestedMax);
    const maxPages = Math.min(requestedMax, contextMax);
    const ageDays = Number.isFinite(entry?.getro_max_age_days) && entry.getro_max_age_days >= 0
      ? Number(entry.getro_max_age_days) : DEFAULT_MAX_AGE_DAYS;
    const cutoff = ageDays > 0 ? Date.now() - ageDays * 86_400_000 : 0;
    const jobs = [];
    let total = Infinity;
    let partial = null;
    const signatures = new Set();
    let pagesFetched = 0;

    for (let page = 0; page < maxPages && page * HITS_PER_PAGE < total; page++) {
      if (page > 0) {
        if (typeof ctx?.sleep === 'function') await ctx.sleep(INTER_PAGE_DELAY_MS);
        else await new Promise((resolve) => setTimeout(resolve, INTER_PAGE_DELAY_MS));
      }
      let payload;
      try {
        payload = await fetchJsonWithRetry(ctx, endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            referer: `${careersUrl.origin}/`,
          },
          body: JSON.stringify({ hitsPerPage: HITS_PER_PAGE, page, filters: { page }, query: '' }),
        });
      } catch (error) {
        if (page === 0) throw error;
        partial = {
          status: 'partial', code: 'network_error',
          reason: `${entry?.name || 'board'} truncated after page ${page}: ${error instanceof Error ? error.message : String(error)}`,
          pagesFetched,
          maxPages,
        };
        break;
      }
      pagesFetched++;
      const rows = requiredArray(payload, 'results.jobs', `getro page ${page}`);
      const normalized = rows.map((row) => normalizeGetroJob(row, careersUrl.href, entry?.name || 'Getro'));
      requireUsableRows(rows, normalized.filter(Boolean), `getro page ${page}`);
      if (Number.isInteger(payload?.results?.count) && payload.results.count >= 0) total = payload.results.count;
      const signature = pageSignature(rows);
      if (signature && signatures.has(signature)) {
        partial = {
          status: 'partial', code: 'repeated_page',
          reason: `${entry?.name || 'board'} repeated page ${page}; pagination stopped`,
          pagesFetched,
          maxPages,
        };
        break;
      }
      signatures.add(signature);

      let reachedOld = false;
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const created = toEpochMs(row?.created_at ?? row?.createdAt ?? row?.published_at ?? row?.timeStamp);
        if (cutoff > 0 && created !== null && created < cutoff) { reachedOld = true; continue; }
        const job = normalized[index];
        if (job) jobs.push(job);
      }
      if (reachedOld || rows.length < HITS_PER_PAGE || page * HITS_PER_PAGE + rows.length >= total) break;
      if (page + 1 >= maxPages && total > (page + 1) * HITS_PER_PAGE) {
        partial = {
          status: 'partial', code: 'max_pages',
          reason: `${entry?.name || 'board'} truncated at max_pages=${maxPages} (${total} total jobs)`,
          pagesFetched,
          maxPages,
        };
        break;
      }
    }
    return partial ? markProviderCoverage(jobs, partial) : jobs;
  },
};

function positivePages(value, fallback, cap) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, cap) : fallback;
}
