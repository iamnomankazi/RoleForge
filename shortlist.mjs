#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseReportMachineSummary, validateMachineSummary } from './assessment-contract.mjs';

const HELP = 'Usage: node shortlist.mjs [--reports reports] [--out data/shortlist.md] [--since YYYY-MM-DD] [--json]\n\n--since filters by report date (summary date, Date/Fecha header, then filename).\n--json prints counts and entries; the Markdown shortlist is still written.\n--help shows this help.';

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

export function parseArgs(args) {
  const options = { reports: 'reports', out: 'data/shortlist.md', since: null, json: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (['--reports', '--out', '--since'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.since && !validDate(options.since)) throw new Error('--since must be a valid YYYY-MM-DD date');
  return options;
}

function locationRank(country) {
  const value = String(country ?? '').trim().toLowerCase();
  if (['fi', 'fin', 'finland'].includes(value)) return 0;
  if (['de', 'deu', 'germany', 'nl', 'nld', 'netherlands', 'dk', 'dnk', 'denmark'].includes(value)) return 1;
  if (/\b(remote|eu|europe|eea)\b/.test(value)) return 2;
  return 3;
}

function compare(a, b) {
  return locationRank(a.location_country) - locationRank(b.location_country)
    || b.fit_score - a.fit_score
    || a.company.localeCompare(b.company, 'en') || a.role.localeCompare(b.role, 'en')
    || a.report.localeCompare(b.report, 'en');
}

function reportDate(summary, markdown, filename) {
  const date = typeof summary?.date === 'string' ? summary.date : '';
  const header = markdown.match(/^\*\*(?:Date|Fecha):\*\*\s*(\d{4}-\d{2}-\d{2})/im)?.[1];
  const suffix = filename.match(/(\d{4}-\d{2}-\d{2})\.md$/i)?.[1];
  return [date, header, suffix].find((value) => value && validDate(value)) || null;
}

function normalizeIdentityPart(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function postingIdentity(entry) {
  const parts = [entry.company, entry.title, entry.location].map(normalizeIdentityPart);
  return parts.every(Boolean) ? parts.join('\u0000') : null;
}

function hasJdText(summary) {
  if (summary.has_jd_text === true || summary.jd_available === true) return true;
  if (typeof summary.description_chars === 'number' && summary.description_chars > 0) return true;
  return ['description', 'job_description', 'jobDescription', 'jd_text', 'jdText', 'job_description_text', 'jd']
    .some((key) => typeof summary[key] === 'string' && summary[key].trim().length > 0);
}

function candidateId(summary) {
  const value = summary.candidate_id ?? summary.candidateId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function compareRepresentative(a, b) {
  return Number(b.liveness === 'confirmed') - Number(a.liveness === 'confirmed')
    || Number(b.has_jd_text) - Number(a.has_jd_text)
    || String(b.date ?? '').localeCompare(String(a.date ?? ''), 'en')
    || String(a.candidate_id ?? a.report).localeCompare(String(b.candidate_id ?? b.report), 'en')
    || a.report.localeCompare(b.report, 'en');
}

function auditId(entry) {
  return entry.candidate_id ?? entry.report.split(/[\\/]/).at(-1);
}

function deduplicateCandidates(candidates) {
  const groups = new Map();
  const unique = [];
  for (const candidate of candidates) {
    const key = postingIdentity(candidate);
    if (!key) {
      unique.push(candidate);
      continue;
    }
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort(compareRepresentative);
    const [representative, ...dropped] = group;
    representative.duplicates = dropped.map(auditId);
    unique.push(representative);
  }
  return unique;
}

// A re-assessment names the report it replaces in a `**Supersedes:** [num](reports/<file>)` header.
// The replaced report stays on disk for audit but leaves the active lists.
function supersededReports(root, files) {
  const superseded = new Map();
  for (const file of files) {
    const header = readFileSync(join(root, file.name), 'utf8').match(/^\*\*Supersedes:\*\*\s*\[[^\]]*\]\(([^)]+)\)/m);
    if (!header) continue;
    const target = header[1].split(/[\\/]/).at(-1);
    if (target !== file.name && files.some((entry) => entry.name === target)) superseded.set(target, file.name);
  }
  return superseded;
}

export function collectReports({ reports = 'reports', since = null } = {}) {
  const result = { apply: [], review: [], skip: [], legacy: [], invalid: [], superseded: [], excluded: 0 };
  const candidates = [];
  const root = resolve(reports);
  const files = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.md$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const superseded = supersededReports(root, files);
  for (const file of files) {
    const report = join(root, file.name);
    if (superseded.has(file.name)) { result.superseded.push({ report, superseded_by: join(root, superseded.get(file.name)) }); continue; }
    const markdown = readFileSync(report, 'utf8');
    const summary = parseReportMachineSummary(markdown);
    const date = reportDate(summary, markdown, file.name);
    if (since && (!date || date < since)) { result.excluded += 1; continue; }
    if (!summary) { result.invalid.push({ report, errors: ['Missing Machine Summary'] }); continue; }
    if (summary.legacy) {
      result.legacy.push({ report, company: summary.company ?? '', role: summary.role ?? '', date });
      continue;
    }
    const assessment = validateMachineSummary(summary);
    if (!assessment.valid) { result.invalid.push({ report, errors: assessment.errors }); continue; }
    const { company, role, title, location_country, fit_score, review_reason } = summary;
    candidates.push({
      report, candidate_id: candidateId(summary), company, role, title: title || role,
      date, location: summary.location || location_country, location_country,
      fit_score, action: assessment.action, fit_band: assessment.fit_band, bucket: assessment.bucket,
      liveness: summary.liveness, has_jd_text: hasJdText(summary), duplicates: [],
      flags: [...summary.flags, ...(summary.prescreen?.flags ?? [])], review_reason: review_reason ?? '',
    });
  }
  for (const candidate of deduplicateCandidates(candidates)) result[candidate.action].push(candidate);
  for (const action of ['apply', 'review', 'skip']) result[action].sort(compare);
  return result;
}

const cell = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').trim();

function reportLink(report, out) {
  const target = relative(dirname(resolve(out)), report).replace(/\\/g, '/');
  // A different Windows drive produces an absolute path; use a file URL there.
  const href = /^[A-Za-z]:\//.test(target) ? pathToFileURL(report).href : target.split('/').map(encodeURIComponent).join('/');
  return `[${cell(report.split(/[\\/]/).at(-1))}](<${href}>)`;
}

export function renderShortlist(result, out = 'data/shortlist.md') {
  const lines = ['# Shortlist', '', 'Finland first, then other target countries (Germany, Netherlands, Denmark), then remote; fit score descending within each group.', ''];
  for (const action of ['apply', 'review']) {
    const entries = result[action];
    lines.push(`## ${action === 'apply' ? 'Apply' : 'Review'} (${entries.length})`, '');
    if (!entries.length) { lines.push('None.', ''); continue; }
    lines.push('| Report | Company | Role | Location | Fit score | Action | Flags | Review reason | Duplicate candidates |', '|---|---|---|---|---|---|---|---|---|');
    for (const entry of entries) {
      lines.push(`| ${reportLink(entry.report, out)} | ${cell(entry.company)} | ${cell(entry.role)} | ${cell(entry.location)} | ${entry.fit_score.toFixed(1)} | ${entry.action} | ${cell(entry.flags.map((flag) => flag.code).join(', '))} | ${cell(entry.review_reason)} | ${cell(entry.duplicates.join(', '))} |`);
    }
    lines.push('');
  }
  lines.push(`## Skip (${result.skip.length})`, '', `Count: ${result.skip.length}.`, '');
  if (result.superseded?.length) lines.push(`Superseded reports (kept for audit, not listed): ${result.superseded.length}.`, '');
  lines.push(`## Needs re-assessment (legacy format) (${result.legacy.length})`, '');
  if (!result.legacy.length) lines.push('None.', '');
  for (const entry of result.legacy) lines.push(`- ${reportLink(entry.report, out)} — ${cell(entry.company)} — ${cell(entry.role)}`);
  if (result.invalid.length) {
    lines.push('', `## Invalid reports (${result.invalid.length})`, '');
    for (const entry of result.invalid) lines.push(`- ${reportLink(entry.report, out)} — ${cell(entry.errors.join('; '))}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  const result = collectReports(options);
  mkdirSync(dirname(resolve(options.out)), { recursive: true });
  writeFileSync(resolve(options.out), renderShortlist(result, options.out), 'utf8');
  const counts = Object.fromEntries(['apply', 'review', 'skip', 'legacy', 'invalid', 'superseded'].map((key) => [key, result[key].length]));
  counts.excluded = result.excluded;
  if (options.json) console.log(JSON.stringify({ out: resolve(options.out), counts, ...result }, null, 2));
  else console.log(`Shortlist written to ${options.out}: Apply ${counts.apply}, Review ${counts.review}, Skip ${counts.skip}, Legacy ${counts.legacy}, Invalid ${counts.invalid}, Superseded ${counts.superseded}, Excluded ${counts.excluded}`);
  if (counts.invalid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
