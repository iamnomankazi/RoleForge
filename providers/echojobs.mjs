// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// EchoJobs provider — RETIRED (#2976, 2026-08-20). The board-wide public JSON
// feed this provider read (https://echojobs.io/api/jobs) no longer serves
// listings: the feed and robots.txt return a Vercel bot-protection checkpoint
// (HTTP 429), and the site's robots.txt disallows /api. Career-Ops does not
// work around bot protection, so this provider is retired rather than repaired.
//
// Keep explicit `provider: echojobs` routing so an old portal entry fails with
// a clear diagnostic instead of appearing unmatched. detect() remains
// explicit-only, so an EchoJobs URL or name never automatically selects it.
// fetch() throws before touching the HTTP context. Remove a legacy entry from
// portals.yml after seeing the diagnostic.
//
// normalizeEchojobsJob() remains unchanged for compatibility with historical
// feed records and their scan provenance.

const FEED_BASE = 'https://echojobs.io/api/jobs';

// Update tests/providers/echojobs.test.mjs if this diagnostic changes.
const RETIRED_MESSAGE =
  'echojobs: this feed is retired — echojobs.io/api/jobs is behind bot protection ' +
  '(HTTP 429, Vercel checkpoint) and robots.txt disallows /api (#2976). ' +
  'Career-Ops does not work around bot protection. Remove `provider: echojobs` from ' +
  'portals.yml. See docs/SUPPORTED_JOB_BOARDS.md.';

/**
 * Normalize a single EchoJobs feed item. Exported for tests.
 *
 * Field mapping → the normalized Job shape:
 *   - title:    `title`, trimmed (items without one are dropped).
 *   - url:      `url` — an absolute `https:` posting URL on the company's own ATS
 *               host (NOT echojobs.io), used as the dedup key. Non-https/malformed
 *               URLs drop the item.
 *   - company:  `company_name`, falling back to the portal entry name, then "EchoJobs".
 *   - location: the joined `locations` array; falls back to "Remote" when the
 *               posting has no listed place but `remote_type` is remote/hybrid.
 *   - postedAt: `posted_at` (already epoch ms) when a positive finite number.
 *
 * @param {any} j
 * @param {string} [fallbackCompany]
 * @returns {{ title: string, url: string, company: string, location: string, postedAt?: number } | null}
 */
export function normalizeEchojobsJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;

  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  // url must be an absolute https link; it lives on the company's ATS host, so
  // it is NOT restricted to echojobs.io.
  let url = '';
  const rawUrl = typeof j.url === 'string' ? j.url.trim() : '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:') url = parsed.href;
    } catch {
      // malformed URL → leave url = '' → dropped below
    }
  }
  if (!url) return null;

  const company =
    typeof j.company_name === 'string' && j.company_name.trim()
      ? j.company_name.trim()
      : fallbackCompany || 'EchoJobs';

  let location = '';
  if (Array.isArray(j.locations)) {
    location = j.locations
      .filter((l) => typeof l === 'string' && l.trim())
      .map((l) => l.trim())
      .join(', ');
  }
  if (!location && (j.remote_type === 'remote' || j.remote_type === 'hybrid')) location = 'Remote';

  /** @type {{ title: string, url: string, company: string, location: string, postedAt?: number }} */
  const job = { title, url, company, location };
  // `posted_at` is already epoch milliseconds.
  if (Number.isFinite(j.posted_at) && j.posted_at > 0) job.postedAt = j.posted_at;
  return job;
}

/** @type {Provider} */
export default {
  id: 'echojobs',

  detect(entry) {
    return entry?.provider === 'echojobs' ? { url: FEED_BASE } : null;
  },

  async fetch() {
    throw new Error(RETIRED_MESSAGE);
  },
};
