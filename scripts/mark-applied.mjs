import { disableLegacyApplicationEntrypoint } from '../legacy-application-guard.mjs';
disableLegacyApplicationEntrypoint('scripts/mark-applied.mjs');

import fs from 'fs';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const args = process.argv.slice(2);
const confirmed = args.includes('--confirm-submitted') || args.includes('--yes');
const nums = args.filter(arg => !arg.startsWith('--')).map(Number).filter(Boolean);
const csvPath = 'output/apply-queue.csv';
const trackerPath = 'data/applications.md';

if (!nums.length) {
  throw new Error('Usage: node scripts/mark-applied.mjs --confirm-submitted [row numbers]');
}
if (!fs.existsSync(csvPath)) throw new Error('Missing output/apply-queue.csv');

if (!confirmed) {
  if (!process.stdin.isTTY) {
    throw new Error('Refusing to mark Applied without confirmation. Re-run with --confirm-submitted only after the user clicked final submit.');
  }
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question('Did you manually click final submit for these rows? Type "submitted" to confirm: ');
  rl.close();
  if (!/^(submitted|i clicked submit|i applied|yes)$/i.test(answer.trim())) {
    console.log('No rows marked Applied. Use Ready to Submit or Blocked if submission is not confirmed.');
    process.exit(0);
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted && ch === '"' && next === '"') {
      cell += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && next === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function escCsv(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function ensureColumn(header, rows, name) {
  let idx = header.indexOf(name);
  if (idx === -1) {
    idx = header.length;
    header.push(name);
    for (const row of rows) row.push('');
  }
  return idx;
}

function escMd(value) {
  return String(value ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ').trim();
}

function splitTrackerRows(text) {
  return text.split(/\r?\n/);
}

function rowMatches(line, row, idx) {
  const lower = line.toLowerCase();
  const company = String(row[idx.company] || '').toLowerCase();
  const role = String(row[idx.role] || '').toLowerCase();
  const jobUrl = String(row[idx.job_url] || '').toLowerCase();
  const applyUrl = String(row[idx.apply_url] || '').toLowerCase();
  return (jobUrl && lower.includes(jobUrl)) ||
    (applyUrl && lower.includes(applyUrl)) ||
    (company && role && lower.includes(company) && lower.includes(role));
}

function updateTrackerLine(line, today) {
  const cells = line.split('|');
  if (cells.length < 10) return line;
  cells[2] = ` ${today} `;
  cells[6] = ' Applied ';
  const note = cells[9]?.trim();
  const suffix = 'Submitted manually by user.';
  cells[9] = ` ${note && !note.includes(suffix) ? `${note} ${suffix}` : (note || suffix)} `;
  return cells.join('|');
}

const csvRows = parseCsv(fs.readFileSync(csvPath, 'utf8')).filter(row => row.length && row.some(Boolean));
const header = csvRows.shift();
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
idx.status = ensureColumn(header, csvRows, 'status');
idx.applied_date = ensureColumn(header, csvRows, 'applied_date');

const today = new Date().toISOString().slice(0, 10);
const wanted = new Set(nums.map(String));
const applied = [];

for (const row of csvRows) {
  if (!wanted.has(row[idx.rank])) continue;
  row[idx.status] = 'Applied';
  row[idx.applied_date] = today;
  applied.push(row);
}

if (!applied.length) {
  console.log('No matching queue rows found.');
  process.exit(0);
}

fs.writeFileSync(csvPath, [header, ...csvRows].map(row => row.map(escCsv).join(',')).join('\n') + '\n');

let tracker = fs.existsSync(trackerPath)
  ? fs.readFileSync(trackerPath, 'utf8')
  : '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n';

let lines = splitTrackerRows(tracker);
let max = 0;
for (const m of tracker.matchAll(/^\|\s*(\d+)\s*\|/gm)) max = Math.max(max, Number(m[1]));

for (const row of applied) {
  const existingIndex = lines.findIndex(line => /^\|\s*\d+\s*\|/.test(line) && rowMatches(line, row, idx));
  if (existingIndex !== -1) {
    lines[existingIndex] = updateTrackerLine(lines[existingIndex], today);
    continue;
  }

  max++;
  const url = row[idx.job_url] || row[idx.apply_url] || '';
  const note = `Submitted manually by user. URL: ${url}`;
  lines.push(`| ${max} | ${today} | ${escMd(row[idx.company])} | ${escMd(row[idx.role])} |  | Applied | ${escMd(row[idx.cv_variant])} |  | ${escMd(note)} |`);
}

tracker = lines.join('\n').replace(/\n{3,}/g, '\n\n');
if (!tracker.endsWith('\n')) tracker += '\n';
fs.writeFileSync(trackerPath, tracker);

console.log(`Marked Applied rows: ${applied.map(row => row[idx.rank]).join(', ')}`);
console.log('Tracker note used: Submitted manually by user.');
