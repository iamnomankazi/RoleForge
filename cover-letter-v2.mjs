#!/usr/bin/env node

/** Deterministic cover-letter checks and collision-safe text/PDF rendering. */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { hasFactUnits, splitClaimSentences } from './cv-claims.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = resolve(ROOT, 'output', 'cover-letters');
const APPROVED_OUTPUT_DIR = resolve(ROOT, 'output', 'cv-approved');
const V2_TEMPLATE = resolve(ROOT, 'templates', 'cover-letter-v2-template.html');

// These are generic wording patterns already called out by the system cover
// mode. User-specific additions are read from voice-dna.md and _profile.md at
// runtime and are deliberately not copied into this source file.
export const SYSTEM_BANNED_PHRASES = Object.freeze([
  'leverage', 'synergy', 'seamless', 'holistic', 'robust', 'cutting-edge',
  'spearheaded', 'championed', 'orchestrated', 'passionate', 'excited',
  'stakeholder alignment', 'data-driven', 'actionable insights',
  'move the needle', 'north star', 'unique opportunity', 'perfect fit',
  'strong track record', 'i am pleased to', 'i am writing to express',
  'i am excited to', 'i am thrilled to',
]);

const STOPWORDS = Object.freeze({
  en: new Set(('a an and are as at be been being by for from had has have he her hers him his i in into is it its me my of on or our ours she that the their theirs them then there these they this those to was we were what when where which who will with would you your').split(' ')),
  fi: new Set(('aiemmin aika aina aivan alkaa alkaa alkoi alle alueella eri et että hän he hei heitä heidän heille heillä hänelle hänellä hänestä ja jo jos jossa jonka jotta joko kanssa kautta kun kuin kuka kaikki kaksi kuitenkaan koska myös niitä ne näin oli olla ovat on ollut mutta niin sekä tai tai tätä tämä nämä niiden niiden nyt olla olen olet olemme olette ovat voi voivat voi').split(' ')),
  de: new Set(('aber alle allem allen aller alles als also am an andere auch auf aus bei bin bis bist da dadurch daher darum das dass dein deine dem den der des die dies diese dieser doch dort du durch ein eine einem einen einer eines er es etwas für gegen gewesen hat hatte haben hier hin ich im in ist ja jede jedem jeden jeder jedes kann kein keine können könnte man mehr mich mir mit muss nach nicht nichts noch nun nur ob oder ohne sehr sein seine selbst sich sie sind so solche und unser unsere unter vom von vor war waren was weg weil weiter welche wenn werde werden wie wieder wir wird wo zu zum zur über').split(' ')),
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function draftHash(draft) {
  return sha256(stableStringify(draft));
}

function normalizeSpace(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function safeSlug(value, fallback) {
  return String(value || fallback)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 64).replace(/_+$/g, '') || fallback;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function textParts(draft) {
  const parts = [];
  if (draft.greeting) parts.push(String(draft.greeting).trim());
  for (const paragraph of Array.isArray(draft.paragraphs) ? draft.paragraphs : []) {
    if (paragraph?.text) parts.push(String(paragraph.text).trim());
  }
  if (draft.closing) parts.push(String(draft.closing).trim());
  if (draft.signature) parts.push(String(draft.signature).trim());
  return parts.filter(Boolean);
}

export function renderDraftText(draft) {
  const body = textParts(draft).join('\n\n');
  return `${String(draft.company ?? '').trim()}\n${String(draft.role ?? '').trim()}\n\n${body}\n`;
}

function wordCount(value) {
  return (String(value ?? '').match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) || []).length;
}

function bodyText(draft) {
  const paragraphs = Array.isArray(draft.paragraphs) ? draft.paragraphs : [];
  return [draft.greeting, ...paragraphs.map(item => item?.text), draft.closing]
    .filter(value => typeof value === 'string')
    .join(' ');
}

function sentenceList(value) {
  return splitClaimSentences(value);
}

function flattenClaims(draft) {
  return [...(Array.isArray(draft?.claims) ? draft.claims : []),
    ...(Array.isArray(draft?.paragraphs) ? draft.paragraphs : [])
      .flatMap(paragraph => Array.isArray(paragraph?.claims) ? paragraph.claims : [])];
}

function phrasePattern(phrase) {
  const escaped = String(phrase).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu');
}

function parseVoiceDna(text) {
  const lines = String(text).split(/\r?\n/);
  const heading = lines.findIndex(line => /^##\s+3\.?\s+BANNED LIST\s*$/i.test(line));
  if (heading < 0) return [];
  const section = [];
  for (let index = heading + 1; index < lines.length && !/^##\s/.test(lines[index]); index++) section.push(lines[index]);
  // The word list is the comma-separated line (prose lines such as instructions are not phrases).
  const commas = line => (line.match(/,/g) || []).length;
  const listLine = section.filter(line => line.trim() && !/^Also banned:/i.test(line) && !/^#/.test(line) && commas(line))
    .sort((a, b) => commas(b) - commas(a))[0] || '';
  const entries = listLine.split(',')
    .map(item => item.trim().replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[.;:]+$/, '').trim().replace(/^['"`]|['"`]$/g, ''))
    .flatMap(item => item.split('/').map(part => part.trim()))
    .filter(Boolean);
  // "Also banned" lists constructions before its explanation ("... when used to avoid "is" ..."); the
  // words recommended instead are not banned.
  const alsoBanned = (section.find(line => /^Also banned:/i.test(line))?.replace(/^Also banned:\s*/i, '') || '')
    .split(/\bwhen used\b/i)[0];
  const constructions = [...alsoBanned.matchAll(/"([^"]+)"/g)].map(matchItem => matchItem[1].replace(/[,.;:]+$/, '').trim());
  return [...entries, ...constructions].filter(Boolean);
}

function parseProfileAvoid(text) {
  const lines = String(text).split(/\r?\n/);
  const entries = [];
  let inAvoid = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      inAvoid = /\b(?:avoid|banned|ban list|generic phrases)\b/i.test(line);
      continue;
    }
    if (/^\s*(?:avoid|banned phrases?|generic phrases)\s*:\s*/i.test(line)) {
      inAvoid = true;
      continue;
    }
    if (inAvoid && !line.trim()) {
      inAvoid = false;
      continue;
    }
    if (!inAvoid) continue;
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bullet) {
      const quoted = [...bullet[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map(item => item[1]);
      entries.push(...(quoted.length ? quoted : [bullet[1].replace(/[.;]$/, '').trim()]));
    }
  }
  return entries;
}

export async function loadBannedPhrases({ root = ROOT, userLayerDir = root } = {}) {
  const phrases = [...SYSTEM_BANNED_PHRASES];
  for (const [file, parser] of [
    [join(userLayerDir, 'voice-dna.md'), parseVoiceDna],
    [join(userLayerDir, 'modes', '_profile.md'), parseProfileAvoid],
  ]) {
    try {
      phrases.push(...parser(await readFile(file, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return [...new Map(phrases.map(phrase => [normalizeSpace(phrase), String(phrase).trim()])).values()]
    .filter(Boolean);
}

export function detectLanguage(text) {
  const tokens = String(text ?? '').toLowerCase().match(/[\p{L}]+/gu) || [];
  const scores = Object.fromEntries(Object.entries(STOPWORDS).map(([language, stopwords]) => [
    language,
    tokens.length ? tokens.filter(token => stopwords.has(token)).length / tokens.length : 0,
  ]));
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const likely = tokens.length >= 20 && ranked[0][1] >= 0.025 && ranked[0][1] - ranked[1][1] >= 0.008
    ? ranked[0][0]
    : null;
  return { language: likely, scores, tokenCount: tokens.length };
}

function requiredLanguage(jdText) {
  const clauses = String(jdText ?? '').split(/[.!?;\n]|,(?!\s*(?:speak|read|write|understand|communicate)\b)|\b(?:but|however|whereas)\b|\band\s+(?=[\p{L}]+\s+(?:is\s+)?(?:optional|required|mandatory|essential|not|a\s+plus|nice[- ]to[- ]have)\b)/iu);
  const found = new Set();
  const names = [
    ['fi', 'Finnish|Suomi'],
    ['de', 'German|Deutsch'],
  ];
  for (const [code, name] of names) {
    const patterns = [
      new RegExp(`\\b(?:${name})(?:\\s+(?:language|skills?|fluency|proficiency|knowledge))?(?:\\s+(?:at\\s+)?(?:level\\s+)?(?:A1|A2|B1|B2|C1|C2))?\\s*(?:is\\s+)?(?:required|mandatory|essential|must[- ]have)\\b`, 'i'),
      new RegExp(`\\b(?:required|mandatory|essential|must\\s+(?:speak|know|have))[^.!?;\\n]{0,45}\\b(?:${name})\\b`, 'i'),
      new RegExp(`\\b(?:${name})\\s+(?:at\\s+)?(?:A1|A2|B1|B2|C1|C2)\\s+(?:or\\s+above\\s+)?(?:is\\s+)?required\\b`, 'i'),
    ];
    if (code === 'fi') {
      patterns.push(/\b(?:suomen\s+kielen\s+taito|suomi)\b[^.!?\n]{0,40}\b(?:vaaditaan|edellytetään|pakollinen)\b/i);
    }
    if (code === 'de') {
      patterns.push(/\bdeutschkenntnisse\b[^.!?\n]{0,40}\b(?:erforderlich|vorausgesetzt|notwendig)\b/i);
    }
    if (clauses.some(clause => !/\b(?:optional|a plus|nice[- ]to[- ]have|not (?:a )?requirement|not (?:required|mandatory|essential)|no (?:requirement|need)|need not|do(?:es)? not|don['’]t|isn['’]t|aren['’]t|nicht|kein\w*)\b/i.test(clause)
      && patterns.some(pattern => pattern.test(clause)))) found.add(code);
  }
  return found.size === 1 ? [...found][0] : found.size > 1 ? 'ambiguous' : 'en';
}

function isPlaceholder(text) {
  return /\{[^{}]*\}|\[[^\]]+\]|\bTODO\b|\bXXX\b|\bLorem(?:\s+ipsum)?\b/i.test(text);
}

function isFirstPerson(text) {
  return /\b(?:I(?:['’](?:m|ve))?|my|me|myself)\b/i.test(text);
}

function isJdContext(sentence, jdText) {
  return !isFirstPerson(sentence) && sentenceList(jdText).some(item => normalizeSpace(item) === normalizeSpace(sentence));
}

function isIntentOrCourtesy(sentence) {
  if (/^thank you(?: for (?:your time|considering my application|considering me))?[.!]?$/i.test(sentence)) return true;
  const match = /^(?:I(?: am|['’]m)? (?:applying|interested|excited|available)|I (?:look forward|would welcome)|thank you)\b([^.!?]{0,160})[.!?]?$/i.exec(sentence);
  return Boolean(match && !isFirstPerson(match[1]) && !hasFactUnits(match[1]));
}

function hasClaimCoverage(draft, profileName, jdText) {
  const missing = [];
  const claimTexts = flattenClaims(draft).filter(claim => typeof claim?.text === 'string').map(claim => normalizeSpace(claim.text));
  const signature = String(draft.signature ?? '').trim();
  const plainName = /^(?:[\p{Lu}][\p{L}'’-]+\.?)(?:\s+[\p{Lu}][\p{L}'’-]+\.?){1,4}$/u.test(signature)
    && signature.split(/\s+/).every(part => !hasFactUnits(part));
  const fields = [
    ['greeting', draft.greeting],
    ...(draft.paragraphs || []).map((paragraph, index) => [`paragraph-${index + 1}`, paragraph?.text]),
    ['closing', draft.closing],
    ...(normalizeSpace(signature) === normalizeSpace(profileName) || plainName ? [] : [['signature', signature]]),
  ];
  for (const [field, text] of fields) {
    for (const sentence of sentenceList(text)) {
      const normalizedSentence = normalizeSpace(sentence);
      if (isJdContext(sentence, jdText) || isIntentOrCourtesy(sentence)) continue;
      if (!isFirstPerson(sentence) && !hasFactUnits(sentence)) continue;
      if (!claimTexts.includes(normalizedSentence)) {
        missing.push({ field, sentence });
      }
    }
  }
  return missing;
}

function check(id, status, details = {}) {
  const result = { id, status, ...details };
  if (status === 'pass') delete result.reasonCode;
  return result;
}

function statusFor(checks) {
  if (checks.some(item => item.status === 'blocked')) return 'blocked';
  if (checks.some(item => item.status === 'fail')) return 'fail';
  if (checks.some(item => item.status === 'review_required')) return 'review_required';
  return 'pass';
}

export async function checkCoverLetterDraft(draft, {
  jdText = '',
  jdCompany,
  jdRole,
  profileName,
  validateClaims,
  manifest,
  cv,
  validatorError,
  bannedPhrases = SYSTEM_BANNED_PHRASES,
} = {}) {
  const checks = [];
  const validDraft = draft && typeof draft === 'object' && !Array.isArray(draft);
  const candidateText = validDraft ? renderDraftText(draft) : '';
  const normalizedDraft = validDraft ? draft : {};
  const actualBody = bodyText(normalizedDraft);
  const count = wordCount(actualBody);

  checks.push(check('draft_shape', validDraft && typeof draft.company === 'string' && typeof draft.role === 'string'
    && Array.isArray(draft.paragraphs) && draft.paragraphs.length > 0
    && draft.paragraphs.every(paragraph => paragraph && typeof paragraph.text === 'string')
    && typeof draft.closing === 'string' && typeof draft.signature === 'string'
    ? 'pass' : 'fail', { reasonCode: 'invalid_draft_shape' }));

  const company = String(normalizedDraft.company ?? '').trim();
  const role = String(normalizedDraft.role ?? '').trim();
  const companyMatches = Boolean(company && typeof jdCompany === 'string' && jdCompany.trim()
    && normalizeSpace(company) === normalizeSpace(jdCompany) && phrasePattern(jdCompany).test(jdText));
  // Scraped pages often glue the title to its neighbours ("jobsSmartly Launchpad", "ContextHelsinki"), so a role may
  // also match where a lowercase letter runs into a capitalized word. The role must still equal the canonical role.
  const degluedJd = String(jdText ?? '').replace(/([\p{Ll})\]])(?=\p{Lu}\p{Ll}{2,})/gu, '$1 ');
  const roleMatches = Boolean(role && typeof jdRole === 'string' && jdRole.trim()
    && normalizeSpace(role) === normalizeSpace(jdRole)
    && (phrasePattern(jdRole).test(jdText) || phrasePattern(jdRole).test(degluedJd)));
  checks.push(check('company_matches_jd', companyMatches ? 'pass' : 'fail', { reasonCode: 'company_mismatch' }));
  checks.push(check('role_matches_jd', roleMatches ? 'pass' : 'fail', { reasonCode: 'role_mismatch' }));

  const phraseMatches = [...new Set(bannedPhrases.filter(phrase => phrase && phrasePattern(phrase).test(candidateText)))];
  checks.push(check('banned_phrases', phraseMatches.length ? 'fail' : 'pass', {
    reasonCode: phraseMatches.length ? 'banned_phrase' : undefined,
    matches: phraseMatches,
  }));

  checks.push(check('body_word_count', count >= 180 && count <= 260 ? 'pass' : 'fail', {
    wordCount: count, minimum: 180, maximum: 260, reasonCode: 'body_length_out_of_range',
  }));

  const requestedLanguage = String(normalizedDraft.language || 'en').toLowerCase();
  const expected = requiredLanguage(jdText);
  const detected = detectLanguage(actualBody);
  let languageStatus = 'pass';
  let languageReason;
  if (detected.language === null) {
    languageStatus = 'review_required';
    languageReason = 'ambiguous_language';
  } else if (expected === 'ambiguous') {
    languageStatus = 'review_required';
    languageReason = 'ambiguous_jd_language_requirement';
  } else if (!['en', 'fi', 'de'].includes(requestedLanguage)
    || requestedLanguage !== expected || detected.language !== requestedLanguage) {
    languageStatus = 'fail';
    languageReason = 'language_policy_mismatch';
  }
  checks.push(check('language', languageStatus, {
    requested: requestedLanguage, detected: detected.language, requiredByJd: expected,
    scores: detected.scores, tokenCount: detected.tokenCount, reasonCode: languageReason,
  }));

  const placeholders = isPlaceholder(candidateText);
  checks.push(check('placeholders', placeholders ? 'fail' : 'pass', {
    reasonCode: placeholders ? 'placeholder_found' : undefined,
  }));

  // JD context has its own authority; it is never submitted as a CV fact.
  const allClaims = flattenClaims(normalizedDraft);
  const claims = allClaims.filter(claim => !isJdContext(claim?.text, jdText));
  const invalidClaims = allClaims.filter(claim => !claim || typeof claim.id !== 'string' || !claim.id.trim()
    || typeof claim.text !== 'string' || !claim.text.trim());
  const ids = allClaims.map(claim => String(claim?.id ?? '')).filter(Boolean);
  const candidateIds = claims.map(claim => claim?.id);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  const missingCoverage = hasClaimCoverage(normalizedDraft, profileName, jdText);
  checks.push(check('claim_coverage', claims.length && !invalidClaims.length && !duplicateIds.length && !missingCoverage.length
    ? 'pass' : 'fail', {
    reasonCode: !claims.length ? 'claims_missing' : invalidClaims.length ? 'invalid_claim' : duplicateIds.length
      ? 'duplicate_claim_id' : 'candidate_sentence_without_claim',
    missingSentences: missingCoverage,
    invalidClaimCount: invalidClaims.length,
    duplicateIds: [...new Set(duplicateIds)],
  }));

  if (typeof validateClaims !== 'function') {
    checks.push(check('claim_validation', 'blocked', {
      reasonCode: 'claims_validator_missing',
      message: validatorError || 'No claim validator is available; provide --claims-validator or add ./cv-claims.mjs.',
    }));
  } else {
    try {
      const result = await validateClaims({ claims, manifest, cv, jdText });
      const results = Array.isArray(result?.results) ? result.results : [];
      const byId = new Map(results.map(item => [item?.claimId, item]));
      const duplicateResults = results.filter((item, index) => results.findIndex(other => other?.claimId === item?.claimId) !== index)
        .map(item => item?.claimId ?? null);
      const missingResults = claims.filter(claim => !byId.has(claim?.id)).map(claim => claim?.id ?? null);
      const failedResults = results.filter(item => item?.status !== 'pass');
      const extraResults = results.filter(item => !candidateIds.includes(item?.claimId)).map(item => item?.claimId ?? null);
      const isOk = result?.ok === true && claims.length > 0 && results.length === claims.length
        && !missingResults.length && !failedResults.length && !extraResults.length && !duplicateResults.length;
      checks.push(check('claim_validation', isOk ? 'pass' : 'fail', {
        reasonCode: duplicateResults.length ? 'duplicate_claim_result' : missingResults.length ? 'claim_result_missing' : extraResults.length ? 'unexpected_claim_result'
          : 'claim_validation_failed',
        missingResults, failedResults, extraResults, duplicateResults,
      }));
    } catch (error) {
      checks.push(check('claim_validation', 'blocked', {
        reasonCode: 'claims_validator_threw', message: error?.message || String(error),
      }));
    }
  }

  const jdHash = sha256(String(jdText));
  checks.push(check('jd_hash', !normalizedDraft.jd?.hash || normalizedDraft.jd.hash === jdHash ? 'pass' : 'fail', {
    expectedHash: normalizedDraft.jd?.hash || undefined, actualHash: jdHash,
    reasonCode: 'jd_hash_mismatch',
  }));

  const result = statusFor(checks);
  return {
    status: result,
    ok: result === 'pass',
    draftHash: draftHash(normalizedDraft),
    jdHash,
    bodyWordCount: count,
    checks,
    text: candidateText,
  };
}

function buildHtml(draft) {
  let html = readFileSync(V2_TEMPLATE, 'utf8');
  const replacements = {
    '{{LANG}}': escapeHtml(draft.language || 'en'),
    '{{COMPANY}}': escapeHtml(String(draft.company).trim()),
    '{{ROLE}}': escapeHtml(String(draft.role).trim()),
    '{{GREETING}}': draft.greeting ? `<p class="greeting">${escapeHtml(String(draft.greeting).trim())}</p>` : '',
    '{{PARAGRAPHS}}': draft.paragraphs.map(paragraph => `<p>${escapeHtml(String(paragraph.text).trim())}</p>`).join('\n'),
    '{{CLOSING}}': draft.closing ? `<p>${escapeHtml(String(draft.closing).trim())}</p>` : '',
    '{{SIGNATURE}}': draft.signature ? `<p class="signature">${escapeHtml(String(draft.signature).trim())}</p>` : '',
  };
  return html.replace(/\{\{[A-Z_]+\}\}/g, token => replacements[token] ?? token);
}

function isWithin(path, directory) {
  const rel = relative(directory, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function writeReserved(path, contents) {
  await writeFile(path, contents, { encoding: 'utf8', flag: 'w' });
}

export async function runCoverLetterV2(draft, {
  jdText = '',
  jdCompany,
  jdRole,
  profileName,
  validateClaims,
  manifest,
  cv,
  validatorError,
  bannedPhrases,
  outputDirectory = DEFAULT_OUTPUT_DIR,
  renderHtmlToPdf,
} = {}) {
  const phrases = bannedPhrases || await loadBannedPhrases();
  const checked = await checkCoverLetterDraft(draft, {
    jdText, jdCompany, jdRole, profileName, validateClaims, manifest, cv, validatorError, bannedPhrases: phrases,
  });
  if (!checked.ok) return checked;

  const shortHash = checked.draftHash.slice(0, 12);
  const basename = `${safeSlug(draft.company, 'company')}_${safeSlug(draft.role, 'role')}_cover-v2_${shortHash}`;
  const outputDir = resolve(outputDirectory);
  if (isWithin(outputDir, APPROVED_OUTPUT_DIR)) {
    return { ...checked, status: 'blocked', ok: false, checks: [...checked.checks,
      check('output_path', 'blocked', { reasonCode: 'approved_output_forbidden' })] };
  }
  const paths = {
    text: join(outputDir, `${basename}.txt`),
    pdf: join(outputDir, `${basename}.pdf`),
    check: join(outputDir, `${basename}.check.json`),
  };
  await mkdir(outputDir, { recursive: true });
  const reserved = [];
  try {
    // The PDF renderer creates its own target exclusively, so only check it here.
    if (existsSync(paths.pdf)) throw Object.assign(new Error('output exists'), { code: 'EEXIST' });
    for (const path of [paths.text, paths.check]) {
      const handle = await open(path, 'wx');
      await handle.close();
      reserved.push(path);
    }
  } catch (error) {
    await Promise.all(reserved.map(path => rm(path, { force: true })));
    if (error?.code === 'EEXIST') {
      return { ...checked, status: 'blocked', ok: false, checks: [...checked.checks,
        check('output_collision', 'blocked', { reasonCode: 'output_exists', paths })] };
    }
    throw error;
  }

  try {
    const renderer = renderHtmlToPdf || (await import('./generate-pdf.mjs')).renderHtmlToPdf;
    await renderer(buildHtml(draft), paths.pdf, { format: 'a4', recordManifest: false, baseDir: ROOT });
    reserved.push(paths.pdf);
    const pdfBytes = await readFile(paths.pdf);
    const pdf = await PDFDocument.load(pdfBytes);
    const pageCount = pdf.getPageCount();
    const onePage = check('pdf_one_page', pageCount === 1 ? 'pass' : 'fail', {
      pageCount, reasonCode: 'pdf_not_one_page',
    });
    if (pageCount !== 1) {
      await Promise.all(reserved.map(path => rm(path, { force: true })));
      return { ...checked, status: 'fail', ok: false, checks: [...checked.checks, onePage] };
    }

    const text = checked.text;
    await writeReserved(paths.text, text);
    const sidecar = {
      version: 2,
      status: 'pass',
      draftHash: checked.draftHash,
      jdHash: checked.jdHash,
      textHash: sha256(text),
      pdfHash: sha256(pdfBytes),
      wordCount: checked.bodyWordCount,
      pageCount,
      checks: [...checked.checks, onePage],
      files: { text: paths.text, pdf: paths.pdf },
    };
    await writeReserved(paths.check, `${JSON.stringify(sidecar, null, 2)}\n`);
    return { ...checked, checks: [...checked.checks, onePage], files: paths, pageCount,
      textHash: sidecar.textHash, pdfHash: sidecar.pdfHash };
  } catch (error) {
    await Promise.all(reserved.map(path => rm(path, { force: true })));
    throw error;
  }
}

export async function approveCoverLetterV2(checkPath, { now = new Date() } = {}) {
  const sidecarPath = resolve(checkPath);
  if (!sidecarPath.endsWith('.check.json')) throw new Error('Approval requires a .check.json sidecar');
  const sidecar = JSON.parse((await readFile(sidecarPath, 'utf8')).replace(/^\uFEFF/, ''));
  if (sidecar.status !== 'pass' || !Array.isArray(sidecar.checks)
      || sidecar.checks.some(item => item?.status !== 'pass')) {
    throw new Error('Only a passing cover-letter v2 check can be approved');
  }
  for (const key of ['draftHash', 'jdHash', 'textHash', 'pdfHash']) {
    if (!/^[a-f0-9]{64}$/.test(sidecar[key] || '')) throw new Error(`Check sidecar has an invalid ${key}`);
  }
  const stem = basename(sidecarPath, '.check.json');
  const expectedText = `${stem}.txt`;
  const expectedPdf = `${stem}.pdf`;
  const textPath = resolve(dirname(sidecarPath), sidecar.files?.text || '');
  const pdfPath = resolve(dirname(sidecarPath), sidecar.files?.pdf || '');
  if (dirname(textPath) !== dirname(sidecarPath) || dirname(pdfPath) !== dirname(sidecarPath)
      || basename(textPath) !== expectedText || basename(pdfPath) !== expectedPdf) {
    throw new Error('Check sidecar does not reference its matching text/PDF pair');
  }
  const [textBytes, pdfBytes] = await Promise.all([readFile(textPath), readFile(pdfPath)]);
  if (sha256(textBytes) !== sidecar.textHash || sha256(pdfBytes) !== sidecar.pdfHash) {
    throw new Error('Cover-letter v2 pair hash mismatch; refusing approval');
  }
  const approvedPath = join(dirname(sidecarPath), `${stem}.approved.json`);
  const approval = {
    approvedAt: now.toISOString(),
    draftHash: sidecar.draftHash,
    textHash: sidecar.textHash,
    pdfHash: sidecar.pdfHash,
  };
  const handle = await open(approvedPath, 'wx');
  try { await handle.writeFile(`${JSON.stringify(approval, null, 2)}\n`, 'utf8'); }
  finally { await handle.close(); }
  return { approvedPath, approval };
}

async function loadValidator(modulePath) {
  const resolved = resolve(modulePath);
  if (!existsSync(resolved)) throw new Error(`Claim validator module not found: ${resolved}`);
  const loaded = await import(pathToFileURL(resolved).href);
  const validateClaims = loaded.validateClaims || loaded.default?.validateClaims || loaded.default;
  if (typeof validateClaims !== 'function') throw new Error('Claim validator module must export validateClaims().');
  return validateClaims;
}

async function readJd(draft, draftPath) {
  if (typeof draft?.jd?.text === 'string') return draft.jd.text;
  if (typeof draft?.jd?.path !== 'string' || !draft.jd.path.trim()) throw new Error('Draft must include jd.text or jd.path.');
  const jdPath = isAbsolute(draft.jd.path) ? draft.jd.path : resolve(dirname(draftPath), draft.jd.path);
  return readFile(jdPath, 'utf8');
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      approve: { type: 'string' },
      draft: { type: 'string' },
      'claims-validator': { type: 'string' },
      manifest: { type: 'string' },
      cv: { type: 'string' },
      company: { type: 'string' },
      role: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });
  const usage = 'Usage: node cover-letter-v2.mjs --draft <draft.json> --company <canonical-company> --role <canonical-role> [--claims-validator <module>] [--manifest <manifest.json> --cv <cv.md>]\n       node cover-letter-v2.mjs --approve <check.json>';
  if (values.help) {
    console.log(usage);
    return;
  }
  if (values.approve) {
    const approved = await approveCoverLetterV2(values.approve);
    console.log(JSON.stringify(approved, null, 2));
    return;
  }
  if (!values.draft) {
    console.log(usage);
    process.exitCode = 1;
    return;
  }
  const draftPath = resolve(values.draft);
  const draft = JSON.parse(await readFile(draftPath, 'utf8'));
  const jdText = await readJd(draft, draftPath);
  const defaultValidator = resolve(ROOT, 'cv-claims.mjs');
  const validatorPath = values['claims-validator'] ? resolve(values['claims-validator']) : defaultValidator;
  let validateClaims;
  let validatorError = '';
  try {
    validateClaims = await loadValidator(validatorPath);
  } catch (error) {
    validatorError = `${error.message} Draft is blocked until claim validation is available.`;
  }
  let manifest;
  let cv;
  if (values.manifest) manifest = JSON.parse(await readFile(resolve(values.manifest), 'utf8'));
  if (values.cv) cv = await readFile(resolve(values.cv), 'utf8');
  const result = await runCoverLetterV2(draft, { jdText, jdCompany: values.company, jdRole: values.role, validateClaims, manifest, cv, validatorError });
  console.log(JSON.stringify({
    status: result.status,
    draftHash: result.draftHash,
    bodyWordCount: result.bodyWordCount,
    checks: result.checks,
    files: result.files,
  }, null, 2));
  if (!result.ok) process.exitCode = result.status === 'blocked' ? 2 : 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main().catch(error => {
  console.error(`Cover-letter v2 failed: ${error.message}`);
  process.exitCode = 1;
});
