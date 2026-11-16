import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCanonicalStates, resolveCanonicalState, resolveTrackerPath } from './tracker-utils.mjs';
import {
  companyDuplicateKey, findCandidateRecord, groupTrackerRows, loadIdentityMappings, roleDuplicateKey,
  loadReportIndex, loadRunCandidates, loadTrackerRows, rowIdentity,
} from './tracker-identity.mjs';

const IN_PROGRESS_STATES = new Set(['not_opened', 'review_required', 'blocked', 'login_required', 'human_action_required']);
const CLOSED_STATUSES = new Set(['Rejected', 'Discarded', 'SKIP']);

function warning(result, value) { result.warnings.push(String(value)); }

function safeJson(file, warnings, label) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { warning({ warnings }, `Could not read ${label} ${file}: ${error.message}`); return null; }
}

function daysSince(value, now) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return Math.floor((Date.parse(now) - Date.parse(value)) / 86_400_000);
}

function dateValue(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function batchCandidateState(state, candidate, index) {
  const states = Array.isArray(state?.candidates) ? state.candidates : [];
  const match = states.find((entry) => entry?.candidate_id === candidate.candidate_id) ?? states[index];
  return match?.state ?? candidate.initialState ?? null;
}

function loadBatches(root, warnings) {
  const batchRoot = join(root, 'output', 'application-batches');
  let dirs = [];
  try { dirs = readdirSync(batchRoot, { withFileTypes: true }); }
  catch (error) {
    if (existsSync(root) && error?.code !== 'ENOENT') warning({ warnings }, `Could not read application batches ${batchRoot}: ${error.message}`);
    return [];
  }
  const batches = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name.startsWith('.')) continue;
    const manifestPath = join(batchRoot, dir.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = safeJson(manifestPath, warnings, 'application batch manifest');
    if (!manifest || !Array.isArray(manifest.candidates)) {
      warning({ warnings }, `Ignoring malformed application batch manifest ${manifestPath}`);
      continue;
    }
    const statePath = join(batchRoot, dir.name, 'state.json');
    const state = existsSync(statePath) ? safeJson(statePath, warnings, 'application batch state') : null;
    for (let index = 0; index < manifest.candidates.length; index += 1) {
      const candidate = manifest.candidates[index];
      if (!candidate || typeof candidate !== 'object') {
        warning({ warnings }, `Ignoring malformed candidate ${index + 1} in batch ${dir.name}`);
        continue;
      }
      batches.push({
        batch_id: manifest.batchId ?? dir.name,
        candidate_id: candidate.candidate_id ?? null,
        company: candidate.company ?? '',
        title: candidate.title ?? candidate.role ?? '',
        state: batchCandidateState(state, candidate, index),
        source_run_id: manifest.sourceRunId ?? candidate.run_id ?? null,
        listing_url: candidate.listingUrl ?? candidate.listing_url ?? null,
      });
    }
  }
  return batches;
}

function loadLiveness(root, warnings) {
  const outputRoot = join(root, 'output');
  let runDirs = [];
  try { runDirs = readdirSync(outputRoot, { withFileTypes: true }); }
  catch (error) {
    if (error?.code !== 'ENOENT') warning({ warnings }, `Could not read liveness output ${outputRoot}: ${error.message}`);
    return new Map();
  }

  const files = [];
  for (const runDir of runDirs) {
    if (!runDir.isDirectory() || runDir.name.startsWith('.')) continue;
    const runPath = join(outputRoot, runDir.name);
    let children = [];
    try { children = readdirSync(runPath, { withFileTypes: true }); }
    catch (error) {
      if (error?.code !== 'ENOENT') warning({ warnings }, `Could not read liveness directory ${runPath}: ${error.message}`);
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory() || (runDir.name !== 'liveness' && !child.name.startsWith('liveness'))) continue;
      const file = join(runPath, child.name, 'liveness.json');
      if (existsSync(file)) files.push(file);
    }
  }

  const latestById = new Map();
  for (const file of files.sort()) {
    const warningCount = warnings.length;
    const parsed = safeJson(file, warnings, 'liveness results');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (warnings.length === warningCount) warning({ warnings }, `Ignoring malformed liveness results ${file}: expected an object keyed by candidate ID`);
      continue;
    }
    for (const [candidateId, entry] of Object.entries(parsed)) {
      const checkedAt = entry && typeof entry === 'object' ? entry.checked_at : null;
      const checkedAtMs = typeof checkedAt === 'string' ? Date.parse(checkedAt) : NaN;
      if (!Number.isFinite(checkedAtMs)) continue;
      const current = latestById.get(candidateId);
      if (!current || checkedAtMs > current.checkedAtMs) latestById.set(candidateId, { ...entry, checkedAtMs });
    }
  }
  return latestById;
}

function bestCurrentReport(group, reportIndex, superseded) {
  const candidates = reportNumbersForGroup(group, reportIndex).filter((number) => reportIndex.has(number) && !superseded.has(number))
    .map((number) => ({ number, ...reportIndex.get(number) }));
  candidates.sort((a, b) => String(b.summary?.date ?? '').localeCompare(String(a.summary?.date ?? ''))
    || b.number - a.number || String(a.file).localeCompare(String(b.file)));
  return candidates[0] ?? null;
}

function reportNumbersForGroup(group, reportIndex) {
  const related = new Set(group.reports ?? []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [number, report] of reportIndex) {
      if (report?.supersedes == null) continue;
      if (related.has(number) || related.has(report.supersedes)) {
        const before = related.size;
        related.add(number);
        related.add(report.supersedes);
        if (related.size !== before) changed = true;
      }
    }
  }
  return [...related];
}

function linkedBatches(group, batches, mappings) {
  const groupIds = new Set(group.ids ?? []);
  return batches.filter((batch) => {
    if (!batch.candidate_id) return false;
    if (groupIds.has(batch.candidate_id)) return true;
    return [...(mappings.equivalent.get(batch.candidate_id) ?? [])].some((id) => groupIds.has(id));
  });
}

function allGroupRecords(group, runCandidates, mappings) {
  const records = new Map();
  for (const id of group.ids ?? []) {
    const record = findCandidateRecord(runCandidates, mappings, id);
    if (record) records.set(record.candidate_id, record);
  }
  return [...records.values()];
}

function tenantSlugMatches(company, record) {
  const key = companyDuplicateKey(company);
  if (!key) return false;
  const candidates = [record.ats_tenant, record.atsTenant, record.tenant, record.company_slug, record.companySlug,
    record.board_token, record.boardToken];
  for (const candidate of candidates) if (companyDuplicateKey(candidate) === key) return true;
  const rawUrls = [record.url, record.original_url, record.resolved_url, record.apply_url, record.canonical_url];
  for (const raw of rawUrls) {
    try {
      const url = new URL(raw);
      const parts = url.pathname.split('/').filter(Boolean);
      const providerTenant = /(?:ashbyhq\.com|lever\.co)$/.test(url.hostname) ? parts[0]
        : /greenhouse\.io$/.test(url.hostname) ? parts[0]
          : /smartrecruiters\.com$/.test(url.hostname) ? parts[0]
            : /\.myworkdayjobs\.com$/.test(url.hostname) ? url.hostname.split('.')[0]
              : /personio\./.test(url.hostname) ? url.hostname.split('.')[0] : null;
      if (providerTenant && companyDuplicateKey(providerTenant) === key) return true;
    } catch { /* a candidate may have a non-URL alias */ }
  }
  return false;
}

function displayedCompany(group, runCandidates, mappings) {
  const rowCompany = group.rows.find((row) => row.company)?.company ?? '';
  const records = allGroupRecords(group, runCandidates, mappings);
  const alternate = records.find((record) => tenantSlugMatches(rowCompany, record) && record.company
    && String(record.company).trim().toLocaleLowerCase() !== String(rowCompany).trim().toLocaleLowerCase());
  return alternate?.company ?? rowCompany;
}

function reportFields(report) {
  const summary = report?.summary ?? {};
  return {
    country: summary.location_country ?? '',
    fit: summary.fit_score ?? null,
  };
}

function candidateIdsForGroup(group, mappings) {
  const ids = new Set(group.ids ?? []);
  for (const id of [...ids]) for (const equivalent of mappings.equivalent.get(id) ?? []) ids.add(equivalent);
  return ids;
}

function livenessForGroup(group, livenessById, mappings, report, runCandidates) {
  let latest = null;
  for (const id of candidateIdsForGroup(group, mappings)) {
    const entry = livenessById.get(id);
    if (entry && (!latest || entry.checkedAtMs > latest.checkedAtMs)) latest = entry;
  }
  if (latest) return { liveness_status: latest.status ?? null, liveness_date: dateValue(latest.checked_at) };

  const records = allGroupRecords(group, runCandidates, mappings)
    .filter((record) => typeof record.liveness_status === 'string')
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  return {
    liveness_status: typeof report?.summary?.liveness === 'string' ? report.summary.liveness : records[0]?.liveness_status ?? null,
    liveness_date: null,
  };
}

function groupTextMatches(group, companyKey, roleKey) {
  if (!companyKey || !roleKey) return false;
  return group.rows.some((row) => companyDuplicateKey(row.company) === companyKey
    && roleDuplicateKey(row.role) === roleKey);
}

function groupRowsText(group) {
  return group.rows.map((row) => `#${row.num}`).join(', ');
}

function notesLastSegment(notes) {
  const parts = String(notes ?? '').split(/\s*(?:;|\|)\s*/).filter(Boolean);
  return parts.at(-1) ?? '';
}

function groupHasClosedRow(group, states) {
  return group.rows.some((row) => CLOSED_STATUSES.has(resolveCanonicalState(row.status, states)));
}

// Rows that concern the current report's requisition: the report itself, a report linked to it by
// Supersedes, or an equivalent candidate ID. Returns null when the current report carries no usable
// candidate ID, so the caller falls back to whole-group status.
function rowsForCurrentRequisition(group, currentReport, reportIndex, mappings) {
  const id = currentReport?.candidateId;
  if (!id || mappings?.ambiguous?.has(id)) return null;
  const sameId = new Set([id, ...(mappings?.equivalent?.get(id) ?? [])]);
  const linkedReports = new Set([currentReport.number]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [number, report] of reportIndex) {
      const edge = report.supersedes;
      if (edge == null) continue;
      if (linkedReports.has(number) !== linkedReports.has(edge)) {
        linkedReports.add(number); linkedReports.add(edge); changed = true;
      }
    }
  }
  // Candidate IDs of every report in the Supersedes component belong to the same requisition.
  for (const number of linkedReports) {
    const linkedId = reportIndex.get(number)?.candidateId;
    if (!linkedId || mappings?.ambiguous?.has(linkedId)) continue;
    sameId.add(linkedId);
    for (const other of mappings?.equivalent?.get(linkedId) ?? []) sameId.add(other);
  }
  const rows = group.rows.filter((row) => {
    const identity = rowIdentity(row, reportIndex, mappings);
    return identity.reports.some((number) => linkedReports.has(number))
      || [...identity.ids].some((rowId) => sameId.has(rowId)
        || [...(mappings?.equivalent?.get(rowId) ?? [])].some((other) => sameId.has(other)));
  });
  return rows.length ? rows : null;
}

function serializeGroup(group) {
  return {
    rows: group.rows.map((row) => ({ num: row.num, date: row.date, company: row.company, role: row.role, status: row.status, report: row.report, reportLinks: row.reportLinks ?? [], notes: row.notes })),
    ids: [...group.ids].sort(), reports: [...(group.reports ?? [])], open: group.open,
    status: group.status, flags: [...group.flags], possibleDuplicates: group.possibleDuplicates,
  };
}

export function buildWorklist({ root = process.cwd(), now = new Date() } = {}) {
  const absoluteRoot = resolve(root);
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const warnings = [];
  let states = [];
  try { states = loadCanonicalStates(join(absoluteRoot, 'templates', 'states.yml')); }
  catch (error) { warning({ warnings }, `Could not load canonical states: ${error.message}`); }
  const trackerPath = resolveTrackerPath(absoluteRoot);
  const tracker = loadTrackerRows(trackerPath);
  warnings.push(...tracker.warnings);
  const reportsDir = join(absoluteRoot, 'reports');
  const reportIndex = loadReportIndex(reportsDir);
  warnings.push(...reportIndex.warnings);
  const scanRunsDir = join(absoluteRoot, 'output', 'scan-runs');
  const mappings = loadIdentityMappings({ scanRunsDir, correctionsDir: join(absoluteRoot, 'output', 'identity-corrections') });
  warnings.push(...mappings.warnings);
  const runCandidates = loadRunCandidates(scanRunsDir);
  warnings.push(...runCandidates.warnings);
  const groups = groupTrackerRows(tracker.rows, reportIndex, mappings, { states, runCandidates });
  const batches = loadBatches(absoluteRoot, warnings);
  const livenessById = loadLiveness(absoluteRoot, warnings);
  const superseded = new Set([...reportIndex.values()].map((report) => report.supersedes).filter((number) => number != null));

  const openApply = [];
  const review = [];
  const awaitingOutcome = [];
  const dataProblems = [];
  const groupReports = new Set();
  for (const group of groups) {
    for (const report of reportNumbersForGroup(group, reportIndex)) groupReports.add(report);
    const currentReport = bestCurrentReport(group, reportIndex, superseded);
    const fields = reportFields(currentReport);
    const liveness = livenessForGroup(group, livenessById, mappings, currentReport, runCandidates);
    const associatedBatches = linkedBatches(group, batches, mappings);
    const base = {
      tracker_rows: groupRowsText(group), report: currentReport ? basename(currentReport.file) : '',
      report_number: currentReport?.number ?? null, company: displayedCompany(group, runCandidates, mappings),
      role: currentReport?.summary?.role ?? group.rows[0]?.role ?? '', country: fields.country,
      fit: fields.fit, flags: [...new Set([
        ...group.flags,
        ...(Array.isArray(currentReport?.summary?.flags) ? currentReport.summary.flags.map((flag) => typeof flag === 'string' ? flag : flag?.code).filter(Boolean) : []),
        ...(Array.isArray(currentReport?.summary?.prescreen?.flags) ? currentReport.summary.prescreen.flags.map((flag) => typeof flag === 'string' ? flag : flag?.code).filter(Boolean) : []),
      ])], liveness_status: liveness.liveness_status, liveness_date: liveness.liveness_date,
      age_days: daysSince(liveness.liveness_date, timestamp),
      batch: associatedBatches[0] ? { id: associatedBatches[0].batch_id, state: associatedBatches[0].state } : null,
      possibleDuplicates: group.possibleDuplicates,
    };
    // A row can hold an older, closed requisition next to a newer live one (one tracker row per
    // company+role). Decide openness from the rows of the current report's requisition only.
    const currentRows = rowsForCurrentRequisition(group, currentReport, reportIndex, mappings);
    const groupOpen = group.open && !groupHasClosedRow(group, states);
    const open = currentRows
      ? currentRows.every((row) => resolveCanonicalState(row.status, states) === 'Evaluated')
      : groupOpen;
    if (open && !groupOpen) base.flags = [...new Set([...base.flags, 'closed_older_requisition'])];
    if (open && currentReport?.action === 'apply') openApply.push(base);
    if (open && currentReport?.action === 'review') review.push(base);
    if (group.status === 'Applied') {
      const appliedRows = group.rows.filter((row) => resolveCanonicalState(row.status, states) === 'Applied');
      const appliedDate = appliedRows.map((row) => dateValue(row.date)).filter(Boolean).sort().at(-1) ?? null;
      const lastNotes = notesLastSegment(appliedRows.at(-1)?.notes ?? group.rows.at(-1)?.notes);
      awaitingOutcome.push({ tracker_rows: groupRowsText(group), company: base.company, role: base.role,
        applied_date: appliedDate, age_days: daysSince(appliedDate, timestamp), last_notes: lastNotes, flags: [...group.flags] });
    }

    const notesActionProblems = [];
    const action = currentReport?.action ?? null;
    for (const row of group.rows) {
      if (action && /\bAPPLY\b/i.test(row.notes ?? '') && action !== 'apply') notesActionProblems.push({ row: row.num, note: 'APPLY', action });
      if (action && /\bSKIP\b/i.test(row.notes ?? '') && action !== 'skip') notesActionProblems.push({ row: row.num, note: 'SKIP', action });
    }
    if (group.rows.length > 1 || group.flags.length || group.possibleDuplicates.length || notesActionProblems.length) {
      dataProblems.push({ type: 'tracker_group', tracker_rows: groupRowsText(group), company: base.company,
        role: base.role, status: group.status, flags: [...group.flags], possibleDuplicates: group.possibleDuplicates,
        notes_action_conflicts: notesActionProblems });
    }
  }

  const inProgress = [];
  for (const batch of batches) {
    if (!IN_PROGRESS_STATES.has(batch.state)) continue;
    const matchedGroups = groups.filter((group) => [...group.ids].some((id) => id === batch.candidate_id
      || (mappings.equivalent.get(batch.candidate_id) ?? new Set()).has(id)));
    let match = 'id';
    let group = null;
    if (matchedGroups.length) {
      if (!matchedGroups.some((entry) => entry.open)) continue;
      group = matchedGroups.find((entry) => entry.open) ?? null;
      if (group && groupHasClosedRow(group, states)) continue;
    } else {
      const companyKey = companyDuplicateKey(batch.company);
      const roleKey = roleDuplicateKey(batch.title);
      const textGroups = groups.filter((candidate) => groupTextMatches(candidate, companyKey, roleKey));
      if (textGroups.length === 1) {
        match = 'text';
        group = textGroups[0];
        if (!group.open || groupHasClosedRow(group, states)) continue;
      } else {
        match = textGroups.length > 1 ? 'ambiguous' : 'none';
      }
    }
    inProgress.push({ batch_id: batch.batch_id, candidate_id: batch.candidate_id, state: batch.state,
      match, group_status: group?.status ?? null,
      company: batch.company || (group ? displayedCompany(group, runCandidates, mappings) : ''),
      role: batch.title || group?.rows[0]?.role || '', tracker_rows: group ? groupRowsText(group) : '',
      open_tracker_group: Boolean(group) });
  }
  for (const [number, report] of reportIndex) {
    if (!groupReports.has(number)) dataProblems.push({ type: 'report_without_tracker', report: basename(report.file), report_number: number });
  }
  for (const message of warnings) dataProblems.push({ type: 'warning', message });
  const sections = { openApply, awaitingOutcome, inProgress, review, dataProblems };
  return {
    generated_at: timestamp,
    tracker: relative(absoluteRoot, trackerPath).replace(/\\/g, '/'),
    sections,
    groups: groups.map(serializeGroup),
    warnings,
  };
}

function cell(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '&#124;').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
}

function table(lines, headers, rows) {
  lines.push(`| ${headers.map(cell).join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
  if (!rows.length) lines.push(`| ${headers.map((_, index) => index === 0 ? 'None' : '').join(' | ')} |`);
  lines.push('');
}

export function renderWorklist(worklist) {
  const sections = worklist?.sections ?? {};
  const lines = ['# Open worklist', '', `Generated ${cell(worklist?.generated_at ?? '')} from \`${cell(worklist?.tracker ?? '')}\`.`, ''];
  lines.push(`## Open Apply (${(sections.openApply ?? []).length})`, '');
  table(lines, ['Tracker rows', 'Report', 'Company', 'Role', 'Country', 'Fit', 'Flags', 'Liveness status', 'Liveness date', 'Age days', 'Batch', 'Possible duplicates'],
    (sections.openApply ?? []).map((row) => [row.tracker_rows, row.report, row.company, row.role, row.country, row.fit,
      row.flags.join(', '), row.liveness_status, row.liveness_date, row.age_days, row.batch ? `${row.batch.id}: ${row.batch.state}` : '', JSON.stringify(row.possibleDuplicates)]));
  lines.push(`## Awaiting outcome (${(sections.awaitingOutcome ?? []).length})`, '');
  table(lines, ['Tracker rows', 'Company', 'Role', 'Applied date', 'Age days', 'Last Notes segment', 'Flags'],
    (sections.awaitingOutcome ?? []).map((row) => [row.tracker_rows, row.company, row.role, row.applied_date, row.age_days, row.last_notes, row.flags.join(', ')]));
  lines.push(`## In progress (${(sections.inProgress ?? []).length})`, '');
  table(lines, ['Batch', 'Candidate ID', 'State', 'Match', 'Company', 'Role', 'Tracker rows', 'Group status'],
    (sections.inProgress ?? []).map((row) => [row.batch_id, row.candidate_id, row.state, row.match, row.company, row.role, row.tracker_rows, row.group_status]));
  lines.push(`## Review (${(sections.review ?? []).length})`, '');
  table(lines, ['Tracker rows', 'Report', 'Company', 'Role', 'Country', 'Fit', 'Flags', 'Liveness status', 'Liveness date', 'Age days', 'Batch', 'Possible duplicates'],
    (sections.review ?? []).map((row) => [row.tracker_rows, row.report, row.company, row.role, row.country, row.fit,
      row.flags.join(', '), row.liveness_status, row.liveness_date, row.age_days, row.batch ? `${row.batch.id}: ${row.batch.state}` : '', JSON.stringify(row.possibleDuplicates)]));
  lines.push(`## Data problems (${(sections.dataProblems ?? []).length})`, '');
  table(lines, ['Type', 'Tracker rows', 'Report', 'Company', 'Role', 'Status', 'Flags', 'Details'],
    (sections.dataProblems ?? []).map((row) => [row.type, row.tracker_rows, row.report ?? '', row.company ?? '', row.role ?? '', row.status ?? '',
      row.flags?.join(', ') ?? '', row.message ?? JSON.stringify(row.possibleDuplicates ?? row.notes_action_conflicts ?? '')]));
  return lines.join('\n');
}

function parseArgs(args) {
  const options = { root: process.cwd(), json: false, out: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--root' || arg === '--out') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; return; }
  const root = resolve(options.root);
  const result = buildWorklist({ root });
  const markdown = renderWorklist(result);
  if (options.out) {
    const out = resolve(root, options.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, markdown, 'utf8');
  }
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (!options.out) process.stdout.write(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
