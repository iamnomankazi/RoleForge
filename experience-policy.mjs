const DEFAULTS = Object.freeze({
  normalMaxYears: 2,
  outsideMinYears: 4,
});

const SEVERITY = Object.freeze({ normal: 0, stretch: 1, outside: 2 });
const EXPERIENCE_PATTERN = /\b(?:(?:approximately|approx\.?|about|around)\s+)?(?:(at\s+least|minimum(?:\s+of)?)\s+)?(\d+(?:\.\d+)?)\s*(?:(?:[-\u2013\u2014]|to)\s*(\d+(?:\.\d+)?)|(\+))?\s*(?:years?|yrs?)\b/giu;
const HEADING_MARKER = '__CAREER_OPS_EXPERIENCE_HEADING__';
const PREFERRED_SECTION = /^(?:nice[\s-]+to[\s-]+haves?|bonus|preferred\s+qualifications?|preferred\s+experience)\s*:?[\s]*$/i;
const REQUIRED_SECTION = /^(?:requirements?|required\s+qualifications?|minimum\s+qualifications?|must[\s-]+haves?|what\s+you(?:'|\u2019)?ll\s+need)\s*:?[\s]*$/i;
const DIRECT_PREFERRED_PREFIX = /(?:^|[:(]\s*)(?:ideally|preferably|nice[\s-]+to[\s-]+have|bonus|preferred\s+qualifications?)\s*:?\s*$/i;
const DIRECT_PREFERRED_SUFFIX = /^(?:(?:of\s+(?:[\p{L}\p{N}/+_-]+\s+){0,4})?experience\s+)?(?:preferred\b|(?:is\s+)?a\s+plus\b)/iu;

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
      return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
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

function strengthFor(text, start, end, sectionStrength) {
  if (sectionStrength === 'preferred') return 'preferred';
  const { left, right } = clauseBounds(text, start, end);
  const before = text.slice(left, start).trim();
  const after = text.slice(end, right).trim();
  if (DIRECT_PREFERRED_PREFIX.test(before)) return 'preferred';
  if (DIRECT_PREFERRED_SUFFIX.test(after)) return 'preferred';
  return 'required';
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
  let sectionStrength = 'required';
  for (const line of structuredLines(text)) {
    if (PREFERRED_SECTION.test(line.text)) {
      sectionStrength = 'preferred';
      continue;
    }
    if (line.heading || REQUIRED_SECTION.test(line.text)) {
      sectionStrength = 'required';
      continue;
    }
    for (const match of line.text.matchAll(EXPERIENCE_PATTERN)) {
      const minimumYears = Number(match[2]);
      const maximumYears = match[3] === undefined ? null : Number(match[3]);
      const bound = maximumYears !== null ? 'range' : (match[1] || match[4] ? 'minimum' : 'exact');
      const strength = strengthFor(line.text, match.index, match.index + match[0].length, sectionStrength);
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
