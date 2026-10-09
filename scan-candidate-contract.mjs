import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  CANDIDATE_ID_VERSION,
  candidateIdFromAliases,
  candidateIdentityMetadata,
  canonicalListingUrl,
  collectCandidateIdentityAliases,
  mergeCandidateIdentityAliases,
} from './candidate-identity.mjs';

export const SCAN_CANDIDATE_SCHEMA_VERSION = 3;
export const SCAN_RUN_SCHEMA_VERSION = 3;
export const REVIEW_ARTIFACT_AUTHORITY = 'review_only';

const MATCH_BUCKETS = ['Strong Match', 'Viable Apply', 'Stretch Credible', 'Blocked'];

function clean(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function list(value) {
  if (Array.isArray(value)) return [...new Set(value.map(clean).filter(Boolean))];
  return clean(value) ? [clean(value)] : [];
}

function languageList(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const result = [];
  const seen = new Set();
  for (const item of values) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) { seen.add(key); result.push(item); }
      continue;
    }
    const text = clean(item);
    if (text && !seen.has(text)) { seen.add(text); result.push(text); }
  }
  return result;
}

function first(...values) {
  return values.map(clean).find(Boolean) || '';
}

function isAbsoluteHttpUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /\s/.test(raw) || !/^https?:\/\//i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function firstAbsoluteHttpUrl(...values) {
  return values.map(clean).find(isAbsoluteHttpUrl) || '';
}

function sourceQueries(row) {
  return [...new Set([
    ...list(row?.sourceQueries ?? row?.source_queries),
    ...list(row?.sourceQuery ?? row?.source_query),
  ])];
}

// Provenance is evidence about where a row came from, not part of candidate
// identity. Keep the original input/row coordinates and add only source
// metadata that was actually supplied by that row. Sorting object keys makes
// duplicate detection deterministic even when equivalent entries arrive with
// different key insertion order.
function stableProvenanceValue(value) {
  if (Array.isArray(value)) return value.map(stableProvenanceValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableProvenanceValue(value[key])]));
  }
  return value;
}

function provenanceKey(value) {
  try {
    return JSON.stringify(stableProvenanceValue(value));
  } catch {
    return String(value);
  }
}

function dedupeProvenance(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = provenanceKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceEvidenceProvenance(row, {
  inputName,
  index,
  sourceId,
  sourceUrl,
  queries,
} = {}) {
  const entry = { input: inputName, row: index + 1 };
  const provider = first(row?.provider, row?.atsProvider, row?.ats_provider);
  const source = first(row?.source);
  if (provider) entry.provider = provider;
  if (source) entry.source = source;
  if (sourceId) entry.source_id = sourceId;
  if (sourceUrl) entry.source_url = sourceUrl;
  if (queries.length) entry.source_queries = queries;
  return entry;
}

function normalizeSalary(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return clean(value) || null;
}

function normalizeExperience(row) {
  const value = row?.experienceMetadata ?? row?.experience_metadata ?? row?.experience;
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  return { summary: clean(value) };
}

export function normalizeCanonicalCandidate(row, {
  runId = null,
  inputName = 'standard-scan',
  index = 0,
  createdAt = null,
} = {}) {
  const company = first(row?.company, row?.companyName, row?.organization);
  const title = first(row?.title, row?.role, row?.position);
  const originalUrl = firstAbsoluteHttpUrl(
    row?.original_url, row?.originalUrl, row?.url, row?.listingUrl,
    row?.job_url, row?.jobUrl, row?.apply_url, row?.applyUrl,
  );
  const resolvedUrl = firstAbsoluteHttpUrl(row?.resolved_url, row?.resolvedUrl, row?.final_url, row?.finalUrl);
  const listingUrl = originalUrl || resolvedUrl;
  if (!company || !title || !listingUrl) return null;

  const identityInput = {
    ...row,
    url: listingUrl,
    original_url: originalUrl || listingUrl,
    resolved_url: resolvedUrl || null,
  };
  const identityAliases = collectCandidateIdentityAliases(identityInput);
  const identity = candidateIdentityMetadata(identityInput);
  const queries = sourceQueries(row);
  const canonicalUrl = canonicalListingUrl(listingUrl);
  const aliases = [...new Set([
    ...identityAliases.aliases,
    ...identityAliases.urls,
    originalUrl,
    resolvedUrl,
    canonicalUrl,
  ].filter(isAbsoluteHttpUrl).map(clean).filter(Boolean))];
  const blockers = list(row?.hardBlockers ?? row?.hard_blockers ?? row?.blockers);
  const cautions = list(row?.cautions ?? row?.warnings ?? row?.trustFlags);
  const seniority = list(row?.seniority ?? row?.structuredSeniority ?? row?.structured_seniority);
  const languages = languageList(row?.languageRequirements ?? row?.language_requirements ?? row?.languages);
  const source = first(row?.source, row?.provider, inputName);
  const sourceId = first(row?.sourceId, row?.source_id) || null;
  const sourceUrl = first(row?.sourceUrl, row?.source_url) || null;
  const worker = first(row?.sourceWorker, row?.source_worker, inputName.replace(/\.json$/i, ''));
  const existingProvenance = Array.isArray(row?.provenance) ? row.provenance : [];
  const currentProvenance = sourceEvidenceProvenance(row, {
    inputName,
    index,
    sourceId,
    sourceUrl,
    queries,
  });

  return {
    schema_version: SCAN_CANDIDATE_SCHEMA_VERSION,
    run_id: runId || first(row?.run_id, row?.runId) || null,
    candidate_id: candidateIdFromAliases(identityAliases),
    created_at: createdAt || first(row?.created_at, row?.createdAt) || null,
    provider: identity.atsProvider || first(row?.provider, source) || null,
    source,
    source_id: sourceId,
    source_url: sourceUrl,
    source_worker: worker || null,
    source_query: queries[0] || null,
    source_queries: queries,
    provenance: dedupeProvenance([...existingProvenance, currentProvenance]),
    company,
    title,
    canonical_url: canonicalUrl,
    url: listingUrl,
    original_url: originalUrl || null,
    resolved_url: resolvedUrl || null,
    apply_url: first(row?.apply_url, row?.applyUrl) || null,
    url_aliases: aliases,
    ats_provider: identity.atsProvider,
    ats_tenant: identity.atsTenant,
    requisition_id: identity.requisitionId,
    location: first(row?.location, row?.jobLocation) || null,
    location_eligibility: first(row?.locationEligibility, row?.location_eligibility) || null,
    location_eligibility_code: first(row?.locationEligibilityCode, row?.location_eligibility_code) || null,
    location_eligibility_match: first(row?.locationEligibilityMatch, row?.location_eligibility_match) || null,
    location_eligibility_source: first(row?.locationEligibilitySource, row?.location_eligibility_source) || null,
    remote_restriction: first(row?.remoteRestriction, row?.remote_restriction) || null,
    finland_hiring_eligibility: first(row?.finlandHiringEligibility, row?.finland_hiring_eligibility) || null,
    posted_at: first(row?.postedAt, row?.posted_at, row?.date) || null,
    expires_at: first(row?.expiresAt, row?.expires_at, row?.expiry) || null,
    employment_type: first(row?.employmentType, row?.employment_type) || null,
    seniority,
    experience_metadata: normalizeExperience(row),
    ...(row?.prescreen && typeof row.prescreen === 'object' ? { prescreen: row.prescreen } : {}),
    language_requirements: languages,
    salary: normalizeSalary(row?.salary ?? row?.compensation),
    match_bucket: first(row?.matchBucket, row?.match_bucket) || null,
    match_reason: first(row?.matchReason, row?.match_reason) || null,
    recommended_cv_variant: first(row?.recommendedCvVariant, row?.recommended_cv_variant, row?.cvVariant) || null,
    cautions,
    hard_blockers: blockers,
    status: first(row?.status, 'discovered'),
    liveness_status: first(row?.livenessStatus, row?.liveness_status, row?.liveness?.status, 'unverified'),
    liveness_code: first(row?.livenessCode, row?.liveness_code, row?.liveness?.code) || null,
    liveness_reason: first(row?.livenessReason, row?.liveness_reason, row?.liveness?.reason) || null,
    description: first(row?.description, row?.jobDescription, row?.job_description) || null,
    notes: first(row?.notes) || null,
    _identity_aliases: {
      ats: identityAliases.ats,
      urls: identityAliases.urls,
      primaryUrl: identityAliases.primaryUrl,
    },
  };
}

function mergeText(left, right) {
  const values = [clean(left), clean(right)].filter(Boolean);
  return [...new Set(values)].join(' | ') || null;
}

function mergeBucket(left, right) {
  if (left.hard_blockers.length || right.hard_blockers.length
      || left.match_bucket === 'Blocked' || right.match_bucket === 'Blocked') return 'Blocked';
  const rank = new Map(MATCH_BUCKETS.map((bucket, index) => [bucket, index]));
  return [left.match_bucket, right.match_bucket]
    .filter((bucket) => rank.has(bucket))
    .sort((a, b) => rank.get(a) - rank.get(b))[0] || null;
}

export function configuredLocationPriority(root = process.cwd()) {
  const configuredPath = process.env.CAREER_OPS_PROFILE || join(root, 'config', 'profile.yml');
  const profilePath = resolve(root, configuredPath);
  if (!existsSync(profilePath)) return [];
  try {
    const profile = yaml.load(readFileSync(profilePath, 'utf8')) || {};
    const explicit = list(profile.scan?.location_priority || profile.location?.priority);
    const ordered = explicit.length
      ? explicit.map((entry) => [entry])
      : [['Finland'], ['Germany'], ['Denmark'], ['Netherlands']];
    const city = clean(profile.location?.city);
    const country = clean(profile.location?.country);
    if (city && country) {
      const countryIndex = ordered.findIndex((group) => group.some(
        (entry) => entry.localeCompare(country, 'en', { sensitivity: 'base' }) === 0,
      ));
      if (countryIndex >= 0) ordered[countryIndex].push(city);
      else ordered.push([country, city]);
    }
    return ordered;
  } catch {
    return [];
  }
}

const DEFAULT_LOCATION_GROUPS = [
  ['finland', 'helsinki', 'espoo', 'vantaa', 'tampere', 'turku'],
  ['germany', 'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne', 'köln'],
  ['denmark', 'copenhagen', 'aarhus', 'odense', 'aalborg'],
  ['netherlands', 'amsterdam', 'rotterdam', 'eindhoven', 'utrecht'],
];

function priorityGroups(locationPriority) {
  if (!Array.isArray(locationPriority)) return list(locationPriority).map((entry) => [entry]);
  return locationPriority
    .map((entry) => (Array.isArray(entry) ? list(entry) : list(entry)))
    .filter((group) => group.length > 0);
}

function matchesLocationGroup(value, group) {
  return group.some((entry) => {
    const keyword = entry.toLocaleLowerCase('en');
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(value);
  });
}

function locationRank(location, locationPriority = []) {
  const value = clean(location).toLocaleLowerCase('en');
  const configured = priorityGroups(locationPriority);
  const configuredRank = configured.findIndex((group) => matchesLocationGroup(value, group));
  if (configuredRank >= 0) return configuredRank;
  const defaultRank = DEFAULT_LOCATION_GROUPS.findIndex((group) => matchesLocationGroup(value, group));
  if (defaultRank >= 0) return configured.length + defaultRank;
  if (/\b(?:remote|europe|eu|eea|emea)\b/.test(value)
      || /\beuropean (?:union|economic area)\b/.test(value)) {
    return configured.length + DEFAULT_LOCATION_GROUPS.length;
  }
  return configured.length + DEFAULT_LOCATION_GROUPS.length + 1;
}

function candidateLocationRank(candidate, locationPriority) {
  const resolved = candidate.location_eligibility === 'eligible'
    ? candidate.location_eligibility_match
    : '';
  return locationRank(resolved || candidate.location, locationPriority);
}

function sortCandidate(a, b, locationPriority) {
  const ranks = new Map([...MATCH_BUCKETS, ''].map((bucket, index) => [bucket, index]));
  return (ranks.get(a.match_bucket) ?? 3) - (ranks.get(b.match_bucket) ?? 3)
    || candidateLocationRank(a, locationPriority) - candidateLocationRank(b, locationPriority)
    || (Date.parse(b.posted_at) || 0) - (Date.parse(a.posted_at) || 0)
    || a.company.localeCompare(b.company, 'en', { sensitivity: 'base' })
    || a.title.localeCompare(b.title, 'en', { sensitivity: 'base' })
    || a.candidate_id.localeCompare(b.candidate_id, 'en');
}

export function mergeCanonicalCandidates(inputs, {
  runId = null,
  createdAt = null,
  locationPriority = [],
} = {}) {
  const merged = [];
  const byAts = new Map();
  const byUrl = new Map();
  let invalid = 0;
  let duplicates = 0;

  for (const input of inputs) {
    input.rows.forEach((raw, index) => {
      const row = normalizeCanonicalCandidate(raw, {
        runId,
        inputName: input.name,
        index,
        createdAt,
      });
      if (!row) {
        invalid += 1;
        return;
      }
      const existing = row._identity_aliases.ats.map((key) => byAts.get(key)).find(Boolean)
        || byUrl.get(row._identity_aliases.primaryUrl);
      if (!existing) {
        merged.push(row);
        for (const key of row._identity_aliases.ats) byAts.set(key, row);
        byUrl.set(row._identity_aliases.primaryUrl, row);
        return;
      }
      duplicates += 1;
      existing._identity_aliases = mergeCandidateIdentityAliases(existing._identity_aliases, row._identity_aliases);
      existing.url_aliases = [...new Set([...existing.url_aliases, ...row.url_aliases])];
      existing.source_queries = [...new Set([...existing.source_queries, ...row.source_queries])];
      existing.source_query ||= existing.source_queries[0] || null;
      existing.provenance = dedupeProvenance([...existing.provenance, ...row.provenance]);
      existing.source_worker = mergeText(existing.source_worker, row.source_worker);
      existing.source_id ||= row.source_id;
      existing.source_url ||= row.source_url;
      existing.match_bucket = mergeBucket(existing, row);
      existing.match_reason = mergeText(existing.match_reason, row.match_reason);
      existing.notes = mergeText(existing.notes, row.notes);
      existing.resolved_url ||= row.resolved_url;
      existing.apply_url ||= row.apply_url;
      if (existing.experience_metadata == null && row.experience_metadata != null) {
        existing.experience_metadata = row.experience_metadata;
      }
      if (existing.prescreen == null && row.prescreen != null) existing.prescreen = row.prescreen;
      existing.language_requirements = languageList([
        ...existing.language_requirements,
        ...row.language_requirements,
      ]);
      existing.description ||= row.description;
      const livenessRank = { active: 0, uncertain: 1, unverified: 2 };
      if ((livenessRank[row.liveness_status] ?? 9) < (livenessRank[existing.liveness_status] ?? 9)) {
        existing.liveness_status = row.liveness_status;
        existing.liveness_code = row.liveness_code;
        existing.liveness_reason = row.liveness_reason;
      }
      const eligibilityRank = { eligible: 0, uncertain: 1, ineligible: 2 };
      const evidenceRank = { location: 0, title: 1, url: 2 };
      const evidenceKey = (candidate) => [
        eligibilityRank[candidate.location_eligibility] ?? 9,
        evidenceRank[candidate.location_eligibility_source] ?? 9,
        locationRank(candidate.location_eligibility_match, locationPriority),
        clean(candidate.location_eligibility_code).toLocaleLowerCase('en'),
        clean(candidate.location_eligibility_match).toLocaleLowerCase('en'),
        clean(candidate.location_eligibility_source).toLocaleLowerCase('en'),
      ];
      const compareKeys = (left, right) => {
        for (let i = 0; i < left.length; i += 1) {
          const order = typeof left[i] === 'number'
            ? left[i] - right[i]
            : left[i].localeCompare(right[i], 'en');
          if (order) return order;
        }
        return 0;
      };
      if (compareKeys(evidenceKey(row), evidenceKey(existing)) < 0) {
        existing.location_eligibility = row.location_eligibility;
        existing.location_eligibility_code = row.location_eligibility_code;
        existing.location_eligibility_match = row.location_eligibility_match;
        existing.location_eligibility_source = row.location_eligibility_source;
      }
      existing.recommended_cv_variant ||= row.recommended_cv_variant;
      existing.cautions = [...new Set([...existing.cautions, ...row.cautions])];
      existing.hard_blockers = [...new Set([...existing.hard_blockers, ...row.hard_blockers])];
      for (const key of existing._identity_aliases.ats) byAts.set(key, existing);
      byUrl.set(existing._identity_aliases.primaryUrl, existing);
    });
  }

  for (const row of merged) {
    row.candidate_id = candidateIdFromAliases(row._identity_aliases);
    row.run_id = runId || row.run_id;
    delete row._identity_aliases;
    Object.defineProperties(row, {
      matchBucket: { value: row.match_bucket, enumerable: false },
      matchReason: { value: row.match_reason, enumerable: false },
      hardBlockers: { value: row.hard_blockers, enumerable: false },
      recommendedCvVariant: { value: row.recommended_cv_variant, enumerable: false },
      sourceQuery: { value: row.source_query, enumerable: false },
      sourceQueries: { value: row.source_queries, enumerable: false },
      sourceWorker: { value: row.source_worker, enumerable: false },
      applyUrl: { value: row.apply_url, enumerable: false },
      postedAt: { value: row.posted_at, enumerable: false },
    });
  }
  merged.sort((a, b) => sortCandidate(a, b, locationPriority));
  const ids = new Set();
  for (const row of merged) {
    if (ids.has(row.candidate_id)) throw new Error(`Duplicate candidate_id after merge: ${row.candidate_id}`);
    ids.add(row.candidate_id);
  }
  return { candidates: merged, invalid, duplicates };
}

function scalar(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    if (value.every((entry) => entry == null || typeof entry !== 'object')) {
      return value.map(clean).join('; ');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return clean(value);
}

function safeCell(value) {
  const text = scalar(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const text = safeCell(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function mdCell(value) {
  return scalar(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

export const CANDIDATE_TSV_COLUMNS = Object.freeze([
  'schema_version', 'run_id', 'candidate_id', 'created_at', 'provider', 'source', 'source_worker',
  'source_id', 'source_url', 'source_query', 'source_queries', 'company', 'title', 'canonical_url', 'url', 'original_url',
  'resolved_url', 'apply_url', 'url_aliases', 'ats_provider', 'ats_tenant', 'requisition_id',
  'location', 'location_eligibility', 'location_eligibility_code', 'location_eligibility_match',
  'location_eligibility_source', 'remote_restriction',
  'finland_hiring_eligibility', 'posted_at', 'expires_at',
  'employment_type', 'seniority', 'experience_metadata', 'prescreen', 'language_requirements', 'salary',
  'match_bucket', 'match_reason', 'recommended_cv_variant', 'cautions', 'hard_blockers', 'status',
  'liveness_status', 'liveness_code', 'liveness_reason',
  'notes', 'provenance',
]);

export function buildCandidatesTsv(candidates) {
  return [
    CANDIDATE_TSV_COLUMNS.join('\t'),
    ...candidates.map((row) => CANDIDATE_TSV_COLUMNS.map((key) => safeCell(row[key])).join('\t')),
  ].join('\n') + '\n';
}

export function buildReviewCsv(candidates) {
  const columns = [
    'run_id', 'candidate_id', 'review_decision', 'match_bucket', 'hard_blocker_check', 'liveness',
    'liveness_code', 'liveness_reason', 'company', 'title', 'location', 'location_eligibility',
    'location_eligibility_code', 'location_eligibility_match', 'location_eligibility_source',
    'posted_at', 'source', 'source_url', 'canonical_url', 'url', 'match_reason',
    'recommended_cv_variant', 'source_query', 'source_queries', 'source_worker', 'detected_hard_blockers',
    'cautions', 'notes',
  ];
  const rows = candidates.map((row) => ({
    ...row,
    review_decision: 'review',
    match_bucket: row.match_bucket || 'Unclassified',
    hard_blocker_check: (row.hard_blockers || row.hardBlockers || []).length ? 'detected - verify' : 'pending',
    liveness: row.liveness_status || row.livenessStatus || 'unverified',
    detected_hard_blockers: row.hard_blockers || row.hardBlockers || [],
  }));
  return [columns.join(','), ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(','))].join('\n') + '\n';
}

export function buildReviewMarkdown(candidates, manifest) {
  const eligibility = (row) => [
    row.location_eligibility,
    row.location_eligibility_code,
    row.location_eligibility_match,
    row.location_eligibility_source,
  ].filter(Boolean).join(' / ') || 'Unclassified';
  const rows = candidates.map((row, index) => (
    `| ${index + 1} | ${mdCell(row.candidate_id)} | Review | ${mdCell(row.match_bucket || row.matchBucket || 'Unclassified')} | ${mdCell(row.company)} | [${mdCell(row.title)}](${row.url}) | ${mdCell(row.location || 'Unknown')} | ${mdCell(eligibility(row))} | ${mdCell(row.liveness_status && row.liveness_status !== 'unverified' ? `${row.liveness_status}${row.liveness_code ? ` / ${row.liveness_code}` : ''}` : 'Unverified')} | ${mdCell((row.hard_blockers || row.hardBlockers || []).length ? (row.hard_blockers || row.hardBlockers) : 'Pending review')} | ${mdCell(row.match_reason || row.matchReason)} | ${mdCell(row.recommended_cv_variant || row.recommendedCvVariant)} |`
  ));
  const runId = manifest.run_id || manifest.runId;
  return `# Scan Review — ${runId}\n\nGenerated: ${manifest.created_at || manifest.createdAt}\n\nRun ID: ${runId}\n\nAuthority: review only. This file and output/apply-queue.csv cannot authorize browser execution.\n\n## Summary\n\n- Candidates: ${manifest.candidate_count ?? manifest.candidates}\n- Duplicates removed: ${manifest.duplicates_removed ?? manifest.duplicatesRemoved}\n- Invalid rows skipped: ${manifest.invalid_rows ?? manifest.invalidRows}\n\n## Review\n\n| # | Candidate ID | Decision | Bucket | Company | Role | Location | Eligibility | Liveness | Hard blockers | Match reason | CV |\n|---:|---|---|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
}

export function buildImmutableScanRun({
  root = process.cwd(),
  runId,
  inputs,
  createdAt = new Date().toISOString(),
  sourceArchitecture = 'worker_merge',
  metadata = {},
  locationPriority = null,
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(String(runId || ''))) {
    throw new Error('run ID must be 1-120 safe filename characters');
  }
  const effectiveLocationPriority = locationPriority || configuredLocationPriority(root);
  const result = mergeCanonicalCandidates(inputs, { runId, createdAt, locationPriority: effectiveLocationPriority });
  const matchBuckets = Object.fromEntries(MATCH_BUCKETS.map((bucket) => [
    bucket, result.candidates.filter((candidate) => candidate.match_bucket === bucket).length,
  ]));
  const manifest = {
    schema_version: SCAN_RUN_SCHEMA_VERSION,
    run_id: runId,
    candidate_schema_version: SCAN_CANDIDATE_SCHEMA_VERSION,
    candidate_id_version: CANDIDATE_ID_VERSION,
    created_at: createdAt,
    source_architecture: sourceArchitecture,
    artifact_authority: REVIEW_ARTIFACT_AUTHORITY,
    inputs: inputs.map((input) => ({ name: input.name, rows: input.rows.length })),
    candidate_count: result.candidates.length,
    duplicates_removed: result.duplicates,
    invalid_rows: result.invalid,
    match_buckets: matchBuckets,
    metadata,
    next_step: 'Create an immutable application batch with exact candidate IDs; never execute from a review queue.',
  };
  return { manifest, candidates: result.candidates };
}

export function writeImmutableScanRun({ root = process.cwd(), outRoot = 'output/scan-runs', ...options }) {
  const built = buildImmutableScanRun({ root, ...options });
  const parent = resolve(root, outRoot);
  mkdirSync(parent, { recursive: true });
  const runDir = join(parent, built.manifest.run_id);
  if (existsSync(runDir)) throw new Error(`Immutable scan run already exists (EEXIST): ${runDir}`);
  const staging = join(parent, `.${built.manifest.run_id}.${process.pid}.${randomBytes(6).toString('hex')}.staging`);
  mkdirSync(staging);
  try {
    writeFileSync(join(staging, 'candidates.json'), `${JSON.stringify(built.candidates, null, 2)}\n`, { flag: 'wx' });
    writeFileSync(join(staging, 'candidates.tsv'), buildCandidatesTsv(built.candidates), { flag: 'wx' });
    writeFileSync(join(staging, 'review.csv'), buildReviewCsv(built.candidates), { flag: 'wx' });
    writeFileSync(join(staging, 'review.md'), buildReviewMarkdown(built.candidates, built.manifest), { flag: 'wx' });
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(built.manifest, null, 2)}\n`, { flag: 'wx' });
    renameSync(staging, runDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { ...built, runDir };
}
