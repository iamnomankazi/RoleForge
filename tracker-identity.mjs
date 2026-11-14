import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isSeparatorRow, parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { resolveCanonicalState } from './tracker-utils.mjs';
import { parseReportMachineSummary, validateMachineSummary } from './assessment-contract.mjs';
import { canonicalListingUrl, isCandidateId } from './candidate-identity.mjs';

export const WORK_STATE_ORDER = Object.freeze([
  'Hired', 'Offer', 'Interview', 'Responded', 'Rejected', 'Applied', 'Discarded', 'SKIP', 'Evaluated',
]);

// Kept byte-for-byte equivalent in behavior to application-batch.mjs.
export function companyDuplicateKey(value) {
  let name = String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  const suffix = /(?:^| )(?:gmbh co kg|gmbh|ag|se|oy|oyj|ab|aps|a s|as|bv|b v|nv|ltd|limited|llc|inc|corp|corporation|plc|sa|sas|srl|spa|kg)$/;
  while (suffix.test(name)) {
    const stripped = name.replace(suffix, '').trim();
    if (!stripped) break;
    name = stripped;
  }
  return normalizeTextKey(name);
}

export function roleDuplicateKey(value) {
  const role = String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/\bc\+\+/g, 'cplusplus')
    .replace(/\bc#/g, 'csharp')
    .replace(/\bf#/g, 'fsharp')
    .replace(/\.net\b/g, 'dotnet');
  return normalizeTextKey(role);
}

function normalizeTextKey(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

function idValue(value) {
  const candidate = String(value ?? '').trim();
  return isCandidateId(candidate) ? candidate : null;
}

function pushWarning(warnings, message) {
  warnings.push(String(message));
}

function reportNumberFrom(value) {
  const file = basename(String(value ?? '').split(/[?#]/)[0]);
  const match = file.match(/^(\d+)(?:[-_.]|$)/);
  return match ? Number(match[1]) : null;
}

function reportLinks(value) {
  const links = [];
  const text = String(value ?? '');
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const target = match[1].trim().replace(/^<|>$/g, '');
    const number = reportNumberFrom(target);
    if (number != null && /\.md(?:[?#].*)?$/i.test(target)) links.push(number);
  }
  return [...new Set(links)];
}

function reportHeaders(markdown) {
  const candidate = markdown.match(/^\*\*Candidate ID:\*\*\s*(.*?)\s*$/im)?.[1] ?? '';
  const supersedesText = markdown.match(/^\*\*Supersedes:\*\*\s*\[[^\]]*\]\(([^)]+)\)/im)?.[1];
  return {
    candidateId: idValue(candidate),
    supersedes: supersedesText ? reportNumberFrom(supersedesText) : null,
  };
}

function reportIdMismatch(report) {
  const headerId = idValue(report?.candidateId);
  const summaryId = idValue(report?.summary?.candidate_id ?? report?.summary?.candidateId);
  return Boolean(headerId && summaryId && headerId !== summaryId);
}

export function loadReportIndex(reportsDir) {
  const index = new Map();
  index.warnings = [];
  try {
    for (const entry of readdirSync(reportsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      const number = reportNumberFrom(entry.name);
      if (number == null) continue;
      const file = join(resolve(reportsDir), entry.name);
      try {
        const markdown = readFileSync(file, 'utf8');
        const headers = reportHeaders(markdown);
        const summary = parseReportMachineSummary(markdown);
        let action = null;
        if (!summary) {
          pushWarning(index.warnings, `Report ${file} has no Machine Summary`);
        } else if (Array.isArray(summary.errors) && summary.errors.length) {
          pushWarning(index.warnings, `Report ${file} has an invalid Machine Summary: ${summary.errors.join('; ')}`);
        } else if (!summary.legacy) {
          const assessment = validateMachineSummary(summary);
          if (assessment.valid) action = assessment.action;
          else pushWarning(index.warnings, `Report ${file} has an invalid assessment: ${assessment.errors.join('; ')}`);
        }
        const report = { file, candidateId: headers.candidateId, supersedes: headers.supersedes, summary, action };
        if (reportIdMismatch(report)) {
          pushWarning(index.warnings, `Report ${file} has mismatched candidate IDs: header ${report.candidateId}; Machine Summary ${summary.candidate_id ?? summary.candidateId}`);
        }
        index.set(number, report);
      } catch (error) {
        pushWarning(index.warnings, `Could not parse report ${file}: ${error.message}`);
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') pushWarning(index.warnings, `Could not read reports directory ${reportsDir}: ${error.message}`);
  }
  return index;
}

function safeReadJson(file, warnings, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    pushWarning(warnings, `Could not read ${label} ${file}: ${error.message}`);
    return null;
  }
}

function mappingList(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.mappings)) return value.mappings;
  return null;
}

export function loadIdentityMappings(options = {}) {
  const scanRunsDir = options?.scanRunsDir;
  const correctionsDir = options?.correctionsDir;
  const warnings = [];
  const edgeSources = [];
  const ambiguous = new Set();

  let runEntries = [];
  try { runEntries = readdirSync(scanRunsDir, { withFileTypes: true }); }
  catch (error) {
    if (scanRunsDir && error?.code !== 'ENOENT') pushWarning(warnings, `Could not read scan runs ${scanRunsDir}: ${error.message}`);
  }
  for (const entry of runEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) {
      pushWarning(warnings, `Ignoring hidden scan run directory ${entry.name}`);
      continue;
    }
    const dir = join(scanRunsDir, entry.name);
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = safeReadJson(manifestPath, warnings, 'scan manifest');
    if (!manifest || typeof manifest !== 'object') continue;
    const enrichmentPath = join(dir, 'enrichment.json');
    if (!existsSync(enrichmentPath)) {
      if (manifest?.metadata?.tool === 'enrich-run') pushWarning(warnings, `Enrichment run ${entry.name} is missing enrichment.json`);
      continue;
    }
    if (manifest?.metadata?.tool !== 'enrich-run') {
      pushWarning(warnings, `Ignoring enrichment.json in ${entry.name}: manifest metadata.tool is not enrich-run`);
      continue;
    }
    let bytes;
    try { bytes = readFileSync(enrichmentPath); }
    catch (error) { pushWarning(warnings, `Could not read enrichment file ${enrichmentPath}: ${error.message}`); continue; }
    const expected = manifest?.metadata?.enrichment_sha256;
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (typeof expected !== 'string' || expected !== actual) {
      pushWarning(warnings, `Ignoring enrichment run ${entry.name}: enrichment hash is missing or invalid`);
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch (error) { pushWarning(warnings, `Ignoring unparsable enrichment file ${enrichmentPath}: ${error.message}`); continue; }
    const mappings = mappingList(parsed);
    if (!mappings) { pushWarning(warnings, `Ignoring malformed enrichment file ${enrichmentPath}: expected an array or mappings list`); continue; }
    const edges = [];
    for (const mapping of mappings) {
      if (!mapping || typeof mapping !== 'object') {
        pushWarning(warnings, `Ignoring malformed mapping in enrichment file ${enrichmentPath}`);
        continue;
      }
      const oldId = idValue(mapping.source_candidate_id);
      const newId = idValue(mapping.candidate_id);
      if (oldId && newId && oldId !== newId) edges.push({ old: oldId, new: newId, source: enrichmentPath, converged: mapping.converged === true });
      else if (!oldId || !newId) pushWarning(warnings, `Ignoring mapping with invalid candidate IDs in ${enrichmentPath}`);
    }
    edgeSources.push(...edges);
  }

  let correctionEntries = [];
  try { correctionEntries = readdirSync(correctionsDir, { withFileTypes: true }); }
  catch (error) {
    if (correctionsDir && error?.code !== 'ENOENT') pushWarning(warnings, `Could not read identity corrections ${correctionsDir}: ${error.message}`);
  }
  for (const entry of correctionEntries) {
    if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue;
    const file = join(correctionsDir, entry.name);
    const ledger = safeReadJson(file, warnings, 'identity corrections ledger');
    if (!ledger || typeof ledger !== 'object' || !Array.isArray(ledger.entries)) {
      pushWarning(warnings, `Ignoring malformed identity corrections ledger ${file}`);
      continue;
    }
    if (Array.isArray(ledger.old_ids_shared_by_distinct_openings)) {
      for (const item of ledger.old_ids_shared_by_distinct_openings) {
        const sharedId = idValue(item?.old_candidate_id);
        if (sharedId) ambiguous.add(sharedId);
      }
    }
    for (const item of ledger.entries) {
      const oldId = idValue(item?.old_candidate_id);
      if (!oldId || !Array.isArray(item?.corrected)) continue;
      for (const corrected of item.corrected) {
        const newId = idValue(corrected?.candidate_id);
        if (newId && oldId !== newId) edgeSources.push({ old: oldId, new: newId, source: file });
      }
    }
  }

  const targets = new Map();
  const sources = new Map();
  // Converged mappings still contribute to cardinality across all sources.
  for (const edge of edgeSources) {
    if (!targets.has(edge.old)) targets.set(edge.old, new Set());
    if (!sources.has(edge.new)) sources.set(edge.new, new Set());
    targets.get(edge.old).add(edge.new);
    sources.get(edge.new).add(edge.old);
  }
  for (const [oldId, distinctTargets] of targets) if (distinctTargets.size > 1) ambiguous.add(oldId);
  const equivalent = new Map();
  const discardedEdges = [];
  for (const edge of edgeSources) {
    const outDegree = targets.get(edge.old)?.size ?? 0;
    const inDegree = sources.get(edge.new)?.size ?? 0;
    if (ambiguous.has(edge.old) || ambiguous.has(edge.new) || outDegree !== 1 || inDegree !== 1) {
      const reason = outDegree !== 1 ? 'one_to_many' : inDegree !== 1 ? 'many_to_one' : 'ambiguous_id';
      discardedEdges.push({ ...edge, reason });
      continue;
    }
    if (edge.converged) {
      discardedEdges.push({ ...edge, reason: 'converged' });
      continue;
    }
    if (!equivalent.has(edge.old)) equivalent.set(edge.old, new Set([edge.old]));
    if (!equivalent.has(edge.new)) equivalent.set(edge.new, new Set([edge.new]));
    equivalent.get(edge.old).add(edge.new);
    equivalent.get(edge.new).add(edge.old);
  }
  // Turn valid edges into transitive equivalence components, including chains.
  const visited = new Set();
  for (const id of equivalent.keys()) {
    if (visited.has(id)) continue;
    const component = new Set();
    const queue = [id];
    while (queue.length) {
      const next = queue.pop();
      if (visited.has(next)) continue;
      visited.add(next);
      component.add(next);
      for (const neighbor of equivalent.get(next) ?? []) if (!visited.has(neighbor)) queue.push(neighbor);
    }
    for (const member of component) equivalent.set(member, new Set(component));
  }
  return { equivalent, ambiguous, discardedEdges, warnings };
}

export function loadRunCandidates(scanRunsDir) {
  const runCandidates = new Map();
  runCandidates.warnings = [];
  let entries = [];
  try { entries = readdirSync(scanRunsDir, { withFileTypes: true }); }
  catch (error) {
    if (scanRunsDir && error?.code !== 'ENOENT') pushWarning(runCandidates.warnings, `Could not read scan runs ${scanRunsDir}: ${error.message}`);
    return runCandidates;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(scanRunsDir, entry.name);
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = safeReadJson(manifestPath, runCandidates.warnings, 'scan manifest');
    if (!manifest || typeof manifest !== 'object') continue;
    const candidatesPath = join(dir, 'candidates.json');
    if (!existsSync(candidatesPath)) {
      pushWarning(runCandidates.warnings, `Scan run ${entry.name} is missing candidates.json`);
      continue;
    }
    const parsed = safeReadJson(candidatesPath, runCandidates.warnings, 'scan candidates');
    const candidates = Array.isArray(parsed) ? parsed : parsed?.candidates;
    if (!Array.isArray(candidates)) {
      pushWarning(runCandidates.warnings, `Malformed candidates.json in scan run ${entry.name}`);
      continue;
    }
    const runDate = manifest.created_at ?? manifest.createdAt ?? manifest.generated_at ?? manifest.generatedAt ?? '';
    for (const candidate of candidates) {
      const id = idValue(candidate?.candidate_id ?? candidate?.candidateId);
      if (!id) continue;
      const record = { ...candidate, candidate_id: id, run_id: entry.name, created_at: candidate.created_at ?? candidate.createdAt ?? runDate };
      const existing = runCandidates.get(id);
      if (!existing || String(record.created_at ?? '').localeCompare(String(existing.created_at ?? '')) > 0) runCandidates.set(id, record);
    }
  }
  return runCandidates;
}

export function findCandidateRecord(runCandidates, mappings, id) {
  const candidateId = idValue(id);
  if (!candidateId) return null;
  if (runCandidates?.has(candidateId)) return runCandidates.get(candidateId);
  const equivalents = mappings?.equivalent?.get(candidateId) ?? new Set();
  let newest = null;
  for (const equivalentId of equivalents) {
    const record = runCandidates?.get(equivalentId);
    if (record && (!newest || String(record.created_at ?? '').localeCompare(String(newest.created_at ?? '')) > 0)) newest = record;
  }
  return newest;
}

function notesIds(notes) {
  const ids = new Set();
  const pattern = /Canonical candidate ID:\s*([^\s,;]+)/gi;
  let match;
  while ((match = pattern.exec(String(notes ?? '')))) {
    const id = idValue(match[1].replace(/[.)]+$/, ''));
    if (id) ids.add(id);
  }
  return ids;
}

export function rowIdentity(row, reportIndex, mappings) {
  const ids = notesIds(row?.notes);
  const reports = reportLinks(row?.report);
  for (const number of reports) {
    const report = reportIndex?.get?.(number);
    const headerId = idValue(report?.candidateId);
    if (headerId) ids.add(headerId);
  }
  const textKey = [companyDuplicateKey(row?.company), roleDuplicateKey(row?.role)].every(Boolean)
    ? `${companyDuplicateKey(row.company)}\0${roleDuplicateKey(row.role)}` : '';
  return { ids, reports, textKey };
}

function urlAliases(candidate) {
  const values = [candidate?.url, candidate?.original_url, candidate?.resolved_url, candidate?.apply_url,
    candidate?.canonical_url, ...(Array.isArray(candidate?.url_aliases) ? candidate.url_aliases : [])];
  return new Set(values.map(canonicalListingUrl).filter(Boolean));
}

function groupRunRecords(group, runCandidates, mappings) {
  const records = new Map();
  for (const id of group.ids) {
    const record = findCandidateRecord(runCandidates, mappings, id);
    if (record) records.set(record.candidate_id, record);
  }
  return [...records.values()];
}

function addPossible(group, other, reason, details = {}) {
  if (group === other) return;
  const key = `${other._key}|${reason}`;
  if (group._possibleKeys.has(key)) return;
  group._possibleKeys.add(key);
  group.possibleDuplicates.push({ group: other._key, rows: other.rows.map((row) => row.num), reason, ...details });
}

function discardedMappingComponents(edges) {
  const adjacent = new Map();
  const reasons = new Map();
  for (const edge of edges ?? []) {
    if (!adjacent.has(edge.old)) adjacent.set(edge.old, new Set());
    if (!adjacent.has(edge.new)) adjacent.set(edge.new, new Set());
    adjacent.get(edge.old).add(edge.new);
    adjacent.get(edge.new).add(edge.old);
    for (const id of [edge.old, edge.new]) {
      if (!reasons.has(id)) reasons.set(id, new Set());
      reasons.get(id).add(edge.reason);
    }
  }
  const componentById = new Map();
  const reasonByComponent = new Map();
  for (const id of adjacent.keys()) {
    if (componentById.has(id)) continue;
    const component = new Set();
    const queue = [id];
    while (queue.length) {
      const current = queue.pop();
      if (component.has(current)) continue;
      component.add(current);
      for (const neighbor of adjacent.get(current) ?? []) queue.push(neighbor);
    }
    const key = [...component].sort()[0];
    const componentReasons = new Set([...component].flatMap((member) => [...(reasons.get(member) ?? [])]));
    reasonByComponent.set(key, componentReasons);
    for (const member of component) componentById.set(member, key);
  }
  return { componentById, reasonByComponent };
}

function supersedesComponents(reportIndex) {
  const adjacent = new Map();
  for (const [number, report] of reportIndex instanceof Map ? reportIndex : []) {
    const target = report?.supersedes;
    if (!Number.isSafeInteger(number) || !Number.isSafeInteger(target)) continue;
    if (!adjacent.has(number)) adjacent.set(number, new Set());
    if (!adjacent.has(target)) adjacent.set(target, new Set());
    adjacent.get(number).add(target);
    adjacent.get(target).add(number);
  }
  const componentByReport = new Map();
  for (const number of adjacent.keys()) {
    if (componentByReport.has(number)) continue;
    const queue = [number];
    while (queue.length) {
      const current = queue.pop();
      if (componentByReport.has(current)) continue;
      componentByReport.set(current, number);
      for (const neighbor of adjacent.get(current) ?? []) queue.push(neighbor);
    }
  }
  return componentByReport;
}

export function groupTrackerRows(rows, reportIndex, mappings, options = {}) {
  const states = Array.isArray(options?.states) ? options.states : [];
  const runCandidates = options?.runCandidates ?? new Map();
  const list = Array.isArray(rows) ? rows.map((row) => row && typeof row === 'object' && !Array.isArray(row) ? row : {}) : [];
  const canonicalStates = states;
  const identities = list.map((row) => rowIdentity(row, reportIndex, mappings));
  const parent = list.map((_, index) => index);
  const find = (index) => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const identityOwner = new Map();
  // Include untracked reports before assigning rows to Supersedes components.
  const reportComponents = supersedesComponents(reportIndex);
  const reportOwner = new Map();
  for (let index = 0; index < list.length; index += 1) {
    for (const id of identities[index].ids) {
      if (mappings?.ambiguous?.has(id)) continue;
      const component = mappings?.equivalent?.get(id) ?? new Set([id]);
      for (const equivalentId of component) {
        if (mappings?.ambiguous?.has(equivalentId)) continue;
        if (identityOwner.has(equivalentId)) union(index, identityOwner.get(equivalentId));
        else identityOwner.set(equivalentId, index);
      }
    }
    for (const number of identities[index].reports) {
      const component = reportComponents.get(number) ?? number;
      if (reportOwner.has(component)) union(index, reportOwner.get(component));
      else reportOwner.set(component, index);
    }
  }
  const rawGroups = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const root = find(index);
    if (!rawGroups.has(root)) rawGroups.set(root, { rows: [], identities: [] });
    rawGroups.get(root).rows.push(list[index]);
    rawGroups.get(root).identities.push(identities[index]);
  }
  const groupRecords = [...rawGroups.values()].map((record, index) => {
    const ids = new Set(record.identities.flatMap((identity) => [...identity.ids]).filter((id) => !mappings?.ambiguous?.has(id)));
    const reports = [...new Set(record.identities.flatMap((identity) => identity.reports))].sort((a, b) => a - b);
    const statuses = record.rows.map((row) => resolveCanonicalState(row.status, canonicalStates));
    const unknown = statuses.some((status) => status == null);
    const present = new Set(statuses.filter(Boolean));
    const nonEvaluated = new Set([...present].filter((status) => status !== 'Evaluated'));
    const status = WORK_STATE_ORDER.find((candidate) => present.has(candidate)) ?? record.rows.map((row) => String(row.status ?? '').trim()).find(Boolean) ?? '';
    const flags = [];
    if (nonEvaluated.size > 1) flags.push('mixed_status');
    if (unknown) flags.push('unknown_status');
    if (reports.some((number) => reportIdMismatch(reportIndex?.get?.(number)))) flags.push('report_id_mismatch');
    let conflict = false;
    for (let left = 0; left < record.rows.length; left += 1) {
      for (let right = left + 1; right < record.rows.length; right += 1) {
        const leftIds = [...record.identities[left].ids].filter((id) => !mappings?.ambiguous?.has(id));
        const rightIds = [...record.identities[right].ids].filter((id) => !mappings?.ambiguous?.has(id));
        const leftKeys = new Set(leftIds.flatMap((id) => [...(mappings?.equivalent?.get(id) ?? new Set([id]))]));
        if ([...rightIds].some((id) => leftKeys.has(id) || [...(mappings?.equivalent?.get(id) ?? new Set([id]))].some((candidate) => leftKeys.has(candidate)))) {
          if (companyDuplicateKey(record.rows[left].company) !== companyDuplicateKey(record.rows[right].company)) conflict = true;
        }
      }
    }
    if (conflict) flags.push('conflict');
    const rawIds = new Set(record.identities.flatMap((identity) => [...identity.ids]));
    const group = {
      rows: record.rows,
      ids,
      reports,
      open: !unknown && statuses.length > 0 && statuses.every((value) => value === 'Evaluated'),
      status,
      flags,
      possibleDuplicates: [],
      _rawIds: rawIds,
      _identities: record.identities,
      _key: `group-${index + 1}`,
      _possibleKeys: new Set(),
    };
    return group;
  });
  const discardedComponents = discardedMappingComponents(mappings?.discardedEdges);
  for (const group of groupRecords) {
    group._discardedComponents = new Set([...group._rawIds].map((id) => discardedComponents.componentById.get(id)).filter(Boolean));
  }

  for (let left = 0; left < groupRecords.length; left += 1) {
    for (let right = left + 1; right < groupRecords.length; right += 1) {
      const a = groupRecords[left]; const b = groupRecords[right];
      const commonText = a._identities.some((identity) => identity.textKey && b._identities.some((other) => identity.textKey === other.textKey));
      if (commonText) { addPossible(a, b, 'company_role_match'); addPossible(b, a, 'company_role_match'); }
      const commonAmbiguous = [...a._rawIds].filter((id) => mappings?.ambiguous?.has(id) && b._rawIds.has(id));
      if (commonAmbiguous.length) {
        addPossible(a, b, 'ambiguous_id', { candidateIds: commonAmbiguous });
        addPossible(b, a, 'ambiguous_id', { candidateIds: commonAmbiguous });
      }
      const recordsA = groupRunRecords(a, runCandidates, mappings);
      const recordsB = groupRunRecords(b, runCandidates, mappings);
      const sharedUrls = new Set();
      for (const recordA of recordsA) {
        const aliasesA = urlAliases(recordA);
        for (const recordB of recordsB) {
          if (recordA.candidate_id === recordB.candidate_id) continue;
          for (const url of urlAliases(recordB)) if (aliasesA.has(url)) sharedUrls.add(url);
        }
      }
      if (sharedUrls.size) {
        const urls = [...sharedUrls];
        addPossible(a, b, 'shared_url_alias', { urls });
        addPossible(b, a, 'shared_url_alias', { urls });
      }
      const sharedDiscardedComponents = [...a._discardedComponents].filter((component) => b._discardedComponents.has(component));
      if (sharedDiscardedComponents.length) {
        const edgeReasons = [...new Set(sharedDiscardedComponents.flatMap((component) => [...(discardedComponents.reasonByComponent.get(component) ?? [])]))];
        addPossible(a, b, 'discarded_mapping', { candidateIds: sharedDiscardedComponents, edgeReasons });
        addPossible(b, a, 'discarded_mapping', { candidateIds: sharedDiscardedComponents, edgeReasons });
      }
    }
  }
  return groupRecords.map(({ _rawIds, _identities, _key, _possibleKeys, _discardedComponents, ...group }) => group);
}

export function findGroupsForCandidate(groups, candidateIds) {
  const ids = new Set((Array.isArray(candidateIds) ? candidateIds : [candidateIds]).map(idValue).filter(Boolean));
  return (groups ?? []).filter((group) => [...(group.ids ?? [])].some((id) => ids.has(id)));
}

export function loadTrackerRows(trackerPath) {
  const result = { rows: [], warnings: [] };
  let content;
  try { content = readFileSync(trackerPath, 'utf8'); }
  catch (error) { pushWarning(result.warnings, `Could not read tracker ${trackerPath}: ${error.message}`); return result; }
  const lines = content.split(/\r?\n/);
  let columns;
  try { columns = resolveColumns(lines); }
  catch (error) { pushWarning(result.warnings, `Could not resolve tracker columns: ${error.message}`); return result; }
  let sawHeader = false;
  for (const line of lines) {
    if (!line.trim().startsWith('|') || isSeparatorRow(line)) continue;
    const cells = line.split('|').map((cell) => cell.trim().toLowerCase());
    if (!sawHeader && cells.some((cell) => ['#', 'num', 'number'].includes(cell))) { sawHeader = true; continue; }
    const row = parseTrackerRow(line, columns);
    if (row) {
      row.reportLinks = reportLinks(row.report);
      result.rows.push(row);
    } else if (sawHeader && line.trim() !== '') {
      pushWarning(result.warnings, `Skipped malformed tracker row: ${line.slice(0, 120)}`);
    }
  }
  return result;
}
