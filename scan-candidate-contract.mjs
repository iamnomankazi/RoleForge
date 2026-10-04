import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

function first(...values) {
  return values.map(clean).find(Boolean) || '';
}

function sourceQueries(row) {
  return [...new Set([
    ...list(row?.sourceQueries ?? row?.source_queries),
    ...list(row?.sourceQuery ?? row?.source_query),
  ])];
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
  const originalUrl = first(
    row?.original_url, row?.originalUrl, row?.url, row?.listingUrl,
    row?.job_url, row?.jobUrl, row?.apply_url, row?.applyUrl,
  );
  const resolvedUrl = first(row?.resolved_url, row?.resolvedUrl, row?.final_url, row?.finalUrl);
  if (!company || !title || !(originalUrl || resolvedUrl)) return null;

  const identityInput = { ...row, original_url: originalUrl, resolved_url: resolvedUrl };
  const identityAliases = collectCandidateIdentityAliases(identityInput);
  const identity = candidateIdentityMetadata(identityInput);
  const queries = sourceQueries(row);
  const canonicalUrl = canonicalListingUrl(originalUrl || resolvedUrl);
  const aliases = [...new Set([
    ...identityAliases.aliases,
    ...identityAliases.urls,
    originalUrl,
    resolvedUrl,
    canonicalUrl,
  ].map(clean).filter(Boolean))];
  const blockers = list(row?.hardBlockers ?? row?.hard_blockers ?? row?.blockers);
  const cautions = list(row?.cautions ?? row?.warnings ?? row?.trustFlags);
  const seniority = list(row?.seniority ?? row?.structuredSeniority ?? row?.structured_seniority);
  const languages = list(row?.languageRequirements ?? row?.language_requirements ?? row?.languages);
  const source = first(row?.source, row?.provider, inputName);
  const worker = first(row?.sourceWorker, row?.source_worker, inputName.replace(/\.json$/i, ''));
  const existingProvenance = Array.isArray(row?.provenance) ? row.provenance : [];

  return {
    schema_version: SCAN_CANDIDATE_SCHEMA_VERSION,
    run_id: runId || first(row?.run_id, row?.runId) || null,
    candidate_id: candidateIdFromAliases(identityAliases),
    created_at: createdAt || first(row?.created_at, row?.createdAt) || null,
    provider: identity.atsProvider || first(row?.provider, source) || null,
    source,
    source_worker: worker || null,
    source_query: queries[0] || null,
    source_queries: queries,
    provenance: existingProvenance.length ? existingProvenance : [{ input: inputName, row: index + 1 }],
    company,
    title,
    canonical_url: canonicalUrl,
    url: originalUrl || resolvedUrl,
    original_url: originalUrl || null,
    resolved_url: resolvedUrl || null,
    apply_url: first(row?.apply_url, row?.applyUrl) || null,
    url_aliases: aliases,
    ats_provider: identity.atsProvider,
    ats_tenant: identity.atsTenant,
    requisition_id: identity.requisitionId,
    location: first(row?.location, row?.jobLocation) || null,
    remote_restriction: first(row?.remoteRestriction, row?.remote_restriction) || null,
    finland_hiring_eligibility: first(row?.finlandHiringEligibility, row?.finland_hiring_eligibility) || null,
    posted_at: first(row?.postedAt, row?.posted_at, row?.date) || null,
    expires_at: first(row?.expiresAt, row?.expires_at, row?.expiry) || null,
    employment_type: first(row?.employmentType, row?.employment_type) || null,
    seniority,
    experience_metadata: normalizeExperience(row),
    language_requirements: languages,
    salary: normalizeSalary(row?.salary ?? row?.compensation),
    match_bucket: first(row?.matchBucket, row?.match_bucket) || null,
    match_reason: first(row?.matchReason, row?.match_reason) || null,
    recommended_cv_variant: first(row?.recommendedCvVariant, row?.recommended_cv_variant, row?.cvVariant) || null,
    cautions,
    hard_blockers: blockers,
    status: first(row?.status, 'discovered'),
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

function locationRank(location) {
  const value = clean(location).toLowerCase();
  if (/(finland|helsinki|espoo|vantaa|tampere|turku|joensuu)/.test(value)) return 0;
  if (/(denmark|copenhagen|aarhus|odense|aalborg)/.test(value)) return 1;
  if (/(germany|berlin|munich|münchen|hamburg|frankfurt|cologne|köln)/.test(value)) return 2;
  if (/(netherlands|amsterdam|rotterdam|eindhoven|utrecht)/.test(value)) return 3;
  if (/(remote|europe|eu|eea|emea)/.test(value)) return 4;
  return 5;
}

function sortCandidate(a, b) {
  const ranks = new Map([...MATCH_BUCKETS, ''].map((bucket, index) => [bucket, index]));
  return (ranks.get(a.match_bucket) ?? 3) - (ranks.get(b.match_bucket) ?? 3)
    || locationRank(a.location) - locationRank(b.location)
    || (Date.parse(b.posted_at) || 0) - (Date.parse(a.posted_at) || 0)
    || a.company.localeCompare(b.company, 'en', { sensitivity: 'base' })
    || a.title.localeCompare(b.title, 'en', { sensitivity: 'base' })
    || a.candidate_id.localeCompare(b.candidate_id, 'en');
}

export function mergeCanonicalCandidates(inputs, { runId = null, createdAt = null } = {}) {
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
      existing.provenance.push(...row.provenance);
      existing.source_worker = mergeText(existing.source_worker, row.source_worker);
      existing.match_bucket = mergeBucket(existing, row);
      existing.match_reason = mergeText(existing.match_reason, row.match_reason);
      existing.notes = mergeText(existing.notes, row.notes);
      existing.resolved_url ||= row.resolved_url;
      existing.apply_url ||= row.apply_url;
      existing.description ||= row.description;
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
  merged.sort(sortCandidate);
  const ids = new Set();
  for (const row of merged) {
    if (ids.has(row.candidate_id)) throw new Error(`Duplicate candidate_id after merge: ${row.candidate_id}`);
    ids.add(row.candidate_id);
  }
  return { candidates: merged, invalid, duplicates };
}

function scalar(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join('; ');
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
  'source_query', 'source_queries', 'company', 'title', 'canonical_url', 'url', 'original_url',
  'resolved_url', 'apply_url', 'url_aliases', 'ats_provider', 'ats_tenant', 'requisition_id',
  'location', 'remote_restriction', 'finland_hiring_eligibility', 'posted_at', 'expires_at',
  'employment_type', 'seniority', 'experience_metadata', 'language_requirements', 'salary',
  'match_bucket', 'match_reason', 'recommended_cv_variant', 'cautions', 'hard_blockers', 'status',
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
    'company', 'title', 'location', 'posted_at', 'source', 'canonical_url', 'url', 'match_reason',
    'recommended_cv_variant', 'source_query', 'source_queries', 'source_worker', 'detected_hard_blockers',
    'cautions', 'notes',
  ];
  const rows = candidates.map((row) => ({
    ...row,
    review_decision: 'review',
    match_bucket: row.match_bucket || 'Unclassified',
    hard_blocker_check: (row.hard_blockers || row.hardBlockers || []).length ? 'detected - verify' : 'pending',
    liveness: 'unverified',
    detected_hard_blockers: row.hard_blockers || row.hardBlockers || [],
  }));
  return [columns.join(','), ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(','))].join('\n') + '\n';
}

export function buildReviewMarkdown(candidates, manifest) {
  const rows = candidates.map((row, index) => (
    `| ${index + 1} | ${mdCell(row.candidate_id)} | Review | ${mdCell(row.match_bucket || row.matchBucket || 'Unclassified')} | ${mdCell(row.company)} | [${mdCell(row.title)}](${row.url}) | ${mdCell(row.location || 'Unknown')} | Unverified | ${mdCell((row.hard_blockers || row.hardBlockers || []).length ? (row.hard_blockers || row.hardBlockers) : 'Pending review')} | ${mdCell(row.match_reason || row.matchReason)} | ${mdCell(row.recommended_cv_variant || row.recommendedCvVariant)} |`
  ));
  const runId = manifest.run_id || manifest.runId;
  return `# Scan Review — ${runId}\n\nGenerated: ${manifest.created_at || manifest.createdAt}\n\nRun ID: ${runId}\n\nAuthority: review only. This file and output/apply-queue.csv cannot authorize browser execution.\n\n## Summary\n\n- Candidates: ${manifest.candidate_count ?? manifest.candidates}\n- Duplicates removed: ${manifest.duplicates_removed ?? manifest.duplicatesRemoved}\n- Invalid rows skipped: ${manifest.invalid_rows ?? manifest.invalidRows}\n\n## Review\n\n| # | Candidate ID | Decision | Bucket | Company | Role | Location | Liveness | Hard blockers | Match reason | CV |\n|---:|---|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
}

export function buildImmutableScanRun({
  runId,
  inputs,
  createdAt = new Date().toISOString(),
  sourceArchitecture = 'worker_merge',
  metadata = {},
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(String(runId || ''))) {
    throw new Error('run ID must be 1-120 safe filename characters');
  }
  const result = mergeCanonicalCandidates(inputs, { runId, createdAt });
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
  const built = buildImmutableScanRun(options);
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
