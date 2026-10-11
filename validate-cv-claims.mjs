#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, open, readFile, rename, stat, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, extname, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildValidationReport,
  createDraftManifest,
  extractDriftFacts,
  loadManifest,
  sha256,
  splitClaimSentences,
  technologyListSegments,
  validateClaims,
  validateManifest,
} from './cv-claims.mjs';

const execFile = promisify(execFileCallback);
const ACTIVE_MANIFEST = 'data/cv-claim-anchors.json';
const SECTION_LABELS = new Set(['summary', 'profile', 'professional summary', 'experience', 'work experience',
  'education', 'projects', 'personal projects', 'skills', 'languages', 'technical skills', 'contact',
  'yhteenveto', 'profiili', 'työkokemus', 'kokemus', 'koulutus', 'projektit', 'taidot', 'kielet', 'tekniset taidot', 'yhteystiedot',
  'zusammenfassung', 'profil', 'berufserfahrung', 'erfahrung', 'ausbildung', 'bildung', 'projekte', 'kenntnisse', 'fähigkeiten', 'sprachen', 'technische kenntnisse', 'kontakt']);
const SKILLS_LABELS = new Set(['languages', 'frameworks', 'tools', 'databases', 'cloud', 'other']);
export function isStandardCvLabel(value) {
  return SECTION_LABELS.has(String(value ?? '').trim().toLowerCase()) || isSkillsCategoryLabel(value);
}
export function isSkillsCategoryLabel(value) {
  return SKILLS_LABELS.has(String(value ?? '').trim().toLowerCase());
}

function texDefinitions(source) {
  const text = String(source).split(/\r?\n/).map(line => line.replace(/(?<!\\)%.*$/, '')).join('\n');
  const definitions = [];
  const command = /\\(?:newcommand|renewcommand|providecommand|def)\b/g;
  let match;
  while ((match = command.exec(text))) {
    let index = command.lastIndex;
    const space = () => { while (/\s/.test(text[index] || '') && index < text.length) index++; };
    const group = (open, close) => {
      if (text[index] !== open) throw new Error('untrusted_macro_definition');
      let depth = 1;
      index++;
      while (index < text.length && depth) {
        if (text[index] === '\\') { index += 2; continue; }
        if (text[index] === open) depth++;
        if (text[index] === close) depth--;
        index++;
      }
      if (depth) throw new Error('untrusted_macro_definition');
    };
    space();
    if (text[index] === '*') { index++; space(); }
    if (text[index] === '{') group('{', '}');
    else {
      const name = /^\\[A-Za-z]+/.exec(text.slice(index));
      if (!name) throw new Error('untrusted_macro_definition');
      index += name[0].length;
    }
    space();
    while (text[index] === '[') { group('[', ']'); space(); }
    if (match[0] === '\\def') { while (index < text.length && text[index] !== '{') index++; }
    group('{', '}');
    definitions.push(text.slice(match.index, index).trim());
    command.lastIndex = index;
  }
  return definitions;
}

export function enforceTrustedTexDefinitions(source) {
  const trusted = texDefinitions(readFileSync(new URL('./templates/cv-template.tex', import.meta.url), 'utf8'));
  for (const definition of texDefinitions(source)) {
    if (!trusted.includes(definition)) throw new Error('untrusted_macro_definition');
  }
}
const HELP = `Usage:
  node validate-cv-claims.mjs --cv <path> --anchors <path> [--json] [--strict]
  node validate-cv-claims.mjs --cv <path> --init <out> [--json]
  node validate-cv-claims.mjs --cv <path> [--anchors <active>] --refresh [<out>] [--json]
  node validate-cv-claims.mjs --activate <draft> [--replace-active] [--anchors <active>]
  node validate-cv-claims.mjs --drift [--cv <path>] [--anchors <active>] [--approved-dir <dir>] [--json]
  node validate-cv-claims.mjs --check-document <file> [--cv <path>] [--anchors <active>] [--strict]

Options:
  --cv <path>             Canonical CV markdown (defaults to cv.md for drift/check)
  --anchors <path>        Manifest path (defaults to data/cv-claim-anchors.json)
  --init <out>            Write a collision-safe, hash-qualified asserted draft
  --refresh [<out>]       Draft current cv.md against the active manifest and report its delta
  --activate <draft>      Explicitly move a reviewed draft to the active manifest path
  --replace-active        Back up the current active manifest before activation
  --drift                 Compare approved PDF facts with canonical cv.md
  --approved-dir <dir>    PDF directory (defaults to cv.approved_system.source_dir in config/profile.yml, else output/cv-approved)
  --check-document <file> Check generated HTML, TXT, or TeX content against current claims
  --json                  Print full JSON output where supported
  --strict                Exit nonzero when checked segments fail
  --help                  Show this help
`;
const EMPTY_COUNTS = Object.freeze({ asserted: 0, supported: 0, needs_review: 0, conflict: 0, stale: 0, unanchored: 0 });

function parseArgs(argv) {
  const options = { json: false, strict: false };
  const commands = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--strict') { options.strict = true; continue; }
    if (arg === '--allow-unverified-claims') { options.allowUnverifiedClaims = true; continue; }
    if (arg === '--replace-active') { options.replaceActive = true; continue; }
    if (arg === '--drift') { commands.push('drift'); continue; }
    if (['--cv', '--anchors', '--init', '--activate', '--check-document', '--approved-dir'].includes(arg)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`);
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = value;
      if (key === 'init' || key === 'activate' || key === 'checkDocument') commands.push(key);
      i += 1;
      continue;
    }
    if (arg === '--refresh') {
      commands.push('refresh');
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) options.refreshOut = argv[++i];
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (commands.length > 1) throw new Error('Choose one operation at a time');
  options.command = commands[0] || 'validate';
  if (!options.help) {
    if (['init', 'refresh'].includes(options.command) && !options.cv) throw new Error('--cv is required');
    if (options.command === 'validate' && (!options.cv || !options.anchors)) throw new Error('Use --cv and --anchors to validate');
    if (options.command === 'checkDocument' && !['.html', '.htm', '.txt', '.tex'].includes(extname(options.checkDocument).toLowerCase())) {
      throw new Error('--check-document supports HTML, TXT, or TeX files');
    }
    if (options.command === 'init' && options.strict) throw new Error('--strict does not apply to --init');
  }
  return options;
}

function qualifyOutput(path, inputHash) {
  const extension = extname(path) || '.json';
  const base = extname(path) ? path.slice(0, -extension.length) : path;
  return `${base}.${inputHash.slice(7, 19)}${extension}`;
}

async function writeNewFile(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'wx');
  try { await handle.writeFile(contents, 'utf8'); }
  finally { await handle.close(); }
}

async function readCv(path) {
  try { return await readFile(resolve(path), 'utf8'); }
  catch (error) { throw new Error(`Could not read CV: ${error.message}`); }
}

function printJson(value) { console.log(JSON.stringify(value, null, 2)); }

function documentText(source, extension) {
  if (['.html', '.htm'].includes(extension)) {
    return decodeHtml(source
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<\/?(?:br|p|div|li|ul|ol|h[1-6]|section|article|tr|td|th|header|footer|table|main)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ' '));
  }
  if (extension !== '.tex') return String(source ?? '');
  return renderedTexText(source);
}

/** Extract the template's visible arguments, never its preamble or layout values. */
export function renderedTexText(source) {
  const stripped = String(source ?? '').split(/\r?\n/).map(line => line.replace(/(?<!\\)%.*$/, '')).join('\n');
  const body = /\\begin\s*\{document\}([\s\S]*?)\\end\s*\{document\}/.exec(stripped)?.[1];
  if (body === undefined) throw new Error('tex_document_missing');
  let index = 0;
  const skipSpace = () => { while (/\s/.test(body[index] || '') && index < body.length) index++; };
  const group = (open = '{', close = '}') => {
    skipSpace();
    if (body[index] !== open) return '';
    const start = ++index;
    let depth = 1;
    while (index < body.length && depth) {
      if (body[index] === '\\') { index += 2; continue; }
      if (body[index] === open) depth++;
      if (body[index] === close) depth--;
      index++;
    }
    return body.slice(start, index - 1);
  };
  const drop = { vspace: 1, hspace: 1, color: 1, textcolor: 1, setlength: 2, addtolength: 2,
    rule: 2, raisebox: 1, includegraphics: 1, label: 1, pagestyle: 1, urlstyle: 1,
    fontsize: 2, fontfamily: 1, fontencoding: 1, geometry: 1, hypersetup: 1 };
  const contentArgs = { resumeSubheading: 4, resumeSubheadingContinue: 2, resumeProjectHeading: 2,
    resumeItem: 1, resumeSubItem: 1 };
  let output = '';
  while (index < body.length) {
    if (body[index] !== '\\') { output += body[index++]; continue; }
    index++;
    if (body[index] === '\\') { index++; output += '\n'; continue; }
    if (/[{}%$#&_]/.test(body[index] || '')) {
      output += body[index] === '$' ? '\uE001' : body[index];
      index++; continue;
    }
    const command = /^[A-Za-z]+\*?/.exec(body.slice(index))?.[0];
    if (!command) { output += ' '; index++; continue; }
    index += command.length;
    const name = command.replace(/\*$/, '');
    if (['newcommand', 'renewcommand', 'providecommand', 'def'].includes(name)) {
      skipSpace();
      if (body[index] === '{') group();
      else { const macro = /^\\[A-Za-z]+/.exec(body.slice(index))?.[0] || ''; index += macro.length; }
      skipSpace();
      while (body[index] === '[') { group('[', ']'); skipSpace(); }
      // For \def, parameter markers precede the definition body.
      while (index < body.length && body[index] !== '{') index++;
      group();
      continue;
    }
    if (name === 'begin' || name === 'end') {
      const environment = group();
      skipSpace();
      if (name === 'begin') {
        if (body[index] === '[') group('[', ']');
        if (/^(?:tabular\*?|tabularx|multicols)$/.test(environment)) {
          group(); skipSpace();
          if (body[index] === '[') group('[', ']');
          if (environment !== 'tabular' && environment !== 'multicols') group();
        }
      }
      output += '\n'; continue;
    }
    if (name === 'href') { group(); output += `{${group()}}`; continue; }
    if (name === 'textasciitilde') { output += '~'; group(); continue; }
    if (name === 'textdollar') { output += '\uE001'; group(); continue; }
    if (name === 'textbackslash') { output += '\uE002'; group(); continue; }
    if (name === 'textasciicircum') { output += '^'; group(); continue; }
    if (name === 'approx') { output += '≈'; continue; }
    if (Object.hasOwn(drop, name)) {
      skipSpace();
      while (body[index] === '[') { group('[', ']'); skipSpace(); }
      for (let count = 0; count < drop[name]; count++) group();
      continue;
    }
    if (Object.hasOwn(contentArgs, name)) {
      output += '\n';
      for (let count = 0; count < contentArgs[name]; count++) output += `${group()}\n`;
      continue;
    }
    if (/^(?:section|subsection|subsubsection)$/.test(name)) {
      const title = group(); output += `\n${title}\n`; continue;
    }
    if (name === 'item') { skipSpace(); if (body[index] === '[') group('[', ']'); output += '\n'; continue; }
    // Formatting commands have visible group contents. Recursively process these
    // below; unrecognized command names themselves never become candidate facts.
    if (!/^(?:textbf|textit|emph|underline|texttt|textrm|textsf|textnormal|mbox|hbox|normalfont|small|large|Large|LARGE|huge|Huge|tiny|footnotesize|scriptsize|normalsize|scshape|bfseries|itshape|rmfamily|sffamily|ttfamily|raggedright|raggedleft|centering|hfill|vfill|quad|qquad|newline|linebreak|noindent|selectfont|faEnvelope|faLinkedin|faGithub|resumeSubHeadingListStart|resumeSubHeadingListEnd|resumeItemListStart|resumeItemListEnd|pm|rightarrow)$/.test(name)) {
      throw new Error(`unsupported_tex_command:${name}`);
    }
  }
  if (/\\[A-Za-z]+/.test(output)) output = renderedTexText(`\\begin{document}${output}\\end{document}`);
  return output.replace(/[{}$]/g, ' ').replace(/~(?!\s*\d)/g, ' ').replace(/\uE001/g, '$').replace(/\uE002/g, '\\');
}

function decodeHtml(value) {
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    if (/^#x/i.test(entity)) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (/^#/.test(entity)) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[entity.toLowerCase()] ?? whole;
  });
}

/** Split rendered text into one factual sentence or bullet per validation call. */
export function extractDocumentSegments(source, filePath = 'document.txt', options = {}) {
  if (extname(filePath).toLowerCase() === '.tex' && !options.allowUnverifiedClaims) enforceTrustedTexDefinitions(source);
  const text = documentText(source, extname(filePath).toLowerCase());
  const segments = [];
  let inSkills = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim().replace(/^(?:[-*+•▪◦‣]|\d+[.)])\s+/, '');
    if (!line) continue;
    if (isStandardCvLabel(line)) {
      inSkills = /^(?:skills|technical skills|taidot|tekniset taidot|kenntnisse|fähigkeiten|technische kenntnisse)$/i.test(line) || isSkillsCategoryLabel(line);
      continue;
    }
    const category = /^([^:]+):\s*(.*)$/.exec(line);
    if (category && (inSkills || isSkillsCategoryLabel(category[1]))) {
      if (!isSkillsCategoryLabel(category[1])) segments.push(...splitClaimSentences(category[1]));
      segments.push(...category[2].split(/[,|·/;]/).map(item => item.trim()).filter(Boolean));
    } else if (inSkills) segments.push(...line.split(/[,|·/;]/).map(item => item.trim()).filter(Boolean));
    else segments.push(...(technologyListSegments(line) || splitClaimSentences(line)));
  }
  return segments;
}

/** Shared CLI claim flags; PDF's --cv is a mode flag, --cv-source supplies evidence. */
export function claimRenderOptions(argv) {
  const options = { cvPath: 'cv.md', anchorsPath: ACTIVE_MANIFEST, allowUnverifiedClaims: false, cvMode: false, documentType: 'cv' };
  const args = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--allow-unverified-claims') options.allowUnverifiedClaims = true;
    else if (arg === '--cv') options.cvMode = true;
    else if (arg.split('=')[0] === '--document-type') {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++index];
      if (!['cover', 'report', 'other'].includes(value)) throw new Error('--document-type requires cover, report, or other');
      options.documentType = value;
    }
    else if (['--cv-source', '--anchors', '--manifest'].includes(arg.split('=')[0])) {
      const [flag, inline] = arg.split('=');
      const value = inline ?? argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path`);
      options[flag === '--cv-source' ? 'cvPath' : 'anchorsPath'] = value;
    } else args.push(arg);
  }
  return { args, options };
}

export async function enforceRenderedCvClaims(segments, options = {}) {
  const contentHash = sha256(JSON.stringify(segments));
  if (options.allowUnverifiedClaims) {
    const warning = 'WARNING: --allow-unverified-claims bypasses CV fact validation. Output contains UNVERIFIED CLAIMS.';
    console.error(warning);
    return { status: 'unverified', allowUnverifiedClaims: true, warning, contentHash };
  }
  const cv = await readCv(options.cvPath || 'cv.md');
  let manifest;
  try { manifest = await loadManifest(resolve(options.anchorsPath || ACTIVE_MANIFEST)); }
  catch (error) { throw new Error(`CV claim validation blocked: manifest_load_failed:${error.message}`); }
  const checked = validateClaims({ claims: segments.map((text, index) => ({ id: `render-${index + 1}`, text })), manifest, cv });
  if (!checked.ok) throw new Error(`CV claim validation failed: ${JSON.stringify(checked.results.filter(item => item.status !== 'pass'))}`);
  return { status: 'pass', allowUnverifiedClaims: false, contentHash, cvHash: sha256(cv), manifestHash: sha256(JSON.stringify(manifest)), checked: segments.length };
}

async function initDraft({ cvText, cvPath, outputPath, json }) {
  const manifest = createDraftManifest(cvText, 'cv.md');
  const draftPath = resolve(qualifyOutput(resolve(outputPath), manifest.cv.inputHash));
  try { await writeNewFile(draftPath, `${JSON.stringify(manifest, null, 2)}\n`); }
  catch (error) {
    const result = { status: 'blocked', error: error.code === 'EEXIST' ? 'init_collision' : `init_write_failed:${error.message}` };
    if (json) printJson(result); else console.error(result.error);
    process.exitCode = 1;
    return;
  }
  const report = await buildValidationReport({ cvText, cvPath, manifest, root: process.cwd() });
  if (json) printJson({ ...report, draftPath });
  else {
    console.log(`CV claim draft: ${report.status}; ${report.claims.length} asserted claims`);
    console.log(`Draft manifest written: ${draftPath}`);
  }
}

async function refreshDraft({ cvText, cvPath, outputPath, activePath, json }) {
  const active = await loadManifest(resolve(activePath));
  const comparison = await buildValidationReport({ cvText, cvPath, manifest: active, root: process.cwd() });
  const draft = createDraftManifest(cvText, 'cv.md');
  for (const entry of draft.claims) {
    const previous = active.claims.find((old) => old.id === entry.id && old.textHash === entry.textHash && old.type === entry.type);
    if (previous) entry.evidence.push(...previous.evidence.filter((ref) => ref.path !== 'cv.md'));
  }
  const draftPath = resolve(qualifyOutput(resolve(outputPath), draft.cv.inputHash));
  await writeNewFile(draftPath, `${JSON.stringify(draft, null, 2)}\n`);
  const staleClaims = comparison.claims.filter((claim) => claim.state === 'stale');
  const result = {
    schemaVersion: 1, operation: 'refresh', status: 'review_required', draftPath,
    counts: {
      asserted: draft.claims.length,
      unchanged: comparison.delta.unchanged.length,
      added: comparison.delta.added.length,
      changed: comparison.delta.changed.length,
      removed: comparison.delta.removed.length,
      stale: staleClaims.length,
    },
    delta: comparison.delta,
    staleClaims,
    draftClaims: draft.claims.map(({ id, type, text, state, evidence }) => ({ id, type, text, state, evidence })),
  };
  if (json) printJson(result);
  else console.log(`CV claim refresh: ${result.counts.asserted} asserted; ${result.counts.unchanged} unchanged; ${result.counts.added} new; ${result.counts.changed} changed; ${result.counts.removed} removed/stale. Draft: ${draftPath}`);
}

async function activateDraft(draftPath, activePath, replaceActive, json) {
  const source = resolve(draftPath);
  const active = resolve(activePath);
  if (source === active) throw new Error('activation_source_is_active_manifest');
  const manifest = await loadManifest(source);
  if (validateManifest(manifest).length) throw new Error('draft_manifest_invalid');
  await mkdir(dirname(active), { recursive: true });
  let existing = false;
  try { await stat(active); existing = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && !replaceActive) throw new Error('active_manifest_exists_use_--replace-active');
  let backupPath = null;
  if (existing) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const extension = extname(active) || '.json';
    const base = active.slice(0, -extension.length);
    for (let suffix = 0; ; suffix += 1) {
      const candidate = `${base}.${stamp}${suffix ? `-${suffix}` : ''}${extension}`;
      try { await stat(candidate); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        backupPath = candidate;
        break;
      }
    }
    await rename(active, backupPath);
  }
  try { await rename(source, active); }
  catch (error) {
    if (backupPath) await rename(backupPath, active).catch(() => {});
    throw new Error(`activation_failed:${error.message}`);
  }
  const result = { status: 'activated', activePath: active, backupPath, claims: manifest.claims.length };
  if (json) printJson(result); else console.log(`Activated ${result.claims} claims at ${active}${backupPath ? `; previous manifest backed up to ${backupPath}` : ''}`);
}

function metricKey(value) { return String(value).toLowerCase().replace(/\s+/g, ''); }

function missingFromCv(fact, cvText) {
  if (fact.type === 'technology') {
    // Match against the canonical vocabulary rather than requiring the same alias spelling.
    const cvTech = new Set();
    const aliases = extractDriftFacts(cvText).filter((candidate) => candidate.type === 'technology');
    for (const candidate of aliases) cvTech.add(candidate.key);
    return !cvTech.has(fact.key);
  }
  if (fact.type === 'metric') {
    const cvMetrics = extractDriftFacts(cvText).filter((candidate) => candidate.type === 'metric');
    return !cvMetrics.some((candidate) => metricKey(candidate.text) === metricKey(fact.text));
  }
  return !String(cvText).normalize('NFKC').toLowerCase().includes(fact.text.normalize('NFKC').toLowerCase());
}

export function compareDriftFacts(cvText, pdfText) {
  return extractDriftFacts(pdfText).filter((fact) => missingFromCv(fact, cvText))
    .map(({ type, text }) => ({ type, text, state: 'needs_review' }));
}

async function extractPdfText(path) {
  try {
    const { stdout } = await execFile('pdftotext', ['-layout', path, '-'], { maxBuffer: 20 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('pdf_text_extractor_unavailable: pdftotext is required for drift reports');
    throw new Error(`pdf_text_extraction_failed:${error.message}`);
  }
}

async function defaultApprovedDir() {
  try {
    const { default: yaml } = await import('js-yaml');
    const profile = yaml.load(await readFile('config/profile.yml', 'utf8')) || {};
    return profile.cv?.approved_system?.source_dir || 'output/cv-approved';
  } catch {
    return 'output/cv-approved';
  }
}

async function driftReport({ cvText, cvPath, activePath, approvedDir, json }) {
  let manifestComparison = { status: 'missing' };
  try {
    const active = await loadManifest(resolve(activePath));
    const current = await buildValidationReport({ cvText, cvPath, manifest: active, root: process.cwd() });
    manifestComparison = {
      status: 'loaded', validationStatus: current.status,
      cvHashMatches: active.cv.inputHash === sha256(String(cvText).replace(/^\uFEFF/, '')),
      counts: current.counts,
      delta: Object.fromEntries(Object.entries(current.delta).map(([key, value]) => [key, value.length])),
    };
  } catch (error) {
    if (error.code !== 'ENOENT') manifestComparison = { status: 'invalid', error: error.message.split(':')[0] };
  }
  let files;
  try { files = (await readdir(approvedDir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')).map((entry) => resolve(approvedDir, entry.name)).sort(); }
  catch (error) { throw new Error(`approved_pdf_directory_unreadable:${error.message}`); }
  const pdfs = [];
  for (const file of files) {
    try {
      const text = await extractPdfText(file);
      const facts = compareDriftFacts(cvText, text);
      pdfs.push({ file: basename(file), facts });
    } catch (error) { pdfs.push({ file: basename(file), facts: [], error: error.message }); }
  }
  const factCount = pdfs.reduce((count, pdf) => count + pdf.facts.length, 0);
  const errors = pdfs.filter((pdf) => pdf.error).length;
  const result = {
    schemaVersion: 1, operation: 'drift', status: errors ? 'partial' : 'review_required',
    input: { cvPath, hash: sha256(String(cvText).replace(/^\uFEFF/, '')) },
    activeManifest: manifestComparison,
    summary: `${files.length} approved PDFs checked; ${factCount} PDF facts absent from cv.md need review${errors ? `; ${errors} extraction errors` : ''}.`,
    counts: { pdfs: files.length, needs_review: factCount, extraction_errors: errors },
    pdfs,
  };
  if (json) printJson(result);
  else {
    console.log(result.summary);
    for (const pdf of pdfs) for (const fact of pdf.facts) console.log(`${pdf.file}: needs_review [${fact.type}] ${fact.text}`);
    for (const pdf of pdfs) if (pdf.error) console.log(`${pdf.file}: ${pdf.error}`);
  }
  if (errors) process.exitCode = 1;
}

async function checkDocument({ filePath, cvText, cvPath, activePath, strict, allowUnverifiedClaims }) {
  const source = await readFile(resolve(filePath), 'utf8');
  if (allowUnverifiedClaims) {
    printJson(await enforceRenderedCvClaims([source], { allowUnverifiedClaims: true }));
    return;
  }
  const segments = extractDocumentSegments(source, filePath);
  let manifest;
  try { manifest = await loadManifest(resolve(activePath)); }
  catch (error) { throw new Error(`manifest_load_failed:${error.message}`); }
  const failures = [];
  for (const [index, text] of segments.entries()) {
    const checked = validateClaims({ claims: [{ id: `segment-${index + 1}`, text }], manifest, cv: cvText });
    const result = checked.results[0];
    if (result?.status !== 'pass') failures.push({ segment: index + 1, text, reasonCode: result?.reasonCode || 'validation_failed' });
  }
  const output = {
    schemaVersion: 1, operation: 'check-document', status: failures.length ? 'review_required' : 'pass',
    input: { file: filePath, cv: cvPath, segments: segments.length },
    summary: `${segments.length} segments checked; ${failures.length} need review.`,
    counts: { checked: segments.length, passed: segments.length - failures.length, failed: failures.length },
    failures,
  };
  printJson(output);
  if (strict && failures.length) process.exitCode = 1;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { console.error(error.message); console.error('Run with --help for usage.'); process.exitCode = 2; return; }
  if (options.help) { console.log(HELP); return; }
  const activePath = options.anchors || ACTIVE_MANIFEST;

  if (options.command === 'activate') {
    try { await activateDraft(options.activate, activePath, Boolean(options.replaceActive), options.json); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    return;
  }

  const cvPath = options.cv || 'cv.md';
  let cvText;
  try { cvText = await readCv(cvPath); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }

  if (options.command === 'init') {
    try { await initDraft({ cvText, cvPath, outputPath: options.init, json: options.json }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    return;
  }
  if (options.command === 'refresh') {
    try { await refreshDraft({ cvText, cvPath, outputPath: options.refreshOut || 'output/cv-claim-anchors-refresh.json', activePath, json: options.json }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    return;
  }
  if (options.command === 'drift') {
    try { await driftReport({ cvText, cvPath, activePath, approvedDir: resolve(options.approvedDir || await defaultApprovedDir()), json: options.json }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    return;
  }
  if (options.command === 'checkDocument') {
    try { await checkDocument({ filePath: options.checkDocument, cvText, cvPath, activePath, strict: options.strict, allowUnverifiedClaims: options.allowUnverifiedClaims }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    return;
  }

  let manifest;
  try { manifest = await loadManifest(resolve(options.anchors)); }
  catch (error) {
    const report = { schemaVersion: 1, status: 'blocked', counts: { ...EMPTY_COUNTS }, claims: [], delta: { added: [], unchanged: [], changed: [], removed: [] }, errors: [error.message.split(':')[0]] };
    printJson(report);
    process.exitCode = 1;
    return;
  }
  const report = await buildValidationReport({ cvText, cvPath, manifest, root: process.cwd() });
  if (options.json) printJson(report);
  else {
    const counts = Object.entries(report.counts).map(([state, count]) => `${state}=${count}`).join(' ');
    console.log(`CV claim check: ${report.status}; ${counts}`);
    if (report.errors?.length) console.error(`Manifest errors: ${report.errors.join(', ')}`);
  }
  if (report.status === 'blocked' || (options.strict && report.status !== 'pass')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`CV claim check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
