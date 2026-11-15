#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  companyDuplicateKey, groupTrackerRows, loadIdentityMappings, loadReportIndex,
  loadRunCandidates, loadTrackerRows, roleDuplicateKey, rowIdentity,
} from './tracker-identity.mjs';
import { resolveTrackerPath } from './tracker-utils.mjs';
import { canonicalListingUrl, isCandidateId } from './candidate-identity.mjs';
import { loadPrescreenProfile, prescreenJob } from './prescreen.mjs';
import { normalizeExperiencePolicy } from './experience-policy.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const candidateIdOf = (candidate) => String(candidate?.candidate_id ?? candidate?.candidateId ?? '').trim();
const toArray = (value) => Array.isArray(value) ? value : [];

function warning(warnings, message) { warnings.push(String(message)); }

function readJsonFile(file, label) {
  let bytes;
  try { bytes = readFileSync(file); }
  catch (error) { throw new Error(`Could not read ${label} ${file}: ${error.message}`); }
  try { return { bytes, value: JSON.parse(bytes.toString('utf8')) }; }
  catch (error) { throw new Error(`Could not parse ${label} ${file}: ${error.message}`); }
}

function normalizedLiveness(rawStatus) {
  if (rawStatus === 'active') return 'active';
  if (rawStatus === 'expired') return 'expired';
  return 'unconfirmed';
}

function inside(child, parent) {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function canonicalPath(path) {
  let current = resolve(path);
  const suffix = [];
  while (true) {
    try { return resolve(realpathSync(current), ...suffix); }
    catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function reportComponents(reportIndex) {
  const adjacent = new Map();
  for (const [number, report] of reportIndex) {
    if (!Number.isSafeInteger(report?.supersedes)) continue;
    const target = report.supersedes;
    if (!adjacent.has(number)) adjacent.set(number, new Set());
    if (!adjacent.has(target)) adjacent.set(target, new Set());
    adjacent.get(number).add(target);
    adjacent.get(target).add(number);
  }
  const componentByReport = new Map();
  const idsByReport = new Map();
  const idsById = new Map();
  for (const [number, report] of reportIndex) {
    if (report?.candidateId) {
      if (!idsByReport.has(number)) idsByReport.set(number, new Set());
      idsByReport.get(number).add(report.candidateId);
    }
  }
  for (const number of new Set([...reportIndex.keys(), ...adjacent.keys()])) {
    if (componentByReport.has(number)) continue;
    const component = new Set();
    const queue = [number];
    while (queue.length) {
      const current = queue.pop();
      if (component.has(current)) continue;
      component.add(current);
      for (const next of adjacent.get(current) ?? []) queue.push(next);
    }
    const ids = new Set([...component].flatMap((item) => [...(idsByReport.get(item) ?? [])]));
    for (const item of component) {
      componentByReport.set(item, component);
      if (!idsByReport.has(item)) idsByReport.set(item, new Set());
      for (const id of ids) idsByReport.get(item).add(id);
    }
    for (const id of ids) idsById.set(id, ids);
  }
  return { componentByReport, idsByReport, idsById };
}

function loadRuns(runDirs) {
  const runs = [];
  for (const givenDir of runDirs) {
    const dir = resolve(givenDir);
    const manifestPath = join(dir, 'manifest.json');
    const candidatesPath = join(dir, 'candidates.json');
    const manifestFile = readJsonFile(manifestPath, 'run manifest');
    const candidatesFile = readJsonFile(candidatesPath, 'run candidates');
    const manifest = manifestFile.value;
    const parsedCandidates = Array.isArray(candidatesFile.value)
      ? candidatesFile.value : candidatesFile.value?.candidates;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(`Malformed manifest.json in run ${dir}`);
    }
    if (!Array.isArray(parsedCandidates)) throw new Error(`Malformed candidates.json in run ${dir}`);
    const createdAt = manifest.created_at ?? manifest.createdAt ?? null;
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
      throw new Error(`Run ${dir} has no valid manifest created_at`);
    }
    const enriched = manifest?.metadata?.tool === 'enrich-run';
    let enrichment = null;
    if (enriched) {
      const enrichmentPath = join(dir, 'enrichment.json');
      let bytes;
      try { bytes = readFileSync(enrichmentPath); }
      catch {
        throw new Error(`incomplete enriched run ${dir}: enrichment.json is missing or unreadable`);
      }
      const actual = sha256(bytes);
      if (typeof manifest?.metadata?.enrichment_sha256 !== 'string' || actual !== manifest.metadata.enrichment_sha256) {
        throw new Error(`incomplete enriched run ${dir}: enrichment.json SHA-256 does not match manifest`);
      }
      try { enrichment = { bytes, value: JSON.parse(bytes.toString('utf8')) }; }
      catch (error) { throw new Error(`incomplete enriched run ${dir}: could not parse enrichment.json: ${error.message}`); }
    }
    const runId = String(manifest.run_id ?? manifest.runId ?? basename(dir));
    const candidates = parsedCandidates.map((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !isCandidateId(candidateIdOf(candidate))) {
        throw new Error(`Malformed candidate ${index + 1} in run ${dir}: missing candidate_id`);
      }
      return { ...candidate, candidate_id: candidateIdOf(candidate), run_id: runId };
    });
    runs.push({ dir, run_id: runId, created_at: createdAt, created_ms: Date.parse(createdAt), enriched,
      manifest_sha256: sha256(manifestFile.bytes), candidates, enrichment });
  }
  return runs;
}

function loadLivenessInputs(livenessDirs, warnings) {
  const inputs = [];
  const entries = [];
  for (const givenDir of livenessDirs) {
    const dir = resolve(givenDir);
    const file = join(dir, 'liveness.json');
    let bytes;
    try { bytes = readFileSync(file); }
    catch (error) {
      warning(warnings, `Could not read optional liveness results ${file}: ${error.message}`);
      inputs.push({ dir, liveness_json_sha256: null });
      continue;
    }
    const hash = sha256(bytes);
    inputs.push({ dir, liveness_json_sha256: hash });
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch (error) {
      warning(warnings, `Ignoring malformed liveness.json ${file}: ${error.message}`);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      warning(warnings, `Ignoring malformed liveness.json ${file}: expected an object keyed by candidate ID`);
      continue;
    }
    entries.push({ dir, hash, value });
  }
  return { inputs, entries };
}

function effectiveLiveness(candidate, run, livenessEntries) {
  const id = candidate.candidate_id;
  let latest = null;
  for (const artifact of livenessEntries) {
    const entry = artifact.value[id];
    const checkedAt = typeof entry?.checked_at === 'string' ? Date.parse(entry.checked_at) : NaN;
    if (!Number.isFinite(checkedAt) || checkedAt <= run.created_ms) continue;
    if (!latest || checkedAt > latest.checked_ms) {
      latest = { source: artifact.dir, liveness_json_sha256: artifact.hash,
        status: normalizedLiveness(entry.status), raw_status: entry.status ?? null,
        checked_at: entry.checked_at, checked_ms: checkedAt };
    }
  }
  if (latest) {
    const { checked_ms, ...evidence } = latest;
    return evidence;
  }
  const rawStatus = candidate.liveness_status ?? null;
  return { source: 'run', liveness_json_sha256: null, status: normalizedLiveness(rawStatus),
    raw_status: rawStatus, checked_at: null };
}

function buildTrackedEvidence(groups, reportIndex, mappings) {
  const trackedIds = new Set();
  const evidenceById = new Map();
  const add = (id, evidence) => {
    if (!id) return;
    if (!mappings.ambiguous.has(id)) trackedIds.add(id);
    if (!evidenceById.has(id)) evidenceById.set(id, []);
    evidenceById.get(id).push(evidence);
  };
  for (const group of groups) {
    const groupRows = group.rows.map((row) => ({ num: row.num, status: row.status }));
    for (const id of group.ids) {
      if (mappings.ambiguous.has(id)) continue;
      add(id, { tracker_rows: groupRows });
    }
    for (const row of group.rows) {
      const identity = rowIdentity(row, reportIndex, mappings);
      for (const id of identity.ids) {
        add(id, { tracker_rows: [{ num: row.num, status: row.status }] });
      }
    }
  }
  for (const [number, report] of reportIndex) {
    if (!report?.candidateId) continue;
    add(report.candidateId, { report_numbers: [number] });
  }
  return { trackedIds, evidenceById };
}

function createStrongIdResolver(mappings, reportInfo) {
  const cache = new Map();
  return function strongIds(id) {
    if (cache.has(id)) return cache.get(id);
    if (mappings.ambiguous.has(id)) {
      const empty = new Set();
      cache.set(id, empty);
      return empty;
    }
    const ids = new Set([id]);
    const queue = [id];
    while (queue.length) {
      const current = queue.pop();
      for (const relatedId of mappings.equivalent.get(current) ?? []) {
        if (!mappings.ambiguous.has(relatedId) && !ids.has(relatedId)) {
          ids.add(relatedId);
          queue.push(relatedId);
        }
      }
      for (const relatedId of reportInfo.idsById.get(current) ?? []) {
        if (!mappings.ambiguous.has(relatedId) && !ids.has(relatedId)) {
          ids.add(relatedId);
          queue.push(relatedId);
        }
      }
    }
    for (const member of ids) cache.set(member, ids);
    return ids;
  };
}

function createTrackedMatcher(tracked, strongIds) {
  const cache = new Map();
  const weakCache = new Map();
  function trackedMatch(candidateId) {
    if (cache.has(candidateId)) return cache.get(candidateId);
    const ids = strongIds(candidateId);
    if (!ids.size) { cache.set(candidateId, null); return null; }
    const matches = [...ids].filter((id) => tracked.trackedIds.has(id));
    if (!matches.length) { cache.set(candidateId, null); return null; }
    const rows = new Map();
    const reports = new Set();
    for (const id of matches) {
      for (const evidence of tracked.evidenceById.get(id) ?? []) {
        for (const row of evidence.tracker_rows ?? []) rows.set(`${row.num}\0${row.status}`, row);
        for (const number of evidence.report_numbers ?? []) reports.add(number);
      }
    }
    const result = { matched_candidate_ids: matches,
      tracker_rows: [...rows.values()].sort((a, b) => Number(a.num) - Number(b.num)),
      report_numbers: [...reports].sort((a, b) => a - b) };
    cache.set(candidateId, result);
    return result;
  }
  function weakTrackedMatch(candidateId) {
    if (weakCache.has(candidateId)) return weakCache.get(candidateId);
    const strong = trackedMatch(candidateId);
    if (strong) { weakCache.set(candidateId, strong); return strong; }
    const evidence = tracked.evidenceById.get(candidateId);
    if (!evidence?.length) { weakCache.set(candidateId, null); return null; }
    const rows = new Map(); const reports = new Set();
    for (const item of evidence) {
      for (const row of item.tracker_rows ?? []) rows.set(`${row.num}\0${row.status}`, row);
      for (const number of item.report_numbers ?? []) reports.add(number);
    }
    const result = { matched_candidate_ids: [candidateId],
      tracker_rows: [...rows.values()].sort((a, b) => Number(a.num) - Number(b.num)),
      report_numbers: [...reports].sort((a, b) => a - b) };
    weakCache.set(candidateId, result);
    return result;
  }
  return { trackedMatch, weakTrackedMatch };
}

function discardedComponents(edges) {
  const adjacency = new Map();
  const edgesById = new Map();
  for (const edge of edges ?? []) {
    for (const id of [edge.old, edge.new]) {
      if (!adjacency.has(id)) adjacency.set(id, new Set());
      if (!edgesById.has(id)) edgesById.set(id, []);
      edgesById.get(id).push(edge);
    }
    adjacency.get(edge.old).add(edge.new);
    adjacency.get(edge.new).add(edge.old);
  }
  const componentById = new Map();
  for (const id of adjacency.keys()) {
    if (componentById.has(id)) continue;
    const component = new Set(); const queue = [id];
    while (queue.length) {
      const current = queue.pop();
      if (component.has(current)) continue;
      component.add(current);
      for (const next of adjacency.get(current)) queue.push(next);
    }
    for (const member of component) componentById.set(member, component);
  }
  return { componentById, edgesById };
}

function urlsFor(candidate) {
  return new Set([candidate?.url, candidate?.original_url, candidate?.resolved_url, candidate?.apply_url,
    candidate?.canonical_url, ...toArray(candidate?.url_aliases)]
    .map(canonicalListingUrl).filter(Boolean));
}

function buildDuplicateIndexes(allRunCandidates, trackerRows) {
  const recordsByUrl = new Map();
  const urlsByCandidate = new Map();
  const trackerRowsByKey = new Map();
  for (const record of allRunCandidates) {
    if (!record?.candidate_id) continue;
    const urls = urlsFor(record);
    urlsByCandidate.set(record, urls);
    for (const url of urls) {
      if (!recordsByUrl.has(url)) recordsByUrl.set(url, []);
      recordsByUrl.get(url).push(record);
    }
  }
  for (const row of trackerRows) {
    const companyKey = companyDuplicateKey(row.company);
    const roleKey = roleDuplicateKey(row.role);
    if (!companyKey || !roleKey) continue;
    const key = `${companyKey}\0${roleKey}`;
    if (!trackerRowsByKey.has(key)) trackerRowsByKey.set(key, []);
    trackerRowsByKey.get(key).push(row);
  }
  return { recordsByUrl, urlsByCandidate, trackerRowsByKey };
}

function buildPossibleDuplicates(candidate, indexes, tracked, mappings, strongIds, trackedMatch, weakTrackedMatch, discarded) {
  const results = [];
  const seen = new Set();
  const add = (value) => {
    const key = JSON.stringify(value);
    if (!seen.has(key)) { seen.add(key); results.push(value); }
  };
  const candidateUrls = indexes.urlsByCandidate.get(candidate) ?? urlsFor(candidate);
  const urlMatches = new Map();
  if (candidateUrls.size) {
    for (const url of candidateUrls) {
      for (const record of indexes.recordsByUrl.get(url) ?? []) {
        if (!record?.candidate_id || record.candidate_id === candidate.candidate_id) continue;
        if (!urlMatches.has(record.candidate_id)) urlMatches.set(record.candidate_id, { record, urls: new Set() });
        urlMatches.get(record.candidate_id).urls.add(url);
      }
    }
    for (const [candidateId, match] of urlMatches) {
      const matchingTracked = weakTrackedMatch(candidateId);
      if (!matchingTracked) continue;
      add({ reason: 'shared_url_alias', urls: [...match.urls].sort(), candidate_id: candidateId,
        tracker_rows: matchingTracked.tracker_rows, report_numbers: matchingTracked.report_numbers });
    }
  }
  const companyKey = companyDuplicateKey(candidate.company);
  const roleKey = roleDuplicateKey(candidate.title ?? candidate.role);
  if (companyKey && roleKey) {
    const rows = indexes.trackerRowsByKey.get(`${companyKey}\0${roleKey}`) ?? [];
    if (rows.length) {
      add({ reason: 'company_role_match', tracker_rows: rows.map((row) => ({ num: row.num, status: row.status })) });
    }
  }
  const candidateIds = new Set([candidate.candidate_id, ...strongIds(candidate.candidate_id)]);
  const candidateComponents = new Set([...candidateIds].map((id) => discarded.componentById.get(id)).filter(Boolean));
  if (candidateComponents.size) {
    const componentIds = new Set([...candidateComponents].flatMap((component) => [...component]));
    const trackedComponentIds = new Set();
    for (const id of componentIds) {
      const match = trackedMatch(id);
      if (match) for (const matchId of match.matched_candidate_ids) trackedComponentIds.add(matchId);
      else if (mappings.ambiguous.has(id) && tracked.evidenceById.has(id)) trackedComponentIds.add(id);
    }
    if (trackedComponentIds.size) {
      const relevantEdges = [...componentIds].flatMap((id) => discarded.edgesById.get(id) ?? []);
      add({ reason: 'discarded_mapping', candidate_ids: [...trackedComponentIds].sort(),
        edge_reasons: [...new Set(relevantEdges.map((edge) => edge.reason))].sort() });
    }
  }
  if (mappings.ambiguous.has(candidate.candidate_id)) {
    add({ reason: 'ambiguous_id', candidate_id: candidate.candidate_id,
      evidence: tracked.evidenceById.get(candidate.candidate_id) ?? [] });
  }
  return results;
}

function assertOutputSafe(outPath, runDirs, livenessDirs, root) {
  const canonicalOut = canonicalPath(outPath);
  const protectedDirs = [
    ...runDirs.map((dir) => [canonicalPath(dir), `an input run directory`]),
    ...livenessDirs.map((dir) => [canonicalPath(dir), `an input liveness directory`]),
    ...['output/scan-runs', 'reports', 'data', 'output/application-batches', 'config']
      .map((part) => [canonicalPath(join(resolve(root), part)), part]),
  ];
  for (const [directory, label] of protectedDirs) {
    if (inside(canonicalOut, directory)) throw new Error(`Refusing --out inside ${label}: ${outPath}`);
  }
}

function assertRunDirsInRoot(runDirs, root) {
  const scanRuns = canonicalPath(join(resolve(root), 'output', 'scan-runs'));
  for (const dir of runDirs) {
    if (!inside(canonicalPath(dir), scanRuns) || canonicalPath(dir) === scanRuns) {
      throw new Error(`Refusing --run outside <root>/output/scan-runs: ${dir}`);
    }
  }
}

function assertNoUnexpectedWarnings(label, messages, allowed = []) {
  const fatal = messages.filter((message) => !allowed.some((pattern) => pattern.test(message)));
  if (fatal.length) throw new Error(`${label}:\n${fatal.map((message) => `- ${message}`).join('\n')}`);
}

const BENIGN_REPORT_WARNINGS = [
  /^Report .+ has no Machine Summary$/,
  /^Report .+ has an invalid Machine Summary:/,
  /^Report .+ has an invalid assessment:/,
];
const BENIGN_MAPPING_WARNINGS = [
  /^Ignoring enrichment\.json in .+: manifest metadata\.tool is not enrich-run$/,
];

function loadExperiencePolicy(root) {
  const configuredPath = process.env.CAREER_OPS_PORTALS
    ? resolve(process.env.CAREER_OPS_PORTALS) : join(root, 'portals.yml');
  if (!existsSync(configuredPath)) return null;
  let config;
  try { config = yaml.load(readFileSync(configuredPath, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`Could not load scan configuration ${configuredPath}: ${error.message}`); }
  const normalizedConfig = config && typeof config === 'object' ? config : {};
  return normalizeExperiencePolicy(normalizedConfig.experience_policy);
}

function loadApplicationBatches(root) {
  const batchesDir = join(root, 'output', 'application-batches');
  if (!existsSync(batchesDir)) return new Map();
  let entries;
  try { entries = readdirSync(batchesDir, { withFileTypes: true }); }
  catch (error) { throw new Error(`Could not read application-batches directory ${batchesDir}: ${error.message}`); }
  const byCandidateId = new Map();
  for (const entry of entries) {
    // Dot-prefixed directories (claim locks, staging) are internal, never batches.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const batchId = entry.name;
    const manifestPath = join(batchesDir, batchId, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`Malformed application batch ${batchId}: manifest.json is missing`);
    const manifest = readJsonFile(manifestPath, 'application-batch manifest').value;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !Array.isArray(manifest.candidates)
        || manifest.candidates.length === 0
        || manifest.batchId != null && (typeof manifest.batchId !== 'string' || manifest.batchId !== batchId)) {
      throw new Error(`Malformed application-batch manifest ${manifestPath}: expected candidates array`);
    }
    const statePath = join(batchesDir, batchId, 'state.json');
    let state = null;
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
    for (const [index, row] of manifest.candidates.entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`Malformed application-batch manifest ${manifestPath}: candidate ${index + 1} must be an object`);
      }
      const candidateId = row.candidate_id;
      if (candidateId == null || candidateId === '') continue;
      if (typeof candidateId !== 'string' || !isCandidateId(candidateId)) {
        throw new Error(`Malformed application-batch manifest ${manifestPath}: candidate ${index + 1} has invalid candidate_id`);
      }
      if (!byCandidateId.has(candidateId)) byCandidateId.set(candidateId, []);
      byCandidateId.get(candidateId).push({ batch_id: manifest.batchId ?? batchId,
        state: state?.candidates?.[index]?.state ?? null });
    }
  }
  return byCandidateId;
}

function applicationBatchMatch(candidateId, batches, strongIds) {
  const ids = new Set([candidateId, ...strongIds(candidateId)]);
  const matches = new Map();
  for (const id of ids) {
    for (const batch of batches.get(id) ?? []) matches.set(batch.batch_id, batch);
  }
  if (!matches.size) return null;
  const entries = [...matches.values()].sort((a, b) => a.batch_id.localeCompare(b.batch_id));
  return { batch_ids: entries.map((entry) => entry.batch_id),
    candidate_states: entries.map(({ batch_id, state }) => ({ batch_id, state })) };
}

function addQueuedDuplicateEvidence(queued) {
  const byUrl = new Map();
  const byCompanyRole = new Map();
  const pairEvidence = new Map();
  const addPair = (left, right, reason, details = {}) => {
    if (left === right) return;
    const a = Math.min(left.index, right.index); const b = Math.max(left.index, right.index);
    const pairKey = `${a}:${b}`;
    if (!pairEvidence.has(pairKey)) pairEvidence.set(pairKey, { left, right, reasons: new Map() });
    const pair = pairEvidence.get(pairKey);
    if (!pair.reasons.has(reason)) pair.reasons.set(reason, []);
    pair.reasons.get(reason).push(details);
  };
  for (const item of queued) {
    const urls = item.urls;
    for (const url of urls) {
      for (const other of byUrl.get(url) ?? []) addPair(item, other, 'shared_url_alias', { url });
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push(item);
    }
    const companyKey = companyDuplicateKey(item.candidate.company);
    const roleKey = roleDuplicateKey(item.candidate.title ?? item.candidate.role);
    if (!companyKey || !roleKey) continue;
    const key = `${companyKey}\0${roleKey}`;
    for (const other of byCompanyRole.get(key) ?? []) addPair(item, other, 'company_role_match');
    if (!byCompanyRole.has(key)) byCompanyRole.set(key, []);
    byCompanyRole.get(key).push(item);
  }
  for (const pair of pairEvidence.values()) {
    for (const [reason, details] of pair.reasons) {
      const urls = [...new Set(details.map((item) => item.url).filter(Boolean))].sort();
      pair.left.entry.possible_duplicates.push({ reason, candidate_id: pair.right.candidate.candidate_id, ...(urls.length ? { urls } : {}) });
      pair.right.entry.possible_duplicates.push({ reason, candidate_id: pair.left.candidate.candidate_id, ...(urls.length ? { urls } : {}) });
    }
  }
}

export function buildEvalQueue({ runDirs = [], livenessDirs = [], root = SCRIPT_DIR, profilePath, now = new Date() } = {}) {
  if (!Array.isArray(runDirs) || runDirs.length === 0) throw new Error('At least one --run directory is required');
  const absoluteRoot = resolve(root);
  assertRunDirsInRoot(runDirs, absoluteRoot);
  const runs = loadRuns(runDirs.map(canonicalPath));
  const warnings = [];

  const trackerPath = resolveTrackerPath(absoluteRoot);
  const reportsDir = join(absoluteRoot, 'reports');
  const trackerExists = existsSync(trackerPath);
  let reportsExist = existsSync(reportsDir);
  let reportEntries = [];
  if (reportsExist) {
    try { reportEntries = readdirSync(reportsDir); }
    catch (error) { throw new Error(`Could not read reports directory ${reportsDir}: ${error.message}`); }
  }
  const hasReports = reportEntries.some((name) => /\.md$/i.test(name));
  if (!trackerExists && !hasReports) {
    warning(warnings, `Fresh project: tracker ${trackerPath} is missing and no reports exist in ${reportsDir}`);
  } else if (!trackerExists && hasReports) {
    throw new Error(`Could not read tracker ${trackerPath}: tracker is missing while reports exist`);
  } else if (!reportsExist) {
    throw new Error(`Could not read reports directory ${reportsDir}: directory does not exist`);
  }
  let tracker = { rows: [], warnings: [] };
  if (trackerExists) {
    tracker = loadTrackerRows(trackerPath);
    assertNoUnexpectedWarnings('Could not safely load tracker identity evidence', tracker.warnings);
    warnings.push(...tracker.warnings);
  }
  const reportIndex = reportsExist ? loadReportIndex(reportsDir) : new Map();
  assertNoUnexpectedWarnings('Could not safely load report identity evidence', reportIndex.warnings ?? [], BENIGN_REPORT_WARNINGS);
  warnings.push(...(reportIndex.warnings ?? []));
  const scanRunsDir = join(absoluteRoot, 'output', 'scan-runs');
  const mappings = loadIdentityMappings({ scanRunsDir, correctionsDir: join(absoluteRoot, 'output', 'identity-corrections') });
  assertNoUnexpectedWarnings('Could not safely load identity mappings', mappings.warnings, BENIGN_MAPPING_WARNINGS);
  warnings.push(...mappings.warnings);
  const runCandidates = loadRunCandidates(scanRunsDir);
  assertNoUnexpectedWarnings('Could not safely load scan-run identity evidence', runCandidates.warnings);
  warnings.push(...runCandidates.warnings);
  const groups = groupTrackerRows(tracker.rows, reportIndex, mappings);
  const tracked = buildTrackedEvidence(groups, reportIndex, mappings);
  const reportInfo = reportComponents(reportIndex);
  const strongIds = createStrongIdResolver(mappings, reportInfo);
  const { trackedMatch, weakTrackedMatch } = createTrackedMatcher(tracked, strongIds);
  const applicationBatches = loadApplicationBatches(absoluteRoot);
  const liveness = loadLivenessInputs(livenessDirs, warnings);
  const chosenProfilePath = profilePath == null ? join(absoluteRoot, 'config', 'profile.yml') : resolve(profilePath);
  let profile;
  let profileHash;
  try {
    const profileBytes = readFileSync(chosenProfilePath);
    profileHash = sha256(profileBytes);
    profile = loadPrescreenProfile(chosenProfilePath);
  } catch (error) {
    throw new Error(`Could not load required prescreen profile ${chosenProfilePath}: ${error.message}`);
  }
  const experiencePolicy = loadExperiencePolicy(absoluteRoot);

  const allCandidates = runs.flatMap((run, runIndex) => run.candidates.map((candidate, candidateIndex) => ({
    run, runIndex, candidateIndex, candidate, liveness: effectiveLiveness(candidate, run, liveness.entries),
  })));
  const groupKeyFor = (item) => {
    const strong = strongIds(item.candidate.candidate_id);
    if (!strong.size) return `ambiguous:${item.runIndex}:${item.candidateIndex}`;
    return [...strong].sort()[0];
  };
  const winners = new Map();
  for (const item of allCandidates) {
    if (trackedMatch(item.candidate.candidate_id)) continue;
    const key = groupKeyFor(item);
    const current = winners.get(key);
    if (!current || item.run.created_ms > current.run.created_ms
      || item.run.created_ms === current.run.created_ms && item.runIndex < current.runIndex) winners.set(key, item);
  }

  const output = { schema: 'eval-queue/1', generated_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    inputs: { runs: runs.map(({ dir, run_id, created_at, enriched, manifest_sha256 }) => ({ dir, run_id, created_at, enriched, manifest_sha256 })),
      liveness: liveness.inputs, profile_sha256: profileHash },
    include: [], needs_liveness: [], exclude: [], counts: null, warnings };
  const allRunCandidates = [...runCandidates.values(), ...runs.flatMap((run) => run.candidates)];
  const duplicateIndexes = buildDuplicateIndexes(allRunCandidates, tracker.rows);
  const discarded = discardedComponents(mappings.discardedEdges);
  const queued = [];
  const excludeCandidate = (candidate, run, live, reason, detail) => output.exclude.push({
    candidate_id: candidate.candidate_id, run_id: run.run_id, company: candidate.company ?? '',
    title: candidate.title ?? candidate.role ?? '', reason, detail, liveness: live,
  });

  for (const item of allCandidates) {
    const { run, candidate, liveness: live } = item;
    const trackedEvidence = trackedMatch(candidate.candidate_id);
    if (trackedEvidence) {
      excludeCandidate(candidate, run, live, 'already_tracked', trackedEvidence);
      continue;
    }
    const batchEvidence = applicationBatchMatch(candidate.candidate_id, applicationBatches, strongIds);
    if (batchEvidence) {
      excludeCandidate(candidate, run, live, 'in_application_batch', batchEvidence);
      continue;
    }
    const winner = winners.get(groupKeyFor(item));
    if (winner !== item) {
      excludeCandidate(candidate, run, live, 'duplicate_in_queue', {
        kept_run_id: winner.run.run_id, kept_run_dir: winner.run.dir, kept_candidate_id: winner.candidate.candidate_id,
      });
      continue;
    }
    if (live.status === 'expired') {
      excludeCandidate(candidate, run, live, 'liveness_expired', live);
      continue;
    }
    const description = String(candidate.description ?? '');
    if (description.length < 120) {
      excludeCandidate(candidate, run, live, 'no_description', {
        description_chars: description.length, threshold: 120, recoverable: live.status !== 'active',
      });
      continue;
    }
    if (candidate.location_eligibility === 'ineligible') {
      excludeCandidate(candidate, run, live, 'region', {
        location: candidate.location ?? null, location_eligibility: candidate.location_eligibility,
        location_eligibility_code: candidate.location_eligibility_code ?? null,
      });
      continue;
    }
    let prescreen;
    try {
      prescreen = prescreenJob({ title: candidate.title ?? candidate.role ?? '', description,
        location: candidate.location ?? '', country: candidate.country }, profile, { experiencePolicy });
    } catch (error) {
      throw new Error(`Could not prescreen ${candidate.candidate_id} from ${run.dir}: ${error.message}`);
    }
    if (prescreen?.blockers?.length) {
      excludeCandidate(candidate, run, live, 'prescreen_blocked', { blockers: prescreen.blockers });
      continue;
    }
    const possibleDuplicates = buildPossibleDuplicates(candidate, duplicateIndexes, tracked, mappings, strongIds,
      trackedMatch, weakTrackedMatch, discarded);
    const queueRecord = { candidate_id: candidate.candidate_id, run_id: run.run_id, run_dir: run.dir,
      company: candidate.company ?? '', title: candidate.title ?? candidate.role ?? '', location: candidate.location ?? null,
      url: candidate.url ?? null, description_chars: description.length, description_sha256: sha256(Buffer.from(description, 'utf8')),
      prescreen, liveness: live, possible_duplicates: possibleDuplicates };
    let queuedRecord = queueRecord;
    if (live.status === 'active') output.include.push(queueRecord);
    else {
      queuedRecord = { ...queueRecord, reason: 'No fresh active liveness evidence; confirm the listing before evaluation' };
      output.needs_liveness.push(queuedRecord);
    }
    queued.push({ index: queued.length, candidate, entry: queuedRecord,
      urls: duplicateIndexes.urlsByCandidate.get(candidate) ?? urlsFor(candidate) });
  }

  addQueuedDuplicateEvidence(queued);

  const excludeByReason = {};
  for (const item of output.exclude) excludeByReason[item.reason] = (excludeByReason[item.reason] ?? 0) + 1;
  output.counts = { include: output.include.length, needs_liveness: output.needs_liveness.length, exclude: output.exclude.length,
    exclude_by_reason: Object.fromEntries(Object.entries(excludeByReason).sort(([a], [b]) => a.localeCompare(b))) };
  return output;
}

function parseArgs(args) {
  const options = { runDirs: [], livenessDirs: [], root: SCRIPT_DIR, json: false, out: null, profilePath: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--run' || arg === '--liveness' || arg === '--root' || arg === '--profile' || arg === '--out') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--run') options.runDirs.push(resolve(value));
      else if (arg === '--liveness') options.livenessDirs.push(resolve(value));
      else if (arg === '--root') options.root = resolve(value);
      else if (arg === '--profile') options.profilePath = resolve(value);
      else options.out = resolve(value);
    } else if (arg === '--json') options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.runDirs.length) throw new Error('At least one --run directory is required');
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.out) {
      assertOutputSafe(options.out, options.runDirs, options.livenessDirs, options.root);
      if (existsSync(options.out)) throw new Error(`Refusing --out because destination already exists: ${options.out}`);
      if (!existsSync(dirname(options.out))) throw new Error(`Output parent directory does not exist: ${dirname(options.out)}`);
    }
    const result = buildEvalQueue(options);
    if (options.out) {
      writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (!options.out) {
      process.stdout.write(`Evaluation queue: ${result.counts.include} include, ${result.counts.needs_liveness} needs liveness, ${result.counts.exclude} excluded\n`);
      for (const [reason, count] of Object.entries(result.counts.exclude_by_reason)) process.stdout.write(`  ${reason}: ${count}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
