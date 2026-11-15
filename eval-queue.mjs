#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  companyDuplicateKey, groupTrackerRows, loadIdentityMappings, loadReportIndex,
  loadRunCandidates, loadTrackerRows, roleDuplicateKey, rowIdentity,
} from './tracker-identity.mjs';
import { resolveTrackerPath } from './tracker-utils.mjs';
import { canonicalListingUrl, isCandidateId } from './candidate-identity.mjs';
import { loadPrescreenProfile, prescreenJob } from './prescreen.mjs';

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
  }
  return { componentByReport, idsByReport };
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
      enrichment = { bytes, value: (() => {
        try { return JSON.parse(bytes.toString('utf8')); }
        catch { return null; }
      })() };
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

function strongIds(id, mappings, reportInfo) {
  if (mappings.ambiguous.has(id)) return new Set();
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const current of [...ids]) {
      for (const relatedId of mappings.equivalent.get(current) ?? []) {
        if (!mappings.ambiguous.has(relatedId) && !ids.has(relatedId)) { ids.add(relatedId); changed = true; }
      }
    }
    for (const reportIds of reportInfo.idsByReport.values()) {
      if ([...reportIds].some((reportId) => ids.has(reportId))) {
        for (const relatedId of reportIds) {
          if (!mappings.ambiguous.has(relatedId) && !ids.has(relatedId)) { ids.add(relatedId); changed = true; }
        }
      }
    }
  }
  for (const member of [...ids]) {
    if (mappings.ambiguous.has(member)) ids.delete(member);
  }
  return ids;
}

function trackedMatch(candidateId, tracked, mappings, reportInfo) {
  const ids = strongIds(candidateId, mappings, reportInfo);
  if (!ids.size) return null;
  const matches = [...ids].filter((id) => tracked.trackedIds.has(id));
  if (!matches.length) return null;
  const rows = new Map();
  const reports = new Set();
  for (const id of matches) {
    for (const evidence of tracked.evidenceById.get(id) ?? []) {
      for (const row of evidence.tracker_rows ?? []) rows.set(`${row.num}\0${row.status}`, row);
      for (const number of evidence.report_numbers ?? []) reports.add(number);
    }
  }
  return { matched_candidate_ids: matches, tracker_rows: [...rows.values()].sort((a, b) => Number(a.num) - Number(b.num)),
    report_numbers: [...reports].sort((a, b) => a - b) };
}

function weakTrackedMatch(candidateId, tracked, mappings, reportInfo) {
  const strong = trackedMatch(candidateId, tracked, mappings, reportInfo);
  if (strong) return strong;
  const evidence = tracked.evidenceById.get(candidateId);
  if (!evidence?.length) return null;
  const rows = new Map(); const reports = new Set();
  for (const item of evidence) {
    for (const row of item.tracker_rows ?? []) rows.set(`${row.num}\0${row.status}`, row);
    for (const number of item.report_numbers ?? []) reports.add(number);
  }
  return { matched_candidate_ids: [candidateId],
    tracker_rows: [...rows.values()].sort((a, b) => Number(a.num) - Number(b.num)),
    report_numbers: [...reports].sort((a, b) => a - b) };
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

function buildPossibleDuplicates(candidate, allRunCandidates, trackerRows, tracked, mappings, discarded, reportIndex, reportInfo) {
  const results = [];
  const seen = new Set();
  const add = (value) => {
    const key = JSON.stringify(value);
    if (!seen.has(key)) { seen.add(key); results.push(value); }
  };
  const candidateUrls = urlsFor(candidate);
  if (candidateUrls.size) {
    for (const record of allRunCandidates) {
      if (!record?.candidate_id || record.candidate_id === candidate.candidate_id) continue;
      const matchingTracked = weakTrackedMatch(record.candidate_id, tracked, mappings, reportInfo);
      if (!matchingTracked) continue;
      const matchingUrls = [...urlsFor(record)].filter((url) => candidateUrls.has(url));
      if (!matchingUrls.length) continue;
      add({ reason: 'shared_url_alias', urls: matchingUrls, candidate_id: record.candidate_id,
        tracker_rows: matchingTracked.tracker_rows, report_numbers: matchingTracked.report_numbers });
    }
  }
  const companyKey = companyDuplicateKey(candidate.company);
  const roleKey = roleDuplicateKey(candidate.title ?? candidate.role);
  if (companyKey && roleKey) {
    for (const row of trackerRows) {
      const rowCompanyKey = companyDuplicateKey(row.company);
      const rowRoleKey = roleDuplicateKey(row.role);
      if (companyKey === rowCompanyKey && roleKey === rowRoleKey) {
        add({ reason: 'company_role_match', tracker_rows: [{ num: row.num, status: row.status }] });
      }
    }
  }
  const candidateComponent = discarded.componentById.get(candidate.candidate_id);
  if (candidateComponent) {
    const trackedComponentIds = [...candidateComponent].filter((id) => tracked.trackedIds.has(id)
      || mappings.ambiguous.has(id) && tracked.evidenceById.has(id));
    if (trackedComponentIds.length) {
      const relevantEdges = (discarded.edgesById.get(candidate.candidate_id) ?? [])
        .filter((edge) => candidateComponent.has(edge.old) && candidateComponent.has(edge.new));
      add({ reason: 'discarded_mapping', candidate_ids: trackedComponentIds,
        edge_reasons: [...new Set(relevantEdges.map((edge) => edge.reason))].sort() });
    }
  }
  if (mappings.ambiguous.has(candidate.candidate_id) && tracked.evidenceById.has(candidate.candidate_id)) {
    add({ reason: 'ambiguous_id', candidate_id: candidate.candidate_id,
      evidence: tracked.evidenceById.get(candidate.candidate_id) });
  }
  return results;
}

function assertOutputSafe(outPath, runs, root) {
  const canonicalOut = canonicalPath(outPath);
  const scanRuns = canonicalPath(join(resolve(root), 'output', 'scan-runs'));
  if (runs.some((run) => inside(canonicalOut, canonicalPath(run.dir)))) {
    throw new Error(`Refusing --out inside an input run directory: ${outPath}`);
  }
  if (inside(canonicalOut, scanRuns)) throw new Error(`Refusing --out inside output/scan-runs: ${outPath}`);
}

export function buildEvalQueue({ runDirs = [], livenessDirs = [], root = SCRIPT_DIR, profilePath, now = new Date() } = {}) {
  if (!Array.isArray(runDirs) || runDirs.length === 0) throw new Error('At least one --run directory is required');
  const absoluteRoot = resolve(root);
  const runs = loadRuns(runDirs);
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
    if (tracker.warnings.some((message) => /Could not read tracker|Could not resolve tracker columns/.test(message))) {
      throw new Error(tracker.warnings.join('; '));
    }
    warnings.push(...tracker.warnings);
  }
  const reportIndex = reportsExist ? loadReportIndex(reportsDir) : new Map();
  if ((reportIndex.warnings ?? []).some((message) => message.startsWith('Could not parse report ')
    || message.startsWith('Could not read reports directory '))) {
    throw new Error(reportIndex.warnings.join('; '));
  }
  warnings.push(...(reportIndex.warnings ?? []));
  const scanRunsDir = join(absoluteRoot, 'output', 'scan-runs');
  const mappings = loadIdentityMappings({ scanRunsDir, correctionsDir: join(absoluteRoot, 'output', 'identity-corrections') });
  warnings.push(...mappings.warnings);
  const runCandidates = loadRunCandidates(scanRunsDir);
  warnings.push(...runCandidates.warnings);
  const groups = groupTrackerRows(tracker.rows, reportIndex, mappings);
  const tracked = buildTrackedEvidence(groups, reportIndex, mappings);
  const reportInfo = reportComponents(reportIndex);
  const liveness = loadLivenessInputs(livenessDirs, warnings);
  const chosenProfilePath = profilePath == null ? join(absoluteRoot, 'config', 'profile.yml') : resolve(profilePath);
  let profile = null;
  let profileHash = null;
  try {
    const profileBytes = readFileSync(chosenProfilePath);
    profileHash = sha256(profileBytes);
    profile = loadPrescreenProfile(chosenProfilePath);
  } catch (error) {
    warning(warnings, `Prescreen profile unavailable at ${chosenProfilePath}; prescreen blockers are disabled: ${error.message}`);
  }

  const allCandidates = runs.flatMap((run, runIndex) => run.candidates.map((candidate, candidateIndex) => ({
    run, runIndex, candidateIndex, candidate, liveness: effectiveLiveness(candidate, run, liveness.entries),
  })));
  const groupKeyFor = (item) => {
    const strong = strongIds(item.candidate.candidate_id, mappings, reportInfo);
    if (!strong.size) return `ambiguous:${item.runIndex}:${item.candidateIndex}`;
    return [...strong].sort()[0];
  };
  const winners = new Map();
  for (const item of allCandidates) {
    if (trackedMatch(item.candidate.candidate_id, tracked, mappings, reportInfo)) continue;
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

  for (const item of allCandidates) {
    const { run, candidate, liveness: live } = item;
    const trackedEvidence = trackedMatch(candidate.candidate_id, tracked, mappings, reportInfo);
    if (trackedEvidence) {
      output.exclude.push({ candidate_id: candidate.candidate_id, run_id: run.run_id, company: candidate.company ?? '',
        title: candidate.title ?? candidate.role ?? '', reason: 'already_tracked', detail: trackedEvidence });
      continue;
    }
    const winner = winners.get(groupKeyFor(item));
    if (winner !== item) {
      output.exclude.push({ candidate_id: candidate.candidate_id, run_id: run.run_id, company: candidate.company ?? '',
        title: candidate.title ?? candidate.role ?? '', reason: 'duplicate_in_queue', detail: {
          kept_run_id: winner.run.run_id, kept_run_dir: winner.run.dir, kept_candidate_id: winner.candidate.candidate_id,
        } });
      continue;
    }
    if (live.status === 'expired') {
      output.exclude.push({ candidate_id: candidate.candidate_id, run_id: run.run_id, company: candidate.company ?? '',
        title: candidate.title ?? candidate.role ?? '', reason: 'liveness_expired', detail: live });
      continue;
    }
    const description = String(candidate.description ?? '');
    if (description.length < 120) {
      output.exclude.push({ candidate_id: candidate.candidate_id, run_id: run.run_id, company: candidate.company ?? '',
        title: candidate.title ?? candidate.role ?? '', reason: 'no_description', detail: {
          description_chars: description.length, threshold: 120, recoverable: live.status !== 'active',
        } });
      continue;
    }
    if (candidate.location_eligibility === 'ineligible') {
      output.exclude.push({ candidate_id: candidate.candidate_id, run_id: run.run_id, company: candidate.company ?? '',
        title: candidate.title ?? candidate.role ?? '', reason: 'region', detail: {
          location: candidate.location ?? null, location_eligibility: candidate.location_eligibility,
          location_eligibility_code: candidate.location_eligibility_code ?? null,
        } });
      continue;
    }
    let prescreen = null;
    if (profile) {
      try {
        prescreen = prescreenJob({ title: candidate.title ?? candidate.role ?? '', description,
          location: candidate.location ?? '', country: candidate.country }, profile);
      } catch (error) {
        warning(warnings, `Could not prescreen ${candidate.candidate_id} from ${run.dir}: ${error.message}`);
      }
    }
    if (prescreen?.blockers?.length) {
      output.exclude.push({ candidate_id: candidate.candidate_id, run_id: run.run_id, company: candidate.company ?? '',
        title: candidate.title ?? candidate.role ?? '', reason: 'prescreen_blocked', detail: { blockers: prescreen.blockers } });
      continue;
    }
    const possibleDuplicates = buildPossibleDuplicates(candidate, allRunCandidates, tracker.rows, tracked, mappings,
      discardedComponents(mappings.discardedEdges), reportIndex, reportInfo);
    const queueRecord = { candidate_id: candidate.candidate_id, run_id: run.run_id, run_dir: run.dir,
      company: candidate.company ?? '', title: candidate.title ?? candidate.role ?? '', location: candidate.location ?? null,
      url: candidate.url ?? null, description_chars: description.length, description_sha256: sha256(Buffer.from(description, 'utf8')),
      prescreen, liveness: live, possible_duplicates: possibleDuplicates };
    if (live.status === 'active') output.include.push(queueRecord);
    else output.needs_liveness.push({ ...queueRecord, reason: 'No fresh active liveness evidence; confirm the listing before evaluation' });
  }

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
      else options.out = value;
    } else if (arg === '--json') options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.runDirs.length) throw new Error('At least one --run directory is required');
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = buildEvalQueue(options);
    if (options.out) {
      const outPath = resolve(options.root, options.out);
      assertOutputSafe(outPath, loadRuns(options.runDirs), options.root);
      if (!existsSync(dirname(outPath))) throw new Error(`Output parent directory does not exist: ${dirname(outPath)}`);
      writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
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
