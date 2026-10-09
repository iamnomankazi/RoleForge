import yaml from 'js-yaml';

export const BLOCKER_CODES = Object.freeze([
  'language_required', 'work_auth_restricted', 'location_ineligible', 'graduation_window',
  'experience_outside', 'seniority_title', 'profile_exclusion', 'skill_gap_hard', 'posting_closed',
]);
export const FLAG_CODES = Object.freeze([
  'sponsorship_unknown', 'liveness_unconfirmed', 'experience_stretch', 'language_preferred',
]);

// These are the existing scan-candidate-contract.mjs MATCH_BUCKETS values.
const BUCKETS = { strong: 'Strong Match', good: 'Viable Apply', possible: 'Stretch Credible', weak: 'Stretch Credible' };
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function fitBand(score) {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 1 || score > 5) return null;
  return score >= 4.5 ? 'strong' : score >= 4 ? 'good' : score >= 3.5 ? 'possible' : 'weak';
}

function entries(value, codes, name, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${name} must be an array`);
    return [];
  }
  value.forEach((entry, index) => {
    const path = `${name}[${index}]`;
    if (!object(entry)) {
      errors.push(`${path} must be an object with code and evidence`);
      return;
    }
    if (!codes.includes(entry.code)) errors.push(`${path}.code is unknown: ${String(entry.code)}`);
    if (!text(entry.evidence)) errors.push(`${path}.evidence must be non-empty quoted JD text or a profile fact`);
    if (own(entry, 'detail') && typeof entry.detail !== 'string') errors.push(`${path}.detail must be a string`);
  });
  return value;
}

// Optional prescreen uses exactly { blockers: [{code, evidence, detail}], flags: [...] }.
// Its evidence is merged with evaluator evidence, never replaced or inferred.
export function deriveAssessment(input = {}) {
  const errors = [];
  if (!object(input)) return { fit_band: null, action: 'skip', bucket: null, errors: ['assessment must be an object'] };
  const { fit_score, liveness, review_reason } = input;
  const fit_band = fitBand(fit_score);
  if (!fit_band) errors.push('fit_score must be a finite number from 1.0 to 5.0');
  const blockers = [...entries(own(input, 'blockers') ? input.blockers : [], BLOCKER_CODES, 'blockers', errors)];
  const flags = [...entries(own(input, 'flags') ? input.flags : [], FLAG_CODES, 'flags', errors)];
  if (own(input, 'prescreen')) {
    if (!object(input.prescreen)) errors.push('prescreen must be an object');
    else {
      blockers.push(...entries(input.prescreen.blockers, BLOCKER_CODES, 'prescreen.blockers', errors));
      flags.push(...entries(input.prescreen.flags, FLAG_CODES, 'prescreen.flags', errors));
    }
  }
  if (!['confirmed', 'unconfirmed'].includes(liveness)) errors.push('liveness must be confirmed or unconfirmed');
  const unconfirmedFlag = flags.some((flag) => flag?.code === 'liveness_unconfirmed');
  if (liveness === 'confirmed' && unconfirmedFlag) errors.push('liveness confirmed contradicts liveness_unconfirmed flag');
  if (liveness === 'confirmed' && blockers.some((blocker) => blocker?.code === 'posting_closed')) {
    errors.push('liveness confirmed contradicts posting_closed blocker');
  }
  const confirmed = liveness === 'confirmed' && !unconfirmedFlag;
  const action = blockers.length || !fit_band ? 'skip'
    : fit_score >= 4 && confirmed ? 'apply'
      : fit_score >= 3.5 ? 'review' : 'skip';
  if (action === 'review' && (!text(review_reason) || /[\r\n]/.test(review_reason))) {
    errors.push('review_reason must be a non-empty one-line reason when action is review');
  }
  const bucket = blockers.length ? 'Blocked' : BUCKETS[fit_band] ?? null;
  return { fit_band, action, bucket, errors };
}

// Validation returns derived fields plus valid/errors; it never trusts stated decisions.
export function validateMachineSummary(obj) {
  const assessment = deriveAssessment(obj);
  const errors = [...assessment.errors];
  if (object(obj)) {
    if (obj.legacy === true) errors.push('legacy summary needs re-assessment');
    for (const key of ['company', 'role', 'location_country']) {
      if (!text(obj[key])) errors.push(`${key} must be a non-empty string`);
    }
    for (const key of ['blockers', 'flags']) {
      if (!own(obj, key)) errors.push(`${key} is required (use [] when empty)`);
    }
    for (const key of ['action', 'fit_band', 'bucket']) {
      if (own(obj, key) && obj[key] !== assessment[key]) errors.push(`${key} contradicts derived ${key}: ${assessment[key]}`);
    }
    // Reject old decision/evidence aliases in new reports rather than silently ignoring them.
    for (const key of ['score', 'match_bucket', 'hardBlockers', 'hard_blockers', 'hard_stops', 'final_decision', 'application_worthy']) {
      if (own(obj, key)) errors.push(`${key} is a legacy field; use the assessment contract`);
    }
    if (Array.isArray(obj.errors)) errors.push(...obj.errors);
  }
  return { ...assessment, valid: errors.length === 0, errors };
}

// null means no Machine Summary. Malformed YAML is returned as an invalid new
// summary with errors, so consumers can keep it out of Apply/Review.
export function parseReportMachineSummary(markdown) {
  if (typeof markdown !== 'string') return null;
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const isHeading = (line) => /^ {0,3}#{1,6}\s+/.test(line);
  const start = lines.findIndex((line) => /^ {0,3}#{2,6}\s+Machine Summary\s*$/i.test(line));
  if (start < 0) return null;
  let end = lines.length;
  let fenceIndex = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isHeading(lines[index])) { end = index; break; }
    if (/^ {0,3}(?:`{3,}|~{3,})(?:ya?ml)?[ \t]*$/i.test(lines[index])) {
      fenceIndex = index;
      break;
    }
  }
  let section = lines.slice(start + 1, end);
  let body = section;
  if (fenceIndex >= 0) {
    const opener = lines[fenceIndex].match(/^( *)(`{3,}|~{3,})(?:ya?ml)?[ \t]*$/i);
    const openingIndent = opener[1].length;
    const marker = opener[2];
    const closingFence = /^ *(\`+|~+)[ \t]*$/;
    let close = -1;
    for (let index = fenceIndex + 1; index < lines.length; index += 1) {
      const candidate = lines[index].match(closingFence);
      if (candidate && candidate[1][0] === marker[0] && candidate[1].length >= marker.length
        && lines[index].match(/^ */)[0].length <= openingIndent) {
        close = index;
        break;
      }
    }
    if (close < 0) return { legacy: false, errors: ['Machine Summary YAML fence is not closed'] };
    end = lines.findIndex((line, index) => index > close && isHeading(line));
    if (end < 0) end = lines.length;
    section = lines.slice(start + 1, end);
    body = lines.slice(fenceIndex + 1, close);
  } else {
    // Older reports also use Markdown's four-space indented YAML blocks.
    while (body.length && !body[0].trim()) body.shift();
    const codeIndent = body[0]?.match(/^ */)[0].length ?? 0;
    if (codeIndent >= 4) {
      const afterCode = body.findIndex((line) => line.trim() && line.match(/^ */)[0].length < codeIndent);
      if (afterCode >= 0) body = body.slice(0, afterCode);
    }
    const separator = body.findIndex((line) => /^\s*---\s*$/.test(line));
    if (separator >= 0) body = body.slice(0, separator);
  }
  const nonempty = body.filter((line) => line.trim());
  const indent = nonempty.length ? Math.min(...nonempty.map((line) => line.match(/^ */)[0].length)) : 0;
  try {
    const summary = yaml.load(body.map((line) => line.slice(indent)).join('\n'), { schema: yaml.JSON_SCHEMA });
    if (!object(summary)) return { legacy: false, errors: ['Machine Summary must contain a YAML object'] };
    const modern = ['fit_score', 'action', 'fit_band', 'review_reason', 'liveness', 'prescreen'].some((key) => own(summary, key))
      || ['blockers', 'flags'].some((key) => Array.isArray(summary[key]) && summary[key].some(object));
    return { ...summary, legacy: !modern };
  } catch (error) {
    return { legacy: false, errors: [`Invalid Machine Summary YAML: ${error.message}`] };
  }
}
