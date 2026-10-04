// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { BROWSER_LIKE_USER_AGENT, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { markProviderCoverage } from './_result.mjs';

const MAX_PAGES = 30;
const INTER_PAGE_DELAY_MS = 250;
const DNS_LABEL_RE = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const HOST_SUFFIX = '.icims.com';
const HEADERS = {
  'user-agent': BROWSER_LIKE_USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

function isIcimsHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host.length > 253 || !host.endsWith(HOST_SUFFIX)) return false;
  const labels = host.split('.');
  return labels.length >= 3 && labels.every((label) => DNS_LABEL_RE.test(label));
}

function parseIcimsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || !isIcimsHostname(url.hostname)) return null;
  // WHATWG URL normalizes the default HTTPS port to an empty string.
  if (url.port) return null;
  return { hostname: url.hostname.toLowerCase(), origin: url.origin };
}

function resolveHosts(entry) {
  const primary = parseIcimsUrl(entry?.api) || parseIcimsUrl(entry?.careers_url);
  if (!primary) return null;
  const hosts = [primary];
  const seen = new Set([primary.origin]);
  if (Array.isArray(entry?.fallback_urls)) {
    for (const candidate of entry.fallback_urls) {
      const host = parseIcimsUrl(candidate);
      if (!host || seen.has(host.origin)) continue;
      seen.add(host.origin);
      hosts.push(host);
    }
  }
  return hosts;
}

function buildSearchUrl(host, page) {
  const url = new URL('/jobs/search', host.origin);
  url.searchParams.set('ss', '1');
  url.searchParams.set('pr', String(page));
  url.searchParams.set('in_iframe', '1');
  return url.href;
}

function attributesOf(tagText) {
  const nameEnd = tagText.search(/[\s/>]/);
  const raw = nameEnd < 0 ? '' : tagText.slice(nameEnd);
  const attrs = Object.create(null);
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of raw.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function parseHtml(html) {
  const root = { tag: '#root', attrs: Object.create(null), children: [], parent: null };
  const stack = [root];
  const tokens = String(html).matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][A-Za-z0-9:-]*\b[^>]*>|[^<]+|</g);
  for (const token of tokens) {
    const value = token[0];
    if (value.startsWith('<!--') || /^<!/i.test(value)) continue;
    const closing = /^<\//.test(value);
    const tag = /^<\/?([A-Za-z][A-Za-z0-9:-]*)/.exec(value)?.[1]?.toLowerCase();
    if (!tag) {
      if (value !== '<') stack[stack.length - 1].children.push({ text: value });
      continue;
    }
    if (closing) {
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index].tag === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const node = { tag, attrs: attributesOf(value), children: [], parent: stack[stack.length - 1] };
    stack[stack.length - 1].children.push(node);
    if (!VOID_ELEMENTS.has(tag) && !/\/\s*>$/.test(value)) stack.push(node);
  }
  return root;
}

function textContent(node) {
  if (typeof node?.text === 'string') return node.text;
  if (node?.tag === 'br') return ' ';
  return (node?.children || []).map(textContent).join(' ');
}

function cleanText(value) {
  return decodeEntities(String(value || '')).replace(/\s+/g, ' ').trim();
}

function classTokens(node) {
  return String(node?.attrs?.class || '').split(/\s+/).filter(Boolean);
}

function hasClass(node, token) {
  return classTokens(node).some((value) => value.toLowerCase() === token.toLowerCase());
}

function descendants(node, predicate, result = []) {
  for (const child of node?.children || []) {
    if (child.tag && predicate(child)) result.push(child);
    descendants(child, predicate, result);
  }
  return result;
}

function normalizePostingUrl(href, host) {
  if (typeof href !== 'string' || !href.trim()) return null;
  let url;
  try { url = new URL(href.trim(), host.origin); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== host.origin || url.username || url.password) return null;
  const match = /^\/jobs\/(\d+)\/[^/?#]+\/job\/?$/i.exec(url.pathname);
  if (!match) return null;
  url.search = '';
  url.hash = '';
  return { url: url.href, sourceId: match[1] };
}

function fieldValueAfter(label) {
  const parent = label.parent;
  if (!parent) return '';
  const index = parent.children.indexOf(label);
  for (let next = index + 1; next < parent.children.length; next++) {
    const sibling = parent.children[next];
    if (!sibling.tag || sibling.tag.startsWith('#')) continue;
    if (hasClass(sibling, 'iCIMS_JobCardFieldValue')) return cleanText(textContent(sibling));
    // A label's next element is the value in several iCIMS themes even when
    // the theme replaces the stock FieldValue class.
    return cleanText(textContent(sibling));
  }
  return '';
}

function locationFromCard(card) {
  for (const label of descendants(card, (node) => hasClass(node, 'field-label')
    || hasClass(node, 'iCIMS_JobCardFieldLabel'))) {
    const labelText = cleanText(textContent(label)).replace(/\s*:\s*$/, '');
    if (!/\blocation\b/i.test(labelText)) continue;
    const value = fieldValueAfter(label);
    if (value) return value;
  }
  return '';
}

function titleFromCard(card) {
  const heading = descendants(card, (node) => node.tag === 'h3')[0];
  if (!heading) return '';
  for (const name of ['data-title', 'data-job-title', 'data-jobtitle', 'aria-label', 'title']) {
    const value = cleanText(heading.attrs[name]);
    if (value) return value;
  }
  return cleanText(textContent(heading));
}

function parseSearchPage(html, host, company) {
  const root = parseHtml(html);
  const cards = descendants(root, (node) => ['div', 'li'].includes(node.tag) && hasClass(node, 'iCIMS_JobCardItem'));
  const jobs = [];
  for (const card of cards) {
    const anchor = descendants(card, (node) => node.tag === 'a' && node.attrs.href)[0];
    const posting = normalizePostingUrl(anchor?.attrs?.href, host);
    const title = titleFromCard(card);
    if (!posting || !title) continue;
    jobs.push({
      title,
      url: posting.url,
      company: typeof company === 'string' && company.trim() ? company.trim() : 'iCIMS',
      location: locationFromCard(card),
      sourceId: posting.sourceId,
    });
  }
  return { jobs, cardCount: cards.length };
}

function isNotFound(error) {
  return Number(error?.status) === 404;
}

/** Parse a public iCIMS search page into normalized jobs. */
export function parseIcimsSearchPage(html, origin, companyName = 'iCIMS') {
  const originValue = typeof origin === 'string' ? origin
    : origin instanceof URL ? origin.href
      : typeof origin?.origin === 'string' ? origin.origin : '';
  const host = parseIcimsUrl(originValue);
  if (!host) {
    throw new Error('icims: parser requires a validated HTTPS *.icims.com origin');
  }
  return parseSearchPage(html, host, companyName).jobs;
}

function resolveMaxPages(entry, ctx) {
  const configured = Number.isInteger(entry?.max_pages) && entry.max_pages > 0
    ? Math.min(entry.max_pages, MAX_PAGES) : MAX_PAGES;
  return Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0
    ? Math.min(configured, ctx.maxPages)
    : configured;
}

async function requestPage(host, page, ctx) {
  return await ctx.fetchText(buildSearchUrl(host, page), {
    redirect: 'error',
    headers: HEADERS,
  });
}

function scriptType(attrsText) {
  const attrs = attributesOf(`<script ${attrsText}>`);
  return String(attrs.type || '').trim().toLowerCase();
}

function jsonLdNodes(html) {
  const nodes = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of String(html).matchAll(scriptPattern)) {
    if (scriptType(match[1]) !== 'application/ld+json') continue;
    let parsed;
    try { parsed = JSON.parse(match[2].trim()); } catch { continue; }
    collectJsonNodes(parsed, nodes);
  }
  return nodes;
}

function collectJsonNodes(value, nodes) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonNodes(item, nodes);
    return;
  }
  if (!value || typeof value !== 'object') return;
  nodes.push(value);
  if (value['@graph'] != null) collectJsonNodes(value['@graph'], nodes);
}

function isJobPosting(node) {
  const types = Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']];
  return types.some((type) => String(type || '').toLowerCase() === 'jobposting');
}

function parsePostedAt(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.trim();
  const datePart = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/i.exec(normalized);
  if (datePart) {
    const year = Number(datePart[1]);
    const month = Number(datePart[2]);
    const day = Number(datePart[3]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return undefined;
  }
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function firstPostedAt(nodes) {
  const typed = nodes.filter(isJobPosting);
  const typedDates = typed.filter((node) => Object.hasOwn(node, 'datePosted'));
  for (const node of typedDates) {
    const timestamp = parsePostedAt(node.datePosted);
    if (timestamp !== undefined) return timestamp;
  }
  // A present but invalid JobPosting date is authoritative evidence that the
  // page did not provide a usable publication date; don't borrow another
  // schema node's unrelated date (for example, an Organization date).
  if (typedDates.length) return undefined;
  for (const node of nodes) {
    if (isJobPosting(node)) continue;
    const timestamp = parsePostedAt(node.datePosted);
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}

function asList(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function fieldString(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object') return String(value.name ?? value.identifier ?? '').trim();
  return '';
}

function usableLocationPart(value) {
  const clean = fieldString(value);
  return clean && !/^unavailable$/i.test(clean) ? clean : '';
}

function normalizeCountry(value) {
  const candidates = value && typeof value === 'object'
    ? [value.name, value.identifier]
    : [value];
  let country = '';
  for (const candidate of candidates) {
    country = usableLocationPart(candidate);
    if (country) break;
  }
  if (/^US$/i.test(country)) return 'United States';
  if (/^CA$/i.test(country)) return 'Canada';
  return country;
}

function locationFromAddress(address) {
  if (!address || typeof address !== 'object') return '';
  const parts = [
    usableLocationPart(address.addressLocality),
    usableLocationPart(address.addressRegion),
    normalizeCountry(address.addressCountry),
  ].filter(Boolean);
  return [...new Set(parts)].join(', ');
}

function locationFromJsonLd(nodes) {
  const ordered = [...nodes.filter(isJobPosting), ...nodes.filter((node) => !isJobPosting(node))];
  for (const node of ordered) {
    for (const jobLocation of asList(node.jobLocation)) {
      if (!jobLocation || typeof jobLocation !== 'object') continue;
      for (const address of asList(jobLocation.address)) {
        const location = locationFromAddress(address);
        if (location) return location;
      }
    }
  }
  return '';
}

/** @type {Provider} */
const provider = {
  id: 'icims',

  detect(entry) {
    const hosts = resolveHosts(entry);
    return hosts ? { url: buildSearchUrl(hosts[0], 0) } : null;
  },

  async fetch(entry, ctx) {
    if (typeof ctx?.fetchText !== 'function') throw new Error('icims: ctx.fetchText transport is required');
    const hosts = resolveHosts(entry);
    if (!hosts) throw new Error(`icims: ${entry?.name || 'entry'} needs an HTTPS *.icims.com careers_url or api`);

    const maxPages = resolveMaxPages(entry, ctx);
    let activeHost = hosts[0];
    let firstHtml;
    let originalFailure;
    try {
      firstHtml = await requestPage(activeHost, 0, ctx);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      originalFailure = error;
      let found = false;
      for (const candidate of hosts.slice(1)) {
        try {
          firstHtml = await requestPage(candidate, 0, ctx);
          activeHost = candidate;
          found = true;
          break;
        } catch (fallbackError) {
          if (!isNotFound(fallbackError)) throw fallbackError;
        }
      }
      if (!found) throw originalFailure;
    }

    const jobs = [];
    const firstUrls = new Set();
    let pagesFetched = 0;
    let pageCapReached = false;
    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const html = page === 0 ? firstHtml : await requestPage(activeHost, page, ctx);
      const parsed = parseSearchPage(html, activeHost, entry?.name || 'iCIMS');
      pagesFetched++;
      if (parsed.jobs.length === 0) break;

      const firstUrl = parsed.jobs[0].url;
      if (firstUrls.has(firstUrl)) break;
      firstUrls.add(firstUrl);
      jobs.push(...parsed.jobs);

      if (page === maxPages - 1) pageCapReached = true;
    }

    if (pageCapReached) {
      return markProviderCoverage(jobs, {
        status: 'partial',
        code: 'icims_page_cap',
        reason: `${entry?.name || 'iCIMS'} truncated at maxPages=${maxPages}`,
        pagesFetched,
        maxPages,
      });
    }
    return jobs;
  },

  async enrichDate(job, ctx) {
    if (!job || typeof job !== 'object') throw new TypeError('icims: enrichDate requires a job object');
    if (typeof ctx?.fetchText !== 'function') throw new Error('icims: ctx.fetchText transport is required');
    const host = parseIcimsUrl(job.url);
    if (!host) throw new Error('icims: enrichDate requires an HTTPS job URL on *.icims.com');

    const detailUrl = new URL(job.url);
    detailUrl.hash = '';
    detailUrl.searchParams.set('in_iframe', '1');
    const html = await ctx.fetchText(detailUrl.href, {
      redirect: 'error',
      headers: HEADERS,
    });
    const nodes = jsonLdNodes(html);
    const postedAt = firstPostedAt(nodes);
    const hasLocation = typeof job.location === 'string' && job.location.trim() && !/^n\/?a$/i.test(job.location.trim());
    if (job.postedAt == null && postedAt !== undefined) job.postedAt = postedAt;
    if (!hasLocation) {
      const location = locationFromJsonLd(nodes);
      if (location) job.location = location;
    }
    return job;
  },
};

export default provider;
