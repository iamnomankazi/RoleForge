#!/usr/bin/env node
/**
 * dedup-tracker.mjs — Remove duplicate entries from applications.md
 *
 * Groups by normalized company, then merges only rows whose full role title
 * matches exactly (case- and whitespace-normalized). Keeps entry with highest
 * score. If discarded entry had more advanced status, preserves that status.
 * Merges notes.
 *
 * Run: node career-ops/dedup-tracker.mjs [--dry-run]
 */

import { readFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rebuildRow, trackerLockDirFor, acquireTrackerLock, writeFileAtomic } from './tracker-utils.mjs';
import { resolveColumns, parseTrackerRow, normalizeVia } from './tracker-parse.mjs';
import { normalizeOpeningText, sameOpening, unionEvidence } from './tracker-evidence.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// Support both layouts: data/applications.md (boilerplate) and applications.md
// (original). CAREER_OPS_TRACKER lets tests point the script at an isolated
// fixture so the real user tracker is never touched.
const APPS_FILE = process.env.CAREER_OPS_TRACKER
  ? process.env.CAREER_OPS_TRACKER
  : existsSync(join(CAREER_OPS, 'data/applications.md'))
    ? join(CAREER_OPS, 'data/applications.md')
    : join(CAREER_OPS, 'applications.md');
const DRY_RUN = process.argv.includes('--dry-run');

// Ensure the target tracker directory exists in both normal and fixture mode.
mkdirSync(dirname(APPS_FILE), { recursive: true });

// Status advancement order (higher = more advanced in pipeline)
// Aplicado > Rechazado because active application > terminal state
const STATUS_RANK = {
  // English canonicals (states.yml labels)
  'skip': 0,
  'discarded': 0,
  'rejected': 1,
  'evaluated': 2,
  'applied': 3,
  'responded': 4,
  'interview': 5,
  'offer': 6,
  'hired': 7,
  'accepted': 7,
  'accept': 7,
  // Spanish aliases — kept for backwards compat with existing tracker data
  'no_aplicar': 0,
  'no aplicar': 0,
  'descartado': 0,
  'descartada': 0,
  'rechazado': 1,  // Terminal — below active states
  'rechazada': 1,
  'evaluada': 2,
  'aplicado': 3,
  'respondido': 4,
  'entrevista': 5,
  'oferta': 6,
  'contratado': 7,
  'contratada': 7,
};

/**
 * Normalize tracker status text before ranking or comparing it.
 *
 * Existing trackers can contain bold Markdown wrappers or legacy dates appended
 * to the status cell. Dedup needs the canonical status word only, in lowercase,
 * so advanced-state protection works the same for old and new tracker rows.
 *
 * @param {string} status - Raw status cell from applications.md.
 * @returns {string} Lowercase status key with Markdown/date noise removed.
 */
function normalizeStatus(status) {
  return String(status ?? '')
    .replace(/\*\*/g, '')
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Convert a tracker status into its pipeline-advancement rank.
 *
 * Higher ranks represent states that carry more user intent and should not be
 * casually overwritten or removed. Unknown statuses rank as 0 so malformed data
 * is treated conservatively rather than promoted.
 *
 * @param {string} status - Raw or normalized status value.
 * @returns {number} Numeric rank from STATUS_RANK, or 0 for unknown statuses.
 */
function statusRank(status) {
  return STATUS_RANK[normalizeStatus(status)] || 0;
}

/**
 * Decide whether two same-company tracker rows should be deduplicated.
 *
 * Rows merge only when they describe the same opening: either the exact same
 * bracketed report identity, or an exact
 * role-title match after normalizing case and whitespace. Fuzzy title matching
 * is deliberately NOT used here — it collapsed distinct sibling roles at one
 * company (e.g. "Software Engineer, Data Infrastructure" vs "Senior Software
 * Engineer, Agent Infrastructure"), causing real data loss.
 *
 * When titles match exactly but either row is already Applied or later, dedup
 * still keeps both and warns: deleting an in-flight application would lose its
 * status, report link, and notes unless the rows are the exact same report
 * identity.
 *
 * @param {object} a - First parsed applications.md row.
 * @param {object} b - Second parsed applications.md row.
 * @returns {boolean} True when dedup may cluster the two rows as duplicates.
 */
function roleMatch(a, b) {
  return sameOpening(a, b);
}

/**
 * Parse a tracker score cell into a numeric value for keeper selection.
 *
 * Scores may include Markdown bolding or a `/5` suffix. Dedup only needs the
 * numeric part so it can keep the highest-scored duplicate row in a cluster.
 *
 * @param {string} s - Raw score cell such as `4.3/5` or `**4.3/5**`.
 * @returns {number} Parsed score, or 0 when no number is present.
 */
function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * Parse one Markdown table row from applications.md into a tracker object.
 *
 * Header and separator rows return null because they either lack enough cells
 * or do not have a numeric tracker id. Valid data rows keep the raw line; the
 * caller attaches the physical line index after parsing so later updates and
 * removals never depend on tracker numbers being globally unique.
 *
 * @param {string} line - One line from applications.md.
 * @returns {object|null} Parsed tracker row, or null for non-application lines.
 */
function parseAppLine(line) {
  return parseTrackerRow(line, COLMAP);
}

// Read
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to dedup.');
  process.exit(0);
}
let trackerLock = null;
if (!DRY_RUN) {
  try {
    trackerLock = await acquireTrackerLock(trackerLockDirFor(APPS_FILE), { tracker: APPS_FILE });
    process.once('exit', () => trackerLock?.release());
  } catch (error) {
    console.error(`Cannot acquire tracker lock: ${error.message}`);
    process.exit(1);
  }
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');
// Header-aware column map (tolerates an inserted Location column, etc.).
const COLMAP = resolveColumns(lines);

// Parse all entries
const entries = [];

for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('|')) continue;
  const app = parseAppLine(lines[i]);
  if (app && app.num > 0) {
    app.lineIdx = i;
    entries.push(app);
  }
}

console.log(`📊 ${entries.length} entries loaded`);

// Group by company+role. Unknown-employer rows (Company `?`, #1596) all
// normalize to the same empty key, so they group by their Via channel instead:
// the same agency re-blasting one listing IS a duplicate, while the same role
// via two different agencies is two real submissions and must never merge.
const BLIND_KEY = '__blind-via__:';
const groups = new Map();
for (const entry of entries) {
  const key = String(entry.company).trim() === '?'
    ? BLIND_KEY + normalizeVia(entry.via || '')
    : normalizeOpeningText(entry.company);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(entry);
}

// Two blind rows only count as the same listing when their evaluation dates
// sit within the re-post window (mirrors detect-reposts.mjs's 90 days).
// Unparseable dates never cluster — deleting a real application is worse than
// keeping a duplicate.
const BLIND_WINDOW_DAYS = 90;
function withinBlindWindow(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) <= BLIND_WINDOW_DAYS * 86400000;
}

// Find duplicates
let removed = 0;
const linesToRemove = new Set();

for (const [company, companyEntries] of groups) {
  if (companyEntries.length < 2) continue;
  const isBlindGroup = company.startsWith(BLIND_KEY);

  // Within same company, find role matches
  const processed = new Set();
  for (let i = 0; i < companyEntries.length; i++) {
    if (processed.has(i)) continue;
    const cluster = [companyEntries[i]];
    processed.add(i);

    for (let j = i + 1; j < companyEntries.length; j++) {
      if (processed.has(j)) continue;
      if (cluster.every((member) => roleMatch(member, companyEntries[j]))
          && (!isBlindGroup || withinBlindWindow(companyEntries[i].date, companyEntries[j].date))) {
        cluster.push(companyEntries[j]);
        processed.add(j);
      }
    }

    if (cluster.length < 2) continue;

    // Keep the one with highest score
    cluster.sort((a, b) => parseScore(b.score) - parseScore(a.score));
    const keeper = cluster[0];

    // Reconcile every compatible field before removing a row. Score chooses
    // the keeper, but evidence and status are independent of score.
    let bestStatusRank = statusRank(keeper.status);
    let bestStatus = keeper.status;
    for (let k = 1; k < cluster.length; k++) {
      const rank = statusRank(cluster[k].status);
      if (rank > bestStatusRank) {
        bestStatusRank = rank;
        bestStatus = cluster[k].status;
      }
    }

    const mergedNotes = unionEvidence(...cluster.map((entry) => entry.notes));

    if (keeper.lineIdx !== undefined) {
      const parts = lines[keeper.lineIdx].split('|').map((value) => value.trim());
      if (bestStatus !== keeper.status) {
        parts[COLMAP.status] = bestStatus;
        console.log(`  📝 #${keeper.num}: status promoted to "${bestStatus}" (from #${cluster.find(e => e.status === bestStatus)?.num})`);
      }
      for (const field of ['report', 'pdf', 'via', 'location']) {
        if (COLMAP[field] != null) parts[COLMAP[field]] = unionEvidence(...cluster.map((entry) => entry[field]));
      }
      if (COLMAP.notes != null) parts[COLMAP.notes] = mergedNotes;
      lines[keeper.lineIdx] = rebuildRow(parts);
      keeper.notes = mergedNotes;
      keeper.status = bestStatus;
    }

    // Remove duplicates
    for (let k = 1; k < cluster.length; k++) {
      const dup = cluster[k];
      const lineIdx = dup.lineIdx;
      if (lineIdx !== undefined) {
        linesToRemove.add(lineIdx);
        removed++;
        console.log(`🗑️  Remove #${dup.num} (${dup.company} — ${dup.role}, ${dup.score}) → kept #${keeper.num} (${keeper.score})`);
      }
    }
  }
}

// Remove lines (in reverse order to preserve indices)
const sortedRemoveIndices = [...linesToRemove].sort((a, b) => b - a);
for (const idx of sortedRemoveIndices) {
  lines.splice(idx, 1);
}

console.log(`\n📊 ${removed} duplicates removed`);

if (!DRY_RUN && removed > 0) {
  copyFileSync(APPS_FILE, APPS_FILE + '.bak');
  writeFileAtomic(APPS_FILE, lines.join('\n'));
  console.log('✅ Written to applications.md (backup: applications.md.bak)');
} else if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else {
  console.log('✅ No duplicates found');
}
trackerLock?.release();
