// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Greenhouse provider — hits the public boards-api JSON endpoint.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.

const ALLOWED_GREENHOUSE_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

/** @param {string} url */
function assertGreenhouseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`greenhouse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`greenhouse: URL must use HTTPS: ${url}`);
  if (!ALLOWED_GREENHOUSE_HOSTS.has(parsed.hostname))
    throw new Error(`greenhouse: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_GREENHOUSE_HOSTS].join(', ')}`);
  return url;
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  if (entry.api) {
    assertGreenhouseUrl(entry.api);
    return entry.api;
  }
  const url = entry.careers_url || '';
  const match = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (match) return `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs`;
  return null;
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

const WORK_MODEL = /^(?:hybrid|in[-\s]?office|on[-\s]?site|distributed|remote|flexible)$/i;

export function isWorkModelOnly(name) {
  if (typeof name !== 'string') return false;
  const parts = name.split(';').map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => WORK_MODEL.test(part));
}

export function officesUrlFor(apiUrl) {
  const match = apiUrl.match(/^(https:\/\/[^/]+\/v1\/boards\/[^/]+)\/jobs(?:$|[?#])/);
  return match ? `${match[1]}/offices` : null;
}

export function buildOfficeMap(json) {
  const map = new Map();
  const walk = (offices) => {
    if (!Array.isArray(offices)) return;
    for (const office of offices) {
      if (!office || typeof office !== 'object') continue;
      const name = typeof office.name === 'string' ? office.name.trim() : '';
      if (name) {
        for (const department of Array.isArray(office.departments) ? office.departments : []) {
          for (const job of Array.isArray(department?.jobs) ? department.jobs : []) {
            if (!job || job.id == null) continue;
            if (!map.has(job.id)) map.set(job.id, new Set());
            map.get(job.id).add(name);
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
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertGreenhouseUrl above it guarantees the final hostname stays in the allowlist.
    const json = /** @type {any} */ (await ctx.fetchJson(apiUrl, { redirect: 'error' }));
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    const usable = jobs.filter(/** @param {any} j */ j => j.absolute_url);
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
        const offices = officeMap.get(j.id);
        if (offices?.size) location = [location, ...offices].join(' · ');
      }
      return {
        title: j.title || '',
        url: j.absolute_url,
        company: entry.name,
        location,
        postedAt: toEpochMs(j.first_published),
      };
    });
  },
};
