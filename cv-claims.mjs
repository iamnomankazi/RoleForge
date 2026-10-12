import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml';
import { PDFDocument } from 'pdf-lib';

export const CV_CLAIM_SCHEMA_VERSION = 1;
export const CLAIM_TYPES = Object.freeze([
  'identity', 'role', 'employer', 'dates', 'project', 'technology', 'metric', 'education', 'language', 'authorship',
]);
export const CLAIM_STATES = Object.freeze(['asserted', 'supported', 'conflict', 'needs_review', 'unanchored']);

// Deliberately small and explicit. Similar technologies never share a key.
export const TECHNOLOGY_ALIASES = Object.freeze({
  'javascript': 'javascript', 'js': 'javascript',
  'typescript': 'typescript', 'ts': 'typescript',
  'node.js': 'node.js', 'nodejs': 'node.js',
  'react': 'react', 'next.js': 'next.js', 'nextjs': 'next.js',
  'vue.js': 'vue.js', 'vuejs': 'vue.js', '.net': '.net', 'asp.net': 'asp.net',
  'python': 'python', 'java': 'java', 'c#': 'c#', 'c++': 'c++',
  'go': 'go', 'golang': 'go', 'rust': 'rust', 'ruby': 'ruby',
  'postgresql': 'postgresql', 'postgres': 'postgresql', 'mysql': 'mysql',
  'sqlite': 'sqlite', 'mongodb': 'mongodb', 'redis': 'redis',
  'html': 'html', 'css': 'css', 'sql': 'sql', 'graphql': 'graphql',
  'docker': 'docker', 'kubernetes': 'kubernetes', 'aws': 'aws', 'azure': 'azure',
  'gcp': 'gcp', 'git': 'git', 'linux': 'linux', 'fastapi': 'fastapi',
  'django': 'django', 'flask': 'flask', 'spring': 'spring', 'pytorch': 'pytorch',
  'tensorflow': 'tensorflow', 'scikit-learn': 'scikit-learn',
  'pandas': 'pandas',
});

const ALLOWED_EVIDENCE = new Set([
  'cv.md', 'config/profile.yml', 'modes/_profile.md', 'article-digest.md',
  'interview-prep/story-bank.md',
]);
const STYLE_ONLY = /(?:^|\/)(?:voice-dna\.md|writing-samples(?:\/|$))/i;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const DATE_RE = /\b(?:19|20)\d{2}(?:\s*[-–—/] ?\s*(?:(?:19|20)\d{2}|present|current|now))?\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?:19|20)\d{2}\b/gi;
const METRIC_RE = /(?:~|≈|approx\.?\s*|about\s+|around\s+|over\s+|more\s+than\s+|up\s+to\s+|approximately\s+|roughly\s+|nearly\s+)?(?:€|£|\$|(?:EUR|USD|GBP|CAD|AUD|SEK|NOK|DKK|CHF|JPY|INR)\s*)?\b\d[\d,]*(?:\.\d+)?\s*\+?\s*(?:%|percent|x|times|[kmb]\b|thousand|million|billion|rows?|records?|users?|requests?|transactions?|jobs?|items?|days?|weeks?|months?|years?|EUR|USD|GBP|CAD|AUD|SEK|NOK|DKK|CHF|JPY|INR)?\s*\+?/gi;
const STOP_WORDS = new Set(('a an and are as at be been being by can did do does for from had has have he her hers him his i if in into is it its may me might my of on or our ours she should so that the their theirs them then there these they this those through to was we were what when where which while who will with would you your yours worked work built led used using developed designed implemented created authored wrote founded launched responsible delivered managed improved helped support supporting').split(' '));

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
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/[*_]/g, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

function technologyMatches(text) {
  const input = normalizeText(text);
  const aliases = Object.keys(TECHNOLOGY_ALIASES).sort((a, b) => b.length - a.length);
  const matches = [];
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9+#.-])(${escaped})(?=$|[^a-z0-9+#.-]|\\.(?![a-z0-9]))`, 'gi');
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
  const firstContentLine = lines.findIndex((line) => line.trim());
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const lineNumber = index + 1;
    const heading = HEADING_RE.exec(raw.trim());
    if (heading) {
      const level = heading[1].length;
      headings.length = Math.min(headings.length, level - 1);
      headings[level - 1] = cleanMarkdown(heading[2]);
      const section = headings.filter(Boolean).join(' / ');
      if (level === 1 && index === firstContentLine && !/^(?:profile|summary|experience|employment|projects?|education|skills?|technical skills|languages|certifications?)$/i.test(cleanMarkdown(heading[2]))) {
        addClaim(claims, 'identity', cleanMarkdown(heading[2]), section, lineNumber);
      }
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
      const values = text.replace(/^[^:]{1,40}:\s*/, '').split(/[,;|·/]/).map((value) => value.trim()).filter(Boolean);
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
  const source = String(cvText ?? '').replace(/^\uFEFF/, '');
  const inputHash = sha256(source);
  return {
    schemaVersion: CV_CLAIM_SCHEMA_VERSION,
    cv: { path: cvPath, inputHash },
    claims: parseCvClaims(source).map((claim) => ({
      id: claim.id, type: claim.type, text: claim.text, textHash: claim.textHash,
      cv: { startLine: claim.cv.startLine, endLine: claim.cv.endLine, textHash: claim.cv.textHash },
      state: 'asserted',
      evidence: [{
        path: 'cv.md', locator: `lines:${claim.cv.startLine}${claim.cv.endLine === claim.cv.startLine ? '' : `-${claim.cv.endLine}`}`,
        sourceHash: inputHash, relation: 'self',
      }],
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
      if (!['self', 'independent', 'derivative', 'historical'].includes(ref.relation)) errors.push(`invalid_evidence_relation:${entry.id}`);
      if (ref.relation === 'self' && ref.path !== 'cv.md') errors.push(`self_evidence_not_cv:${entry.id}`);
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
  const withoutDates = String(text).replace(DATE_RE, ' ').replace(/\s+[|·–—-]\s+/g, ' ');
  const withoutTech = withoutDates.replace(/[\w.+#-]+/g, (token) => technologyMatches(token).length ? ' ' : token);
  // Unit suffixes glued to numbers (1.1M+, 50k, 37.3B) belong to the metric token, not to words.
  return withoutTech.toLowerCase().match(/(?<![0-9.])[a-z][a-z0-9'-]*/g)?.filter((word) => !STOP_WORDS.has(word) && !ACTION_LEMMAS.has(word)) || [];
}

// Explicit inflections: changing an action must never be authorized by its object.
const ACTION_LEMMAS = new Map([
  ['manage', 'managed', 'managing'], ['lead', 'led', 'leading'], ['build', 'built', 'building'],
  ['create', 'created', 'creating'], ['develop', 'developed', 'developing'],
  ['design', 'designed', 'designing'], ['implement', 'implemented', 'implementing'],
  ['maintain', 'maintained', 'maintaining'], ['own', 'owned', 'owning'],
  ['review', 'reviewed', 'reviewing'], ['analyse', 'analysed', 'analysing', 'analyze', 'analyzed', 'analyzing'],
  ['automate', 'automated', 'automating'], ['process', 'processed', 'processing'],
  ['migrate', 'migrated', 'migrating'], ['author', 'authored', 'authoring'],
  ['write', 'wrote', 'written', 'writing'], ['found', 'founded', 'founding'],
  ['launch', 'launched', 'launching'],
].flatMap(([lemma, ...forms]) => [lemma, `${lemma}s`, ...forms].map(form => [form, lemma])));

function actionLemmas(text) {
  const words = normalizeText(text).match(/[a-z]+/g) || [];
  // "my own project" is possession, not the action "own".
  return new Set(words.filter((word, index) => !(word === 'own' && /^(?:my|your|its|our|their|his|her)$/.test(words[index - 1] || '')))
    .map(word => ACTION_LEMMAS.get(word)).filter(Boolean));
}

function normalizeRoleHeading(text) {
  return normalizeText(text).replace(/\s+(?:at|@|[|·–—-])\s+/g, ' ')
    .replace(/\s*([–—-])\s*(?=\d{4}\b)/g, '-').replace(/\s+/g, ' ');
}

function coveringRoleHeading(text, cv, allowed, units) {
  // Only the complete canonical heading may combine its independently stored
  // role/employer/date fields. Narrative sentences still require one anchor.
  const canonical = normalizeRoleHeading(text);
  for (const [index, line] of cv.split(/\r?\n/).entries()) {
    const heading = HEADING_RE.exec(line.trim());
    if (!heading || !splitRoleHeader(cleanMarkdown(heading[2]))
        || normalizeRoleHeading(cleanMarkdown(heading[2])) !== canonical) continue;
    const fields = allowed.filter(entry => ['role', 'employer', 'dates'].includes(entry.type)
      && entry.occurrences.some(span => span.startLine === index + 1));
    if (fields.some(entry => entry.type === 'role') && units.every(unit => unitCovered(unit, fields).length)) return fields;
  }
  return [];
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

/** Split sentences without turning dotted technologies or decimal metrics into facts. */
export function splitClaimSentences(value) {
  const protectedText = String(value ?? '')
    .replace(/\b(?:Node\.js|Next\.js|Vue\.js|ASP\.NET)\b|\.NET\b/gi, match => match.replace(/\./g, '\uE000'))
    .replace(/\bapprox\.(?=\s*\d)/gi, match => match.replace('.', '\uE000'))
    .replace(/(?<=\d)\.(?=\d)/g, '\uE000');
  return (protectedText.match(/[^.!?]+(?:[.!?]+|$)/g) || [])
    .map(part => part.replace(/\uE000/g, '.').trim()).filter(Boolean);
}

/** A rendered skills list contains independent entries rather than a sentence. */
export function technologyListSegments(value) {
  const text = String(value ?? '');
  const matches = technologyMatches(text);
  let remainder = normalizeText(text);
  for (const match of [...matches].reverse()) remainder = remainder.slice(0, match.start) + ' ' + remainder.slice(match.end);
  return matches.length && /^[\s,;|·/&.]*$/.test(remainder.replace(/\band\b/g, '')) ? matches.map(match => match.alias) : null;
}

/** Facts in rendered letter fields, excluding ordinary salutations and courtesy. */
export function hasFactUnits(text) {
  return technologyMatches(text).length > 0 || dateTokens(text).length > 0 || metricTokens(text).length > 0
    || namedEntityMentions(text).length > 0
    || /\b(?:built|created|developed|authored|wrote|founded|designed|implemented|led|launched|invented|processed|managed|worked|fluent|proficient|degree|experience)\b/i.test(text)
    || /\b(?:I|we)\s+(?:build|work|use|have|speak|know|develop|design|manage)\b/i.test(text)
    || /\b(?:I|we)\s+(?!(?:would welcome|look forward|thank you)\b)[\p{L}]+/iu.test(text)
    || /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(String(text).replace(/^(?:Dear|Hello|Hi)\s+.*?,?$/i, ''));
}

const CREATION_RE = /\b(build|built|building|create|created|creating|develop|developed|developing|author|authored|authoring|write|wrote|written|writing|found|founded|founding|design|designed|designing|implement|implemented|implementing|lead|led|leading|launch|launched|launching)\s+(.+?)(?=\s+(?:using|with|in|for|at|by|across|to)\b|[.!?;]|$)/gi;

function creationRelationships(text) {
  // Compare the action and its direct object; using a framework is not creating it.
  let canonical = normalizeText(text);
  for (const match of technologyMatches(canonical).reverse()) canonical = canonical.slice(0, match.start) + match.canonical + canonical.slice(match.end);
  const safe = canonical.replace(/(?<=\p{L})\.(?=\p{L})/gu, '\uE000');
  return [...safe.matchAll(CREATION_RE)].map(match => normalizeText(`${ACTION_LEMMAS.get(match[1]) || match[1]} ${match[2]}`).replace(/\uE000/g, '.'));
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
    .map((entry) => ({ ...entry, text: byId.get(entry.id).text, occurrences: byId.get(entry.id).occurrences,
      section: byId.get(entry.id).section, sectionType: classifySection(byId.get(entry.id).section) }));
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
// Words that change what a claim asserts (seniority, authority, proficiency, quantity, recognition). In a
// paraphrase they must come from the cited evidence.
const RISK_WORDS = new Set(('lead led leading leader manager managed managing senior principal staff head expert expertise '
  + 'fluent fluently native proficient proficiency year years month months decade award awarded awards winner won published '
  + 'publication publications patent patents founded founder cofounder owner owned sole certified certification certificate '
  + 'phd doctorate million millions billion thousand thousands hundred hundreds dozen dozens one two three four five six seven '
  + 'eight nine ten eleven twelve first top best '
  + 'english finnish swedish german dutch danish norwegian spanish french italian portuguese hindi gujarati arabic chinese japanese russian').split(' '));
const APOSTROPHES = /[’‘`´]/g;
// Connecting vocabulary a cited paraphrase may add without evidence. None of these words names a responsibility,
// domain, audience or outcome; every other content word must come from the cited evidence.
const PARAPHRASE_WORDS = new Set(('m s ve d ll re t also both especially earlier then during into together reliably '
  + 'strongest example part putting making went completing studying skills code practical challenge software '
  + 'engineering familiar own projects project interface features feature application platform tool including').split(' '));
// STOP_WORDS entries that assert a contribution or outcome; a cited paraphrase needs them in the evidence.
const CLAIM_STOP_WORDS = new Set(('led developed designed implemented created authored wrote founded launched responsible '
  + 'delivered managed improved helped support supporting').split(' '));
// The only things a sentence citing the job description may say "I" do: apply, want, hope, welcome, look forward.
const JD_FIRST_PERSON_FILLER = new Set('am m d ll would will could can also really very be'.split(' '));
const JD_FIRST_PERSON_VERBS = new Set(('applying apply want hope hoping welcome like love look looking keen eager '
  + 'excited interested drawn glad happy believe see find appreciate enjoy').split(' '));

function wordStem(word) {
  return word.replace(/y$/, 'i').replace(/(?:ions|ion|ings|ing|ship|ers|er|ed|es|s|ly)$/, '');
}

function wordInEvidence(word, evidenceWords) {
  const stem = wordStem(word);
  return evidenceWords.some((other) => {
    const otherStem = wordStem(other);
    if (other === word || otherStem === stem) return true;
    const [short, long] = stem.length <= otherStem.length ? [stem, otherStem] : [otherStem, stem];
    return short.length >= 4 && long.startsWith(short) && long.length - short.length <= 2;
  });
}

function unsupportedWords(text, evidenceText) {
  const evidenceWords = evidenceText.match(/[a-z]+/g) || [];
  return (comparableEntity(text).match(/[a-z]+/g) || [])
    .filter((word) => (!STOP_WORDS.has(word) || CLAIM_STOP_WORDS.has(word)) && !PARAPHRASE_WORDS.has(word)
      && !wordInEvidence(word, evidenceWords));
}

function jdFirstPersonActivity(text) {
  const words = comparableEntity(text).match(/[a-z]+/g) || [];
  return words.some((word, index) => {
    if (word !== 'i') return false;
    let next = index + 1;
    while (JD_FIRST_PERSON_FILLER.has(words[next])) next += 1;
    return !JD_FIRST_PERSON_VERBS.has(words[next]);
  });
}

function riskWords(text) {
  return [...new Set((normalizeText(text).replace(APOSTROPHES, "'").match(/[a-z]+/g) || []).filter((word) => RISK_WORDS.has(word)))];
}

function comparableEntity(text) {
  return normalizeText(text).replace(APOSTROPHES, "'").replace(/\s+/g, ' ').trim();
}

// Names, brands and unlisted technologies (Kotlin, Saki, Node.js) are facts: every capitalized or dotted token
// except the sentence-initial word and "I" must occur in the evidence (possessive and plural forms tolerated).
function properNounTokens(text) {
  return String(text).replace(APOSTROPHES, "'").split(/\s+/).slice(1)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.+#]+$/gu, '').replace(/\.$/, ''))
    .flatMap((token) => token.split(/[-/]/))
    .filter((token) => /^\p{Lu}/u.test(token) || /\p{L}\.\p{L}/u.test(token))
    .filter((token) => !/^I(?:'(?:m|ve|d|ll))?$/.test(token))
    .map((token) => token.toLowerCase().replace(/'s$/, ''))
    .filter((token) => /\p{L}/u.test(token));
}

function tokenInEvidence(token, evidenceText) {
  const words = new Set(evidenceText.match(/[\p{L}\p{N}.+#']+/gu)?.map((word) => word.replace(/\.$/, '').replace(/'s$/, '')) || []);
  return words.has(token) || words.has(token.replace(/s$/, '')) || evidenceText.includes(token);
}

// A claim object (as in "I built X") must name something more than a bare technology or skill.
function creationObjectIsBareTechnology(text) {
  let canonical = normalizeText(text);
  for (const match of technologyMatches(canonical).reverse()) canonical = canonical.slice(0, match.start) + ' ' + canonical.slice(match.end);
  // Keep "Node.js" and "1.1M+" intact so a dot inside a name or number never ends the object.
  const safe = canonical.replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, '');
  return [...safe.matchAll(CREATION_RE)].some((match) => !(match[2].match(/[a-z][a-z'-]*/g) || [])
    .some((word) => !STOP_WORDS.has(word) && !ACTION_LEMMAS.has(word)));
}

/**
 * A paraphrased claim that names its evidence. `evidence` lists manifest claim IDs from one CV item, or "jd"
 * for employer/job context. Hard facts (technologies, metrics, dates, named entities, action verbs, risk words)
 * must come from that evidence, and every other content word must be in the evidence (any word form) or in
 * PARAPHRASE_WORDS. Cross-item evidence, unknown or stale
 * evidence, and candidate-experience statements backed only by the job description all fail.
 */
function validateCitedClaim(claim, claimId, evidence, allowed, jdText) {
  const fail = (reasonCode, anchorIds = []) => ({ claimId, status: 'fail', reasonCode, anchorIds });
  const text = claim.text;
  const units = claimedUnits(text).filter((unit) => unit.kind !== 'word');
  const names = properNounTokens(text);
  if (evidence.length === 1 && evidence[0] === 'jd') {
    const jd = comparableEntity(jdText || '');
    if (!jd) return fail('jd_context_missing');
    if (actionLemmas(text).size || creationRelationships(text).length || riskWords(text).length || jdFirstPersonActivity(text)
        || /\b(?:I(?:['’]ve| have| had)|my (?:experience|skills?|background|work|projects?|internship))\b/i.test(text)) {
      return fail('jd_context_candidate_claim');
    }
    const missing = units.filter((unit) => (unit.kind === 'technology'
      ? !technologyMatches(jdText).some((match) => match.canonical === unit.value)
      : !jd.includes(comparableEntity(unit.value))));
    if (missing.length || names.some((name) => !tokenInEvidence(name, jd))) return fail('unsupported_jd_context');
    return { claimId, status: 'pass', anchorIds: ['jd'] };
  }
  if (evidence.some((id) => typeof id !== 'string' || id === 'jd')) return fail('evidence_invalid');
  const cited = evidence.map((id) => allowed.find((entry) => entry.id === id));
  if (cited.some((entry) => !entry)) return fail('evidence_not_allowed');
  const ids = cited.map((entry) => entry.id);
  if (new Set(cited.map((entry) => entry.section)).size !== 1) return fail('evidence_spans_items', ids);
  const itemHeading = String(cited[0].section || '').split(' / ').at(-1);
  const evidenceText = comparableEntity([...cited.map((entry) => entry.text), itemHeading].join(' \n '));
  const missing = units.filter((unit) => unitCovered(unit, cited).length === 0);
  if (missing.length) {
    return fail(missing.some((unit) => unit.kind === 'technology') ? 'unsupported_technology'
      : missing.some((unit) => unit.kind === 'metric') ? 'unsupported_metric' : 'unsupported_date', ids);
  }
  if (names.some((name) => !tokenInEvidence(name, evidenceText))) return fail('unknown_named_entity', ids);
  const evidenceActions = new Set(cited.flatMap((entry) => [...actionLemmas(entry.text)]));
  if ([...actionLemmas(text)].some((action) => !evidenceActions.has(action))) return fail('unsupported_action', ids);
  const evidenceWords = new Set(evidenceText.match(/[a-z]+/g) || []);
  if (riskWords(text).some((word) => !evidenceWords.has(word))) return fail('unsupported_risk_word', ids);
  if (unsupportedWords(text, evidenceText).length) return fail('unsupported_wording', ids);
  if (creationRelationships(text).length && (!cited.some((entry) => ['project', 'role'].includes(entry.type)
      || (entry.type === 'authorship' && ['project', 'role'].includes(entry.sectionType)))
      || creationObjectIsBareTechnology(text))) {
    return fail('unsupported_relationship', ids);
  }
  return { claimId, status: 'pass', anchorIds: ids };
}

export function validateClaims({ claims, manifest, cv, jdText = '' } = {}) {
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
      if (claim.evidence !== undefined) {
        if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
          return { claimId, status: 'fail', reasonCode: 'evidence_invalid', anchorIds: [] };
        }
        return validateCitedClaim(claim, claimId, claim.evidence, allowed, jdText);
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
      const relationships = creationRelationships(claim.text);
      const actions = actionLemmas(claim.text);
      const headingFields = actions.size ? [] : coveringRoleHeading(claim.text, cv, allowed, units);
      if (headingFields.length) return { claimId, status: 'pass', anchorIds: headingFields.map(entry => entry.id) };
      const covering = allowed.filter(entry => units.every(unit => unitCovered(unit, [entry]).length)
        && [...actions].every(action => actionLemmas(entry.text).has(action))
        && entities.every(entity => normalizeText(entry.text).includes(entity))
        && (!relationships.length || ((['project', 'role'].includes(entry.type)
          || (entry.type === 'authorship' && ['project', 'role'].includes(entry.sectionType)))
          && relationships.every(relationship => creationRelationships(entry.text).includes(relationship)))));
      if (!covering.length) return { claimId, status: 'fail', reasonCode: 'unsupported_relationship', anchorIds: anchors };
      return { claimId, status: 'pass', anchorIds: covering.map(entry => entry.id) };
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
        const currentClaim = parseCvClaims(cvTextValue).find((claim) => claim.id === entry.id && claim.textHash === entry.textHash);
        const claimStillCurrent = Boolean(currentClaim);
        if (ref.sourceHash !== currentCvHash && !claimStillCurrent) entryIssues.push('evidence_source_stale');
        if (ref.sourceHash === currentCvHash) {
          const start = Number(locator[1]);
          const end = Number(locator[2] || locator[1]);
          if (start < 1 || end < start || !currentClaim || start !== currentClaim.cv.startLine || end !== currentClaim.cv.endLine) {
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

const LANGUAGE_LEVEL_RE = /\b(English|Finnish|Spanish|Hindi|Gujarati|French|German|Dutch|Danish|Swedish|Norwegian|Italian|Portuguese|Arabic|Japanese|Chinese|Mandarin|Korean|Russian|Ukrainian|Polish|Estonian|Latvian|Lithuanian|Turkish|Persian|Urdu|Bengali|Tamil|Telugu|Punjabi)\s*[:\-–—]\s*([^\n;,|]{2,50})/gi;

/** Extract a conservative set of facts from text for approved-document drift review. */
export function extractDriftFacts(sourceText) {
  const text = String(sourceText ?? '').normalize('NFKC');
  const facts = [];
  const add = (type, value) => {
    const clean = String(value ?? '').replace(/\s+/g, ' ').trim().replace(/^[|–—-]+|[|–—-]+$/g, '').trim();
    if (!clean) return;
    const key = type === 'technology' ? TECHNOLOGY_ALIASES[normalizeText(clean)] || normalizeText(clean) : normalizeText(clean);
    if (!facts.some((fact) => fact.type === type && fact.key === key)) facts.push({ type, text: clean, key });
  };

  for (const match of technologyMatches(text)) add('technology', match.alias);
  for (const metric of extractMetrics(text)) {
    if (/(?:%|percent|\b(?:EUR|USD|GBP|CAD|AUD|SEK|NOK|DKK|CHF|JPY|INR)\b|\b(?:x|times|k|m|b|thousand|million|billion|rows?|records?|users?|requests?|transactions?|jobs?|items?|days?|weeks?|months?|years?)\b)/i.test(metric)) add('metric', metric);
  }
  for (const match of text.matchAll(LANGUAGE_LEVEL_RE)) add('language_level', `${match[1]}: ${match[2]}`);

  let section = '';
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const normalized = normalizeText(line).replace(/[:：]$/, '');
    if (/^(?:selected |personal |academic )?projects?$/.test(normalized)) { section = 'project'; continue; }
    if (/^(?:professional |work |employment )?(?:experience|history)$/.test(normalized)) { section = 'experience'; continue; }
    if (/^(?:education|technical skills|skills|languages|profile|summary|certifications?)$/.test(normalized)) { section = ''; continue; }
    const bullet = /^(?:[-*•▪◦‣]|\d+[.)])\s+/.test(line);
    const value = line.replace(/^(?:[-*•▪◦‣]|\d+[.)])\s+/, '');
    if (section === 'project' && !bullet && value.length <= 100 && !/[.!?]$/.test(value) && !/\d{4}/.test(value) && !/:/.test(value)) {
      add('project', value.split(/\s+[|–—]\s+/)[0]);
    }
    if (section === 'experience' && /\b(?:19|20)\d{2}\b/.test(value)) {
      const parts = value.split(/\s+[|]\s+/).map((part) => part.trim()).filter(Boolean);
      if (parts.length > 1) add('employer', parts.map((part) => part.replace(DATE_RE, '').trim()).filter(Boolean).at(-1));
      else {
        const employer = /\b(?:at|for)\s+((?:[A-Z][\p{L}\p{N}&.'’-]*\s+){0,4}[A-Z][\p{L}\p{N}&.'’-]*(?:\s+(?:Inc\.?|Ltd\.?|Limited|LLC|GmbH|Oy|AB|AS|BV|Corporation|Corp\.?))?)/u.exec(value);
        if (employer) add('employer', employer[1]);
      }
    }
  }

  const suffixEmployer = /\b([A-Z][\p{L}\p{N}&.'’-]*(?:\s+[A-Z][\p{L}\p{N}&.'’-]*){0,4}\s+(?:Inc\.?|Ltd\.?|Limited|LLC|GmbH|Oy|AB|AS|BV|Pvt\.?\s+Ltd\.?|Corporation|Corp\.?))\b/gu;
  for (const match of text.matchAll(suffixEmployer)) add('employer', match[1]);

  return facts;
}
