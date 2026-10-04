#!/usr/bin/env node

/**
 * set-status.mjs — canonical CLI to update a tracker row's status/note (#1428).
 *
 * data/applications.md is a shared surface with multiple readers and writers.
 * One canonical write path is safer than N agents hand-editing markdown, so
 * modes (apply Step 9, followup, batch) call this instead of editing the table.
 *
 * Usage:
 *   node set-status.mjs <report#|company> <state> [--note "..."] [--role "..."] [--dry-run] [--json]
 *
 * Row resolution:
 *   - numeric argument → exact match on the # column
 *   - otherwise → company match (normalized, same key as merge-tracker dedup);
 *     multiple hits are narrowed with --role (fuzzy, role-matcher.mjs), and
 *     anything still ambiguous fails with a numbered candidate list.
 *
 * State validation is strict against templates/states.yml (labels, ids, and
 * aliases resolve to the canonical label; anything else is rejected before the
 * tracker is touched). --note appends to the Notes cell with "; " and is
 * idempotent — re-running the same command is always safe.
 *
 * The read-modify-write runs under the shared tracker lock (tracker-utils.mjs,
 * same lock as merge-tracker.mjs) and the file is replaced atomically. Only the
 * Status and Notes cells of the matched row change; every other byte of the
 * tracker round-trips untouched.
 *
 * Exit codes: 0 success (including no-op re-runs) · 1 usage error,
 * non-canonical state, unreadable states.yml, or non-retryable lock/write failure ·
 * 2 row not found or unreadable tracker · 3 ambiguous company match ·
 * 4 tracker lock timeout (busy — retry later).
 *
 * When the new status is Applied, the JSON output carries
 * `"followupSeedCandidate": true` — the hook point for seeding
 * data/follow-ups.md with the default cadence (#1430, not implemented here).
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveColumns, parseTrackerRow, normalizeTextKey } from './tracker-parse.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { assertPreflightConfirmed, loadBatchState } from './application-batch.mjs';
import {
  rebuildRow, resolveTrackerPath, trackerLockDirFor, acquireTrackerLock,
  writeFileAtomic, loadCanonicalStates, resolveCanonicalState, normalizeCompany, cell,
} from './tracker-utils.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const STATES_FILE = join(CAREER_OPS, 'templates/states.yml');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NOT_FOUND = 2;
const EXIT_AMBIGUOUS = 3;
const EXIT_LOCK_TIMEOUT = 4;

const USAGE = `Usage: node set-status.mjs <row#|company> <state> [--note "..."] [--role "..."] [--dry-run] [--json]
       node set-status.mjs --row N <state> [...]
       node set-status.mjs --report N <state> [...]

  <row#|company>     Legacy selector: tracker # or company name
  <state>            Canonical state from templates/states.yml (aliases accepted)
  --row N            Select an exact tracker row ID
  --report N         Select the row linking an exact report ID
  --note "..."       Append to the Notes cell ("; "-separated, idempotent)
  --role "..."       Disambiguate when several rows share the company (fuzzy match)
  --dry-run          Resolve and validate, but write nothing
  --json             Machine-readable output on stdout (errors included)

Applied is gated. Do not invoke it directly; application-submission.mjs supplies
the internal --application-manifest, --candidate-id, and --submission-event proof.`;

// ── argument parsing ─────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const positional = [];
const flags = {
  note: null, role: null, dryRun: false, json: false,
  row: null, report: null,
  applicationManifest: null, candidateId: null, submissionEvent: null,
};

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (['--note', '--role', '--row', '--report', '--application-manifest', '--candidate-id', '--submission-event'].includes(a)) {
    // Never consume a following flag as the value: "--note --dry-run" would
    // silently disable dry-run and turn a preview into a real write.
    const value = rawArgs[i + 1];
    if (value === undefined || value.startsWith('--')) {
      failUsage(`Missing value for ${a}`);
    }
    const key = {
      '--note': 'note',
      '--role': 'role',
      '--row': 'row',
      '--report': 'report',
      '--application-manifest': 'applicationManifest',
      '--candidate-id': 'candidateId',
      '--submission-event': 'submissionEvent',
    }[a];
    if (flags[key] != null) failUsage(`Duplicate option: ${a}`);
    if ((a === '--row' || a === '--report') && !/^\d+$/.test(value)) {
      failUsage(`${a} expects a positive integer, got "${value}"`);
    }
    flags[key] = value;
    i++;
  }
  else if (a === '--dry-run') { flags.dryRun = true; }
  else if (a === '--json') { flags.json = true; }
  else if (a.startsWith('--')) { failUsage(`Unknown flag: ${a}`); }
  else { positional.push(a); }
}

if (flags.row !== null && flags.report !== null) {
  failUsage('--row and --report are mutually exclusive');
}
const explicitSelector = flags.row !== null || flags.report !== null;
if ((explicitSelector && positional.length !== 1) || (!explicitSelector && positional.length !== 2)) {
  failUsage(explicitSelector
    ? `With ${flags.row !== null ? '--row' : '--report'}, provide only the state`
    : (positional.length === 0 ? null : `Expected 2 arguments (selector, state), got ${positional.length}`));
}

const selector = explicitSelector ? null : positional[0];
const stateInput = explicitSelector ? positional[0] : positional[1];
const isBareNumericSelector = selector !== null && /^\d+$/.test(selector);

/**
 * Emit a structured error and exit.
 *
 * With --json the error object goes to stdout so callers parse one stream; the
 * human-readable message always goes to stderr.
 *
 * @param {number} exitCode - Process exit code (see EXIT_* contract above).
 * @param {string} code - Stable machine-readable error code.
 * @param {string} message - Human-readable explanation.
 * @param {object} [extra] - Extra JSON fields (e.g. candidates).
 * @returns {never}
 */
function failWith(exitCode, code, message, extra = {}) {
  if (flags.json) {
    console.log(JSON.stringify({ error: message, code, ...extra }));
  }
  console.error(`❌ ${message}`);
  process.exit(exitCode);
}

/**
 * Print usage (plus an optional specific complaint) and exit 1.
 *
 * With --json a structured usage-error payload goes to stdout (same shape as
 * failWith) so machine callers always parse one stream. failUsage can fire
 * mid-argv-parse — before flags.json is settled — so JSON mode is detected
 * from the raw argv directly.
 *
 * @param {string|null} message - What was wrong with the invocation, if known.
 * @returns {never}
 */
function failUsage(message) {
  const msg = message ?? 'Expected 2 arguments: <report#|company> <state>';
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify({ error: msg, code: 'usage' }));
    console.error(`❌ ${msg}`);
  } else {
    if (message) console.error(`❌ ${message}\n`);
    console.error(USAGE);
  }
  process.exit(EXIT_USAGE);
}

// ── state validation (before anything touches the tracker) ──────

let states;
try {
  states = loadCanonicalStates(STATES_FILE);
} catch (err) {
  failWith(EXIT_USAGE, 'states-error', `Cannot load canonical states from ${STATES_FILE}: ${err.message}`);
}
const newStatus = resolveCanonicalState(stateInput, states);
if (!newStatus) {
  const valid = states.map(s => s.label).join(' · ');
  failWith(EXIT_USAGE, 'invalid-state', `"${stateInput}" is not a canonical state. Valid states: ${valid}`);
}

// ── tracker access ───────────────────────────────────────────────

const APPS_FILE = resolveTrackerPath(CAREER_OPS);
if (!existsSync(APPS_FILE)) {
  failWith(EXIT_NOT_FOUND, 'no-tracker', `No tracker found at ${APPS_FILE}`);
}

/**
 * Find the tracker row matching the CLI selector.
 *
 * @param {object[]} rows - Parsed data rows (parseTrackerRow output + lineIdx).
 * @returns {object} The single matched row. Exits the process on 0 or 2+ matches.
 */
function resolveRow(rows) {
  const narrow = (matches, notFound, ambiguous) => {
    if (matches.length > 1 && flags.role) {
      const narrowed = matches.filter((row) => roleFuzzyMatch(row.role, flags.role)
        || String(row.role).trim().toLowerCase() === String(flags.role).trim().toLowerCase());
      if (narrowed.length === 1) return narrowed[0];
    }
    if (matches.length === 0) failWith(EXIT_NOT_FOUND, 'not-found', notFound);
    if (matches.length > 1) {
      const candidates = matches.map((row) => ({ num: row.num, company: row.company, role: row.role }));
      failWith(EXIT_AMBIGUOUS, 'ambiguous', `${ambiguous}\n${candidates.map((row) => `#${row.num}\t${row.company}\t${row.role}`).join('\n')}`, { candidates });
    }
    return matches[0];
  };

  if (flags.report !== null) {
    const report = Number(flags.report);
    return narrow(
      rows.filter((row) => extractTrackerReportNumbers(row.report).includes(report)),
      `No tracker row links report #${report}`,
      `Report #${report} is linked by multiple tracker rows; pass --role to disambiguate:`,
    );
  }

  if (flags.row !== null || isBareNumericSelector) {
    const num = Number(flags.row ?? selector);
    return narrow(
      rows.filter((row) => row.num === num),
      `No tracker row with #${num}`,
      `Tracker #${num} is duplicated; pass --role to disambiguate:`,
    );
  }

  const key = normalizeCompany(selector);
  if (!key) failUsage(`Selector "${selector}" is empty after normalization`);
  let matches = rows.filter(r => normalizeCompany(r.company) === key);

  if (matches.length === 0) {
    failWith(EXIT_NOT_FOUND, 'not-found', `No tracker row with company matching "${selector}"`);
  }
  if (matches.length > 1 && flags.role) {
    const narrowed = matches.filter(r => roleFuzzyMatch(r.role, flags.role));
    if (narrowed.length === 1) return narrowed[0];
    // Fall through with the original list so the candidates stay visible.
  }
  if (matches.length > 1) {
    const candidates = matches.map(r => ({ num: r.num, company: r.company, role: r.role }));
    const listing = candidates.map(c => `#${c.num}\t${c.company}\t${c.role}`).join('\n');
    failWith(EXIT_AMBIGUOUS, 'ambiguous',
      `Company "${selector}" matches ${matches.length} rows — pass the # or narrow with --role:\n${listing}`,
      { candidates });
  }
  return matches[0];
}

function extractTrackerReportNumbers(report) {
  const values = new Set();
  const text = String(report ?? '');
  for (const match of text.matchAll(/\[(\d+)\]/g)) values.add(Number(match[1]));
  for (const match of text.matchAll(/(?:^|[\\/])(\d{1,9})(?:[-_.]|$)/g)) values.add(Number(match[1]));
  return [...values];
}

// ── locked read-modify-write ─────────────────────────────────────

// Dry-run never writes, so it must not hold the exclusive lock: a read-only
// preview should not block (or be blocked by) merge-tracker or another
// set-status writer. A stale read is acceptable for a preview.
let lock = null;
if (!flags.dryRun) {
  try {
    lock = await acquireTrackerLock(trackerLockDirFor(APPS_FILE), {
      timeoutMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000,
      retryMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75,
      staleMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || 10 * 60_000,
      tracker: APPS_FILE,
    });
  } catch (err) {
    // Exit 4 means "lock is busy — retry later" and must stay reserved for
    // the actual timeout. Filesystem/configuration failures (EACCES on the
    // lock dir, unwritable owner.json, …) are not retryable and fail as a
    // config error instead.
    if (err?.code === 'LOCK_TIMEOUT') {
      failWith(EXIT_LOCK_TIMEOUT, 'lock-timeout', err.message);
    }
    failWith(EXIT_USAGE, 'lock-error', `Cannot acquire tracker lock: ${err.message}`);
  }
}
// Safety net: failWith/failUsage/resolveRow call process.exit() directly and
// skip the explicit release below. release() is idempotent, so both firing
// on the happy path is fine.
if (lock) process.once('exit', () => lock.release());

let content;
try {
  content = readFileSync(APPS_FILE, 'utf-8');
} catch (err) {
  failWith(EXIT_NOT_FOUND, 'read-failure', `Cannot read tracker at ${APPS_FILE}: ${err.message}`);
}
const lines = content.split('\n');
const colmap = resolveColumns(lines);

const rows = [];
for (let i = 0; i < lines.length; i++) {
  const row = parseTrackerRow(lines[i], colmap);
  if (row) rows.push({ ...row, lineIdx: i });
}
if (rows.length === 0) {
  failWith(EXIT_NOT_FOUND, 'empty-tracker', `Tracker at ${APPS_FILE} has no data rows`);
}

const target = resolveRow(rows);
if (isBareNumericSelector) {
  const reportNumbers = extractTrackerReportNumbers(target.report);
  const number = Number(selector);
  if (reportNumbers.some((report) => report !== number)) {
    failWith(EXIT_AMBIGUOUS, 'report-number-mismatch',
      `Tracker #${number} links report ${reportNumbers.map((report) => `#${report}`).join(', ')}; use --row ${number} or --report N`);
  }
  if (reportNumbers.length === 0) {
    const linkers = rows.filter((row) => row !== target && extractTrackerReportNumbers(row.report).includes(number));
    if (linkers.length > 0) {
      failWith(EXIT_AMBIGUOUS, 'report-number-ambiguous',
        `"${number}" names a report-less tracker row and report #${number}; use --row ${number} or --report ${number}`,
        { linkedBy: linkers.map((row) => ({ num: row.num, company: row.company, role: row.role })) });
    }
  }
}
if (flags.role && !(roleFuzzyMatch(target.role, flags.role)
    || String(target.role).trim().toLowerCase() === String(flags.role).trim().toLowerCase())) {
  failWith(EXIT_NOT_FOUND, 'role-mismatch', `Selected row role "${target.role}" does not match --role "${flags.role}"`);
}
const oldStatus = target.status;
const note = flags.note != null ? cell(flags.note) : null;

if (newStatus === 'Applied') {
  if (!flags.applicationManifest || !flags.candidateId || !flags.submissionEvent) {
    failWith(EXIT_USAGE, 'applied-confirmation-required',
      'Applied status requires an application-batch submission confirmation; use application-submission.mjs');
  }
  const exactRowSelector = flags.row !== null ? Number(flags.row) : (isBareNumericSelector ? Number(selector) : null);
  if (exactRowSelector !== target.num) {
    failWith(EXIT_USAGE, 'exact-tracker-row-required', 'Applied status requires the exact numeric tracker row selector');
  }
  try {
    const applicationRoot = process.env.CAREER_OPS_APPLICATION_ROOT || CAREER_OPS;
    const loaded = loadBatchState(flags.applicationManifest, { root: applicationRoot });
    assertPreflightConfirmed(loaded.manifest, loaded.state, {
      root: applicationRoot, requireCv: true, requireCoverLetter: true,
    });
    const manifestCandidate = loaded.manifest.candidates.find((candidate) => candidate.candidate_id === flags.candidateId);
    const candidateState = loaded.state.candidates.find((candidate) => candidate.candidate_id === flags.candidateId);
    if (!manifestCandidate || !candidateState) throw new Error('Candidate is not in the supplied application batch');
    const submission = candidateState.submission;
    if (candidateState.state !== 'form_prepared' || !candidateState.formPreparation?.reviewComplete
        || candidateState.formPreparation?.finalAction?.activated !== false
        || submission?.status !== 'confirmed_pending_tracker'
        || submission.eventId !== flags.submissionEvent || submission.trackerPath !== APPS_FILE
        || submission.trackerRow !== target.num
        || submission.scopeHash !== `sha256:${String(submission.eventId || '').replace(/^submission_v1_/, '')}`) {
      throw new Error('Submission proof is missing, mismatched, or not pending for this exact tracker row');
    }
    if (normalizeCompany(manifestCandidate.company) !== normalizeCompany(target.company)
        || normalizeTextKey(manifestCandidate.title) !== normalizeTextKey(target.role)) {
      throw new Error('Tracker company/role does not exactly match the confirmed manifest candidate');
    }
  } catch (error) {
    failWith(EXIT_USAGE, 'invalid-submission-proof', error.message);
  }
}

// Rebuild only the matched line: change the Status cell, append the note, keep
// every other cell exactly as parsed.
const parts = lines[target.lineIdx].split('|').map(s => s.trim());
while (parts.length <= Math.max(colmap.status, colmap.notes ?? 0)) parts.push('');

const statusChanged = parts[colmap.status] !== newStatus;
parts[colmap.status] = newStatus;

let noteChanged = false;
if (note) {
  if (colmap.notes == null) {
    failWith(EXIT_USAGE, 'no-notes-column', 'Tracker has no Notes column — cannot apply --note');
  }
  const existing = parts[colmap.notes] ?? '';
  // Delimiter-aware idempotency: the note counts as already present only when
  // it appears as a whole "; "-delimited entry (or as the entire field) — a
  // bare substring of a longer entry ("sent" inside "sent CV") must not
  // suppress a genuinely new note. Matching the full note text at entry
  // boundaries (instead of splitting the field into segments) keeps retries
  // idempotent even when the note itself contains "; ".
  const hasNote = existing === note
    || existing.startsWith(`${note}; `)
    || existing.endsWith(`; ${note}`)
    || existing.includes(`; ${note}; `);
  if (!hasNote) {
    parts[colmap.notes] = existing && existing !== '—' && existing !== '-' ? `${existing}; ${note}` : note;
    noteChanged = true;
  }
}

const changed = statusChanged || noteChanged;

if (changed && !flags.dryRun) {
  lines[target.lineIdx] = rebuildRow(parts);
  try {
    writeFileAtomic(APPS_FILE, lines.join('\n'));
  } catch (err) {
    // Same structured error contract as every other failure path — a raw
    // stack trace on stdout/stderr would break --json consumers.
    failWith(EXIT_USAGE, 'write-failure', `Cannot write tracker at ${APPS_FILE}: ${err.message}`);
  }
}
lock?.release();

// ── report ───────────────────────────────────────────────────────

const result = {
  changed,
  num: target.num,
  company: target.company,
  role: target.role,
  oldStatus,
  newStatus,
  ...(note != null ? { note } : {}),
  ...(flags.dryRun ? { dryRun: true } : {}),
  // Fire the #1430 hook only on an actual transition INTO Applied — an
  // idempotent re-run of an already-Applied row must not invite a consumer
  // to seed a duplicate follow-up.
  ...(statusChanged && newStatus === 'Applied' ? { followupSeedCandidate: true } : {}),
  tracker: APPS_FILE,
};

if (flags.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const verb = flags.dryRun ? 'would set' : changed ? 'set' : 'already';
  console.log(`✅ #${target.num} ${target.company} — ${target.role}: ${verb} ${oldStatus} → ${newStatus}${note ? ` (note: ${note})` : ''}`);
  if (statusChanged && !flags.dryRun && newStatus === 'Applied') {
    console.error('ℹ️  Status is Applied — consider seeding follow-ups in data/follow-ups.md (#1430: node followup-cadence.mjs)');
  }
}
process.exit(EXIT_OK);
