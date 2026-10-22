import {
  applicationControlSignature,
  applicationFormStateFingerprint,
  classifyApplicationControl,
  classifyCaptchaState,
  classifyHumanGate,
  classifyHumanOnlyField,
  classifyUserGate,
  FINAL_TOKEN,
  inspectApplicationForm as inspectLegacyApplicationForm,
  isSemanticFinalAction,
  PROGRESSION_ACTION_LABEL,
  sanitizeHumanGateUrl,
  sanitizeUrl,
  sanitizePersistedUrls,
} from './application-form-core.mjs';
import {
  canonicalFieldValue,
  classifyFieldSemantics,
  cleanFormText,
  containsUnresolvedPlaceholder,
  generateCustomNarrativeAnswer,
  hashFormValue,
  isTraineeRole,
  normalizeNarrativeText,
  normalizeFormQuestion,
  preferredDeclineOption,
  stableFieldIdentity,
  validatePlannedValueForControl,
} from './application-form-policy.mjs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { validateNarrativeProvenanceRecord } from './application-evidence.mjs';
import {
  addPreparedAnswers,
  boundedProviderCall,
  buildReasoningCandidate,
  createReasoningState,
  createSemanticReasoningRequest,
  createSemanticVerifierRequest,
  fieldResolutionKey,
  makeRepairLedgerEntry,
  mergeResolutionLedger,
  publicLiveReasoningField,
  reasoningEvidence,
  resolutionForField,
  semanticFromAnnotation,
  validateSemanticAnnotationResponse,
  validateSemanticVerifierResponse,
  verifierTriggerReasons,
} from './application-reasoning.mjs';

const MAX_FIELD_ATTEMPTS = 2;
const MAX_CONTROLLED_RESUMES = 10;
export const MAX_PROGRESSION_TRANSITIONS = 8;
const DEFAULT_PROGRESSION_TRANSITION_MS = 10 * 1000;
const DEFAULT_PROGRESSION_STABILITY_MS = 600;

export const DEFAULT_LIVE_FORM_LIMITS = Object.freeze({
  sessionMs: 5 * 60 * 1000,
  normalFieldMs: 10 * 1000,
  choiceMs: 20 * 1000,
  uploadMs: 30 * 1000,
  maxAttempts: MAX_FIELD_ATTEMPTS,
});
const DEFAULT_PROGRESSION_SESSION_MS = DEFAULT_LIVE_FORM_LIMITS.sessionMs;
const REASONABLE_OPTION_MAPPING_CATEGORIES = new Set([
  'identity_contact', 'current_location', 'work_authorization',
  'sponsorship_employer_support', 'source_how_heard', 'education',
  'availability', 'relocation',
]);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function resolveOperationalFormLimits(profile = {}, overrides = {}) {
  const configured = profile?.formRules?.time_limits || {};
  const configuredMs = (key, fallback) => positiveInteger(Number(configured[key]) * 1000, fallback);
  return {
    sessionMs: Math.min(
      DEFAULT_LIVE_FORM_LIMITS.sessionMs,
      positiveInteger(overrides.sessionMs, configuredMs('session_seconds', DEFAULT_LIVE_FORM_LIMITS.sessionMs)),
    ),
    normalFieldMs: Math.min(
      DEFAULT_LIVE_FORM_LIMITS.normalFieldMs,
      positiveInteger(overrides.normalFieldMs, configuredMs('normal_field_seconds', DEFAULT_LIVE_FORM_LIMITS.normalFieldMs)),
    ),
    choiceMs: Math.min(
      DEFAULT_LIVE_FORM_LIMITS.choiceMs,
      positiveInteger(overrides.choiceMs, configuredMs('dropdown_autocomplete_seconds', DEFAULT_LIVE_FORM_LIMITS.choiceMs)),
    ),
    uploadMs: Math.min(
      DEFAULT_LIVE_FORM_LIMITS.uploadMs,
      positiveInteger(overrides.uploadMs, configuredMs('upload_seconds', DEFAULT_LIVE_FORM_LIMITS.uploadMs)),
    ),
    maxAttempts: Math.min(
      MAX_FIELD_ATTEMPTS,
      positiveInteger(overrides.maxAttempts, positiveInteger(configured.max_attempts, DEFAULT_LIVE_FORM_LIMITS.maxAttempts)),
    ),
  };
}

export function actionAttemptLimitMs(action, limits = DEFAULT_LIVE_FORM_LIMITS) {
  if (action?.action === 'upload') return limits.uploadMs;
  if (['select', 'autocomplete'].includes(action?.action)) return limits.choiceMs;
  return limits.normalFieldMs;
}

function digest(value) {
  return hashFormValue(JSON.stringify(value));
}

function humanGateOutcome(snapshot, stage) {
  const { gate } = classifyHumanGate(snapshot);
  return gate ? {
    state: 'human_action_required', ...gate, stage,
    currentUrl: sanitizeHumanGateUrl(snapshot.url || snapshot.currentUrl || 'about:blank'),
    reason: `Human action required: ${gate.cause}.`,
  } : null;
}

async function inspectLiveHumanGate(page, stage) {
  // Non-browser test adapters may execute a supplied action implementation.
  if (typeof page.locator !== 'function') return null;
  return humanGateOutcome(await inspectLegacyApplicationForm(page, { gateOnly: true }), stage);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.stableFieldId || row.fieldId}|${row.reason || ''}|${row.semantic || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeAnswerRecords(existing = [], additions = []) {
  const merged = [];
  const indexByIdentity = new Map();
  for (const record of [...existing, ...additions]) {
    const key = [
      cleanFormText(record?.candidateId),
      normalizeFormQuestion(record?.normalizedQuestion),
    ].join('|');
    const index = indexByIdentity.get(key);
    if (index === undefined) {
      indexByIdentity.set(key, merged.length);
      merged.push(record);
    } else {
      merged[index] = record;
    }
  }
  return merged;
}

function fieldQuestion(field) {
  return cleanFormText(field.questionText || field.groupLabel || field.label);
}

function workdayEntryFieldLabel(field) {
  const detail = fieldQuestion(field);
  const entry = cleanFormText(field.workdayBlockHeading);
  return entry ? `${entry}: ${detail}` : detail;
}

function optionsFor(field) {
  return (field.options || []).flatMap((option) => [
    { label: cleanFormText(option.label), value: cleanFormText(option.value) },
  ]).filter((option) => option.label || option.value);
}

function matchingOption(field, intended) {
  const normalized = normalizeFormQuestion(intended);
  return optionsFor(field).find((option) => (
    normalizeFormQuestion(option.label) === normalized
    || normalizeFormQuestion(option.value) === normalized
  )) || null;
}

function choiceMatches(field, intended) {
  const target = normalizeFormQuestion(intended);
  return [field.optionLabel, field.value, field.label]
    .map(normalizeFormQuestion)
    .some((value) => value === target || value.endsWith(` ${target}`));
}

// Several checkboxes sharing one name are the options of one question (Lever "multiple-select"). Pick the single
// option that carries the answer: an exact label match, else the one option starting with the answer word
// ("Yes - I need a visa ..."), dropping options that claim the candidate already lives in the employer's locations
// (the job is in another country) and "do not want to relocate" when a relocating option remains.
function chooseCheckboxGroupOption(group, intended, { candidateCountry = '', jobCountry = '' } = {}) {
  const answer = normalizeFormQuestion(intended);
  if (!answer) return null;
  const label = (option) => normalizeFormQuestion(option.optionLabel || option.value || option.label);
  const exact = group.filter((option) => label(option) === answer);
  if (exact.length === 1) return exact[0];
  let candidates = group.filter((option) => label(option).startsWith(`${answer} `));
  const livesInJobCountry = candidateCountry && jobCountry
    && normalizeFormQuestion(candidateCountry) === normalizeFormQuestion(jobCountry);
  if (candidates.length > 1 && !livesInJobCountry) {
    candidates = candidates.filter((option) => !/\balready (?:relocated|live|living|based|reside|residing)\b/.test(label(option)));
  }
  if (candidates.length > 1 && candidates.some((option) => /\b(?:would like to|can|willing to|able to) relocate\b/.test(label(option)))) {
    candidates = candidates.filter((option) => !/\b(?:do not|don t|not) (?:want|willing) to relocate\b/.test(label(option)));
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function controlAction(field, intended) {
  // A lone checkbox is ticked only for an affirmative answer; any other value (e.g. a nationality) is not a tick.
  if (field.type === 'checkbox') return /^(?:yes|true|i agree|agree|accept|i accept|i consent|consent)$/i.test(cleanFormText(intended)) ? 'check' : null;
  if (field.type === 'radio') return choiceMatches(field, intended) ? 'radio' : null;
  if (field.tag === 'select') return 'select';
  if (field.widget === 'workday-listbox') return 'listbox';
  if (field.role === 'combobox' || field.autocomplete === 'list') return 'autocomplete';
  return 'fill';
}

function listboxOptionMatches(label, action) {
  const normalized = normalizeFormQuestion(label);
  const optionMatch = action.optionMatch || null;
  if (optionMatch?.mode === 'degree') {
    const level = optionMatch.level.toLowerCase();
    if (new RegExp(`^${level}(?:s| s)?(?: degree)?$`).test(normalized)) return true;
    const subject = (value) => normalizeFormQuestion(value).split(' ')
      .filter((word) => !['master', 'masters', 'bachelor', 'bachelors', 's', 'degree', 'of', 'in'].includes(word))
      .sort().join(' ');
    return new RegExp(`^${level}(?:s| s)?\\b`).test(normalized)
      && Boolean(subject(optionMatch.qualification))
      && subject(normalized) === subject(optionMatch.qualification);
  }
  if (optionMatch?.mode === 'proficiency') {
    // The whole option must be an approved level label: "Advanced Beginner" or "Less than proficient" never pass.
    // CEFR codes ("C1", "C2 - "), a leading scale number (Workday "4 - Fluent") and bracketed notes are decoration.
    const core = normalizeFormQuestion(cleanFormText(label).replace(/\([^)]*\)/g, ' ')
      .replace(/^\s*\d+\s*[-–.:)]\s*/, ' ')
      .replace(/\b[abc][12]\b/gi, ' ').replace(/[-–:/]+/g, ' '));
    return (optionMatch.values || []).some((value) => core === normalizeFormQuestion(value));
  }
  if (optionMatch?.mode === 'education_month') {
    const index = Number(optionMatch.month) - 1;
    const month = new Date(Date.UTC(2000, index, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' });
    return [month, month.slice(0, 3), String(index + 1), String(index + 1).padStart(2, '0')]
      .some((value) => normalizeFormQuestion(value) === normalized);
  }
  return normalized === normalizeFormQuestion(action.value);
}

function pickOptionMatches(label, action) {
  if (action.pickKind === 'field_of_study') {
    return normalizeFormQuestion(label) === normalizeFormQuestion(action.value);
  }
  if (action.pickKind === 'phone_country') {
    const country = cleanFormText(action.value);
    const match = cleanFormText(label).match(/^(.+?)\s*\(\s*\+\d{1,4}\s*\)$/);
    return Boolean(match && normalizeFormQuestion(match[1]) === normalizeFormQuestion(country));
  }
  if (action.pickKind === 'skill') {
    return normalizeFormQuestion(label) === normalizeFormQuestion(action.value);
  }
  return (action.optionValues || [action.value])
    .some((value) => normalizeFormQuestion(label) === normalizeFormQuestion(value));
}

function pickFieldCommitted(field, action) {
  const values = Array.isArray(field.selectedItems)
    ? field.selectedItems.map(cleanFormText).filter(Boolean)
    : cleanFormText(field.value).split(/\s*,\s*/).filter(Boolean);
  if (action.pickKind === 'skill') return values.some((value) => pickOptionMatches(value, action));
  return values.length === 1 && pickOptionMatches(values[0], action);
}

function markdownSection(markdown, name) {
  const match = String(markdown || '').match(new RegExp(`^##\\s+${name}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s+|$(?![\\s\\S]))`, 'im'));
  return match?.[1] || '';
}

function cvTechnicalSkills(profile) {
  const section = markdownSection(profile?.cvText, 'Technical Skills');
  const seen = new Set();
  const skills = [];
  for (const raw of section.split(/[,;\r\n]+/)) {
    const skill = cleanFormText(raw.replace(/^\s*(?:[-*•]\s*)+/, '').replace(/\*\*/g, '').replace(/[.;]+$/, ''));
    const key = normalizeFormQuestion(skill);
    if (!skill || !key || /\b(?:familiar|basic)\b/i.test(skill) || seen.has(key)) continue;
    seen.add(key);
    skills.push(skill);
    if (skills.length >= 15) break;
  }
  return skills;
}

function markdownEntries(sectionName, profile) {
  const section = markdownSection(profile?.cvText, sectionName);
  const headings = [...section.matchAll(/^###\s+(.+)\s*$/gm)];
  return headings.map((heading, index) => {
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? section.length;
    return { heading: cleanFormText(heading[1]), body: section.slice(start, end) };
  });
}

function cvExperienceEntries(profile) {
  const entries = [];
  const skipped = [];
  for (const item of markdownEntries('Experience', profile)) {
    const heading = item.heading.match(/^([^|\r\n]+?)\s+\|\s+([^|\r\n]+?)\s*$/);
    if (!heading) {
      skipped.push(item.heading);
      continue;
    }
    const dateLine = item.body.match(/^\s*\*\*([^*\r\n]+)\*\*\s*$/m)?.[1] || '';
    const range = parseExperienceDateRange(dateLine);
    const bullets = item.body.split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S/.test(line));
    entries.push({
      title: cleanFormText(heading[1]),
      company: cleanFormText(heading[2]),
      start: range?.start || null,
      end: range?.end || null,
      current: Boolean(range?.current),
      description: bullets.join('\n'),
    });
  }
  return { entries, skipped };
}

function parseExperienceDateRange(value) {
  const monthNumbers = new Map([
    ['jan', '01'], ['january', '01'], ['feb', '02'], ['february', '02'], ['mar', '03'], ['march', '03'],
    ['apr', '04'], ['april', '04'], ['may', '05'], ['jun', '06'], ['june', '06'], ['jul', '07'], ['july', '07'],
    ['aug', '08'], ['august', '08'], ['sep', '09'], ['sept', '09'], ['september', '09'], ['oct', '10'],
    ['october', '10'], ['nov', '11'], ['november', '11'], ['dec', '12'], ['december', '12'],
  ]);
  const month = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const match = cleanFormText(value).match(new RegExp(`^${month}\\s+(\\d{4})\\s*[-\\u2010-\\u2015]\\s*(${month}\\s+\\d{4}|Present|Current)$`, 'i'));
  if (!match) return null;
  const toDate = (monthName, year) => ({ month: monthNumbers.get(monthName.toLowerCase()), year });
  const start = toDate(match[1], match[2]);
  const current = /^(?:present|current)$/i.test(match[3]);
  const endMatch = current ? null : match[3].match(new RegExp(`^${month}\\s+(\\d{4})$`, 'i'));
  return { start, end: endMatch ? toDate(endMatch[1], endMatch[2]) : null, current };
}

function cvEducationData(profile) {
  const entries = [];
  const skipped = [];
  for (const { heading: school, body } of markdownEntries('Education', profile)) {
    const line = body.match(/^\s*\*\*([^*\r\n]+)\*\*(?:\s*\|\s*([^\r\n]+))?\s*$/m);
    if (!line || !/\b(?:master|bachelor)(?:'|\u2019)?s?\b/i.test(line[1])) {
      skipped.push(school);
      continue;
    }
    const degree = cleanFormText(line[1]);
    // "Degree, Subject", else the subject after " in " / " of ": Master of Computer Science -> Computer Science.
    const subject = degree.match(/^[^,]+,\s*(.+)$/)?.[1]?.trim()
      || degree.match(/\bin\s+(.+)$/i)?.[1]?.trim()
      || degree.match(/^(?:master|bachelor)'?s?\s+of\s+(.+)$/i)?.[1]?.trim() || '';
    const range = parseEducationDateRange(line[2]);
    const expected = expectedGraduationSegments(profile);
    entries.push({
      school,
      degree,
      subject,
      firstYear: range?.start?.year || '',
      firstMonth: range?.start?.month || '',
      lastYear: (range?.current ? expected?.year : range?.end?.year) || '',
      lastMonth: (range?.current ? expected?.month : range?.end?.month) || '',
      current: Boolean(range?.current),
    });
  }
  return { entries, skipped };
}

function expectedGraduationSegments(profile) {
  const match = cleanFormText(profile?.education?.expected_graduation_date).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() + 1 === Number(month) && date.getUTCDate() === Number(day)
    ? { day, month, year } : null;
}

function parseEducationDateRange(value) {
  const endpoints = cleanFormText(value).replace(/\s*\([^)]*\)\s*$/, '').split(/\s*[-\u2010-\u2015]\s*/);
  if (endpoints.length !== 2) return null;
  const parse = (text) => {
    const match = text.match(/^(?:([A-Za-z]+)\s+)?(\d{4})$/);
    if (!match) return null;
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const index = match[1] ? names.findIndex((name) => [name, name.slice(0, 3), ...(name === 'september' ? ['sept'] : [])].includes(match[1].toLowerCase())) : -1;
    if (match[1] && index < 0) return null;
    return { year: match[2], month: index < 0 ? '' : String(index + 1).padStart(2, '0') };
  };
  const start = parse(endpoints[0]);
  const current = /^(?:present|current)$/i.test(endpoints[1]);
  const end = current ? null : parse(endpoints[1]);
  if (!start || (!current && !end)) return null;
  return { start, end, current };
}

function cvEducationEntries(profile) {
  return cvEducationData(profile).entries;
}

function cleanSchoolName(value) {
  return cleanFormText(value).replace(/^the\s+/i, '');
}

function educationSchoolMatches(left, right) {
  const normalizeSchool = (value) => normalizeFormQuestion(cleanSchoolName(value));
  const a = normalizeSchool(left);
  const b = normalizeSchool(right);
  // Whole names only: "Indiana University of Pennsylvania" is not "University of Pennsylvania".
  return Boolean(a && b && a === b);
}

function educationFieldAnswer(field, semantics, profile) {
  const school = cleanSchoolName(field.educationSchool);
  const schoolEntries = markdownEntries('Education', profile).filter((entry) => educationSchoolMatches(entry.heading, school));
  const entries = cvEducationEntries(profile).filter((entry) => educationSchoolMatches(entry.school, school));
  if (schoolEntries.length !== 1 || entries.length !== 1) {
    if (field.required) throw new Error('The education block does not match exactly one supported CV school entry.');
    return { value: null, answerRecord: null };
  }
  const entry = entries[0];
  let value = null;
  let optionMatch = null;
  let sourceRef = 'cv.md';
  if (semantics.semantic === 'degree') {
    value = /\bmaster\b/i.test(entry.degree) ? 'Master' : 'Bachelor';
    optionMatch = { mode: 'degree', level: value, qualification: entry.degree };
  } else if (semantics.semantic === 'field_of_study') {
    value = entry.subject || null;
  } else {
    const segment = normalizeFormQuestion([field.questionText, field.label, field.id, field.name].filter(Boolean).join(' '))
      .match(/\b(start|end)(?: date)? (month|year)\b/);
    if (segment) {
      const [, endpoint, part] = segment;
      const raw = entry[`${endpoint === 'start' ? 'first' : 'last'}${part === 'month' ? 'Month' : 'Year'}`];
      if (endpoint === 'end' && entry.current) sourceRef = 'cv.md + config/profile.yml';
      if (raw && part === 'month') {
        optionMatch = { mode: 'education_month', month: raw };
        value = field.type === 'number' ? String(Number(raw))
          : new Date(Date.UTC(2000, Number(raw) - 1, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' });
      } else value = raw || null;
    }
  }
  if (value && field.tag === 'select') {
    let options = (field.options || []).filter((option) => optionMatch
      ? listboxOptionMatches(option.label, { value, optionMatch }) || listboxOptionMatches(option.value, { value, optionMatch })
      : normalizeFormQuestion(option.label) === normalizeFormQuestion(value));
    if (semantics.semantic === 'degree') {
      const exact = options.filter((option) => normalizeFormQuestion(option.label) === normalizeFormQuestion(entry.degree));
      if (exact.length) options = exact;
    }
    if (options.length !== 1) throw new Error('Education field has no unique visible option matching the CV entry.');
    value = options[0].label;
  }
  return { value, optionMatch, sourceRef, answerRecord: null };
}

function groundedDateSegments(value) {
  const text = cleanFormText(value);
  let year;
  let month;
  let day;
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [, year, month, day] = match;
  if (!match) {
    match = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
    if (match) {
      const first = Number(match[1]);
      const second = Number(match[2]);
      if (first > 12 && second <= 12) [, day, month, year] = match;
      else if (second > 12 && first <= 12) [, month, day, year] = match;
      else return null;
    }
  }
  if (!match) {
    match = text.match(/^(\d{1,2})[/.](\d{4})$/);
    if (match) [, month, year] = match;
  }
  if (!match) {
    match = text.match(/^(\d{4})-(\d{1,2})$/);
    if (match) [, year, month] = match;
  }
  if (!match && /^\d{4}$/.test(text)) year = text;
  if (!year || !/^\d{4}$/.test(String(year))) return null;
  const values = { year: String(year), month: month ? String(Number(month)).padStart(2, '0') : '', day: day ? String(Number(day)).padStart(2, '0') : '' };
  if (values.month && (Number(values.month) < 1 || Number(values.month) > 12)) return null;
  if (values.day && (Number(values.day) < 1 || Number(values.day) > 31)) return null;
  if (values.day && values.month && Number(values.day) > new Date(Date.UTC(Number(values.year), Number(values.month), 0)).getUTCDate()) return null;
  return values;
}

function cvLanguageLevels(profile) {
  const section = markdownSection(profile?.cvText, 'Languages');
  return [...section.matchAll(/^\s*[-*]\s*([^:\r\n]+):\s*([^\r\n]+?)\s*$/gm)]
    .map((match) => [cleanFormText(match[1]), cleanFormText(match[2])]);
}

function languageLevelForField(field, profile) {
  const blockLanguage = normalizeFormQuestion(field.workdayLanguage);
  if (!blockLanguage) return null;
  const matches = cvLanguageLevels(profile).filter(([language]) => {
    const normalized = normalizeFormQuestion(language);
    // Whole names only: Malay is not Malayalam.
    return blockLanguage === normalized;
  });
  return matches.length === 1 ? matches[0][1] : null;
}

function companyNamesFromContext(context = {}) {
  const values = [context.company, context.companyName, context.company_name, context.jobCompany,
    context.discovery?.company, context.candidate?.company, context.candidate?.companyName,
    context.candidate?.company_name, context.job?.company, context.job?.companyName];
  return [...new Set(values.map(cleanFormText).filter(Boolean))];
}

function applicationSourceOptionValues(value, context) {
  if (normalizeFormQuestion(value) !== normalizeFormQuestion('Company website')) return [value];
  const companyValues = companyNamesFromContext(context);
  return [...new Set([
    value,
    'Company Website',
    'Company Career Site',
    ...companyValues.map((company) => `${company} Careers Website`),
    'Career Site',
    'Careers Page',
  ].filter(Boolean))];
}

function groundedLocationComponents(action) {
  const combined = cleanFormText(action.locationGrounding?.combined || action.value);
  const parts = combined.split(',').map((part) => part.trim()).filter(Boolean);
  return {
    combined,
    city: cleanFormText(action.locationGrounding?.city || (parts.length > 1 ? parts[0] : '')),
    country: cleanFormText(action.locationGrounding?.country || (parts.length > 1 ? parts.at(-1) : '')),
  };
}

function groundedLocationMatches(value, action) {
  const normalized = normalizeFormQuestion(value);
  const intended = cleanFormText(action.value);
  if (action.semantic === 'city') {
    const grounding = groundedLocationComponents(action);
    const tokens = [grounding.city || intended, grounding.country].map(normalizeFormQuestion).filter(Boolean);
    return tokens.length === 2 && tokens.every((token) => (` ${normalized} `).includes(` ${token} `));
  }
  if (action.semantic === 'country') {
    return Boolean(normalized) && (` ${normalized} `).includes(` ${normalizeFormQuestion(intended)} `);
  }
  const grounding = groundedLocationComponents(action);
  const parts = grounding.combined.split(',').map((part) => part.trim()).filter(Boolean);
  const tokens = parts.map(normalizeFormQuestion).filter(Boolean);
  if (tokens.length > 0 && tokens.every((token) => normalized.includes(token))) return true;
  return [grounding.city, grounding.country]
    .map(normalizeFormQuestion)
    .filter(Boolean)
    .some((grounded) => normalized === grounded);
}

function groundedAutocompleteMatches(label, action) {
  if (action.optionMatch) return listboxOptionMatches(label, action);
  if (action.category === 'current_location') return groundedLocationMatches(label, action);
  if (action.semantic === 'phone_country') {
    const country = cleanFormText(action.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${country}(?:\\s*\\(?\\+\\d{1,4}\\)?)?$`, 'i').test(cleanFormText(label));
  }
  return normalizeFormQuestion(label) === normalizeFormQuestion(action.value);
}

function autocompleteQueries(action) {
  if (action.category !== 'current_location') return [cleanFormText(action.value)].filter(Boolean);
  const grounding = groundedLocationComponents(action);
  return [...new Set([grounding.combined, grounding.city, grounding.country].map(cleanFormText).filter(Boolean))];
}

function isCommitted(field, action) {
  if (action.action === 'upload') {
    return (field.files || []).some((filename) => filename === action.artifact.intendedFilename);
  }
  if (action.action === 'check' || action.action === 'radio') return Boolean(field.checked);
  if (action.action === 'uncheck') return !field.checked;
  if (action.action === 'listbox') return listboxOptionMatches(field.value, action);
  if (action.action === 'date') return (action.dateSegments || []).every((segment) => (
    cleanFormText(action.workdayDateSegments?.find((current) => current.fieldId === segment.fieldId)?.value)
      === segment.value
  ));
  if (action.action === 'pick') return pickFieldCommitted(field, action);
  if (action.action === 'select') {
    const option = matchingOption(field, action.value);
    return Boolean(option && (
      cleanFormText(field.value) === option.value
      || normalizeFormQuestion(field.selectedLabel) === normalizeFormQuestion(option.label)
    ));
  }
  const normalizeValue = action.category === 'custom_motivation_experience_narrative'
    ? normalizeNarrativeText
    : cleanFormText;
  const current = normalizeValue(field.value);
  if (action.action === 'autocomplete' && (action.category === 'current_location' || action.category === 'education' || action.semantic === 'phone_country')) {
    return groundedAutocompleteMatches(current, action);
  }
  return current === normalizeValue(action.value);
}

function selectArtifact(artifacts, semantic) {
  if (semantic === 'cv_upload') return artifacts.cv || null;
  if (semantic === 'cover_letter_upload') return artifacts.coverLetter || null;
  if (semantic === 'single_document_upload') return artifacts.combinedDocument || null;
  return null;
}

// Workday can navigate (URL change, re-render of the document) while a step is being read; a read interrupted by
// that navigation is repeated on the new document instead of failing the pass.
export async function inspectOperationalApplicationForm(page) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await inspectOperationalApplicationFormOnce(page);
    } catch (error) {
      const navigated = /Execution context was destroyed|Cannot find context with specified id|navigation/i.test(String(error?.message));
      if (!navigated || attempt >= 4 || page.isClosed()) throw error;
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    }
  }
}

async function inspectOperationalApplicationFormOnce(page) {
  const snapshot = await inspectLegacyApplicationForm(page);
  const metadata = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const seen = new Set();
    return [...document.querySelectorAll('[data-career-ops-field-id]')].map((element) => {
      const fieldId = clean(element.getAttribute('data-career-ops-field-id'));
      if (!fieldId || seen.has(fieldId)) throw new Error(`Duplicate Career-Ops field identity detected: ${fieldId || '(empty)'}`);
      seen.add(fieldId);
      // Lever-style questions keep their text in a sibling block (<div class="application-label"><div class="text">)
      // instead of a <label>; checkbox/radio options there carry only the option text. Read the question from the
      // enclosing question block, but only when that block holds a single question (one field name).
      const questionHost = element.closest('.application-question, [class*="question" i]');
      const hostNames = questionHost
        ? new Set([...questionHost.querySelectorAll('input:not([type="hidden"]), textarea, select')]
          .map((control) => control.getAttribute('name') || control.id || control.getAttribute('data-career-ops-field-id')))
        : new Set();
      const hostQuestionNode = hostNames.size === 1
        ? [...questionHost.querySelectorAll('.application-label .text, .application-label, [class*="question-text" i], [class*="question-label" i], [class*="question-title" i]')]
          .find((node) => !node.contains(element) && !node.querySelector('input, textarea, select'))
        : null;
      const hostQuestion = clean(hostQuestionNode?.innerText).replace(/\s*[✱*]+\s*$/u, '');
      const fieldset = element.closest('fieldset');
      const groupLabel = clean(fieldset?.querySelector(':scope > legend')?.innerText)
        || clean(element.closest('[role="group"], [role="radiogroup"]')?.getAttribute('aria-label'))
        || (['radio', 'checkbox'].includes((element.type || '').toLowerCase()) ? hostQuestion : '');
      const ownLabel = element.labels ? clean([...element.labels].map((label) => label.innerText).join(' ')) : '';
      const formGroupLabel = clean(element.closest('.form-group')?.querySelector(':scope > label.control-label')?.innerText);
      let labelledGroup = null;
      for (let node = element.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
        if (node.matches('[role="group"], fieldset, [aria-labelledby]')) {
          labelledGroup = node;
          break;
        }
      }
      const referencedLabel = (node) => clean((node?.getAttribute('aria-labelledby') || '').split(/\s+/)
        .filter(Boolean).map((id) => document.getElementById(id)?.innerText || '').join(' '));
      const controlLabel = (control) => clean([
        ...(control.labels || []),
      ].map((label) => label.innerText).join(' ')
        || control.getAttribute('aria-label') || referencedLabel(control));
      const controlValue = (control) => clean(control?.value || control?.innerText
        || [...(control?.querySelectorAll?.('[data-automation-id="selectedItem"]') || [])].map((item) => item.innerText).join(' '));
      const repeatedPanel = element.closest('[role="group"][aria-labelledby$="-panel"]');
      const repeatedPanelHeading = referencedLabel(repeatedPanel);
      const educationPanel = (/^education\b/i.test(repeatedPanelHeading) ? repeatedPanel : null)
        || element.closest('[data-automation-id^="education-"]');
      const greenhouseEducationPanel = element.closest('.education--form');
      const greenhouseSchoolControls = greenhouseEducationPanel
        ? [...greenhouseEducationPanel.querySelectorAll('input, select, [role="combobox"]')]
          .filter((control) => /\b(?:school|university|institution)\b/i.test(controlLabel(control))) : [];
      const greenhouseSchool = greenhouseSchoolControls.length === 1 ? greenhouseSchoolControls[0] : null;
      const educationSchool = greenhouseSchool ? clean(
        greenhouseSchool.closest('.select__container')?.querySelector('.select__single-value')?.innerText
        || greenhouseSchool.selectedOptions?.[0]?.textContent || greenhouseSchool.value,
      ) : '';
      const repeatedLanguagePanel = repeatedPanel
        && (/^languages?\b/i.test(repeatedPanelHeading) || repeatedPanel.querySelector('[name="language"]'))
        ? repeatedPanel : null;
      const languageGroup = repeatedLanguagePanel || labelledGroup || element.closest('[data-automation-id*="language" i]')
        || (element.hasAttribute('aria-labelledby') ? element : null);
      const groupName = clean(referencedLabel(languageGroup)
        || languageGroup?.querySelector('legend, h1, h2, h3, h4, h5, h6')?.innerText
        || languageGroup?.getAttribute('aria-label')
        || (languageGroup === element ? element.getAttribute('aria-label') : ''));
      const controlsInGroup = languageGroup ? [...languageGroup.querySelectorAll('input, button, [role="combobox"]')] : [];
      const namedLanguage = controlsInGroup.find((control) => control.getAttribute('name') === 'language')
        || controlsInGroup.find((control) => /\blanguage\b/i.test(controlLabel(control)));
      const languageName = clean(namedLanguage?.innerText || namedLanguage?.textContent) || controlValue(namedLanguage) || groupName
        || (element.getAttribute('aria-label') || '');
      const schoolControl = educationPanel
        ? educationPanel.querySelector('[name="schoolName"]') || [...educationPanel.querySelectorAll('input, button, [role="combobox"]')]
          .find((control) => /school|university|institution/i.test(controlLabel(control)))
        : null;
      const dateWrapper = element.closest('[data-automation-id="dateInputWrapper"]');
      const dateQuestionGroup = dateWrapper?.closest('[role="group"][aria-labelledby]')
        || dateWrapper?.closest('[aria-labelledby]')
        || null;
      const dateQuestion = clean(referencedLabel(dateQuestionGroup)
        || dateQuestionGroup?.getAttribute('aria-label')
        || dateWrapper?.getAttribute('aria-label'));
      const dateSegment = (control) => {
        const text = [control.getAttribute('data-automation-id'), control.getAttribute('aria-label'),
          control.getAttribute('name'), control.id].filter(Boolean).join(' ');
        if (/month/i.test(text)) return 'month';
        if (/day/i.test(text)) return 'day';
        if (/year/i.test(text)) return 'year';
        return '';
      };
      const dateSegments = dateWrapper
        ? [...dateWrapper.querySelectorAll('input[role="spinbutton"], input[id*="dateSection"], input[name*="dateSection"]')]
          .map((control) => ({
            fieldId: clean(control.getAttribute('data-career-ops-field-id')),
            id: clean(control.id),
            name: clean(control.getAttribute('name')),
            segment: dateSegment(control),
            value: clean(control.value),
            required: Boolean(control.required || control.getAttribute('aria-required') === 'true'),
          })).filter((segment) => segment.fieldId && segment.segment)
        : [];
      const dateGroupId = dateWrapper
        ? clean(dateWrapper.id || dateSegments.map((segment) => segment.fieldId).join('|'))
        : '';
      const fieldLabel = [ownLabel, formGroupLabel, element.getAttribute('aria-label'), referencedLabel(element)]
        .filter(Boolean).join(' ');
      const workdayBlockKind = educationPanel ? 'education'
        : (repeatedLanguagePanel || (/\b(?:overall|reading|writing|speaking|listening|language)\b|\bi am fluent\b/i.test(fieldLabel)
          && (languageGroup || /language|proficiency|\bi am fluent\b/i.test(fieldLabel)))) ? 'language' : '';
      const workdaySchool = clean(controlValue(schoolControl));
      const directQuestion = clean(ownLabel || formGroupLabel || element.getAttribute('aria-label')
        || hostQuestion || element.placeholder || element.name || element.id);
      const normalizedText = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const contextualQuestion = workdayBlockKind === 'language' && languageName
        ? (normalizedText(directQuestion).includes(normalizedText(languageName))
          ? directQuestion : `${languageName} ${directQuestion}`)
        : workdayBlockKind === 'education' && workdaySchool && /degree|qualification/i.test(directQuestion)
          ? `${workdaySchool} ${directQuestion}` : '';
      const optionLabel = ['radio', 'checkbox'].includes((element.type || '').toLowerCase()) ? ownLabel : '';
      const selected = element.tagName === 'SELECT' ? element.selectedOptions?.[0]?.textContent : '';
      return {
        fieldId,
        groupLabel,
        questionText: dateQuestion || contextualQuestion || groupLabel || directQuestion,
        optionLabel,
        maxLength: Number(element.getAttribute('maxlength') || 0) || null,
        minLength: Number(element.getAttribute('minlength') || 0) || null,
        selectedLabel: clean(selected),
        ariaInvalid: element.getAttribute('aria-invalid') === 'true',
        workdayBlockKind,
        workdayBlockHeading: repeatedPanelHeading,
        workdayBlockId: repeatedPanel?.id || '',
        workdayBlockLabelledBy: repeatedPanel?.getAttribute('aria-labelledby') || '',
        workdaySchool,
        educationSchool,
        workdayLanguage: workdayBlockKind === 'language' ? clean(languageName) : '',
        workdayUploadSectionHeading: (element.type || '').toLowerCase() === 'file'
          ? clean(referencedLabel(element.closest('[role="group"][aria-labelledby]'))
            || element.closest('[role="group"][aria-labelledby]')?.querySelector('h4')?.innerText)
          : '',
        workdayDateGroupId: dateGroupId,
        workdayDateSegments: dateSegments,
        workdayDateGroupRequired: /\*/.test([dateQuestion, groupLabel, directQuestion].filter(Boolean).join(' '))
          || dateQuestionGroup?.getAttribute('aria-required') === 'true'
          || dateWrapper?.getAttribute('aria-required') === 'true'
          || dateSegments.some((segment) => segment.required),
        workdayDatePrimary: Boolean(dateGroupId && dateSegments.length
          && dateSegments.find((segment) => segment.segment === 'month')?.fieldId === fieldId),
      };
    });
  });
  const workdayEmptySections = await page.evaluate(() => {
    const sections = [
      ['Work Experience', 'Work-Experience-section'],
      ['Education', 'Education-section'],
      ['Languages', 'Languages-section'],
    ];
    return sections.flatMap(([label, id]) => {
      const section = document.querySelector(`[role="group"][aria-labelledby="${id}"]`);
      if (!section) return [];
      const entryCount = section.querySelectorAll('[role="group"][aria-labelledby$="-panel"]').length;
      return entryCount === 0 ? [{ label, entryCount }] : [];
    });
  }).catch(() => []);
  const byId = new Map(metadata.map((row) => [row.fieldId, row]));
  return {
    ...snapshot,
    workdayEmptySections,
    fields: snapshot.fields.map((field) => ({ ...field, ...(byId.get(field.fieldId) || {}) })),
  };
}

export function inspectOperationalUploadTopology(snapshot) {
  const hasVerifiedFormKey = Object.prototype.hasOwnProperty.call(snapshot || {}, 'applicationFormId');
  const applicationFormId = cleanFormText(snapshot?.applicationFormId);
  const fields = (snapshot.fields || [])
    .filter((field) => !field.disabled && field.type === 'file'
      && !(field.visible === false && !field.required && classifyFieldSemantics(field).semantic === 'unknown_upload')
      && (!hasVerifiedFormKey || (applicationFormId && field.formId === applicationFormId && field.applicationFormOwned !== false)))
    .map((field) => {
      const semantics = classifyFieldSemantics(field);
      return {
        fieldId: field.fieldId,
        formId: field.formId || '',
        applicationFormOwned: field.applicationFormOwned !== false,
        stableFieldId: stableFieldIdentity(field, semantics),
        label: fieldQuestion(field),
        category: semantics.category,
        semantic: semantics.semantic,
      };
    });
  const cv = fields.filter((row) => row.semantic === 'cv_upload');
  const cover = fields.filter((row) => row.semantic === 'cover_letter_upload');
  const combined = fields.filter((row) => row.semantic === 'single_document_upload');
  const unknown = fields.filter((row) => row.semantic === 'unknown_upload');
  let mode = 'none';
  let reason = 'No visible document upload fields.';
  if ((cv.length || cover.length) && !combined.length && !unknown.length) {
    // Each field names its document; a missing counterpart (e.g. a CV tile without a file input) is handled
    // by trigger uploads or an explicit manual-upload row, not by refusing the labelled field.
    mode = 'separate';
    reason = 'Separate, explicitly labelled CV and/or cover-letter upload fields are available.';
  } else if (fields.length === 1 && combined.length === 1) {
    mode = 'single_combined';
    reason = 'Exactly one field explicitly requests combined application documents.';
  } else if (fields.length) {
    mode = 'ambiguous';
    reason = 'Document upload purpose or topology is ambiguous; no combined upload is allowed.';
  }
  return { mode, reason, fields };
}

function manualField(field, semantics, reason, missingInformation = null, reasonCode = null) {
  return {
    fieldId: field.fieldId,
    stableFieldId: stableFieldIdentity(field, semantics),
    label: workdayEntryFieldLabel(field),
    category: semantics.category,
    semantic: semantics.semantic,
    reason,
    reasonCode,
    missingInformation,
    manualActionRequired: true,
  };
}

function selectionConflict(field, semantics, existingValue, groundedValue) {
  return {
    ...manualField(field, semantics,
      `Existing selection (${existingValue}) differs from the grounded value (${groundedValue}); review is required.`,
      { existingValue, groundedValue }),
    existingValue,
    groundedValue,
  };
}

function answerForField(field, semantics, profile, snapshot, artifacts, context, narrativeRouting = null) {
  if (field.educationContext && !field.workdayBlockKind && ['degree', 'field_of_study', 'education_date'].includes(semantics.semantic)) {
    return educationFieldAnswer(field, semantics, profile);
  }
  if (semantics.category === 'custom_motivation_experience_narrative') {
    if (semantics.semantic === 'cover_letter_text' && artifacts.coverLetterTextContent) {
      if (containsUnresolvedPlaceholder(artifacts.coverLetterTextContent)) {
        throw new Error('Bound cover letter contains an unresolved placeholder');
      }
      const provenance = artifacts.coverLetterTextProvenance;
      // The approved, claim-checked letter is bound by hash and pasted as-is; text without a provenance record is
      // used only when it is exactly that bound artifact. A provenance record, when present, is still validated.
      if (!provenance) {
        const bound = String(artifacts.coverLetterText?.sha256 || '').replace(/^sha256:/, '');
        if (!bound || createHash('sha256').update(artifacts.coverLetterTextContent, 'utf8').digest('hex') !== bound) {
          throw new Error('Bound cover letter text has no factual provenance');
        }
        return { value: artifacts.coverLetterTextContent, answerRecord: null };
      }
      validateNarrativeProvenanceRecord(profile, provenance, {
        candidateId: cleanFormText(context?.candidate?.candidate_id || context?.candidate?.candidateId),
        normalizedQuestion: provenance.normalizedQuestion,
        answer: artifacts.coverLetterTextContent,
      });
      return { value: artifacts.coverLetterTextContent, answerRecord: null };
    }
    const record = generateCustomNarrativeAnswer(profile, {
      question: fieldQuestion(field),
      candidate: context.candidate || {},
      jdText: context.jdText || '',
      maxLength: field.maxLength,
      routing: narrativeRouting,
    });
    return { value: record.answer, answerRecord: record };
  }
  return {
    value: canonicalFieldValue(profile, semantics, { field, snapshot, context }),
    answerRecord: null,
  };
}

function resolvedFieldSemantics(field, snapshot, context, semanticResolutions) {
  const deterministic = classifyFieldSemantics(field);
  const classification = resolutionForField(
    semanticResolutions, field, snapshot, context, 'semantic_classification',
  );
  if (classification) return {
    semantics: semanticFromAnnotation(classification.annotation),
    semanticResolution: classification,
    narrativeRouting: null,
  };
  const narrative = resolutionForField(
    semanticResolutions, field, snapshot, context, 'narrative_routing',
  );
  if (narrative) return {
    semantics: { category: 'custom_motivation_experience_narrative', semantic: 'custom_narrative' },
    semanticResolution: narrative,
    narrativeRouting: narrative.annotation,
  };
  return { semantics: deterministic, semanticResolution: null, narrativeRouting: null };
}

export function buildOperationalFormPlan(snapshot, profile, artifacts = {}, {
  context = {},
  previousEvidence = null,
  semanticResolutions = previousEvidence?.reasoning?.semanticResolutions || [],
  // stableFieldIds RoleForge committed on the current step in this pass (cleared at every step change).
  userCorrectionGuard = null,
} = {}) {
  const actions = [];
  const preservedFields = [];
  const preservedUploads = [];
  const unresolvedFields = [];
  const answerRecords = [];
  const reasoningCandidates = [];
  const priorAnswers = Array.isArray(previousEvidence?.answerRecords) ? previousEvidence.answerRecords : [];
  const effectiveProfile = { ...profile, priorApprovedAnswers: priorAnswers };
  const hasVerifiedFormKey = Object.prototype.hasOwnProperty.call(snapshot || {}, 'applicationFormId');
  const applicationFormId = cleanFormText(snapshot?.applicationFormId);
  const applicationFields = (snapshot.fields || []).filter((field) => !hasVerifiedFormKey
    || (applicationFormId && field.formId === applicationFormId && field.applicationFormOwned !== false));
  const cvSectionHasText = {
    'Work Experience': Boolean(cleanFormText(markdownSection(profile?.cvText, 'Experience'))),
    Education: Boolean(cleanFormText(markdownSection(profile?.cvText, 'Education'))),
    Languages: Boolean(cleanFormText(markdownSection(profile?.cvText, 'Languages'))),
  };
  const cvSectionHasUsableEntry = {
    'Work Experience': cvExperienceEntries(profile).entries.length > 0,
    Education: cvEducationEntries(profile).length > 0,
    Languages: cvLanguageLevels(profile).length > 0,
  };
  for (const section of snapshot.workdayEmptySections || []) {
    if (!cvSectionHasText[section.label] || cvSectionHasUsableEntry[section.label]) continue;
    const label = `${section.label} has no entries (Workday did not parse the CV); add them or press Enter to continue`;
    unresolvedFields.push({
      fieldId: `workday-empty-${section.label.toLowerCase().replace(/\s+/g, '-')}`,
      stableFieldId: `workday-empty-entry:${section.label.toLowerCase().replace(/\s+/g, '-')}`,
      label,
      category: 'workday_entry_section',
      semantic: 'empty_cv_entry_section',
      reason: label,
      missingInformation: null,
      manualActionRequired: true,
    });
  }
  const visibleFields = applicationFields.filter((field) => {
    if (field.disabled) return false;
    const semantics = classifyFieldSemantics(field);
    return field.visible !== false
      || semantics.category === 'file_upload'
      || (field.required && semantics.category === 'current_location');
  });

  if (hasVerifiedFormKey) {
    if (!applicationFormId) {
      unresolvedFields.push({
        fieldId: 'application-form-unverified',
        stableFieldId: 'application-form-unverified',
        label: 'Application form',
        category: 'workflow_identity',
        semantic: 'application_form',
        reason: 'No uniquely verified application form is available; no fields were filled.',
        missingInformation: null,
        manualActionRequired: true,
      });
    }
    const unownedApplicationFields = (snapshot.fields || []).filter((field) => {
      if (field.disabled || field.visible === false || field.formId) return false;
      const semantics = classifyFieldSemantics(field);
      return semantics.category !== 'unknown';
    });
    for (const field of unownedApplicationFields) {
      const semantics = classifyFieldSemantics(field);
      unresolvedFields.push(manualField(
        field,
        semantics,
        applicationFormId
          ? 'Application-like field is outside the uniquely verified application form; it was not filled.'
          : 'No uniquely verified application form owns this field; it was not filled.',
      ));
    }
  }

  for (const field of visibleFields) {
    const humanField = classifyHumanOnlyField(field);
    if (humanField) {
      unresolvedFields.push(manualField(field, { category: 'human_action', semantic: humanField }, 'Credential or challenge field requires the human.'));
      continue;
    }
    const { semantics, semanticResolution, narrativeRouting } = resolvedFieldSemantics(
      field, snapshot, context, semanticResolutions,
    );
    const stableFieldId = stableFieldIdentity(field, semantics);
    const base = {
      fieldId: field.fieldId,
      formId: field.formId || '',
      stableFieldId,
      id: field.id,
      tag: field.tag,
      label: workdayEntryFieldLabel(field),
      name: field.name,
      category: semantics.category,
      semantic: semantics.semantic,
      locatorSemantic: classifyFieldSemantics(field).semantic,
      workdayBlockId: field.workdayBlockId || '',
      workdayBlockLabelledBy: field.workdayBlockLabelledBy || '',
      resolutionKey: fieldResolutionKey(field, snapshot.applicationFormId),
      semanticResolutionKind: semanticResolution?.kind || null,
      narrativeRouting,
    };

    // Workday's CV autofill can populate repeated experience and education entries. Keep their existing text,
    // including role descriptions, instead of replacing it with a canonical or generated answer.
    if ((field.workdayBlockKind === 'education' || field.workdayBlockLabelledBy)
        && ['text', 'textarea'].includes(field.type) && !field.widget && cleanFormText(field.value)) {
      preservedFields.push({ ...base, valueHash: hashFormValue(field.value), preserved: true });
      continue;
    }
    // Inside a repeated entry (Work Experience 1, Education 2, ...) a field describes that entry, not the candidate:
    // the employer's Location is not the candidate's city. Only the per-entry answers handled below (degree,
    // language proficiency, "I am fluent") are filled; anything else is the user's.
    const handledEntryField = (field.workdayBlockKind === 'education'
      && ((field.widget === 'workday-listbox' && semantics.semantic === 'degree')
        || (field.widget === 'selectinput' && semantics.semantic === 'field_of_study')))
      || (field.workdayBlockKind === 'language' && ['language_proficiency', 'language_fluent'].includes(semantics.semantic));
    if (/-panel$/i.test(field.workdayBlockLabelledBy || '') && !handledEntryField) {
      if (field.required && !fieldAnswered(field)) {
        unresolvedFields.push(manualField(field, semantics, 'Entry-specific field in a repeated Workday entry; fill it from that entry.'));
      }
      continue;
    }

    if (semantics.category === 'preferred_location') {
      unresolvedFields.push(manualField(field, semantics, 'Preferred location is application-specific and has no exact approved value.'));
      continue;
    }
    if (semantics.category === 'optional_marketing_consent') {
      if (field.required) unresolvedFields.push(manualField(field, semantics, 'Required promotional consent needs user review; Career-Ops will not opt in automatically.'));
      continue;
    }
    if (semantics.category === 'legal_declaration') {
      if ((field.type === 'checkbox' && !field.checked) || (field.required && !fieldAnswered(field))) {
        unresolvedFields.push(manualField(field, semantics, 'Legally meaningful declaration requires user review.'));
      }
      continue;
    }
    if (semantics.category === 'demographic_eeo') {
      if (!field.required) continue;
      const decline = preferredDeclineOption(field.options);
      if (!decline) {
        unresolvedFields.push(manualField(field, semantics, 'Required EEO field has no visible Prefer not to say option.'));
        continue;
      }
      const action = controlAction(field, decline);
      if (!action) continue;
      actions.push({ ...base, action, value: decline, valueHash: hashFormValue(decline), retryBudget: 1 });
      continue;
    }
    if (semantics.category === 'privacy_data_processing_consent') {
      if (!field.required) continue;
      if (field.type === 'text' || field.type === 'textarea' || field.tag === 'textarea') {
        unresolvedFields.push(manualField(field, semantics, 'Privacy/Data Notice field asks for text instead of a standard acknowledgement.'));
        continue;
      }
      const intended = field.type === 'checkbox'
        ? 'Yes'
        : matchingOption(field, 'I agree')?.label
          || matchingOption(field, 'Accept')?.label
          || matchingOption(field, 'Yes')?.label;
      if (!intended) {
        unresolvedFields.push(manualField(field, semantics, 'Required privacy acknowledgement has no grounded acceptance control.'));
        continue;
      }
      const action = controlAction(field, intended);
      if (!action) continue;
      const planned = { ...base, action, value: intended, valueHash: hashFormValue(intended), retryBudget: 1 };
      if (isCommitted(field, planned)) preservedFields.push({ ...base, valueHash: planned.valueHash, preserved: true });
      else actions.push(planned);
      continue;
    }
    if (semantics.category === 'file_upload') {
      if (field.visible === false && semantics.semantic === 'unknown_upload' && !field.required) continue;
      const artifact = selectArtifact(artifacts, semantics.semantic);
      if (!artifact) {
        if (field.required || semantics.semantic === 'unknown_upload') {
          unresolvedFields.push(manualField(field, semantics, 'Required exact bound artifact is unavailable or upload purpose is ambiguous.'));
        }
        continue;
      }
      const planned = { ...base, action: 'upload', artifact, retryBudget: 1 };
      // Files the ATS already lists for this control: the same bound file counts as attached; a different one is
      // never replaced without the user's review.
      // A name listed in an area shared by several inputs that is exactly this control's bound file is RoleForge's own
      // earlier upload; any other shared-area name stays ambiguous and withholds the upload.
      const shown = (field.attachedNames || [])
        .map((name) => (name === `(ambiguous attachment) ${artifact.intendedFilename}` ? artifact.intendedFilename : name));
      const held = field.files || [];
      // setInputFiles replaces the input's FileList, so any different file held by the input blocks the upload.
      // Only an empty multiple-file input next to a server-side list (Workday) adds without replacing.
      const differentHeld = held.length > 0 && !held.includes(artifact.intendedFilename);
      const differentShown = shown.length > 0 && !shown.includes(artifact.intendedFilename)
        && !(field.multiple && held.length === 0);
      if (differentHeld || differentShown) {
        unresolvedFields.push({
          ...manualField(field, semantics, `A different file is already attached here (${[...new Set([...held, ...shown])].join(', ')}); RoleForge did not replace it. Review it; the bound file is ${artifact.resolvedPath}`),
          manualUploadPath: artifact.resolvedPath,
        });
        continue;
      }
      if (isCommitted(field, planned) || shown.includes(artifact.intendedFilename)) {
        preservedFields.push({ ...base, valueHash: artifact.sha256, preserved: true });
        preservedUploads.push({
          semantic: semantics.semantic,
          filename: artifact.intendedFilename,
          sha256: artifact.sha256,
          preserved: true,
        });
      } else {
        actions.push(planned);
      }
      continue;
    }
    if (semantics.semantic === 'german_university_enrollment') {
      unresolvedFields.push(manualField(
        field,
        semantics,
        'German-university enrollment requires an explicit grounded Yes or No answer; an institution name is not a valid substitute.',
      ));
      continue;
    }
    if (semantics.category === 'unknown') {
      // Already answered (by the user at a manual-fields pause, or prefilled by the ATS): theirs to review.
      if (field.required && !fieldAnswered(field)) {
        const narrativeShape = field.tag === 'textarea' || field.type === 'textarea'
          || (field.type === 'text' && Number(field.maxLength || 0) >= 120);
        const conservativeManualControl = field.type === 'checkbox';
        const kind = narrativeShape ? 'narrative_routing' : 'semantic_classification';
        unresolvedFields.push(manualField(
          field,
          semantics,
          'Field meaning is genuinely uncertain.',
          null,
          conservativeManualControl ? 'unknown_consent_or_declaration'
            : narrativeShape ? 'unknown_narrative_intent' : 'unknown_field_semantics',
        ));
        if (!conservativeManualControl) {
          reasoningCandidates.push(buildReasoningCandidate(field, snapshot, context, {
            kind,
            reasonCode: narrativeShape ? 'unknown_narrative_intent' : 'unknown_field_semantics',
            profile,
          }));
        }
      }
      continue;
    }

    if (semantics.semantic === 'workday_skills') {
      const selectedItems = Array.isArray(field.selectedItems) ? field.selectedItems.map(cleanFormText).filter(Boolean) : [];
      for (const skill of cvTechnicalSkills(profile)) {
        if (selectedItems.some((existing) => normalizeFormQuestion(existing) === normalizeFormQuestion(skill))) continue;
        actions.push({
          ...base,
          action: 'pick',
          pickKind: 'skill',
          optionValues: [skill],
          value: skill,
          valueHash: hashFormValue(skill),
          retryBudget: 1,
        });
      }
      continue;
    }

    let resolved;
    try {
      resolved = answerForField(field, semantics, effectiveProfile, snapshot, artifacts, context, narrativeRouting);
    } catch (error) {
      unresolvedFields.push(manualField(
        field,
        semantics,
        cleanFormText(error.message),
        cleanFormText(error.message).startsWith('Missing evidence') ? cleanFormText(error.message) : null,
      ));
      continue;
    }
    if (field.widget === 'selectinput' && semantics.semantic === 'field_of_study'
        && field.workdayBlockKind === 'education') {
      const school = cleanSchoolName(field.workdaySchool);
      const matchingEntries = cvEducationEntries(profile).filter((entry) => educationSchoolMatches(entry.school, school));
      if (matchingEntries.length !== 1 || !matchingEntries[0].subject) {
        if (field.required) unresolvedFields.push(manualField(field, semantics,
          'The CV does not provide one exact subject for this education entry.'));
        continue;
      }
      const subject = matchingEntries[0].subject;
      const planned = {
        ...base,
        action: 'pick',
        pickKind: 'field_of_study',
        optionValues: [subject],
        value: subject,
        valueHash: hashFormValue(subject),
        retryBudget: 1,
      };
      if (isCommitted(field, planned)) preservedFields.push({ ...base, valueHash: planned.valueHash, preserved: true });
      else if (fieldAnswered(field)) unresolvedFields.push(selectionConflict(field, semantics, field.value, subject));
      else actions.push(planned);
      continue;
    }
    if (field.widget === 'selectinput') {
      const value = cleanFormText(resolved.value);
      const selectedItems = Array.isArray(field.selectedItems)
        ? field.selectedItems.map(cleanFormText).filter(Boolean)
        : cleanFormText(field.value).split(/\s*,\s*/).filter(Boolean);
      if (!['phone_country', 'phone_dial_code'].includes(semantics.semantic)
          && semantics.semantic !== 'application_source') {
        if (field.required && !selectedItems.length) {
          unresolvedFields.push(manualField(field, semantics, 'Workday pick-from-list field has no grounded answer.'));
        }
        continue;
      }
      // A selected chip without discovery provenance is an existing user/ATS answer and stays in place.
      if (selectedItems.length && !value) continue;
      if (!value) {
        if (field.required) unresolvedFields.push(manualField(
          field,
          semantics,
          'No grounded value is available for this Workday pick-from-list field.',
          semantics.category === 'source_how_heard' ? 'Where this job was found is not recorded in its discovery provenance.' : null,
        ));
        continue;
      }
      const pickKind = semantics.category === 'source_how_heard' ? 'application_source' : 'phone_country';
      const planned = {
        ...base,
        action: 'pick',
        pickKind,
        optionValues: pickKind === 'application_source' ? applicationSourceOptionValues(value, context) : [value],
        value,
        valueHash: hashFormValue(value),
        retryBudget: 1,
      };
      if (selectedItems.length) {
        if (isCommitted(field, planned)) preservedFields.push({ ...base, valueHash: planned.valueHash, preserved: true });
        else unresolvedFields.push(selectionConflict(field, semantics, selectedItems.join(', '), value));
      } else actions.push(planned);
      continue;
    }
    if (field.widget === 'workday-listbox' && semantics.semantic === 'degree'
        && field.workdayBlockKind === 'education') {
      const school = cleanSchoolName(field.workdaySchool);
      const matchingEntries = cvEducationEntries(profile).filter((entry) => (
        educationSchoolMatches(entry.school, school)
        && /\b(?:master|bachelor)\b/i.test(entry.degree)
      ));
      const targets = matchingEntries.map((entry) => /\bmaster\b/i.test(entry.degree) ? 'Master' : 'Bachelor');
      if (targets.length !== 1) {
        if (field.required) unresolvedFields.push(manualField(
          field, semantics, 'The education block does not match exactly one CV degree entry.',
        ));
        continue;
      }
      const planned = {
        ...base,
        action: 'listbox',
        value: targets[0],
        optionMatch: { mode: 'degree', level: targets[0], qualification: matchingEntries[0].degree },
        valueHash: hashFormValue(targets[0]),
        retryBudget: 1,
      };
      if (isCommitted(field, planned)) preservedFields.push({ ...base, valueHash: planned.valueHash, preserved: true });
      else if (fieldAnswered(field)) unresolvedFields.push(selectionConflict(field, semantics, field.value, matchingEntries[0].degree));
      else actions.push(planned);
      continue;
    }
    if (field.widget === 'workday-listbox' && semantics.semantic === 'language_proficiency'
        && field.workdayBlockKind === 'language') {
      const level = languageLevelForField(field, profile);
      const valuesByLevel = {
        Native: ['Native', 'Native speaker', 'Mother tongue', 'Native or bilingual', 'Native or bilingual proficiency'],
        Fluent: ['Fluent', 'Advanced', 'Proficient'],
        Beginner: ['Beginner', 'Basic', 'Elementary', 'Novice', 'Elementary proficiency'],
      };
      if (!level || !valuesByLevel[level]) {
        unresolvedFields.push(manualField(field, semantics, 'Language proficiency is not an approved exact CV level.'));
        continue;
      }
      const planned = {
        ...base,
        action: 'listbox',
        value: level,
        optionMatch: { mode: 'proficiency', values: valuesByLevel[level] },
        valueHash: hashFormValue(level),
        retryBudget: 1,
      };
      if (isCommitted(field, planned)) preservedFields.push({ ...base, valueHash: planned.valueHash, preserved: true });
      else if (fieldAnswered(field)) unresolvedFields.push(selectionConflict(field, semantics, field.value, level));
      else actions.push(planned);
      continue;
    }
    if (semantics.semantic === 'language_fluent' && field.workdayBlockKind === 'language') {
      const level = languageLevelForField(field, profile);
      if (level === 'Native' || level === 'Fluent') {
        const planned = { ...base, action: 'check', value: 'Yes', valueHash: hashFormValue('Yes'), retryBudget: 1 };
        if (isCommitted(field, planned)) preservedFields.push({ ...base, valueHash: planned.valueHash, preserved: true });
        else actions.push(planned);
      } else if (level === 'Beginner') {
        const planned = { ...base, action: 'uncheck', value: 'No', valueHash: hashFormValue('No'), retryBudget: 1 };
        if (isCommitted(field, planned)) preservedFields.push({ ...base, valueHash: planned.valueHash, preserved: true });
        else unresolvedFields.push(selectionConflict(field, semantics, 'Fluent', level));
      } else {
        unresolvedFields.push(manualField(field, semantics, 'The fluent checkbox language level is not an approved exact CV level.'));
      }
      continue;
    }

    if (semantics.semantic === 'graduation' && field.workdayDateGroupId) {
      if (!field.workdayDatePrimary) continue;
      const segments = field.workdayDateSegments || [];
      if (segments.some((segment) => cleanFormText(segment.value))) {
        preservedFields.push({ ...base, valueHash: hashFormValue(segments.map((segment) => segment.value).join('|')), preserved: true });
        continue;
      }
      let dateAnswer;
      try {
        dateAnswer = answerForField(field, semantics, effectiveProfile, snapshot, artifacts, context, narrativeRouting);
      } catch {
        dateAnswer = null;
      }
      const grounded = groundedDateSegments(dateAnswer?.value);
      const requiredSegments = segments.filter((segment) => field.workdayDateGroupRequired || segment.required);
      const targetSegments = segments.map((segment) => ({
        fieldId: segment.fieldId,
        id: segment.id,
        name: segment.name,
        segment: segment.segment,
        value: grounded?.[segment.segment] || '',
      }));
      if (!grounded || !requiredSegments.length
          || requiredSegments.some((segment) => !grounded[segment.segment])) {
        if (field.required || field.workdayDateGroupRequired || requiredSegments.length) {
          unresolvedFields.push(manualField(field, semantics,
            'The grounded graduation date does not contain every required date segment.'));
        }
        continue;
      }
      const planned = {
        ...base,
        action: 'date',
        value: dateAnswer.value,
        dateSegments: targetSegments.filter((segment) => segment.value),
        workdayDateSegments: segments,
        valueHash: hashFormValue(dateAnswer.value),
        retryBudget: 1,
      };
      if (isCommitted(field, planned)) preservedFields.push({ ...base, valueHash: planned.valueHash, preserved: true });
      else actions.push(planned);
      continue;
    }

    if (semantics.semantic === 'graduation' && field.role === 'spinbutton') {
      if (field.required) unresolvedFields.push(manualField(field, semantics,
        'A Workday date segment was not grouped with its complete date field.'));
      continue;
    }
    const normalizeValue = semantics.category === 'custom_motivation_experience_narrative'
      ? normalizeNarrativeText
      : cleanFormText;
    let value = normalizeValue(resolved.value);
    // A value already in the field (entered by the user at a manual-fields pause, or prefilled by the ATS from their
    // account) is theirs to review; it is not an unresolved field.
    if (!value && fieldAnswered(field)) continue;
    if (!value) {
      const traineeSalary = semantics.semantic === 'salary' && isTraineeRole(context);
      if (field.required || traineeSalary || ['work_authorization', 'sponsorship_employer_support'].includes(semantics.category)) {
        const missing = {
          work_authorization: 'Verified job country or hiring arrangement is missing or ambiguous.',
          sponsorship_employer_support: 'Verified job country or hiring arrangement is missing or ambiguous.',
          source_how_heard: 'Where this job was found is not recorded in its discovery provenance.',
          skill_experience: 'Not every skill named in the question is listed in the CV skills section.',
          adult_confirmation: 'application_form.adult_confirmed is not set to Yes in config/profile.yml.',
          employment: 'application_form.current_employment is not set in config/profile.yml.',
        }[semantics.category] || (traineeSalary
          ? 'Trainee/internship role: the general salary target is not used; enter a role-appropriate expectation.'
          : 'Canonical profile evidence is missing.');
        unresolvedFields.push(manualField(field, semantics, 'No grounded canonical answer is available.', missing));
      }
      continue;
    }
    if (resolved.answerRecord && answerRecords.some((record) => record.answerHash === resolved.answerRecord.answerHash
        && record.normalizedQuestion !== resolved.answerRecord.normalizedQuestion)) {
      unresolvedFields.push(manualField(field, semantics, 'Generated narrative duplicates a different question; a question-specific answer needs manual review.'));
      continue;
    }
    try {
      value = validatePlannedValueForControl(field, semantics, value);
    } catch (error) {
      unresolvedFields.push(manualField(field, semantics, cleanFormText(error.message)));
      continue;
    }
    if (['work_authorization', 'sponsorship'].includes(semantics.semantic) && !['Yes', 'No'].includes(value)) {
      unresolvedFields.push(manualField(field, semantics, 'Authorization and sponsorship controls require an exact Yes or No answer.'));
      continue;
    }
    const optionResolution = resolutionForField(
      semanticResolutions, field, snapshot, context, 'option_mapping',
    );
    if (optionResolution) {
      if (optionResolution.annotation.canonicalValueHash !== hashFormValue(value)) {
        unresolvedFields.push(manualField(
          field,
          semantics,
          'A semantic option mapping no longer matches the grounded canonical answer.',
          null,
          'stale_option_mapping',
        ));
        continue;
      }
      if (optionResolution.annotation.noSemanticMatch === true) {
        unresolvedFields.push(manualField(
          field,
          semantics,
          'No supplied visible option is semantically equivalent to the grounded canonical answer.',
          null,
          'reasoning_option_no_semantic_match',
        ));
        continue;
      }
      value = optionResolution.annotation.selectedVisibleOption;
    } else if (field.tag === 'select' && !matchingOption(field, value)) {
      unresolvedFields.push(manualField(
        field,
        semantics,
        'No exact visible option matches the grounded canonical answer.',
        null,
        'grounded_value_option_mismatch',
      ));
      if (REASONABLE_OPTION_MAPPING_CATEGORIES.has(semantics.category)) {
        reasoningCandidates.push(buildReasoningCandidate(field, snapshot, context, {
          kind: 'option_mapping',
          reasonCode: 'grounded_value_option_mismatch',
          canonicalValue: value,
          profile,
        }));
      }
      continue;
    }
    const checkboxGroup = field.type === 'checkbox' && field.name
      ? applicationFields.filter((item) => item.type === 'checkbox' && item.name === field.name)
      : [];
    let action;
    if (checkboxGroup.length > 1) {
      const chosen = chooseCheckboxGroupOption(checkboxGroup, value, {
        candidateCountry: profile?.location?.country, jobCountry: context?.jobCountry,
      });
      if (!chosen) {
        if (field.required && checkboxGroup[0] === field) {
          unresolvedFields.push(manualField(field, semantics, `No single option matches the answer "${cleanFormText(value)}".`));
        }
        continue;
      }
      if (chosen !== field) continue;
      action = 'check';
    } else {
      action = controlAction(field, value);
    }
    if (!action) continue;
    const planned = {
      ...base,
      action,
      value,
      valueHash: hashFormValue(value),
      retryBudget: 1,
      sourceRef: resolved.answerRecord ? 'candidate-specific-grounded-narrative'
        : resolved.sourceRef ? resolved.sourceRef
        : semantics.category === 'skill_experience' ? 'cv.md'
          : semantics.category === 'source_how_heard' ? 'job-discovery-provenance' : 'config/profile.yml',
    };
    if (resolved.optionMatch) planned.optionMatch = resolved.optionMatch;
    if (action === 'autocomplete' && semantics.category === 'current_location') {
      planned.locationGrounding = {
        city: cleanFormText(canonicalFieldValue(
          profile, { category: 'current_location', semantic: 'city' }, { field, snapshot, context },
        )),
        country: cleanFormText(canonicalFieldValue(
          profile, { category: 'current_location', semantic: 'country' }, { field, snapshot, context },
        )),
        combined: value,
      };
    }
    if (isCommitted(field, planned)) {
      preservedFields.push({ ...base, valueHash: planned.valueHash, preserved: true });
    } else if (field.widget === 'workday-listbox' && fieldAnswered(field)) {
      unresolvedFields.push(selectionConflict(field, semantics, field.value, value));
    } else {
      actions.push(planned);
    }
    if (resolved.answerRecord) answerRecords.push(resolved.answerRecord);
  }

  const applicationControls = (snapshot.controls || []).filter((control) => (
    snapshot.applicationFormId && control.formId === snapshot.applicationFormId
  ));
  const finalActions = applicationControls.filter(isSemanticFinalAction).map((control) => ({
    label: control.label || control.text || control.value || '(unlabelled submit control)',
    semanticClass: control.type === 'submit' ? 'form_submit' : 'terminal_action',
  }));
  const progressionActions = applicationControls.filter((control) => classifyApplicationControl(control) === 'progression');
  const ambiguousActions = applicationControls.filter((control) => (
    classifyApplicationControl(control) === 'ambiguous'
    // A plain backward step (Workday's footer "Back" is type=submit) is never clicked and does not block progress.
    && !/^(?:back|previous|zurück|takaisin|edellinen|tillbaka|vorige|précédent)$/i.test(cleanFormText(control.label || control.text || control.value))
    && (control.type === 'submit' || control.formAction || control.invokesSubmit
      || PROGRESSION_ACTION_LABEL.test(cleanFormText(control.label || control.text || control.value))
      || /\b(?:next|continue|proceed|review|apply|submit|send|complete|finish|finali[sz]e|confirm)\b/i.test(
        cleanFormText(control.label || control.text || control.value),
      ))
  ));
  // A document withheld at one control (a different file is already attached) is not uploaded anywhere on the page.
  const withheldUploads = new Set(unresolvedFields
    .filter((row) => row.manualUploadPath && /different file is already attached/i.test(row.reason))
    .map((row) => row.manualUploadPath));
  if (withheldUploads.size) {
    for (let index = actions.length - 1; index >= 0; index -= 1) {
      if (actions[index].action === 'upload' && withheldUploads.has(actions[index].artifact.resolvedPath)) actions.splice(index, 1);
    }
  }
  // A field RoleForge already committed on this step that now differs (unchecked, cleared, changed) was corrected by
  // the user at a manual pause: keep the user's state, never redo the action. (A page reload after a restart is not a
  // correction: the guard only covers the current step of the current pass.)
  const committedEarlier = userCorrectionGuard || new Set();
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    if (action.action !== 'upload' && committedEarlier.has(action.stableFieldId)) {
      preservedFields.push({ fieldId: action.fieldId, stableFieldId: action.stableFieldId, label: action.label,
        category: action.category, semantic: action.semantic, preserved: true, userCorrected: true });
      actions.splice(index, 1);
    }
  }
  const uploadTopology = inspectOperationalUploadTopology(snapshot);
  if (uploadTopology.mode === 'ambiguous') {
    for (const row of uploadTopology.fields) {
      if (!unresolvedFields.some((field) => field.stableFieldId === row.stableFieldId)) {
        unresolvedFields.push({ ...row, reason: uploadTopology.reason, manualActionRequired: true });
      }
    }
  }
  return {
    actions,
    plannedFieldIds: applicationFields.map((field) => field.fieldId),
    preservedFields,
    preservedUploads,
    unresolvedFields: dedupeRows(unresolvedFields),
    answerRecords,
    reasoningCandidates,
    finalActions,
    progressionActions,
    ambiguousActions,
    uploadTopology,
    snapshotHash: digest(snapshot),
  };
}

const operationalGuardContexts = new WeakSet();

function installOperationalGuardInDocument({ finalTokenSource, finalTokenFlags, progressionLabelSource, progressionLabelFlags }) {
    if (!String(globalThis.name || '').split('|').includes('career-ops-guard-active')) return;
    if (globalThis.__careerOpsOperationalGuard?.document === document) return;
    if (globalThis.__careerOpsOperationalGuard) delete globalThis.__careerOpsOperationalGuard;
    globalThis.__careerOpsSubmitAttempts = Number(globalThis.__careerOpsSubmitAttempts || 0);
    globalThis.__careerOpsProgressionSubmits = Number(globalThis.__careerOpsProgressionSubmits || 0);
    const finalToken = new RegExp(finalTokenSource, finalTokenFlags);
    const progressionLabel = new RegExp(progressionLabelSource, progressionLabelFlags);
    const controlLabels = (control) => {
      const labelled = (control.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent || '').join(' ');
      return [control.getAttribute('aria-label'), labelled, control.innerText, control.value,
        ...[...(control.labels || [])].map((label) => label.innerText)]
        .map((value) => String(value || '').replace(/\s+/g, ' ').trim());
    };
    const isIntermediateControl = (control, form) => {
      const label = String(control.getAttribute('aria-label') || control.innerText || control.value || '').replace(/\s+/g, ' ').trim().replace(/\s*&\s*/g, ' & ');
      if (!progressionLabel.test(label) || finalToken.test(controlLabels(control).join(' '))) return false;
      const root = form.closest('[data-career-ops-workflow-id]') || form;
      let candidates = [...root.querySelectorAll('[data-career-ops-step], [aria-current="step"], [role="progressbar"], .step, .steps, .progress, [data-automation-id="progressBarActiveStep"], [data-automation-id="progressBarActiveStep"] *')];
      if (root !== form) candidates.push(...[...root.querySelectorAll('*')].filter((element) => !form.contains(element)));
      // A virtual form progresses only on a verified application step (Workday progress bar or explicit hook).
      if (form.hasAttribute('data-career-ops-virtual-form')) {
        candidates = candidates.filter((element) => element.hasAttribute('data-career-ops-step')
          || Boolean(element.closest('[data-automation-id="progressBarActiveStep"]')?.closest('[data-automation-id="progressBar"]')));
      }
      for (const element of candidates) {
        if (element.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        // Workday's screen-reader-only step label counts when its active step in the progress bar is visible.
        const activeStep = element.closest('[data-automation-id="progressBarActiveStep"]');
        const activeRect = activeStep?.getBoundingClientRect();
        const workdayStepLabel = Boolean(activeStep?.closest('[data-automation-id="progressBar"]') && activeRect
          && activeRect.width > 0 && activeRect.height > 0 && getComputedStyle(activeStep).display !== 'none'
          && getComputedStyle(activeStep).visibility !== 'hidden');
        if (!workdayStepLabel && (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || 1) <= 0 || rect.width <= 0 || rect.height <= 0)) continue;
        const ownText = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
        const text = ownText || element.getAttribute('aria-label') || '';
        let current = Number(element.getAttribute('data-career-ops-step') || 0);
        let total = Number(element.getAttribute('data-career-ops-total-steps') || 0);
        if (!Number.isInteger(current) || current <= 0 || !Number.isInteger(total) || total <= 0) {
          const match = text.match(/\b(?:step|page)\s*(\d+)\s+(?:of|\/)\s+(\d+)(?!\d)/i);
          if (!match) continue;
          current = Number(match[1]);
          total = Number(match[2]);
        }
        return current > 0 && current < total;
      }
      return false;
    };
    const permittedControl = (submitter, form) => {
      const permit = globalThis.__careerOpsProgressionPermit;
      const liveSignature = submitter && form ? {
        controlId: String(submitter.getAttribute('data-career-ops-control-id') || '').trim(),
        formId: String(form.getAttribute('data-career-ops-form-id') || '').trim(),
        label: String(submitter.getAttribute('aria-label') || submitter.innerText || submitter.value || '').replace(/\s+/g, ' ').trim().replace(/\s*&\s*/g, ' & '),
        type: String(submitter.type || '').trim().toLowerCase(),
        formAction: String(submitter.getAttribute('formaction') || form.getAttribute('action') || '').trim(),
        formMethod: String(submitter.getAttribute('formmethod') || form.getAttribute('method') || 'get').trim().toLowerCase(),
      } : null;
      const signatureMatches = liveSignature && permit?.expected
        && Object.keys(permit.expected).every((key) => liveSignature[key] === permit.expected[key]);
      return Boolean(
        permit
        && permit.classification === 'progression'
        && permit.consumed !== true
        && Date.now() <= permit.expiresAt
        && permit.applicationIdentity === globalThis.__careerOpsApplicationIdentity
        && permit.stateFingerprint === globalThis.__careerOpsCurrentStateFingerprint
        && submitter
        && submitter === permit.controlElement
        && form
        && form === permit.formElement
        && signatureMatches
        && isIntermediateControl(submitter, form)
      );
    };
    const block = (event) => {
      const permit = globalThis.__careerOpsProgressionPermit;
      const permitted = event?.type === 'submit' && permittedControl(event.submitter, event.target);
      if (permitted) {
        permit.consumed = true;
        delete globalThis.__careerOpsProgressionPermit;
        globalThis.__careerOpsProgressionSubmits += 1;
        return;
      }
      delete globalThis.__careerOpsProgressionPermit;
      globalThis.__careerOpsSubmitAttempts += 1;
      event?.preventDefault?.();
      event?.stopImmediatePropagation?.();
      throw new Error('Career-Ops blocked a final form submission attempt');
    };
    const activationEvents = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'auxclick', 'dblclick', 'keydown', 'keyup'];
    const gestureFormControls = new WeakSet();
    const guardActivation = (event) => {
      if (['keydown', 'keyup'].includes(event.type) && !['Enter', ' ', 'Spacebar'].includes(event.key)) return;
      const path = event.composedPath?.() || [];
      const selector = 'button, input[type="submit"], input[type="button"], input[type="image"], input[type="reset"], a, [role="button"], [role="link"]';
      const control = path.find((element) => element.matches?.(selector)) || event.target?.closest?.(selector);
      // Enter in a text field of a form-less application: no native submit event exists, so the page's own
      // JavaScript could submit. Comboboxes and textareas keep Enter for option choice and new lines.
      const target = path[0] || event.target;
      if (['keydown', 'keyup'].includes(event.type) && event.key === 'Enter' && target?.tagName === 'INPUT'
          && !['checkbox', 'radio', 'file', 'submit', 'button', 'image', 'reset'].includes((target.type || '').toLowerCase())
          && target.getAttribute('role') !== 'combobox' && !target.getAttribute('aria-autocomplete')
          && target.getAttribute('data-uxi-widget-type') !== 'selectinput'
          && !target.form && target.closest('[data-career-ops-virtual-form]')) {
        return block(event);
      }
      if (!control || ['textbox', 'checkbox', 'radio', 'combobox', 'listbox'].includes(control.getAttribute('role'))
          || (control.tagName === 'INPUT' && !['submit', 'button', 'image', 'reset'].includes(control.type))
          || ['TEXTAREA', 'SELECT'].includes(control.tagName)) return;
      const form = control.form || control.closest('form, [data-career-ops-virtual-form]') || path.find((element) => element.tagName === 'FORM');
      // Keep the gesture guarded if a handler moves the control or removes its form.
      if (form && ['pointerdown', 'mousedown', 'touchstart', 'keydown'].includes(event.type)) gestureFormControls.add(control);
      if (!form && !gestureFormControls.has(control)) {
        // A form-less application step (a freshly loaded Workday Review: no fields, no form, "step 6 of 6") has its
        // final Submit outside any form; block final labels there. A Workday flow container or footer always protects
        // its final button. Any visible structured step keeps final labels outside forms blocked; only an explicit
        // [data-career-ops-wizard] holding exactly one form with fields lifts it, and only for controls outside that
        // wizard (a stepper inside a form does not: an SPA may render its Submit outside that form).
        const inApplicationFlow = Boolean(control.closest('[data-automation-id="applyFlowPage"], [data-automation-id="pageFooter"]'));
        const shown = (element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const formWithFields = (item) => shown(item)
          && [...item.querySelectorAll('input:not([type="hidden"]), textarea, select, [role="combobox"]')].some(shown);
        const insideWizard = (wizard) => {
          for (let node = control; node; node = node.getRootNode() instanceof ShadowRoot ? node.getRootNode().host : null) {
            if (wizard.contains(node)) return true;
          }
          return false;
        };
        const stepOwnsForm = (step) => {
          const forms = [...document.querySelectorAll('form, [data-career-ops-virtual-form]')].filter(formWithFields);
          const wizard = step.closest('[data-career-ops-wizard]');
          return Boolean(wizard) && !insideWizard(wizard) && forms.some((item) => wizard.contains(item))
            && [...wizard.querySelectorAll('form, [data-career-ops-virtual-form]')].filter(formWithFields).length === 1;
        };
        // Plain "Step 3 of 3" text also counts here (blocking only; progression still needs verified structure).
        const textSteps = [];
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        for (let item = walker.nextNode(); item; item = walker.nextNode()) {
          if (item.parentElement && /\b(?:step|page)\s*\d+\s+(?:of|\/)\s+\d+(?!\d)/i.test(item.textContent || '')) textSteps.push(item.parentElement);
        }
        const formlessApplicationStep = inApplicationFlow
          || [...document.querySelectorAll('[data-automation-id="progressBarActiveStep"], [aria-current="step"], [data-career-ops-step]'), ...textSteps]
            .some((step) => shown(step) && !stepOwnsForm(step));
        if (formlessApplicationStep && finalToken.test(controlLabels(control).join(' '))) block(event);
        return;
      }
      const labels = controlLabels(control);
      if (finalToken.test(labels.join(' '))) return block(event);
      if (!labels.some((label) => progressionLabel.test(label))) return;
      if (!permittedControl(control, form)) block(event);
    };
    const nativeSubmit = HTMLFormElement.prototype.submit;
    const nativeRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    globalThis.__careerOpsOperationalGuard = { block, guardActivation, activationEvents, isIntermediateControl, nativeSubmit, nativeRequestSubmit, document };
    document.addEventListener('submit', block, true);
    for (const type of activationEvents) document.addEventListener(type, guardActivation, { capture: true, passive: false });
    HTMLFormElement.prototype.submit = function guardedSubmit() { block(); };
    HTMLFormElement.prototype.requestSubmit = function guardedRequestSubmit(submitter) {
      const permit = globalThis.__careerOpsProgressionPermit;
      const exact = arguments.length === 1
        && submitter
        && permit
        && permit.classification === 'progression'
        && permit.consumed !== true
        && Date.now() <= permit.expiresAt
        && submitter === permit.controlElement
        && this === permit.formElement;
      if (exact) return nativeRequestSubmit.call(this, submitter);
      return block();
    };
}

export async function installSubmissionGuard(page) {
  const rules = {
    finalTokenSource: FINAL_TOKEN.source, finalTokenFlags: FINAL_TOKEN.flags,
    progressionLabelSource: PROGRESSION_ACTION_LABEL.source, progressionLabelFlags: PROGRESSION_ACTION_LABEL.flags,
  };
  const context = page.context?.();
  if (context?.addInitScript && !operationalGuardContexts.has(context)) {
    await context.addInitScript(installOperationalGuardInDocument, rules);
    operationalGuardContexts.add(context);
  }
  await page.evaluate(() => {
    const parts = String(globalThis.name || '').split('|').filter(Boolean);
    if (!parts.includes('career-ops-guard-active')) parts.push('career-ops-guard-active');
    globalThis.name = parts.join('|');
  });
  await page.evaluate(installOperationalGuardInDocument, rules);
}

export async function removeOperationalSubmissionGuard(page) {
  await page.evaluate(() => {
    const guard = globalThis.__careerOpsOperationalGuard;
    if (!guard) return;
    document.removeEventListener('submit', guard.block, true);
    for (const type of guard.activationEvents) document.removeEventListener(type, guard.guardActivation, true);
    HTMLFormElement.prototype.submit = guard.nativeSubmit;
    HTMLFormElement.prototype.requestSubmit = guard.nativeRequestSubmit;
    delete globalThis.__careerOpsProgressionPermit;
    delete globalThis.__careerOpsCurrentStateFingerprint;
    delete globalThis.__careerOpsApplicationIdentity;
    globalThis.name = String(globalThis.name || '').split('|').filter((part) => part && part !== 'career-ops-guard-active').join('|');
    delete globalThis.__careerOpsOperationalGuard;
  });
}

export async function grantProgressionPermit(page, control, {
  applicationIdentity,
  stateFingerprint,
  timeoutMs = DEFAULT_PROGRESSION_TRANSITION_MS,
} = {}) {
  if (classifyApplicationControl(control) !== 'progression') {
    throw new Error('Progression permit refused for a non-progression control.');
  }
  await installSubmissionGuard(page);
  const expected = applicationControlSignature(control);
  return page.evaluate(({ expected, applicationIdentity: identity, stateFingerprint: fingerprint, timeoutMs: ttl }) => {
    delete globalThis.__careerOpsProgressionPermit;
    const controls = [...document.querySelectorAll(`[data-career-ops-control-id="${CSS.escape(expected.controlId)}"]`)];
    const forms = [...document.querySelectorAll(`[data-career-ops-form-id="${CSS.escape(expected.formId)}"]`)];
    if (controls.length !== 1 || forms.length !== 1) return false;
    const controlElement = controls[0];
    const formElement = forms[0];
    if ((controlElement.form || controlElement.closest('form, [data-career-ops-virtual-form]')) !== formElement) return false;
    const live = {
      controlId: String(controlElement.getAttribute('data-career-ops-control-id') || '').trim(),
      formId: String(formElement.getAttribute('data-career-ops-form-id') || '').trim(),
      label: String(controlElement.getAttribute('aria-label') || controlElement.innerText || controlElement.value || '').replace(/\s+/g, ' ').trim().replace(/\s*&\s*/g, ' & '),
      type: String(controlElement.type || '').trim().toLowerCase(),
      formAction: String(controlElement.getAttribute('formaction') || formElement.getAttribute('action') || '').trim(),
      formMethod: String(controlElement.getAttribute('formmethod') || formElement.getAttribute('method') || 'get').trim().toLowerCase(),
    };
    if (!Object.keys(expected).every((key) => live[key] === expected[key])) return false;
    if (!globalThis.__careerOpsOperationalGuard?.isIntermediateControl(controlElement, formElement)) return false;
    globalThis.__careerOpsApplicationIdentity = identity;
    globalThis.__careerOpsCurrentStateFingerprint = fingerprint;
    globalThis.__careerOpsProgressionPermit = {
      controlId: expected.controlId,
      formId: expected.formId,
      applicationIdentity: identity,
      stateFingerprint: fingerprint,
      classification: 'progression',
      expiresAt: Date.now() + ttl,
      consumed: false,
      controlElement,
      formElement,
      expected,
    };
    return true;
  }, {
    expected,
    applicationIdentity,
    stateFingerprint,
    timeoutMs,
  });
}

export async function clearProgressionPermit(page) {
  await page.evaluate(() => {
    delete globalThis.__careerOpsProgressionPermit;
    delete globalThis.__careerOpsCurrentStateFingerprint;
  }).catch(() => {});
}

export async function activateProgressionControl(page, control, options = {}) {
  if (classifyApplicationControl(control) !== 'progression') {
    throw new Error('Refusing to activate a final or ambiguous application control.');
  }
  const locator = page.locator(`[data-career-ops-control-id="${String(control.controlId).replace(/"/g, '\\"')}"]`);
  if (await locator.count() !== 1) {
    await clearProgressionPermit(page);
    throw new Error('Progression control identity is no longer exact.');
  }
  const liveSnapshot = await inspectOperationalApplicationForm(page);
  const humanGate = humanGateOutcome(liveSnapshot, 'form_progression');
  if (humanGate) {
    await clearProgressionPermit(page);
    const error = new Error(humanGate.reason);
    error.humanGate = humanGate;
    throw error;
  }
  const liveControl = liveSnapshot.controls.find((item) => item.controlId === control.controlId);
  if (!liveControl || classifyApplicationControl(liveControl) !== 'progression'
      || JSON.stringify(applicationControlSignature(liveControl)) !== JSON.stringify(applicationControlSignature(control))) {
    await clearProgressionPermit(page);
    throw new Error('Progression control changed or is no longer semantically intermediate.');
  }
  const liveFingerprint = applicationFormStateFingerprint(liveSnapshot);
  if (liveFingerprint !== options.stateFingerprint) {
    await clearProgressionPermit(page);
    throw new Error('Application form state changed before progression activation.');
  }
  const granted = await grantProgressionPermit(page, liveControl, options);
  if (!granted) throw new Error('Progression control identity changed before activation.');
  try {
    await locator.click({ timeout: options.timeoutMs || DEFAULT_PROGRESSION_TRANSITION_MS });
  } finally {
    await clearProgressionPermit(page);
  }
}

export async function waitForApplicationStateTransition(page, beforeFingerprint, {
  timeoutMs = DEFAULT_PROGRESSION_TRANSITION_MS,
  pollMs = 200,
  stabilityMs = DEFAULT_PROGRESSION_STABILITY_MS,
  inspect = inspectOperationalApplicationForm,
  clock = () => Date.now(),
} = {}) {
  const started = clock();
  let latest = null;
  let changedFingerprint = null;
  let stableSince = null;
  while (clock() - started < timeoutMs) {
    await installSubmissionGuard(page).catch(() => {});
    latest = await inspect(page);
    const fingerprint = applicationFormStateFingerprint(latest);
    if (fingerprint !== beforeFingerprint) {
      if (fingerprint !== changedFingerprint) {
        changedFingerprint = fingerprint;
        stableSince = clock();
      } else if (clock() - stableSince >= stabilityMs) {
        return { snapshot: latest, fingerprint, durationMs: clock() - started };
      }
    } else {
      changedFingerprint = null;
      stableSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { snapshot: latest, fingerprint: latest ? applicationFormStateFingerprint(latest) : beforeFingerprint, durationMs: clock() - started, timedOut: true };
}

// Workday renders a step in phases: fields first, then the saved values from the server. Reading it earlier makes
// prefilled fields look empty. Settled = network quiet and field values + page text unchanged for quietMs.
async function waitForSettledStep(page, { quietMs = 1_500, maxMs = 10_000 } = {}) {
  if (quietMs <= 0) return;
  await page.waitForLoadState('networkidle', { timeout: Math.min(5_000, maxMs) }).catch(() => {});
  const started = Date.now();
  let last = null;
  let since = Date.now();
  while (Date.now() - started < maxMs) {
    const signature = await page.evaluate(() => {
      const values = [...document.querySelectorAll('input, textarea, select, button[aria-haspopup="listbox"]')]
        .map((element) => (element.type === 'checkbox' ? String(element.checked) : element.value || element.innerText || ''));
      return `${values.length}:${values.join('|').slice(0, 20_000)}:${(document.body?.innerText || '').length}`;
    }).catch(() => null);
    if (signature !== last) {
      last = signature;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function isSameVerifiedApplicationOrigin(beforeUrl, afterUrl) {
  try {
    const before = new URL(beforeUrl);
    const after = new URL(afterUrl);
    return ['http:', 'https:'].includes(after.protocol) && before.origin === after.origin;
  } catch {
    return false;
  }
}

async function exactLocator(page, action) {
  const formPrefix = action.formId
    ? `[data-career-ops-form-id="${String(action.formId).replace(/"/g, '\\"')}"] `
    : '';
  const expectedFieldId = String(action.fieldId);
  const stamped = page.locator(`${formPrefix}[data-career-ops-field-id="${expectedFieldId.replace(/"/g, '\\"')}"]`);
  const stampedCount = await stamped.count();
  if (stampedCount === 1) return stamped;
  if (stampedCount > 1) {
    throw new Error(`Career-Ops exact field identity is ambiguous for ${action.semantic}`);
  }
  const fallbackSelectors = [];
  if (action.id) fallbackSelectors.push(`${formPrefix}[id="${String(action.id).replace(/"/g, '\\"')}"]`);
  if (action.name) fallbackSelectors.push(`${formPrefix}[name="${String(action.name).replace(/"/g, '\\"')}"]`);
  for (const selector of fallbackSelectors) {
    const locator = page.locator(selector);
    const count = await locator.count();
    if (count === 1 && await locator.getAttribute('data-career-ops-field-id') === expectedFieldId) {
      return locator;
    }
  }
  // React can replace a control after typing. A stable DOM id alone is insufficient: repeated panels and other
  // forms can reuse it. Verify ownership and the fresh field's meaning before transferring the planned identity.
  if (action.id && action.formId) {
    const byId = page.locator(`[id="${String(action.id).replace(/"/g, '\\"')}"]`);
    if (await byId.count() === 1) {
      const identity = await byId.evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        formId: (element.form || element.closest('form, [data-career-ops-virtual-form]'))
          ?.getAttribute('data-career-ops-form-id') || '',
        blockId: element.closest('[role="group"][aria-labelledby$="-panel"]')?.id || '',
        blockLabelledBy: element.closest('[role="group"][aria-labelledby$="-panel"]')?.getAttribute('aria-labelledby') || '',
        fieldId: element.getAttribute('data-career-ops-field-id') || '',
      }));
      const belongsToAnotherField = identity.fieldId && identity.fieldId !== expectedFieldId
        && (action.plannedFieldIds || []).includes(identity.fieldId);
      if ((!action.tag || identity.tag === action.tag) && identity.formId === action.formId
          && identity.blockId === (action.workdayBlockId || '')
          && identity.blockLabelledBy === (action.workdayBlockLabelledBy || '') && !belongsToAnotherField) {
        const snapshot = await inspectOperationalApplicationForm(page);
        const field = snapshot.fields.find((item) => item.id === action.id);
        if (snapshot.applicationFormId === action.formId && field?.formId === action.formId
            && classifyFieldSemantics(field).semantic === (action.locatorSemantic || action.semantic)
            && normalizeFormQuestion(fieldQuestion(field)) === normalizeFormQuestion(action.label)) {
          await byId.evaluate((element, fieldId) => element.setAttribute('data-career-ops-field-id', fieldId), expectedFieldId);
          return byId;
        }
      }
    }
  }
  if (action.label && action.action !== 'upload' && action.formId) {
    const locator = page.locator(`[data-career-ops-form-id="${String(action.formId).replace(/"/g, '\\"')}"]`).getByLabel(action.label, { exact: true });
    if (await locator.count() === 1) {
      const fieldId = await locator.getAttribute('data-career-ops-field-id');
      if (fieldId === expectedFieldId) return locator;
    }
  }
  throw new Error(`Form control changed and could not be reacquired: ${action.semantic}`);
}

async function assertNotFinal(locator) {
  const final = await locator.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || '',
    type: element.type,
    formAction: element.getAttribute('formaction'),
    insideApplicationForm: Boolean(element.closest('form, [data-career-ops-virtual-form]')),
    label: element.getAttribute('aria-label') || element.innerText || element.value,
    text: element.innerText || '',
    value: element.value || '',
  }));
  if (isSemanticFinalAction(final)) throw new Error('Refusing to interact with a final-action control');
}

async function validationState(locator) {
  return locator.evaluate((element) => ({
    value: element.value || '',
    educationSelectedValue: element.closest('.education--form') && element.getAttribute('role') === 'combobox'
      ? element.closest('.select__container')?.querySelector('.select__single-value')?.innerText || '' : '',
    checked: Boolean(element.checked),
    invalid: element.getAttribute('aria-invalid') === 'true' || (typeof element.checkValidity === 'function' && !element.checkValidity()),
    files: element.files ? [...element.files].map((file) => file.name) : [],
  }));
}

function remainingTimeout(deadlineMs, clock) {
  const remaining = Math.floor(deadlineMs - clock());
  if (remaining <= 0) {
    const error = new Error('Field attempt time limit reached.');
    error.code = 'FIELD_ATTEMPT_TIMEOUT';
    throw error;
  }
  return remaining;
}

async function ownedAutocompleteOptions(page, action) {
  const locator = await exactLocator(page, action);
  const relationship = await locator.evaluate((element) => ({
    controls: element.getAttribute('aria-controls') || '',
    owns: element.getAttribute('aria-owns') || '',
  }));
  const ownedIds = [...new Set(
    `${relationship.controls} ${relationship.owns}`.trim().split(/\s+/).filter(Boolean),
  )];
  if (ownedIds.length !== 1) {
    throw new Error(`Autocomplete option list is not uniquely owned by ${action.semantic}`);
  }
  const identifiedElements = page.locator('[id]');
  const matchingIndexes = await identifiedElements.evaluateAll((elements, ownedId) => elements
    .map((element, index) => ({ id: element.id, index }))
    .filter((entry) => entry.id === ownedId)
    .map((entry) => entry.index), ownedIds[0]);
  if (matchingIndexes.length !== 1) {
    throw new Error(`Autocomplete option list is not uniquely associated with ${action.semantic}`);
  }
  const listbox = identifiedElements.nth(matchingIndexes[0]);
  if (await listbox.getAttribute('role') !== 'listbox' || !await listbox.isVisible()) {
    throw new Error(`Autocomplete option list is not visible for ${action.semantic}`);
  }
  return { listboxId: ownedIds[0], options: listbox.getByRole('option') };
}

async function chooseAutocomplete(page, action, visibleOptions, { deadlineMs, clock }) {
  let locator = await exactLocator(page, action);
  let selectedLabel = null;
  for (const query of autocompleteQueries(action)) {
    locator = await exactLocator(page, action);
    await assertHumanFillTarget(locator, action);
    await locator.focus({ timeout: remainingTimeout(deadlineMs, clock) });
    await locator.fill('', { timeout: remainingTimeout(deadlineMs, clock) });
    await locator.pressSequentially(query, { delay: 20, timeout: remainingTimeout(deadlineMs, clock) });
    remainingTimeout(deadlineMs, clock);
    await page.waitForTimeout(250);
    const ownedOptions = await ownedAutocompleteOptions(page, action);
    const optionLocators = ownedOptions.options;
    const count = await optionLocators.count();
    let matchingLabel = null;
    for (let index = 0; index < count; index += 1) {
      const option = optionLocators.nth(index);
      const directlyOwned = await option.evaluate(
        (element, listboxId) => element.closest('[role="listbox"]')?.id === listboxId,
        ownedOptions.listboxId,
      ).catch(() => false);
      if (!directlyOwned || !await option.isVisible()) continue;
      const label = cleanFormText(await option.innerText().catch(() => ''));
      if (label) visibleOptions.push(label);
      const matches = groundedAutocompleteMatches(label, action);
      if (!matches) continue;
      matchingLabel ||= label;
    }
    if (matchingLabel) {
      const liveOwnedOptions = await ownedAutocompleteOptions(page, action);
      const liveOptionLocators = liveOwnedOptions.options;
      const liveMatches = [];
      for (let index = 0; index < await liveOptionLocators.count(); index += 1) {
        const option = liveOptionLocators.nth(index);
        const directlyOwned = await option.evaluate(
          (element, listboxId) => element.closest('[role="listbox"]')?.id === listboxId,
          liveOwnedOptions.listboxId,
        ).catch(() => false);
        if (!directlyOwned || !await option.isVisible()) continue;
        const label = cleanFormText(await option.innerText().catch(() => ''));
        if (groundedAutocompleteMatches(label, action)) {
          liveMatches.push({ option, label });
        }
      }
      if (liveMatches.length !== 1) {
        throw new Error(`Autocomplete owned option is ambiguous for ${action.semantic}: ${matchingLabel}`);
      }
      await liveMatches[0].option.click({ timeout: remainingTimeout(deadlineMs, clock) });
      selectedLabel = liveMatches[0].label;
    }
    if (selectedLabel) break;
  }
  if (!selectedLabel) throw new Error(`Autocomplete has no grounded visible option for ${action.value}`);
  locator = await exactLocator(page, action);
  await locator.blur({ timeout: remainingTimeout(deadlineMs, clock) });
  const state = await validationState(locator);
  const committed = cleanFormText(state.educationSelectedValue || state.value);
  if (state.invalid || normalizeFormQuestion(committed) !== normalizeFormQuestion(selectedLabel)) {
    throw new Error(`Autocomplete selection was not committed: ${selectedLabel}`);
  }
  if (action.category === 'current_location' && !groundedLocationMatches(committed, action)) {
    throw new Error(`Autocomplete committed an ungrounded location: ${committed || '(empty)'}`);
  }
  return committed;
}

async function assertHumanFillTarget(locator, action) {
  const liveField = await locator.evaluate((element) => ({
    type: element.type, name: element.name, id: element.id,
    label: [...(element.labels || [])].map((label) => label.innerText).join(' '),
    autocomplete: element.getAttribute('autocomplete'),
    placeholder: element.getAttribute('placeholder'),
    text: element.getAttribute('aria-label'),
  }));
  if (classifyHumanOnlyField(action) || classifyHumanOnlyField(liveField)) {
    throw new Error('Refusing to fill a credential or challenge response field.');
  }
}

async function workdayListboxOptions(page, control, { deadlineMs, clock }) {
  const relation = await control.evaluate((element) => `${element.getAttribute('aria-controls') || ''} ${element.getAttribute('aria-owns') || ''}`.trim());
  const ids = [...new Set(relation.split(/\s+/).filter(Boolean))];
  if (ids.length > 1) throw new Error('Workday dropdown owns several listboxes.');
  if (ids.length === 1) {
    const identified = page.locator(`[id="${ids[0].replace(/"/g, '\\"')}"]`);
    if (await identified.count() !== 1 || await identified.getAttribute('role') !== 'listbox'
        || !await identified.isVisible()) throw new Error('Workday dropdown listbox is not uniquely visible.');
    return identified.locator('[role="option"]');
  }
  const listboxes = page.locator('[role="listbox"]:visible');
  if (await listboxes.count() !== 1) throw new Error('Workday dropdown does not have one visible listbox.');
  const listbox = listboxes.first();
  await listbox.waitFor({ state: 'visible', timeout: Math.min(5_000, remainingTimeout(deadlineMs, clock)) });
  return listbox.locator('[role="option"]');
}

function pickOptionLocators(page) {
  return page.locator('[data-automation-id="promptOption"]:visible, [role="option"]:visible');
}

async function visiblePickChipTexts(input) {
  const container = input.locator('xpath=ancestor::*[@data-automation-id="multiSelectContainer"][1]');
  if (await container.count() !== 1) throw new Error('Workday pick field has no unique multiSelectContainer.');
  const chips = container.locator('[data-automation-id="selectedItem"]');
  const values = [];
  for (let index = 0; index < await chips.count(); index += 1) {
    const chip = chips.nth(index);
    if (await chip.isVisible().catch(() => false)) values.push(cleanFormText(await chip.innerText().catch(() => '')));
  }
  return { container, values: values.filter(Boolean) };
}

function categoryPromptOption(locator, label) {
  return locator.evaluate((element) => Boolean(
    element.hasAttribute('aria-haspopup')
    || element.hasAttribute('aria-expanded')
    || element.hasAttribute('data-has-children')
    || /category|subcategory|sub-category/i.test(element.getAttribute('data-automation-id') || '')
    || /expand|more options/i.test(element.getAttribute('aria-label') || ''),
  )).catch(() => /\b(?:category|other)\b/i.test(label));
}

async function clearPickSearch(page, action, { deadlineMs, clock }) {
  let input = await exactLocator(page, action).catch(() => null);
  if (!input) return;
  await input.press('Escape', { timeout: remainingTimeout(deadlineMs, clock) }).catch(() => null);
  input = await exactLocator(page, action).catch(() => input);
  await input.fill('', { timeout: remainingTimeout(deadlineMs, clock) }).catch(() => null);
}

function optionalSkillSkipError(skill) {
  const error = new Error(`No exact option for skill ${skill}.`);
  error.code = 'OPTIONAL_SKILL_NO_EXACT_OPTION';
  return error;
}

async function chooseWorkdayPick(page, action, visibleOptions, { deadlineMs, clock }) {
  let input = await exactLocator(page, action);
  let chipState = await visiblePickChipTexts(input);
  const originalChips = [...chipState.values];
  if (action.pickKind === 'skill'
      && chipState.values.some((value) => pickOptionMatches(value, action))) {
    return chipState.values.find((value) => pickOptionMatches(value, action));
  }
  if (chipState.values.length && action.pickKind !== 'skill') {
    if (chipState.values.length === 1 && pickOptionMatches(chipState.values[0], action)) return chipState.values[0];
    throw new Error('A different Workday selection is already present; RoleForge did not replace it.');
  }
  try {
    await input.focus({ timeout: remainingTimeout(deadlineMs, clock) });
    await input.fill('', { timeout: remainingTimeout(deadlineMs, clock) });
    for (const character of [...action.value]) {
      input = await exactLocator(page, action);
      await input.pressSequentially(character, { delay: 0, timeout: remainingTimeout(deadlineMs, clock) });
    }
    input = await exactLocator(page, action);
    await input.focus({ timeout: remainingTimeout(deadlineMs, clock) });
    await page.keyboard.press('Enter', { timeout: remainingTimeout(deadlineMs, clock) });
    const options = pickOptionLocators(page);
    if (action.pickKind === 'skill') {
      await options.first().waitFor({ state: 'visible', timeout: Math.min(1_200, remainingTimeout(deadlineMs, clock)) }).catch(() => null);
    }
    else await options.first().waitFor({ state: 'visible', timeout: Math.min(5_000, remainingTimeout(deadlineMs, clock)) });
    for (let depth = 0; depth < 3; depth += 1) {
      const liveOptions = pickOptionLocators(page);
      const count = await liveOptions.count();
      const matching = [];
      const categories = [];
      for (let index = 0; index < count; index += 1) {
        const option = liveOptions.nth(index);
        if (!await option.isVisible().catch(() => false)) continue;
        const label = cleanFormText(await option.innerText().catch(() => ''));
        if (!label) continue;
        visibleOptions.push(label);
        if (pickOptionMatches(label, action)) matching.push({ option, label });
        else if (await categoryPromptOption(option, label)) categories.push({ option, label });
      }
      if (matching.length > 1) throw new Error(`Several Workday pick options match ${action.value}.`);
      let selectedLabel = null;
      if (matching.length === 1) {
        selectedLabel = matching[0].label;
        await matching[0].option.click({ timeout: remainingTimeout(deadlineMs, clock) });
      } else if (categories.length === 1 && action.pickKind !== 'skill') {
        await categories[0].option.click({ timeout: remainingTimeout(deadlineMs, clock) });
        await page.waitForTimeout(100);
        input = await exactLocator(page, action);
        chipState = await visiblePickChipTexts(input);
        if (chipState.values.length) {
          if (chipState.values.length === 1 && pickOptionMatches(chipState.values[0], action)) return chipState.values[0];
          throw new Error('A different Workday selection is already present; RoleForge did not replace it.');
        }
        const children = pickOptionLocators(page);
        if (await children.count()) continue;
        throw new Error(`Workday category did not open child options for ${action.value}.`);
      } else {
        if (action.pickKind === 'skill') throw optionalSkillSkipError(action.value);
        throw new Error(`No unique Workday pick option matches ${action.value}.`);
      }
      await page.waitForTimeout(100);
      input = await exactLocator(page, action);
      chipState = await visiblePickChipTexts(input);
      if (action.pickKind === 'skill') {
        const preserved = originalChips.every((value) => chipState.values.includes(value));
        const added = chipState.values.some((value) => pickOptionMatches(value, action)
          && !originalChips.includes(value));
        if (preserved && added) return chipState.values.find((value) => pickOptionMatches(value, action));
        throw new Error(`Workday did not add the skill chip without changing existing chips: ${action.value}.`);
      }
      if (chipState.values.length === 1 && pickOptionMatches(chipState.values[0], action)) return chipState.values[0];
      if (chipState.values.length) throw new Error('Workday selected a different chip; RoleForge did not replace it.');
      const childOptions = pickOptionLocators(page);
      if (!selectedLabel && await childOptions.count()) continue;
      if (await childOptions.count()) continue;
      throw new Error(`Workday pick option was not committed: ${selectedLabel || action.value}.`);
    }
    throw new Error(`Workday category nesting is too deep for ${action.value}.`);
  } catch (error) {
    await clearPickSearch(page, action, { deadlineMs, clock });
    throw error;
  }
}

async function performAction(page, action, visibleOptions, { deadlineMs, clock }) {
  let locator = await exactLocator(page, action);
  await assertNotFinal(locator);
  await assertHumanFillTarget(locator, action);
  if (action.action === 'upload') {
    const target = await locator.elementHandle();
    if (!target) throw new Error(`Exact upload input is unavailable: ${action.semantic}`);
    try {
      const before = await target.evaluate((element) => ({
        fieldId: element.getAttribute('data-career-ops-field-id') || '',
        type: (element.type || '').toLowerCase(),
      }));
      if (before.type !== 'file') throw new Error(`Exact upload target is not a file input: ${action.semantic}`);
      if (before.fieldId && before.fieldId !== action.fieldId) {
        throw new Error(`Exact upload target identity changed before upload: ${action.semantic}`);
      }
      // Re-checked live: the input may have gained a different file since planning, and setInputFiles replaces it.
      const other = await differentAttachment(target, action.artifact);
      if (other) throw new Error(`A different file is already attached here (${other}); RoleForge did not replace it. Review it.`);
      await locator.setInputFiles(action.artifact.resolvedPath, { timeout: remainingTimeout(deadlineMs, clock) });
      const state = await target.evaluate((element) => ({
        attached: element.isConnected,
        files: element.files ? [...element.files].map((file) => file.name) : [],
      }));
      const workdayAutofill = await page.evaluate(() => Boolean(document.querySelector('[data-automation-id="applyFlowAutoFillPage"]')))
        .catch(() => false);
      if (workdayAutofill) {
        if (!await uploadedFileTileShown(page, action.artifact.intendedFilename, { deadlineMs, clock })) {
          throw new Error(`Workday did not finish parsing the exact CV upload: ${action.artifact.intendedFilename}`);
        }
        return action.artifact.intendedFilename;
      }
      // Workday consumes the file: the input empties or is removed and a tile shows the uploaded file's exact name.
      if (state.files.length === 0
          && await uploadedFileTileShown(page, action.artifact.intendedFilename, { deadlineMs, clock })) {
        return action.artifact.intendedFilename;
      }
      if (state.files.length !== 1 || state.files[0] !== action.artifact.intendedFilename) {
        throw new Error(
          `Exact upload input did not accept the intended artifact for ${action.semantic}: expected ${action.artifact.intendedFilename}; observed ${state.files.join(', ') || '(none)'}`,
        );
      }
    } finally {
      await target.dispose();
    }
    return action.artifact.intendedFilename;
  }
  if (action.action === 'listbox') {
    // Workday "Select One" button: open it, pick the option whose whole text matches, verify the button shows it.
    // Option order varies per question, so never pick by position.
    const existing = cleanFormText(await locator.innerText());
    if (existing && !/^select one$/i.test(existing)) {
      if (listboxOptionMatches(existing, action)) return action.value;
      throw new Error(`Existing selection (${existing}) differs from the grounded value (${action.optionMatch?.qualification || action.value}); review is required.`);
    }
    await locator.click({ timeout: remainingTimeout(deadlineMs, clock) });
    const options = await workdayListboxOptions(page, locator, { deadlineMs, clock });
    try {
      await options.first().waitFor({ state: 'visible', timeout: Math.min(5_000, remainingTimeout(deadlineMs, clock)) });
    } catch (error) {
      await page.keyboard.press('Escape').catch(() => null);
      throw error;
    }
    const findMatch = async () => {
      const count = await options.count();
      let found = null;
      for (let index = 0; index < count; index += 1) {
        const option = options.nth(index);
        if (!await option.isVisible().catch(() => false)) continue;
        if (listboxOptionMatches(await option.innerText().catch(() => ''), action)) {
          if (found) {
            await page.keyboard.press('Escape').catch(() => null);
            throw new Error(`Several dropdown options match ${action.value}`);
          }
          found = option;
        }
      }
      return found;
    };
    let match = await findMatch();
    // Long Workday lists (Language) render only part of their options: type the option's name (the listbox jumps
    // to it), then scroll through the list. Still chosen by exact text, never by position.
    if (!match && action.optionMatch?.mode !== 'proficiency' && action.optionMatch?.mode !== 'degree') {
      await page.keyboard.type(cleanFormText(action.value), { delay: 40 }).catch(() => null);
      await page.waitForTimeout(400);
      match = await findMatch();
    }
    for (let step = 0; !match && step < 60; step += 1) {
      const moved = await options.first().evaluate((option) => {
        const list = option.closest('[role="listbox"]');
        const scroller = [list, ...(list ? [...list.querySelectorAll('*')] : [])].find((element) => element && element.scrollHeight > element.clientHeight + 4)
          || list?.parentElement;
        if (!scroller) return false;
        const before = scroller.scrollTop;
        scroller.scrollTop += Math.max(120, scroller.clientHeight * 0.8);
        return scroller.scrollTop !== before;
      }).catch(() => false);
      if (!moved) break;
      await page.waitForTimeout(120);
      match = await findMatch();
    }
    if (!match) {
      await page.keyboard.press('Escape').catch(() => null);
      throw new Error(`No exact dropdown option for ${action.value}`);
    }
    await match.click({ timeout: remainingTimeout(deadlineMs, clock) });
    locator = await exactLocator(page, action);
    if (!listboxOptionMatches(await locator.innerText(), action)) {
      throw new Error(`Dropdown selection did not remain committed: ${action.value}`);
    }
    return action.value;
  }
  if (action.action === 'pick') return chooseWorkdayPick(page, action, visibleOptions, { deadlineMs, clock });
  if (action.action === 'date') {
    for (const segment of action.dateSegments || []) {
      let target = await exactLocator(page, { ...action, fieldId: segment.fieldId, id: segment.id, name: segment.name });
      const before = await target.inputValue().catch(() => '');
      if (before && before !== segment.value) {
        throw new Error(`A Workday date segment is already populated; RoleForge did not replace it: ${segment.segment}`);
      }
      if (!before) {
        await target.fill(segment.value, { timeout: remainingTimeout(deadlineMs, clock) });
        target = await exactLocator(page, { ...action, fieldId: segment.fieldId, id: segment.id, name: segment.name });
        await target.blur({ timeout: remainingTimeout(deadlineMs, clock) });
      }
      target = await exactLocator(page, { ...action, fieldId: segment.fieldId, id: segment.id, name: segment.name });
      const state = await validationState(target);
      if (state.invalid || cleanFormText(state.value) !== segment.value) {
        throw new Error(`Workday date segment did not remain committed: ${segment.segment}`);
      }
    }
    return action.value;
  }
  if (action.action === 'select') {
    const selected = await locator.evaluate((element, intended) => {
      const normalized = (value) => String(value || '').trim().toLowerCase();
      const option = [...element.options].find((item) => (
        normalized(item.textContent) === normalized(intended)
        || normalized(item.value) === normalized(intended)
      ));
      return option ? { value: option.value, label: option.textContent.trim() } : null;
    }, action.value);
    if (!selected) throw new Error(`No exact dropdown option for ${action.value}`);
    await locator.selectOption(selected.value, { timeout: remainingTimeout(deadlineMs, clock) });
    locator = await exactLocator(page, action);
    await locator.blur({ timeout: remainingTimeout(deadlineMs, clock) });
    const state = await validationState(locator);
    if (state.invalid || state.value !== selected.value) throw new Error(`Dropdown selection did not remain committed: ${action.value}`);
    return selected.label;
  }
  if (action.action === 'autocomplete') {
    return chooseAutocomplete(page, action, visibleOptions, { deadlineMs, clock });
  }
  if (action.action === 'check' || action.action === 'radio') {
    await locator.check({ timeout: remainingTimeout(deadlineMs, clock) });
    locator = await exactLocator(page, action);
    const state = await validationState(locator);
    if (!state.checked || state.invalid) throw new Error(`Choice did not remain committed: ${action.semantic}`);
    return action.value;
  }
  if (action.action === 'uncheck') {
    await locator.uncheck({ timeout: remainingTimeout(deadlineMs, clock) });
    locator = await exactLocator(page, action);
    const state = await validationState(locator);
    if (state.checked || state.invalid) throw new Error(`Choice did not remain unchecked: ${action.semantic}`);
    return action.value;
  }
  await locator.fill(action.value, { timeout: remainingTimeout(deadlineMs, clock) });
  await locator.blur({ timeout: remainingTimeout(deadlineMs, clock) });
  locator = await exactLocator(page, action);
  const state = await validationState(locator);
  const normalizeValue = action.category === 'custom_motivation_experience_narrative'
    ? normalizeNarrativeText
    : action.semantic === 'phone'
      ? (value) => cleanFormText(value).replace(/[\s().-]+/g, '')
    : cleanFormText;
  if (state.invalid || normalizeValue(state.value) !== normalizeValue(action.value)) {
    throw new Error(`Field value did not remain committed: ${action.semantic}`);
  }
  return state.value;
}

// Bound documents the form is expected to receive. A single combined upload covers both CV and cover letter.
export function expectedDocuments(artifacts = {}, uploadTopology = null) {
  if (uploadTopology?.mode === 'single_combined' && artifacts.combinedDocument) {
    return [{ semantic: 'single_document_upload', artifact: artifacts.combinedDocument }];
  }
  // Without a bound combined document, the separately bound CV and cover letter stay outstanding.
  return [
    artifacts.cv && { semantic: 'cv_upload', artifact: artifacts.cv },
    artifacts.coverLetter && { semantic: 'cover_letter_upload', artifact: artifacts.coverLetter },
  ].filter(Boolean);
}

const DOCUMENT_LABEL = { cv_upload: 'CV', cover_letter_upload: 'Cover letter', single_document_upload: 'Combined application document' };

export function manualUploadRow(doc, reason) {
  return {
    fieldId: `upload-${doc.semantic}`,
    stableFieldId: `upload:${doc.semantic}`,
    label: `${DOCUMENT_LABEL[doc.semantic]} upload`,
    category: 'file_upload',
    semantic: doc.semantic,
    reason: `${reason} Upload this exact file manually: ${doc.artifact.resolvedPath}`,
    manualUploadPath: doc.artifact.resolvedPath,
    manualActionRequired: true,
  };
}

// Finds upload buttons/tiles/links for one doc purpose, e.g. SuccessFactors "Upload a CV" tiles that open a
// dialog or a native file chooser. Purpose comes from the control's own text or its nearest small container.
function stampUploadTriggers({ semantic, applicationFormId, finalTokenSource, finalTokenFlags }) {
  const finalToken = new RegExp(finalTokenSource, finalTokenFlags);
  const purposes = {
    cv_upload: /\b(?:cv|resume|résumé|curriculum vitae|ansioluettelo|lebenslauf)\b/i,
    cover_letter_upload: /\b(?:cover(?:ing)? letter|motivation letter|application letter|saatekirje|hakemuskirje|anschreiben)\b/i,
  };
  const uploadWords = /\b(?:upload|attach|browse|choose (?:a )?file|select (?:a )?file|add (?:a )?(?:file|document)|lataa|liitä|valitse tiedosto)\b/i;
  const text = (element) => [element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText, element.value,
    ...(element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.innerText)]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const visible = (element) => {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const purposeOf = (value) => {
    const hits = Object.entries(purposes).filter(([, pattern]) => pattern.test(value)).map(([key]) => key);
    return hits.length === 1 ? hits[0] : hits.length ? 'ambiguous' : null;
  };
  for (const element of document.querySelectorAll('[data-career-ops-upload-trigger]')) element.removeAttribute('data-career-ops-upload-trigger');
  const found = [];
  for (const element of document.querySelectorAll('button, a, [role="button"], input[type="button"], label, [tabindex]:not([tabindex="-1"])')) {
    if (!visible(element) || element.type === 'submit') continue;
    // A real link would navigate away from the form; upload links are script-driven ("#" or javascript:).
    if (element.tagName === 'A' && element.getAttribute('href') && !/^\s*(?:#|javascript:)/i.test(element.getAttribute('href'))) continue;
    if (element.closest('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="onetrust" i]')) continue;
    const own = text(element);
    if (!uploadWords.test(own) || finalToken.test(own.replace(uploadWords, ' '))) continue;
    let purpose = purposeOf(own);
    for (let node = element.parentElement, depth = 0; !purpose && node && depth < 5; node = node.parentElement, depth += 1) {
      const context = (node.innerText || '').replace(/\s+/g, ' ').trim();
      if (context.length > 300) break;
      purpose = purposeOf(context);
    }
    if (purpose !== semantic) continue;
    const owningForm = element.closest('form, [data-career-ops-virtual-form]');
    if (applicationFormId && owningForm && owningForm.getAttribute('data-career-ops-form-id') !== applicationFormId) continue;
    found.push(element);
  }
  // Prefer the innermost control when a tile wrapper and its button both qualify.
  const innermost = found.filter((element) => !found.some((other) => other !== element && element.contains(other)));
  return innermost.slice(0, 3).map((element, index) => {
    const id = `${semantic}-${index}`;
    element.setAttribute('data-career-ops-upload-trigger', id);
    return id;
  });
}

const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]';

async function openModal(page) {
  const modals = page.locator(MODAL_SELECTOR);
  for (let index = 0; index < await modals.count(); index += 1) {
    if (await modals.nth(index).isVisible()) return modals.nth(index);
  }
  return null;
}

// A Workday upload tile ([data-automation-id="file-upload-item-name"]) whose whole text is exactly the file name.
async function uploadedFileTileShown(page, filename, { deadlineMs, clock }) {
  const until = Math.min(deadlineMs ?? Infinity, clock() + 30_000);
  do {
    // Shown and finished: Workday shows loading dots until the upload is processed ("Successfully Uploaded!").
    const shown = await page.evaluate((name) => [...document.querySelectorAll('[data-automation-id="file-upload-item-name"]')]
      .some((element) => {
        if (element.getClientRects().length === 0 || (element.textContent || '').trim() !== name) return false;
        for (let row = element.parentElement; row && !row.matches('[data-automation-id="applyFlowAutoFillPage"]'); row = row.parentElement) {
          const rowText = (row.innerText || '').replace(/\s+/g, ' ');
          const rowFileCount = row.querySelectorAll('[data-automation-id="file-upload-item-name"]').length;
          const loading = [...row.querySelectorAll('[data-automation-id="file-loading-dots"]')]
            .some((item) => item.getClientRects().length > 0);
          if (/successfully uploaded/i.test(rowText) && rowFileCount === 1) return !loading;
          if (rowText.length > 500) break;
        }
        return false;
      }), filename)
      .catch(() => false);
    if (shown) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (clock() < until);
  return false;
}

async function reparseBoundWorkdayResume(page, artifact, uploadedThisPass, progressLog) {
  if (!artifact?.intendedFilename || uploadedThisPass.has(artifact.intendedFilename)) return { changed: false };
  const filename = artifact.intendedFilename;
  const tileState = await page.evaluate((name) => {
    const step = document.querySelector('[data-automation-id="applyFlowAutoFillPage"]');
    if (!step) return null;
    const names = [...step.querySelectorAll('[data-automation-id="file-upload-item-name"]')]
      .filter((tile) => tile.getClientRects().length > 0).map((tile) => (tile.textContent || '').trim()).filter(Boolean);
    return { names, exact: names.includes(name) };
  }, filename).catch(() => null);
  if (!tileState) return { changed: false };
  if (!tileState.exact) {
    const different = [...new Set(tileState.names)];
    if (!different.length) return { changed: false };
    const attached = different.join(', ');
    progressLog?.(`[form] Workday Autofill has a different resume tile (${attached}); leaving it for user review`);
    return { changed: false, unresolved: {
      fieldId: 'workday-different-resume', stableFieldId: `workday:different-resume:${attached}`,
      label: `A different file is already attached here (${attached}); RoleForge did not replace it. Review it; the bound file is ${artifact.resolvedPath}`,
      category: 'file_upload', semantic: 'cv_upload', manualUploadPath: artifact.resolvedPath,
      reason: `A different file is already attached here (${attached}); RoleForge did not replace it. Review it.`,
      manualActionRequired: true,
    } };
  }

  const marker = `career-ops-reparse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const scopes = await page.evaluate(({ name, marker }) => {
    const step = document.querySelector('[data-automation-id="applyFlowAutoFillPage"]');
    const tile = step && [...step.querySelectorAll('[data-automation-id="file-upload-item-name"]')]
      .find((item) => item.getClientRects().length > 0 && (item.textContent || '').trim() === name);
    if (!tile) return [];
    const result = [];
    for (let node = tile.parentElement, depth = 0; node && step.contains(node); node = node.parentElement, depth += 1) {
      const key = `${marker}-${depth}`;
      node.setAttribute('data-career-ops-reparse-scope', key);
      result.push({ key, depth });
      if (node === step) break;
    }
    return result;
  }, { name: filename, marker }).catch(() => []);
  let removed = false;
  try {
    for (const scopeInfo of scopes) {
      const scope = page.locator(`[data-career-ops-reparse-scope="${scopeInfo.key}"]`);
      const exactTiles = await scope.locator('[data-automation-id="file-upload-item-name"]')
        .evaluateAll((tiles, name) => tiles.filter((tile) => (tile.textContent || '').trim() === name).length === 1
          && tiles.length === 1, filename).catch(() => false);
      if (!exactTiles) continue;
      const button = scope.getByRole('button', { name: `Delete ${filename}`, exact: true });
      if (await button.count() !== 1) continue;
      const safe = await button.evaluate((element) => element.tagName !== 'BUTTON'
        || (element.type || '').toLowerCase() !== 'submit').catch(() => false);
      if (!safe) continue;
      await assertNotFinal(button);
      progressLog?.(`[form] Workday Autofill already has the bound CV "${filename}"; deleting its exact tile so Workday parses this pass's upload`);
      await button.click({ timeout: 5_000 });
      const deadline = Date.now() + 30_000;
      do {
        const ready = await page.evaluate((name) => {
          const step = document.querySelector('[data-automation-id="applyFlowAutoFillPage"]');
          if (!step) return false;
          const oldTile = [...step.querySelectorAll('[data-automation-id="file-upload-item-name"]')]
            .some((item) => (item.textContent || '').trim() === name);
          return !oldTile
            && Boolean(step.querySelector('[data-automation-id="file-upload-drop-zone"]'))
            && Boolean(step.querySelector('input[type="file"][data-automation-id="file-upload-input-ref"]'));
        }, filename).catch(() => false);
        if (ready) {
          removed = true;
          progressLog?.(`[form] Workday Autofill drop zone returned; re-uploading the exact bound CV "${filename}"`);
          return { changed: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      } while (Date.now() < deadline);
      return { changed: false, unresolved: {
        fieldId: 'workday-resume-reparse', stableFieldId: `workday:resume-reparse:${filename}`,
        label: 'Workday could not restore the CV upload control; review the Autofill step before continuing',
        category: 'file_upload', semantic: 'cv_upload',
        reason: 'The exact bound CV tile was deleted, but the Workday drop zone and hidden file input did not return.',
        manualActionRequired: true,
      } };
    }
    return { changed: false, unresolved: {
      fieldId: 'workday-resume-reparse', stableFieldId: `workday:resume-reparse:${filename}`,
      label: 'Workday has the bound CV but no exact Delete button; review the Autofill step before continuing',
      category: 'file_upload', semantic: 'cv_upload',
      reason: `No button with the exact accessible name "Delete ${filename}" was found in the bound CV tile.`,
      manualActionRequired: true,
    } };
  } finally {
    await page.evaluate((prefix) => [...document.querySelectorAll('[data-career-ops-reparse-scope]')]
      .filter((element) => (element.getAttribute('data-career-ops-reparse-scope') || '').startsWith(`${prefix}-`))
      .forEach((element) => element.removeAttribute('data-career-ops-reparse-scope')), marker).catch(() => {});
    if (removed) progressLog?.(`[form] Workday CV tile removed; the normal verified upload action will attach "${filename}"`);
  }
}

function cssAttributeValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function workdayEntryManualRow(section, entryNumber, field, reason) {
  const slug = `${section}-${entryNumber}-${field}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    fieldId: `workday-cv-entry-${slug}`,
    stableFieldId: `workday-cv-entry:${slug}`,
    label: `${section} ${entryNumber}: ${field}`,
    category: 'workday_entry_field',
    semantic: 'cv_entry_field',
    reason,
    missingInformation: null,
    manualActionRequired: true,
  };
}

async function workdaySectionPanels(page, sectionId) {
  return page.evaluate((id) => {
    const section = document.querySelector(`[role="group"][aria-labelledby="${id}"]`);
    if (!section) return { present: false, panels: [] };
    const panels = [...section.querySelectorAll('[role="group"][aria-labelledby$="-panel"]')];
    return { present: true, panels: panels.map((panel) => ({
      key: panel.getAttribute('aria-labelledby') || '',
      title: (panel.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map((labelId) => document.getElementById(labelId)?.textContent || '').join(' ')
        .replace(/\s+/g, ' ').trim(),
    })) };
  }, sectionId).catch(() => ({ present: false, panels: [] }));
}

async function waitForWorkdayEntryPanel(page, sectionId, knownKeys, heading) {
  const deadline = Date.now() + 10_000;
  do {
    const state = await workdaySectionPanels(page, sectionId);
    const panel = state.panels.find((item) => !knownKeys.includes(item.key)
      && new RegExp(`^${escapeRegex(heading)}\\s+\\d+$`, 'i').test(item.title));
    if (panel) return panel;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return null;
}

async function fillWorkdayEntryText(panel, selector, value, section, entryNumber, field, unresolved) {
  if (!value) return;
  const input = panel.locator(selector);
  if (await input.count().catch(() => 0) !== 1) {
    unresolved.push(workdayEntryManualRow(section, entryNumber, field, 'The new Workday entry does not have one exact matching field.'));
    return;
  }
  const before = await input.inputValue().catch(() => '');
  if (before && before !== value) {
    unresolved.push(workdayEntryManualRow(section, entryNumber, field, 'The new Workday field already contains a different value; it was left unchanged.'));
    return;
  }
  if (!before) await input.fill(value, { timeout: 5_000 }).catch(() => {});
  const deadline = Date.now() + 5_000;
  do {
    const live = panel.locator(selector);
    const current = await live.inputValue().catch(() => '');
    if (current === value) {
      await live.blur().catch(() => {});
      const committed = await panel.locator(selector).inputValue().catch(() => '');
      if (committed === value) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  unresolved.push(workdayEntryManualRow(section, entryNumber, field, 'The Workday field did not retain the exact CV value.'));
}

async function fillWorkdayEntryDate(panel, suffix, segments, section, entryNumber, field, unresolved) {
  if (!segments) {
    unresolved.push(workdayEntryManualRow(section, entryNumber, field, 'The CV date line does not contain an exact supported date.'));
    return;
  }
  const wrapper = panel.locator(`[data-automation-id="dateInputWrapper"][id$="--${suffix}"]`);
  if (await wrapper.count().catch(() => 0) !== 1) {
    unresolved.push(workdayEntryManualRow(section, entryNumber, field, 'The new Workday entry does not have one exact date group.'));
    return;
  }
  for (const segment of ['month', 'year'].filter((part) => segments[part])) {
    await fillWorkdayEntryText(wrapper, `input[id$="dateSection${segment[0].toUpperCase()}${segment.slice(1)}-input"]`,
      segments[segment], section, entryNumber, field, unresolved);
  }
}

async function chooseWorkdayEntryLanguage(page, panel, language, entryNumber, unresolved) {
  const selector = 'button[aria-haspopup="listbox"][name="language"]';
  let control = panel.locator(selector);
  if (await control.count().catch(() => 0) !== 1) {
    unresolved.push(workdayEntryManualRow('Languages', entryNumber, 'Language', 'The new Workday entry does not have one language dropdown.'));
    return;
  }
  let current = cleanFormText(await control.innerText().catch(() => ''));
  if (normalizeFormQuestion(current) === normalizeFormQuestion(language)) return;
  if (current && !/^select one$/i.test(current)) {
    unresolved.push(workdayEntryManualRow('Languages', entryNumber, 'Language', 'The new Workday language dropdown already contains a different choice.'));
    return;
  }
  await assertNotFinal(control);
  await control.click({ timeout: 5_000 });
  const options = await workdayListboxOptions(page, control, { deadlineMs: Date.now() + 5_000, clock: () => Date.now() });
  await options.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  const seen = new Set();
  const findMatches = async () => {
    const found = [];
    for (let index = 0; index < await options.count(); index += 1) {
      const option = options.nth(index);
      if (!await option.isVisible().catch(() => false)) continue;
      const text = cleanFormText(await option.innerText().catch(() => ''));
      if (text) seen.add(text);
      if (normalizeFormQuestion(text) === normalizeFormQuestion(language)) found.push(option);
    }
    return found;
  };
  let matches = await findMatches();
  // The language list is long and only partly rendered: type the name (the listbox jumps to it), then scroll.
  if (!matches.length) {
    await page.keyboard.type(language, { delay: 40 }).catch(() => {});
    await page.waitForTimeout(400);
    matches = await findMatches();
  }
  for (let step = 0; !matches.length && step < 80; step += 1) {
    const moved = await options.first().evaluate((option) => {
      const list = option.closest('[role="listbox"]');
      const scroller = [list, ...(list ? [...list.querySelectorAll('*')] : [])]
        .find((element) => element && element.scrollHeight > element.clientHeight + 4) || list?.parentElement;
      if (!scroller) return false;
      const before = scroller.scrollTop;
      scroller.scrollTop += Math.max(120, scroller.clientHeight * 0.8);
      return scroller.scrollTop !== before;
    }).catch(() => false);
    if (!moved) break;
    await page.waitForTimeout(120);
    matches = await findMatches();
  }
  if (matches.length !== 1) {
    await page.keyboard.press('Escape').catch(() => {});
    const sample = [...seen].slice(0, 12).join(' | ') || 'no options rendered';
    unresolved.push(workdayEntryManualRow('Languages', entryNumber, 'Language',
      matches.length ? 'Several exact language options are available.'
        : `No exact Workday language option matches the CV (options seen: ${sample}).`));
    return;
  }
  await matches[0].click({ timeout: 5_000 });
  const deadline = Date.now() + 5_000;
  do {
    control = panel.locator(selector);
    current = cleanFormText(await control.innerText().catch(() => ''));
    if (normalizeFormQuestion(current) === normalizeFormQuestion(language)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  unresolved.push(workdayEntryManualRow('Languages', entryNumber, 'Language', 'The selected language did not remain committed.'));
}

async function fillWorkdayCvEntries(page, profile, progressLog, loggedSkips) {
  const definitions = [
    {
      section: 'Work Experience', sectionId: 'Work-Experience-section', heading: 'Work Experience',
      entries: cvExperienceEntries(profile).entries, kind: 'experience',
    },
    {
      section: 'Education', sectionId: 'Education-section', heading: 'Education',
      entries: cvEducationEntries(profile), kind: 'education',
    },
    {
      section: 'Languages', sectionId: 'Languages-section', heading: 'Languages',
      entries: cvLanguageLevels(profile).map(([language, level]) => ({ language, level })), kind: 'language',
    },
  ];
  const experienceSkipped = cvExperienceEntries(profile).skipped;
  const educationSkipped = cvEducationData(profile).skipped;
  for (const [section, names] of [['Work Experience', experienceSkipped], ['Education', educationSkipped]]) {
    for (const name of names) {
      const key = `${section}:${name}`;
      if (loggedSkips.has(key)) continue;
      loggedSkips.add(key);
      const reason = section === 'Work Experience' ? 'does not use the exact "Title | Company" heading format'
        : 'is not a Master\'s or Bachelor\'s degree programme';
      progressLog?.(`[form] ${section} CV item "${name}" ${reason}; left for user review`);
    }
  }

  let changed = false;
  const unresolved = [];
  for (const definition of definitions) {
    if (!definition.entries.length) continue;
    const initial = await workdaySectionPanels(page, definition.sectionId);
    if (!initial.present || initial.panels.length) continue;
    for (let index = 0; index < definition.entries.length; index += 1) {
      const entry = definition.entries[index];
      const entryNumber = index + 1;
      const state = await workdaySectionPanels(page, definition.sectionId);
      const add = page.locator(`[role="group"][aria-labelledby="${cssAttributeValue(definition.sectionId)}"] [data-automation-id="add-button"]`);
      if (await add.count().catch(() => 0) !== 1) {
        unresolved.push(workdayEntryManualRow(definition.section, entryNumber, 'Entry', 'The section does not have one exact Add button.'));
        break;
      }
      const unsafeSubmit = await add.evaluate((element) => (element.type || '').toLowerCase() === 'submit' && Boolean(element.form)).catch(() => true);
      if (unsafeSubmit) {
        unresolved.push(workdayEntryManualRow(definition.section, entryNumber, 'Entry', 'The section Add button is a submit control and was not clicked.'));
        break;
      }
      progressLog?.(`[form] adding ${definition.section} ${entryNumber} from cv.md through its own Add button`);
      await assertNotFinal(add);
      await add.click({ timeout: 5_000 });
      const created = await waitForWorkdayEntryPanel(page, definition.sectionId, state.panels.map((panel) => panel.key), definition.heading);
      if (!created) {
        unresolved.push(workdayEntryManualRow(definition.section, entryNumber, 'Entry', 'Workday did not render a new entry panel after Add.'));
        break;
      }
      changed = true;
      const entryName = definition.kind === 'experience' ? `${entry.title} | ${entry.company}`
        : definition.kind === 'education' ? entry.school : entry.language;
      progressLog?.(`[form] added ${created.title} (${entryName}) from cv.md`);
      const panel = page.locator(`[role="group"][aria-labelledby="${cssAttributeValue(created.key)}"]`);
      if (definition.kind === 'experience') {
        await fillWorkdayEntryText(panel, 'input[id$="--jobTitle"]', entry.title, definition.section, entryNumber, 'Job Title', unresolved);
        await fillWorkdayEntryText(panel, 'input[id$="--companyName"]', entry.company, definition.section, entryNumber, 'Company', unresolved);
        await fillWorkdayEntryText(panel, 'textarea[id$="--roleDescription"]', entry.description, definition.section, entryNumber, 'Role Description', unresolved);
        if (entry.start) await fillWorkdayEntryDate(panel, 'startDate', entry.start, definition.section, entryNumber, 'Start Date', unresolved);
        else unresolved.push(workdayEntryManualRow(definition.section, entryNumber, 'Start Date', 'The CV date line does not contain an exact supported date.'));
        if (entry.current) {
          const current = panel.locator('input[type="checkbox"][id$="--currentlyWorkHere"]');
          if (await current.count().catch(() => 0) === 1) {
            await current.check({ timeout: 5_000 }).catch(() => {});
            if (!await current.isChecked().catch(() => false)) unresolved.push(workdayEntryManualRow(definition.section, entryNumber, 'I currently work here', 'The current-work checkbox did not remain checked.'));
          } else unresolved.push(workdayEntryManualRow(definition.section, entryNumber, 'I currently work here', 'The new Workday entry does not have one current-work checkbox.'));
        } else if (entry.end) await fillWorkdayEntryDate(panel, 'endDate', entry.end, definition.section, entryNumber, 'End Date', unresolved);
        else unresolved.push(workdayEntryManualRow(definition.section, entryNumber, 'End Date', 'The CV date line does not contain an exact supported end date.'));
      } else if (definition.kind === 'education') {
        await fillWorkdayEntryText(panel, 'input[id$="--schoolName"]', entry.school, definition.section, entryNumber, 'School Name', unresolved);
        if (entry.firstYear) await fillWorkdayEntryDate(panel, 'firstYearAttended', { year: entry.firstYear }, definition.section, entryNumber, 'First Year Attended', unresolved);
        else unresolved.push(workdayEntryManualRow(definition.section, entryNumber, 'First Year Attended', 'The CV does not provide an exact start year.'));
        if (entry.lastYear) await fillWorkdayEntryDate(panel, 'lastYearAttended', { year: entry.lastYear }, definition.section, entryNumber, 'Last Year Attended', unresolved);
        else unresolved.push(workdayEntryManualRow(definition.section, entryNumber, 'Last Year Attended', 'The CV end year or configured expected graduation year is unavailable.'));
      } else {
        await chooseWorkdayEntryLanguage(page, panel, entry.language, entryNumber, unresolved);
      }
    }
  }
  return { changed, unresolved };
}

async function fillWorkdayWebsiteProfile(page, profile, pendingPanels, progressLog) {
  const targets = [
    ['LinkedIn', cleanFormText(profile?.candidate?.linkedin)],
    ['GitHub', cleanFormText(profile?.candidate?.github)],
  ].filter(([, value]) => value);
  if (!targets.length) return { changed: false, unresolved: [] };
  const sectionPresent = await page.evaluate(() => Boolean(document.querySelector('[role="group"][aria-labelledby="Websites-section"]')))
    .catch(() => false);
  if (!sectionPresent) return { changed: false, unresolved: [] };

  let changed = false;
  const unresolved = [];
  for (const [label, url] of targets) {
    const status = await page.evaluate((target) => {
      const section = document.querySelector('[role="group"][aria-labelledby="Websites-section"]');
      if (!section) return { present: false };
      const panels = [...section.querySelectorAll('[role="group"][aria-labelledby$="-panel"]')];
      const inputsFor = (panel) => [...panel.querySelectorAll('input')].filter((input) => {
        const label = (input.getAttribute('aria-label') || [...(input.labels || [])].map((item) => item.innerText).join(' ')
          || (input.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
            .map((id) => document.getElementById(id)?.textContent || '').join(' ')).replace(/\s+/g, ' ').trim();
        return label.replace(/\s*(?:\*|\(required\)|required).*$/i, '').trim().toLowerCase() === 'url';
      });
      if (panels.some((panel) => inputsFor(panel).some((input) => input.value === target))) {
        return { present: true, committed: true, panelCount: panels.length };
      }
      const headingFor = (panel) => (panel.getAttribute('aria-labelledby') || '').split(/\s+/)
        .filter(Boolean).map((id) => document.getElementById(id)?.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
      return { present: true, committed: false, panelCount: panels.length, panels: panels.map((panel) => ({
        key: panel.getAttribute('aria-labelledby') || '',
        heading: headingFor(panel),
        urlInputCount: inputsFor(panel).length,
      })) };
    }, url).catch(() => ({ present: false }));
    if (!status.present || status.committed) continue;

    if (!pendingPanels.has('__workdayCanAddFromEmpty')) {
      pendingPanels.set('__workdayCanAddFromEmpty', status.panelCount === 0);
    }
    if (!pendingPanels.get('__workdayCanAddFromEmpty')) {
      unresolved.push({
        fieldId: `workday-website-${label.toLowerCase()}`, stableFieldId: `website:${label.toLowerCase()}`,
        label: `${label} website URL`, category: 'identity_contact', semantic: label.toLowerCase(),
        reason: 'The Websites section already has an entry panel; RoleForge did not add a duplicate.',
        manualActionRequired: true,
      });
      continue;
    }

    let panelKey = pendingPanels.get(url) || '';
    if (!panelKey || !status.panels.some((panel) => panel.key === panelKey)) {
      const section = page.locator('[role="group"][aria-labelledby="Websites-section"]');
      const add = section.locator('[data-automation-id="add-button"]');
      if (await add.count() !== 1) {
        unresolved.push({
          fieldId: `workday-website-${label.toLowerCase()}`, stableFieldId: `website:${label.toLowerCase()}`,
          label: `${label} website could not be added automatically; add it in the Websites section before continuing`,
          category: 'identity_contact', semantic: label.toLowerCase(), reason: 'The Websites section did not have one exact Add button.',
          manualActionRequired: true,
        });
        continue;
      }
      const safe = await add.evaluate((element) => (element.type || '').toLowerCase() !== 'submit' || !element.form).catch(() => false);
      if (!safe) {
        unresolved.push({
          fieldId: `workday-website-${label.toLowerCase()}`, stableFieldId: `website:${label.toLowerCase()}`,
          label: `${label} website could not be added automatically; add it in the Websites section before continuing`,
          category: 'identity_contact', semantic: label.toLowerCase(), reason: 'The Websites Add control was a submit button.',
          manualActionRequired: true,
        });
        continue;
      }
      const knownPanelKeys = new Set(status.panels.map((panel) => panel.key));
      progressLog?.(`[form] adding ${label} through the Websites section's own Add button`);
      await assertNotFinal(add);
      await add.click({ timeout: 5_000 });
      const deadline = Date.now() + 10_000;
      do {
        const nextPanel = await page.evaluate(({ knownKeys }) => {
          const section = document.querySelector('[role="group"][aria-labelledby="Websites-section"]');
          if (!section) return null;
          for (const panel of section.querySelectorAll('[role="group"][aria-labelledby$="-panel"]')) {
            const key = panel.getAttribute('aria-labelledby') || '';
            const title = key.split(/\s+/).filter(Boolean)
              .map((id) => document.getElementById(id)?.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
            if (!knownKeys.includes(key) && /^Websites\s+\d+$/i.test(title)) return { key, title };
          }
          return null;
        }, { knownKeys: [...knownPanelKeys] }).catch(() => null);
        if (nextPanel) {
          panelKey = nextPanel.key;
          pendingPanels.set(url, panelKey);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      if (!panelKey) {
        unresolved.push({
          fieldId: `workday-website-${label.toLowerCase()}`, stableFieldId: `website:${label.toLowerCase()}`,
          label: `${label} website panel did not appear; add it in the Websites section before continuing`,
          category: 'identity_contact', semantic: label.toLowerCase(), reason: 'Workday did not render a new Websites N entry panel after Add.',
          manualActionRequired: true,
        });
        continue;
      }
    }

    const panel = page.locator(`[role="group"][aria-labelledby="${cssAttributeValue(panelKey)}"]`);
    const urlInput = panel.getByLabel(/^URL\b/i);
    const inputDeadline = Date.now() + 10_000;
    let filled = false;
    do {
      const count = await urlInput.count().catch(() => 0);
      if (count === 1) {
        const existing = await urlInput.inputValue().catch(() => '');
        if (existing === url) {
          filled = true;
          break;
        }
        if (existing) break;
        await urlInput.fill(url, { timeout: 3_000 }).catch(() => {});
        const committed = await page.evaluate(({ key, target }) => {
          const panels = [...document.querySelectorAll('[role="group"][aria-labelledby$="-panel"]')]
            .filter((item) => item.getAttribute('aria-labelledby') === key);
          const inputs = panels.flatMap((item) => [...item.querySelectorAll('input')].filter((input) => {
            const label = (input.getAttribute('aria-label') || [...(input.labels || [])].map((node) => node.innerText).join(' ')
              || (input.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
                .map((id) => document.getElementById(id)?.textContent || '').join(' ')).replace(/\s+/g, ' ').trim();
            return label.replace(/\s*(?:\*|\(required\)|required).*$/i, '').trim().toLowerCase() === 'url';
          }));
          return panels.length === 1 && inputs.length === 1 && inputs[0].value === target;
        }, { key: panelKey, target: url }).catch(() => false);
        if (committed) {
          filled = true;
          changed = true;
          pendingPanels.delete(url);
          progressLog?.(`[form] committed ${label} website in its new Workday Websites panel`);
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    } while (Date.now() < inputDeadline);
    if (!filled) {
      unresolved.push({
        fieldId: `workday-website-${label.toLowerCase()}`, stableFieldId: `website:${label.toLowerCase()}`,
        label: `${label} website did not remain committed; fill it in the Websites section before continuing`,
        category: 'identity_contact', semantic: label.toLowerCase(), reason: 'The new Websites URL input did not retain the exact profile value.',
        manualActionRequired: true,
      });
    }
  }
  return { changed, unresolved };
}

async function attachmentVerified(page, artifact) {
  const names = [...new Set([artifact.intendedFilename, basename(artifact.resolvedPath)].filter(Boolean))];
  if (await openModal(page)) return false;
  return page.evaluate((expected) => {
    const inputs = [...document.querySelectorAll('input[type="file"]')]
      .some((input) => [...(input.files || [])].some((file) => expected.includes(file.name)));
    const shown = expected.some((name) => (document.body.innerText || '').includes(name));
    return inputs || shown;
  }, names);
}

// The file an input already holds, or the ATS lists next to it, when it is not the bound document. Checked on the
// actual chooser/dialog input right before every trigger upload, since setFiles replaces whatever was selected.
async function differentAttachment(handle, artifact) {
  if (!handle) return null;
  const expected = [...new Set([artifact.intendedFilename, basename(artifact.resolvedPath)].filter(Boolean))];
  return handle.evaluate((input, expected) => {
    // Exact names only: "Old CV.pdf" is a different file from a bound "CV.pdf".
    const same = (name) => expected.includes(name) || expected.some((item) => name === `(ambiguous attachment) ${item}`);
    const held = [...(input.files || [])].map((file) => file.name);
    let shown = [];
    // Files an ATS lists next to an upload control. Read per visible text node: a node that is a file name, or a name
    // followed only by an upload status, gives that exact name; any other mention of a file is unreadable. In a
    // container shared by several file inputs, a name inside another control's own area belongs to that control; any
    // other listed name cannot be tied to one control and is ambiguous. Unreadable/ambiguous names never equal the
    // bound file, so the upload is withheld for review.
    // Text-node visibility from its own rects (display:contents wrappers have none, their text does);
    // display:contents elements are transparent like inline ones.
    const textShown = (item) => {
      const range = document.createRange();
      range.selectNodeContents(item);
      return range.getClientRects().length > 0;
    };
    const inlineLike = (element) => {
      const display = getComputedStyle(element).display;
      return display.startsWith('inline') || display === 'contents';
    };
    const namesIn = (root, skip = [], used = new Set()) => {
      // Text nodes are first joined into tokens: adjacent nodes in the same block element that touch without whitespace
      // (<span>Archived_</span><span>CV.pdf</span>) form one token, so a name is always read whole.
      const blockOf = (element) => {
        let node = element;
        while (node.parentElement && node !== root && inlineLike(node)) node = node.parentElement;
        return node;
      };
      const tokens = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let item = walker.nextNode(); item; item = walker.nextNode()) {
        const parent = item.parentElement;
        if (!parent || parent.closest('script, style, template') || !textShown(item)) continue;
        if (skip.some((region) => region.contains(parent))) continue;
        const raw = item.textContent || '';
        const block = blockOf(parent);
        const last = tokens[tokens.length - 1];
        if (last && last.block === block && /\S$/.test(last.raw) && /^\S/.test(raw)) {
          last.raw += raw;
          last.items.push(item);
          last.listed = last.listed || Boolean(parent.closest('[data-automation-id="file-upload-item-name"]'));
        } else {
          tokens.push({ raw, block, items: [item], listed: Boolean(parent.closest('[data-automation-id="file-upload-item-name"]')) });
        }
      }
      // A token is a whole name only when it stands alone in its block: its nearest non-whitespace neighbours are block
      // elements, form controls (or areas holding them), another control's area, or nothing. Inline text beside it
      // ("<span>Archived </span><span>CV.pdf</span>") makes it a fragment, read as unreadable.
      const boundary = (node) => {
        if (!node) return true;
        if (node.nodeType === Node.TEXT_NODE) return !/\S/.test(node.textContent || '');
        if (node.nodeType !== Node.ELEMENT_NODE) return true;
        if (skip.some((region) => region === node || region.contains(node) || node.contains(region))) return true;
        if (node.matches('input, textarea, select, button') || node.querySelector('input, textarea, select, button')) return true;
        if (!inlineLike(node)) return true;
        return !/\S/.test(node.textContent || '');
      };
      const neighbour = (node, block, forward) => {
        for (let current = node; current && current !== block; current = current.parentElement) {
          let sibling = forward ? current.nextSibling : current.previousSibling;
          // Whitespace, comments and empty inline elements are not neighbours (they never isolate a fragment).
          while (sibling && ((sibling.nodeType === Node.TEXT_NODE && !/\S/.test(sibling.textContent || ''))
            || (sibling.nodeType !== Node.TEXT_NODE && sibling.nodeType !== Node.ELEMENT_NODE)
            || (sibling.nodeType === Node.ELEMENT_NODE && inlineLike(sibling)
              && !/\S/.test(sibling.textContent || '') && !sibling.matches('input, textarea, select, button')
              && !sibling.querySelector('input, textarea, select, button')))) {
            sibling = forward ? sibling.nextSibling : sibling.previousSibling;
          }
          if (sibling) return sibling;
        }
        return null;
      };
      const isolated = (token) => boundary(neighbour(token.items[0], token.block, false))
        && boundary(neighbour(token.items[token.items.length - 1], token.block, true));
      const found = [];
      for (const token of tokens) {
        const text = token.raw.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        // A file name has a non-separator character right before the extension ("Old CV ().pdf") or a letter or digit in
        // its segment before it (spaces and dots allowed: "Old CV .pdf");
        // bare type hints (".pdf, .docx", "(.pdf)", "types: .pdf") do not.
        if (!token.listed && !/(?:[^\s,;:(\/]|(?:^|[,;:(\/])[^,;:(\/]*[\p{L}\p{N}][^,;:(\/]*)\.(?:pdf|docx?|rtf|odt|ott|txt|html?|pages|md|png|jpe?g|gif|tiff?|xlsx?|pptx?|zip)(?![\p{L}\p{N}])/iu.test(text)) continue;
        const lead = token.listed ? [text, text] : text.match(/^(.+\.(?:pdf|docx?|rtf|odt|ott|txt|html?|pages|md|png|jpe?g|gif|tiff?|xlsx?|pptx?|zip))(?:\s+(?:(?:was\s+)?(?:successfully\s+)?(?:uploaded|attached)(?:\s+successfully)?[.!]?))?$/i);
        found.push(lead && isolated(token) ? lead[1] : `(unreadable file name) ${text}`);
        for (const item of token.items) used.add(item);
      }
      return found;
    };
    // A file name split across elements (<span>Name</span><span>.pdf</span>) is caught on the joined text of the
    // visible text nodes; when the per-node reading found nothing, it is unreadable and withholds the upload.
    const joinedHasFile = (root, skip = [], used = new Set()) => {
      let joined = '';
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let item = walker.nextNode(); item; item = walker.nextNode()) {
        const parent = item.parentElement;
        if (!parent || parent.closest('script, style, template') || !textShown(item)) continue;
        if (skip.some((region) => region.contains(parent)) || used.has(item)) continue;
        joined += item.textContent || '';
      }
      return /(?:[^\s,;:(\/]|(?:^|[,;:(\/])[^,;:(\/]*[\p{L}\p{N}][^,;:(\/]*)\.(?:pdf|docx?|rtf|odt|ott|txt|html?|pages|md|png|jpe?g|gif|tiff?|xlsx?|pptx?|zip)(?![\p{L}\p{N}])/iu.test(joined);
    };
    const regionOf = (other, top) => {
      let region = other;
      while (region.parentElement && region.parentElement !== top
        && region.parentElement.querySelectorAll('input[type="file"]').length === 1) region = region.parentElement;
      return region;
    };
    const listedNames = (input) => {
      for (let node = input.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) {
        const inputs = [...node.querySelectorAll('input[type="file"]')];
        if (inputs.length > 1) {
          const others = inputs.filter((other) => other !== input);
          const regions = others.map((other) => regionOf(other, node));
          // A shared-area name that another input actually holds (e.g. RoleForge's own CV upload) belongs to it.
          const heldElsewhere = new Set(others.flatMap((other) => [...(other.files || [])].map((file) => file.name)));
          const used = new Set();
          const sharedNames = namesIn(node, regions, used).filter((name) => !heldElsewhere.has(name));
          const split = joinedHasFile(node, regions, used) ? ['(unreadable file name)'] : [];
          return [...new Set([...sharedNames, ...split].map((name) => `(ambiguous attachment) ${name}`))];
        }
        const used = new Set();
        const names = [...namesIn(node, [], used), ...(joinedHasFile(node, [], used) ? ['(unreadable file name)'] : [])];
        if (names.length) return [...new Set(names)];
        if (node.matches('[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"]')) break;
      }
      return [];
    };
    if (!(input.multiple && held.length === 0)) shown = listedNames(input);
    return [...held, ...shown].find((name) => !same(name)) || null;
  }, expected).catch(() => null);
}

function withheldUpload(doc, name) {
  return {
    status: 'withheld',
    reason: `A different file is already attached here (${name}); RoleForge did not replace it. Review it; the bound file is ${doc.artifact.resolvedPath}`,
  };
}

export async function uploadThroughTrigger(page, doc, { applicationFormId = null, timeoutMs = 15000 } = {}) {
  const triggerIds = await page.evaluate(stampUploadTriggers, {
    semantic: doc.semantic, applicationFormId, finalTokenSource: FINAL_TOKEN.source, finalTokenFlags: FINAL_TOKEN.flags,
  });
  if (!triggerIds.length) return { status: 'no_trigger' };
  const path = doc.artifact.resolvedPath;
  for (const triggerId of triggerIds) {
    await page.evaluate(() => document.querySelectorAll('input[type="file"]')
      .forEach((input) => input.setAttribute('data-career-ops-preexisting-file', '1')));
    let chooser = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
    const clicked = await page.locator(`[data-career-ops-upload-trigger="${triggerId}"]`).click({ timeout: 5000 })
      .then(() => true, () => false);
    if (!clicked) continue;
    let fileChooser = await chooser;
    let attached = false;
    if (fileChooser) {
      const other = await differentAttachment(fileChooser.element(), doc.artifact);
      if (other) {
        if (await openModal(page)) await page.keyboard.press('Escape').catch(() => null);
        return withheldUpload(doc, other);
      }
      await fileChooser.setFiles(path);
      attached = true;
    } else {
      const modal = await openModal(page);
      const scope = modal || page.locator('body');
      const inputs = modal
        ? modal.locator('input[type="file"]')
        : page.locator('input[type="file"]:not([data-career-ops-preexisting-file])');
      if (await inputs.count() === 1) {
        const other = await differentAttachment(await inputs.elementHandle(), doc.artifact);
        if (other) {
          if (modal) await page.keyboard.press('Escape').catch(() => null);
          return withheldUpload(doc, other);
        }
        await inputs.setInputFiles(path);
        attached = true;
      } else if (modal) {
        const browse = scope.locator('button, a, [role="button"], label, input[type="button"]')
          .filter({ hasText: /browse|choose|select|from (?:my )?(?:computer|device)|upload|lataa|valitse/i });
        if (await browse.count() >= 1) {
          chooser = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
          await browse.first().click({ timeout: 5000 }).catch(() => null);
          fileChooser = await chooser;
          const other = fileChooser ? await differentAttachment(fileChooser.element(), doc.artifact) : null;
          if (other) {
            await page.keyboard.press('Escape').catch(() => null);
            return withheldUpload(doc, other);
          }
          if (fileChooser) {
            await fileChooser.setFiles(path);
            attached = true;
          }
        }
      }
    }
    if (!attached) {
      const modal = await openModal(page);
      if (modal) await page.keyboard.press('Escape').catch(() => null);
      continue;
    }
    // Upload dialogs often need their own Upload/OK button; never anything that reads as a final action.
    const modal = await openModal(page);
    if (modal) {
      const confirm = modal.locator('button, [role="button"], input[type="button"], a')
        .filter({ hasText: /^\s*(?:upload|attach|ok|done|save|add|lataa|tallenna)(?: (?:file|document|attachment))?\s*$/i });
      if (await confirm.count() >= 1) await confirm.last().click({ timeout: 5000 }).catch(() => null);
    }
    const deadline = Date.now() + Math.min(timeoutMs, 10000);
    while (Date.now() < deadline) {
      if (await attachmentVerified(page, doc.artifact)) return { status: 'uploaded' };
      await page.waitForTimeout(250);
    }
    return { status: 'unverified', reason: `${DOCUMENT_LABEL[doc.semantic]} was given to the upload control but the page never showed it as attached.` };
  }
  return { status: 'failed', reason: `${DOCUMENT_LABEL[doc.semantic]} upload control did not open a file chooser or upload dialog.` };
}

function documentUploaded(uploads = [], doc) {
  return uploads.some((upload) => upload?.sha256 === doc.artifact.sha256 || upload?.semantic === 'single_document_upload');
}

async function uploadPendingDocuments(page, plan, artifacts, aggregate, applicationFormId) {
  const planned = new Set(plan.actions.filter((action) => action.action === 'upload').map((action) => action.artifact.sha256));
  for (const doc of expectedDocuments(artifacts, plan.uploadTopology)) {
    if (planned.has(doc.artifact.sha256) || documentUploaded(aggregate.uploadedArtifacts, doc)) continue;
    // A document the plan withheld (different file already attached, or manual) is never uploaded through a trigger.
    if (plan.unresolvedFields.some((row) => row.manualUploadPath === doc.artifact.resolvedPath
      || (row.category === 'file_upload' && row.semantic === doc.semantic))) continue;
    let result;
    try {
      result = await uploadThroughTrigger(page, doc, { applicationFormId });
    } catch (error) {
      result = { status: 'failed', reason: cleanFormText(error.message) };
    }
    if (result.status === 'no_trigger') continue;
    if (result.status !== 'uploaded') {
      aggregate.unresolvedFields.push(manualUploadRow(doc, result.reason));
      continue;
    }
    aggregate.uploadedArtifacts.push({
      semantic: doc.semantic, filename: doc.artifact.intendedFilename, sha256: doc.artifact.sha256, preserved: false,
    });
    aggregate.completed.push({
      fieldId: `upload-${doc.semantic}`, stableFieldId: `upload:${doc.semantic}`, category: 'file_upload',
      semantic: doc.semantic, valueHash: doc.artifact.sha256, preserved: false,
    });
  }
}

async function withinAttemptDeadline(operation, {
  timeoutMs,
  sessionBound,
}) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(sessionBound
            ? 'Whole form-filling session time limit reached.'
            : 'Field attempt time limit reached.');
          error.code = sessionBound ? 'FORM_SESSION_TIMEOUT' : 'FIELD_ATTEMPT_TIMEOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function executeOperationalFormPlanGuarded(page, plan, {
  previousEvidence = null,
  now = () => new Date(),
  clock = () => Date.now(),
  limits = DEFAULT_LIVE_FORM_LIMITS,
  sessionDeadlineMs = null,
  performActionImpl = performAction,
} = {}) {
  const effectiveLimits = resolveOperationalFormLimits({}, limits);
  const hardDeadlineMs = sessionDeadlineMs ?? (clock() + effectiveLimits.sessionMs);
  const completed = [...(plan.preservedFields || [])];
  const uploadedArtifacts = [...(plan.preservedUploads || [])];
  const committedSelections = [];
  const fieldOutcomes = [];
  const optionalSkips = [];
  const unresolvedFields = [];
  const priorLedger = Array.isArray(previousEvidence?.attemptLedger) ? previousEvidence.attemptLedger : [];
  const attemptLedger = [...priorLedger];

  let sessionLimitReached = false;
  let gate = null;
  for (let actionIndex = 0; actionIndex < plan.actions.length; actionIndex += 1) {
    const action = { ...plan.actions[actionIndex], plannedFieldIds: plan.plannedFieldIds
      || [...plan.actions, ...(plan.preservedFields || []), ...(plan.unresolvedFields || [])].map((row) => row.fieldId) };
    gate = await inspectLiveHumanGate(page, 'field_filling');
    if (gate) break;
    if (classifyHumanOnlyField(action)) {
      unresolvedFields.push({ fieldId: action.fieldId, stableFieldId: action.stableFieldId,
        category: action.category, semantic: action.semantic, label: action.label,
        reason: 'Credential or challenge field requires the human.', manualActionRequired: true });
      continue;
    }
    if (clock() >= hardDeadlineMs) {
      sessionLimitReached = true;
      for (const pending of plan.actions.slice(actionIndex)) {
        unresolvedFields.push({
          fieldId: pending.fieldId,
          stableFieldId: pending.stableFieldId,
          label: pending.label,
          category: pending.category,
          semantic: pending.semantic,
          reason: 'Whole form-filling session time limit reached.',
          manualActionRequired: true,
        });
      }
      break;
    }
    const visibleOptions = [];
    let success = false;
    let skipped = false;
    let lastReason = null;
    for (let attempt = 1; attempt <= effectiveLimits.maxAttempts; attempt += 1) {
      gate = await inspectLiveHumanGate(page, 'field_filling');
      if (gate) break;
      const attemptedAt = now().toISOString();
      try {
        const sessionRemainingMs = Math.max(0, hardDeadlineMs - clock());
        if (sessionRemainingMs <= 0) {
          const error = new Error('Whole form-filling session time limit reached.');
          error.code = 'FORM_SESSION_TIMEOUT';
          throw error;
        }
        const actionLimitMs = actionAttemptLimitMs(action, effectiveLimits);
        const timeoutMs = Math.min(sessionRemainingMs, actionLimitMs);
        const sessionBound = sessionRemainingMs <= actionLimitMs;
        const attemptDeadlineMs = clock() + timeoutMs;
        const committedValue = await withinAttemptDeadline(
          () => performActionImpl(page, action, visibleOptions, { deadlineMs: attemptDeadlineMs, clock }),
          { timeoutMs, sessionBound },
        );
        if (clock() > hardDeadlineMs) {
          const error = new Error('Whole form-filling session time limit reached.');
          error.code = 'FORM_SESSION_TIMEOUT';
          throw error;
        }
        const completedAt = now().toISOString();
        attemptLedger.push({
          batchId: cleanFormText(action.batchId) || null,
          candidateId: cleanFormText(action.candidateId) || null,
          formFingerprint: plan.formFingerprint || null,
          stableFieldId: action.stableFieldId,
          category: action.category,
          semantic: action.semantic,
          attemptedValueHash: action.valueHash || action.artifact?.sha256,
          attemptCount: attempt,
          success: true,
          committedValue: action.category === 'custom_motivation_experience_narrative' ? null : cleanFormText(committedValue),
          committedValueHash: action.valueHash || action.artifact?.sha256,
          validationEvidence: 'live control remained committed after blur/rerender verification',
          visibleOptions: [...new Set(visibleOptions)],
          attemptedAt,
          completedAt,
          retryReason: lastReason,
          manualActionRequired: false,
        });
        completed.push({
          fieldId: action.fieldId,
          stableFieldId: action.stableFieldId,
          category: action.category,
          semantic: action.semantic,
          valueHash: action.valueHash || action.artifact?.sha256,
          preserved: false,
        });
        fieldOutcomes.push({
          fieldId: action.fieldId,
          value: action.action === 'upload' ? 'file attached' : cleanFormText(action.value),
        });
        if (action.action === 'upload') {
          uploadedArtifacts.push({
            semantic: action.semantic,
            filename: action.artifact.intendedFilename,
            sha256: action.artifact.sha256,
            preserved: false,
          });
        } else if (['select', 'autocomplete', 'check', 'radio'].includes(action.action)) {
          committedSelections.push({
            semantic: action.semantic,
            valueHash: action.valueHash,
            label: action.category === 'custom_motivation_experience_narrative' ? null : cleanFormText(committedValue),
          });
        }
        success = true;
        break;
      } catch (error) {
        gate = await inspectLiveHumanGate(page, 'field_filling');
        if (gate) break;
        const timeoutCode = clock() >= hardDeadlineMs ? 'FORM_SESSION_TIMEOUT' : error.code;
        sessionLimitReached = timeoutCode === 'FORM_SESSION_TIMEOUT';
        lastReason = timeoutCode === 'FORM_SESSION_TIMEOUT'
          ? 'Whole form-filling session time limit reached.'
          : timeoutCode === 'FIELD_ATTEMPT_TIMEOUT'
            ? 'Field attempt time limit reached.'
            : cleanFormText(error.message);
        if (error.code === 'OPTIONAL_SKILL_NO_EXACT_OPTION') {
          optionalSkips.push({ fieldId: action.fieldId, value: action.value, reason: 'no exact option' });
          skipped = true;
          break;
        }
        attemptLedger.push({
          batchId: cleanFormText(action.batchId) || null,
          candidateId: cleanFormText(action.candidateId) || null,
          formFingerprint: plan.formFingerprint || null,
          stableFieldId: action.stableFieldId,
          category: action.category,
          semantic: action.semantic,
          attemptedValueHash: action.valueHash || action.artifact?.sha256,
          attemptCount: attempt,
          success: false,
          committedValue: null,
          committedValueHash: null,
          validationEvidence: lastReason,
          visibleOptions: [...new Set(visibleOptions)],
          attemptedAt,
          completedAt: now().toISOString(),
          retryReason: !sessionLimitReached && attempt < effectiveLimits.maxAttempts ? lastReason : null,
          manualActionRequired: sessionLimitReached || attempt === effectiveLimits.maxAttempts,
          limitReached: timeoutCode || null,
        });
        if (sessionLimitReached) break;
      }
    }
    if (gate) break;
    if (!success && !skipped && action.pickKind === 'skill') {
      optionalSkips.push({ fieldId: action.fieldId, value: action.value, reason: 'could not add skill' });
    } else if (!success && !skipped) {
      unresolvedFields.push({
        fieldId: action.fieldId,
        stableFieldId: action.stableFieldId,
        label: action.label,
        category: action.category,
        semantic: action.semantic,
        reason: lastReason || 'Retry budget exhausted.',
        manualActionRequired: true,
        ...(action.action === 'upload' ? {
          reason: `${lastReason || 'Retry budget exhausted.'} Upload this exact file manually: ${action.artifact.resolvedPath}`,
          manualUploadPath: action.artifact.resolvedPath,
        } : {}),
      });
    }
    if (sessionLimitReached) {
      for (const pending of plan.actions.slice(actionIndex + 1)) {
        unresolvedFields.push({
          fieldId: pending.fieldId,
          stableFieldId: pending.stableFieldId,
          label: pending.label,
          category: pending.category,
          semantic: pending.semantic,
          reason: 'Whole form-filling session time limit reached.',
          manualActionRequired: true,
        });
      }
      break;
    }
  }
  gate ||= await inspectLiveHumanGate(page, 'field_filling');
  return {
    completed,
    uploadedArtifacts,
    committedSelections,
    unresolvedFields,
    fieldOutcomes,
    optionalSkips,
    attemptLedger,
    timeLimits: effectiveLimits,
    sessionLimitReached,
    ...(gate ? { gate } : {}),
  };
}

export async function executeOperationalFormPlan(page, plan, options = {}) {
  await installSubmissionGuard(page);
  try {
    return await executeOperationalFormPlanGuarded(page, plan, options);
  } finally {
    await removeOperationalSubmissionGuard(page);
  }
}

// A radio or checkbox carries its option value whether or not it is chosen; only checked counts as answered.
function fieldAnswered(field) {
  if (field.widget === 'selectinput') return (field.selectedItems || []).some((value) => cleanFormText(value));
  return ['radio', 'checkbox'].includes(String(field.type || '').toLowerCase())
    ? Boolean(field.checked)
    : Boolean(cleanFormText(field.value));
}

function requiredEmpty(field) {
  if (classifyFieldSemantics(field).semantic === 'workday_skills') return false;
  return field.visible !== false && field.required && !field.disabled
    && !(field.widget === 'selectinput' ? fieldAnswered(field) : cleanFormText(field.value) || field.checked)
    && !(field.files || []).length;
}

async function currentApplicationStepLabel(page, snapshot) {
  const heading = await page.evaluate(() => {
    const flow = document.querySelector('[data-automation-id="applyFlowPage"]')
      || document.querySelector('[data-career-ops-virtual-form]');
    const text = (element) => (element?.innerText || '').replace(/\s+/g, ' ').trim();
    const headings = [...(flow?.querySelectorAll('h1, h2, h3') || [])]
      .filter((element) => element.getClientRects().length && !element.closest('[data-automation-id="progressBar"]'))
      .map(text).filter(Boolean);
    if (headings.length) return headings[0];
    const active = text(flow?.querySelector('[data-automation-id="progressBarActiveStep"]'));
    return active.replace(/current step\s+\d+\s+of\s+\d+/i, '').trim();
  }).catch(() => '');
  const label = cleanFormText(heading || '');
  if (label) return label.replace(/[|\r\n]+/g, ' ').trim();
  return cleanFormText(snapshot?.stepIndicator?.text || 'Application Step').replace(/[|\r\n]+/g, ' ').trim();
}

function fieldLogValue(value) {
  const text = cleanFormText(value).replace(/[|\r\n]+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text || '(empty)';
}

function existingFieldLogValue(field) {
  if (String(field.type || '').toLowerCase() === 'file') {
    return (field.files || []).length || (field.attachedNames || []).length ? 'file attached' : '';
  }
  if (field.widget === 'selectinput') return (field.selectedItems || []).map(cleanFormText).filter(Boolean).join(', ');
  if (['checkbox', 'radio'].includes(String(field.type || '').toLowerCase())) {
    return field.checked ? cleanFormText(field.value) || 'checked' : '';
  }
  return cleanFormText(field.value);
}

function logApplicationFieldOutcomes(snapshot, plan, execution, reviewedEvidence, stepLabel, progressLog) {
  if (!progressLog || !snapshot.applicationFormId) return;
  const fields = (snapshot.fields || []).filter((field) => field.formId === snapshot.applicationFormId
    && field.applicationFormOwned !== false);
  for (const field of fields) {
    const label = workdayEntryFieldLabel(field).replace(/[|\r\n]+/g, ' ').trim()
      || field.fieldId;
    const fieldOutcomes = (execution.fieldOutcomes || []).filter((row) => row.fieldId === field.fieldId);
    const optionalSkips = (execution.optionalSkips || []).filter((row) => row.fieldId === field.fieldId);
    const unresolved = [
      ...(reviewedEvidence.unresolvedFields || []),
      ...(execution.unresolvedFields || []),
      ...(plan.unresolvedFields || []),
    ].find((row) => row.fieldId === field.fieldId);
    let status;
    if (fieldOutcomes.length) {
      const filled = [...new Set(fieldOutcomes.map((row) => cleanFormText(row.value)).filter(Boolean))];
      status = `filled: ${fieldLogValue(filled.join(', '))}`;
      if (optionalSkips.length) {
        status += `; skipped: no exact option (${fieldLogValue(optionalSkips.map((row) => row.value).join(', '))})`;
      }
    } else if (optionalSkips.length) {
      const reason = optionalSkips.every((row) => row.reason === 'no exact option')
        ? `no exact option (${optionalSkips.map((row) => row.value).join(', ')})`
        : `could not add skill (${optionalSkips.map((row) => row.value).join(', ')})`;
      status = `skipped: ${fieldLogValue(reason)}`;
    } else if (unresolved) {
      status = field.required || field.type === 'checkbox' && classifyFieldSemantics(field).category === 'legal_declaration'
        ? `manual: ${fieldLogValue(unresolved.reason || 'requires user review')}`
        : `skipped: ${fieldLogValue(unresolved.reason || 'optional field')}`;
    } else {
      const existing = existingFieldLogValue(field);
      if (existing) status = `kept: ${fieldLogValue(existing)}`;
      else if (field.disabled) status = 'skipped: disabled field';
      else if (field.required) status = 'manual: required field remains empty';
      else status = 'skipped: optional field';
    }
    progressLog(`[field] ${stepLabel} | ${label} | ${status}`);
  }
}

export async function reviewOperationalApplicationForm(page, profile, artifacts, execution, {
  context = {},
  previousEvidence = null,
  reasoningState = null,
  passId,
  resumeMode = 'initial',
} = {}) {
  const snapshot = await inspectOperationalApplicationForm(page);
  const submissionGuardActiveAtHandoff = await page.evaluate(
    () => Boolean(globalThis.__careerOpsOperationalGuard),
  ).catch(() => null);
  const plan = buildOperationalFormPlan(snapshot, profile, artifacts, {
    context,
    previousEvidence,
    semanticResolutions: reasoningState?.semanticResolutions,
  });
  const applicationFields = snapshot.fields.filter((field) => snapshot.applicationFormId
    && field.formId === snapshot.applicationFormId && field.applicationFormOwned !== false);
  const requiredMissing = applicationFields.filter(requiredEmpty).map((field) => {
    const semantics = classifyFieldSemantics(field);
    return manualField(field, semantics, 'Required field remains empty.');
  });
  const unresolvedFields = dedupeRows([
    ...plan.unresolvedFields,
    ...(execution.unresolvedFields || []),
    ...requiredMissing,
  ]);
  const finalAction = {
    detected: plan.finalActions.length > 0,
    label: plan.finalActions.map((item) => item.label).join(' | ') || null,
    semanticClass: plan.finalActions.map((item) => item.semanticClass).join(' | ') || null,
    activated: snapshot.submitAttempts > 0,
  };
  const answerRecords = mergeAnswerRecords(
    mergeAnswerRecords(previousEvidence?.answerRecords || [], execution.answerRecords || []),
    plan.answerRecords || [],
  );
  const gate = humanGateOutcome(snapshot, 'form_review');
  const userActionRequired = Boolean(gate) || snapshot.loginGate || snapshot.captcha.manualActionRequired || unresolvedFields.length > 0;
  const semanticVerification = reasoningState?.semanticVerification || {
    disposition: 'not_required', triggerReasons: [], findings: [], requestDigest: null, responseDigest: null,
    repair: { attempted: false, outcome: 'not_attempted', resolutionKey: null },
  };
  const deterministicReviewComplete = !userActionRequired && !snapshot.validationErrors.length
    && finalAction.detected && !finalAction.activated;
  const evidence = sanitizePersistedUrls({
    schemaVersion: 3,
    passId,
    resumeMode,
    inspectedAt: new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
    currentUrl: sanitizeUrl(snapshot.url),
    formFingerprint: digest(applicationFields.map((field) => ({
      stableFieldId: stableFieldIdentity(field, classifyFieldSemantics(field)),
      label: fieldQuestion(field),
      type: field.type,
      required: field.required,
    }))),
    requiredFieldCount: applicationFields.filter((field) => field.visible !== false && field.required).length,
    filledFields: execution.completed || [],
    committedSelections: execution.committedSelections || [],
    uploadedArtifacts: [...new Map((execution.uploadedArtifacts || []).map((upload) =>
      [[upload.semantic, upload.sha256, upload.filename].join('|'), upload])).values()],
    unresolvedFields,
    validationErrors: snapshot.validationErrors,
    attemptLedger: execution.attemptLedger || previousEvidence?.attemptLedger || [],
    answerRecords: answerRecords.map(({ stableFieldId, ...row }) => row),
    userActionRequired,
    browserOpenRequired: userActionRequired,
    captcha: snapshot.captcha,
    finalAction,
    uploadTopology: plan.uploadTopology,
    passBudget: {
      fullPassesUsed: 1,
      fullPassesAllowed: 1,
      artifactRevisionReset: Boolean(previousEvidence?.passBudget?.artifactRevisionReset),
      controlledResumeUsed: resumeMode === 'initial'
        ? 0
        : Number(previousEvidence?.passBudget?.controlledResumeUsed || 0) + 1,
      controlledResumeAllowed: MAX_CONTROLLED_RESUMES,
      perFieldAttemptsAllowed: MAX_FIELD_ATTEMPTS,
      timeLimits: execution.timeLimits || DEFAULT_LIVE_FORM_LIMITS,
      sessionLimitReached: Boolean(execution.sessionLimitReached),
      precomputedNarrativeCount: Number(execution.precomputedNarrativeCount || 0),
    },
    browserSession: {
      ownership: 'task_created',
      manualContinuation: resumeMode !== 'process_recovery',
      processRecovery: resumeMode === 'process_recovery',
      keepOpenRequired: userActionRequired,
    },
    operationalArtifacts: {
      screenshotBefore: null,
      screenshotAfter: null,
      uploadTopologyBefore: null,
      uploadTopologyAfter: plan.uploadTopology,
      submissionGuardActiveAtHandoff,
      phoneControls: applicationFields
        .map((field) => ({ field, semantics: classifyFieldSemantics(field) }))
        .filter(({ field, semantics }) => field.type === 'tel' || ['phone', 'phone_country', 'phone_dial_code'].includes(semantics.semantic))
        .map(({ field, semantics }) => ({
          fieldId: field.fieldId,
          id: field.id,
          name: field.name,
          tag: field.tag,
          type: field.type,
          role: field.role,
          label: field.label,
          groupLabel: field.groupLabel,
          questionText: field.questionText,
          semantic: semantics.semantic,
          value: field.value,
          selectedLabel: field.selectedLabel,
        })),
    },
    reasoning: reasoningState ? reasoningEvidence(reasoningState) : {
      schemaVersion: 1,
      provider: null,
      model: null,
      calls: { fallback: 0, verifier: 0, total: 0 },
      limits: { fallbackCalls: 3, verifierCalls: 1, totalCalls: 4, repairCycles: 1, timeoutMs: 15000 },
      semanticResolutions: [],
      rejectedResolutions: [],
      preparedAnswerSummary: [],
    },
    semanticVerification: structuredClone(semanticVerification),
    deterministicReviewComplete,
    reviewComplete: deterministicReviewComplete
      && ['not_required', 'passed'].includes(semanticVerification.disposition),
  });
  evidence.evidenceHash = digest(evidence);
  return { snapshot, plan, evidence, ...(gate ? { gate } : {}) };
}

export function attachOperationalArtifacts(preparation, artifacts = {}) {
  const evidence = sanitizePersistedUrls({
    ...preparation.evidence,
    operationalArtifacts: {
      ...preparation.evidence.operationalArtifacts,
      ...artifacts,
    },
  });
  evidence.evidenceHash = digest({ ...evidence, evidenceHash: undefined });
  return { ...preparation, evidence };
}

async function resolvePlanAmbiguitiesWithReasoning(plan, snapshot, profile, context, reasoningState) {
  if (!(plan.reasoningCandidates || []).length) return false;
  if (!reasoningState.provider) {
    for (const candidate of plan.reasoningCandidates) {
      reasoningState.rejectedResolutions.push({
        resolutionKey: candidate.resolutionKey,
        kind: candidate.kind,
        reasonCode: 'provider_unavailable',
      });
    }
    return false;
  }
  try {
    const request = createSemanticReasoningRequest(plan.reasoningCandidates);
    const raw = await boundedProviderCall(reasoningState.provider, 'annotate', request, reasoningState);
    const accepted = validateSemanticAnnotationResponse(raw, request, {
      providerIdentity: reasoningState.providerIdentity,
      profile,
    });
    reasoningState.semanticResolutions = mergeResolutionLedger(reasoningState.semanticResolutions, accepted);
    for (const entry of accepted) {
      reasoningState.riskReasons.add(entry.kind === 'option_mapping'
        ? 'nontrivial_option_mapping'
        : entry.kind === 'narrative_routing'
          ? 'narrative_semantic_fallback'
          : 'semantic_fallback_used');
    }
    return accepted.length > 0;
  } catch (error) {
    reasoningState.rejectedResolutions.push({
      resolutionKey: null,
      kind: 'batched_fallback',
      reasonCode: /budget is exhausted/.test(error.message) ? 'call_budget_exhausted' : 'provider_or_schema_failure',
      detailDigest: digest(cleanFormText(error.message)),
    });
    return false;
  }
}

function liveReasoningFields(snapshot, profile, context, semanticResolutions) {
  return snapshot.fields.filter((field) => snapshot.applicationFormId
    && field.formId === snapshot.applicationFormId && field.applicationFormOwned !== false
    && field.visible !== false && !field.disabled).map((field) => {
    const { semantics } = resolvedFieldSemantics(field, snapshot, context, semanticResolutions);
    let canonicalValue = null;
    try {
      canonicalValue = canonicalFieldValue(profile, semantics, { field, snapshot, context });
    } catch {}
    return publicLiveReasoningField(field, snapshot, context, profile, semantics, canonicalValue);
  });
}

async function runFinalSemanticVerifier(snapshot, profile, context, reasoningState) {
  const liveFields = liveReasoningFields(
    snapshot, profile, context, reasoningState.semanticResolutions,
  );
  let request;
  try {
    request = createSemanticVerifierRequest(reasoningState, liveFields);
  } catch (error) {
    const missingNarrativeText = /lacks transient text/.test(error.message);
    reasoningState.semanticVerification.disposition = 'review_required';
    reasoningState.semanticVerification.findings = [{
      code: missingNarrativeText ? 'transient_narrative_unavailable' : 'ambiguous_live_field_identity',
      resolutionKey: null,
      message: missingNarrativeText
        ? 'Semantic verification requires manual review because prior narrative text was not persisted.'
        : 'Semantic verification could not bind every live field uniquely.',
      detailDigest: digest(cleanFormText(error.message)), live: false, repair: null,
    }];
    return { repaired: false, reviewRequired: true };
  }
  reasoningState.semanticVerification.requestDigest = request.requestDigest;
  if (!reasoningState.provider) {
    reasoningState.semanticVerification.disposition = 'review_required';
    reasoningState.semanticVerification.findings = [{
      code: 'provider_unavailable', resolutionKey: null,
      message: 'Semantic verification was required but no configured reasoning provider was available.',
      live: false, repair: null,
    }];
    return { repaired: false, reviewRequired: true };
  }
  try {
    const raw = await boundedProviderCall(reasoningState.provider, 'verify', request, reasoningState);
    const result = validateSemanticVerifierResponse(raw, request);
    reasoningState.semanticVerification.responseDigest = result.responseDigest;
    reasoningState.semanticVerification.findings = result.findings;
    if (result.disposition === 'pass') {
      reasoningState.semanticVerification.disposition = 'passed';
      return { repaired: false, reviewRequired: false };
    }
    if (result.findings.length !== 1 || !result.findings[0].repair || !result.findings[0].live) {
      reasoningState.semanticVerification.disposition = 'review_required';
      return { repaired: false, reviewRequired: true };
    }
    if (reasoningState.semanticVerification.repair.attempted
        || reasoningState.limits.repairCycles < 1) {
      reasoningState.semanticVerification.disposition = 'review_required';
      reasoningState.semanticVerification.repair = {
        attempted: true, outcome: 'repair_budget_exhausted', resolutionKey: result.findings[0].resolutionKey,
      };
      return { repaired: false, reviewRequired: true };
    }
    const finding = result.findings[0];
    const liveField = snapshot.fields.find((field) => (
      fieldResolutionKey(field, snapshot.applicationFormId) === finding.resolutionKey
      && field.formId === snapshot.applicationFormId && field.visible !== false && !field.disabled
    ));
    if (!liveField) {
      reasoningState.semanticVerification.disposition = 'review_required';
      return { repaired: false, reviewRequired: true };
    }
    const currentSemantics = resolvedFieldSemantics(
      liveField, snapshot, context, reasoningState.semanticResolutions,
    ).semantics;
    let canonicalValue = null;
    try { canonicalValue = canonicalFieldValue(profile, currentSemantics, { field: liveField, snapshot, context }); } catch {}
    const repairCandidate = buildReasoningCandidate(liveField, snapshot, context, {
      kind: finding.repair.kind,
      reasonCode: 'final_semantic_verifier_repair',
      canonicalValue,
      profile,
    });
    const entry = makeRepairLedgerEntry(finding.repair, repairCandidate, request, reasoningState, profile);
    reasoningState.semanticResolutions = mergeResolutionLedger(reasoningState.semanticResolutions, [entry]);
    reasoningState.semanticVerification.repair = {
      attempted: true, outcome: 'accepted_pending_deterministic_execution', resolutionKey: finding.resolutionKey,
    };
    return { repaired: true, reviewRequired: false };
  } catch (error) {
    reasoningState.semanticVerification.disposition = 'review_required';
    reasoningState.semanticVerification.findings = [{
      code: /budget is exhausted/.test(error.message) ? 'call_budget_exhausted' : 'provider_or_schema_failure',
      resolutionKey: null,
      message: 'Semantic verification failed closed.',
      detailDigest: digest(cleanFormText(error.message)),
      live: false,
      repair: null,
    }];
    return { repaired: false, reviewRequired: true };
  }
}

export async function prepareOperationalApplicationForm(page, profile, artifacts, {
  context = {},
  previousEvidence = null,
  resumeMode = 'initial',
  passId = `pass-${Date.now()}`,
  limits = null,
  clock = () => Date.now(),
  performActionImpl = performAction,
  transitionTimeoutMs = DEFAULT_PROGRESSION_TRANSITION_MS,
  progressionSessionMs = DEFAULT_PROGRESSION_SESSION_MS,
  transitionStabilityMs = DEFAULT_PROGRESSION_STABILITY_MS,
  waitForTransitionImpl = waitForApplicationStateTransition,
  reasoningProvider = null,
  // Interactive runs: (labels) => Promise<boolean>. Lists the fields RoleForge cannot fill and resolves true once the
  // user has filled them in the browser (Enter), so the step is re-checked and progression continues.
  awaitManualFields = null,
  // Interactive runs: (line) => void. Live log of the detected step, the progression control and each transition.
  progressLog = null,
  // Save the live page before RoleForge activates an intermediate progression control. Failures are ignored.
  onBeforeProgression = null,
} = {}) {
  const effectiveLimits = resolveOperationalFormLimits(profile, limits || {});
  let sessionDeadlineMs = clock() + effectiveLimits.sessionMs;
  const currentArtifactHashes = new Set([
    artifacts?.cv?.sha256,
    artifacts?.coverLetter?.sha256,
    artifacts?.combinedDocument?.sha256,
  ].filter(Boolean));
  const priorUploads = Array.isArray(previousEvidence?.uploadedArtifacts) ? previousEvidence.uploadedArtifacts : [];
  const newlyBoundCombinedDocument = Boolean(
    artifacts?.combinedDocument?.sha256
    && previousEvidence?.uploadTopology?.mode === 'single_combined'
    && !priorUploads.some((upload) => upload?.sha256 === artifacts.combinedDocument.sha256),
  );
  const artifactSetChanged = newlyBoundCombinedDocument
    || priorUploads.some((upload) => upload?.sha256 && !currentArtifactHashes.has(upload.sha256));
  const effectivePreviousEvidence = artifactSetChanged
    ? {
      ...previousEvidence,
      uploadedArtifacts: priorUploads.filter((upload) => currentArtifactHashes.has(upload?.sha256)),
      passBudget: {
        ...(previousEvidence?.passBudget || {}),
        controlledResumeUsed: 0,
        artifactRevisionReset: true,
      },
    }
    : previousEvidence;
  const reasoningState = createReasoningState(profile, reasoningProvider, effectivePreviousEvidence);
  // The resume budget bounds unattended retries. In a supervised run (awaitManualFields: a person at the terminal
  // presses Enter for every resume) the person is the bound.
  if (resumeMode !== 'initial' && !awaitManualFields
      && Number(effectivePreviousEvidence?.passBudget?.controlledResumeUsed || 0) >= MAX_CONTROLLED_RESUMES) {
    const snapshot = await inspectOperationalApplicationForm(page);
    reasoningState.semanticVerification.disposition = 'review_required';
    reasoningState.semanticVerification.findings = [{
      code: 'controlled_resume_budget_exhausted',
      resolutionKey: null,
      message: 'Candidate-wide controlled resume budget is exhausted.',
      live: false,
      repair: null,
    }];
    const evidence = sanitizePersistedUrls({
      ...effectivePreviousEvidence,
      schemaVersion: 3,
      passId,
      resumeMode,
      reviewedAt: new Date().toISOString(),
      currentUrl: sanitizeUrl(snapshot.url),
      unresolvedFields: dedupeRows([
        ...(effectivePreviousEvidence.unresolvedFields || []),
        {
          fieldId: 'form',
          stableFieldId: 'form',
          category: 'unknown',
          semantic: 'retry_budget',
          reason: 'Candidate-wide controlled resume budget is exhausted.',
          manualActionRequired: true,
        },
      ]),
      userActionRequired: true,
      browserOpenRequired: true,
      reasoning: reasoningEvidence(reasoningState),
      semanticVerification: structuredClone(reasoningState.semanticVerification),
      deterministicReviewComplete: false,
      reviewComplete: false,
    });
    evidence.evidenceHash = digest({ ...evidence, evidenceHash: undefined });
    const humanGate = humanGateOutcome(snapshot, 'form_review');
    return {
      snapshot,
      plan: { actions: [], unresolvedFields: evidence.unresolvedFields, finalActions: [], uploadTopology: effectivePreviousEvidence.uploadTopology },
      evidence,
      gate: humanGate || { state: 'review_required', reason: 'Controlled resume budget is exhausted; finish unresolved fields manually.' },
    };
  }

  const priorProgression = effectivePreviousEvidence?.progression || {};
  const progression = {
    stepsAdvanced: Number(priorProgression.stepsAdvanced || 0),
    transitions: [...(priorProgression.transitions || [])],
    visitedFingerprints: [...(priorProgression.visitedFingerprints || [])],
    maxTransitions: MAX_PROGRESSION_TRANSITIONS,
    transitionTimeoutMs,
    deadlineReached: false,
  };
  // History of earlier passes is kept; the limit of 8 applies to the step changes of this pass.
  const stepsAtPassStart = progression.stepsAdvanced;
  const visited = new Set();
  const historicalVisited = new Set(progression.visitedFingerprints);
  let manualWaits = 0;
  const acknowledgedConflicts = new Set();
  const stepCommitted = new Set();
  // Live runs wait for Workday to finish loading a step; tests that pass transitionStabilityMs: 0 skip it.
  const settleQuietMs = transitionStabilityMs >= DEFAULT_PROGRESSION_STABILITY_MS ? 1_500 : 0;
  let settleRetries = 0;
  let progressionDeadlineMs = Math.min(sessionDeadlineMs, clock() + Math.min(progressionSessionMs, effectiveLimits.sessionMs));
  const uploadedThisPass = new Set();
  const pendingWebsitePanels = new Map();
  const loggedCvEntrySkips = new Set();
  const aggregate = {
    completed: [], uploadedArtifacts: [...(effectivePreviousEvidence?.uploadedArtifacts || [])], committedSelections: [], unresolvedFields: [],
    answerRecords: [],
    attemptLedger: effectivePreviousEvidence?.attemptLedger || [],
    timeLimits: effectiveLimits, sessionLimitReached: false, precomputedNarrativeCount: 0,
  };
  const applicationIdentity = digest({
    batchId: context.batchId || null,
    candidateId: context.candidate?.candidate_id || context.candidate?.candidateId || null,
  });
  let outcome;
  await installSubmissionGuard(page);
  try {
    while (true) {
      const snapshot = await inspectOperationalApplicationForm(page);
      const stateFingerprint = applicationFormStateFingerprint(snapshot);
      if (visited.has(stateFingerprint)) {
        outcome = {
          gate: { state: 'review_required', reason: 'Application form-state loop detected; progression stopped safely.' },
          snapshot,
        };
        break;
      }
      visited.add(stateFingerprint);
      progression.visitedFingerprints = [...new Set([...historicalVisited, ...visited])];

      const gate = humanGateOutcome(snapshot, 'form_inspection');
      if (gate) {
        outcome = { gate, snapshot };
        break;
      }

      const reparse = await reparseBoundWorkdayResume(page, artifacts?.cv, uploadedThisPass, progressLog);
      if (reparse.changed) {
        visited.delete(stateFingerprint);
        continue;
      }
      const cvEntryFill = await fillWorkdayCvEntries(page, profile, progressLog, loggedCvEntrySkips);
      aggregate.unresolvedFields.push(...cvEntryFill.unresolved);
      if (cvEntryFill.changed) {
        visited.delete(stateFingerprint);
        continue;
      }
      const websiteFill = await fillWorkdayWebsiteProfile(page, profile, pendingWebsitePanels, progressLog);
      if (websiteFill.changed && !websiteFill.unresolved.length) {
        visited.delete(stateFingerprint);
        continue;
      }

      let plan = buildOperationalFormPlan(snapshot, profile, artifacts, {
        context,
        previousEvidence: effectivePreviousEvidence,
        semanticResolutions: reasoningState.semanticResolutions,
        userCorrectionGuard: stepCommitted,
      });
      const reasoningChangedPlan = await resolvePlanAmbiguitiesWithReasoning(
        plan, snapshot, profile, context, reasoningState,
      );
      if (reasoningChangedPlan) {
        plan = buildOperationalFormPlan(snapshot, profile, artifacts, {
          context,
          previousEvidence: effectivePreviousEvidence,
          semanticResolutions: reasoningState.semanticResolutions,
          userCorrectionGuard: stepCommitted,
        });
      }
      if (reparse.unresolved) plan.unresolvedFields.push(reparse.unresolved);
      plan.unresolvedFields.push(...websiteFill.unresolved);
      const transientWorkdayUnresolved = [reparse.unresolved, ...websiteFill.unresolved]
        .filter(Boolean).map((row) => ({ ...row, transientWorkday: true }));
      aggregate.unresolvedFields.push(...transientWorkdayUnresolved);
      const applicationFields = snapshot.fields.filter((field) => snapshot.applicationFormId
        && field.formId === snapshot.applicationFormId && field.applicationFormOwned !== false);
      plan.formFingerprint = digest(applicationFields.map((field) => stableFieldIdentity(field, classifyFieldSemantics(field))));
      plan.actions = plan.actions.map((action) => ({
        ...action,
        batchId: context.batchId || null,
        candidateId: context.candidate?.candidate_id || null,
      }));
      const ledgerBefore = aggregate.attemptLedger.length;
      const execution = await executeOperationalFormPlanGuarded(page, plan, {
        previousEvidence: { ...effectivePreviousEvidence, attemptLedger: aggregate.attemptLedger },
        clock,
        limits: effectiveLimits,
        sessionDeadlineMs,
        performActionImpl,
      });
      execution.precomputedNarrativeCount = plan.answerRecords.length;
      for (const key of ['completed', 'uploadedArtifacts', 'committedSelections', 'unresolvedFields']) {
        aggregate[key].push(...(execution[key] || []));
      }
      for (const upload of execution.uploadedArtifacts || []) {
        if (upload.filename) uploadedThisPass.add(upload.filename);
      }
      aggregate.attemptLedger = execution.attemptLedger;
      for (const row of execution.attemptLedger.slice(ledgerBefore)) {
        if (row.success && row.stableFieldId && row.category !== 'file_upload') stepCommitted.add(row.stableFieldId);
      }
      aggregate.answerRecords = mergeAnswerRecords(aggregate.answerRecords, plan.answerRecords || []);
      aggregate.sessionLimitReached ||= execution.sessionLimitReached;
      aggregate.precomputedNarrativeCount += plan.answerRecords.length;
      if (execution.gate) {
        outcome = { gate: execution.gate, snapshot };
        break;
      }
      if (!execution.sessionLimitReached) {
        const uploadsBeforePending = aggregate.uploadedArtifacts.length;
        await uploadPendingDocuments(page, plan, artifacts, aggregate, snapshot.applicationFormId);
        for (const upload of aggregate.uploadedArtifacts.slice(uploadsBeforePending)) {
          if (upload.filename) uploadedThisPass.add(upload.filename);
        }
      }
      addPreparedAnswers(reasoningState, plan, plan.formFingerprint, snapshot);
      const triggerReasons = verifierTriggerReasons(reasoningState, plan, aggregate);
      reasoningState.riskReasons = new Set(triggerReasons);
      reasoningState.semanticVerification.triggerReasons = triggerReasons;
      reasoningState.semanticVerification.disposition = triggerReasons.length ? 'pending' : 'not_required';

      const reviewed = await reviewOperationalApplicationForm(page, profile, artifacts, aggregate, {
        context, previousEvidence: effectivePreviousEvidence, reasoningState, passId, resumeMode,
      });
      reviewed.evidence.progression = { ...progression, progressionSubmits: reviewed.snapshot.progressionSubmits || 0 };
      reviewed.evidence.evidenceHash = digest({ ...reviewed.evidence, evidenceHash: undefined });
      const currentSnapshot = reviewed.snapshot;
      const currentPlan = reviewed.plan;
      const stepLabel = await currentApplicationStepLabel(page, currentSnapshot);
      logApplicationFieldOutcomes(currentSnapshot, plan, execution, reviewed.evidence, stepLabel, progressLog);
      const currentApplicationFields = currentSnapshot.fields.filter((field) => currentSnapshot.applicationFormId
        && field.formId === currentSnapshot.applicationFormId && field.applicationFormOwned !== false);
      const legalConsentCheckbox = (field) => field.type === 'checkbox'
        && classifyFieldSemantics(field).category === 'legal_declaration';
      const consentOnlyStep = currentApplicationFields.length > 0 && currentApplicationFields.every(legalConsentCheckbox);
      const reviewGate = humanGateOutcome(currentSnapshot, 'form_review');
      if (reviewGate) {
        outcome = { ...reviewed, gate: reviewGate };
        break;
      }
      const currentStateFingerprint = applicationFormStateFingerprint(currentSnapshot);
      const staleProgressionMutation = plan.progressionActions.find((oldControl) => {
        const liveControl = currentSnapshot.controls.find((item) => item.controlId === oldControl.controlId);
        return !liveControl
          || classifyApplicationControl(liveControl) !== 'progression'
          || JSON.stringify(applicationControlSignature(liveControl)) !== JSON.stringify(applicationControlSignature(oldControl));
      });

      if (reviewed.evidence.captcha.manualActionRequired) {
        outcome = { ...reviewed, gate: { state: 'review_required', reason: `CAPTCHA requires manual completion (${reviewed.evidence.captcha.classification}).` } };
        break;
      }
      // A document with no upload control on this step ("upload:*", e.g. a cover letter) is settled at the end of the
      // flow and never blocks moving to the next step.
      // A differing selection the user has already been shown at a pause is the user's choice (kept, never replaced).
      const blockingUnresolved = reviewed.evidence.unresolvedFields
        .filter((row) => !String(row.stableFieldId || '').startsWith('upload:'))
        .filter((row) => !(row.existingValue && acknowledgedConflicts.has(row.stableFieldId)))
        // An optional field RoleForge could not fill exactly (e.g. Field of Study without an exact option) never blocks.
        .filter((row) => {
          const field = (currentSnapshot.fields || []).find((item) => item.fieldId === row.fieldId);
          if (field && classifyFieldSemantics(field).semantic === 'workday_skills') return false;
          return !field || field.required || consentOnlyStep && legalConsentCheckbox(field);
        });
      // A form that momentarily fails verification is a page still rendering (Workday after an upload or sign-in):
      // re-inspect the settled page before treating anything as unresolved.
      if (blockingUnresolved.some((row) => row.fieldId === 'application-form-unverified')
          && settleRetries < 15 && clock() < progressionDeadlineMs) {
        settleRetries += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        visited.delete(stateFingerprint);
        continue;
      }
      if ((blockingUnresolved.length || reviewed.evidence.validationErrors.length) && awaitManualFields && manualWaits < 12) {
        manualWaits += 1;
        const waitStarted = clock();
        const labels = [];
        const seenManualLabels = new Set();
        const consentCheckboxes = consentOnlyStep
          ? currentApplicationFields.filter((field) => legalConsentCheckbox(field) && !field.checked)
          : [];
        const manualLabels = consentCheckboxes.length
          ? [`Consent: ${consentCheckboxes.map((field) => fieldQuestion(field) || 'legal checkbox').join('; ')} - this is yours to tick; then press Enter (RoleForge clicks Save and Continue) or finish yourself`,
            ...blockingUnresolved.filter((row) => !consentCheckboxes.some((field) => field.fieldId === row.fieldId))
              .map((row) => cleanFormText(row.label || row.semantic || row.fieldId))]
          : blockingUnresolved.map((row) => cleanFormText(row.label || row.semantic || row.fieldId)
            + (row.category === 'workday_entry_field' && row.reason ? ` (${cleanFormText(row.reason)})` : ''));
        for (const label of [
          ...manualLabels,
          ...reviewed.evidence.validationErrors.map((text) => `error: ${cleanFormText(text)}`),
        ]) {
          const key = normalizeFormQuestion(label);
          if (!key || seenManualLabels.has(key)) continue;
          seenManualLabels.add(key);
          labels.push(label);
        }
        if (await awaitManualFields(labels)) {
          const freshSnapshot = await inspectOperationalApplicationForm(page);
          const sameOrigin = isSameVerifiedApplicationOrigin(currentSnapshot.url, freshSnapshot.url);
          const continuity = typeof context.verifyApplicationContinuity === 'function'
            ? await context.verifyApplicationContinuity({
              beforeUrl: currentSnapshot.url, currentUrl: freshSnapshot.url,
              snapshot: freshSnapshot, candidate: context.candidate,
            })
            : { verified: currentSnapshot.url.split('#')[0] === freshSnapshot.url.split('#')[0] };
          // A page refresh (Workday "Something went wrong" -> F5) rebuilds the virtual form under a new id: the same
          // exact application (origin + requisition continuity) with a verified form is still the same application.
          if (!sameOrigin || !continuity?.verified || !currentSnapshot.applicationFormId
              || !freshSnapshot.applicationFormId) {
            outcome = { ...reviewed, gate: { state: 'review_required',
              reason: 'Application identity or verified form changed during manual completion; no further fields were filled.' } };
            break;
          }
          // Execution history remains in the attempt ledger. Only still-uncommitted fields belong in the handoff.
          // A bound document the user uploaded by hand shows as a Workday tile with its exact name; the input is gone.
          const shownFiles = new Set(await page.evaluate(() => [...document.querySelectorAll('[data-automation-id="file-upload-item-name"]')]
            .filter((element) => element.getClientRects().length > 0).map((element) => (element.textContent || '').trim()))
            .catch(() => []));
          for (const row of reviewed.evidence.unresolvedFields) if (row.existingValue) acknowledgedConflicts.add(row.stableFieldId);
          aggregate.unresolvedFields = aggregate.unresolvedFields.filter((row) => {
            // Rows about entries RoleForge added are re-derived from the live page by the next review.
            if (row.category === 'workday_entry_field') return false;
            if (row.transientWorkday) return false;
            if (row.category === 'file_upload' && row.manualUploadPath && shownFiles.has(basename(row.manualUploadPath))) return false;
            const matches = freshSnapshot.fields.filter((field) => field.formId === freshSnapshot.applicationFormId
              && (field.fieldId === row.fieldId || stableFieldIdentity(field) === row.stableFieldId));
            if (matches.length !== 1) return true;
            const field = matches[0];
            if (field.ariaInvalid) return true;
            if (field.workdayDateGroupId) {
              return !(field.workdayDateSegments || []).every((segment) => cleanFormText(segment.value)
                || !(field.workdayDateGroupRequired || segment.required));
            }
            return !fieldAnswered(field) && !(field.files || []).length;
          });
          const waited = clock() - waitStarted;
          sessionDeadlineMs += waited;
          progressionDeadlineMs += waited;
          visited.delete(stateFingerprint);
          continue;
        }
      }
      if (blockingUnresolved.length || reviewed.evidence.validationErrors.length) {
        outcome = { ...reviewed, gate: { state: 'review_required', reason: 'Controlled form preparation found unresolved or invalid fields; review is required.' } };
        break;
      }
      if (staleProgressionMutation) {
        outcome = { ...reviewed, gate: { state: 'review_required', reason: 'A progression control changed after form filling; no control was activated.' } };
        break;
      }
      if (currentPlan.finalActions.length) {
        if (!reasoningState.riskReasons.size) {
          outcome = reviewed;
          break;
        }
        const verification = await runFinalSemanticVerifier(
          currentSnapshot, profile, context, reasoningState,
        );
        if (verification.reviewRequired) {
          const finalReview = await reviewOperationalApplicationForm(page, profile, artifacts, aggregate, {
            context, previousEvidence: effectivePreviousEvidence, reasoningState, passId, resumeMode,
          });
          outcome = {
            ...finalReview,
            gate: { state: 'review_required', reason: 'Semantic verification requires human review.' },
          };
          break;
        }
        if (!verification.repaired) {
          outcome = await reviewOperationalApplicationForm(page, profile, artifacts, aggregate, {
            context, previousEvidence: effectivePreviousEvidence, reasoningState, passId, resumeMode,
          });
          break;
        }

        const repairSnapshot = await inspectOperationalApplicationForm(page);
        const repairPlan = buildOperationalFormPlan(repairSnapshot, profile, artifacts, {
          context,
          previousEvidence: effectivePreviousEvidence,
          semanticResolutions: reasoningState.semanticResolutions,
        });
        const liveRepairKey = reasoningState.semanticVerification.repair.resolutionKey;
        repairPlan.actions = repairPlan.actions.filter((action) => action.resolutionKey === liveRepairKey);
        repairPlan.formFingerprint = digest(repairSnapshot.fields
          .filter((field) => repairSnapshot.applicationFormId && field.formId === repairSnapshot.applicationFormId)
          .map((field) => stableFieldIdentity(field, classifyFieldSemantics(field))));
        repairPlan.actions = repairPlan.actions.map((action) => ({
          ...action,
          batchId: context.batchId || null,
          candidateId: context.candidate?.candidate_id || null,
        }));
        if (repairPlan.actions.length !== 1) {
          reasoningState.semanticVerification.disposition = 'review_required';
          reasoningState.semanticVerification.repair.outcome = 'no_unique_deterministic_repair_action';
          const finalReview = await reviewOperationalApplicationForm(page, profile, artifacts, aggregate, {
            context, previousEvidence: effectivePreviousEvidence, reasoningState, passId, resumeMode,
          });
          outcome = { ...finalReview, gate: { state: 'review_required', reason: 'Semantic repair could not compile to one live deterministic action.' } };
          break;
        }
        const repairExecution = await executeOperationalFormPlanGuarded(page, repairPlan, {
          previousEvidence: { ...effectivePreviousEvidence, attemptLedger: aggregate.attemptLedger },
          clock,
          limits: effectiveLimits,
          sessionDeadlineMs,
          performActionImpl,
        });
        for (const key of ['completed', 'uploadedArtifacts', 'committedSelections', 'unresolvedFields']) {
          aggregate[key].push(...(repairExecution[key] || []));
        }
        aggregate.attemptLedger = repairExecution.attemptLedger;
        if (repairExecution.gate) {
          outcome = { gate: repairExecution.gate, snapshot: repairSnapshot };
          break;
        }
        aggregate.answerRecords = mergeAnswerRecords(aggregate.answerRecords, repairPlan.answerRecords || []);
        addPreparedAnswers(reasoningState, repairPlan, repairPlan.formFingerprint, repairSnapshot);
        reasoningState.semanticVerification.repair.outcome = repairExecution.unresolvedFields.length
          ? 'deterministic_execution_failed'
          : 'executed_and_fresh_reviewed';
        reasoningState.semanticVerification.disposition = repairExecution.unresolvedFields.length
          ? 'review_required'
          : 'passed';
        const finalReview = await reviewOperationalApplicationForm(page, profile, artifacts, aggregate, {
          context, previousEvidence: effectivePreviousEvidence, reasoningState, passId, resumeMode,
        });
        if (repairExecution.unresolvedFields.length
            || finalReview.evidence.unresolvedFields.length
            || finalReview.evidence.validationErrors.length
            || !finalReview.evidence.deterministicReviewComplete) {
          reasoningState.semanticVerification.disposition = 'review_required';
          reasoningState.semanticVerification.repair.outcome = 'fresh_deterministic_review_failed';
          const failedReview = await reviewOperationalApplicationForm(page, profile, artifacts, aggregate, {
            context, previousEvidence: effectivePreviousEvidence, reasoningState, passId, resumeMode,
          });
          outcome = { ...failedReview, gate: { state: 'review_required', reason: 'Fresh deterministic review after semantic repair found unresolved or unsafe state.' } };
        } else {
          outcome = finalReview;
        }
        break;
      }
      // Beside exactly one verified progression control, only another continue/submit-like control is a real
      // ambiguity; "Delete <file>", "Back to Job Posting" and similar never compete with Continue.
      const controlText = (control) => cleanFormText(control.label || control.text || control.value);
      const competingAmbiguous = currentPlan.progressionActions.length === 1
        ? currentPlan.ambiguousActions.filter((control) => PROGRESSION_ACTION_LABEL.test(controlText(control))
          || /\b(?:next|continue|proceed|review|apply|submit|send|complete|finish|finali[sz]e|confirm)\b/i.test(controlText(control)))
        : currentPlan.ambiguousActions;
      if (competingAmbiguous.length || currentPlan.progressionActions.length !== 1) {
        // Client-rendered ATS pages (Workday) keep re-rendering right after an upload or a fill; a single snapshot can
        // catch Continue mid-render. Re-inspect the settled page before giving up.
        if (settleRetries < 15 && clock() < progressionDeadlineMs) {
          settleRetries += 1;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          visited.delete(stateFingerprint);
          continue;
        }
        const why = (control) => `${controlText(control)} [fields=${control.candidateFieldCount}, step=${
          control.stepIndicator ? `${control.stepIndicator.current}/${control.stepIndicator.total}` : 'none'}, workflow=${
          control.workflowVerified}, form=${control.formId || 'none'}/${control.applicationFormId || 'none'}, type=${control.type}]`;
        const reason = competingAmbiguous.length
          ? `Application progression control is ambiguous (${competingAmbiguous.map(why).join('; ')}); no control was activated.`
          : 'A unique verified progression control was not available; no control was activated.';
        outcome = { ...reviewed, gate: { state: 'review_required', reason } };
        break;
      }
      if (progression.stepsAdvanced - stepsAtPassStart >= MAX_PROGRESSION_TRANSITIONS) {
        outcome = { ...reviewed, gate: { state: 'review_required', reason: 'Maximum of 8 verified progression transitions reached; continue manually.' } };
        break;
      }
      if (clock() >= progressionDeadlineMs) {
        progression.deadlineReached = true;
        reviewed.evidence.progression = { ...progression, progressionSubmits: reviewed.snapshot.progressionSubmits || 0 };
        reviewed.evidence.evidenceHash = digest({ ...reviewed.evidence, evidenceHash: undefined });
        outcome = { ...reviewed, gate: { state: 'review_required', reason: 'Overall application progression deadline reached; continue manually.' } };
        break;
      }

      const control = currentPlan.progressionActions[0];
      const startedAt = clock();
      const liveStep = control.stepIndicator ? `${control.stepIndicator.current}/${control.stepIndicator.total}` : 'none';
      progressLog?.(`[form] step ${liveStep}: "${cleanFormText(control.label)}" classified ${classifyApplicationControl(control)}; clicking it`);
      try {
        await onBeforeProgression?.(page, stepLabel);
      } catch {
        // Evidence capture is best effort and never interrupts the application run.
      }
      try {
        await activateProgressionControl(page, control, {
          applicationIdentity,
          stateFingerprint: currentStateFingerprint,
          timeoutMs: Math.min(transitionTimeoutMs, Math.max(1, progressionDeadlineMs - clock())),
        });
      } catch (error) {
        outcome = { ...reviewed, gate: error.humanGate || { state: 'review_required', reason: `Progression control changed before safe activation: ${cleanFormText(error.message)}` } };
        break;
      }
      const transition = await waitForTransitionImpl(page, currentStateFingerprint, {
        timeoutMs: Math.min(transitionTimeoutMs, Math.max(1, progressionDeadlineMs - clock())),
        stabilityMs: transitionStabilityMs,
      });
      await clearProgressionPermit(page);
      const transitionGate = transition.snapshot && humanGateOutcome(transition.snapshot, 'form_progression');
      if (transitionGate) {
        if (!transition.timedOut && transition.fingerprint !== currentStateFingerprint) {
          progression.stepsAdvanced += 1;
          stepCommitted.clear();
          progression.transitions.push({
            controlId: control.controlId, label: control.label, before: currentStateFingerprint,
            after: transition.fingerprint, durationMs: transition.durationMs ?? Math.max(0, clock() - startedAt),
          });
        }
        outcome = { gate: transitionGate, snapshot: transition.snapshot };
        break;
      }
      progressLog?.(`[form] transition after "${cleanFormText(control.label)}": ${transition.timedOut ? 'timed out'
        : transition.fingerprint === currentStateFingerprint ? 'no change' : 'page changed'} in ${
        transition.durationMs ?? Math.max(0, clock() - startedAt)} ms`);
      if (transition.timedOut || transition.fingerprint === currentStateFingerprint) {
        outcome = { ...reviewed, gate: { state: 'review_required', reason: 'Progression activation produced no verified application-state transition.' } };
        break;
      }
      const continuity = typeof context.verifyApplicationContinuity === 'function'
        ? await context.verifyApplicationContinuity({
          beforeUrl: currentSnapshot.url,
          currentUrl: transition.snapshot?.url,
          snapshot: transition.snapshot,
          candidate: context.candidate,
        })
        : { verified: isSameVerifiedApplicationOrigin(currentSnapshot.url, transition.snapshot?.url), reason: 'origin-only fallback' };
      if (!continuity?.verified) {
        outcome = { ...reviewed, gate: { state: 'review_required', reason: `Application continuity check failed: ${cleanFormText(continuity?.reason || 'unverified application identity')}` } };
        break;
      }
      // Loops are detected within this pass. A restarted run legitimately re-walks steps an earlier pass visited.
      if (visited.has(transition.fingerprint)) {
        progression.transitions.push({
          controlId: control.controlId, label: control.label, before: currentStateFingerprint,
          after: transition.fingerprint, durationMs: transition.durationMs, loopDetected: true,
        });
        reviewed.evidence.progression = { ...progression, progressionSubmits: Number(reviewed.snapshot.progressionSubmits || 0) + 1 };
        reviewed.evidence.evidenceHash = digest({ ...reviewed.evidence, evidenceHash: undefined });
        outcome = { ...reviewed, gate: { state: 'review_required', reason: 'Application form-state loop detected after progression; stopped safely.' } };
        break;
      }
      progression.stepsAdvanced += 1;
      stepCommitted.clear();
      progression.transitions.push({
        controlId: control.controlId,
        label: control.label,
        before: currentStateFingerprint,
        after: transition.fingerprint,
        durationMs: transition.durationMs ?? Math.max(0, clock() - startedAt),
      });
      // The next step must finish loading its saved values before it is planned. Waiting for the ATS is not
      // RoleForge's working time, so it extends the deadlines like a manual pause does.
      const settleStarted = clock();
      await waitForSettledStep(page, { quietMs: settleQuietMs });
      sessionDeadlineMs += clock() - settleStarted;
      progressionDeadlineMs += clock() - settleStarted;
    }
  } finally {
    await clearProgressionPermit(page);
    await removeOperationalSubmissionGuard(page);
  }

  if (!outcome.evidence) {
    const reviewed = await reviewOperationalApplicationForm(page, profile, artifacts, aggregate, {
      context, previousEvidence: effectivePreviousEvidence, reasoningState, passId, resumeMode,
    });
    outcome = { ...reviewed, gate: outcome.gate };
  }
  // Final reviews can occur after asynchronous verification or repair. Their
  // fresh human-gate classification always takes precedence over review gates.
  const finalHumanGate = humanGateOutcome(outcome.snapshot, 'form_review');
  if (finalHumanGate) outcome.gate = outcome.gate?.state === 'human_action_required' ? outcome.gate : finalHumanGate;
  if (outcome.gate?.state === 'human_action_required') {
    outcome.humanAction = {
      candidate_id: context.candidate?.candidate_id || context.candidate?.candidateId || null,
      cause: outcome.gate.cause, stage: outcome.gate.stage,
      currentUrl: outcome.gate.currentUrl, timestamp: new Date().toISOString(),
      evidence: outcome.gate.evidence,
    };
    outcome.evidence.currentUrl = outcome.gate.currentUrl;
    outcome.evidence.userActionRequired = true;
    outcome.evidence.deterministicReviewComplete = false;
    outcome.evidence.reviewComplete = false;
  }
  if (outcome.gate?.state !== 'human_action_required') {
    // Expected documents are never skipped silently: anything not attached gets an explicit manual handoff.
    const letterPasted = outcome.evidence.filledFields.some((row) => row.semantic === 'cover_letter_text');
    const missing = expectedDocuments(artifacts, outcome.evidence.uploadTopology).filter((doc) => (
      !documentUploaded(outcome.evidence.uploadedArtifacts, doc)
      && !(doc.semantic === 'cover_letter_upload' && letterPasted)
      && !outcome.evidence.unresolvedFields.some((row) => row.category === 'file_upload' && row.semantic === doc.semantic)));
    if (missing.length) {
      outcome.evidence.unresolvedFields.push(...missing.map((doc) => manualUploadRow(doc,
        'Not attached: no upload control for this document was found on the form pages RoleForge reached.')));
      outcome.evidence.userActionRequired = true;
      outcome.evidence.deterministicReviewComplete = false;
      outcome.evidence.reviewComplete = false;
      outcome.gate ||= { state: 'review_required', reason: 'Bound application documents were not attached; upload them manually before submitting.' };
    }
  }
  outcome.evidence.progression = { ...progression, progressionSubmits: outcome.snapshot?.progressionSubmits || progression.stepsAdvanced };
  outcome.evidence.operationalArtifacts.submissionGuardActiveAtHandoff = false;
  outcome.evidence.browserOpenRequired = Boolean(outcome.gate) || outcome.evidence.userActionRequired;
  outcome.evidence.browserSession.keepOpenRequired = outcome.evidence.browserOpenRequired;
  if (outcome.gate) {
    outcome.evidence.reviewComplete = false;
    outcome.evidence.deterministicReviewComplete = false;
  }
  outcome.evidence = sanitizePersistedUrls(outcome.evidence);
  outcome.evidence.evidenceHash = digest({ ...outcome.evidence, evidenceHash: undefined });
  return outcome;
}

export {
  classifyCaptchaState,
  classifyFieldSemantics,
  classifyUserGate,
  isSemanticFinalAction,
};
