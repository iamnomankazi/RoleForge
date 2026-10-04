// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { intInRange } from './_config-utils.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { markProviderCoverage } from './_result.mjs';

const API_ROOT = 'https://www.vdab.be/rest/vindeenjob/v4';
const SEARCH_URL = `${API_ROOT}/vacatureLight/zoek`;
const BOARD_URL = 'https://www.vdab.be/vindeenjob/vacatures';
const BUNDLE_ROOT = 'https://www.vdab.be';
const INITIAL_MONITOR_KEY = 'b277002f-e1fa-4fc5-868a-fdab633c3851';
const DEFAULT_DAYS = 30;
const DEFAULT_SIZE = 100;
const DEFAULT_DETAIL_LIMIT = 25;
const MAX_DETAIL_LIMIT = 100;
const MAX_DAYS = 1_000;
const MAX_SIZE = 100;
const MAX_PAGES = 50;
const DETAIL_BATCH_SIZE = 5;
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {unknown} values
 * @returns {string[]}
 */
export function normalizeVdabKeywords(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const keywords = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const keyword = value.trim();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
  }
  return keywords;
}

/**
 * Normalize nested `entry.vdab` options. Profile roles are supplied by the
 * caller so the helper remains pure and can also be used by config tooling.
 *
 * @param {any} entry
 * @param {unknown} [profileRoles]
 */
export function normalizeVdabConfig(entry, profileRoles = []) {
  const config = entry?.vdab && typeof entry.vdab === 'object' && !Array.isArray(entry.vdab)
    ? entry.vdab
    : {};
  const hasExplicitKeywords = Object.prototype.hasOwnProperty.call(config, 'keywords');
  const keywords = normalizeVdabKeywords(hasExplicitKeywords ? config.keywords : profileRoles);

  return {
    keywords,
    days: intInRange(config.days, DEFAULT_DAYS, 1, MAX_DAYS),
    size: intInRange(config.size, DEFAULT_SIZE, 1, MAX_SIZE),
    fetchDetails: config.fetchDetails === true,
    detailLimit: intInRange(config.detailLimit, DEFAULT_DETAIL_LIMIT, 1, MAX_DETAIL_LIMIT),
  };
}

/**
 * Return a normalized opaque vacancy id or null when it cannot be encoded
 * safely as a path segment. String ids are intentionally not narrowed to a
 * numeric-only format because the API owns the identifier namespace.
 *
 * @param {unknown} rawId
 * @returns {string|null}
 */
export function normalizeVdabId(rawId) {
  if (typeof rawId !== 'string' && !(typeof rawId === 'number' && Number.isFinite(rawId))) return null;
  const id = String(rawId).trim();
  if (!id || id === '.' || id === '..' || /[\u0000-\u001f\u007f]/.test(id)) return null;
  for (let index = 0; index < id.length; index++) {
    const code = id.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = id.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return null;
    }
  }
  try {
    encodeURIComponent(id);
  } catch {
    return null;
  }
  return id;
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {unknown} value */
function postedAtFrom(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return postedAtFrom(numeric);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}

/**
 * Convert a VDAB search row into the scanner's normalized job shape.
 *
 * @param {any} row
 * @param {string} [keyword]
 * @param {string} [fallbackCompany]
 */
export function normalizeVdabJob(row, keyword = '', fallbackCompany = 'VDAB') {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const id = normalizeVdabId(row.id?.id);
  const title = nonEmptyString(row.vacaturefunctie?.naam);
  if (!id || !title) return null;

  let encodedId;
  try {
    encodedId = encodeURIComponent(id);
  } catch {
    return null;
  }
  const url = `https://www.vdab.be/vindeenjob/vacatures/${encodedId}`;
  const company = nonEmptyString(row.vacatureBedrijfsnaam) || nonEmptyString(fallbackCompany) || 'VDAB';
  const location = nonEmptyString(row.tewerkstellingsLocatieRegioOfAdres);
  const job = {
    title,
    url,
    company,
    location,
    sourceId: id,
    sourceUrl: url,
  };
  if (keyword) {
    job.sourceQuery = keyword;
    job.sourceQueries = [keyword];
  }
  const postedAt = postedAtFrom(row.eerstePublicatieDatum);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

/** @param {string} keyword @param {{days: number, size: number, page: number}} options */
export function buildVdabSearchBody(keyword, { days, size, page }) {
  return {
    criteria: {
      trefwoord: keyword,
      diplomaCodes: [],
      arbeidsduurCodes: [],
      arbeidsregimeCodes: [],
      contractTypeCodes: [],
      jobdomeinCodes: [],
      internationaalCodes: [],
      beroepCodes: [],
      ervaringCodes: [],
      rijbewijsCodes: [],
      attestCodes: [],
      taalCriteria: { taalSelecties: [] },
      onlineSindsCode: String(days),
      sorteerVeld: 'STANDAARD',
    },
    pagina: page,
    zoekmodus: 'C2',
    paginaGrootte: size,
  };
}

/** @param {any} value */
function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

/** @param {string} message @param {string} code @param {unknown} [cause] */
function typedError(message, code, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = 'VdabProviderError';
  /** @type {any} */ (error).code = code;
  return error;
}

/** @param {unknown} error */
function statusOf(error) {
  const status = Number(/** @type {any} */ (error)?.status);
  return Number.isFinite(status) ? status : undefined;
}

/** @param {any} error @param {Error} probeError */
function retainProbeFailure(error, probeError) {
  try {
    error.vdabProbeError = probeError;
  } catch {
    // The original fetch error still carries its identity and status.
  }
}

/**
 * Get profile roles at fetch time. The environment override is resolved from
 * the current working directory, while the default is rooted at this module.
 */
async function loadProfileRoles() {
  const override = typeof process.env.CAREER_OPS_PROFILE === 'string'
    ? process.env.CAREER_OPS_PROFILE.trim()
    : '';
  const profilePath = override
    ? resolve(process.cwd(), override)
    : resolve(ROOT_DIR, 'config/profile.yml');
  let source;
  try {
    source = await readFile(profilePath, 'utf8');
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return [];
    throw typedError('vdab: unable to read profile target roles', 'EVDAB_PROFILE_READ', error);
  }

  let profile;
  try {
    profile = yaml.load(source);
  } catch (error) {
    throw typedError('vdab: unable to parse profile target roles', 'EVDAB_PROFILE_PARSE', error);
  }
  return normalizeVdabKeywords(profile?.target_roles?.primary);
}

/** @param {string} html */
function safeBundleUrl(html) {
  if (typeof html !== 'string') return null;
  const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
  for (const tag of scriptTags) {
    const match = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!match) continue;
    const src = match[1] ?? match[2] ?? match[3];
    const authority = /^(?:https?:)?\/\/([^/?#]*)/i.exec(src.trim())?.[1];
    if (authority?.includes('@')) continue;
    let url;
    try {
      url = new URL(src, `${BUNDLE_ROOT}/`);
    } catch {
      continue;
    }
    if (url.protocol === 'https:' && url.origin === BUNDLE_ROOT
        && !url.username && !url.password
        && /^\/webapps\/vindeenjob\/main-[\w-]+\.js$/.test(url.pathname)
        && !url.search && !url.hash) {
      return url.href;
    }
  }
  return null;
}

/** @param {string} javascript */
function monitorKeyFrom(javascript) {
  if (typeof javascript !== 'string') return null;
  const match = /vej-key-monitor","([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i.exec(javascript);
  return match?.[1] || null;
}

/** @param {any} ctx */
async function deriveMonitorKey(ctx) {
  if (typeof ctx?.fetchText !== 'function') {
    throw typedError('vdab: fetchText is required to refresh the monitor key', 'EVDAB_KEY_PROBE_UNAVAILABLE');
  }
  let html;
  try {
    html = await ctx.fetchText(BOARD_URL, { timeoutMs: 12_000, redirect: 'error' });
  } catch (error) {
    throw typedError('vdab: board health probe failed while refreshing the monitor key', 'EVDAB_KEY_PROBE_FAILED', error);
  }
  const bundleUrl = safeBundleUrl(html);
  if (!bundleUrl) {
    throw typedError('vdab: no safe VDAB application bundle was found', 'EVDAB_KEY_BUNDLE_NOT_FOUND');
  }

  let javascript;
  try {
    javascript = await ctx.fetchText(bundleUrl, { timeoutMs: 15_000, redirect: 'error' });
  } catch (error) {
    throw typedError('vdab: application bundle probe failed while refreshing the monitor key', 'EVDAB_KEY_BUNDLE_FAILED', error);
  }
  const key = monitorKeyFrom(javascript);
  if (!key) throw typedError('vdab: monitor key literal was not found in the safe application bundle', 'EVDAB_KEY_NOT_FOUND');
  return key;
}

/**
 * Convert the API's markdown description to readable plain text without
 * passing through arbitrary URLs or retaining lightweight markdown syntax.
 * @param {unknown} markdown
 */
function markdownToPlainText(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return '';
  const withoutMarkdown = markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}(?:[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/```[\w-]*\s*/g, '')
    .replace(/[`*_~]/g, ' ');
  return htmlToText(withoutMarkdown).trim();
}

/** @param {any} ctx */
function createJsonRequester(ctx) {
  let monitorKey = INITIAL_MONITOR_KEY;
  let keyGeneration = 0;
  let recoveryStarted = false;
  /** @type {Promise<string>|null} */
  let recoveryPromise = null;

  const requestWithKey = (url, options, key) => ctx.fetchJson(url, {
    ...options,
    headers: { ...(options?.headers || {}), 'vej-key-monitor': key },
  });

  return async (url, options = {}) => {
    const requestGeneration = keyGeneration;
    try {
      return await requestWithKey(url, options, monitorKey);
    } catch (rawError) {
      const originalError = asError(rawError);
      if (statusOf(originalError) !== 403) throw rawError;

      // Parallel detail requests may still be finishing with the original key
      // after one of them has completed recovery. They each get one fresh-key
      // retry, while requests already using the new key never start another.
      if (requestGeneration < keyGeneration) {
        return await requestWithKey(url, options, monitorKey);
      }
      if (requestGeneration !== 0) throw rawError;

      if (!recoveryStarted) {
        recoveryStarted = true;
        recoveryPromise = deriveMonitorKey(ctx);
      }
      try {
        const freshKey = await recoveryPromise;
        if (keyGeneration === 0) {
          monitorKey = freshKey;
          keyGeneration = 1;
        }
      } catch (probeFailure) {
        const typedProbeError = asError(probeFailure);
        retainProbeFailure(originalError, typedProbeError);
        throw originalError;
      }
      return await requestWithKey(url, options, monitorKey);
    }
  };
}

/** @param {unknown} payload @param {number} page */
function requiredResults(payload, page) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.resultaten)) {
    throw typedError(`vdab: malformed response on page ${page} (expected resultaten array)`, 'EVDAB_MALFORMED_RESPONSE');
  }
  return payload.resultaten;
}

/** @param {any} error */
function errorCoverageCode(error) {
  if (error?.vdabProbeError) return 'key_derivation_failed';
  if (error?.code === 'EVDAB_MALFORMED_RESPONSE') return 'malformed_response';
  if (statusOf(error) === 403) return 'forbidden';
  return 'fetch_error';
}

/** @param {any} job @param {string} query */
function addQueryProvenance(job, query) {
  if (!Array.isArray(job.sourceQueries)) job.sourceQueries = job.sourceQuery ? [job.sourceQuery] : [];
  if (!job.sourceQueries.includes(query)) job.sourceQueries.push(query);
}

/** @type {Provider} */
const provider = {
  id: 'vdab',

  async fetch(entry, ctx) {
    const nested = entry?.vdab && typeof entry.vdab === 'object' && !Array.isArray(entry.vdab)
      ? entry.vdab
      : {};
    let profileRoles = [];
    if (!Object.prototype.hasOwnProperty.call(nested, 'keywords')) profileRoles = await loadProfileRoles();
    const config = normalizeVdabConfig(entry, profileRoles);
    if (config.keywords.length === 0) {
      throw typedError('vdab: configure at least one keyword or profile target_roles.primary role', 'EVDAB_KEYWORDS_REQUIRED');
    }

    const maxPages = ctx?.maxPages === undefined
      ? MAX_PAGES
      : intInRange(ctx.maxPages, 1, 1, MAX_PAGES);
    const requestJson = createJsonRequester(ctx);
    const jobsById = new Map();
    const failures = [];
    let pagesFetched = 0;
    let answeredKeywords = 0;
    let hadPartialPageFailure = false;
    let hitPageCap = false;

    for (const keyword of config.keywords) {
      let keywordAnswered = false;
      let keywordFailed = false;

      for (let page = 0; page < maxPages; page++) {
        let results;
        try {
          const body = buildVdabSearchBody(keyword, { days: config.days, size: config.size, page });
          const payload = await requestJson(SEARCH_URL, {
            method: 'POST',
            body: JSON.stringify(body),
            redirect: 'error',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
          });
          results = requiredResults(payload, page);
        } catch (error) {
          failures.push(asError(error));
          keywordFailed = true;
          if (keywordAnswered) hadPartialPageFailure = true;
          break;
        }

        const normalizedRows = [];
        for (const row of results) {
          const normalized = normalizeVdabJob(row, keyword, entry?.name || 'VDAB');
          if (normalized) normalizedRows.push(normalized);
        }
        if (results.length > 0 && normalizedRows.length === 0) {
          failures.push(typedError(
            `vdab: malformed response on page ${page} (no structurally usable vacancy rows)`,
            'EVDAB_MALFORMED_RESPONSE',
          ));
          keywordFailed = true;
          if (keywordAnswered) hadPartialPageFailure = true;
          break;
        }

        pagesFetched++;
        keywordAnswered = true;
        for (const normalized of normalizedRows) {
          const existing = jobsById.get(normalized.sourceId);
          if (existing) {
            addQueryProvenance(existing, keyword);
            continue;
          }
          jobsById.set(normalized.sourceId, normalized);
        }

        if (results.length < config.size) break;
        if (page === maxPages - 1) hitPageCap = true;
      }

      if (keywordAnswered && !keywordFailed) answeredKeywords++;
    }

    if (answeredKeywords === 0 && pagesFetched === 0 && failures.length > 0) throw failures[0];

    const jobs = [...jobsById.values()];
    let detailFailures = 0;
    if (config.fetchDetails && ctx?.maxPages === undefined) {
      const detailJobs = jobs.slice(0, config.detailLimit);
      for (let start = 0; start < detailJobs.length; start += DETAIL_BATCH_SIZE) {
        const batch = detailJobs.slice(start, start + DETAIL_BATCH_SIZE);
        const settled = await Promise.all(batch.map(async (job) => {
          const encodedId = encodeURIComponent(job.sourceId);
          const detailUrl = `${API_ROOT}/vacatures/${encodedId}?preview=false`;
          try {
            const payload = await requestJson(detailUrl, { redirect: 'error' });
            const description = markdownToPlainText(payload?.functie?.omschrijving?.markdown);
            if (description) job.description = description;
            else detailFailures++;
          } catch {
            detailFailures++;
          }
        }));
        void settled;
      }
    }

    const partialCodes = [];
    if (failures.length > 0) partialCodes.push(errorCoverageCode(failures[0]));
    if (hadPartialPageFailure) partialCodes.push('later_page_failed');
    if (hitPageCap) partialCodes.push('max_pages');
    if (detailFailures > 0) partialCodes.push('detail_failed');
    if (answeredKeywords > 0 && failures.length > 0) partialCodes.push('keyword_failed');
    if (partialCodes.length > 0) {
      const distinctCodes = [...new Set(partialCodes)];
      return markProviderCoverage(jobs, {
        status: 'partial',
        code: distinctCodes.length === 1 ? distinctCodes[0] : 'partial_coverage',
        reason: distinctCodes.join(', '),
        pagesFetched,
        maxPages,
      });
    }
    return jobs;
  },
};

export default provider;
