// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';
import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry, sleep } from './_http.mjs';
import { requiredArray, requireUsableRows } from './_payload.mjs';
import { markProviderCoverage } from './_result.mjs';

// Numbered Oracle apex domains are deliberately bounded to 1..99.
const HOST_RE = /^[a-z0-9-]+\.fa\.(?:[a-z0-9-]+\.)?(?:ocs\.)?oraclecloud(?:[1-9][0-9]?)?\.com$/i;
const PAGE_SIZE = 200;
const HARD_MAX_PAGES = 25;
const INTER_PAGE_DELAY_MS = 250;
const RETRY_POLICY = { retries: 3 };
const FACETS = 'LOCATIONS%3BWORK_LOCATIONS%3BWORKPLACE_TYPES%3BTITLES%3BCATEGORIES%3BORGANIZATIONS%3BPOSTING_DATES%3BFLEX_FIELDS';

function validSegment(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value); }

function resolveSite(entry) {
  for (const raw of [entry?.api, entry?.careers_url]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let parsed;
    try { parsed = new URL(raw); } catch { continue; }
    if (parsed.protocol !== 'https:' || !HOST_RE.test(parsed.hostname)) continue;
    const segments = parsed.pathname.split('/').filter(Boolean);
    const ceIndex = segments.indexOf('CandidateExperience');
    const langCandidate = ceIndex >= 0 ? segments[ceIndex + 1] : '';
    const lang = validSegment(langCandidate) ? langCandidate : 'en';
    const sitesIndex = segments.indexOf('sites');
    const siteCandidate = sitesIndex >= 0 ? segments[sitesIndex + 1] : '';
    const configuredSite = typeof entry?.siteNumber === 'string' ? entry.siteNumber.trim() : '';
    const siteNumber = configuredSite || (validSegment(siteCandidate) ? siteCandidate : 'CX_1');
    if (!validSegment(siteNumber)) continue;
    const configuredLocation = entry?.locationId == null ? '' : String(entry.locationId).trim();
    const locationId = configuredLocation && /^\d+$/.test(configuredLocation) ? configuredLocation : null;
    return { host: parsed.hostname.toLowerCase(), lang, siteNumber, locationId };
  }
  return null;
}

function buildApiUrl(site, offset = 0) {
  const finderParams = [
    `siteNumber=${site.siteNumber}`, `facetsList=${FACETS}`, `limit=${PAGE_SIZE}`,
    'sortBy=POSTING_DATES_DESC', `offset=${offset}`,
  ];
  if (site.locationId) finderParams.push(`locationId=${site.locationId}`);
  const finder = `findReqs;${finderParams.join(',')}`;
  const expand = encodeURIComponent('requisitionList.workLocation,requisitionList.secondaryLocations');
  return `https://${site.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
    + `?onlyData=true&expand=${expand}&finder=${finder}&limit=${PAGE_SIZE}&offset=${offset}`;
}

function buildJobUrl(site, id) {
  return `https://${site.host}/hcmUI/CandidateExperience/${encodeURIComponent(site.lang)}/sites/${encodeURIComponent(site.siteNumber)}/job/${encodeURIComponent(id)}`;
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try { const parsed = new URL(value.trim()); return parsed.protocol === 'https:' ? parsed.href : ''; } catch { return ''; }
}

function toEpochMs(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function assembleLocation(req) {
  let base = typeof req.PrimaryLocation === 'string' ? req.PrimaryLocation.trim() : '';
  if (!base && Array.isArray(req.workLocation) && req.workLocation.length) {
    const location = req.workLocation[0] || {};
    base = [location.TownOrCity, location.Region, location.Country]
      .filter((part) => typeof part === 'string' && part.trim()).join(', ');
  }
  const remote = req.WorkplaceTypeCode === 'ORA_REMOTE' ? 'Remote'
    : req.WorkplaceTypeCode === 'ORA_HYBRID' ? 'Hybrid' : '';
  return [base, remote].filter(Boolean).join(' · ');
}

/** Normalize a requisition, requiring a title and a safe public URL. */
export function normalizeOracleJob(value, site, companyName = 'Oracle Recruiting Cloud') {
  if (!value || typeof value !== 'object') return null;
  const req = /** @type {Record<string, any>} */ (value);
  const title = typeof req.Title === 'string' ? req.Title.trim() : '';
  if (!title) return null;
  const idValue = req.Id ?? req.RequisitionNumber;
  const id = idValue == null ? '' : String(idValue).trim();
  const externalUrl = safeHttpsUrl(req.ExternalURL ?? req.ExternalUrl);
  const url = externalUrl || (id ? buildJobUrl(site, id) : '');
  if (!url) return null;
  const job = {
    title, url,
    company: typeof companyName === 'string' && companyName.trim() ? companyName.trim() : 'Oracle Recruiting Cloud',
    location: assembleLocation(req),
  };
  if (id) job.sourceId = id;
  const sourceUrl = safeHttpsUrl(req.SourceURL ?? req.sourceUrl ?? req.DisplayURL);
  if (sourceUrl && sourceUrl !== url) job.sourceUrl = sourceUrl;
  if (typeof req.ShortDescriptionStr === 'string' && req.ShortDescriptionStr.trim()) {
    job.description = decodeEntities(req.ShortDescriptionStr).trim();
  }
  const postedAt = toEpochMs(req.PostedDate);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

function resolveMaxPages(entry, ctx) {
  const configured = Number.isInteger(entry?.max_pages) && entry.max_pages > 0
    ? Math.min(entry.max_pages, HARD_MAX_PAGES) : HARD_MAX_PAGES;
  return Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0
    ? Math.min(configured, ctx.maxPages) : configured;
}

/** @type {Provider} */
export default {
  id: 'oraclecloud',

  detect(entry) {
    const site = resolveSite(entry);
    return site ? { url: buildApiUrl(site) } : null;
  },

  async fetch(entry, ctx) {
    if (typeof ctx?.fetchJson !== 'function') throw new Error('oraclecloud: ctx.fetchJson transport is required');
    const site = resolveSite(entry);
    if (!site) throw new Error(`oraclecloud: ${entry?.name || 'entry'} needs an Oracle Candidate Experience URL on a supported *.fa.*.oraclecloud host`);
    const maxPages = resolveMaxPages(entry, ctx);
    const jobs = [];
    let total = null;
    let pagesFetched = 0;
    let lastPageLength = 0;
    let reachedEnd = false;

    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const offset = page * PAGE_SIZE;
      const payload = await fetchJsonWithRetry(ctx, buildApiUrl(site, offset), {
        redirect: 'error',
        headers: { 'user-agent': BROWSER_LIKE_USER_AGENT, accept: 'application/json' },
      }, RETRY_POLICY);
      const items = requiredArray(payload, 'items', 'oraclecloud');
      if (!items.length || !items[0] || typeof items[0] !== 'object') {
        throw new Error('oraclecloud: malformed response (expected items[0] requisition envelope)');
      }
      const envelope = items[0];
      const rows = requiredArray(envelope, 'requisitionList', `oraclecloud page ${page + 1}`);
      const normalized = rows.map((row) => normalizeOracleJob(row, site, entry?.name || 'Oracle Recruiting Cloud'));
      requireUsableRows(rows, normalized.filter(Boolean), `oraclecloud page ${page + 1}`);
      jobs.push(...normalized.filter(Boolean));
      pagesFetched++;
      lastPageLength = rows.length;
      const reportedTotal = envelope.TotalJobsCount;
      if (total === null && Number.isFinite(reportedTotal) && reportedTotal >= 0) total = reportedTotal;

      // ORC can return a short middle page and stale hasMore=false. TotalJobsCount
      // governs continuation; an empty page always ends the walk.
      if (rows.length === 0) { reachedEnd = true; break; }
      if (total !== null) {
        if (offset + PAGE_SIZE >= total) { reachedEnd = true; break; }
      } else if (rows.length < PAGE_SIZE) { reachedEnd = true; break; }
    }

    const hasMore = !reachedEnd && (total !== null
      ? pagesFetched * PAGE_SIZE < total
      : lastPageLength === PAGE_SIZE);
    if (hasMore && pagesFetched >= maxPages) {
      return markProviderCoverage(jobs, {
        status: 'partial', code: 'max_pages',
        reason: `${entry?.name || 'Oracle Recruiting Cloud'} truncated at max_pages=${maxPages}${total === null ? '' : ` (${total} reported requisitions)`}`,
        pagesFetched, maxPages,
      });
    }
    return jobs;
  },
};
