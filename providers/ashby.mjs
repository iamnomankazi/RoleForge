// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Ashby provider — hits the public posting-api endpoint.
// Auto-detects from careers_url pattern `https://jobs.ashbyhq.com/<slug>`.
//
// Ashby's public posting-api carries a ~10s+ server-side latency floor
// (response time is independent of board size) and rate-limits repeated
// unauthenticated hits. The global default timeout (10s, providers/_http.mjs)
// sits right on that floor, so requests race the timeout and abort. We give
// Ashby a longer timeout plus a backoff+jitter retry (the backoff spaces
// requests out to dodge rate-limiting).
// See .planning/codebase/ashby-scan-abort-diagnosis.md.
import { htmlToText } from './_html-to-text.mjs';

const ASHBY_TIMEOUT_MS = 30_000;
const ASHBY_RETRIES = 2;

// Annualization multipliers for different compensation intervals
const INTERVAL_MULTIPLIERS = {
  '1 HOUR': 2080,
  '1 DAY': 260,
  '1 WEEK': 52,
  '2 WEEK': 26,
  '0.5 MONTH': 24,
  '1 MONTH': 12,
  '2 MONTH': 6,
  '3 MONTH': 4,
  '6 MONTH': 2,
  '1 YEAR': 1,
};

/**
 * Parse compensation data from Ashby job object.
 * Returns structured salary object with min, max, and currency,
 * or null if no valid compensation data exists.
 * @param {any} job - Ashby job object
 * @returns {{min: number, max: number, currency: string}|null}
 */
export function parseCompensation(job) {
  const comp = job?.compensation;
  if (!comp) return null;

  const interval = /** @type {keyof typeof INTERVAL_MULTIPLIERS} */ (comp.interval || '1 YEAR');
  const multiplier = INTERVAL_MULTIPLIERS[interval];
  if (!multiplier) return null;

  // Coerce and validate numeric fields — malformed API payloads must not propagate
  /** @param {any} v */
  const normalizeNum = (v) => {
    if (v == null) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const minValue = normalizeNum(comp.minValue);
  const maxValue = normalizeNum(comp.maxValue);
  const currency = typeof comp.currency === 'string' ? comp.currency.trim() : '';

  // If neither min nor max is provided, no valid compensation
  if (minValue == null && maxValue == null) return null;

  // Annualize the values
  const min = minValue != null ? minValue * multiplier : null;
  const max = maxValue != null ? maxValue * multiplier : null;

  // Must have at least one valid annual value
  if (min == null && max == null) return null;

  // Ensure correct ordering (min <= max)
  const resolvedMin = /** @type {number} */ (min ?? max);
  const resolvedMax = /** @type {number} */ (max ?? min);
  return {
    min: Math.min(resolvedMin, resolvedMax),
    max: Math.max(resolvedMin, resolvedMax),
    currency: currency.toUpperCase(),
  };
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  const url = entry.careers_url || '';
  const match = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (!match) return null;
  return `https://api.ashbyhq.com/posting-api/job-board/${match[1]}?includeCompensation=true`;
}

function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((r) => setTimeout(r, ms));
}

// Ashby publishes ISO timestamps. Require an explicit time zone and validate
// calendar fields before Date.parse(), which otherwise rolls invalid days into
// the following month.
function toEpochMs(value) {
  if (typeof value !== 'string') return undefined;
  const timestamp = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i.exec(timestamp);
  if (!match) return undefined;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysPerMonth[month - 1]
      || hour > 23 || minute > 59 || second > 59) return undefined;

  if (zone.toUpperCase() !== 'Z') {
    const [offsetHour, offsetMinute] = zone.slice(1).split(':').map(Number);
    if (zone === '-00:00' || offsetHour > 23 || offsetMinute > 59) return undefined;
  }

  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// Build the full location string from primary and secondary locations.
// Ashby's posting-api puts extra hiring regions in `secondaryLocations[]`
// (each with a region label + a postalAddress). The primary address and every
// secondary address are included so location filtering can see all advertised
// geography. Duplicate evidence is omitted while its first source spelling is
// preserved.
/** @param {any} j */
function formatLocation(j) {
  const parts = [];
  const add = (value, avoidLabelRepeat = false) => {
    const part = typeof value === 'string' ? value.trim() : '';
    if (!part) return;
    const key = part.normalize('NFC').toLowerCase();
    if (parts.some((existing) => existing.normalize('NFC').toLowerCase() === key)) return;
    if (avoidLabelRepeat && parts.some((existing) => labelContains(existing, part))) return;
    parts.push(part);
  };

  add(j.location);
  for (const value of postalAddressParts(j)) add(value, true);
  if (Array.isArray(j.secondaryLocations)) {
    for (const s of j.secondaryLocations) {
      if (!s || typeof s !== 'object') continue;
      add(s.location);
      for (const value of postalAddressParts(s)) add(value, true);
    }
  }

  const workplaceType = typeof j.workplaceType === 'string' ? j.workplaceType.trim() : '';
  const remote = workplaceType
    ? /(^|[^\p{L}\p{N}])remote($|[^\p{L}\p{N}])/iu.test(workplaceType)
    : j.isRemote === true;
  if (remote) add('Remote', true);

  return [...new Set(parts)].join(' · ');
}

function labelContains(label, value) {
  const normalizedLabel = label.normalize('NFC');
  const normalizedValue = value.normalize('NFC');
  const escaped = normalizedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(normalizedLabel);
}

function postalAddressParts(container) {
  const postalAddress = container?.address?.postalAddress;
  if (!postalAddress || typeof postalAddress !== 'object') return [];
  return ['addressLocality', 'addressCountry']
    .map((key) => typeof postalAddress[key] === 'string' ? postalAddress[key].trim() : '')
    .filter(Boolean);
}

/** @param {any} j */
function descriptionText(j) {
  const plain = typeof j.descriptionPlain === 'string' ? j.descriptionPlain.trim() : '';
  if (plain) return plain;

  const html = typeof j.descriptionHtml === 'string' ? j.descriptionHtml.trim() : '';
  if (html) return htmlToText(html) || undefined;

  const description = typeof j.description === 'string' ? j.description.trim() : '';
  if (!description) return undefined;
  if (/<(?:!?[a-z][\w:-]*|!--)|&lt;\s*\/?\s*[a-z][\w:-]*\b/i.test(description)) {
    return htmlToText(description) || undefined;
  }
  return description;
}

/** @type {Provider} */
export default {
  id: 'ashby',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`ashby: cannot derive API URL for ${entry.name}`);
    let lastErr;
    for (let attempt = 0; attempt <= ASHBY_RETRIES; attempt++) {
      if (attempt > 0) {
        // exponential backoff + jitter — spaces out retries to dodge Ashby rate-limiting
        const backoff = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
        await sleep(backoff, ctx);
      }
      try {
        const json = /** @type {any} */ (await ctx.fetchJson(apiUrl, { timeoutMs: ASHBY_TIMEOUT_MS, redirect: 'error' }));
        const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
        return jobs.map(/** @param {any} j */ (j) => {
          const job = {
            title: j.title || '',
            url: j.jobUrl || '',
            company: entry.name,
            location: formatLocation(j),
            salary: parseCompensation(j),
          };
          const description = descriptionText(j);
          if (description) job.description = description;
          const postedAt = toEpochMs(j.publishedAt);
          if (postedAt !== undefined) job.postedAt = postedAt;
          return job;
        });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  },
};
