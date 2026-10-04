// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';
import { requireUsableRows } from './_payload.mjs';

const GEM_API_URL = 'https://jobs.gem.com/api/public/graphql/batch';
const GEM_HOST = 'jobs.gem.com';

const JOB_BOARD_LIST_QUERY = `query JobBoardList($boardId: String!) {
  oatsExternalJobPostings(boardId: $boardId) {
    jobPostings {
      id extId title
      locations { id name city isoCountry isRemote extId __typename }
      job { id department { id name extId __typename } locationType employmentType __typename }
      __typename
    }
    __typename
  }
}`;

const JOB_DETAIL_QUERY = `query ExternalJobPostingQuery($boardId: String!, $extId: String!) {
  oatsExternalJobPosting(boardId: $boardId, extId: $extId) {
    extId firstPublishedTsSec descriptionHtml
    jobPostSectionHtml { introHtml outroHtml }
    compensationHtml __typename
  }
}`;

function assertGemUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`gem: invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') throw new Error(`gem: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== GEM_HOST) throw new Error(`gem: untrusted hostname "${parsed.hostname}" - must be ${GEM_HOST}`);
  return url;
}

function resolveBoardId(entry) {
  const raw = typeof entry?.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.hostname !== GEM_HOST) return null;
    const match = parsed.pathname.match(/^\/([A-Za-z0-9_-]+)\/?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function toEpochMsFromSeconds(value) {
  if (value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number * 1000 : undefined;
}

function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function buildDescription(posting) {
  const intro = htmlToText(posting?.jobPostSectionHtml?.introHtml);
  const body = htmlToText(posting?.descriptionHtml);
  const outro = htmlToText(posting?.jobPostSectionHtml?.outroHtml);
  const compensation = htmlToText(posting?.compensationHtml);
  const text = [intro, body, outro].filter(Boolean).join('\n\n');
  return compensation ? [text, `Compensation: ${compensation}`].filter(Boolean).join('\n\n') : text;
}

function formatLocation(location) {
  const parts = [];
  if (typeof location?.name === 'string' && location.name.trim()) parts.push(location.name.trim());
  if (location?.isRemote === true) parts.push('Remote');
  return parts.join(' - ');
}

function normalizeListing(posting, entry, boardId) {
  if (!posting || typeof posting !== 'object') return null;
  const extId = typeof posting.extId === 'string' ? posting.extId.trim() : '';
  const title = typeof posting.title === 'string' ? posting.title.trim() : '';
  if (!extId || !title || !/^[A-Za-z0-9_-]+$/.test(extId)) return null;
  return {
    title,
    url: `https://${GEM_HOST}/${encodeURIComponent(boardId)}/${encodeURIComponent(extId)}`,
    company: typeof entry?.name === 'string' ? entry.name : '',
    location: Array.isArray(posting.locations)
      ? [...new Set(posting.locations.map(formatLocation).filter(Boolean))].join(' - ')
      : '',
    extId,
  };
}

function markDegraded(jobs, reason) {
  Object.defineProperty(jobs, 'providerDegraded', { value: true, enumerable: false });
  Object.defineProperty(jobs, 'providerDegradedReason', { value: reason, enumerable: false });
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'gem',

  detect(entry) {
    const boardId = resolveBoardId(entry);
    return boardId ? { url: `${GEM_API_URL}?board=${encodeURIComponent(boardId)}` } : null;
  },

  async fetch(entry, ctx) {
    const boardId = resolveBoardId(entry);
    if (!boardId) throw new Error(`gem: cannot derive a safe board id for ${entry?.name || 'entry'}`);
    assertGemUrl(GEM_API_URL);

    const listBody = JSON.stringify([
      { operationName: 'JobBoardList', variables: { boardId }, query: JOB_BOARD_LIST_QUERY },
    ]);
    const json = await ctx.fetchJson(GEM_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', batch: 'true' },
      body: listBody,
      redirect: 'error',
    });
    if (!Array.isArray(json) || !json[0] || typeof json[0] !== 'object') {
      throw new Error('gem: malformed JobBoardList response');
    }
    const listResult = json[0];
    if (Array.isArray(listResult.errors) && listResult.errors.length > 0) {
      throw new Error(`gem: JobBoardList failed: ${listResult.errors[0]?.message || 'unknown GraphQL error'}`);
    }
    const postings = listResult?.data?.oatsExternalJobPostings?.jobPostings;
    if (!Array.isArray(postings)) throw new Error('gem: malformed JobBoardList response (expected jobPostings array)');

    const listings = postings.map((posting) => normalizeListing(posting, entry, boardId)).filter(Boolean);
    requireUsableRows(postings, listings, 'gem JobBoardList');
    if (listings.length === 0) return [];

    const byExtId = new Map(listings.map((job) => [job.extId, job]));
    try {
      const detailBody = JSON.stringify(listings.map((job) => ({
        operationName: 'ExternalJobPostingQuery',
        variables: { boardId, extId: job.extId },
        query: JOB_DETAIL_QUERY,
      })));
      const details = await ctx.fetchJson(GEM_API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', batch: 'true' },
        body: detailBody,
        redirect: 'error',
      });
      if (!Array.isArray(details)) throw new Error('detail response is not an array');
      const receivedExtIds = new Set();
      for (const detail of details) {
        if (Array.isArray(detail?.errors) && detail.errors.length > 0) throw new Error('detail GraphQL error');
        const posting = detail?.data?.oatsExternalJobPosting;
        const job = byExtId.get(posting?.extId);
        if (!job) continue;
        receivedExtIds.add(posting.extId);
        const postedAt = toEpochMsFromSeconds(posting.firstPublishedTsSec);
        if (postedAt !== undefined) job.postedAt = postedAt;
        const description = buildDescription(posting);
        if (description) job.description = description;
      }
      if (receivedExtIds.size !== listings.length) {
        throw new Error(`detail response covered ${receivedExtIds.size} of ${listings.length} listing(s)`);
      }
    } catch (error) {
      const clean = listings.map(({ extId, ...job }) => job);
      return markDegraded(clean, `gem detail enrichment failed: ${error.message}`);
    }

    return listings.map(({ extId, ...job }) => job);
  },
};
