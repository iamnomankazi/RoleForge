import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml';
import { PDFDocument } from 'pdf-lib';

export const CV_CLAIM_SCHEMA_VERSION = 1;
export const CLAIM_TYPES = Object.freeze([
  'role', 'employer', 'dates', 'project', 'technology', 'metric', 'education', 'language', 'authorship',
]);
export const CLAIM_STATES = Object.freeze(['asserted', 'supported', 'conflict', 'needs_review', 'unanchored']);

// Deliberately small and explicit. Similar technologies never share a key.
export const TECHNOLOGY_ALIASES = Object.freeze({
  'javascript': 'javascript', 'js': 'javascript',
  'typescript': 'typescript', 'ts': 'typescript',
  'node.js': 'node.js', 'nodejs': 'node.js',
  'react': 'react', 'next.js': 'next.js', 'nextjs': 'next.js',
  'python': 'python', 'java': 'java', 'c#': 'c#', 'c++': 'c++',
  'go': 'go', 'golang': 'go', 'rust': 'rust', 'ruby': 'ruby',
  'postgresql': 'postgresql', 'postgres': 'postgresql', 'mysql': 'mysql',
  'sqlite': 'sqlite', 'mongodb': 'mongodb', 'redis': 'redis',
  'html': 'html', 'css': 'css', 'sql': 'sql', 'graphql': 'graphql',
  'docker': 'docker', 'kubernetes': 'kubernetes', 'aws': 'aws', 'azure': 'azure',
  'gcp': 'gcp', 'git': 'git', 'linux': 'linux', 'fastapi': 'fastapi',
  'django': 'django', 'flask': 'flask', 'spring': 'spring', 'pytorch': 'pytorch',
  'tensorflow': 'tensorflow', 'scikit-learn': 'scikit-learn',
});

const ALLOWED_EVIDENCE = new Set([
  'cv.md', 'config/profile.yml', 'modes/_profile.md', 'article-digest.md',
  'interview-prep/story-bank.md',
]);
const STYLE_ONLY = /(?:^|\/)(?:voice-dna\.md|writing-samples(?:\/|$))/i;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const DATE_RE = /\b(?:19|20)\d{2}(?:\s*[-–—/] ?\s*(?:(?:19|20)\d{2}|present|current|now))?\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?:19|20)\d{2}\b/gi;
const METRIC_RE = /(?:~|≈|about\s+|around\s+|approximately\s+|roughly\s+|nearly\s+)?(?:€|£|\$|(?:EUR|USD|GBP|CAD|AUD|SEK|NOK|DKK|CHF|JPY|INR)\s*)?\b\d[\d,]*(?:\.\d+)?\s*(?:%|percent|x|times|[kmb]|thousand|million|billion|rows?|records?|users?|requests?|transactions?|jobs?|items?|days?|weeks?|months?|years?|EUR|USD|GBP|CAD|AUD|SEK|NOK|DKK|CHF|JPY|INR)?\s*\+?/gi;
const STOP_WORDS = new Set(('a an and are as at be been being by can did do does for from had has have he her hers him his i if in into is it its may me might my of on or our ours she should so that the their theirs them then there these they this those through to was we were what when where which while who will with would you your yours worked work built led used using developed designed implemented created responsible delivered managed improved helped support supporting').split(' '));

export function sha256(value) {
  const input = Buffer.isBuffer(value) || value instanceof Uint8Array ? value : String(value ?? '');
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\u00a0/g, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function textHash(value) {
  return sha256(normalizeText(value));
}

function cleanMarkdown(value) {
  return String(value ?? '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

function technologyMatches(text) {
  const input = normalizeText(text);
  const aliases = Object.keys(TECHNOLOGY_ALIASES).sort((a, b) => b.length - a.length);
  const matches = [];
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9+#.-])(${escaped})(?=$|[^a-z0-9+#.-])`, 'gi');
    let match;
    while ((match = re.exec(input))) {
      matches.push({ alias: match[2].toLowerCase(), canonical: TECHNOLOGY_ALIASES[match[2].toLowerCase()], start: match.index + match[1].length, end: match.index + match[1].length + match[2].length });
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  return matches.filter((m, i) => !matches.slice(0, i).some((prior) => prior.start <= m.start && prior.end >= m.end));
}

function classifySection(section) {
  const s = normalizeText(section);
  if (/\b(language|languages)\b/.test(s)) return 'language';
  if (/\b(education|academic|degree)\b/.test(s)) return 'education';
  if (/\b(project|projects|portfolio)\b/.test(s)) return 'project';
  if (/\b(experience|employment|work history|professional history)\b/.test(s)) return 'role';
  if (/\b(skill|skills|technology|technologies|tech stack|tools)\b/.test(s)) return 'technology';
  if (/\b(publication|authorship|writing|papers)\b/.test(s)) return 'authorship';
  return 'role';
}

function addClaim(claims, type, text, section, startLine, endLine = startLine) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean || !CLAIM_TYPES.includes(type)) return;
  const normalizedHash = textHash(clean);
  const id = `claim-${type}-${normalizedHash.slice(7, 23)}`;
  const existing = claims.get(id);
  const span = { startLine, endLine, textHash: normalizedHash };
  if (existing) {
    if (!existing.occurrences.some((item) => item.startLine === startLine && item.endLine === endLine)) existing.occurrences.push(span);
    return;
  }
  claims.set(id, {
    id, type, text: clean, section,
    cv: { startLine, endLine, textHash: normalizedHash },
    textHash: normalizedHash,
    occurrences: [span],
  });
}

function splitRoleHeader(text) {
  const dateMatches = [...text.matchAll(DATE_RE)];
  let dates = dateMatches.map((m) => m[0].trim());
  let rest = text.replace(DATE_RE, ' ').replace(/[()|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!dates.length) return null;
  let role = '';
  let employer = '';
  const separators = /\s+(?:at|@|[-–—|])\s+/i;
  const sep = separators.exec(rest);
  if (sep) {
    role = rest.slice(0, sep.index).trim();
    employer = rest.slice(sep.index + sep[0].length).trim();
  } else if (rest.includes(',')) {
    [role, employer] = rest.split(',', 2).map((part) => part.trim());
  }
  return { role, employer, dates };
}

function extractMetrics(text) {
  const dates = [...text.matchAll(DATE_RE)].map((m) => [m.index, m.index + m[0].length]);
  const found = [];
  for (const match of text.matchAll(METRIC_RE)) {
    const value = match[0].trim().replace(/\s+/g, ' ');
    if (!/\d/.test(value) || dates.some(([start, end]) => match.index < end && match.index + match[0].length > start)) continue;
    if (/^(?:19|20)\d{2}$/.test(value)) continue;
    if (!found.some((item) => normalizeText(item) === normalizeText(value))) found.push(value);
  }
  return found;
}

export function parseCvClaims(cvText) {
  const lines = String(cvText ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const claims = new Map();
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const lineNumber = index + 1;
    const heading = HEADING_RE.exec(raw.trim());
    if (heading) {
      const level = heading[1].length;
      headings.length = Math.min(headings.length, level - 1);
      headings[level - 1] = cleanMarkdown(heading[2]);
      const section = headings.filter(Boolean).join(' / ');
      if (classifySection(section) === 'project' && level >= 2) {
        addClaim(claims, 'project', cleanMarkdown(heading[2]), section, lineNumber);
      } else if (classifySection(section) === 'education' && level >= 3) {
        addClaim(claims, 'education', cleanMarkdown(heading[2]), section, lineNumber);
      }
      const roleHeader = splitRoleHeader(cleanMarkdown(heading[2]));
      if (roleHeader && classifySection(section) === 'role') {
        if (roleHeader.role) addClaim(claims, 'role', roleHeader.role, section, lineNumber);
        if (roleHeader.employer) addClaim(claims, 'employer', roleHeader.employer, section, lineNumber);
        for (const date of roleHeader.dates) addClaim(claims, 'dates', date, section, lineNumber);
      }
      continue;
    }
    const text = cleanMarkdown(raw);
    if (!text || /^[-*_]{3,}$/.test(text)) continue;
    const section = headings.filter(Boolean).join(' / ') || 'Unsectioned';
    const kind = classifySection(section);

    if (kind === 'technology') {
      const values = text.replace(/^[^:]{1,40}:\s*/, '').split(/[,;|]/).map((value) => value.trim()).filter(Boolean);
      if (values.length > 1) for (const value of values) addClaim(claims, 'technology', value, section, lineNumber);
      else {
        const matches = technologyMatches(text);
        if (matches.length) for (const match of matches) addClaim(claims, 'technology', match.alias, section, lineNumber);
        else addClaim(claims, 'technology', text, section, lineNumber);
      }
    } else if (kind === 'language') {
      addClaim(claims, 'language', text, section, lineNumber);
    } else if (kind === 'education') {
      addClaim(claims, 'education', text, section, lineNumber);
    } else if (kind === 'authorship' || /\b(authored|co-authored|published|publication|maintainer of)\b/i.test(text)) {
      addClaim(claims, 'authorship', text, section, lineNumber);
    } else if (/^\s*(?:employer|company|organization)\s*:/i.test(raw)) {
      addClaim(claims, 'employer', text.replace(/^[^:]+:\s*/, ''), section, lineNumber);
    } else {
      addClaim(claims, kind, text, section, lineNumber);
      const roleHeader = splitRoleHeader(text);
      if (roleHeader && kind === 'role') {
        if (roleHeader.role) addClaim(claims, 'role', roleHeader.role, section, lineNumber);
        if (roleHeader.employer) addClaim(claims, 'employer', roleHeader.employer, section, lineNumber);
      }
    }

    for (const match of text.matchAll(DATE_RE)) addClaim(claims, 'dates', match[0].trim(), section, lineNumber);
    for (const metric of extractMetrics(text)) addClaim(claims, 'metric', metric, section, lineNumber);
    if (kind !== 'technology') {
      for (const match of technologyMatches(text)) addClaim(claims, 'technology', match.alias, section, lineNumber);
    }
  }
  return [...claims.values()].sort((a, b) => a.cv.startLine - b.cv.startLine || CLAIM_TYPES.indexOf(a.type) - CLAIM_TYPES.indexOf(b.type) || a.id.localeCompare(b.id));
}

export function createDraftManifest(cvText, cvPath = 'cv.md') {
  const inputHash = sha256(String(cvText ?? '').replace(/^\uFEFF/, ''));
  return {
    schemaVersion: CV_CLAIM_SCHEMA_VERSION,
    cv: { path: cvPath, inputHash },
    claims: parseCvClaims(cvText).map((claim) => ({
      id: claim.id, type: claim.type, text: claim.text, textHash: claim.textHash,
      cv: { startLine: claim.cv.startLine, endLine: claim.cv.endLine, textHash: claim.cv.textHash },
      state: 'unanchored', evidence: [],
    })),
  };
}

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifest_not_object'];
  if (manifest.schemaVersion !== CV_CLAIM_SCHEMA_VERSION) errors.push('unsupported_schema_version');
  if (!manifest.cv || typeof manifest.cv !== 'object' || typeof manifest.cv.path !== 'string' || !manifest.cv.path.trim() || !HASH_RE.test(manifest.cv.inputHash || '')) errors.push('invalid_cv_binding');
  if (!Array.isArray(manifest.claims)) errors.push('claims_not_array');
  const ids = new Set();
  for (const entry of Array.isArray(manifest.claims) ? manifest.claims : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push('claim_not_object'); continue; }
    if (typeof entry.id !== 'string' || !/^claim-[a-z]+-[a-f0-9]{16}$/.test(entry.id)) errors.push(`invalid_claim_id:${String(entry.id || '')}`);
    if (ids.has(entry.id)) errors.push(`duplicate_claim_id:${entry.id}`);
    ids.add(entry.id);
    if (!CLAIM_TYPES.includes(entry.type)) errors.push(`invalid_claim_type:${entry.id}`);
    if (typeof entry.text !== 'string' || !entry.text.trim()) errors.push(`invalid_claim_text:${entry.id}`);
    if (!HASH_RE.test(entry.textHash || '') || entry.textHash !== textHash(entry.text || '')) errors.push(`invalid_claim_text_hash:${entry.id}`);
    if (CLAIM_TYPES.includes(entry.type) && HASH_RE.test(entry.textHash || '') && entry.id !== `claim-${entry.type}-${entry.textHash.slice(7, 23)}`) errors.push(`claim_id_content_mismatch:${entry.id}`);
    if (!CLAIM_STATES.includes(entry.state)) errors.push(`invalid_claim_state:${entry.id}`);
    if (!entry.cv || !Number.isInteger(entry.cv.startLine) || !Number.isInteger(entry.cv.endLine) || entry.cv.startLine < 1 || entry.cv.endLine < entry.cv.startLine || !HASH_RE.test(entry.cv.textHash || '')) errors.push(`invalid_claim_cv_locator:${entry.id}`);
    if (!Array.isArray(entry.evidence)) errors.push(`invalid_evidence_list:${entry.id}`);
    for (const ref of Array.isArray(entry.evidence) ? entry.evidence : []) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) { errors.push(`invalid_evidence_ref:${entry.id}`); continue; }
      for (const key of Object.keys(ref)) if (!['path', 'locator', 'sourceHash', 'relation'].includes(key)) errors.push(`unsupported_evidence_field:${entry.id}:${key}`);
      if (typeof ref.path !== 'string' || !ref.path.trim()) errors.push(`invalid_evidence_path:${entry.id}`);
      if (typeof ref.locator !== 'string' || !ref.locator.trim()) errors.push(`invalid_evidence_locator:${entry.id}`);
      if (!HASH_RE.test(ref.sourceHash || '')) errors.push(`invalid_evidence_hash:${entry.id}`);
      if (!['independent', 'derivative', 'historical'].includes(ref.relation)) errors.push(`invalid_evidence_relation:${entry.id}`);
    }
    if (entry.state === 'supported' && (!Array.isArray(entry.evidence) || !entry.evidence.some((ref) => ref?.relation === 'independent'))) {
      errors.push(`supported_without_independent_evidence:${entry.id}`);
    }
  }
  return errors;
}

export async function loadManifest(path) {
  const raw = await readFile(path, 'utf8');
  let manifest;
  try { manifest = JSON.parse(raw); } catch (error) { throw new Error(`manifest_json_invalid: ${error.message}`); }
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`manifest_invalid: ${errors.join(', ')}`);
  return manifest;
}

function canonicalFactToken(token) {
  const normalized = normalizeText(token).replace(/[–—]/g, '-');
  return TECHNOLOGY_ALIASES[normalized] ? `technology:${TECHNOLOGY_ALIASES[normalized]}` : `text:${normalized}`;
}

function dateTokens(text) {
  return [...String(text).matchAll(DATE_RE)].map((match) => normalizeText(match[0]).replace(/[–—]/g, '-').replace(/\s*([-\/])\s*/g, '$1'));
}

function metricTokens(text) {
  return extractMetrics(String(text)).map((value) => normalizeText(value).replace(/\s+/g, '').replace(/,/g, ','));
}

function meaningfulWords(text) {
  const withoutDates = String(text).replace(DATE_RE, ' ');
  const withoutTech = withoutDates.replace(/[\w.+#-]+/g, (token) => technologyMatches(token).length ? ' ' : token);
  return withoutTech.toLowerCase().match(/[a-z][a-z0-9'-]*/g)?.filter((word) => !STOP_WORDS.has(word)) || [];
}

function claimedUnits(text) {
  const tokens = [];
  const dateList = dateTokens(text);
  for (const date of dateList) tokens.push({ kind: 'date', value: date });
  for (const metric of metricTokens(text)) tokens.push({ kind: 'metric', value: metric });
  for (const match of technologyMatches(text)) tokens.push({ kind: 'technology', value: match.canonical });
  for (const word of meaningfulWords(text)) tokens.push({ kind: 'word', value: word });
  return [...new Map(tokens.map((token) => [`${token.kind}:${token.value}`, token])).values()];
}

function containsWord(text, word) {
  const normalized = normalizeText(text);
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(normalized);
}

function unitCovered(unit, entries) {
  return entries.filter((entry) => {
    if (unit.kind === 'technology') return technologyMatches(entry.text).some((match) => match.canonical === unit.value);
    if (unit.kind === 'date') {
      const anchoredDates = dateTokens(entry.text);
      if (anchoredDates.includes(unit.value)) return true;
      return /^\d{4}$/.test(unit.value) && anchoredDates.some((date) => date.match(/\b(?:19|20)\d{2}\b/g)?.includes(unit.value));
    }
    if (unit.kind === 'metric') return metricTokens(entry.text).includes(unit.value);
    return containsWord(entry.text, unit.value);
  }).map((entry) => entry.id);
}

function namedEntityMentions(text) {
  const mentions = [];
  const patterns = [
    /\b(?:[Aa]t|[Ff]or|[Ww]ith|[Jj]oined|[Ff]rom|[Ww]ithin)\s+((?:[A-Z][\p{L}\p{N}&.'’-]*\s+){0,4}[A-Z][\p{L}\p{N}&.'’-]*)/gu,
    /\bproject\s+["“]?((?:[A-Z][\p{L}\p{N}&.'’-]*\s*){1,5})["”]?/gu,
    /\b((?:BSc|MSc|PhD|Bachelor(?:'s)?|Master(?:'s)?|Doctorate|Doctor of Philosophy)(?:\s+(?:of|in|Science|Arts|Engineering|Computer|Business|Data|Software|Technology)){0,5})\b/giu,
  ];
  for (const pattern of patterns) for (const match of String(text).matchAll(pattern)) {
    const phrase = match[1].replace(/["“”]+$/g, '').trim();
    if (phrase && !['the', 'a', 'an'].includes(phrase.toLowerCase())) mentions.push(phrase);
  }
  return [...new Set(mentions.map((mention) => normalizeText(mention)))];
}

function currentAllowedEntries(manifest, cv) {
  const claims = parseCvClaims(cv);
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  return manifest.claims.filter((entry) => {
    if (!['asserted', 'supported'].includes(entry.state)) return false;
    const current = byId.get(entry.id);
    return Boolean(current && current.textHash === entry.textHash && current.type === entry.type);
  }).filter((entry) => entry.state !== 'supported' || hasCurrentIndependentEvidence(entry))
    .map((entry) => ({ ...entry, text: byId.get(entry.id).text }));
}

function hasCurrentIndependentEvidence(entry) {
  for (const ref of entry.evidence || []) {
    if (ref.relation !== 'independent') continue;
    const sourceInfo = allowedEvidencePath(ref.path);
    if (!sourceInfo.allowed || sourceInfo.pdf || !['article-digest.md', 'interview-prep/story-bank.md'].includes(sourceInfo.path)) continue;
    try {
      const source = readFileSync(resolve(process.cwd(), sourceInfo.path));
      if (sha256(source) !== ref.sourceHash) continue;
      const value = source.toString('utf8');
      const resolved = resolveLocator(value, ref.locator, sourceInfo.path);
      if (!normalizeText(resolved).includes(normalizeText(entry.text))) continue;
      return true;
    } catch { /* A stale or unresolved reference cannot authorize a claim. */ }
  }
  return false;
}

/**
 * Deterministic factual-claim guard for free text. Only current CV claims in
 * asserted/supported states are eligible. Exact tokens and words are required;
 * paraphrases deliberately fail closed for human review.
 */
export function validateClaims({ claims, manifest, cv } = {}) {
  try {
    if (validateManifest(manifest).length) throw new Error('manifest_invalid');
    if (typeof cv !== 'string') throw new Error('cv_missing');
    if (!Array.isArray(claims)) throw new Error('claims_missing');
    if (claims.length === 0) throw new Error('claims_empty');
    const allowed = currentAllowedEntries(manifest, cv);
    const results = Array.from({ length: claims.length }, (_, index) => {
      if (!Object.hasOwn(claims, index)) return { claimId: `claim-${index + 1}`, status: 'fail', reasonCode: 'claim_missing', anchorIds: [] };
      const claim = claims[index];
      const claimId = typeof claim?.id === 'string' ? claim.id : `claim-${index + 1}`;
      if (!claim || typeof claim.text !== 'string' || !claim.text.trim()) {
        return { claimId, status: 'fail', reasonCode: 'claim_text_missing', anchorIds: [] };
      }
      const units = claimedUnits(claim.text);
      if (units.length === 0) return { claimId, status: 'fail', reasonCode: 'no_anchorable_facts', anchorIds: [] };
      const missing = units.filter((unit) => unitCovered(unit, allowed).length === 0);
      const anchors = [...new Set(units.flatMap((unit) => unitCovered(unit, allowed)))];
      const entities = namedEntityMentions(claim.text);
      const missingEntities = entities.filter((entity) => !allowed.some((entry) => normalizeText(entry.text).includes(entity)));
      if (missing.length || missingEntities.length || anchors.length === 0) {
        const reasonCode = missing.some((unit) => unit.kind === 'technology') ? 'unsupported_technology'
          : missing.some((unit) => unit.kind === 'metric') ? 'unsupported_metric'
            : missing.some((unit) => unit.kind === 'date') ? 'unsupported_date'
              : missingEntities.length ? 'unknown_named_entity' : 'unsupported_claim_text';
        return { claimId, status: 'fail', reasonCode, anchorIds: anchors };
      }
      return { claimId, status: 'pass', anchorIds: anchors };
    });
    if (results.length !== claims.length) throw new Error('claim_results_incomplete');
    return { ok: results.every((result) => result.status === 'pass'), results };
  } catch (error) {
    const results = Array.isArray(claims) ? Array.from({ length: claims.length }, (_, index) => {
      const claim = Object.hasOwn(claims, index) ? claims[index] : null;
      return {
        claimId: typeof claim?.id === 'string' ? claim.id : `claim-${index + 1}`,
        status: 'fail', reasonCode: claim ? String(error.message || 'validation_error').split(':')[0] : 'claim_missing', anchorIds: [],
      };
    }) : [];
    if (!results.length) results.push({ claimId: '(input)', status: 'fail', reasonCode: String(error.message || 'validation_error').split(':')[0], anchorIds: [] });
    return { ok: false, results };
  }
}

function allowedEvidencePath(path) {
  const normalized = String(path ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.split('/').some((part) => part === '..' || part === '.')) return { allowed: false, path: normalized };
  if (STYLE_ONLY.test(normalized)) return { allowed: false, style: true, path: normalized };
  if (normalized.startsWith('output/cv-approved/') && /\.pdf$/i.test(normalized)) return { allowed: true, pdf: true, path: normalized };
  return { allowed: ALLOWED_EVIDENCE.has(normalized), path: normalized };
}

function resolveLocator(source, locator, path) {
  const lineMatch = /^lines:(\d+)(?:-(\d+))?$/.exec(locator);
  if (lineMatch) {
    const start = Number(lineMatch[1]);
    const end = Number(lineMatch[2] || lineMatch[1]);
    const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (start < 1 || end < start || end > lines.length || end - start > 100) throw new Error('locator_out_of_range');
    return lines.slice(start - 1, end).join('\n');
  }
  const pageMatch = /^page:(\d+)$/.exec(locator);
  if (pageMatch && Number(pageMatch[1]) > 0 && path.startsWith('output/cv-approved/') && extname(path).toLowerCase() === '.pdf') return source;
  if (path === 'config/profile.yml' && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(locator)) {
    const yaml = loadYaml(source, { schema: JSON_SCHEMA });
    let value = yaml;
    for (const part of locator.split('.')) value = value && typeof value === 'object' ? value[part] : undefined;
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error('locator_unresolved');
    return String(value);
  }
  if (locator.startsWith('heading:')) {
    const heading = locator.slice(8).trim();
    if (!heading || !source.split(/\r?\n/).some((line) => normalizeText(line.replace(/^#{1,6}\s+/, '')) === normalizeText(heading))) throw new Error('locator_unresolved');
    return source;
  }
  throw new Error('locator_invalid');
}

export async function validateManifestEvidence(manifest, { root = process.cwd(), cvText } = {}) {
  const issues = new Map();
  const currentCvHash = sha256(String(cvText ?? '').replace(/^\uFEFF/, ''));
  for (const entry of manifest.claims) {
    const entryIssues = [];
    for (const ref of entry.evidence) {
      const sourceInfo = allowedEvidencePath(ref.path);
      if (!sourceInfo.allowed) {
        entryIssues.push(sourceInfo.style ? 'style_source_forbidden' : 'evidence_source_forbidden');
        continue;
      }
      if (sourceInfo.path === 'cv.md') {
        const cvTextValue = String(cvText ?? '').replace(/^\uFEFF/, '');
        const locator = /^lines:(\d+)(?:-(\d+))?$/.exec(ref.locator);
        if (!locator) { entryIssues.push('evidence_locator_invalid'); continue; }
        const claimStillCurrent = parseCvClaims(cvTextValue).some((claim) => claim.id === entry.id && claim.textHash === entry.textHash);
        if (ref.sourceHash !== currentCvHash && !claimStillCurrent) entryIssues.push('evidence_source_stale');
        if (ref.sourceHash === currentCvHash) {
          const start = Number(locator[1]);
          const end = Number(locator[2] || locator[1]);
          const lines = cvTextValue.split(/\r?\n/);
          if (start < 1 || end < start || end > lines.length || !normalizeText(lines.slice(start - 1, end).join(' ')).includes(normalizeText(entry.text))) {
            entryIssues.push('evidence_locator_mismatch');
          }
        }
        if (ref.relation === 'independent') entryIssues.push('canonical_cv_is_not_independent');
        continue;
      }
      const absolute = resolve(root, sourceInfo.path);
      let source;
      try { source = await readFile(absolute); } catch { entryIssues.push('evidence_source_missing'); continue; }
      const sourceText = sourceInfo.pdf ? source : source.toString('utf8');
      if (ref.sourceHash !== sha256(sourceText)) { entryIssues.push('evidence_source_stale'); continue; }
      if (sourceInfo.pdf) {
        const pageMatch = /^page:(\d+)$/.exec(ref.locator);
        if (!pageMatch || !source.subarray(0, 5).equals(Buffer.from('%PDF-'))) { entryIssues.push('pdf_locator_invalid'); continue; }
        try {
          const pdf = await PDFDocument.load(source, { ignoreEncryption: true });
          const page = Number(pageMatch[1]);
          if (page < 1 || page > pdf.getPageCount()) { entryIssues.push('pdf_page_out_of_range'); continue; }
        } catch { entryIssues.push('pdf_unreadable'); continue; }
      }
      try {
        const resolved = resolveLocator(sourceText, ref.locator, sourceInfo.path);
        const profileEcho = ['config/profile.yml', 'modes/_profile.md'].includes(sourceInfo.path)
          && normalizeText(resolved).includes(normalizeText(entry.text));
        if (profileEcho) {
          entryIssues.push('derivative_echo_only');
          continue;
        }
        if (sourceInfo.path === 'cv.md' && ref.relation === 'independent') {
          entryIssues.push('canonical_cv_is_not_independent');
          continue;
        }
        if (sourceInfo.pdf && ref.relation === 'independent') {
          entryIssues.push('historical_pdf_not_independent');
          continue;
        }
        if (!sourceInfo.pdf && !normalizeText(resolved).includes(normalizeText(entry.text))) {
          // Profile echoes and prose paraphrases may be noted, but cannot be
          // promoted to independent support by this deterministic checker.
          entryIssues.push(ref.relation === 'derivative' ? 'derivative_echo_only' : 'evidence_text_mismatch');
        }
      } catch (error) {
        entryIssues.push(error.message || 'evidence_locator_invalid');
      }
    }
    if (entry.state === 'supported' && !entry.evidence.some((ref) => ref.relation === 'independent')) entryIssues.push('independent_evidence_missing');
    if (entryIssues.length) issues.set(entry.id, [...new Set(entryIssues)]);
  }
  return issues;
}

function overlapScore(a, b) {
  const tokenize = (text) => new Set(normalizeText(text).match(/[\p{L}\p{N}]+/gu) || []);
  const aa = tokenize(a.text);
  const bb = tokenize(b.text);
  if (!aa.size || !bb.size) return 0;
  const common = [...aa].filter((word) => bb.has(word)).length;
  return common / Math.max(aa.size, bb.size);
}

export async function buildValidationReport({ cvText, cvPath = 'cv.md', manifest, root = process.cwd() } = {}) {
  const inputHash = sha256(String(cvText ?? '').replace(/^\uFEFF/, ''));
  const current = parseCvClaims(cvText);
  const manifestErrors = validateManifest(manifest);
  const evidenceIssues = manifestErrors.length ? new Map() : await validateManifestEvidence(manifest, { root, cvText });
  const oldById = new Map((manifest?.claims || []).map((claim) => [claim.id, claim]));
  const currentById = new Map(current.map((claim) => [claim.id, claim]));
  const delta = { added: [], unchanged: [], changed: [], removed: [] };
  for (const claim of current) {
    if (oldById.has(claim.id)) delta.unchanged.push(claim.id);
    else delta.added.push(claim.id);
  }
  const removed = (manifest?.claims || []).filter((entry) => !currentById.has(entry.id));
  delta.removed = removed.map((entry) => entry.id);
  const unused = new Set(delta.added);
  for (const old of removed) {
    const candidates = current.filter((claim) => unused.has(claim.id) && claim.type === old.type)
      .map((claim) => ({ claim, score: overlapScore(old, claim) }))
      .sort((a, b) => b.score - a.score);
    if (candidates[0]?.score >= 0.45) {
      delta.changed.push({ from: old.id, to: candidates[0].claim.id });
      unused.delete(candidates[0].claim.id);
    }
  }

  const entries = [];
  for (const claim of current) {
    const anchor = oldById.get(claim.id);
    let status = 'unanchored';
    const issues = [];
    if (anchor) {
      if (anchor.state === 'conflict') status = 'conflict';
      else if (anchor.state === 'needs_review') status = 'needs_review';
      else if (!['asserted', 'supported'].includes(anchor.state)) status = 'unanchored';
      else {
        const foundIssues = evidenceIssues.get(anchor.id) || [];
        if (foundIssues.length) {
          issues.push(...foundIssues);
          status = foundIssues.includes('evidence_source_stale') || foundIssues.includes('evidence_source_missing') ? 'stale' : 'needs_review';
        } else status = anchor.state;
      }
      if (anchor.textHash !== claim.textHash || anchor.type !== claim.type) {
        status = 'stale';
        issues.push('claim_content_changed');
      }
    }
    entries.push({
      id: claim.id, type: claim.type, text: claim.text,
      cv: claim.cv, state: status,
      evidence: anchor?.evidence || [], issues,
    });
  }
  for (const old of removed) {
    const status = old.state === 'needs_review' ? 'needs_review' : old.state === 'conflict' ? 'conflict' : 'stale';
    const issues = status === 'stale' ? ['claim_removed_from_current_cv'] : ['not_in_current_cv'];
    entries.push({ id: old.id, type: old.type, text: old.text, cv: old.cv, state: status, evidence: old.evidence, issues });
  }
  const counts = Object.fromEntries(['asserted', 'supported', 'needs_review', 'conflict', 'stale', 'unanchored'].map((state) => [state, entries.filter((entry) => entry.state === state).length]));
  const reviewCount = counts.needs_review + counts.conflict + counts.stale + counts.unanchored;
  const status = manifestErrors.length ? 'blocked' : reviewCount ? 'review_required' : 'pass';
  return {
    schemaVersion: CV_CLAIM_SCHEMA_VERSION,
    input: { path: cvPath, hash: inputHash }, status, counts,
    claims: entries,
    delta,
    errors: manifestErrors,
  };
}
