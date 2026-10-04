// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { htmlToText } from './_html-to-text.mjs';
import { requiredArray, requireUsableRows } from './_payload.mjs';
import { markProviderCoverage } from './_result.mjs';

const ENDPOINT_PATH = '/api-boards/search-jobs';
const DEFAULT_SIZE = 500;
const MAX_SIZE = 2_000;
const MAX_DESCRIPTION_CHARS = 4_000;

/**
 * Consider boards are hosted on vanity domains.  Keep the URL configurable,
 * but only permit a public HTTPS origin and never follow redirects from it.
 * @param {unknown} value
 * @returns {string|null}
 */
export function resolveConsiderOrigin(value) {
  let parsed;
  try { parsed = new URL(typeof value === 'string' ? value : ''); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host || host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  if (host === 'localhost' || host === 'localhost.localdomain') return null;
  if (host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return null;
  return parsed.origin;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function resolveBoardId(entry) {
  const raw = entry?.consider_board ?? entry?.consider?.board_id ?? entry?.consider?.boardId;
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  return String(raw).trim();
}

function toEpochMs(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function safeUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim(), base);
    if (parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function normalizeLocations(job) {
  const values = [];
  if (Array.isArray(job?.locations)) {
    for (const location of job.locations) {
      if (typeof location === 'string' && location.trim()) values.push(location.trim());
      else if (location && typeof location === 'object') {
        const text = [location.label, location.name, location.value, location.city, location.country]
          .find((item) => typeof item === 'string' && item.trim());
        if (text) values.push(text.trim());
      }
    }
  }
  if (Array.isArray(job?.normalizedLocations)) {
    for (const location of job.normalizedLocations) {
      const text = location && typeof location === 'object' ? (location.label || location.value || location.name) : location;
      if (typeof text === 'string' && text.trim()) values.push(text.trim());
    }
  }
  if (job?.remote === true && !values.some((value) => /remote/i.test(value))) values.push('Remote');
  return [...new Set(values)].join(', ');
}

/**
 * Normalize one Consider listing. `applyUrl` is preferred as the destination;
 * the board's `url` is retained as sourceUrl whenever it differs.
 * @param {unknown} value
 * @param {string} origin
 * @param {string} fallbackCompany
 * @returns {object|null}
 */
export function normalizeConsiderJob(value, origin, fallbackCompany = 'Consider') {
  if (!value || typeof value !== 'object') return null;
  const row = /** @type {Record<string, any>} */ (value);
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  if (!title) return null;

  const boardUrl = safeUrl(row.url || row.sourceUrl || row.jobUrl, origin);
  const applyUrl = safeUrl(row.applyUrl || row.apply_url || row.destinationUrl, origin);
  const destination = applyUrl || boardUrl;
  if (!destination) return null;

  const company = typeof row.companyName === 'string' && row.companyName.trim()
    ? row.companyName.trim()
    : typeof row.company === 'string' && row.company.trim()
      ? row.company.trim()
      : fallbackCompany;
  const job = {
    title,
    url: destination,
    company: company || 'Consider',
    location: normalizeLocations(row),
    sourceUrl: boardUrl && boardUrl !== destination ? boardUrl : `${origin}/jobs`,
  };
  const sourceId = row.id ?? row.jobId ?? row.job_id ?? row._id;
  if ((typeof sourceId === 'string' && sourceId.trim()) || (typeof sourceId === 'number' && Number.isFinite(sourceId))) {
    job.sourceId = String(sourceId).trim();
  }
  const postedAt = toEpochMs(row.timeStamp ?? row.timestamp ?? row.createdAt ?? row.created_at);
  if (postedAt !== undefined) job.postedAt = postedAt;
  const description = htmlToText(row.description ?? row.descriptionHtml ?? row.description_html);
  if (description) job.description = description.slice(0, MAX_DESCRIPTION_CHARS);
  return job;
}

/** @type {Provider} */
export default {
  id: 'consider',

  detect(entry) {
    const origin = resolveConsiderOrigin(entry?.careers_url);
    return resolveBoardId(entry) && origin ? { url: `${origin}${ENDPOINT_PATH}` } : null;
  },

  async fetch(entry, ctx) {
    if (typeof ctx?.fetchJson !== 'function') throw new Error('consider: ctx.fetchJson transport is required');
    const origin = resolveConsiderOrigin(entry?.careers_url);
    if (!origin) throw new Error(`consider: ${entry?.name || 'entry'} needs an https careers_url on a public host`);
    const boardId = resolveBoardId(entry);
    if (!boardId) throw new Error(`consider: ${entry?.name || 'entry'} needs a 'consider_board' id in portals.yml`);

    const configured = positiveInteger(entry?.consider_size ?? entry?.consider?.size);
    const size = Math.min(configured || DEFAULT_SIZE, MAX_SIZE);
    const endpoint = `${origin}${ENDPOINT_PATH}`;
    // Some Consider tenants enforce a CSRF token established by the board
    // landing page.  The shared context exposes no response headers, so the
    // adapter keeps a narrow test/host seam: callers that already have a
    // handshake can provide cookie/token values without any global fetch.
    const handshake = typeof ctx?._acquireHandshake === 'function'
      ? await ctx._acquireHandshake(origin)
      : null;
    const csrfHeaders = {};
    if (handshake?.cookie) csrfHeaders.cookie = String(handshake.cookie);
    if (handshake?.csrfToken) csrfHeaders['x-csrf-token'] = String(handshake.csrfToken);
    const payload = await ctx.fetchJson(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        referer: `${origin}/jobs`,
        ...csrfHeaders,
      },
      body: JSON.stringify({
        meta: { size },
        board: { id: boardId, isParent: true },
        query: { promoteFeatured: true },
      }),
    });

    const rows = requiredArray(payload, 'jobs', 'consider');
    const normalized = rows.map((row) => normalizeConsiderJob(row, origin, entry?.name || 'Consider')).filter(Boolean);
    requireUsableRows(rows, normalized, 'consider');
    const bounded = normalized.slice(0, size);

    // A board may expose more rows than the requested size. Preserve a typed
    // partial result rather than claiming complete coverage silently.
    const totalValue = payload?.total ?? payload?.count ?? payload?.meta?.total;
    const total = Number.isInteger(totalValue) && totalValue >= 0 ? totalValue : null;
    if (normalized.length > size || (total !== null && total > bounded.length)) {
      return markProviderCoverage(bounded, {
        status: 'partial',
        code: 'max_size',
        reason: `${entry?.name || 'board'} truncated at consider_size=${size} (${total} total jobs)`,
        pagesFetched: 1,
        maxPages: 1,
      });
    }
    return bounded;
  },
};
