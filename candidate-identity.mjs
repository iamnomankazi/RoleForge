import { createHash } from 'node:crypto';

export const CANDIDATE_ID_VERSION = 'v1';
export const CANDIDATE_ID_PREFIX = `cand_${CANDIDATE_ID_VERSION}_`;
export const LEGACY_CANDIDATE_ID_PREFIX = `legacy_cand_${CANDIDATE_ID_VERSION}_`;

const TRACKING_QUERY_KEY = /^(?:utm_.+|ref|referrer|source|sourceid|campaign|gh_src|lever-source)$/i;

function clean(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

export function canonicalListingUrl(value) {
  const raw = clean(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_QUERY_KEY.test(key)) url.searchParams.delete(key);
    }
    const entries = [...url.searchParams.entries()]
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
        leftKey.toLowerCase().localeCompare(rightKey.toLowerCase(), 'en')
        || leftValue.localeCompare(rightValue, 'en')
      ));
    url.search = '';
    for (const [key, queryValue] of entries) url.searchParams.append(key, queryValue);
    url.pathname = url.pathname.replace(/\/$/, '') || '/';
    return url.toString();
  } catch {
    return raw.toLowerCase();
  }
}

function providerName(value) {
  const normalized = clean(value).toLowerCase();
  for (const provider of [
    'greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'personio', 'workable',
  ]) {
    if (normalized.includes(provider)) return provider;
  }
  return '';
}

function normalizeIdentityPart(value) {
  return clean(value).normalize('NFKC').toLowerCase();
}

export function atsIdentityFromUrl(value) {
  let url;
  try {
    url = new URL(clean(value));
  } catch {
    return '';
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  let match;

  if (/(?:^|\.)greenhouse\.io$/.test(host)) {
    match = path.match(/^\/(?:v1\/boards\/)?([^/]+)\/jobs\/(\d+)/i);
    if (match) return `ats:greenhouse:${normalizeIdentityPart(match[1])}:${normalizeIdentityPart(match[2])}`;
  }
  const greenhouseId = url.searchParams.get('gh_jid');
  if (greenhouseId) {
    return `ats:greenhouse:${normalizeIdentityPart(host)}:${normalizeIdentityPart(greenhouseId)}`;
  }

  match = path.match(/^\/([^/]+)\/([^/]+?)(?:\/application)?\/?$/i);
  if (match && /^jobs\.(?:eu\.)?lever\.co$/.test(host)) {
    return `ats:lever:${normalizeIdentityPart(match[1])}:${normalizeIdentityPart(match[2])}`;
  }
  if (match && host === 'jobs.ashbyhq.com') {
    return `ats:ashby:${normalizeIdentityPart(match[1])}:${normalizeIdentityPart(match[2])}`;
  }

  if (host.endsWith('.myworkdayjobs.com')) {
    const segments = path.split('/').filter(Boolean);
    const requisition = path.match(/_([A-Za-z0-9-]+)(?:[/?]|$)/)?.[1];
    if (segments[0] && requisition) {
      return `ats:workday:${normalizeIdentityPart(host)}:${normalizeIdentityPart(segments[0])}:${normalizeIdentityPart(requisition)}`;
    }
  }

  if (host === 'jobs.smartrecruiters.com') {
    match = path.match(/^\/([^/]+)\/([^/]+)/);
    if (match) return `ats:smartrecruiters:${normalizeIdentityPart(match[1])}:${normalizeIdentityPart(match[2])}`;
  }

  if (host.includes('personio.')) {
    const tenant = host.split('.')[0];
    match = path.match(/\/job\/(\d+)/i);
    if (tenant && match) return `ats:personio:${normalizeIdentityPart(tenant)}:${normalizeIdentityPart(match[1])}`;
  }

  if (host === 'apply.workable.com') {
    match = path.match(/^\/([^/]+)\/j\/([^/]+)/i);
    if (match) return `ats:workable:${normalizeIdentityPart(match[1])}:${normalizeIdentityPart(match[2])}`;
  }
  return '';
}

export function explicitAtsIdentity(row) {
  const provider = providerName(row?.atsProvider ?? row?.ats_provider ?? row?.provider ?? row?.source);
  const tenant = clean(
    row?.atsTenant ?? row?.ats_tenant ?? row?.tenant ?? row?.boardToken ?? row?.board_token
      ?? row?.companyIdentifier ?? row?.company_identifier ?? row?.companySlug ?? row?.company_slug,
  );
  const requisition = clean(
    row?.requisitionId ?? row?.requisition_id ?? row?.jobId ?? row?.job_id ?? row?.requisition,
  );
  if (!provider || !tenant || !requisition) return '';
  return `ats:${provider}:${normalizeIdentityPart(tenant)}:${normalizeIdentityPart(requisition)}`;
}

export function candidateIdentityMetadata(row) {
  const aliases = collectCandidateIdentityAliases(row);
  const identity = aliases.ats[0] || '';
  const parts = identity.split(':');
  if (parts[0] !== 'ats' || parts.length < 4) {
    return {
      atsProvider: null,
      atsTenant: null,
      requisitionId: null,
      identity,
      aliases,
    };
  }
  return {
    atsProvider: parts[1] || null,
    atsTenant: parts.slice(2, -1).join(':') || null,
    requisitionId: parts.at(-1) || null,
    identity,
    aliases,
  };
}

function candidateUrls(row) {
  const originalUrl = clean(
    row?.original_url ?? row?.originalUrl ?? row?.url ?? row?.listingUrl ?? row?.job_url ?? row?.jobUrl,
  );
  const resolvedUrl = clean(
    row?.resolved_url ?? row?.resolvedUrl ?? row?.final_url ?? row?.finalUrl,
  );
  const aliases = unique([
    ...(Array.isArray(row?.url_aliases) ? row.url_aliases : []),
    ...(Array.isArray(row?.urlAliases) ? row.urlAliases : []),
    originalUrl,
    resolvedUrl,
    row?.url,
    row?.listingUrl,
    row?.job_url,
    row?.jobUrl,
    row?.apply_url,
    row?.applyUrl,
  ]);
  return { originalUrl, resolvedUrl, aliases };
}

export function collectCandidateIdentityAliases(row) {
  const { originalUrl, resolvedUrl, aliases } = candidateUrls(row);
  const urls = unique(aliases.map(canonicalListingUrl));
  const ats = unique([
    explicitAtsIdentity(row),
    ...aliases.map(atsIdentityFromUrl),
  ]).sort();
  if (ats.length > 1) {
    throw new Error(`Conflicting ATS identities for one candidate: ${ats.join(', ')}`);
  }
  const primaryUrl = canonicalListingUrl(originalUrl || resolvedUrl || aliases[0]);
  return { ats, urls: urls.sort(), primaryUrl, originalUrl, resolvedUrl, aliases };
}

export function mergeCandidateIdentityAliases(...groups) {
  const ats = unique(groups.flatMap((group) => group?.ats || [])).sort();
  if (ats.length > 1) {
    throw new Error(`Conflicting ATS identities while merging candidate aliases: ${ats.join(', ')}`);
  }
  const primaryUrls = unique(groups.map((group) => group?.primaryUrl));
  if (!ats.length && primaryUrls.length > 1) {
    throw new Error(`Conflicting canonical listing identities while merging aliases: ${primaryUrls.join(', ')}`);
  }
  return { ats, urls: unique(groups.flatMap((group) => group?.urls || [])).sort(), primaryUrl: primaryUrls[0] || '' };
}

export function candidateIdFromAliases({ ats = [], urls = [], primaryUrl = '' }, { legacy = false } = {}) {
  const primary = [...ats].sort()[0] || primaryUrl || [...urls].sort()[0];
  if (!primary) throw new Error('Cannot derive candidate identity without an ATS identity or URL');
  const namespace = legacy ? 'career-ops:legacy-candidate-id:v1' : 'career-ops:candidate-id:v1';
  const prefix = legacy ? LEGACY_CANDIDATE_ID_PREFIX : CANDIDATE_ID_PREFIX;
  return `${prefix}${sha256(`${namespace}\0${primary}`)}`;
}

export function deriveCandidateId(row, { legacy = false } = {}) {
  return candidateIdFromAliases(collectCandidateIdentityAliases(row), { legacy });
}

export function isCandidateId(value) {
  return new RegExp(`^(?:${CANDIDATE_ID_PREFIX}|${LEGACY_CANDIDATE_ID_PREFIX})[a-f0-9]{64}$`).test(clean(value));
}
