#!/usr/bin/env node

/**
 * Record a submission that the user explicitly says they completed manually.
 *
 * This is deliberately separate from application-submission.mjs. It mutates
 * only the tracker and never attests that the automated executor prepared or
 * submitted a form.
 */

import { existsSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  acquireTrackerLock,
  cell,
  loadCanonicalStates,
  normalizeCompany,
  rebuildRow,
  resolveCanonicalState,
  resolveTrackerPath,
  trackerLockDirFor,
  writeFileAtomic,
} from './tracker-utils.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { groupTrackerRows, loadIdentityMappings, loadReportIndex } from './tracker-identity.mjs';

export const MANUAL_SUBMISSION_SOURCE = 'Source: user-confirmed manual submission';

export class ManualApplicationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ManualApplicationError';
    this.code = code;
    this.details = details;
  }
}

function normalizeRole(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function localDate(now) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ManualApplicationError('invalid-date', `Invalid date "${value}"; expected YYYY-MM-DD`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new ManualApplicationError('invalid-date', `Invalid calendar date "${value}"`);
  }
  return value;
}

function hasDelimitedNote(existing, note) {
  return existing === note
    || existing.startsWith(`${note}; `)
    || existing.endsWith(`; ${note}`)
    || existing.includes(`; ${note}; `);
}

function parseRows(lines, colmap) {
  const rows = [];
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const row = parseTrackerRow(lines[lineIdx], colmap);
    if (row) rows.push({ ...row, lineIdx });
  }
  return rows;
}

function resolveTarget(rows, company, role) {
  const companyKey = normalizeCompany(company);
  const companyMatches = rows.filter((row) => normalizeCompany(row.company) === companyKey);

  if (!role) {
    if (companyMatches.length === 1) return companyMatches[0];
    if (companyMatches.length > 1) {
      throw new ManualApplicationError(
        'ambiguous',
        `Company "${company}" matches multiple roles; provide the exact role`,
        { candidates: companyMatches.map(({ num, company: rowCompany, role: rowRole }) => ({
          num, company: rowCompany, role: rowRole,
        })) },
      );
    }
    throw new ManualApplicationError(
      'role-required',
      `Role is required to create a new tracker entry for "${company}"`,
    );
  }

  const roleKey = normalizeRole(role);
  const exact = companyMatches.filter((row) => normalizeRole(row.role) === roleKey);
  if (exact.length > 1) {
    throw new ManualApplicationError(
      'duplicate-existing',
      `Multiple tracker rows already match "${company}" — "${role}"; resolve the existing duplicates first`,
      { candidates: exact.map(({ num, company: rowCompany, role: rowRole }) => ({
        num, company: rowCompany, role: rowRole,
      })) },
    );
  }
  return exact[0] ?? null;
}

function reportNumbers(value) {
  const numbers = new Set();
  for (const match of String(value ?? '').matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    const label = /^\d+$/.test(match[1].trim()) ? Number(match[1].trim()) : null;
    const target = match[2].trim().replace(/^<|>$/g, '');
    const file = basename(target.split(/[?#]/)[0]);
    const leading = file.match(/^(\d+)(?:[-_.]|$)/);
    const number = leading && /\.md(?:[?#].*)?$/i.test(target) ? Number(leading[1]) : null;
    // Conflicting labels and filenames must never select a row for mutation.
    if (label != null && number != null && label !== number) return [];
    if (label != null || number != null) numbers.add(label ?? number);
  }
  return [...numbers];
}

function resolveExplicitTarget(rows, options, company, role) {
  if (options.row != null && options.report != null) {
    throw new ManualApplicationError('usage', '--row and --report are mutually exclusive');
  }
  if (options.row == null && options.report == null) return resolveTarget(rows, company, role);

  const selector = options.row ?? options.report;
  if (!/^\d+$/.test(String(selector)) || !Number.isSafeInteger(Number(selector))) {
    throw new ManualApplicationError('usage', `${options.row != null ? '--row' : '--report'} expects a positive integer`);
  }
  const number = Number(selector);
  const matches = rows.filter((row) => options.row != null
    ? row.num === number
    : reportNumbers(row.report).includes(number));
  if (!matches.length) {
    const label = options.row != null ? `tracker row #${number}` : `report #${number}`;
    throw new ManualApplicationError('not-found', `No tracker row matches ${label}`);
  }
  if (matches.length > 1) {
    throw new ManualApplicationError('ambiguous', `Selector #${number} matches multiple tracker rows`, {
      candidates: matches.map(({ num, company: rowCompany, role: rowRole }) => ({ num, company: rowCompany, role: rowRole })),
    });
  }
  const [target] = matches;
  if (company && normalizeCompany(company) !== normalizeCompany(target.company)) {
    throw new ManualApplicationError('selector-mismatch', `Company "${company}" does not match selected tracker row #${target.num} (${target.company})`);
  }
  if (role && normalizeRole(role) !== normalizeRole(target.role)) {
    throw new ManualApplicationError('selector-mismatch', `Role "${role}" does not match selected tracker row #${target.num} (${target.role})`);
  }
  return target;
}

function identityGroupForRows(rows, trackerPath, rootOverride, states) {
  const trackerDir = dirname(trackerPath);
  const projectRoot = rootOverride ?? (basename(trackerDir).toLowerCase() === 'data' ? dirname(trackerDir) : trackerDir);
  try {
    const reportIndex = loadReportIndex(join(projectRoot, 'reports'));
    const mappings = loadIdentityMappings({
      scanRunsDir: join(projectRoot, 'output', 'scan-runs'),
      correctionsDir: join(projectRoot, 'output', 'identity-corrections'),
    });
    return groupTrackerRows(rows, reportIndex, mappings, { states });
  } catch {
    return rows.map((row) => ({ rows: [row], ids: new Set(), open: row.status === 'Evaluated', status: row.status, flags: [] }));
  }
}

/**
 * Apply one explicit user-confirmed manual submission to the tracker.
 */
export async function confirmManualApplication(options, dependencies = {}) {
  if (options?.userConfirmed !== true) {
    throw new ManualApplicationError(
      'confirmation-required',
      'Refusing to mark Applied without an explicit user-confirmed manual submission',
    );
  }

  const company = cell(options.company);
  const requestedRole = cell(options.role);
  const hasExplicitSelector = options.row != null || options.report != null;
  if (options.row != null && options.report != null) {
    throw new ManualApplicationError('usage', '--row and --report are mutually exclusive');
  }
  if (!hasExplicitSelector && (!company || !normalizeCompany(company))) {
    throw new ManualApplicationError('company-required', 'Company is required');
  }

  const now = dependencies.now ?? new Date();
  const dateProvided = Boolean(options.date);
  const effectiveDate = validateDate(options.date || localDate(now));
  const root = dependencies.root ?? dirname(fileURLToPath(import.meta.url));
  const trackerPath = dependencies.trackerPath ?? resolveTrackerPath(root);
  if (!existsSync(trackerPath)) {
    throw new ManualApplicationError('no-tracker', `No tracker found at ${trackerPath}`);
  }

  let lock = null;
  if (!options.dryRun) {
    lock = await acquireTrackerLock(trackerLockDirFor(trackerPath), {
      timeoutMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000,
      retryMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75,
      staleMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || 10 * 60_000,
      tracker: trackerPath,
    });
  }

  try {
    const content = readFileSync(trackerPath, 'utf8');
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);
    const colmap = resolveColumns(lines);
    const rows = parseRows(lines, colmap);
    const target = resolveExplicitTarget(rows, options, company, requestedRole);

    if (target) {
      const states = loadCanonicalStates(new URL('./templates/states.yml', import.meta.url));
      const groups = identityGroupForRows(rows, trackerPath, dependencies.root, states);
      const group = groups.find((entry) => entry.rows.some((row) => row.lineIdx === target.lineIdx));
      const siblings = (group?.rows ?? []).filter((row) => row.lineIdx !== target.lineIdx)
        .map((row) => ({ num: row.num, status: row.status }));
      const appliedSiblingStatuses = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected']);
      const blockingSiblings = siblings.filter((row) => appliedSiblingStatuses.has(resolveCanonicalState(row.status, states)));
      if (blockingSiblings.length) {
        return {
          changed: false,
          created: false,
          idempotent: true,
          identityConflict: true,
          num: target.num,
          company: target.company,
          role: target.role,
          oldStatus: target.status,
          newStatus: target.status,
          date: target.date,
          source: 'user-confirmed manual submission',
          blockingSiblings,
          siblings,
          tracker: trackerPath,
          ...(options.dryRun ? { dryRun: true } : {}),
        };
      }
      const parts = lines[target.lineIdx].split('|').map((value) => value.trim());
      const requiredWidth = Math.max(colmap.date ?? 0, colmap.status, colmap.notes ?? 0);
      while (parts.length <= requiredWidth) parts.push('');
      if (colmap.date == null || colmap.notes == null) {
        throw new ManualApplicationError(
          'tracker-columns',
          'Tracker must include Date and Notes columns for manual submission confirmation',
        );
      }

      const sourceAlreadyRecorded = hasDelimitedNote(parts[colmap.notes] ?? '', MANUAL_SUBMISSION_SOURCE);
      const oldStatus = target.status;
      parts[colmap.status] = 'Applied';
      if (dateProvided || oldStatus !== 'Applied' || !sourceAlreadyRecorded) {
        parts[colmap.date] = effectiveDate;
      }
      if (!sourceAlreadyRecorded) {
        const existing = parts[colmap.notes] ?? '';
        parts[colmap.notes] = existing && existing !== '—' && existing !== '-'
          ? `${existing}; ${MANUAL_SUBMISSION_SOURCE}`
          : MANUAL_SUBMISSION_SOURCE;
      }

      const updatedLine = rebuildRow(parts);
      const changed = updatedLine !== lines[target.lineIdx];
      if (changed) lines[target.lineIdx] = updatedLine;
      if (changed && !options.dryRun) writeFileAtomic(trackerPath, lines.join(newline));

      return {
        changed,
        created: false,
        num: target.num,
        company: target.company,
        role: target.role,
        oldStatus,
        newStatus: 'Applied',
        date: parts[colmap.date],
        source: 'user-confirmed manual submission',
        siblings,
        tracker: trackerPath,
        ...(options.dryRun ? { dryRun: true } : {}),
      };
    }

    if (!requestedRole) {
      throw new ManualApplicationError('role-required', 'Role is required to create a new tracker entry');
    }
    if (colmap.date == null || colmap.notes == null || colmap.pdf == null || colmap.report == null) {
      throw new ManualApplicationError(
        'tracker-columns',
        'Tracker must include Date, PDF, Report, and Notes columns to create an entry',
      );
    }

    const maxNum = rows.reduce((max, row) => Math.max(max, row.num), 0);
    const num = maxNum + 1;
    const maxIndex = Math.max(...Object.values(colmap));
    const parts = Array(maxIndex + 1).fill('');
    parts[colmap.num] = String(num);
    parts[colmap.date] = effectiveDate;
    parts[colmap.company] = company;
    parts[colmap.role] = requestedRole;
    parts[colmap.score] = 'N/A';
    parts[colmap.status] = 'Applied';
    parts[colmap.pdf] = '';
    parts[colmap.report] = '';
    parts[colmap.notes] = MANUAL_SUBMISSION_SOURCE;
    const line = rebuildRow(parts);

    const lastDataLine = rows.reduce((max, row) => Math.max(max, row.lineIdx), -1);
    const insertAt = lastDataLine >= 0 ? lastDataLine + 1 : lines.length;
    lines.splice(insertAt, 0, line);
    if (!options.dryRun) writeFileAtomic(trackerPath, lines.join(newline));

    return {
      changed: true,
      created: true,
      num,
      company,
      role: requestedRole,
      oldStatus: null,
      newStatus: 'Applied',
      date: effectiveDate,
      source: 'user-confirmed manual submission',
      siblings: [],
      tracker: trackerPath,
      ...(options.dryRun ? { dryRun: true } : {}),
    };
  } finally {
    lock?.release();
  }
}

export function parseArgs(argv) {
  const options = {
    company: '',
    role: '',
    date: '',
    userConfirmed: false,
    dryRun: false,
    json: false,
    row: null,
    report: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--company') options.company = argv[++index] ?? '';
    else if (arg === '--role') options.role = argv[++index] ?? '';
    else if (arg === '--date') options.date = argv[++index] ?? '';
    else if (arg === '--row' || arg === '--report') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ManualApplicationError('usage', `Missing value for ${arg}`);
      }
      if (!/^\d+$/.test(value)) throw new ManualApplicationError('usage', `${arg} expects a positive integer, got "${value}"`);
      const key = arg.slice(2);
      if (options[key] != null) throw new ManualApplicationError('usage', `Duplicate option: ${arg}`);
      options[key] = value;
      index += 1;
    }
    else if (arg === '--user-confirmed') options.userConfirmed = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else throw new ManualApplicationError('usage', `Unknown argument: ${arg}`);
  }
  if (options.row != null && options.report != null) {
    throw new ManualApplicationError('usage', '--row and --report are mutually exclusive');
  }
  return options;
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url).toLowerCase() === fileURLToPath(new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`)).toLowerCase();

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await confirmManualApplication(options);
    if (!options.json) {
      const siblings = (result.siblings ?? []).map((row) => `#${row.num} (${row.status})`).join(', ') || 'none';
      const blocked = result.blockingSiblings?.length
        ? `; already applied by ${result.blockingSiblings.map((row) => `#${row.num} (${row.status})`).join(', ')}`
        : '';
      console.log(`Identity siblings: ${siblings}${blocked}`);
    }
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (result.identityConflict) {
      const blockers = result.blockingSiblings.map((row) => `#${row.num} (${row.status})`).join(', ');
      console.log(`Identity conflict: #${result.num} ${result.company} — ${result.role} remains ${result.newStatus}; confirmation blocked by sibling(s) ${blockers}`);
    } else {
      const verb = result.created ? 'created and marked' : result.changed ? 'marked' : 'already recorded as';
      console.log(`✅ #${result.num} ${result.company} — ${result.role}: ${verb} Applied (${result.date})`);
    }
  } catch (error) {
    const payload = {
      error: error.message,
      code: error.code ?? 'manual-application-error',
      ...(error.details ?? {}),
    };
    if (process.argv.includes('--json')) console.log(JSON.stringify(payload));
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  }
}
