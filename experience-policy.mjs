const DEFAULTS = Object.freeze({
  normalMaxYears: 2,
  outsideMinYears: 4,
});

const SEVERITY = Object.freeze({ normal: 0, stretch: 1, outside: 2 });
const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'];
const LOCALIZED_NUMBER_WORDS = new Map([
  ...NUMBER_WORDS.map((word, index) => [word, index + 1]),
  ['eins', 1], ['ein', 1], ['eine', 1], ['einen', 1],
  ['zwei', 2], ['drei', 3], ['vier', 4], ['fünf', 5], ['sechs', 6], ['sieben', 7], ['acht', 8], ['neun', 9], ['zehn', 10],
  ['yksi', 1], ['yhden', 1], ['kaksi', 2], ['kahden', 2], ['kolme', 3], ['kolmen', 3], ['neljä', 4], ['neljän', 4],
  ['viisi', 5], ['viiden', 5], ['kuusi', 6], ['kuuden', 6], ['seitsemän', 7], ['kahdeksan', 8], ['yhdeksän', 9], ['kymmenen', 10],
  ['un', 1], ['une', 1], ['deux', 2], ['trois', 3], ['quatre', 4], ['cinq', 5], ['six', 6], ['sept', 7], ['huit', 8], ['neuf', 9], ['dix', 10],
  ['ett', 1], ['en', 1], ['två', 2], ['tre', 3], ['fyra', 4], ['fem', 5], ['sex', 6], ['sju', 7], ['åtta', 8], ['nio', 9], ['tio', 10],
]);
const EXPERIENCE_NUMBER_WORDS = [...LOCALIZED_NUMBER_WORDS.keys()].sort((left, right) => right.length - left.length);
const EXPERIENCE_NUMBER = String.raw`(?:\d+(?:[.,]\d+)?|(?:${EXPERIENCE_NUMBER_WORDS.join('|')})\b)`;
const EXPERIENCE_UNITS = String.raw`(?:years?|yrs?|Jahre?n?|Jahren|Jahr|vuoden|vuotta|vuosi|vuodet|ans?|år|års)`;
const MONTH_UNITS = String.raw`(?:months?|Monate?n?|Monaten|kuukautta|kuukauden|kuukausi|kuukaudet|mois|månader|månad|månaderna)`;
const DURATION_UNITS = String.raw`(?:${EXPERIENCE_UNITS}|${MONTH_UNITS})`;
const REQUIREMENT_QUALIFIER = String.raw`(?:approximately|approx\.?|about|around|at\s+least|minimum(?:\s+of)?|mindestens|mind\.?|vähintään|yli|au\s+moins|minst)`;
const RANGE_SEPARATOR = String.raw`(?:[-\u2010-\u2014\u2212]|\bto\b|\bbis\b|\btill\b)`;
const EXPERIENCE_PATTERN = new RegExp(
  String.raw`\b(?:(?:approximately|approx\.?|about|around)\s+)?(?:(?<minimumQualifier>at\s+least|minimum(?:\s+of)?|mindestens|mind\.?|vähintään|yli|au\s+moins|minst)\s+)?(?<minimum>${EXPERIENCE_NUMBER})\s*(?:(?:${RANGE_SEPARATOR})\s*(?<maximum>${EXPERIENCE_NUMBER})|(?<plus>\+))?\s*(?<unit>${DURATION_UNITS})\b`,
  'giu',
);
const HEADING_MARKER = '__CAREER_OPS_EXPERIENCE_HEADING__';
const PREFERRED_SECTION = /^(?:(?:strongly\s+)?preferred(?:\s+(?:qualifications?|experience))?|desired(?:\s+(?:qualifications?|experience))?|good\s+to\s+have|nice[\s-]+to[\s-]+have(?:s|'s)?|bonus(?:\s+points(?:\s+for)?)?|wünschenswert|von\s+vorteil|eduksi\s+katsotaan|plussaa)\s*:?\s*$/iu;
const REQUIRED_SECTION = /^(?:requirements?|qualifications?|required\s+qualifications?|minimum\s+qualifications?|must\s+have(?:s)?|what\s+you(?:'|\u2019)?ll\s+need|candidate\s+profile|what\s+we(?:'|\u2019)?re\s+looking\s+for|what\s+we\s+expect|anforderungen|dein\s+profil|was\s+du\s+mitbringst|vaatimukset|odotamme\s+sinulta)\s*:?\s*$/iu;
const NON_REQUIREMENT_SECTION = /^(?:about\s+(?:us|the\s+company|company)|benefits?|what\s+we\s+offer|our\s+story|company\s+history|culture|vorteile|förmåner|edut)\s*:?\s*$/iu;
const DIRECT_PREFERRED_PREFIX = /(?:^|[:(]\s*)(?:ideally|preferably|nice\s+to\s+have(?:s|'s)?|bonus(?:\s+points\s+for)?|preferred(?:\s+qualifications?)?|idealerweise|wünschenswert|von\s+vorteil|ein\s+plus|eduksi(?:\s+katsotaan)?|plussaa|un\s+atout|souhaité(?:e?s?)?|meriterande)\s*[,;:]?\s*$/iu;
const DIRECT_PREFERRED_CONTEXT = /(?:^|[:(]\s*)toivomme\b[^.;\n]*$/iu;
const DIRECT_PREFERRED_SUFFIX = /^[\s,;:]*(?:\(\s*)?(?:(?:(?:of\s+(?:[\p{L}\p{N}/+_-]+\s+){0,4})?experience|d['’]expérience|(?:de\s+)?(?:l['’])?expérience|Berufs?erfahrung|Erfahrung|kokemus(?:ta|en)?|erfarenhet)\s*[,;:]?\s*)?(?:\(\s*)?(?:(?:is|would\s+be|wäre|wären|ist|sind|on|olisi|est|serait)\s+)?(?:preferred\b|(?:is\s+)?a\s+plus\b|wünschenswert\b|von\s+vorteil\b|ein\s+plus\b|eduksi\b|plussaa\b|souhait\u00e9(?:e?s?)?(?![\p{L}\p{N}_])|un\s+atout\b|meriterande\b)(?:\s*\))?/iu;
const UNKNOWN_NUMERIC_RANGE_SEPARATOR = /[\p{Dash_Punctuation}\u2212]/u;
const EXPERIENCE_DURATION = String.raw`${EXPERIENCE_NUMBER}\s*(?:(?:\+)|(?:${RANGE_SEPARATOR}\s*${EXPERIENCE_NUMBER}))?\s*${DURATION_UNITS}\b`;
const ORGANIZATION_HISTORY = new RegExp(
  String.raw`\b(?:we|company|business|organization|product|our\s+(?:company|business|organization|product)|the\s+(?:company|business|organization|product))\b[\s\S]{0,60}\b(?:operated|operating|served|serving|existed|exists|existing|built|building|founded|established|run|running|maintained|maintaining)\b[\s\S]{0,80}${EXPERIENCE_DURATION}`,
  'i',
);
const ROLE_DURATION = new RegExp(
  String.raw`\b(?:this|the)\s+role\b[\s\S]{0,30}\b(?:lasts?|runs?)\b[\s\S]{0,30}${EXPERIENCE_DURATION}`,
  'i',
);
const BENEFIT_DURATION = new RegExp(
  String.raw`\b${DURATION_UNITS}\b[\s\S]{0,45}\b(?:for|until|before|paid|extra|annual)\s+(?:pension|vesting|benefits?|vacation|leave|parental\s+leave|congé|urlaub|loma|etu|förmåner)\b`,
  'iu',
);
const COLLECTIVE_EXPERIENCE_CONTEXT = new RegExp(
  String.raw`(?:${EXPERIENCE_DURATION}\s+(?:of\s+)?(?:combined|collective)\s+(?:team\s+)?experience\b|\b(?:combined|collective)\s+(?:team\s+)?experience\s+(?:of\s+)?${EXPERIENCE_DURATION})`,
  'gi',
);
const TEAM_EXPERIENCE_SUBJECT = /\b(?:team|our\s+(?:engineers|employees|colleagues|founders))\b(?:(?!\b(?:you|your|applicants?|candidates?|need(?:s)?|requires?|must|should)\b)[^.;\n]){0,120}$/i;
const NEGATIVE_EXPERIENCE_CONTEXT = [
  new RegExp(String.raw`\b${DURATION_UNITS}\s+(?:old|ago|of\s+age|in\s+business|of\s+(?:service|employment|tenure|vacation|leave|benefits?|history|company(?:\s+history)?|business(?:\s+history)?|product(?:\s+history)?))\b`, 'iu'),
  ORGANIZATION_HISTORY,
  new RegExp(String.raw`\b(?:company|business|organization|product)\s+(?:age|history)\b[\s\S]{0,40}\b${EXPERIENCE_DURATION}`, 'i'),
  ROLE_DURATION,
  BENEFIT_DURATION,
  new RegExp(String.raw`\bseit\s+${EXPERIENCE_DURATION}[\s\S]{0,50}\b(?:am\s+markt|unternehmen|firma|markt)\b`, 'iu'),
  new RegExp(String.raw`\b(?:befristet|zeitlich\s+begrenzt)\b[\s\S]{0,30}\b(?:auf\s+)?${EXPERIENCE_DURATION}`, 'iu'),
  new RegExp(String.raw`\bprojekt\b[\s\S]{0,40}\b(?:dauert|läuft|laufzeit)\b[\s\S]{0,30}${EXPERIENCE_DURATION}`, 'iu'),
  new RegExp(String.raw`\byli\s+${EXPERIENCE_DURATION}\s+(?:kokemusta\s+)?(?:yrityksenä|yrityksessä|yrityksen)\b`, 'iu'),
  new RegExp(String.raw`\b${DURATION_UNITS}\b[\s\S]{0,45}\b(?:cong\u00e9|avantages?|urlaub|elternzeit|loma|etuudet|f\u00f6rm\u00e5ner)(?![\p{L}\p{N}_])`, 'iu'),
  new RegExp(String.raw`\b${DURATION_UNITS}\b[\s\S]{0,45}\b(?:benefits?|vacation|leave|parental\s+leave)\b`, 'iu'),
  COLLECTIVE_EXPERIENCE_CONTEXT,
];
const CANDIDATE_EVIDENCE = /\b(?:professional|relevant|industry|commercial|hands?[- ]on|experience|Berufserfahrung|Erfahrung|kokemus|kokemusta|expérience|erfarenhet)(?![\p{L}\p{N}_])/iu;
const CANDIDATE_SUBJECT_EVIDENCE = /\b(?:applicants?|candidates?|you|your|must\s+have|required|requires?|at\s+least|seeking|need(?:s)?|Sie|Du|Ihr|sinulla|sinä|vous|tu)(?![\p{L}\p{N}_])/iu;
const CANDIDATE_ACTIVITY_EVIDENCE = /\b(?:building|working|developing|engineering|designing|managing|operating|serving)\b/i;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function experienceYearsFor(value) {
  const wordValue = LOCALIZED_NUMBER_WORDS.get(value.toLowerCase());
  return wordValue ?? Number(value.replace(',', '.'));
}

function normalizedExperienceValue(value, unit) {
  const years = experienceYearsFor(value);
  return /^(?:months?|Monate?n?|Monaten|kuukautta|kuukauden|kuukausi|kuukaudet|mois|månader|månad|månaderna)$/iu.test(unit)
    ? years / 12
    : years;
}

export function normalizeExperiencePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.enabled === false) return null;
  return Object.freeze({
    normalMaxYears: finiteNumber(value.normal_max_years, DEFAULTS.normalMaxYears),
    outsideMinYears: finiteNumber(value.outside_min_years, DEFAULTS.outsideMinYears),
  });
}

function decodeHtmlEntities(value) {
  const named = new Map([
    ['nbsp', ' '], ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
    ['ndash', '\u2013'], ['mdash', '\u2014'],
  ]);
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, key) => {
    if (key[0] === '#') {
      const number = key[1].toLowerCase() === 'x'
        ? Number.parseInt(key.slice(2), 16)
        : Number.parseInt(key.slice(1), 10);
      const validScalar = Number.isFinite(number)
        && number >= 0
        && number <= 0x10FFFF
        && !(number >= 0xD800 && number <= 0xDFFF);
      return validScalar ? String.fromCodePoint(number) : entity;
    }
    return named.get(key.toLowerCase()) ?? entity;
  });
}

function plainHtmlText(value) {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function structuredLines(text) {
  const withHeadings = text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_match, _level, body) => (
      `\n${HEADING_MARKER}${plainHtmlText(body)}\n`
    ))
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/?\s*(?:li|p|ul|ol|div|section|article|table|thead|tbody|tr|td|th|dl|dt|dd)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeHtmlEntities(withHeadings)
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .map(line => ({ heading: line.startsWith(HEADING_MARKER), text: line.replace(HEADING_MARKER, '').trim() }))
    .filter(line => line.text);
}

function clauseBounds(text, start, end) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const left = Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1;
  const stops = [after.indexOf('.'), after.indexOf(';'), after.indexOf('\n')].filter(index => index >= 0);
  const right = stops.length ? end + Math.min(...stops) : text.length;
  return { left, right };
}

function sectionStateFor(value) {
  const heading = value.replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();
  if (PREFERRED_SECTION.test(heading)) return 'preferred';
  if (REQUIRED_SECTION.test(heading)) return 'required';
  if (NON_REQUIREMENT_SECTION.test(heading)) return 'non_requirement';
  return null;
}

function strengthFor(text, start, end, sectionState) {
  if (sectionState === 'preferred') return 'preferred';
  const { left, right } = clauseBounds(text, start, end);
  const before = text.slice(left, start).trim().replace(/^[-*•]\s*/, '');
  const after = text.slice(end, right).trim();
  if (DIRECT_PREFERRED_PREFIX.test(before) || DIRECT_PREFERRED_CONTEXT.test(before)) return 'preferred';
  if (DIRECT_PREFERRED_SUFFIX.test(after)) return 'preferred';
  return 'required';
}

function isOrphanUpperBound(text, start) {
  const before = text.slice(0, start);
  if (/(?:^|[^\d])\d[\d.,]*[,.]\s*$/u.test(before)) return true;
  if (/\b(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)[\s\p{Dash_Punctuation}\u2212]+$/iu.test(before)) return true;
  return new RegExp(String.raw`\b${EXPERIENCE_NUMBER}\s*${UNKNOWN_NUMERIC_RANGE_SEPARATOR.source}\s*$`, 'iu').test(before);
}

function hasNegativeExperienceContext(text, start, end) {
  const { left, right } = clauseBounds(text, start, end);
  const clause = text.slice(left, right);
  return NEGATIVE_EXPERIENCE_CONTEXT.some((pattern) => {
    if (pattern !== COLLECTIVE_EXPERIENCE_CONTEXT) return pattern.test(clause);
    return Array.from(clause.matchAll(pattern)).some(match => (
      match.index < end - left && match.index + match[0].length > start - left
      && (TEAM_EXPERIENCE_SUBJECT.test(clause.slice(0, match.index)) || /\bteam\s+experience\b/i.test(match[0]))
    ));
  });
}

function isConciseNumericPrefix(value) {
  const before = value.trim().replace(/^[-*•]\s*/, '');
  return before === ''
    || new RegExp(String.raw`^(?:${REQUIREMENT_QUALIFIER})\s*$`, 'iu').test(before)
    || DIRECT_PREFERRED_PREFIX.test(before);
}

function hasConciseNumericLead(text, start) {
  if (isConciseNumericPrefix(text.slice(0, start))) return true;

  const firstMatch = text.matchAll(EXPERIENCE_PATTERN).next().value;
  return Boolean(firstMatch)
    && firstMatch.index < start
    && !isOrphanUpperBound(text, firstMatch.index)
    && isConciseNumericPrefix(text.slice(0, firstMatch.index));
}

function isCandidateExperienceEvidence(text, start, end, sectionState) {
  if (hasNegativeExperienceContext(text, start, end)) return false;
  if (sectionState === 'required' || sectionState === 'preferred') return true;

  const { left, right } = clauseBounds(text, start, end);
  const clause = text.slice(left, right);
  const explicitCandidateRequirement = CANDIDATE_SUBJECT_EVIDENCE.test(clause);
  const explicitExperience = CANDIDATE_EVIDENCE.test(clause);
  const candidateActivity = CANDIDATE_ACTIVITY_EVIDENCE.test(clause);
  if (sectionState === 'non_requirement') {
    return explicitCandidateRequirement && (explicitExperience || candidateActivity);
  }
  return hasConciseNumericLead(text, start) || explicitExperience || explicitCandidateRequirement;
}

function interpretationFor(requirement, policy) {
  const { minimumYears, maximumYears, bound } = requirement;
  if (bound === 'range') {
    if (maximumYears <= policy.normalMaxYears) return 'normal';
    if (minimumYears < policy.outsideMinYears) return 'stretch';
    return 'outside';
  }
  if (minimumYears <= policy.normalMaxYears) return 'normal';
  if (minimumYears < policy.outsideMinYears) return 'stretch';
  return 'outside';
}

export function extractExperienceRequirements(text, policyValue = DEFAULTS) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const policy = policyValue?.normalMaxYears === undefined
    ? normalizeExperiencePolicy(policyValue) || DEFAULTS
    : policyValue;
  const requirements = [];
  let sectionState = 'unscoped';
  for (const line of structuredLines(text)) {
    const headingState = sectionStateFor(line.text);
    if (line.heading || headingState) {
      sectionState = headingState || 'unscoped';
      continue;
    }
    for (const match of line.text.matchAll(EXPERIENCE_PATTERN)) {
      if (isOrphanUpperBound(line.text, match.index)) continue;
      if (!isCandidateExperienceEvidence(line.text, match.index, match.index + match[0].length, sectionState)) continue;
      const { minimum, maximum, plus, minimumQualifier, unit } = match.groups;
      const minimumYears = normalizedExperienceValue(minimum, unit);
      const maximumYears = maximum === undefined ? null : normalizedExperienceValue(maximum, unit);
      const bound = maximumYears !== null ? 'range' : (minimumQualifier || plus ? 'minimum' : 'exact');
      const strength = strengthFor(line.text, match.index, match.index + match[0].length, sectionState);
      const interpretation = interpretationFor({ minimumYears, maximumYears, bound }, policy);
      requirements.push({
        text: match[0].replace(/\s+/g, ' ').trim(),
        minimum_years: minimumYears,
        maximum_years: maximumYears,
        bound,
        strength,
        interpretation,
        hard_blocker: strength === 'required' && interpretation === 'outside',
      });
    }
  }
  return requirements;
}

export function isNumericExperienceKeyword(value) {
  if (typeof value !== 'string') return false;
  return extractExperienceRequirements(value).length > 0;
}

export function classifyExperienceRequirements(text, policyValue) {
  const policy = policyValue?.normalMaxYears === undefined
    ? normalizeExperiencePolicy(policyValue)
    : policyValue;
  if (!policy) return null;
  const requirements = extractExperienceRequirements(text, policy);
  if (requirements.length === 0) return null;
  const required = requirements.filter(item => item.strength === 'required');
  const interpretation = required.length === 0
    ? 'preferred_only'
    : required.reduce((highest, item) => (
      SEVERITY[item.interpretation] > SEVERITY[highest] ? item.interpretation : highest
    ), 'normal');
  const blockingRequirements = required.filter(item => item.hard_blocker);
  const result = {
    interpretation,
    numeric_hard_blocker: blockingRequirements.length > 0,
    requirements,
    policy: {
      normal_max_years: policy.normalMaxYears,
      outside_min_years: policy.outsideMinYears,
    },
  };
  if (blockingRequirements.length > 0) {
    const minimum = Math.min(...blockingRequirements.map(item => item.minimum_years));
    result.hard_blocker_reason = `required experience starts at ${minimum} years (outside configured target)`;
  }
  return result;
}
