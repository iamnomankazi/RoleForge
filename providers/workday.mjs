// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Workday provider. The only accepted board origins and tenant/site values
// come from an explicit api or careers_url in the portal entry.
import { BROWSER_LIKE_USER_AGENT } from './_http.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { requiredArray, requireUsableRows } from './_payload.mjs';
import { markProviderCoverage } from './_result.mjs';

const PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 100;
const MAX_PAGES_CAP = 1500;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;
const INTER_PAGE_DELAY_MS = 150;
const DEFAULT_DETAIL_LIMIT = 20;
const DETAIL_LIMIT_CAP = 100;
const DETAIL_DELAY_MS = 150;
const EARLY_STOP_MARGIN_MS = 2 * 86_400_000;
const DNS_LABEL_RE = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const WORKDAY_INSTANCE_RE = /^wd\d+(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/i;
const INSTANCE_HOST_RE = /^wd\d+(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/i;
const JOB_PATH_RE = /^\/job\//i;
const GEO_KEYS = [
  'descriptor', 'name', 'locationName', 'city', 'cityName', 'municipality',
  'region', 'regionName', 'state', 'stateName', 'country', 'countryName',
  'countryCode', 'countryDescriptor', 'postalCode', 'address',
];

// WeakMaps keep provider internals out of returned job objects and canonical
// payloads. A board state is attached to its original job objects, never keyed
// only by ctx because reverse scans reuse one ctx across many boards.
const postingByJob = new WeakMap();
const detailStateByJob = new WeakMap();

function resolveMaxPages(entry) {
  const value = entry?.max_pages;
  return Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_PAGES_CAP)
    : DEFAULT_MAX_PAGES;
}

function resolveDetailLimit(entry) {
  const value = entry?.workday?.detailLimit;
  if (Number.isInteger(value) && value >= 0) return Math.min(value, DETAIL_LIMIT_CAP);
  return DEFAULT_DETAIL_LIMIT;
}

function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function isRetryableError(error) {
  if (error?.redirectRefused === true || /^ECAREEROPS_REDIRECT_/.test(String(error?.code || ''))) return false;
  const status = error?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  return status === undefined;
}

async function fetchWithRetry(ctx, method, url, options) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await ctx[method](url, options);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES || !isRetryableError(error)) throw error;
      const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
      const retryAfter = parseRetryAfterMs(error?.retryAfter);
      const delay = retryAfter === null
        ? backoff + Math.random() * 250
        : Math.min(retryAfter, RETRY_MAX_DELAY_MS * 4);
      await sleep(delay, ctx);
    }
  }
  throw lastError;
}

function decodePathSegment(raw) {
  let value;
  try { value = decodeURIComponent(raw); } catch { return null; }
  if (!value || value === '.' || value === '..' || /[\\/?#\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function hasUnsafeConfiguredPath(value) {
  const match = /^https:\/\/[^/?#]*(\/[^?#]*)?/i.exec(value);
  const rawPath = match?.[1] || '/';
  for (const segment of rawPath.split('/')) {
    if (!segment) continue;
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { return true; }
    if (decoded === '.' || decoded === '..' || /[\\\u0000-\u001f\u007f]/.test(decoded)) return true;
  }
  return false;
}

function parseConfiguredUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (hasUnsafeConfiguredPath(value.trim())) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;

  const host = url.hostname.toLowerCase();
  const labels = host.split('.');
  if (labels.some((label) => !DNS_LABEL_RE.test(label))) return null;
  const segments = url.pathname.split('/').slice(1);
  if (segments.at(-1) === '') segments.pop();
  const decoded = segments.map(decodePathSegment);
  if (decoded.some((segment) => segment === null)) return null;

  if (labels.length === 4 && labels[2] === 'myworkdayjobs' && labels[3] === 'com') {
    const tenant = labels[0];
    const instance = labels[1];
    if (!DNS_LABEL_RE.test(tenant) || !WORKDAY_INSTANCE_RE.test(instance)) return null;
    let siteParts = decoded;
    if (siteParts.length === 2 && /^[a-z]{2}-[a-z]{2}$/i.test(siteParts[0])) siteParts = siteParts.slice(1);
    if (siteParts.length !== 1 || !/^[a-z0-9._~-]+$/i.test(siteParts[0]) || siteParts[0] === '.' || siteParts[0] === '..') return null;
    const site = siteParts[0];
    const origin = `https://${host}`;
    return {
      origin,
      tenant,
      site,
      api: `${origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`,
      detailBase: `${origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`,
      jobBase: `${origin}/${encodeURIComponent(site)}`,
      referer: `${origin}/${encodeURIComponent(site)}/`,
    };
  }

  if (labels.length === 3 && labels[1] === 'myworkdaysite' && labels[2] === 'com'
      && INSTANCE_HOST_RE.test(labels[0])) {
    // This host does not encode the tenant. Only the configured recruiting
    // path may supply tenant/site identity; never guess it from the host.
    if (decoded[0]?.toLowerCase() !== 'recruiting') return null;
    const parts = decoded.slice(1);
    if (parts.length !== 2) return null;
    const [tenant, site] = parts;
    if (!DNS_LABEL_RE.test(tenant) || !/^[a-z0-9._~-]+$/i.test(site) || site === '.' || site === '..') return null;
    const origin = `https://${host}`;
    const recruitingPath = `/recruiting/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
    return {
      origin,
      tenant,
      site,
      api: `${origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`,
      detailBase: `${origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`,
      jobBase: `${origin}${recruitingPath}`,
      referer: `${origin}${recruitingPath}/`,
    };
  }
  return null;
}

function resolveEndpoint(entry) {
  for (const value of [entry?.api, entry?.careers_url]) {
    const endpoint = parseConfiguredUrl(value);
    if (endpoint) return endpoint;
  }
  return null;
}

function parsePostedOn(label, now = Date.now()) {
  if (typeof label !== 'string') return undefined;
  const value = label.trim();
  if (/^posted\s+today$/i.test(value)) return now;
  if (/^posted\s+yesterday$/i.test(value)) return now - 86_400_000;
  const match = /^posted\s+(\d{1,5})(\+?)\s+days?\s+ago$/i.exec(value);
  if (!match || match[2] === '+') return undefined;
  const days = Number(match[1]);
  const date = now - days * 86_400_000;
  return Number.isFinite(date) && Number.isSafeInteger(days) ? date : undefined;
}

function parseDateEvidence(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : undefined;
  }
  if (typeof value !== 'string') {
    if (value && typeof value === 'object') {
      return parseDateEvidence(value.date ?? value.value ?? value.descriptor);
    }
    return undefined;
  }
  const normalized = value.trim();
  const workdayDate = /^\/Date\((\d+)\)\/$/.exec(normalized);
  if (workdayDate) {
    const timestamp = Number(workdayDate[1]);
    return Number.isFinite(timestamp) && timestamp <= 8.64e15 ? timestamp : undefined;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ]\d{2}(?::\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/.exec(normalized);
  if (!iso) return undefined;
  const year = Number(iso[1]);
  const month = Number(iso[2]);
  const day = Number(iso[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return undefined;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return undefined;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function locationFromPath(externalPath) {
  const match = String(externalPath || '').match(/\/job\/([^/]+)\//i);
  if (!match) return '';
  let segment;
  try { segment = decodeURIComponent(match[1]); } catch { segment = match[1]; }
  return segment.replace(/-/g, ' ');
}

function isPlaceholderLocation(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return !text || /^(?:(?:n|\d+)\s+locations?|locations?|multiple\s+locations?|various\s+locations?|location\s+not\s+specified|not\s+specified|tbd|n\/?a|not\s+available|see\s+job\s+description)$/i.test(text);
}

function addText(output, value) {
  if (typeof value !== 'string') return;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || isPlaceholderLocation(text)) return;
  if (!output.some((existing) => existing.toLowerCase() === text.toLowerCase())) output.push(text);
}

function collectLocationText(value, output, depth = 0) {
  if (depth > 20) return;
  if (typeof value === 'string') {
    addText(output, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLocationText(item, output, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of GEO_KEYS) {
    if (Object.hasOwn(value, key)) collectLocationText(value[key], output, depth + 1);
  }
}

function locationEvidence(info) {
  const output = [];
  for (const key of ['location', 'locations', 'additionalLocations', 'country', 'countryName', 'countryCode', 'countryDescriptor']) {
    if (Object.hasOwn(info, key)) collectLocationText(info[key], output);
  }
  return output;
}

function postingInfo(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.jobPostingInfo && typeof payload.jobPostingInfo === 'object' && !Array.isArray(payload.jobPostingInfo)) {
    return payload.jobPostingInfo;
  }
  return null;
}

function applyPostingInfo(job, payload) {
  const info = postingInfo(payload);
  if (!info) return false;
  if (job.postedAt == null) {
    const postedAt = parseDateEvidence(info.startDate)
      ?? parseDateEvidence(info.date);
    if (postedAt !== undefined) job.postedAt = postedAt;
  }

  const locations = locationEvidence(info);
  const current = isPlaceholderLocation(job.location) ? [] : [String(job.location).trim()];
  for (const value of locations) addText(current, value);
  if (locations.length > 0) job.location = current.join('; ');

  if (typeof job.description !== 'string' || !job.description.trim()) {
    const rawDescription = info.jobDescription;
    const html = typeof rawDescription === 'string' ? rawDescription
      : typeof rawDescription?.text === 'string' ? rawDescription.text
        : typeof rawDescription?.descriptor === 'string' ? rawDescription.descriptor : '';
    const description = htmlToText(html);
    if (description) job.description = description;
  }
  return true;
}

function normalizeExternalPath(value) {
  if (typeof value !== 'string' || !JOB_PATH_RE.test(value) || value.startsWith('//')
      || /[?#\\\u0000-\u001f\u007f]/.test(value)) return null;
  const segments = value.split('/').slice(1);
  for (const segment of segments) {
    const decoded = decodePathSegment(segment);
    if (decoded === null) return null;
  }
  return value;
}

export function parseWorkdayResponse(json, entry) {
  const endpoint = resolveEndpoint(entry);
  const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
  const jobs = [];
  for (const posting of postings) {
    if (!posting || typeof posting !== 'object') continue;
    const externalPath = normalizeExternalPath(posting.externalPath);
    const title = typeof posting.title === 'string' ? posting.title.trim() : '';
    if (!externalPath || !title) continue;
    const job = {
      title,
      url: endpoint ? `${endpoint.jobBase}${externalPath}` : externalPath,
      company: typeof entry?.name === 'string' ? entry.name : '',
      location: (typeof posting.locationsText === 'string' && posting.locationsText.trim())
        || locationFromPath(externalPath),
      postedAt: parsePostedOn(posting.postedOn),
    };
    postingByJob.set(job, { externalPath, posting });
    if (posting.jobPostingInfo) applyPostingInfo(job, posting);
    jobs.push(job);
  }
  return jobs;
}

function validateWorkdayPage(json, entry, offset = 0) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('workday: malformed response (expected object)');
  }
  if (json.errorCode || json.error) {
    throw new Error(`workday: board returned error ${String(json.errorCode || json.error).slice(0, 120)}`);
  }
  if (json.total !== undefined && (!Number.isSafeInteger(json.total) || json.total < 0)) {
    throw new Error('workday: malformed response (total must be a non-negative integer)');
  }
  const raw = requiredArray(json, 'jobPostings', 'workday');
  if (raw.length > 0 && json.total === 0) {
    throw new Error('workday: malformed response (postings were returned with total=0)');
  }
  if (raw.length === 0 && json.total > offset) {
    throw new Error(`workday: malformed response (empty page at offset ${offset} while total is ${json.total})`);
  }
  return requireUsableRows(raw, parseWorkdayResponse(json, entry), 'workday');
}

function resolveAppliedFacets(entry) {
  const facets = entry?.workday?.appliedFacets;
  if (facets === undefined) return {};
  if (!facets || typeof facets !== 'object' || Array.isArray(facets)) {
    throw new Error('workday: workday.appliedFacets must be a record of facet id to string[]');
  }
  if (Object.keys(facets).length > 20) throw new Error('workday: workday.appliedFacets supports at most 20 facet names');
  const output = Object.create(null);
  for (const [id, values] of Object.entries(facets)) {
    if (!id.trim() || id.length > 200 || !Array.isArray(values) || values.length < 1 || values.length > 50
        || values.some((value) => typeof value !== 'string' || !value.trim() || value.length > 200)) {
      throw new Error('workday: workday.appliedFacets contains an invalid facet id or value list');
    }
    output[id] = values.slice();
  }
  return output;
}

function pageIsPastWindow(pageJobs, sinceMs, rawCount = pageJobs.length) {
  if (typeof sinceMs !== 'number' || pageJobs.length === 0 || rawCount !== pageJobs.length) return false;
  // Relative Workday labels and tenant ordering are not sufficient evidence
  // unless every row on this page has a usable date and every row is stale.
  return pageJobs.every((job) => typeof job.postedAt === 'number'
    && Number.isFinite(job.postedAt)
    && job.postedAt < sinceMs - EARLY_STOP_MARGIN_MS);
}

function pageSignature(pageJobs) {
  return JSON.stringify(pageJobs.map((job) => job.url));
}

function setLegacyFlag(jobs, name, value = true) {
  if (Object.hasOwn(jobs, name)) return;
  Object.defineProperty(jobs, name, { value, configurable: true, enumerable: false });
}

function markPendingCoverage(state) {
  if (state.coverageMarked || !state.pendingCoverage || !state.jobs) return;
  markProviderCoverage(state.jobs, {
    status: 'partial',
    code: state.pendingCoverage.code,
    reason: state.pendingCoverage.reason,
    pagesFetched: state.pagesFetched,
    maxPages: state.pendingCoverage.maxPages,
    totalPages: state.totalPages,
  });
  state.coverageMarked = true;
}

function notePartial(state, code, reason, maxPages = undefined) {
  // Coverage is immutable; keep the first useful explanation.
  if (!state.pendingCoverage) state.pendingCoverage = { code, reason, maxPages };
  if (state.sealed) markPendingCoverage(state);
}

function registerJobs(state, jobs) {
  for (const job of jobs) {
    const source = postingByJob.get(job);
    if (source) {
      detailStateByJob.set(job, state);
      if (source.posting.jobPostingInfo) applyPostingInfo(job, source.posting);
    }
  }
}

function detailUrlFor(state, source) {
  return `${state.endpoint.detailBase}${source.externalPath}`;
}

function detailRequestOptions(state) {
  return {
    redirect: 'error',
    headers: {
      accept: 'application/json',
      'user-agent': BROWSER_LIKE_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
      origin: state.endpoint.origin,
      referer: `${state.endpoint.jobBase}/`,
    },
  };
}

async function requestDetail(state, source) {
  const url = detailUrlFor(state, source);
  const cached = state.detailCache.get(url);
  if (cached) return cached;
  if (state.detailLimit === 0 || state.detailAttempts >= state.detailLimit) {
    notePartial(state, 'detail_budget', `Workday detailLimit=${state.detailLimit} prevented required detail recovery`);
    return null;
  }

  const pending = (async () => {
    let lastError;
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      if (state.detailAttempts >= state.detailLimit) {
        notePartial(state, 'detail_budget', `Workday detail request budget exhausted at ${state.detailAttempts} attempts`);
        return null;
      }
      if (state.detailAttempts > 0 && retry === 0) await sleep(DETAIL_DELAY_MS, state.ctx);
      state.detailAttempts++;
      try {
        const payload = await state.ctx.fetchJson(url, detailRequestOptions(state));
        const info = payload && typeof payload === 'object' && !Array.isArray(payload)
          && payload.jobPostingInfo && typeof payload.jobPostingInfo === 'object'
          && !Array.isArray(payload.jobPostingInfo)
          ? payload.jobPostingInfo : null;
        if (!info) {
          if (/not[_ -]?found|removed|unlisted/i.test(String(payload?.errorCode || payload?.error || ''))) return null;
          notePartial(state, 'detail_invalid', 'Workday detail endpoint returned no jobPostingInfo evidence');
          return null;
        }
        return payload;
      } catch (error) {
        lastError = error;
        if (retry === MAX_RETRIES || !isRetryableError(error)
            || state.detailAttempts >= state.detailLimit) break;
        const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** retry, RETRY_MAX_DELAY_MS);
        const retryAfter = parseRetryAfterMs(error?.retryAfter);
        const delay = retryAfter === null
          ? backoff + Math.random() * 250
          : Math.min(retryAfter, RETRY_MAX_DELAY_MS * 4);
        await sleep(delay, state.ctx);
      }
    }
    const reason = lastError
      ? `Workday detail request failed after ${state.detailAttempts} HTTP attempt(s): ${String(lastError.message || lastError).slice(0, 160)}`
      : 'Workday detail request failed';
    notePartial(state, 'detail_fetch_error', reason);
    return null;
  })();
  state.detailCache.set(url, pending);
  return pending;
}

async function enrichJob(job, state) {
  const source = postingByJob.get(job);
  if (!source || !state.allowDetails) return job;
  const payload = await requestDetail(state, source);
  if (payload) applyPostingInfo(job, payload);
  return job;
}

function resolvePagePlan(first, entry, ctx) {
  const total = typeof first?.total === 'number' ? first.total : null;
  const rawCount = first.jobPostings.length;
  const entryMaxPages = resolveMaxPages(entry);
  const serverPages = total !== null
    ? Math.ceil(total / PAGE_SIZE)
    : rawCount >= PAGE_SIZE ? Infinity : 1;
  const configuredPages = Math.min(serverPages, entryMaxPages);
  const contextMax = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
  const pagesToFetch = Math.min(configuredPages, contextMax);
  return {
    total,
    entryMaxPages,
    serverPages,
    pagesToFetch,
    contextLimited: contextMax < serverPages,
    entryLimited: configuredPages < serverPages
      || (total !== null && total === entryMaxPages * PAGE_SIZE),
  };
}

function totalPagesFrom(total) {
  return Number.isSafeInteger(total) && total >= 0 ? Math.ceil(total / PAGE_SIZE) : undefined;
}

/** @type {Provider} */
const provider = {
  id: 'workday',

  detect(entry) {
    const endpoint = resolveEndpoint(entry);
    return endpoint ? { url: endpoint.api } : null;
  },

  async fetch(entry, ctx) {
    const endpoint = resolveEndpoint(entry);
    if (!endpoint) throw new Error(`workday: cannot derive a trusted CXS endpoint for ${entry?.name || 'entry'}`);
    if (typeof ctx?.fetchJson !== 'function') throw new Error('workday: ctx.fetchJson transport is required');

    const appliedFacets = resolveAppliedFacets(entry);
    const postOptions = {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': BROWSER_LIKE_USER_AGENT,
        'accept-language': 'en-US,en;q=0.9',
        origin: endpoint.origin,
        referer: endpoint.referer,
      },
    };
    const makeBody = (offset) => JSON.stringify({ limit: PAGE_SIZE, offset, searchText: '', appliedFacets });
    const state = {
      endpoint,
      ctx,
      detailLimit: resolveDetailLimit(entry),
      detailAttempts: 0,
      detailCache: new Map(),
      allowDetails: ctx?.maxPages !== 1,
      pagesFetched: 0,
      totalPages: undefined,
      jobs: null,
      pendingCoverage: null,
      coverageMarked: false,
      sealed: false,
    };

    const firstOptions = { ...postOptions, body: makeBody(0) };
    // A one-page liveness context is a strict single-request probe, including
    // its first-page failure path; ordinary board scans retain transient retry.
    const first = ctx.maxPages === 1
      ? await ctx.fetchJson(endpoint.api, firstOptions)
      : await fetchWithRetry(ctx, 'fetchJson', endpoint.api, firstOptions);
    const jobs = validateWorkdayPage(first, entry, 0);
    state.jobs = jobs;
    state.pagesFetched = 1;
    state.totalPages = totalPagesFrom(first.total);
    registerJobs(state, jobs);

    // Placeholder geography affects downstream location filtering. Recover it
    // while the listing batch is available, except for one-page liveness probes.
    if (state.allowDetails) {
      for (const job of jobs) {
        if (isPlaceholderLocation(job.location)) await enrichJob(job, state);
      }
    }

    const plan = resolvePagePlan(first, entry, ctx);
    const sinceMs = typeof ctx?.sinceMs === 'number' ? ctx.sinceMs : null;
    const includeUndated = ctx?.includeUndated === true;
    let stopReason = 'complete';
    if (pageIsPastWindow(jobs, sinceMs, first.jobPostings.length)) stopReason = 'early-stop';
    const sawDatedPosting = jobs.some((job) => typeof job.postedAt === 'number' && Number.isFinite(job.postedAt));
    if (stopReason === 'complete' && sinceMs !== null && !includeUndated && !sawDatedPosting && jobs.length > 0) {
      stopReason = 'no-date-skip';
    }

    const seenPages = new Set([pageSignature(jobs)]);
    let page = 1;
    if (stopReason === 'complete') {
      for (; page < plan.pagesToFetch; page++) {
        await sleep(INTER_PAGE_DELAY_MS, ctx);
        let payload;
        try {
          payload = await fetchWithRetry(ctx, 'fetchJson', endpoint.api, {
            ...postOptions,
            body: makeBody(page * PAGE_SIZE),
          });
        } catch (error) {
          stopReason = 'fetch-error';
          console.error(`⚠️  workday: ${entry.name} truncated at ${page + 1} of ${plan.pagesToFetch} pages after ${MAX_RETRIES + 1} attempts (${jobs.length}${plan.total !== null ? ` of ${plan.total}` : ''} jobs): ${error.message}`);
          break;
        }

        let pageJobs;
        try {
          payload = payload && typeof payload === 'object' ? payload : {};
          pageJobs = validateWorkdayPage(payload, entry, page * PAGE_SIZE);
        } catch (error) {
          stopReason = 'invalid-page';
          console.error(`⚠️  workday: ${entry.name} stopped at page ${page + 1} after an invalid response: ${error.message}`);
          break;
        }
        state.pagesFetched++;
        registerJobs(state, pageJobs);
        const signature = pageSignature(pageJobs);
        if (seenPages.has(signature)) {
          stopReason = 'repeated-page';
          break;
        }
        seenPages.add(signature);
        jobs.push(...pageJobs);
        if (state.allowDetails) {
          for (const job of pageJobs) {
            if (isPlaceholderLocation(job.location)) await enrichJob(job, state);
          }
        }

        if (plan.total === null && payload.jobPostings.length < PAGE_SIZE) break;
        if (pageIsPastWindow(pageJobs, sinceMs, payload.jobPostings.length)) { stopReason = 'early-stop'; break; }
      }
      if (stopReason === 'complete' && page === plan.pagesToFetch && plan.entryLimited && !plan.contextLimited) {
        stopReason = 'cap';
      }
    }

    if (stopReason === 'cap') {
      if (sinceMs === null) {
        console.error(`⚠️  workday: ${entry.name} truncated at max_pages=${plan.entryMaxPages} (${jobs.length}${plan.total !== null ? ` of ${plan.total}` : ''} jobs) — raise max_pages on this entry for more`);
      } else {
        const suspectTag = plan.total !== null && plan.total === plan.entryMaxPages * PAGE_SIZE
          ? ' (total may be Workday-capped, not real)' : '';
        console.error(`⚠️  workday: ${entry.name} truncated at ${plan.entryMaxPages} pages (${jobs.length}${plan.total !== null ? ` of ${plan.total}` : ''} jobs)${suspectTag}`);
      }
      notePartial(state, 'max_pages', `Workday pagination reached max_pages=${plan.entryMaxPages}`, plan.entryMaxPages);
    } else if (stopReason === 'fetch-error') {
      notePartial(state, 'fetch_error', 'Workday pagination stopped after a page request failed');
    } else if (stopReason === 'invalid-page') {
      notePartial(state, 'invalid_page', 'Workday pagination stopped after an invalid page response');
    } else if (stopReason === 'repeated-page') {
      notePartial(state, 'repeated_page', `Workday returned a repeated page at page ${page + 1}`, plan.entryMaxPages);
    } else if (stopReason === 'no-date-skip') {
      setLegacyFlag(jobs, 'workdayNoDateSkip');
      notePartial(state, 'no_date_skip', 'Workday pagination stopped because the first page had no usable dates and undated jobs were excluded');
    }

    state.sealed = true;
    markPendingCoverage(state);
    return jobs;
  },

  async enrichDate(job, ctx) {
    if (!job || typeof job !== 'object') throw new TypeError('workday: enrichDate requires a job object');
    const state = detailStateByJob.get(job);
    if (!state) return job;
    if (ctx?.maxPages === 1) return job;
    return await enrichJob(job, state);
  },
};

export default provider;
