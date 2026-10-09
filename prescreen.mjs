#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { classifyExperienceRequirements } from './experience-policy.mjs';

export const PRESCREEN_BLOCKER_CODES = Object.freeze([
  'language_required', 'work_auth_restricted', 'graduation_window', 'experience_outside',
]);
export const PRESCREEN_FLAG_CODES = Object.freeze([
  'sponsorship_unknown', 'language_preferred', 'experience_stretch',
]);

const COUNTRY_TERMS = {
  fi: 'Finland|Suomi', de: 'Germany|Deutschland', nl: 'Netherlands|Nederland|Holland',
  dk: 'Denmark|Danmark', se: 'Sweden|Sverige', fr: 'France', gb: 'United Kingdom|UK|Britain',
  ie: 'Ireland', no: 'Norway', is: 'Iceland', li: 'Liechtenstein', ch: 'Switzerland',
  us: 'United States|USA', ca: 'Canada', in: 'India|Indian',
  at: 'Austria', be: 'Belgium', bg: 'Bulgaria', hr: 'Croatia', cy: 'Cyprus', cz: 'Czechia|Czech Republic',
  ee: 'Estonia', gr: 'Greece', hu: 'Hungary', it: 'Italy', lv: 'Latvia', lt: 'Lithuania',
  lu: 'Luxembourg', mt: 'Malta', pl: 'Poland', pt: 'Portugal', ro: 'Romania', sk: 'Slovakia',
  si: 'Slovenia', es: 'Spain',
};
const CITY_TERMS = {
  fi: 'Helsinki|Espoo|Vantaa|Tampere|Turku|Joensuu|Oulu',
  de: 'Berlin|Munich|München|Hamburg|Frankfurt|Cologne|Köln|Düsseldorf|Dusseldorf|Stuttgart|Karlsruhe|Nuremberg|Nürnberg|Leipzig|Dresden|Bonn|Darmstadt|Mannheim|Heidelberg|Aachen|Bremen|Hanover|Hannover|Münster|Erlangen|Potsdam|Freiburg',
  nl: 'Amsterdam|Rotterdam|The Hague|Den Haag|Utrecht|Eindhoven|Delft|Leiden|Groningen|Tilburg|Nijmegen|Maastricht|Amersfoort|Haarlem',
  dk: 'Copenhagen|København|Aarhus|Odense|Aalborg|Lyngby|Roskilde|Hillerød|Ballerup|Kolding|Vejle|Randers|Esbjerg',
  gb: 'London', se: 'Stockholm', fr: 'Paris',
};
const EU = new Set('at be bg hr cy cz dk ee fi fr de gr hu ie it lv lt lu mt nl pl pt ro sk si es se'.split(' '));
const EEA = new Set([...EU, 'no', 'is', 'li']);
const boundaryPattern = terms => new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms})(?![\\p{L}\\p{N}])`, 'iu');
const countryPatterns = Object.entries(COUNTRY_TERMS).map(([code, terms]) => [code, boundaryPattern(terms)]);
const cityPatterns = Object.entries(CITY_TERMS).map(([code, terms]) => [code, boundaryPattern(terms)]);

function countryCode(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === 'uk') return 'gb';
  if (/^[a-z]{2}$/.test(text)) return text;
  return Object.entries(COUNTRY_TERMS).find(([, terms]) => boundaryPattern(terms).test(text))?.[0] ?? null;
}

/** Ambiguous multi-country and regional locations deliberately remain unknown. */
export function derivePrescreenCountry(location, explicitCountry) {
  if (explicitCountry != null) {
    if (!/^[a-z]{2}$/i.test(explicitCountry)) throw new Error('country must be an ISO-2 code');
    return countryCode(explicitCountry);
  }
  const text = String(location ?? '');
  // A city followed by a US state is location syntax, not an ISO country code.
  const states = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ').join('|');
  const statePattern = new RegExp(`(?:^|[;/|])\\s*[\\p{L} .'-]+,\\s*(?:${states})(?=\\s*(?:\\d{5}\\b|$|[;/|]))`, 'gu');
  const isStateLocation = match => {
    const suffix = match.match(/,\s*([A-Z]{2})/)?.[1].toLowerCase();
    return !COUNTRY_TERMS[suffix] || !cityPatterns.some(([, pattern]) => pattern.test(match));
  };
  const stateLocations = [...text.matchAll(statePattern)].filter(match => isStateLocation(match[0]));
  const countryText = text.replace(statePattern, match => isStateLocation(match) ? ' '.repeat(match.length) : match);
  const codes = new Set(stateLocations.length ? ['us'] : []);
  for (const [code, pattern] of [...countryPatterns, ...cityPatterns]) {
    if (pattern.test(countryText)) codes.add(code);
  }
  for (const code of Object.keys(COUNTRY_TERMS)) {
    if (new RegExp(`(?<![\\p{L}])${code.toUpperCase()}(?![\\p{L}])`, 'u').test(countryText)) codes.add(code);
  }
  return codes.size === 1 ? [...codes][0] : null;
}

const LEVEL_RANK = { none: 0, basic: 1, A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6, unspecified: 1 };
function languageLevel(value) {
  const text = String(value ?? '');
  const cefr = text.match(/\b[ABC][12]\b/i)?.[0].toUpperCase();
  if (cefr) return cefr;
  if (/native|mother tongue|muttersprach|äidinkiel|modersmål/i.test(text)) return 'C2';
  if (/excellent|fluent|fluency|fließend|fliessend|verhandlungssicher|sujuva|flytande|vloeiend|flydende|courant|proficient/i.test(text)) return 'C1';
  if (/very good|good|gute|hyvä|god|intermediate|professional/i.test(text)) return 'B2';
  if (/basic|beginner|grundkennt|perus/i.test(text)) return 'basic';
  if (/none|no proficiency/i.test(text)) return 'none';
  return null;
}
function yesNo(value) {
  if (typeof value === 'boolean') return value;
  if (/^yes$/i.test(String(value))) return true;
  if (/^no$/i.test(String(value))) return false;
  return null;
}
function graduationDate(value) {
  const text = String(value ?? '');
  const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const iso = parts ? `${parts[3]}-${parts[2]}-${parts[1]}` : text;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * Normalized profile: languages (name -> CEFR/basic), authorized_countries,
 * outside_home_authorized, sponsorship_outside_home, home_country,
 * residence_country, citizenship_countries, graduation_date (ISO date).
 * Unknown authorization/citizenship stays unknown; residency never implies citizenship.
 */
function normalizeProfile(profile = {}) {
  const languages = {};
  const sources = profile.languages ?? profile.language?.additional_proficiencies ?? {};
  for (const [name, value] of Object.entries(sources)) {
    const level = typeof value === 'object' && value !== null
      ? languageLevel(value.cefr) ?? languageLevel(value.level) : languageLevel(value);
    if (level) languages[name.toLowerCase()] = level;
  }
  const answers = profile.application_form?.work_authorization
    ?? profile.application_answers?.work_authorization ?? profile.work_authorization ?? {};
  const home = countryCode(profile.home_country ?? answers.home_country ?? profile.location?.country);
  const authorized = (profile.authorized_countries ?? []).map(countryCode).filter(Boolean);
  if (yesNo(answers.finland_authorized) === true && !authorized.includes('fi')) authorized.push('fi');
  const citizenship = profile.citizenship_countries ?? (profile.candidate?.citizenship
    ? [countryCode(profile.candidate.citizenship)].filter(Boolean) : []);
  return {
    languages,
    authorized_countries: authorized,
    home_country: home,
    outside_home_authorized: yesNo(profile.outside_home_authorized ?? answers.outside_finland_local_authorized),
    sponsorship_outside_home: yesNo(profile.sponsorship_outside_home ?? answers.outside_finland_sponsorship),
    residence_country: countryCode(profile.residence_country ?? profile.location?.country),
    citizenship_countries: citizenship.map(countryCode).filter(Boolean),
    graduation_date: graduationDate(profile.graduation_date ?? profile.education_details?.expected_graduation_date
      ?? profile.expected_graduation_date),
  };
}

export function loadPrescreenProfile(path) {
  return normalizeProfile(yaml.load(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) ?? {});
}

const LANGUAGE_TERMS = {
  english: 'English|Englisch(?:kenntnisse)?|englannin',
  german: 'German|Deutsch(?:kenntnisse)?|deutsche(?:n)? Sprache',
  dutch: 'Dutch|Nederlands|Nederlandse|Niederländisch',
  finnish: 'Finnish|suomen(?: kielen)?|suomi',
  swedish: 'Swedish|svenska|svenskan', danish: 'Danish|dansk',
  french: 'French|français|francais|française',
};
const SKILL = String.raw`(?:[ABC][12](?:[-\s]*(?:Niveau|level))?|native(?:[-\s]+level)?|fluent|fluency|proficien(?:t|cy)|business[-\s]+fluent|very\s+good|good|excellent|basic|fließend(?:e[nsr]?)?|fliessend(?:e[nsr]?)?|verhandlungssicher(?:e[nsr]?)?|gute(?:n)?|sujuva(?:a)?|hyvä|flytande|vloeiend|flydende|courant(?:e)?)`;
const BRIDGE = String.raw`(?:\s|[-,:()])*(?:(?:in|of|at|least|minimum|mindestens|a|the|language|skills?|knowledge|proficiency|fluency|level|auf|Niveau|kielen|taito|Sprachkenntnisse)\b(?:\s|[-,:()])*){0,6}`;
const PREFERRED = /\b(?:preferred|preferably|ideally|a plus|bonus|nice[ -]+to[ -]+have|desirable|von Vorteil|wünschenswert|eduksi|meriterande|préféré|pluspunt)\b/iu;
const NEGATED_REQUIREMENT = /\b(?:not (?:required|necessary|mandatory)|(?:do not|don't|does not)\s+(?:require|need|have to)|no need|no (?:\w+\s+){0,3}(?:required|necessary)|nicht erforderlich|ei vaadita)\b/iu;

// Split independent assertions while preserving coordinated language lists.
function assertionParts(clause) {
  const separator = /\s+(?:but|however|aber)\s+|,\s*(?=[^,]{0,45}\b(?:preferred|required|not necessary)\b)|(?<=\b(?:required|necessary|mandatory|preferred|desirable|plus))\s+(?:and|und)\s+|\s+(?:and|und)\s+(?=(?:you|we|applicants?|candidates?|no need)\b)/giu;
  const parts = [];
  let start = 0;
  for (const match of clause.text.matchAll(separator)) {
    parts.push({ ...clause, text: clause.text.slice(start, match.index), offset: clause.offset + start });
    start = match.index + match[0].length;
  }
  parts.push({ ...clause, text: clause.text.slice(start), offset: clause.offset + start });
  return parts;
}

function languagePreference(text, start, end, sectionPreferred) {
  const before = text.slice(Math.max(0, start - 65), start);
  const after = text.slice(end, end + 90);
  const prefix = /(?:preferred|preferably|ideally|nice[ -]+to[ -]+have|bonus|von Vorteil|wünschenswert)\s*(?!:)(?:[\p{L}]+\s+){0,5}$/iu.exec(before);
  const suffix = /^[\s,()]*?(?:(?:(?:language\s+)?skills?|taito)\s+)?(?:(?:is|are|would be|ist|sind)\s+)?(?:a plus|preferred|desirable|nice[ -]+to[ -]+have(?!\s*:)|von Vorteil|eduksi|meriterande|pluspunt)\b/iu.exec(after);
  return { preferred: sectionPreferred || Boolean(prefix || suffix), start: prefix ? start - (before.length - prefix.index) : start, end: suffix ? end + suffix[0].length : end };
}

function coordinatedLanguages(items, item, text, alternativesOnly = false) {
  const group = new Set([item]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const other of items) {
      if (group.has(other)) continue;
      const connected = [...group].some(member => {
        const first = member.match.index < other.match.index ? member : other;
        const second = first === member ? other : member;
        const gap = text.slice(first.match.index + first.match[0].length, second.match.index);
        if (!alternativesOnly && /^[\s(),]*,[\s(),]*$/u.test(gap)) return true;
        const connector = alternativesOnly ? 'or|oder|tai|eller|of' : 'and|und|ja|och|en|or|oder|tai|eller|of';
        return new RegExp(`^[\\s,()/\\-]*\\b(?:${connector})\\b[\\s\\-]*$`, 'i').test(gap);
      });
      if (connected) { group.add(other); changed = true; }
    }
  }
  return [...group];
}

// Keep indices in the original text, including HTML, for verbatim evidence.
function clauses(raw) {
  const text = raw.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, match => ' '.repeat(match.length))
    .replace(/<[^>]*>/g, tag => /^<\/?(?:p|li|h[1-6]|div|br|section)\b/i.test(tag)
      ? '\n' + ' '.repeat(tag.length - 1) : ' '.repeat(tag.length));
  const result = [];
  let section = null;
  for (const match of text.matchAll(/[^\n.;!?]+/g)) {
    const part = match[0].trim();
    if (!part) continue;
    const offset = match.index + match[0].indexOf(part);
    if (/^(?:preferred qualifications?|nice[ -]+to[ -]+have|bonus|desired skills?)\s*:?$/i.test(part)) {
      section = 'preferred';
      continue;
    }
    if (/^(?:requirements?|qualifications?|must have|about us|benefits?|responsibilities|what we offer)\s*:?$/i.test(part)) section = null;
    result.push({ text: part, offset, preferred: section === 'preferred' });
  }
  return result;
}
function evidenceFor(raw, clause, start = 0, end = clause.text.length) {
  if (clause.text.length <= 200) return raw.slice(clause.offset, clause.offset + clause.text.length);
  return raw.slice(clause.offset + start, clause.offset + Math.min(end, start + 200));
}

function languageRequirements(raw) {
  const requirements = [];
  for (const clause of clauses(raw)) {
    // Concessions are separate so a preferred language cannot soften a required one.
    for (const local of assertionParts(clause)) {
      const part = local.text;
      if (NEGATED_REQUIREMENT.test(part)) continue;
      // Proficiency fragments in qualification lists are assertions; prose about
      // an existing team or company is not a candidate requirement.
      const matches = [];
      for (const [language, terms] of Object.entries(LANGUAGE_TERMS)) {
        const name = `(?<![\\p{L}])(?:${terms})(?![\\p{L}])`;
        const pattern = new RegExp(`(?:${SKILL})${BRIDGE}${name}|${name}${BRIDGE}(?:${SKILL})`, 'giu');
        for (const match of part.matchAll(pattern)) {
          // Classes and learning resources explicitly describe development, not eligibility.
          if (/\b(?:learning|learn|lessons? in|courses? in|classes? in)\s*$/i.test(part.slice(Math.max(0, match.index - 50), match.index))) continue;
          const cefrSuffix = /^\s*\(\s*([ABC][12])\b/i.exec(part.slice(match.index + match[0].length));
          matches.push({ language, level: cefrSuffix?.[1].toUpperCase() ?? languageLevel(match[0]) ?? 'unspecified', match });
        }
        if (!matches.some(item => item.language === language)) {
          // Require a direct language assertion, never a customer/office/nationality mention.
          const assertion = new RegExp(`${name}\\s+(?:(?:language\\s+)?(?:skills?|knowledge|proficiency)\\s+)?(?:is\\s+|are\\s+)?(?:required|mandatory|essential|preferred|a plus|nice[ -]+to[ -]+have|von Vorteil|eduksi|meriterande)\\b|(?:must\\s+(?:speak|know)|(?:knowledge|command)\\s+of)\\s+${name}`, 'iu').exec(part);
          if (assertion) matches.push({ language, level: 'unspecified', match: assertion });
        }
      }
      // Explicit fluency can govern a coordinated list ("fluent English and German").
      for (const [language, terms] of Object.entries(LANGUAGE_TERMS)) {
        const existing = matches.find(item => item.language === language);
        if (existing && existing.level !== 'unspecified') continue;
        const bare = boundaryPattern(terms).exec(part);
        if (!bare) continue;
        const shared = matches.find(item => {
          if (item.language === language || item.level === 'unspecified') return false;
          const left = Math.min(bare.index + bare[0].length, item.match.index + item.match[0].length);
          const right = Math.max(bare.index, item.match.index);
          const gap = part.slice(left, right);
          return /^[\s(),]*,[\s(),]*$/u.test(gap)
            || /^(?:[\s,/-]*(?:and|or|oder|und|tai|ja|eller|och|en|of)[\s-]*)+$/i.test(gap);
        });
        if (shared && existing) existing.level = shared.level;
        else if (shared) matches.push({ language, level: shared.level, match: bare });
      }
      for (const item of matches) {
        const before = part.slice(0, item.match.index);
        const descriptive = /\b(?:(?:our|the|this)\s+(?:team|company|colleagues|employees|office|customers|clients)|we\s+(?:speak|use|work))\b(?:(?!\b(?:you|your|applicants?|candidates?|must|requires?)\b)[\s\S])*$/iu;
        if (descriptive.test(before)) continue;
        const preference = languagePreference(part, item.match.index, item.match.index + item.match[0].length, local.preferred);
        const groupPreferred = coordinatedLanguages(matches, item, part).some(member => PREFERRED.test(member.match[0])
          || languagePreference(part, member.match.index, member.match.index + member.match[0].length, local.preferred).preferred);
        requirements.push({
          language: item.language, level: item.level,
          required: !(groupPreferred || PREFERRED.test(item.match[0])),
          evidence: evidenceFor(raw, local, preference.start, preference.end),
          group: local.offset,
          // Alternatives are handled as a group, so English OR German is satisfiable.
          alternatives: coordinatedLanguages(matches, item, part, true).filter(member => member !== item).map(member => member.language),
        });
      }
    }
  }
  return requirements;
}

const NO_SPONSORSHIP = /\b(?:no\s+(?:visa\s+|work[- ]permit\s+)?sponsorship(?!\s+(?:is\s+)?(?:needed|required|necessary))|(?:cannot|can't|unable to|do not|don't|will not)\s+(?:(?:provide|offer)\s+(?:visa\s+)?sponsorship|sponsor\s+(?:work\s+)?visas?)|(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:not available|not provided|unavailable))\b/gi;
const SPONSORSHIP_AVAILABLE = /\b(?:(?:we\s+)?(?:can\s+|will\s+)?sponsor\s+(?:visas?|others)|(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:available|provided|offered)|(?:provide|offer)\s+(?:visa\s+)?sponsorship)\b/i;
const COUNTRY_CAPTURE = `(?:the\\s+)?(?:${Object.values(COUNTRY_TERMS).join('|')})`;
const EXISTING_RIGHT = new RegExp(String.raw`\b(?:must|need to|required to|have to)\s+(?:already\s+)?have\s+(?:an?\s+|the\s+)?(?:existing\s+)?(?:right|authorization|authorisation|permission)\s+to\s+work(?:\s+in\s+(${COUNTRY_CAPTURE}))?|\b(?:existing\s+)?(?:right|authorization|authorisation)\s+to\s+work\s+in\s+(${COUNTRY_CAPTURE})\s+(?:is\s+)?required`, 'gi');
const BASED = new RegExp(String.raw`\b(?:must|need to|required to|have to)\s+(?:already\s+)?be\s+(?:based|resident|located)\s+in\s+(${COUNTRY_CAPTURE}|(?:the\s+)?EU|(?:the\s+)?EEA)`, 'gi');
const CITIZENSHIP = /\b(?:(EU(?:\s*\/\s*EEA)?|EEA|European Union|European Economic Area)\s+(?:citizens?(?:hip)?|nationals?)\s+(?:only|required|is required)|(?:only|must be)\s+(EU(?:\s*\/\s*EEA)?|EEA|European Union|European Economic Area)\s+(?:citizens?|nationals?))\b/gi;

function authorizedIn(profile, country) {
  if (!country) return null;
  if (profile.authorized_countries.includes(country)) return true;
  if (profile.home_country && country !== profile.home_country) {
    if (profile.outside_home_authorized === false || profile.sponsorship_outside_home === true) return false;
  }
  return null;
}

function softRequirement(clause, match) {
  return NEGATED_REQUIREMENT.test(clause.text)
    || PREFERRED.test(match[0])
    || languagePreference(clause.text, match.index, match.index + match[0].length, clause.preferred).preferred;
}

function alternativeWorkTargets(text, end) {
  const targets = [];
  const pattern = new RegExp(`^\\s+(?:or|oder)\\s+(?:(?:must\\s+)?(?:be\\s+(?:based|resident|located)\\s+in|have\\s+(?:the\\s+)?right\\s+to\\s+work\\s+in)\\s+)?(${COUNTRY_CAPTURE}|(?:the\\s+)?EU|(?:the\\s+)?EEA)\\b`, 'i');
  let rest = text.slice(end);
  for (let match; (match = pattern.exec(rest)); rest = rest.slice(match[0].length)) targets.push(match[1]);
  return targets;
}

function meetsResidence(profile, target) {
  const normalized = target.replace(/^the\s+/i, '').toLowerCase();
  const region = normalized === 'eu' ? EU : normalized === 'eea' ? EEA : null;
  const country = countryCode(normalized);
  if (!profile.residence_country || (!region && !country)) return null;
  return region ? region.has(profile.residence_country) : country === profile.residence_country;
}

const CALENDAR_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const CALENDAR_TERM = `(?:${CALENDAR_MONTHS.join('|')}|spring|summer|fall|autumn|winter)`;
function cohortBoundary(year, term, end) {
  let month = end ? 12 : 1;
  if (term) {
    const index = CALENDAR_MONTHS.indexOf(term.toLowerCase());
    if (index >= 0) month = index + 1;
    else {
      // Winter straddles calendar years; retain the broad year when ambiguous.
      const seasons = { spring: [3, 5], summer: [6, 8], fall: [9, 11], autumn: [9, 11], winter: [1, 12] };
      month = seasons[term.toLowerCase()][end ? 1 : 0];
    }
  }
  const day = end ? new Date(Date.UTC(Number(year), month, 0)).getUTCDate() : 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function graduationRequirements(raw, candidateDate) {
  const result = [];
  const between = new RegExp(`\\b(?:graduated|graduate|graduating|graduation)\\s+(?:date\\s+)?(?:must\\s+be\\s+)?between\\s+(?:(${CALENDAR_TERM})\\s+)?(20\\d{2})\\s+(?:and|to|[-–])\\s+(?:(${CALENDAR_TERM})\\s+)?(20\\d{2})\\b`, 'gi');
  const during = new RegExp(`\\b(?:graduated|graduate|graduating|graduation)\\s+(?:during|in)\\s+(?:(${CALENDAR_TERM})\\s+)?(20\\d{2})\\b`, 'gi');
  for (const clause of clauses(raw).flatMap(assertionParts)) {
    if (clause.preferred || NEGATED_REQUIREMENT.test(clause.text) || /\bour (?:team|colleagues)\b/i.test(clause.text)) continue;
    const windows = [
      ...[...clause.text.matchAll(between)].map(match => ({ match,
        start: cohortBoundary(match[2], match[1], false), end: cohortBoundary(match[4], match[3], true) })),
      ...[...clause.text.matchAll(during)].map(match => ({ match,
        start: cohortBoundary(match[2], match[1], false), end: cohortBoundary(match[2], match[1], true) })),
    ].sort((a, b) => a.match.index - b.match.index);
    const required = windows.filter(window => window.start <= window.end
      && !PREFERRED.test(clause.text.slice(window.match.index + window.match[0].length).split(/\bor\b/i)[0])
      && !PREFERRED.test(clause.text.slice(0, window.match.index)));
    const groups = [];
    for (const window of required) {
      const previous = groups.at(-1)?.at(-1);
      const gap = previous && clause.text.slice(previous.match.index + previous.match[0].length, window.match.index);
      if (previous && /^\s+or\s+(?:to\s+)?$/i.test(gap)) groups.at(-1).push(window);
      else groups.push([window]);
    }
    for (const group of groups) {
      const satisfied = candidateDate && group.find(window => candidateDate >= window.start && candidateDate <= window.end);
      const selected = satisfied || group[0];
      result.push({ start: selected.start, end: selected.end, candidate_date: candidateDate,
        eligible: candidateDate ? Boolean(satisfied) : null,
        evidence: evidenceFor(raw, clause, group[0].match.index, group.at(-1).match.index + group.at(-1).match[0].length) });
    }
  }
  return result;
}

// Decode with an index map so classifier-normalized text can be traced back to
// verbatim HTML, including numeric entities representing digits.
function experienceSource(raw) {
  const named = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—' };
  let text = '';
  const spans = [];
  for (const match of raw.matchAll(/<[^>]*>|&(?:#x[\da-f]+|#\d+|[a-z]+);|[\s\S]/gi)) {
    const source = match[0];
    let value = source;
    if (source.startsWith('<')) value = ' ';
    else if (source.startsWith('&')) {
      const key = source.slice(1, -1);
      if (key.startsWith('#')) {
        const number = /^#x/i.test(key) ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
        if (number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)) value = String.fromCodePoint(number);
      } else value = named[key.toLowerCase()] ?? source;
    }
    for (const char of value) {
      if (/\s/u.test(char)) {
        if (!text || text.endsWith(' ')) {
          if (text) spans.at(-1).end = match.index + source.length;
          continue;
        }
        value = ' ';
      } else value = char;
      text += value;
      for (let index = 0; index < value.length; index++) spans.push({ start: match.index, end: match.index + source.length });
    }
  }
  return { text, spans };
}

/** Pure deterministic check. options.experiencePolicy follows experience-policy.mjs. */
export function prescreenJob({ title = '', description = '', location = '', country } = {}, profile, options = {}) {
  const candidate = normalizeProfile(profile);
  const raw = `${title}\n${description}`;
  const jobCountry = derivePrescreenCountry(location, country);
  const blockers = [];
  const flags = [];
  const addBlocker = (code, evidence, detail) => {
    if (!blockers.some(item => item.code === code && item.evidence === evidence)) blockers.push({ code, evidence, detail });
  };
  const languages = languageRequirements(raw);
  const meetsLanguage = item => item.language === 'english'
    || (LEVEL_RANK[candidate.languages[item.language]] ?? 0) >= LEVEL_RANK[item.level];
  for (const item of languages) {
    if (!item.required) flags.push({ code: 'language_preferred', evidence: item.evidence });
    else if (!meetsLanguage(item) && !languages.some(other => item.alternatives.includes(other.language)
      && other.group === item.group && meetsLanguage(other))) {
      addBlocker('language_required', item.evidence, `${item.language} ${item.level} is required; profile level: ${candidate.languages[item.language] ?? 'not recorded'}`);
    }
  }

  const auth = authorizedIn(candidate, jobCountry);
  const work = { country: jobCountry, status: auth === true ? 'authorized' : auth === false ? 'sponsorship_needed' : 'unknown', evidence: '' };
  let sponsorshipMentioned = false;
  const restrict = (evidence, detail) => {
    addBlocker('work_auth_restricted', evidence, detail);
    work.status = 'restricted';
    if (!work.evidence) work.evidence = evidence;
  };
  for (const clause of clauses(raw).flatMap(assertionParts)) {
    const noSponsorship = [...clause.text.matchAll(NO_SPONSORSHIP)];
    if (noSponsorship.length || SPONSORSHIP_AVAILABLE.test(clause.text)) sponsorshipMentioned = true;
    // A conditional exclusion with an explicit exception needs human review.
    const conditional = /\b(?:if|unless|except|for\s+(?:EU|EEA)|only for)\b|\bor\s+(?:be\s+)?eligible\s+for\s+(?:visa\s+)?sponsorship\b/i.test(clause.text);
    for (const match of noSponsorship) {
      if (languagePreference(clause.text, match.index, match.index + match[0].length, clause.preferred).preferred) continue;
      const evidence = evidenceFor(raw, clause, match.index, match.index + match[0].length);
      if (!conditional && !SPONSORSHIP_AVAILABLE.test(clause.text.replace(match[0], ''))) {
        work.evidence ||= evidence;
        if (auth === false) restrict(evidence, `Sponsorship is explicitly unavailable in ${jobCountry}`);
      }
    }
    for (const match of clause.text.matchAll(EXISTING_RIGHT)) {
      if (softRequirement(clause, match)) continue;
      const requiredCountry = countryCode(match[1] ?? match[2]) ?? jobCountry;
      const alternatives = alternativeWorkTargets(clause.text, match.index + match[0].length);
      const evidence = evidenceFor(raw, clause, match.index, match.index + match[0].length);
      if (!conditional && authorizedIn(candidate, requiredCountry) === false
        && alternatives.every(target => authorizedIn(candidate, countryCode(target)) === false)) restrict(evidence, `Existing work authorization in ${requiredCountry} is required`);
      else if (authorizedIn(candidate, requiredCountry) === true) work.evidence ||= evidence;
    }
    for (const match of clause.text.matchAll(BASED)) {
      if (softRequirement(clause, match)) continue;
      const targets = [match[1], ...alternativeWorkTargets(clause.text, match.index + match[0].length)];
      if (!conditional && targets.every(target => meetsResidence(candidate, target) === false)) {
        restrict(evidenceFor(raw, clause, match.index, match.index + match[0].length), 'Current residence does not meet the explicit location restriction');
      }
    }
    for (const match of clause.text.matchAll(CITIZENSHIP)) {
      if (softRequirement(clause, match)) continue;
      const region = /EEA|European Economic Area/i.test(match[1] ?? match[2]) ? EEA : EU;
      if (!conditional && candidate.citizenship_countries.length && !candidate.citizenship_countries.some(code => region.has(code))) {
        restrict(evidenceFor(raw, clause, match.index, match.index + match[0].length), 'The profile citizenship does not meet the explicit citizenship restriction');
      }
    }
  }
  if (!sponsorshipMentioned && auth === false) flags.push({ code: 'sponsorship_unknown', evidence: '' });

  let graduation = null;
  for (const window of graduationRequirements(raw, candidate.graduation_date)) {
    graduation ??= window;
    if (window.eligible === false) addBlocker('graduation_window', window.evidence, `Profile graduation ${candidate.graduation_date} is outside ${window.start} through ${window.end}`);
  }

  const experience = classifyExperienceRequirements(raw, options.experiencePolicy ?? { normal_max_years: 2, outside_min_years: 4 });
  const source = experience?.requirements.length ? experienceSource(raw) : null;
  for (const requirement of experience?.requirements ?? []) {
    const index = source.text.toLowerCase().indexOf(requirement.text.toLowerCase());
    const evidence = index < 0 ? null : raw.slice(source.spans[index].start, source.spans[index + requirement.text.length - 1].end);
    if (!evidence || evidence.length > 200) continue;
    if (requirement.hard_blocker) addBlocker('experience_outside', evidence, experience.hard_blocker_reason);
    else if (requirement.strength === 'required' && requirement.interpretation === 'stretch') flags.push({ code: 'experience_stretch', evidence });
  }
  return {
    blockers, flags,
    language_requirements: languages.map(({ alternatives, group, ...item }) => item),
    work_authorization: work, graduation_window: graduation, experience,
  };
}

const HELP = `Usage: node prescreen.mjs --file <jd.txt> [options]

Options:
  --location <text>  Job location
  --country <ISO-2>  Explicit job country (overrides location)
  --profile <path>   Profile YAML (default: config/profile.yml)
  --json            Print JSON (also the default)
  --help            Show this help`;

function parseArgs(args) {
  const result = { profile: resolve('config/profile.yml') };
  for (let index = 0; index < args.length; index++) {
    const [flag, inline] = args[index].split(/=(.*)/s, 2);
    if (flag === '--help' || flag === '--json') {
      if (inline != null) throw new Error(`${flag} does not take a value`);
      result[flag.slice(2)] = true;
      continue;
    }
    if (!['--file', '--location', '--country', '--profile'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = inline ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    result[flag.slice(2)] = value;
  }
  if (!result.help && !result.file) throw new Error('--file is required');
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) console.log(HELP);
    else console.log(JSON.stringify(prescreenJob({ description: readFileSync(args.file, 'utf8'), location: args.location, country: args.country }, loadPrescreenProfile(args.profile)), null, 2));
  } catch (error) {
    console.error(`prescreen.mjs: ${error.message}\nUse --help for usage.`);
    process.exitCode = 1;
  }
}
