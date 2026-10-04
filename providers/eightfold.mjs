// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry, sleep } from './_http.mjs';
import { requiredArray, requireUsableRows } from './_payload.mjs';
import { markProviderCoverage } from './_result.mjs';

const HOST_RE = /^[a-z0-9-]+\.eightfold\.ai$/i;
const PAGE_SIZE = 10;
const DEFAULT_MAX_PAGES = 200;
const HARD_MAX_PAGES = 1000;
const INTER_PAGE_DELAY_MS = 250;
const RETRY_POLICY = { retries: 3 };

function resolveTenant(entry) {
  for (const raw of [entry?.api, entry?.careers_url]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let parsed;
    try { parsed = new URL(raw); } catch { continue; }
    if (parsed.protocol !== 'https:' || !HOST_RE.test(parsed.hostname)) continue;
    const override = typeof entry?.domain === 'string' && entry.domain.trim() ? entry.domain.trim() : '';
    const domain = override || parsed.searchParams.get('domain')?.trim() || null;
    return { host: parsed.hostname.toLowerCase(), domain };
  }
  return null;
}

function buildApiUrl(tenant, start = 0) {
  const params = new URLSearchParams();
  if (tenant.domain) params.set('domain', tenant.domain);
  params.set('start', String(start));
  params.set('num', String(PAGE_SIZE));
  return `https://${tenant.host}/api/apply/v2/jobs?${params}`;
}

function buildJobUrl(tenant, pid) {
  const params = new URLSearchParams({ pid });
  if (tenant.domain) params.set('domain', tenant.domain);
  return `https://${tenant.host}/careers?${params}`;
}

function displayUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch { return ''; }
}

function epochSecondsToMs(value) {
  const seconds = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
}

function assembleLocation(position) {
  const parts = [];
  if (typeof position.location === 'string' && position.location.trim()) parts.push(position.location.trim());
  if (Array.isArray(position.locations)) {
    for (const item of position.locations) {
      const value = typeof item === 'string' ? item
        : item && typeof item === 'object' ? (item.label ?? item.name ?? item.value ?? item.city) : '';
      if (typeof value === 'string' && value.trim()) parts.push(value.trim());
    }
  }
  return [...new Set(parts)].join(' · ');
}

/** Normalize one Eightfold job. Missing or malformed records are omitted. */
export function normalizeEightfoldJob(value, tenant, companyName = 'Eightfold') {
  if (!value || typeof value !== 'object') return null;
  const row = /** @type {Record<string, any>} */ (value);
  const title = typeof row.name === 'string' && row.name.trim()
    ? row.name.trim()
    : typeof row.posting_name === 'string' ? row.posting_name.trim() : '';
  if (!title) return null;

  const pid = row.id == null ? '' : String(row.id).trim();
  const canonicalUrl = displayUrl(row.canonicalPositionUrl);
  const url = canonicalUrl || (pid ? buildJobUrl(tenant, pid) : '');
  if (!url) return null;

  const job = {
    title,
    url,
    company: typeof companyName === 'string' && companyName.trim() ? companyName.trim() : 'Eightfold',
    location: assembleLocation(row),
  };
  if (pid) job.sourceId = pid;
  const sourceUrl = displayUrl(row.sourceUrl ?? row.source_url ?? row.listingUrl)
    || (canonicalUrl && canonicalUrl !== url ? canonicalUrl : '');
  if (sourceUrl && sourceUrl !== url) job.sourceUrl = sourceUrl;
  const postedAt = epochSecondsToMs(row.t_create) ?? epochSecondsToMs(row.t_update);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

function resolveMaxPages(entry, ctx) {
  const configured = Number.isInteger(entry?.max_pages) && entry.max_pages > 0
    ? Math.min(entry.max_pages, HARD_MAX_PAGES) : DEFAULT_MAX_PAGES;
  return Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0
    ? Math.min(configured, ctx.maxPages) : configured;
}

/** @type {Provider} */
export default {
  id: 'eightfold',

  detect(entry) {
    const tenant = resolveTenant(entry);
    return tenant ? { url: buildApiUrl(tenant) } : null;
  },

  async fetch(entry, ctx) {
    if (typeof ctx?.fetchJson !== 'function') throw new Error('eightfold: ctx.fetchJson transport is required');
    const tenant = resolveTenant(entry);
    if (!tenant) throw new Error(`eightfold: ${entry?.name || 'entry'} needs a tenant careers_url or api on *.eightfold.ai`);

    const maxPages = resolveMaxPages(entry, ctx);
    const jobs = [];
    let total = null;
    let pagesFetched = 0;
    let lastPageLength = 0;
    let reachedEnd = false;

    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = buildApiUrl(tenant, page * PAGE_SIZE);
      const payload = await fetchJsonWithRetry(ctx, url, {
        redirect: 'error',
        headers: { 'user-agent': BROWSER_LIKE_USER_AGENT, accept: 'application/json' },
      }, RETRY_POLICY);
      const rows = requiredArray(payload, 'positions', 'eightfold');
      const normalized = rows.map((row) => normalizeEightfoldJob(row, tenant, entry?.name || 'Eightfold'));
      requireUsableRows(rows, normalized.filter(Boolean), `eightfold page ${page + 1}`);
      jobs.push(...normalized.filter(Boolean));
      pagesFetched++;
      lastPageLength = rows.length;
      if (total === null && Number.isFinite(payload?.count) && payload.count >= 0) total = payload.count;

      // A short page is authoritative even when count includes pre-filtered rows.
      if (rows.length < PAGE_SIZE) { reachedEnd = true; break; }
      if (total !== null && (page + 1) * PAGE_SIZE >= total) { reachedEnd = true; break; }
    }

    const hasMore = !reachedEnd && (total !== null
      ? pagesFetched * PAGE_SIZE < total
      : lastPageLength === PAGE_SIZE);
    if (hasMore && pagesFetched >= maxPages) {
      return markProviderCoverage(jobs, {
        status: 'partial', code: 'max_pages',
        reason: `${entry?.name || 'Eightfold'} truncated at max_pages=${maxPages}${total === null ? '' : ` (${total} reported positions)`}`,
        pagesFetched, maxPages,
      });
    }
    return jobs;
  },
};
