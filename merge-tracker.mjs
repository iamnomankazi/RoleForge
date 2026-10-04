#!/usr/bin/env node
/**
 * merge-tracker.mjs — Merge batch tracker additions into applications.md
 *
 * Handles multiple TSV formats:
 * - 9-col: num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes
 * - 8-col: num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport (no notes)
 * - Pipe-delimited (markdown table row): | col | col | ... |
 *
 * Destructive reconciliation: exact Unicode-normalized company plus explicit
 * requisition identity, or exact role when no stronger identity exists.
 * Compatible evidence is unioned independently of score.
 * Validates status against states.yml (rejects non-canonical, logs warning)
 *
 * Run: node career-ops/merge-tracker.mjs [--dry-run] [--verify]
 */

import { readFileSync, readdirSync, mkdirSync, renameSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { normalizeReportLink as normalizeLink } from './tracker-links.mjs';
import { LEGACY_COLMAP, detectColumns, resolveScoreStatus, SEPARATOR_ROW_RE } from './tracker-parse.mjs';
import { resolveTrackerPath, trackerLockDirFor, acquireTrackerLock, writeFileAtomic, cell } from './tracker-utils.mjs';
import {
  appendLabeledEvidence,
  effectiveLocation,
  effectiveVia,
  evidenceContains,
  evidenceEntries,
  meaningfulEvidence,
  sameOpening,
  unionEvidence,
} from './tracker-evidence.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// Support both layouts: data/applications.md (boilerplate) and applications.md
// (original). CAREER_OPS_TRACKER overrides the path (used by tests and
// non-standard layouts). Resolution lives in tracker-utils.mjs so every tracker
// writer agrees on the same canonical path (and therefore the same lock).
const APPS_FILE = resolveTrackerPath(CAREER_OPS);
const TRACKER_DIR = dirname(APPS_FILE);
// CAREER_OPS_ADDITIONS overrides the additions dir (used by tests, mirrors CAREER_OPS_TRACKER).
const ADDITIONS_DIR = process.env.CAREER_OPS_ADDITIONS
  ? process.env.CAREER_OPS_ADDITIONS
  : join(CAREER_OPS, 'batch/tracker-additions');
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');
const MIGRATE = process.argv.includes('--migrate');
const MIGRATE_VIA = process.argv.includes('--migrate-via');
const MERGE_HOLD_MS = Number(process.env.CAREER_OPS_MERGE_HOLD_MS) || 0;
const MERGE_READY_IPC = process.env.CAREER_OPS_MERGE_READY_IPC === '1';

const TRACKER_LOCK_DIR = trackerLockDirFor(APPS_FILE);

// The reports/ dir sits at the repo root, which is the tracker's parent in the
// data/ layout (data/applications.md) and the tracker's own dir at root layout.
const REPORTS_ROOT = basename(TRACKER_DIR) === 'data' ? dirname(TRACKER_DIR) : TRACKER_DIR;

/**
 * Normalize report links before writing them into the tracker file.
 *
 * TSV additions use root-relative report links so they are easy for agents to
 * generate. The tracker may live either at `data/applications.md` or at the
 * repository root, so this wrapper binds the correct tracker and reports
 * directories before delegating to the shared link normalizer.
 *
 * @param {string} reportField - Raw report cell from a TSV addition.
 * @returns {string} Markdown report link relative to the tracker file.
 */
const normalizeReportLink = (reportField) => normalizeLink(reportField, TRACKER_DIR, REPORTS_ROOT);
const normalizeReportEvidence = (reportField) => unionEvidence(
  ...evidenceEntries(reportField).map((entry) => normalizeReportLink(entry)),
);

// Ensure required directories exist (fresh setup)
mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });
mkdirSync(ADDITIONS_DIR, { recursive: true });

/**
 * Pause the async merge flow for a fixed number of milliseconds.
 *
 * Used by the regression test hook (`CAREER_OPS_MERGE_HOLD_MS`), which
 * deliberately holds the first merge after it reads `applications.md` so a
 * second merge can try to enter the same critical section. (The lock retry
 * loop's own sleep lives in tracker-utils.mjs with the lock.)
 *
 * @param {number} ms - Milliseconds to wait before resolving.
 * @returns {Promise<void>} Resolves after the requested delay.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let trackerLock;
try {
  trackerLock = await acquireTrackerLock(TRACKER_LOCK_DIR, {
    timeoutMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000,
    retryMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75,
    staleMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || 10 * 60_000,
    tracker: APPS_FILE,
  });
  process.once('exit', () => trackerLock?.release());
  if (trackerLock.waitMs > 0 || trackerLock.staleRecovered) {
    console.log(`🔒 Tracker merge lock acquired (wait_ms=${trackerLock.waitMs} | attempts=${trackerLock.attempts} | stale_recovered=${trackerLock.staleRecovered})`);
  }
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}

// Canonical states and aliases
const CANONICAL_STATES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP', 'Hired'];

/**
 * Convert raw addition status text into one canonical tracker state.
 *
 * Batch workers and older tracker additions may emit Spanish labels, bold
 * Markdown, legacy date suffixes, or repost markers. The merge script normalizes
 * all of those variants here so applications.md keeps the states defined by
 * templates/states.yml.
 *
 * @param {string} status - Raw status string from a TSV or pipe-delimited row.
 * @returns {string} Canonical tracker status.
 */
function validateStatus(status) {
  const clean = status.replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  const lower = clean.toLowerCase();

  for (const valid of CANONICAL_STATES) {
    if (valid.toLowerCase() === lower) return valid;
  }

  // Aliases
  const aliases = {
    // Spanish → English
    'evaluada': 'Evaluated', 'condicional': 'Evaluated', 'hold': 'Evaluated', 'evaluar': 'Evaluated', 'verificar': 'Evaluated',
    'aplicado': 'Applied', 'enviada': 'Applied', 'aplicada': 'Applied', 'applied': 'Applied', 'sent': 'Applied',
    'respondido': 'Responded',
    'entrevista': 'Interview',
    'oferta': 'Offer',
    'contratado': 'Hired', 'contratada': 'Hired', 'accepted': 'Hired', 'accept': 'Hired',
    'rechazado': 'Rejected', 'rechazada': 'Rejected',
    'descartado': 'Discarded', 'descartada': 'Discarded', 'cerrada': 'Discarded', 'cancelada': 'Discarded',
    'no aplicar': 'SKIP', 'no_aplicar': 'SKIP', 'skip': 'SKIP', 'monitor': 'SKIP',
    'geo blocker': 'SKIP',
  };

  if (aliases[lower]) return aliases[lower];

  // DUPLICADO/Repost → Discarded
  if (/^(duplicado|dup|repost)/i.test(lower)) return 'Discarded';

  console.warn(`⚠️  Non-canonical status "${status}" → defaulting to "Evaluated"`);
  return 'Evaluated';
}

function mergeNotes(existingNotes, addition, oldScore, newScore) {
  return unionEvidence(existingNotes, addition.notes);
}

/**
 * Parse a score cell into a numeric value for score-upgrade decisions.
 *
 * The merge path compares old and new scores to decide whether to update an
 * existing duplicate row. Markdown bolding and `/5` suffixes are presentation
 * details, so only the first numeric value is used.
 *
 * @param {string} s - Raw score cell such as `4.2/5`.
 * @returns {number} Parsed score, or 0 when no numeric value is present.
 */
function parseScore(s) {
  const m = String(s ?? '').replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

const STATUS_RANK = new Map([
  ['SKIP', 0], ['Discarded', 0], ['Rejected', 1], ['Evaluated', 2],
  ['Applied', 3], ['Responded', 4], ['Interview', 5], ['Offer', 6], ['Hired', 7],
]);

function strongestStatus(existing, incoming) {
  const left = validateStatus(String(existing ?? ''));
  const right = validateStatus(String(incoming ?? ''));
  return (STATUS_RANK.get(right) ?? 0) > (STATUS_RANK.get(left) ?? 0) ? right : left;
}

function evidenceValue(existing, incoming) {
  return unionEvidence(existing, incoming);
}

function mergedLocation(existing, incoming) {
  return unionEvidence(existing, incoming);
}

function additionEvidenceRepresented(row, addition) {
  if (parseScore(row.score) < parseScore(addition.score)) return false;
  if ((STATUS_RANK.get(validateStatus(row.status)) ?? 0) < (STATUS_RANK.get(validateStatus(addition.status)) ?? 0)) return false;
  if (!evidenceContains(row.notes, addition.notes)) return false;
  if (!evidenceContains(effectiveLocation(row), addition.location)) return false;
  if (!evidenceContains(effectiveVia(row), addition.via)) return false;
  if (!evidenceContains(row.report, addition.report)) return false;
  if (!evidenceContains(row.pdf, addition.pdf)) return false;
  return true;
}

// Column layout for the applications.md table. The tracker may use the original
// 9-column layout, or a customized one with an extra/reordered column (e.g. a
// Location column after Role). We map columns by header NAME rather than fixed
// position so both work — fixed-position indexing would otherwise read, say,
// Location where it expects Score. Falls back to the legacy layout when no
// recognizable header row is found.
// LEGACY_COLMAP, HEADER_ALIASES and detectColumns are the shared header-name
// mapping, now sourced from tracker-parse.mjs so every tracker reader stays in
// lockstep (see imports above). COLMAP stays mutable here — it is reassigned to
// the detected layout once the table is read (below).
let COLMAP = LEGACY_COLMAP;

// Build a tracker row string matching the detected layout (with or without the
// optional Via and Location columns) so writes round-trip through the same
// schema. Optional columns follow the documented positions: Via after Company
// (#1596), Location after Role (#946).
function buildRow(o) {
  const cells = [o.num, o.date, cell(o.company)];
  if (COLMAP.via != null) cells.push(cell(o.via) || '—');
  cells.push(cell(o.role));
  if (COLMAP.location != null) cells.push(cell(o.location) || '—');
  cells.push(o.score, o.status, o.pdf, o.report, cell(o.notes));
  return `| ${cells.join(' | ')} |`;
}

function buildHeaderRows() {
  const labels = ['#', 'Date', 'Company'];
  if (COLMAP.via != null) labels.push('Via');
  labels.push('Role');
  if (COLMAP.location != null) labels.push('Location');
  labels.push('Score', 'Status', 'PDF', 'Report', 'Notes');
  return {
    header: `| ${labels.join(' | ')} |`,
    separator: `|${labels.map((label) => '-'.repeat(Math.max(3, label.length + 2))).join('|')}|`,
  };
}

/**
 * Parse one Markdown applications.md table row into a tracker object.
 *
 * Header/separator rows and malformed rows return null. Valid rows preserve the
 * original raw line so the merge logic can locate and replace the exact tracker
 * line when a higher-scored re-evaluation arrives.
 *
 * @param {string} line - One line from applications.md.
 * @returns {object|null} Parsed tracker row, or null for non-data rows.
 */
function parseAppLine(line) {
  const parts = line.split('|').map(s => s.trim());
  const maxIdx = Math.max(...Object.values(COLMAP));
  if (parts.length <= maxIdx) return null;
  const num = parseInt(parts[COLMAP.num]);
  if (isNaN(num) || num === 0) return null;
  return {
    num,
    date: parts[COLMAP.date],
    company: parts[COLMAP.company],
    via: COLMAP.via != null ? parts[COLMAP.via] : '',
    role: parts[COLMAP.role],
    location: COLMAP.location != null ? parts[COLMAP.location] : '',
    score: parts[COLMAP.score],
    status: parts[COLMAP.status],
    pdf: parts[COLMAP.pdf],
    report: parts[COLMAP.report],
    notes: COLMAP.notes != null ? (parts[COLMAP.notes] || '') : '',
    raw: line,
  };
}

/**
 * Parse a TSV file content into a structured addition object.
 *
 * Handles 9-column TSV, 8-column TSV, and pipe-delimited Markdown rows. The
 * parser also tolerates old score/status column ordering, validates status, and
 * rejects additions without a usable tracker number so malformed batch output
 * cannot corrupt applications.md.
 *
 * @param {string} content - Raw file content from batch/tracker-additions.
 * @param {string} filename - Source filename used in warning messages.
 * @returns {object|null} Parsed tracker addition, or null when malformed.
 */
/**
 * Resolve the optional trailing TSV fields (index ≥ 9) into { via, location }.
 *
 * Via travels as a TAGGED field (`via=Hays`) rather than another positional
 * slot: TSV writers are LLM agents following prompt instructions, and a writer
 * that skips an empty padding field would silently shift a positional Via into
 * the Location slot (#1596). A single untagged extra remains the legacy
 * positional location (stale prompts stay valid forever). Anything ambiguous —
 * two untagged extras, duplicate via= tags — returns null so the row is
 * rejected loudly instead of merged with scrambled columns.
 *
 * @param {string[]} parts - All fields of the TSV/pipe row.
 * @param {string} filename - Source filename used in warning messages.
 * @returns {{via: string, location: string}|null}
 */
function parseTsvExtras(parts, filename) {
  {
    const extras = parts.slice(9).map((value) => String(value).trim()).filter(Boolean);
    let via = '';
    let location = '';
    let legacyLocation = '';
    for (const extra of extras) {
      const tagged = extra.match(/^([^=]+)=(.*)$/u);
      if (tagged) {
        const name = tagged[1].trim().toLowerCase();
        const value = meaningfulEvidence(tagged[2]) ? tagged[2].trim() : '';
        if (name === 'via') {
          if (via) { console.warn(`Skipping ${filename}: duplicate via tag`); return null; }
          via = value;
        } else if (name === 'location') {
          if (location) { console.warn(`Skipping ${filename}: duplicate location tag`); return null; }
          location = value;
        } else {
          console.warn(`Skipping ${filename}: unknown extra tag "${name}"`);
          return null;
        }
      } else {
        if (legacyLocation) { console.warn(`Skipping ${filename}: multiple legacy location fields`); return null; }
        legacyLocation = meaningfulEvidence(extra) ? extra : '';
      }
    }
    if (location && legacyLocation) {
      console.warn(`Skipping ${filename}: both tagged and legacy locations were supplied`);
      return null;
    }
    return { via, location: location || legacyLocation };
  }
  const extras = parts.slice(9).map(s => String(s).trim()).filter(s => s !== '');
  const viaTags = extras.filter(s => /^via=/i.test(s));
  const untagged = extras.filter(s => !/^via=/i.test(s));
  if (viaTags.length > 1 || untagged.length > 1) {
    console.warn(`⚠️  Skipping ${filename}: ambiguous extra fields [${extras.join(', ')}] — expected at most one "via=Firm" tag and one location`);
    return null;
  }
  return {
    via: viaTags.length ? viaTags[0].replace(/^via=/i, '').trim() : '',
    location: untagged[0] || '',
  };
}

function parseTsvContent(content, filename) {
  content = content.trim();
  if (!content) return null;

  let parts;
  let addition;

  // Detect pipe-delimited (markdown table row)
  if (content.startsWith('|')) {
    parts = content.split('|').map(s => s.trim()).filter(Boolean);
    if (parts.length < 8) {
      console.warn(`⚠️  Skipping malformed pipe-delimited ${filename}: ${parts.length} fields`);
      return null;
    }
    // Format: num | date | company | role | score | status | pdf | report | notes [| location]
    // Identify score vs status by content, not position, so a swapped row can't
    // merge silently (#1427).
    const resolved = resolveScoreStatus(parts[4], parts[5]);
    if (!resolved) {
      console.warn(`⚠️  Skipping ${filename}: cannot tell score from status in columns 5–6 ("${parts[4]}" | "${parts[5]}") — refusing to merge a possible column swap`);
      return null;
    }
    addition = {
      num: parseInt(parts[0]),
      date: parts[1],
      company: parts[2],
      role: parts[3],
      // Write-canonical: the tracker stores scores unbolded (verify-pipeline
      // rejects bold scores), so strip any markdown bold from the incoming cell.
      score: resolved.score.replace(/\*\*/g, '').trim(),
      status: validateStatus(resolved.status),
      pdf: parts[6],
      report: parts[7],
      notes: parts[8] || '',
    };
    const extras = parseTsvExtras(parts, filename);
    if (!extras) return null;
    Object.assign(addition, extras);
  } else {
    // Tab-separated
    parts = content.split('\t');
    if (parts.length < 8) {
      console.warn(`⚠️  Skipping malformed TSV ${filename}: ${parts.length} fields`);
      return null;
    }

    // Column order varies: batch TSVs write (status, score), applications.md is
    // (score, status). Identify each by content — the score cell is recognizable
    // by pattern, a status never is — so a reordered TSV merges correctly and an
    // undecidable row is skipped loudly instead of merging swapped data (#1427).
    const resolved = resolveScoreStatus(parts[4].trim(), parts[5].trim());
    if (!resolved) {
      console.warn(`⚠️  Skipping ${filename}: cannot tell score from status in columns 5–6 ("${parts[4].trim()}" | "${parts[5].trim()}") — refusing to merge a possible column swap`);
      return null;
    }

    addition = {
      num: parseInt(parts[0]),
      date: parts[1],
      company: parts[2],
      role: parts[3],
      status: validateStatus(resolved.status),
      // Write-canonical: strip any markdown bold so the stored score stays
      // unbolded (verify-pipeline rejects bold scores).
      score: resolved.score.replace(/\*\*/g, '').trim(),
      pdf: parts[6],
      report: parts[7],
      notes: parts[8] || '',
    };
    const extras = parseTsvExtras(parts, filename);
    if (!extras) return null;
    Object.assign(addition, extras);
  }

  if (isNaN(addition.num) || addition.num === 0) {
    console.warn(`⚠️  Skipping ${filename}: invalid entry number`);
    return null;
  }

  // Tracker-addition files represent evaluation output, never proof that the
  // user completed a final submission.  Only application-submission.mjs may
  // advance an existing exact tracker row to Applied through set-status.mjs.
  if (addition.status === 'Applied') {
    console.warn(`⚠️  ${filename}: incoming Applied status is not trusted; storing Evaluated until explicit submission confirmation`);
    addition.status = 'Evaluated';
  }

  return addition;
}

// ---- Main ----

// Read applications.md
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to merge into.');
  process.exit(0);
}
const appContent = readFileSync(APPS_FILE, 'utf-8');
// Test-only synchronization hook: the concurrent merge test waits for the
// first worker to read the tracker while still holding the lock, then starts a
// second worker to prove the lock prevents the old lost-update race.
if (MERGE_READY_IPC && typeof process.send === 'function') {
  process.send({ type: 'merge-tracker-ready' });
}
if (MERGE_HOLD_MS > 0) {
  await sleep(MERGE_HOLD_MS);
}

// One-time migration: rewrite existing report links so they resolve relative
// to the tracker file's directory (see #760). Run with: node merge-tracker.mjs --migrate
if (MIGRATE) {
  const migrated = appContent
    .split('\n')
    .map(line => (line.startsWith('|') ? normalizeReportLink(line) : line));
  const before = appContent.split('\n');
  const changed = migrated.filter((l, i) => l !== before[i]).length;

  if (DRY_RUN) {
    console.log(`🔎 Migration (dry-run): ${changed} row(s) would be rewritten in ${basename(APPS_FILE)}`);
  } else {
    writeFileAtomic(APPS_FILE, migrated.join('\n'));
    console.log(`✅ Migration: rewrote ${changed} report link(s) in ${basename(APPS_FILE)} relative to ${TRACKER_DIR === CAREER_OPS ? 'repo root' : 'data/'}`);
  }
  process.exit(0);
}

// Opt-in migration (#1596): insert a Via column (intermediary channel) after
// Company. Header-aware readers auto-detect both layouts, so this is optional —
// it exists for users who want the column added to an existing tracker.
// Idempotent: a tracker that already has a Via column is left untouched.
// Run with: node merge-tracker.mjs --migrate-via [--dry-run]
if (MIGRATE_VIA) {
  const lines = appContent.split('\n');
  const colmap = detectColumns(lines) || LEGACY_COLMAP;
  if (colmap.via != null) {
    console.log('✅ Via column already present — nothing to migrate.');
    process.exit(0);
  }
  const companyIdx = colmap.company;
  let changed = 0;
  const migrated = lines.map(line => {
    if (!line.startsWith('|')) return line;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length <= companyIdx) return line;
    const isHeader = parts[colmap.num] === '#';
    const isSeparator = /^[-: ]*$/.test(parts.join(''));
    const insert = isHeader ? 'Via' : isSeparator ? '-----' : '—';
    const cells = [...parts.slice(1, companyIdx + 1), insert, ...parts.slice(companyIdx + 1, parts.length - 1)];
    changed++;
    return isSeparator
      ? `|${cells.map(c => c || '---').join('|')}|`
      : `| ${cells.join(' | ')} |`;
  });
  if (DRY_RUN) {
    console.log(`🔎 Migration (dry-run): Via column would be inserted after Company (${changed} table line(s) rewritten)`);
  } else {
    writeFileAtomic(APPS_FILE, migrated.join('\n'));
    console.log(`✅ Migration: inserted Via column after Company (${changed} table line(s) rewritten). Direct applications are marked —.`);
  }
  process.exit(0);
}

const appLines = appContent.split('\n');
// Detect the tracker's column layout via header names so parsing and writing
// both work whether the table uses the original 9-column layout or a customized
// one (e.g. with a Location column after Role). Falls back to the legacy layout.
COLMAP = detectColumns(appLines) || LEGACY_COLMAP;
if (COLMAP.location != null) console.log('🧭 Detected Location column.');
if (COLMAP.via != null) console.log('🧭 Detected Via column.');
const existingApps = [];
let maxNum = 0;

for (const line of appLines) {
  if (!line.startsWith('|')) continue;
  const app = parseAppLine(line);
  if (app) {
    existingApps.push(app);
    if (app.num > maxNum) maxNum = app.num;
  }
}
const usedNumbers = new Set(existingApps.map((app) => app.num));

console.log(`📊 Existing: ${existingApps.length} entries, max #${maxNum}`);

// Read tracker additions
if (!existsSync(ADDITIONS_DIR)) {
  console.log('No tracker-additions directory found.');
  process.exit(0);
}

const tsvFiles = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
if (tsvFiles.length === 0) {
  console.log('✅ No pending additions to merge.');
  process.exit(0);
}

// Sort files numerically for deterministic processing
tsvFiles.sort((a, b) => {
  const numA = parseInt(/^(\d+)/.exec(a)?.[1] ?? '', 10) || 0;
  const numB = parseInt(/^(\d+)/.exec(b)?.[1] ?? '', 10) || 0;
  return numA - numB;
});

console.log(`📥 Found ${tsvFiles.length} pending additions`);

let added = 0;
let updated = 0;
let skipped = 0;
const newLines = [];
const failedAdditions = [];

function replaceTrackerLine(oldLine, updatedLine) {
  const appIdx = appLines.indexOf(oldLine);
  if (appIdx >= 0) {
    appLines[appIdx] = updatedLine;
    return true;
  }
  const pendingIdx = newLines.indexOf(oldLine);
  if (pendingIdx >= 0) {
    newLines[pendingIdx] = updatedLine;
    return true;
  }
  return false;
}

for (const file of tsvFiles) {
  const content = readFileSync(join(ADDITIONS_DIR, file), 'utf-8').trim();
  const addition = parseTsvContent(content, file);
  if (!addition) { skipped++; failedAdditions.push(file); continue; }

  // Legacy layouts preserve optional fields as labeled notes.
  if (meaningfulEvidence(addition.via) && COLMAP.via == null) {
    addition.notes = appendLabeledEvidence(addition.notes, 'Via', addition.via);
  }
  if (meaningfulEvidence(addition.location) && COLMAP.location == null) {
    addition.notes = appendLabeledEvidence(addition.notes, 'Location', addition.location);
  }

  // Normalize the report link to be relative to the tracker file's directory.
  // The TSV convention carries a root-relative `reports/...` link; rewrite it
  // so it resolves correctly when clicked from applications.md (see #760).
  addition.report = normalizeReportEvidence(addition.report);

  // Row numbers and report/PDF files are evidence, never opening identity.
  const duplicate = existingApps.find((app) => sameOpening(app, addition)) || null;

  if (duplicate) {
    const newScore = parseScore(addition.score);
    const oldScore = parseScore(duplicate.score);
    const higherScore = newScore > oldScore;
    const updatedLine = buildRow({
      num: duplicate.num,
      date: higherScore ? addition.date : duplicate.date,
      company: duplicate.company,
      role: duplicate.role,
      via: evidenceValue(duplicate.via, addition.via),
      location: mergedLocation(duplicate.location, addition.location),
      score: higherScore ? addition.score : duplicate.score,
      status: strongestStatus(duplicate.status, addition.status),
      pdf: evidenceValue(duplicate.pdf, addition.pdf),
      report: evidenceValue(duplicate.report, addition.report),
      notes: mergeNotes(duplicate.notes, addition, oldScore, newScore),
    });
    const reconciled = parseAppLine(updatedLine);
    if (!reconciled || !additionEvidenceRepresented(reconciled, addition)) {
      console.error(`❌ ${file}: compatible evidence could not be represented in tracker row #${duplicate.num}; addition remains pending`);
      failedAdditions.push(file);
      continue;
    }
    if (updatedLine !== duplicate.raw) {
      console.log(`🔄 Reconcile: #${duplicate.num} ${addition.company} — ${addition.role} (${oldScore}→${Math.max(oldScore, newScore)})`);
      if (replaceTrackerLine(duplicate.raw, updatedLine)) {
        Object.assign(duplicate, reconciled);
        updated++;
      } else {
        console.error(`❌ ${file}: tracker row #${duplicate.num} could not be located; addition was not merged`);
        failedAdditions.push(file);
      }
    } else {
      console.log(`⏭️  Skip: ${addition.company} — ${addition.role} (all evidence already represented by #${duplicate.num})`);
      skipped++;
    }
  } else {
    // Preserve a worker's reserved number whenever it is actually free;
    // parallel workers can finish out of order, so a lower number is valid.
    let entryNum = addition.num;
    if (usedNumbers.has(entryNum)) {
      entryNum = maxNum + 1;
      while (usedNumbers.has(entryNum)) entryNum++;
      console.warn(`⚠️  Tracker #${addition.num} already used; assigning #${entryNum} to ${addition.company} — ${addition.role}`);
    }
    usedNumbers.add(entryNum);
    if (entryNum > maxNum) maxNum = entryNum;

    const newLine = buildRow({
      num: entryNum, date: addition.date, company: addition.company, role: addition.role,
      via: addition.via || '—',
      location: addition.location || '—',
      score: addition.score, status: addition.status, pdf: addition.pdf,
      report: addition.report, notes: addition.notes,
    });
    const parsedNew = parseAppLine(newLine);
    if (!parsedNew || !additionEvidenceRepresented(parsedNew, addition)) {
      console.error(`New row for ${file} does not represent every meaningful TSV field; addition remains pending`);
      failedAdditions.push(file);
      continue;
    }
    newLines.push(newLine);
    parsedNew.addedThisRun = true;
    existingApps.push(parsedNew);
    added++;
    console.log(`➕ Add #${entryNum}: ${addition.company} — ${addition.role} (${addition.score})`);
  }
}

// Insert new lines after the header (line index of first data row)
if (newLines.length > 0) {
  // Find header separator (|---|...) and insert after it
  let insertIdx = -1;
  for (let i = 0; i < appLines.length; i++) {
    if (SEPARATOR_ROW_RE.test(appLines[i])) {
      insertIdx = i + 1;
      break;
    }
  }
  if (insertIdx < 0) {
    const { header, separator } = buildHeaderRows();
    console.error(`❌ Aborting merge: ${basename(APPS_FILE)} has no table separator row.`);
    console.error(`   No rows were written and no TSV was archived. Expected header:\n     ${header}\n     ${separator}`);
    trackerLock.release();
    process.exit(1);
  }
  appLines.splice(insertIdx, 0, ...newLines);
}

// Write back
if (!DRY_RUN) {
  writeFileAtomic(APPS_FILE, appLines.join('\n'));

  // Move processed files to merged/
  if (!existsSync(MERGED_DIR)) mkdirSync(MERGED_DIR, { recursive: true });
  const archivable = tsvFiles.filter((file) => !failedAdditions.includes(file));
  for (const file of archivable) {
    renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file));
  }
  console.log(`\n✅ Moved ${archivable.length} TSVs to merged/`);
}

console.log(`\n📊 Summary: +${added} added, 🔄${updated} updated, ⏭️${skipped} skipped`);
if (DRY_RUN) console.log('(dry-run — no changes written)');
trackerLock.release();

if (failedAdditions.length > 0) {
  console.error(`❌ ${failedAdditions.length} addition(s) were not merged and remain pending: ${failedAdditions.join(', ')}`);
  process.exit(1);
}

// Optional verify
if (VERIFY && !DRY_RUN) {
  console.log('\n--- Running verification ---');
  try {
    execFileSync('node', [join(CAREER_OPS, 'verify-pipeline.mjs')], { stdio: 'inherit' });
  } catch (e) {
    process.exit(1);
  }
}
