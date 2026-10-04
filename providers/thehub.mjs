// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// The Hub provider — board-wide public feed used by thehub.io's jobs frontend:
// https://api.thehub.io/v2/jobsandfeatured
// Response shape: { jobs: { docs: [ { id, key, title, company: { name, ... },
//   location: { address, locality, country }, isRemote, ... } ], total, page,
//   pages, limit }, featuredJobs: { docs: [...] } }
//
// Paginated 15/page via `?page=N` (1-indexed); the response carries `pages`, so
// iteration is bounded by min(pages, max_pages). Default cap is modest (the
// board size varies); override with `max_pages` on the entry.
//
// Wire in via a `job_boards:` entry with `provider: thehub`.

const FEED_BASE = 'https://api.thehub.io/v2/jobsandfeatured';
const LISTING_URL = 'https://thehub.io/jobs';
const API_HOST = 'api.thehub.io';
const JOB_HOST = 'thehub.io';
const PER_PAGE = 15;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 67;

/** @param {string} url */
function assertHubUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`thehub: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`thehub: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== API_HOST) {
    throw new Error(`thehub: untrusted hostname "${parsed.hostname}" — must be ${API_HOST}`);
  }
  return url;
}

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Normalize a single The Hub job. Exported for unit tests.
 *
 * Field mapping → the normalized Job shape:
 *   - title:    `title`, trimmed (postings without one are dropped).
 *   - url:      `absoluteJobUrl` when present, otherwise the canonical
 *               `https://thehub.io/jobs/{id}` URL exposed by the current feed.
 *               Both forms are host-locked to `thehub.io`.
 *   - company:  `company.name`, falling back to the portal entry name, then
 *               "The Hub".
 *   - location: `location.address`, else assembled from `location.locality` /
 *               `location.country`; "Remote" is appended when `isRemote` is true.
 *   - postedAt: `publishedAt` (else `createdAt`) ISO date → epoch ms (omitted
 *               when absent/unparseable).
 *
 * @param {any} j
 * @param {string} [fallbackCompany]
 * @returns {{ title: string, url: string, company: string, location: string, sourceUrl: string, postedAt?: number } | null}
 */
export function normalizeHubJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;

  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  let url = '';
  const rawUrl = typeof j.absoluteJobUrl === 'string' ? j.absoluteJobUrl.trim() : '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:' && parsed.hostname === JOB_HOST) url = parsed.href;
    } catch {
      // malformed URL → leave url = '' → dropped below
    }
  }
  if (!url && typeof j.id === 'string' && /^[a-f0-9]{24}$/i.test(j.id.trim())) {
    url = `${LISTING_URL}/${j.id.trim()}`;
  }
  if (!url) return null;

  const company =
    j.company && typeof j.company === 'object' && typeof j.company.name === 'string' && j.company.name.trim()
      ? j.company.name.trim()
      : typeof fallbackCompany === 'string' && fallbackCompany.trim()
        ? fallbackCompany.trim()
        : 'The Hub';

  const loc = j.location && typeof j.location === 'object' ? j.location : {};
  const address = typeof loc.address === 'string' ? loc.address.trim() : '';
  const locality = typeof loc.locality === 'string' ? loc.locality.trim() : '';
  const country = typeof loc.country === 'string' ? loc.country.trim() : '';
  const base = address || [locality, country].filter(Boolean).join(', ');
  const location = [base, j.isRemote === true ? 'Remote' : ''].filter(Boolean).join(', ');

  /** @type {{ title: string, url: string, company: string, location: string, sourceUrl: string, postedAt?: number }} */
  const job = { title, url, company, location, sourceUrl: LISTING_URL };
  const postedAt = toEpochMs(j.publishedAt) ?? toEpochMs(j.createdAt);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

/** @type {Provider} */
export default {
  id: 'thehub',

  async fetch(entry, ctx) {
    assertHubUrl(FEED_BASE);
    const maxPages = resolveMaxPages(entry);
    const fallbackCompany = entry?.name;
    const out = [];
    const seenUrls = new Set();

    for (let page = 1; page <= maxPages; page++) {
      const url = `${FEED_BASE}?page=${page}&countryCode=EU&sorting=newJobs`;
      // redirect:'error' prevents SSRF via server-side redirects
      let json;
      try {
        json = await ctx.fetchJson(url, { redirect: 'error' });
      } catch (error) {
        if (error?.status === 404 || error?.status === 410) {
          // This is a board-wide API endpoint, not a tenant/ATS slug.
          error.kind = 'endpoint_gone';
          error.providerEndpoint = FEED_BASE;
        }
        throw error;
      }
      if (!json?.jobs || !Array.isArray(json.jobs.docs)) {
        throw new Error(
          `thehub: unexpected API response on page ${page} — expected { jobs: { docs: [...] } }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
        );
      }
      const featured = Array.isArray(json.featuredJobs?.docs) ? json.featuredJobs.docs : [];
      for (const j of [...featured, ...json.jobs.docs]) {
        const normalized = normalizeHubJob(j, fallbackCompany);
        if (normalized && !seenUrls.has(normalized.url)) {
          seenUrls.add(normalized.url);
          out.push(normalized);
        }
      }
      // Stop at the last page: a short page, or page >= the reported total pages.
      if (json.jobs.docs.length < PER_PAGE) break;
      if (Number.isInteger(json.jobs.pages) && page >= json.jobs.pages) break;
    }
    return out;
  },
};
