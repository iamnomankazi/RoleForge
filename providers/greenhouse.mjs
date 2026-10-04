// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { requiredArray, requireUsableRows } from './_payload.mjs';
import { htmlToText } from './_html-to-text.mjs';

// Greenhouse provider — hits the public boards-api JSON endpoint.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.

const ALLOWED_GREENHOUSE_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

/** @param {unknown} url */
function parseGreenhouseUrl(url) {
  if (typeof url !== 'string' || !url) throw new Error(`greenhouse: invalid URL: ${url}`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`greenhouse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`greenhouse: URL must use HTTPS: ${url}`);
  if (parsed.username || parsed.password) throw new Error(`greenhouse: URL must not contain credentials: ${url}`);
  if (parsed.port) throw new Error(`greenhouse: URL must not use a nondefault port: ${url}`);
  if (!ALLOWED_GREENHOUSE_HOSTS.has(parsed.hostname))
    throw new Error(`greenhouse: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_GREENHOUSE_HOSTS].join(', ')}`);
  return parsed;
}

/** @param {string} url */
function assertGreenhouseUrl(url) {
  return parseGreenhouseUrl(url);
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  if (entry.api) {
    assertGreenhouseUrl(entry.api);
    return entry.api;
  }
  if (typeof entry.careers_url !== 'string' || !entry.careers_url) return null;
  let url;
  try {
    url = parseGreenhouseUrl(entry.careers_url);
  } catch {
    return null;
  }
  if (url.hostname === 'boards-api.greenhouse.io') return null;

  const path = url.pathname;
  let token;
  if (path === '/embed/job_board' || path === '/embed/job_board/') {
    const values = url.searchParams.getAll('for');
    if (values.length !== 1) return null;
    token = values[0];
  } else {
    if (path === '/embed' || path.startsWith('/embed/')) return null;
    token = path.split('/').filter(Boolean)[0];
  }
  if (typeof token === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(token)) {
    return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;
  }
  return null;
}

// Greenhouse provides first_published as an ISO date or timestamp. Requiring
// an unambiguous ISO form prevents Date.parse's locale guesses and calendar
// normalization from fabricating usable posting dates.
function toEpochMs(value) {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}))?$/);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return undefined;
  if (hourText !== undefined) {
    if (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return undefined;
    if (zone !== 'Z') {
      const offset = zone.slice(1).split(':').map(Number);
      if (offset[0] > 23 || offset[1] > 59) return undefined;
    }
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const WORK_MODEL = /^(?:hybrid|in[-\s]?office|on[-\s]?site|distributed|remote|flexible)$/i;

export function isWorkModelOnly(name) {
  if (typeof name !== 'string') return false;
  const parts = name.split(';').map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => WORK_MODEL.test(part));
}

export function officesUrlFor(apiUrl) {
  let url;
  try {
    url = parseGreenhouseUrl(apiUrl);
  } catch {
    return null;
  }
  if (url.hostname !== 'boards-api.greenhouse.io') return null;
  const match = url.pathname.match(/^\/v1\/boards\/([a-z0-9][a-z0-9_-]*)\/jobs\/?$/i);
  return match ? `${url.origin}/v1/boards/${match[1]}/offices` : null;
}

function officeGeography(office) {
  const location = office.location;
  if (typeof location === 'string' && location.trim()) return location.trim();
  if (location && typeof location === 'object') {
    const parts = ['city', 'locality', 'region', 'state', 'country'].map((key) => location[key])
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim());
    if (parts.length) return [...new Set(parts)].join(', ');
    if (typeof location.name === 'string' && location.name.trim()) return location.name.trim();
  }
  return typeof office.name === 'string' ? office.name.trim() : '';
}

export function buildOfficeMap(json) {
  const map = new Map();
  const walk = (offices) => {
    if (!Array.isArray(offices)) return;
    for (const office of offices) {
      if (!office || typeof office !== 'object') continue;
      const location = officeGeography(office);
      if (location) {
        for (const department of Array.isArray(office.departments) ? office.departments : []) {
          for (const job of Array.isArray(department?.jobs) ? department.jobs : []) {
            if (!job || job.id == null) continue;
            const id = String(job.id);
            if (!map.has(id)) map.set(id, new Set());
            map.get(id).add(location);
          }
        }
      }
      walk(office.children);
    }
  };
  walk(json?.offices);
  return map;
}

/** @type {Provider} */
export default {
  id: 'greenhouse',

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`greenhouse: cannot derive API URL for ${entry.name}`);
    assertGreenhouseUrl(apiUrl);
    const listUrl = new URL(apiUrl);
    listUrl.searchParams.set('content', 'true');
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertGreenhouseUrl above it guarantees the final hostname stays in the allowlist.
    const json = /** @type {any} */ (await ctx.fetchJson(listUrl.toString(), { redirect: 'error' }));
    const jobs = requiredArray(json, 'jobs', 'greenhouse');
    const usable = jobs.filter(/** @param {any} j */ j => j.absolute_url);
    requireUsableRows(jobs, usable, 'greenhouse');
    let officeMap = null;
    if (usable.some(/** @param {any} j */ j => isWorkModelOnly(j.location?.name))) {
      const officesUrl = officesUrlFor(apiUrl);
      if (officesUrl) {
        try {
          assertGreenhouseUrl(officesUrl);
          officeMap = buildOfficeMap(await ctx.fetchJson(officesUrl, { redirect: 'error' }));
        } catch (error) {
          console.error(`⚠️  greenhouse: ${entry.name} office enrichment failed — ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return usable.map(/** @param {any} j */ (j) => {
      let location = j.location?.name || '';
      if (officeMap && isWorkModelOnly(location)) {
        const offices = officeMap.get(String(j.id));
        if (offices?.size) location = [location, ...[...offices].sort()].join(' · ');
      }
      return {
        title: j.title || '',
        url: j.absolute_url,
        company: entry.name,
        location,
        ...(typeof j.content === 'string' ? { description: htmlToText(j.content) } : {}),
        postedAt: toEpochMs(j.first_published),
      };
    });
  },
};
