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

export function collectReports({ reports = 'reports', since = null } = {}) {
  const result = { apply: [], review: [], skip: [], legacy: [], invalid: [], excluded: 0 };
  const root = resolve(reports);
  for (const file of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.md$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const report = join(root, file.name);
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
    const { company, role, location_country, fit_score, review_reason } = summary;
    result[assessment.action].push({
      report, company, role, date, location: summary.location || location_country, location_country,
      fit_score, action: assessment.action, fit_band: assessment.fit_band, bucket: assessment.bucket,
      flags: [...summary.flags, ...(summary.prescreen?.flags ?? [])], review_reason: review_reason ?? '',
    });
  }
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
    lines.push('| Report | Company | Role | Location | Fit score | Action | Flags | Review reason |', '|---|---|---|---|---|---|---|---|');
    for (const entry of entries) {
      lines.push(`| ${reportLink(entry.report, out)} | ${cell(entry.company)} | ${cell(entry.role)} | ${cell(entry.location)} | ${entry.fit_score.toFixed(1)} | ${entry.action} | ${cell(entry.flags.map((flag) => flag.code).join(', '))} | ${cell(entry.review_reason)} |`);
    }
    lines.push('');
  }
  lines.push(`## Skip (${result.skip.length})`, '', `Count: ${result.skip.length}.`, '', `## Needs re-assessment (legacy format) (${result.legacy.length})`, '');
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
  const counts = Object.fromEntries(['apply', 'review', 'skip', 'legacy', 'invalid'].map((key) => [key, result[key].length]));
  counts.excluded = result.excluded;
  if (options.json) console.log(JSON.stringify({ out: resolve(options.out), counts, ...result }, null, 2));
  else console.log(`Shortlist written to ${options.out}: Apply ${counts.apply}, Review ${counts.review}, Skip ${counts.skip}, Legacy ${counts.legacy}, Invalid ${counts.invalid}, Excluded ${counts.excluded}`);
  if (counts.invalid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
