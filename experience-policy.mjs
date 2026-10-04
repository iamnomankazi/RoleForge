const DEFAULTS = Object.freeze({
  normalMaxYears: 2,
  outsideMinYears: 4,
});

const SEVERITY = Object.freeze({ normal: 0, stretch: 1, outside: 2 });
const EXPERIENCE_PATTERN = /\b(?:(?:approximately|approx\.?|about|around)\s+)?(?:(at\s+least|minimum(?:\s+of)?)\s+)?(\d+(?:\.\d+)?)\s*(?:(?:[-\u2010-\u2014\u2212]|\bto\b)\s*(\d+(?:\.\d+)?)|(\+))?\s*(?:years?|yrs?)\b/giu;
const HEADING_MARKER = '__CAREER_OPS_EXPERIENCE_HEADING__';
const PREFERRED_SECTION = /^(?:preferred\s+qualifications?|preferred\s+experience|nice\s+to\s+have(?:s|'s)?|bonus(?:\s+points(?:\s+for)?)?)\s*:?\s*$/i;
const REQUIRED_SECTION = /^(?:requirements?|qualifications?|required\s+qualifications?|minimum\s+qualifications?|must\s+have(?:s)?|what\s+you(?:'|\u2019)?ll\s+need|candidate\s+profile|what\s+we(?:'|\u2019)?re\s+looking\s+for|what\s+we\s+expect)\s*:?\s*$/i;
const NON_REQUIREMENT_SECTION = /^(?:about\s+(?:us|the\s+company|company)|benefits?|what\s+we\s+offer|our\s+story|company\s+history|culture)\s*:?\s*$/i;
const DIRECT_PREFERRED_PREFIX = /(?:^|[:(]\s*)(?:ideally|preferably|nice\s+to\s+have(?:s|'s)?|bonus(?:\s+points\s+for)?|preferred(?:\s+qualifications?)?)\s*[,;:]?\s*$/i;
const DIRECT_PREFERRED_SUFFIX = /^[\s,;:]*(?:\(\s*)?(?:(?:of\s+(?:[\p{L}\p{N}/+_-]+\s+){0,4})?experience\s*[,;:]?\s*)?(?:preferred\b|(?:is\s+)?a\s+plus\b)(?:\s*\))?/iu;
const UNKNOWN_NUMERIC_RANGE_SEPARATOR = /[\p{Dash_Punctuation}\u2212]/u;
const NEGATIVE_EXPERIENCE_CONTEXT = [
  /\b(?:years?|yrs?)\s+(?:old|ago|of\s+age|in\s+business|of\s+(?:service|employment|tenure|vacation|leave|benefits?|history|company(?:\s+history)?|business(?:\s+history)?|product(?:\s+history)?))\b/i,
  /\b(?:founded|established|operated|operating|served|serving|existed|exists|built|building)\b[\s\S]{0,80}\b\d+(?:\.\d+)?\s*(?:years?|yrs?)\b/i,
  /\b(?:company|business|organization|product)\s+(?:age|history)\b[\s\S]{0,40}\b\d+(?:\.\d+)?\s*(?:years?|yrs?)\b/i,
  /\b(?:we|our|the\s+company|our\s+company|the\s+business|our\s+product)\b[\s\S]{0,60}\b(?:have|has|is|was|been|operated|operating|served|serving|existed|built|building)\b[\s\S]{0,80}\b\d+(?:\.\d+)?\s*(?:years?|yrs?)\b/i,
  /\b(?:vacation|leave|benefits?|tenure|probation)\b/i,
];
const CANDIDATE_EVIDENCE = /\b(?:applicant|candidate|you|your|must\s+have|required|minimum|at\s+least|need(?:s)?|seeking|professional|relevant|industry|commercial|hands?[- ]on|experience|role|domain|skill|requirements?|building|working|developing|engineering|designing|managing|operating|serving)\b/i;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
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
  if (DIRECT_PREFERRED_PREFIX.test(before)) return 'preferred';
  if (DIRECT_PREFERRED_SUFFIX.test(after)) return 'preferred';
  return 'required';
}

function isOrphanUpperBound(text, start) {
  const before = text.slice(0, start);
  return new RegExp(`\\b\\d+(?:\\.\\d+)?\\s*${UNKNOWN_NUMERIC_RANGE_SEPARATOR.source}\\s*$`, 'u').test(before);
}

function hasNegativeExperienceContext(text, start, end) {
  const { left, right } = clauseBounds(text, start, end);
  const clause = text.slice(left, right);
  return NEGATIVE_EXPERIENCE_CONTEXT.some((pattern) => pattern.test(clause));
}

function isConciseNumericPrefix(value) {
  const before = value.trim().replace(/^[-*•]\s*/, '');
  return before === ''
    || /^(?:approximately|approx\.?|about|around|at\s+least|minimum(?:\s+of)?)\s*$/i.test(before)
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
  const explicitCandidateRequirement = CANDIDATE_EVIDENCE.test(clause);
  if (sectionState === 'non_requirement') {
    return explicitCandidateRequirement && /\b(?:applicant|candidate|you|your|must\s+have|required|minimum|at\s+least)\b/i.test(clause);
  }
  return hasConciseNumericLead(text, start) || explicitCandidateRequirement;
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
      const minimumYears = Number(match[2]);
      const maximumYears = match[3] === undefined ? null : Number(match[3]);
      const bound = maximumYears !== null ? 'range' : (match[1] || match[4] ? 'minimum' : 'exact');
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
