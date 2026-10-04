// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { requireUsableRows } from './_payload.mjs';

// getManfred is a board-wide, zero-auth catalogue.  The `lang` parameter is
// mandatory on the public endpoint; unlike a tenant ATS there is no useful
// careers URL to auto-detect.
const FEED_BASE = 'https://www.getmanfred.com/api/v2/public/offers';
const TRUSTED_HOST = 'www.getmanfred.com';
const OFFER_BASE = 'https://www.getmanfred.com/ofertas-empleo';
const VALID_LANGS = new Set(['EN', 'ES']);
const DEFAULT_LANG = 'EN';

function requireHttpContext(ctx) {
  if (!ctx || ctx.transport !== 'http' || typeof ctx.fetchJson !== 'function') {
    throw new Error('manfred: fetch() requires an http transport context with fetchJson');
  }
}

/** @param {string} url */
function assertManfredUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`manfred: invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') throw new Error(`manfred: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`manfred: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return parsed.href;
}

export function resolveLang(entry) {
  const raw = typeof entry?.lang === 'string' ? entry.lang.trim().toUpperCase() : '';
  return VALID_LANGS.has(raw) ? raw : DEFAULT_LANG;
}

const CURRENCY_BY_SYMBOL = new Map([
  ['€', 'EUR'], ['£', 'GBP'], ['US$', 'USD'], ['$' , 'USD'], ['MXN$', 'MXN'],
  ['CHF', 'CHF'],
]);

/** @param {unknown} raw */
export function normalizeCurrency(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(/[\s\u00a0\u202f]/g, '').toUpperCase();
  const mapped = CURRENCY_BY_SYMBOL.get(cleaned);
  if (mapped) return mapped;
  return /^[A-Z]{3}$/.test(cleaned) ? cleaned : '';
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** @param {any} offer */
export function parseCompensation(offer) {
  const nested = offer?.salary && typeof offer.salary === 'object' ? offer.salary : {};
  const from = finitePositive(offer?.salaryFrom ?? offer?.salary_min ?? offer?.minSalary ?? nested.min ?? nested.from);
  const to = finitePositive(offer?.salaryTo ?? offer?.salary_max ?? offer?.maxSalary ?? nested.max ?? nested.to);
  if (from === null && to === null) return null;
  // Mirroring one-sided bounds preserves the scanner's overlap semantics; no
  // currency or period is invented when the source does not provide one.
  const salary = { min: from ?? to, max: to ?? from };
  const currency = normalizeCurrency(offer?.currency ?? nested.currency);
  if (currency) salary.currency = currency;
  const period = typeof (offer?.salaryPeriod ?? offer?.salary_period ?? nested.period) === 'string'
    ? String(offer?.salaryPeriod ?? offer?.salary_period ?? nested.period).trim()
    : '';
  if (period) salary.period = period;
  return salary;
}

/** @param {any} offer */
export function resolveLocation(offer) {
  const listed = Array.isArray(offer?.locations)
    ? offer.locations.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
    : [];
  if (listed.length) return listed.join(', ');
  const remote = Number(offer?.remotePercentage ?? offer?.remote_percentage);
  if (!Number.isFinite(remote)) return '';
  if (remote >= 100) return 'Remote';
  if (remote > 0) return 'Hybrid';
  return '';
}

function parseDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cleanHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch { return ''; }
}

function sourceId(offer, id) {
  const raw = offer?.sourceId ?? offer?.source_id ?? offer?.id ?? id;
  return raw == null || raw === '' ? '' : String(raw);
}

/**
 * Normalize one active getManfred offer.  The board URL is the canonical
 * source; when the payload supplies an employer destination, it is selected
 * as `url` and the board URL is retained as `sourceUrl`.
 */
export function normalizeManfredOffer(offer, fallbackCompany) {
  if (!offer || typeof offer !== 'object') return null;
  const status = typeof offer.status === 'string' ? offer.status.trim().toUpperCase() : '';
  if (status !== 'ACTIVE') return null;

  const title = typeof (offer.position ?? offer.title) === 'string'
    ? String(offer.position ?? offer.title).trim() : '';
  if (!title) return null;

  const idValue = offer.id ?? offer.offerId ?? offer.offer_id;
  const id = Number(idValue);
  const slug = typeof offer.slug === 'string' ? offer.slug.trim() : '';
  if (!Number.isInteger(id) || id <= 0 || !slug) return null;

  const boardUrl = `${OFFER_BASE}/${id}/${encodeURIComponent(slug)}`;
  const destination = cleanHttpsUrl(offer.applyUrl ?? offer.apply_url ?? offer.applicationUrl
    ?? offer.jobUrl ?? offer.job_url ?? offer.link ?? offer.url);
  const url = destination || boardUrl;
  const companyValue = offer.company?.name ?? offer.companyName ?? offer.company_name;
  const company = typeof companyValue === 'string' && companyValue.trim()
    ? companyValue.trim()
    : (typeof fallbackCompany === 'string' && fallbackCompany.trim() ? fallbackCompany.trim() : 'getManfred');

  const job = { title, url, company, location: resolveLocation(offer) };
  const idString = sourceId(offer, id);
  if (idString) job.sourceId = idString;
  if (url !== boardUrl) job.sourceUrl = boardUrl;
  const descriptionValue = offer.description ?? offer.descriptionHtml ?? offer.description_html;
  if (typeof descriptionValue === 'string' && descriptionValue.trim()) job.description = descriptionValue.trim();
  const postedAt = parseDate(offer.publishedAt ?? offer.published_at ?? offer.datePublished ?? offer.createdAt);
  if (postedAt !== undefined) job.postedAt = postedAt;
  const salary = parseCompensation(offer);
  if (salary) job.salary = salary;
  if (typeof offer.employmentType === 'string' && offer.employmentType.trim()) job.employmentType = offer.employmentType.trim();
  if (Number.isFinite(Number(offer.remotePercentage))) job.remotePercentage = Number(offer.remotePercentage);
  return job;
}

function buildFeedUrl(entry) {
  return `${FEED_BASE}?lang=${resolveLang(entry)}`;
}

/** @type {Provider} */
export default {
  id: 'manfred',

  detect(entry) {
    return entry?.provider === 'manfred' ? { url: buildFeedUrl(entry) } : null;
  },

  async fetch(entry, ctx) {
    requireHttpContext(ctx);
    const url = assertManfredUrl(buildFeedUrl(entry));
    const json = await ctx.fetchJson(url, { redirect: 'error' });
    if (!Array.isArray(json)) {
      throw new Error(`manfred: unexpected API response — expected a JSON array of offers, got ${json === null ? 'null' : typeof json}`);
    }
    // CLOSED/expired catalogue entries are a valid empty result.  Validate
    // only rows that claim to be active so a stale catalogue cannot look like
    // a malformed feed while genuinely broken active rows fail closed.
    const active = json.filter((offer) => typeof offer?.status === 'string' && offer.status.trim().toUpperCase() === 'ACTIVE');
    const jobs = active.map((offer) => normalizeManfredOffer(offer, entry?.name)).filter(Boolean);
    requireUsableRows(active, jobs, 'manfred');
    return jobs;
  },
};
