// @ts-check
/**
 * liveness-api.mjs — zero-token liveness check for ATS-hosted job postings.
 *
 * Many postings live on ATS platforms (Greenhouse, Lever, Ashby, ...) that expose
 * a public JSON endpoint. We can confirm whether a posting is still live by hitting
 * that endpoint directly — no browser, no LLM tokens — and only fall back to the
 * Playwright check (liveness-browser.mjs) for non-ATS pages or when the API is
 * inconclusive. This is the cheap first rung of the liveness ladder.
 *
 * CONSERVATIVE BY DESIGN: a false "expired" is worse than the status quo (the user
 * misses a real job). So on a definitive 404/410 we return `expired`, and for
 * anything ambiguous (unknown ATS, redirect, 429/5xx, network/timeout) we return
 * `null` (→ caller falls back to Playwright).
 *
 * Two endpoint shapes:
 *   - Per-job (Greenhouse, Lever): the URL maps to a single-job endpoint, so a 200
 *     is itself proof the posting is live.
 *   - Org-level (Ashby): the URL maps to the org's whole job board. A 200 only
 *     proves the board exists, so the provider's `interpret` step parses the board
 *     and confirms THIS posting is still listed before returning active/expired.
 *     (Ashby pages are JS-rendered, so the browser/static rung sees only nav/footer
 *     and false-reports live postings as expired — this API rung is authoritative.)
 *
 * SSRF-safe by construction: the request URL is built from a FIXED, hard-coded API
 * host plus path segments extracted from the posting URL with a strict charset
 * (no slashes / traversal), and server-side redirects are refused.
 */

import { htmlToText } from './providers/_html-to-text.mjs';

const TIMEOUT_MS = 8_000;
// Strict path-segment charset. Anything with a slash, dot-dot, or other char is
// rejected before it can reach the fixed-host API URL template.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isSafeValue(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return value.split('/').every((segment) => segment.length > 0 && SAFE_SEGMENT.test(segment) && !segment.includes('..'));
}

// Each ATS: detect its posting URL, then map to a public JSON API URL.
// `match` returns the extracted path params (or null); `api` builds the FIXED-host URL.
// Optional per-provider fields:
//   `timeoutMs`  — override the default fetch timeout (slow/rate-limited APIs).
//   `interpret`  — read the 200 response body to decide liveness (org-level APIs
//                  where a 200 alone doesn't prove THIS posting is live).
const ATS_PROVIDERS = [
  {
    id: 'greenhouse',
    // boards.greenhouse.io/{board}/jobs/{id} · job-boards[.eu].greenhouse.io/{board}/jobs/{id}
    match(u) {
      if (!/(^|\.)greenhouse\.io$/.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/);
      return m ? { board: m[1], id: m[2] } : null;
    },
    api: ({ board, id }) => `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`,
  },
  {
    id: 'lever',
    // jobs.(eu.)?lever.co/{slug}/{id}
    match(u) {
      const host = u.hostname.match(/^jobs\.((?:eu\.)?lever\.co)$/);
      if (!host) return null;
      const m = u.pathname.match(/^\/([^/]+)\/([^/?#]+)\/?$/);
      return m ? { apiHost: `api.${host[1]}`, slug: m[1], id: m[2] } : null;
    },
    api: ({ apiHost, slug, id }) => `https://${apiHost}/v0/postings/${slug}/${id}`,
  },
  {
    id: 'ashby',
    // jobs.ashbyhq.com/{org}/{jobId}[/application]. Ashby's public posting API is
    // ORG-level (the whole job board), not per-job — so `api` maps to the board and
    // `interpret` confirms this {jobId} is still listed. Only {org} reaches the
    // fixed-host URL; {jobId} is used solely to filter the parsed board (SAFE_SEGMENT
    // still validates both).
    match(u) {
      if (u.hostname !== 'jobs.ashbyhq.com') return null;
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/application)?\/?$/);
      return m ? { org: m[1], jobId: m[2] } : null;
    },
    api: ({ org }) => `https://api.ashbyhq.com/posting-api/job-board/${org}`,
    // Ashby's posting-api has a server-side latency floor and rate-limits repeated
    // unauthenticated hits (see providers/ashby.mjs). Give it more room than the ATS
    // default so a slow-but-live board doesn't time out into a Playwright fallback.
    timeoutMs: 20_000,
    async interpret(res, { jobId }) {
      let json;
      try {
        json = await res.json();
      } catch {
        return null; // unparseable body → inconclusive, let the browser decide
      }
      return classifyAshbyBoard(json, jobId);
    },
  },
  {
    id: 'workday',
    match(u) {
      const match = `${u.hostname}${u.pathname}`.match(
        /^([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)\/job\/(.+?)\/?$/,
      );
      if (!match) return null;
      const [, tenant, shard, site, jobPath] = match;
      return { tenant, shard, site, jobPath };
    },
    api: ({ tenant, shard, site, jobPath }) =>
      `https://${tenant}.${shard}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/job/${jobPath}`,
    async interpret(res) {
      let json;
      try { json = await res.json(); } catch { return null; }
      return classifyWorkdayPosting(json);
    },
  },
  {
    id: 'smartrecruiters',
    // jobs.smartrecruiters.com/{company}/{postingId}-{slug}
    match(u) {
      if (!['jobs.smartrecruiters.com', 'careers.smartrecruiters.com'].includes(u.hostname)) return null;
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
      if (!m) return null;
      const id = m[2].match(/^([A-Za-z0-9_]+)(?:-|$)/)?.[1];
      return id ? { company: m[1], id } : null;
    },
    api: ({ company, id }) => `https://api.smartrecruiters.com/v1/companies/${company}/postings/${id}`,
    async interpret(res) {
      let json;
      try { json = await res.json(); } catch { return null; }
      return json && typeof json === 'object' && !Array.isArray(json)
        && (typeof json.id === 'string' || typeof json.name === 'string' || json.jobAd)
        ? { result: 'active', code: 'smartrecruiters_api_ok', reason: 'SmartRecruiters API returned a structured posting' }
        : null;
    },
  },
  {
    id: 'teamtailor',
    // The public RSS feed is the no-auth per-tenant API. Absence is inconclusive
    // because some boards paginate or limit their feed; only a matching row proves live.
    match(u) {
      const host = u.hostname.match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.teamtailor\.com$/i);
      const m = u.pathname.match(/^\/jobs\/([^/]+)\/?$/);
      return host && m ? { tenant: host[1], jobPath: m[1] } : null;
    },
    api: ({ tenant }) => `https://${tenant}.teamtailor.com/jobs.rss`,
    format: 'xml',
    async interpret(res, parts) {
      let xml;
      try { xml = await res.text(); } catch { return null; }
      const job = findTeamtailorItem(xml, parts.jobPath);
      return job
        ? { result: 'active', code: 'teamtailor_api_ok', reason: 'Teamtailor RSS includes the posting' }
        : null;
    },
  },
];

function decodeXmlText(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}

function findTeamtailorItem(xml, jobPath) {
  if (typeof xml !== 'string') return null;
  const expected = String(jobPath).replace(/\/$/, '').toLowerCase();
  for (const item of xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || []) {
    const link = decodeXmlText(item.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1]);
    try {
      const path = new URL(link).pathname.replace(/\/$/, '').toLowerCase();
      if (path === `/jobs/${expected}` || path.endsWith(`/jobs/${expected}`)) return item;
    } catch {}
  }
  return null;
}

export function classifyWorkdayPosting(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const info = json.jobPostingInfo;
  if (info && typeof info === 'object'
      && (typeof info.title === 'string' || typeof info.jobDescription === 'string')) {
    return { result: 'active', code: 'workday_api_ok', reason: 'Workday API returned a structured posting' };
  }
  if (/not[_ -]?found|removed|unlisted/i.test(String(json.errorCode || json.error || ''))) {
    return { result: 'expired', code: 'workday_api_removed', reason: 'Workday API explicitly reports the posting removed' };
  }
  return null;
}

/**
 * Decide liveness for one Ashby posting from its org's job-board API payload.
 * Pure + deterministic (no I/O), mirroring classifyLiveness in liveness-core.mjs.
 *
 * The public board lists only currently-published postings, so a posting that is
 * absent (or explicitly `isListed: false`) has been removed/unlisted → expired.
 * A present, listed posting → active. An unexpected shape → null (inconclusive),
 * so a future API change degrades to a Playwright fallback rather than a false
 * "expired".
 *
 * @param {any} json - parsed job-board response, expected shape `{ jobs: [...] }`
 * @param {string} jobId - the {jobId} from jobs.ashbyhq.com/{org}/{jobId}
 * @returns {{ result: 'active' | 'expired', code: string, reason: string } | null}
 */
export function classifyAshbyBoard(json, jobId) {
  if (!json || !Array.isArray(json.jobs)) return null; // unexpected shape → fall back
  const target = String(jobId).toLowerCase();
  const job = json.jobs.find((j) => typeof j?.id === 'string' && j.id.toLowerCase() === target);
  if (job && job.isListed !== false) {
    return { result: 'active', code: 'ashby_api_ok', reason: 'Ashby posting is listed on the board (live)' };
  }
  return { result: 'expired', code: 'ashby_api_unlisted', reason: 'Ashby posting not listed on the board — removed/unlisted' };
}

/**
 * Map a posting URL to its ATS API URL, or null if it isn't a known ATS posting
 * (or any extracted segment fails the strict charset). Pure + deterministic.
 * @param {string} rawUrl
 * @returns {{ ats: string, apiUrl: string, parts: Record<string, string>, timeoutMs?: number, interpret?: (res: Response, parts: Record<string, string>) => Promise<{ result: 'active' | 'expired', code: string, reason: string } | null> } | null}
 */
export function resolveAtsApi(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  for (const provider of ATS_PROVIDERS) {
    const parts = provider.match(u);
    if (!parts) continue;
    // SSRF guard: every derived segment must be a single safe path segment.
    if (!Object.values(parts).every(isSafeValue)) return null;
    return {
      ats: provider.id,
      apiUrl: provider.api(parts),
      parts,
      timeoutMs: provider.timeoutMs,
      interpret: provider.interpret,
      format: provider.format || 'json',
    };
  }
  return null;
}

function toPlainText(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  // Keep long descriptions intact while still using the shared provider HTML
  // converter. Its public helper caps a single input at 4,000 characters.
  if (trimmed.length <= 3_800) return htmlToText(trimmed);
  const chunks = [];
  for (let offset = 0; offset < trimmed.length;) {
    let end = Math.min(offset + 3_000, trimmed.length);
    if (end < trimmed.length) {
      const boundary = trimmed.lastIndexOf('>', end);
      const space = trimmed.lastIndexOf(' ', end);
      if (boundary > offset + 1_500) end = boundary + 1;
      else if (space > offset + 1_500) end = space + 1;
    }
    chunks.push(htmlToText(trimmed.slice(offset, end)));
    offset = end;
  }
  return chunks.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function firstText(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

function descriptionFromSmartRecruiters(json) {
  const sections = json?.jobAd?.sections;
  if (!sections || typeof sections !== 'object') return '';
  const ordered = Array.isArray(json.jobAd.sectionsOrder)
    ? json.jobAd.sectionsOrder.map((key) => sections[key]).filter(Boolean)
    : Object.values(sections);
  return ordered.map((section) => [section?.title, section?.text]
    .filter((part) => typeof part === 'string' && part.trim())
    .map(toPlainText).join('\n'))
    .filter(Boolean).join('\n\n').trim();
}

function extractTeamtailorDescription(item) {
  const encoded = item?.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i)?.[1];
  return encoded ? toPlainText(decodeXmlText(encoded)) : '';
}

/**
 * Fetch and classify one ATS posting, including its description when the API
 * returns one. `fetchImpl` exists for deterministic offline tests; requests are
 * still pinned to provider-derived HTTPS hosts and refuse redirects.
 *
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{result: 'active' | 'expired', code: string, reason: string, description: string, finalUrl: string} | null>}
 *   null means unsupported or inconclusive and is the signal for the browser rung.
 */
export async function fetchAtsPosting(url, { fetchImpl = fetch } = {}) {
  const resolved = resolveAtsApi(url);
  if (!resolved) return null;
  const { ats, apiUrl, parts, format, timeoutMs } = resolved;
  let requestUrl = apiUrl;
  if (ats === 'greenhouse') {
    const withContent = new URL(requestUrl);
    withContent.searchParams.set('content', 'true');
    requestUrl = withContent.href;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetchImpl(requestUrl, {
        method: 'GET',
        headers: { 'user-agent': 'career-ops-liveness/1.0', accept: format === 'xml' ? 'application/rss+xml, application/xml, text/xml' : 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      return null;
    }
    if (response.status === 404 || response.status === 410) {
      return { result: 'expired', code: `${ats}_api_gone`, reason: `ATS API ${response.status} — posting removed`, description: '', finalUrl: url };
    }
    if (response.status !== 200) return null;

    let json = null;
    let xml = '';
    if (format === 'xml') {
      try { xml = await response.text(); } catch { return null; }
    } else {
      try { json = await response.json(); } catch { return null; }
    }

    let classification;
    let description = '';
    if (ats === 'ashby') {
      classification = classifyAshbyBoard(json, parts.jobId);
      const job = Array.isArray(json?.jobs)
        ? json.jobs.find((item) => String(item?.id || '').toLowerCase() === parts.jobId.toLowerCase())
        : null;
      description = firstText(job?.descriptionPlain, job?.descriptionHtml, job?.description);
    } else if (ats === 'workday') {
      classification = classifyWorkdayPosting(json);
      description = firstText(json?.jobPostingInfo?.jobDescription);
    } else if (ats === 'smartrecruiters') {
      classification = json && typeof json === 'object' && !Array.isArray(json)
        && (typeof json.id === 'string' || typeof json.name === 'string' || json.jobAd)
        ? { result: 'active', code: 'smartrecruiters_api_ok', reason: 'SmartRecruiters API returned a structured posting' }
        : null;
      description = descriptionFromSmartRecruiters(json);
    } else if (ats === 'teamtailor') {
      const item = findTeamtailorItem(xml, parts.jobPath);
      classification = item
        ? { result: 'active', code: 'teamtailor_api_ok', reason: 'Teamtailor RSS includes the posting' }
        : null;
      description = extractTeamtailorDescription(item);
    } else {
      // Greenhouse and Lever use per-job endpoints: a 200 response is the
      // provider's definitive evidence that the requested posting exists.
      classification = { result: 'active', code: `${ats}_api_ok`, reason: 'ATS API returns the posting (live)' };
      if (ats === 'greenhouse') description = firstText(json?.content, json?.job?.content);
      if (ats === 'lever') {
        const lists = Array.isArray(json?.lists) ? json.lists.map((item) => {
          const title = firstText(item?.text);
          const content = firstText(item?.content, item?.description);
          return [title, content].filter(Boolean).join('\n');
        }).filter(Boolean).join('\n\n') : '';
        description = firstText(json?.descriptionPlain, json?.description, lists);
      }
    }
    if (!classification) return null;
    return {
      ...classification,
      description: toPlainText(description),
      finalUrl: url,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** True if `url` is an ATS posting we can check via API (lets callers stay lazy about the browser). */
export function isAtsPosting(url) {
  return resolveAtsApi(url) !== null;
}

/**
 * Zero-token liveness check via the posting's ATS API.
 * @param {string} url
 * @returns {Promise<{ result: 'active' | 'expired', code: string, reason: string } | null>}
 *   null = not a known ATS posting, or inconclusive → caller should fall back to Playwright.
 */
export async function checkLivenessViaApi(url) {
  const resolved = resolveAtsApi(url);
  if (!resolved) return null;
  const { ats, apiUrl, parts, interpret, timeoutMs } = resolved;

  // The timeout guards the whole classification (fetch + any `interpret` body read),
  // since aborting the shared signal also tears down an in-flight res.json().
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(apiUrl, {
        method: 'GET',
        headers: { 'user-agent': 'career-ops-liveness/1.0', accept: 'application/json' },
        redirect: 'error', // refuse server-side redirects (SSRF + ambiguity guard)
        signal: controller.signal,
      });
    } catch {
      return null; // network / timeout / redirect → inconclusive, let Playwright decide
    }

    if (res.status === 404 || res.status === 410) {
      return { result: 'expired', code: `${ats}_api_gone`, reason: `ATS API ${res.status} — posting removed` };
    }
    if (res.status === 200) {
      // Org-level APIs (Ashby) inspect the body to confirm THIS posting; per-job
      // APIs (Greenhouse, Lever) treat a 200 as proof the posting is live.
      if (interpret) return await interpret(res, parts);
      return { result: 'active', code: `${ats}_api_ok`, reason: 'ATS API returns the posting (live)' };
    }
    return null; // 429/5xx/other → inconclusive, fall back to the browser check
  } catch {
    return null; // interpret abort / unexpected error → inconclusive
  } finally {
    clearTimeout(timer);
  }
}
