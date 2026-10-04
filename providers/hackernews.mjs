// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';

// Hacker News "Ask HN: Who is hiring?" provider. The monthly thread is
// free-form, so candidate structure is accepted only when it can be extracted
// conservatively. The HN comment remains provenance; it is never presented as
// an external job URL.

const SEARCH_URL =
  'https://hn.algolia.com/api/v1/search_by_date?tags=story&query=Ask%20HN%20Who%20is%20hiring&hitsPerPage=5';

const RECOGNIZED_ATS_DOMAINS = [
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'myworkdayjobs.com',
  'workable.com',
  'recruitee.com',
  'smartrecruiters.com',
  'teamtailor.com',
];

function isHostOrSubdomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/** @param {string} id */
function itemUrl(id) {
  return `https://hn.algolia.com/api/v1/items/${id}`;
}

/** @param {string} text */
function extractUrls(text) {
  const out = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    let value = match[0].replace(/[.,;!?]+$/, '');
    while (value.endsWith(')')) {
      const closes = value.match(/\)/g)?.length || 0;
      const opens = value.match(/\(/g)?.length || 0;
      if (closes <= opens) break;
      value = value.slice(0, -1);
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') out.push(parsed.href);
    } catch {}
  }
  return [...new Set(out)];
}

function isLinkedInPersonalProfile(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)linkedin\.com$/i.test(parsed.hostname) && /^\/(?:in|pub)\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function jobUrlScore(url, sourceUrl) {
  if (!url || url === sourceUrl || isLinkedInPersonalProfile(url)) return -Infinity;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host === 'news.ycombinator.com' || host === 'hn.algolia.com') return -Infinity;
    if (RECOGNIZED_ATS_DOMAINS.some((domain) => isHostOrSubdomain(host, domain))) return 500;

    const linkedIn = isHostOrSubdomain(host, 'linkedin.com');
    if (linkedIn && /^\/jobs\//.test(path)) return 200;
    if (['twitter.com', 'x.com', 'facebook.com', 'instagram.com']
      .some((domain) => isHostOrSubdomain(host, domain))) return -Infinity;

    const jobHost = /^(?:jobs|careers|apply)\./.test(host);
    const directJobPath = /(?:^|\/)(?:jobs?|careers?|openings?|positions?|vacancies|apply)\/[^/]+/.test(path);
    if (directJobPath || (jobHost && path !== '/')) return 400;

    const careersPage = /(?:^|\/)(?:jobs?|careers?|openings?|positions?|vacancies|apply)\/?$/.test(path);
    if (careersPage || jobHost) return 300;
    return 0;
  } catch {
    return -Infinity;
  }
}

function selectJobUrl(text, sourceUrl) {
  return extractUrls(text)
    .map((url, index) => ({ url, index, score: jobUrlScore(url, sourceUrl) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.url || '';
}

function cleanHeaderSegment(value) {
  return value
    .replace(/^\s*[*_`]+|[*_`]+\s*$/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function looksNonLocation(value) {
  return /^(?:apply(?: here)?|application|jobs?|careers?|website|url|link)\s*:?[.!-]?$/i.test(value)
    || /^(?:full[- ]?time|part[- ]?time|contract|internship|freelance)\s*:?[.!-]?$/i.test(value)
    || /(?:visa|sponsor|salary|equity|€|\$|£|\b(?:python|javascript|typescript|react|node\.js|sql|terraform)\b)/i.test(value);
}

function plainText(text) {
  return text
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis, (_, href, label) => `${label} ${href}`)
    .replace(/<\/?(?:p|br|div|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[A-Za-z#0-9]+;/g, (entity) => decodeEntities(entity))
    .replace(/\r\n?/g, '\n');
}

/**
 * @param {string} text
 * @param {string} threadUrl Per-comment HN provenance URL.
 * @returns {{title:string,url:string,company:string,location:string,description:string,sourceUrl:string}|null}
 */
export function parseHnComment(text, threadUrl = '') {
  if (!text || typeof text !== 'string') return null;
  const plain = plainText(text);
  const lines = plain.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const firstLine = lines[0];
  const parts = firstLine.split('|').map(cleanHeaderSegment).filter(Boolean);
  let company = '';
  let title = '';
  let location = '';

  if (parts.length >= 2) {
    company = parts[0];
    title = parts[1];
    const locationCandidates = parts.slice(2).filter((part) => part && !looksNonLocation(part));
    location = locationCandidates[0] || '';
    if (/\b(?:remote|hybrid|on[- ]?site)\b/i.test(location) && locationCandidates[1]) {
      location = `${location}; ${locationCandidates[1]}`;
    }
  } else {
    // Do not turn long prose or candidate self-advertisements into job rows.
    if (firstLine.length > 120 || /[.!?]$/.test(firstLine)
        || /^(?:i am|i'm|looking for|software engineer with)\b/i.test(firstLine)) return null;
    title = cleanHeaderSegment(firstLine);
  }
  if (!title) return null;

  return {
    title,
    url: selectJobUrl(plain, threadUrl),
    company,
    location,
    description: lines.join('\n'),
    sourceUrl: threadUrl,
  };
}

export function resolveLatestThreadId(data) {
  if (!data || typeof data !== 'object') return null;
  const hits = /** @type {any} */ (data).hits;
  if (!Array.isArray(hits) || hits.length === 0) return null;
  const pattern = /ask\s+hn[:\s]+who\s+is\s+hiring/i;
  for (const hit of hits) {
    if (hit && typeof hit.objectID === 'string' && typeof hit.title === 'string' && pattern.test(hit.title)) {
      return hit.objectID;
    }
  }
  return null;
}

/** @type {Provider} */
export default {
  id: 'hackernews',

  detect(entry) {
    return entry?.provider === 'hackernews' ? { url: SEARCH_URL } : null;
  },

  async fetch(entry, ctx) {
    const searchData = await ctx.fetchJson(SEARCH_URL, { redirect: 'error' });
    if (!searchData || typeof searchData !== 'object' || !Array.isArray(searchData.hits)) {
      throw new Error('hackernews: malformed search response (expected hits array)');
    }
    const threadId = resolveLatestThreadId(searchData);
    if (!threadId) throw new Error('hackernews: could not find "Ask HN: Who is hiring?" thread in search results');

    const threadHnUrl = `https://news.ycombinator.com/item?id=${threadId}`;
    const item = await ctx.fetchJson(itemUrl(threadId), { redirect: 'error' });
    if (!item || typeof item !== 'object') {
      throw new Error(`hackernews: unexpected item response for thread ${threadId}`);
    }
    const children = /** @type {any} */ (item).children;
    if (!Array.isArray(children)) {
      throw new Error(`hackernews: malformed item response for thread ${threadId} (expected children array)`);
    }

    const jobs = [];
    for (const child of children) {
      if (!child || child.deleted || child.dead) continue;
      const text = typeof child.text === 'string' ? child.text : '';
      if (!text.trim()) continue;
      const childId = String(child.id ?? child.objectID ?? '');
      const commentUrl = /^\d+$/.test(childId)
        ? `https://news.ycombinator.com/item?id=${childId}`
        : threadHnUrl;
      const parsed = parseHnComment(text, commentUrl);
      // Without an external job/careers URL there is no safe candidate URL.
      if (!parsed?.url) continue;
      jobs.push({
        title: parsed.title,
        url: parsed.url,
        company: parsed.company || (entry.name || 'HN Hiring'),
        location: parsed.location,
        description: parsed.description,
        sourceUrl: parsed.sourceUrl,
        ...(child.created_at ? { postedAt: Date.parse(child.created_at) || undefined } : {}),
      });
    }
    return jobs;
  },
};
