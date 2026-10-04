// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry } from './_http.mjs';
import { requireUsableRows } from './_payload.mjs';

const BOARD_HOST = 'jobs.jobvite.com';
const FEED_HOST = 'app.jobvite.com';
const ALLOWED_HOSTS = new Set([BOARD_HOST, FEED_HOST]);
const FEED_TIMEOUT_MS = 45_000;
const RETRY_POLICY = {
  retries: 2, baseDelayMs: 1000, maxDelayMs: 15_000, maxRetryAfterMs: 60_000,
};
const PREDEFINED_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos', 'nbsp']);

function assertJobviteUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`jobvite: invalid URL: ${value}`); }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`jobvite: untrusted URL: ${value}`);
  }
  return parsed.href;
}

function validEid(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(value.trim());
}

/** Return the first board path component for the supported Jobvite host. */
export function resolveSlug(entry) {
  const raw = typeof entry?.careers_url === 'string' ? entry.careers_url : '';
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== BOARD_HOST) return null;
  const slug = parsed.pathname.split('/').filter(Boolean)[0] || '';
  return slug && slug.toLowerCase() !== 'api' ? slug : null;
}

/** Explicit company_eid wins; api is accepted only for the current XML feed. */
export function resolveConfiguredEid(entry) {
  const direct = typeof entry?.company_eid === 'string' ? entry.company_eid.trim() : '';
  if (validEid(direct)) return direct;
  const raw = typeof entry?.api === 'string' ? entry.api.trim() : '';
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== FEED_HOST
      || parsed.pathname.toLowerCase() !== '/companyjobs/xml.aspx') return null;
  const eid = parsed.searchParams.get('c')?.trim() || '';
  return validEid(eid) ? eid : null;
}

export function extractEidFromBoard(html) {
  if (typeof html !== 'string') return null;
  const match = html.match(/companyEId\s*[:=]\s*['"]([A-Za-z0-9_-]{4,40})['"]/);
  return match ? match[1] : null;
}

function buildFeedUrl(eid) {
  const url = new URL(`https://${FEED_HOST}/CompanyJobs/Xml.aspx`);
  url.searchParams.set('c', eid);
  return url.href;
}

function buildBoardUrl(slug, discovery = false) {
  const url = new URL(`https://${BOARD_HOST}/${encodeURIComponent(slug)}`);
  if (discovery) {
    url.searchParams.set('fr', 'true');
    url.searchParams.set('nl', '1');
  }
  return url.href;
}

function xml10Char(codePoint) {
  return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function assertXml10Text(text) {
  for (const char of text) {
    if (!xml10Char(char.codePointAt(0))) throw new Error('jobvite: malformed XML feed (XML 1.0-invalid character)');
  }
}

function assertXml10References(xml) {
  for (let cursor = 0; cursor < xml.length;) {
    if (xml.startsWith('<![CDATA[', cursor)) {
      const end = xml.indexOf(']]>', cursor + 9);
      if (end < 0) throw new Error('jobvite: malformed XML feed (unterminated CDATA)');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith(']]>', cursor)) throw new Error('jobvite: malformed XML feed (CDATA terminator outside CDATA)');
    if (xml[cursor] !== '&') { cursor++; continue; }

    const end = xml.indexOf(';', cursor + 1);
    if (end < 0) throw new Error('jobvite: malformed XML feed (unterminated entity reference)');
    const body = xml.slice(cursor + 1, end);
    if (!body || /[&<\s]/.test(body)) throw new Error('jobvite: malformed XML feed (invalid entity reference)');
    if (body[0] === '#') {
      const numeric = body.match(/^#([xX])?([0-9a-fA-F]+)$/);
      if (!numeric || (!numeric[1] && !/^#\d+$/.test(body))) {
        throw new Error('jobvite: malformed XML feed (invalid numeric entity reference)');
      }
      const code = Number.parseInt(numeric[2], numeric[1] ? 16 : 10);
      if (!Number.isFinite(code) || !xml10Char(code)) {
        throw new Error('jobvite: malformed XML feed (XML 1.0-invalid character reference)');
      }
    } else if (!/^[A-Za-z][A-Za-z0-9]+$/.test(body) || !PREDEFINED_ENTITIES.has(body.toLowerCase())) {
      throw new Error(`jobvite: malformed XML feed (unknown entity &${body};)`);
    }
    cursor = end + 1;
  }
}

function countJobBlocks(body) {
  let count = 0;
  let cursor = 0;
  while (true) {
    const open = findOutsideCdata(body, '<job>', cursor);
    const close = findOutsideCdata(body, '</job>', cursor);
    if (open === -1 && close === -1) break;
    if (close !== -1 && (open === -1 || close < open)) throw new Error('jobvite: malformed XML feed (unmatched job close tag)');
    if (open === -1) break;
    const end = findOutsideCdata(body, '</job>', open + 5);
    if (end === -1) throw new Error('jobvite: malformed XML feed (unterminated job record)');
    count++;
    cursor = end + 6;
  }
  if (/<job(?:\s|>)/i.test(body.replaceAll('<job>', '').replaceAll('</job>', ''))) {
    throw new Error('jobvite: malformed XML feed (unsupported job element)');
  }
  return count;
}

function findOutsideCdata(source, needle, from = 0) {
  let cursor = from;
  while (cursor < source.length) {
    const match = source.indexOf(needle, cursor);
    const cdata = source.indexOf('<![CDATA[', cursor);
    if (match < 0) return -1;
    if (cdata < 0 || match < cdata) return match;
    const end = source.indexOf(']]>', cdata + 9);
    if (end < 0) return -1;
    cursor = end + 3;
  }
  return -1;
}

function validateFeed(xml) {
  assertXml10Text(xml);
  assertXml10References(xml);
  let source = xml.replace(/^\uFEFF/, '').trim();
  if (source.startsWith('<?xml')) {
    const declarationEnd = source.indexOf('?>');
    if (declarationEnd < 0) throw new Error('jobvite: malformed XML feed (unterminated declaration)');
    source = source.slice(declarationEnd + 2).trimStart();
  }
  if (!source.startsWith('<result') || !/^<result(?:\s|>|\/)/.test(source)) {
    throw new Error('jobvite: malformed XML feed (expected result root)');
  }
  const rootEnd = source.indexOf('>');
  if (rootEnd < 0) throw new Error('jobvite: malformed XML feed (unclosed result root)');
  if (source.slice(0, rootEnd).trimEnd().endsWith('/')) {
    if (source.slice(rootEnd + 1).trim()) throw new Error('jobvite: malformed XML feed (content after empty result root)');
    return { body: '', jobs: 0 };
  }
  const closeAt = findOutsideCdata(source, '</result>', rootEnd + 1);
  if (rootEnd < 0 || closeAt < rootEnd || source.slice(closeAt + 9).trim()) {
    throw new Error('jobvite: malformed XML feed (unclosed result root)');
  }
  const body = source.slice(rootEnd + 1, closeAt);
  return { body, jobs: countJobBlocks(body) };
}

function decodeJobviteText(value) {
  const decoded = decodeEntities(value);
  assertXml10Text(decoded);
  return decoded;
}

function tagText(block, name) {
  const open = `<${name}>`;
  const close = `</${name}>`;
  const start = findOutsideCdata(block, open);
  if (start < 0) return '';
  const valueStart = start + open.length;
  const end = findOutsideCdata(block, close, valueStart);
  if (end < 0) return '';
  let value = block.slice(valueStart, end).trim();
  if (value.startsWith('<![CDATA[') && value.endsWith(']]>')) value = value.slice(9, -3).trim();
  return value;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const mdy = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const month = Number(mdy[1]); const day = Number(mdy[2]); const year = Number(mdy[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return date.getTime();
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeDisplayUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(decodeJobviteText(value));
    if (parsed.protocol === 'http:') parsed.protocol = 'https:';
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch { return ''; }
}

/** Parse the current XML feed. No request is made for descriptions or details. */
export function parseJobviteXml(xml, companyName = 'Jobvite', sourceUrl = '') {
  if (typeof xml !== 'string' || !xml.trim()) return [];
  const { body } = validateFeed(xml);
  const jobs = [];
  let cursor = 0;
  while (true) {
    const start = findOutsideCdata(body, '<job>', cursor);
    if (start < 0) break;
    const contentStart = start + 5;
    const end = findOutsideCdata(body, '</job>', contentStart);
    if (end < 0) throw new Error('jobvite: malformed XML feed (unterminated job record)');
    cursor = end + 6;
    const record = body.slice(contentStart, end);
    const title = decodeJobviteText(tagText(record, 'title')).trim();
    if (!title) continue;
    const detailUrl = safeDisplayUrl(tagText(record, 'detail-url'));
    const applyUrl = safeDisplayUrl(tagText(record, 'apply-url'));
    const url = detailUrl || applyUrl;
    if (!url) continue;
    const job = {
      title, url,
      company: typeof companyName === 'string' && companyName.trim() ? companyName.trim() : 'Jobvite',
      location: decodeJobviteText(tagText(record, 'location')).trim(),
    };
    const id = decodeJobviteText(tagText(record, 'id')).trim();
    if (id) job.sourceId = id;
    if (sourceUrl && sourceUrl !== url) job.sourceUrl = sourceUrl;
    const postedAt = toEpochMs(decodeJobviteText(tagText(record, 'date')).trim());
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }
  return jobs;
}

function isEmptyBoardRedirect(error, requestUrl) {
  if (typeof error?.status !== 'number' || error.status < 300 || error.status > 399 || !error.location) return false;
  let target;
  try { target = new URL(error.location, requestUrl); } catch { return false; }
  return target.origin === `https://${FEED_HOST}` && !target.username && !target.password
    && target.pathname.toLowerCase() === '/companyjobs/nojobs.htm';
}

/** @type {Provider} */
export default {
  id: 'jobvite',

  detect(entry) {
    const eid = resolveConfiguredEid(entry);
    if (eid) return { url: buildFeedUrl(eid) };
    const slug = resolveSlug(entry);
    return slug ? { url: buildBoardUrl(slug) } : null;
  },

  async fetch(entry, ctx) {
    if (typeof ctx?.fetchText !== 'function') throw new Error('jobvite: ctx.fetchText transport is required');
    let eid = resolveConfiguredEid(entry);
    if (!eid) {
      const slug = resolveSlug(entry);
      if (!slug) throw new Error(`jobvite: ${entry?.name || 'entry'} needs company_eid, a current XML api URL, or a jobs.jobvite.com careers_url`);
      const boardUrl = assertJobviteUrl(buildBoardUrl(slug, true));
      const html = await fetchTextWithRetry(ctx, boardUrl, { redirect: 'error' }, RETRY_POLICY);
      eid = extractEidFromBoard(html);
      if (!eid) throw new Error(`jobvite: could not find companyEId on ${boardUrl} for ${entry?.name || 'board'}`);
    }

    const feedUrl = assertJobviteUrl(buildFeedUrl(eid));
    try {
      const xml = await fetchTextWithRetry(ctx, feedUrl, {
        redirect: 'manual', timeoutMs: FEED_TIMEOUT_MS,
      }, RETRY_POLICY);
      const parsedFeed = validateFeed(xml);
      const jobs = parseJobviteXml(xml, entry?.name || 'Jobvite', feedUrl);
      requireUsableRows({ length: parsedFeed.jobs }, jobs, 'jobvite feed');
      return jobs;
    } catch (error) {
      if (isEmptyBoardRedirect(error, feedUrl)) return [];
      throw error;
    }
  },
};
