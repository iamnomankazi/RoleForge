const DEFAULTS = Object.freeze({
  normalMaxYears: 2,
  normalRangeMaxYears: 3,
  outsideMinYears: 4,
});

const SEVERITY = Object.freeze({ normal: 0, stretch: 1, outside: 2 });
const PREFERRED_LANGUAGE = /\b(?:preferred|ideally|nice[\s-]+to[\s-]+have|bonus|advantageous|(?:is|as)\s+a\s+plus)\b/i;
const EXPERIENCE_PATTERN = /\b(?:(?:approximately|approx\.?|about|around)\s+)?(?:(at\s+least|minimum(?:\s+of)?)\s+)?(\d+(?:\.\d+)?)\s*(?:(?:[-\u2013\u2014]|to)\s*(\d+(?:\.\d+)?)|(\+))?\s*(?:years?|yrs?)\b/giu;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function normalizeExperiencePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.enabled === false) return null;
  return Object.freeze({
    normalMaxYears: finiteNumber(value.normal_max_years, DEFAULTS.normalMaxYears),
    normalRangeMaxYears: finiteNumber(value.normal_range_max_years, DEFAULTS.normalRangeMaxYears),
    outsideMinYears: finiteNumber(value.outside_min_years, DEFAULTS.outsideMinYears),
  });
}

function clauseAround(text, start, end) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const left = Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1;
  const stops = [after.indexOf('.'), after.indexOf(';'), after.indexOf('\n')].filter(index => index >= 0);
  const right = stops.length ? end + Math.min(...stops) : text.length;
  return text.slice(left, right);
}

function interpretationFor(requirement, policy) {
  const { minimumYears, maximumYears, bound } = requirement;
  if (bound === 'range') {
    if (minimumYears <= policy.normalMaxYears && maximumYears <= policy.normalRangeMaxYears) return 'normal';
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
  for (const match of text.matchAll(EXPERIENCE_PATTERN)) {
    const minimumYears = Number(match[2]);
    const maximumYears = match[3] === undefined ? null : Number(match[3]);
    const bound = maximumYears !== null ? 'range' : (match[1] || match[4] ? 'minimum' : 'exact');
    const strength = PREFERRED_LANGUAGE.test(clauseAround(text, match.index, match.index + match[0].length))
      ? 'preferred'
      : 'required';
    const requirement = {
      text: match[0].replace(/\s+/g, ' ').trim(),
      minimum_years: minimumYears,
      maximum_years: maximumYears,
      bound,
      strength,
    };
    requirement.interpretation = interpretationFor({ minimumYears, maximumYears, bound }, policy);
    requirements.push(requirement);
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
  return {
    interpretation,
    numeric_hard_blocker: false,
    requirements,
    policy: {
      normal_max_years: policy.normalMaxYears,
      normal_range_max_years: policy.normalRangeMaxYears,
      outside_min_years: policy.outsideMinYears,
    },
  };
}
