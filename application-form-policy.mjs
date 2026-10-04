import { createHash } from 'node:crypto';
import {
  createNarrativeProvenanceRecord,
  revalidateFactualEvidence,
  resolveConfiguredNarrativeEvidence,
  validateNarrativeProvenanceRecord,
} from './application-evidence.mjs';

const PLACEHOLDER_PATTERN = /(?:\[(?:tool|real project|related skill|[A-Z][A-Z0-9 _-]{1,40})\]|\{\{[^}]+\}\}|<[^>]*placeholder[^>]*>|\bTODO\b|\bTBD\b|template instructions?)/i;

export function cleanFormText(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function normalizeNarrativeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function narrativeReadyEvidenceText(value) {
  const lines = normalizeNarrativeText(value).replace(/\s+-\s+/g, '\n- ').split('\n');
  const prose = [];
  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = lines[index];
    if (!sourceLine) continue;
    if (/^#{1,6}\s+/.test(sourceLine)) continue;
    const bullet = /^[-*+]\s+(.+)$/.exec(sourceLine);
    let line = cleanFormText(bullet ? bullet[1] : sourceLine);
    if (!line) continue;
    if (!bullet && lines.slice(index + 1).some((item) => /^[-*+]\s+/.test(item)) && !/[.!?]$/.test(line)) continue;
    if (/\*\*|__|`|\[[^\]]+\]\([^)]+\)/.test(line)) {
      throw new Error('Factual evidence contains Markdown structure that is not narrative-ready');
    }
    if (/^(?:languages?|data and databases?|backend and apis?|machine learning|visualization and bi|tools and platforms?|frontend)\s*:/i.test(line)) {
      throw new Error('Factual evidence is a skills-section dump, not atomic narrative evidence');
    }
    if (bullet && /^(?:built|cleaned|validated|designed|added|created|implemented|developed|used|analy[sz]ed|deployed|tested|integrated|automated)\b/i.test(line)) {
      line = `I ${line[0].toLowerCase()}${line.slice(1)}`;
    }
    prose.push(line);
  }
  if (!prose.length) throw new Error('Factual evidence has no narrative-ready prose');
  return prose.join(' ');
}

export function normalizeFormQuestion(value) {
  return cleanFormText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function hashFormValue(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

export function containsUnresolvedPlaceholder(value) {
  return PLACEHOLDER_PATTERN.test(String(value ?? ''));
}

function fieldText(field) {
  return normalizeFormQuestion([
    field?.questionText,
    field?.groupLabel,
    field?.label,
    field?.name,
    field?.placeholder,
  ].filter(Boolean).join(' '));
}

function isNarrativeControl(field) {
  return field?.tag === 'textarea'
    || field?.type === 'textarea'
    || (field?.type === 'text' && Number(field?.maxLength || 0) >= 120);
}

export function classifyFieldSemantics(field = {}) {
  const text = fieldText(field);
  const type = cleanFormText(field.type).toLowerCase();
  const selectorShape = field.tag === 'select'
    || field.role === 'combobox'
    || field.autocomplete === 'list'
    || (field.options || []).length > 0;
  const optionText = (field.options || []).flatMap((option) => [option?.label, option?.value]).join(' ');
  if (field.type === 'file') {
    if (/cover|motivation|application letter|supporting statement/.test(text)) {
      return { category: 'file_upload', semantic: 'cover_letter_upload' };
    }
    if (/resume|curriculum vitae|\bcv\b/.test(text)) {
      return { category: 'file_upload', semantic: 'cv_upload' };
    }
    if (/application documents?|application materials?|cv (?:and|plus) cover|resume (?:and|plus) cover|combined application/.test(text)) {
      return { category: 'file_upload', semantic: 'single_document_upload' };
    }
    return { category: 'file_upload', semantic: 'unknown_upload' };
  }
  if (/marketing|newsletter|promotional|offers and updates|talent community|job alerts|future opportunities/.test(text)) {
    return { category: 'optional_marketing_consent', semantic: 'marketing_consent' };
  }
  if (/race|ethnicity|religion|disabilit|veteran|gender|sexual orientation|protected characteristic|diversity|eeo|equal employment/.test(text)) {
    return { category: 'demographic_eeo', semantic: 'eeo' };
  }
  if (/data (?:processing|protection|notice)|privacy (?:notice|policy|acknowledg|consent)|process my (?:personal )?data|gdpr/.test(text)) {
    return { category: 'privacy_data_processing_consent', semantic: 'privacy_processing' };
  }
  if (/certif|declare|signature|background check|truthful|information is accurate|terms and conditions|legal declaration/.test(text)) {
    return { category: 'legal_declaration', semantic: 'legal_declaration' };
  }
  if (/how did you hear|where did you hear|application source|referral source|source detail/.test(text)) {
    return { category: 'source_how_heard', semantic: 'application_source' };
  }
  if (/preferred (?:office |work )?location|location preference|which office|preferred city|office preference/.test(text)) {
    return { category: 'preferred_location', semantic: 'preferred_location' };
  }
  if (/sponsor|employer support|support from (?:the )?employer|immigration support|visa support|require.*(?:visa|permit)/.test(text)) {
    return { category: 'sponsorship_employer_support', semantic: 'sponsorship' };
  }
  if (/work authori[sz]|authori[sz]ed to work|eligible to work|right to work|legally authori[sz]/.test(text)) {
    return { category: 'work_authorization', semantic: 'work_authorization' };
  }
  if (/current location|where (?:are you|do you) (?:currently )?(?:live|located)|city and country|present location/.test(text)) {
    return { category: 'current_location', semantic: 'current_location' };
  }
  if (/\bcity\b|municipality/.test(text) && !/preferred|office|job location|role location/.test(text)) {
    return { category: 'current_location', semantic: 'city' };
  }
  if (/\bcountry\b/.test(text) && !/phone|dial|country code|preferred|office|job location|role location/.test(text)) {
    return { category: 'current_location', semantic: 'country' };
  }
  if (/(^| )location( |$)/.test(text) && !/job location|role location|office location/.test(text)) {
    return { category: 'current_location', semantic: 'current_location' };
  }
  if (/first ?name|given ?name/.test(text)) return { category: 'identity_contact', semantic: 'first_name' };
  if (/last ?name|family ?name|surname/.test(text)) return { category: 'identity_contact', semantic: 'last_name' };
  if (/full ?name|your name|candidate name/.test(text)) return { category: 'identity_contact', semantic: 'full_name' };
  if (/e ?mail/.test(text)) return { category: 'identity_contact', semantic: 'email' };
  if (type === 'tel') return { category: 'identity_contact', semantic: 'phone' };
  if (selectorShape && /dial(?:ing)? code|calling code|phone prefix|country prefix/.test(text)) {
    return { category: 'identity_contact', semantic: 'phone_dial_code' };
  }
  if (selectorShape && /phone country|country code/.test(text)) {
    return /\+\s*\d{1,4}/.test(optionText)
      ? { category: 'identity_contact', semantic: 'phone_dial_code' }
      : { category: 'identity_contact', semantic: 'phone_country' };
  }
  if (/phone|mobile|telephone/.test(text)) return { category: 'identity_contact', semantic: 'phone' };
  if (/linkedin/.test(text)) return { category: 'identity_contact', semantic: 'linkedin' };
  if (/github/.test(text)) return { category: 'identity_contact', semantic: 'github' };
  if (/portfolio|website|personal site/.test(text)) return { category: 'identity_contact', semantic: 'website' };
  if (/(?:enrolled|degree program).*(?:german university)|(?:german university).*(?:enrolled|degree program)/.test(text)) {
    return { category: 'education', semantic: 'german_university_enrollment' };
  }
  if (/university|school|institution/.test(text)) return { category: 'education', semantic: 'university' };
  if (/degree|qualification/.test(text)) return { category: 'education', semantic: 'degree' };
  if (/graduat/.test(text)) return { category: 'education', semantic: 'graduation' };
  if (/salary|compensation|pay expectation/.test(text)) return { category: 'salary', semantic: 'salary' };
  if (/available|start date|notice period/.test(text)) return { category: 'availability', semantic: 'availability' };
  if (/relocat/.test(text)) return { category: 'relocation', semantic: 'relocation' };
  if (isNarrativeControl(field) && /cover letter|motivation letter/.test(text)) {
    return { category: 'custom_motivation_experience_narrative', semantic: 'cover_letter_text' };
  }
  if (isNarrativeControl(field) && /why|motivat|good fit|experience|describe|tell us|project|technical problem|supporting statement|additional information|python|sql|analytics|data engineer|software|machine learning|\bai\b|cloud|api/.test(text)) {
    return { category: 'custom_motivation_experience_narrative', semantic: 'custom_narrative' };
  }
  return { category: 'unknown', semantic: 'unknown' };
}

export function stableFieldIdentity(field, semantics = classifyFieldSemantics(field)) {
  const basis = [
    cleanFormText(field?.id),
    cleanFormText(field?.name),
    normalizeFormQuestion(field?.questionText || field?.groupLabel || field?.label),
    cleanFormText(field?.type),
    semantics.category,
    semantics.semantic,
  ].join('|');
  return `field:${createHash('sha256').update(basis).digest('hex')}`;
}

function exactSavedAnswer(profile, question, candidateId, candidate) {
  const normalized = normalizeFormQuestion(question);
  const prior = Array.isArray(profile?.priorApprovedAnswers) ? profile.priorApprovedAnswers : [];
  const priorMatch = prior.find((row) => row.candidateId === candidateId
    && row.normalizedQuestion === normalized
    && row.answer
    && !containsUnresolvedPlaceholder(row.answer));
  if (!priorMatch) return null;
  const factualEvidence = validateNarrativeProvenanceRecord(profile, priorMatch, {
    candidateId,
    normalizedQuestion: normalized,
    answer: priorMatch.answer,
  });
  const expected = composeRoleFitNarrative(candidate, factualEvidence.map((item) => item.text), priorMatch.templateId);
  if (cleanFormText(priorMatch.answer) !== expected) throw new Error('Prior narrative answer no longer passes deterministic claim validation');
  return { answer: priorMatch.answer, factualEvidence, templateId: priorMatch.templateId, reused: true };
}

function requestedNarrativeTopics(question, jdText) {
  const questionText = normalizeFormQuestion(question);
  const roleText = normalizeFormQuestion(jdText);
  const requested = new Set();
  const add = (topic, pattern) => {
    if (pattern.test(questionText)) requested.add(topic);
  };
  add('data_engineering', /data engineer|analytics engineer|etl|pipeline|warehouse|data platform/);
  add('analytics', /analytics|business intelligence|\bbi\b|tableau|power bi|excel/);
  add('python_sql', /python|sql|postgres|database/);
  add('ai_ml', /machine learning|\bai\b|ml |deep learning|pytorch|transformer/);
  add('software_backend', /software|backend|api|cloud|platform|django/);
  add('motivation_fit', /why|motivat|good fit|supporting statement/);
  if (/why|motivat|good fit|supporting statement/.test(questionText)) {
    if (/data engineer|analytics|etl|warehouse|sql/.test(roleText)) requested.add('data_engineering');
    if (/machine learning|\bai\b|pytorch|model/.test(roleText)) requested.add('ai_ml');
    if (/software|backend|api|platform|python/.test(roleText)) requested.add('software_backend');
  }

  if (requested.size === 0) {
    if (/data engineer|analytics|etl|warehouse|sql/.test(roleText)) requested.add('data_engineering');
    if (/machine learning|\bai\b|pytorch|model/.test(roleText)) requested.add('ai_ml');
    if (/software|backend|api|platform|python/.test(roleText)) requested.add('software_backend');
  }
  if (requested.size === 0) requested.add('motivation_fit');
  return requested;
}

function fitSentences(sentences, maxLength) {
  if (!Number.isInteger(maxLength) || maxLength <= 0) return sentences.join(' ');
  const accepted = [];
  for (const sentence of sentences) {
    const candidate = [...accepted, sentence].join(' ');
    if (candidate.length <= maxLength) {
      accepted.push(sentence);
      continue;
    }
    if (accepted.length) break;
    throw new Error(`No complete factual sentence fits the field limit ${maxLength}`);
  }
  return accepted.join(' ');
}

function roleFitOpening(candidate = {}) {
  const role = cleanFormText(candidate.title);
  const company = cleanFormText(candidate.company);
  if (!role && !company) return null;
  return `For the ${role || 'role'}${company ? ` at ${company}` : ''}, my strongest fit is practical work that connects reliable implementation with clear validation.`;
}

function composeRoleFitNarrative(candidate, factualSentences, templateId = 'role-fit-v1') {
  const opening = templateId === 'role-fit-evidence-only-v1' ? null : roleFitOpening(candidate);
  return [opening, ...factualSentences.map(narrativeReadyEvidenceText)].filter(Boolean).join(' ');
}

export function validateGroundedNarrative(answer, profile, factualEvidence = [], { candidate = {}, templateId = 'role-fit-v1' } = {}) {
  const text = cleanFormText(answer);
  if (!text) throw new Error('Generated narrative answer is empty');
  if (containsUnresolvedPlaceholder(text)) throw new Error('Generated narrative answer contains an unresolved placeholder');
  const current = revalidateFactualEvidence(profile, factualEvidence);
  if (/\b(?:certified|certification|production owner|owned production|\d+\+? years? of professional experience)\b/i.test(text)) {
    throw new Error('Generated narrative contains an unsupported professional claim');
  }
  if (!['role-fit-v1', 'role-fit-evidence-only-v1'].includes(templateId)) throw new Error(`Unsupported narrative generation template: ${templateId}`);
  const expected = composeRoleFitNarrative(candidate, current.map((item) => item.text), templateId);
  if (text !== expected) throw new Error('Generated narrative contains wording not established by factual evidence or the approved neutral template');
  return text;
}

export function generateCustomNarrativeAnswer(profile, {
  question,
  candidate = {},
  jdText = '',
  maxLength = null,
  routing = null,
} = {}) {
  const candidateId = cleanFormText(candidate.candidate_id || candidate.candidateId);
  const normalizedQuestion = normalizeFormQuestion(question);
  if (!candidateId) throw new Error('Automatic narrative generation requires an exact candidate ID');
  if (!normalizedQuestion) throw new Error('Automatic narrative generation requires an exact normalized question');
  const saved = exactSavedAnswer(profile, question, candidateId, candidate);
  if (saved) {
    const answer = cleanFormText(saved.answer);
    if (Number(maxLength) > 0 && answer.length > Number(maxLength)) throw new Error(`Prior narrative answer exceeds field limit ${maxLength}`);
    const templateId = saved.templateId;
    const validated = validateGroundedNarrative(answer, profile, saved.factualEvidence, { candidate, templateId });
    const record = createNarrativeProvenanceRecord({
      candidateId, normalizedQuestion, answer: validated, wording: 'reused', templateId, factualEvidence: saved.factualEvidence,
    });
    return {
      ...record, answer: validated, reused: true,
    };
  }
  const allowedTemplates = new Set(['role-fit-v1', 'role-fit-evidence-only-v1']);
  const allowedTopics = new Set(['data_engineering', 'analytics', 'python_sql', 'ai_ml', 'software_backend', 'motivation_fit']);
  if (routing) {
    if (!allowedTemplates.has(routing.templateId)) throw new Error(`Unsupported narrative routing template: ${routing.templateId}`);
    if (!Array.isArray(routing.topicIds) || !routing.topicIds.length
        || routing.topicIds.some((topic) => !allowedTopics.has(topic))) {
      throw new Error('Narrative routing contains unsupported topics');
    }
    if (!Array.isArray(routing.evidenceIds) || !routing.evidenceIds.length) {
      throw new Error('Narrative routing has no approved evidence identities');
    }
  }
  const requested = routing
    ? new Set(routing.topicIds)
    : requestedNarrativeTopics(question, `${candidate.title || ''}\n${jdText}`);
  const routedEvidenceIds = routing ? new Set(routing.evidenceIds) : null;
  const resolvedEvidence = resolveConfiguredNarrativeEvidence(profile, requested);
  if (routedEvidenceIds) {
    for (const evidenceId of routedEvidenceIds) {
      if (!resolvedEvidence.some((entry) => entry.configuredEvidenceId === evidenceId)) {
        throw new Error(`Narrative routing evidence is stale or unavailable: ${evidenceId}`);
      }
    }
    if (!Array.isArray(routing.evidenceBindings) || !routing.evidenceBindings.length) {
      throw new Error('Narrative routing factual bindings are missing');
    }
    const currentBindings = resolvedEvidence
      .filter((entry) => routedEvidenceIds.has(entry.configuredEvidenceId))
      .map((entry) => ({
        configuredEvidenceId: entry.configuredEvidenceId,
        evidenceIdentity: entry.evidenceIdentity,
        evidenceHash: entry.evidenceHash,
        sourceHash: entry.sourceHash,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const acceptedBindings = routing.evidenceBindings
      .map((entry) => ({
        configuredEvidenceId: entry.configuredEvidenceId,
        evidenceIdentity: entry.evidenceIdentity,
        evidenceHash: entry.evidenceHash,
        sourceHash: entry.sourceHash,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    if (JSON.stringify(currentBindings) !== JSON.stringify(acceptedBindings)) {
      throw new Error('Narrative routing factual evidence is stale or mismatched');
    }
  }
  const selected = resolvedEvidence
    .filter((entry) => !routedEvidenceIds || routedEvidenceIds.has(entry.configuredEvidenceId))
    .flatMap((entry) => {
    try {
      return [{ ...entry, narrativeText: narrativeReadyEvidenceText(entry.text) }];
    } catch {
      return [];
    }
  });
  if (!selected.length) throw new Error('Configured factual evidence is not narrative-ready');
  let templateId = routing?.templateId || 'role-fit-v1';
  const sentences = [templateId === 'role-fit-evidence-only-v1' ? null : roleFitOpening(candidate), ...selected.map((entry) => entry.narrativeText)].filter(Boolean);
  let answer = fitSentences(sentences, Number(maxLength) || null);
  let included = selected.filter((entry) => answer.includes(entry.narrativeText));
  if (!included.length && Number(maxLength) > 0) {
    templateId = 'role-fit-evidence-only-v1';
    answer = fitSentences(selected.map((entry) => entry.narrativeText), Number(maxLength));
    included = selected.filter((entry) => answer.includes(entry.narrativeText));
  }
  if (!included.length) throw new Error('Generated narrative could not include a complete factual evidence sentence');
  const includedEvidence = included.map(({ narrativeText: _narrativeText, ...entry }) => entry);
  const validated = validateGroundedNarrative(answer, profile, includedEvidence, { candidate, templateId });
  if (Number(maxLength) > 0 && validated.length > Number(maxLength)) {
    throw new Error(`Generated narrative exceeds field limit ${maxLength}`);
  }
  const record = createNarrativeProvenanceRecord({
    candidateId, normalizedQuestion, answer: validated, wording: 'generated', templateId, factualEvidence: includedEvidence,
  });
  return { ...record, answer: validated, reused: false };
}

function formRules(profile) {
  const rules = profile?.formRules || {};
  const city = cleanFormText(rules.current_location?.city || profile?.location?.city);
  const country = cleanFormText(rules.current_location?.country || profile?.location?.country);
  const combined = cleanFormText(
    rules.current_location?.combined
      || profile?.candidate?.location
      || [city, country].filter(Boolean).join(', '),
  );
  return {
    currentLocation: { city: city || null, country: country || null, combined: combined || null },
    source: rules.source?.value || 'LinkedIn',
    homeCountry: cleanFormText(rules.work_authorization?.home_country || country) || null,
    phoneDialCode: cleanFormText(rules.phone?.dial_code) || null,
  };
}

function selectorShape(field = {}) {
  return field.tag === 'select'
    || field.role === 'combobox'
    || field.autocomplete === 'list'
    || (field.options || []).length > 0;
}

function pairedPhoneSelector(field, fields = []) {
  const group = normalizeFormQuestion(field.groupLabel);
  return fields.find((candidate) => {
    const semantics = classifyFieldSemantics(candidate);
    if (!['phone_country', 'phone_dial_code'].includes(semantics.semantic) || !selectorShape(candidate)) return false;
    const candidateGroup = normalizeFormQuestion(candidate.groupLabel);
    return Boolean(group && candidateGroup && group === candidateGroup)
      || (fields.filter((item) => classifyFieldSemantics(item).semantic === 'phone').length === 1
        && fields.filter((item) => ['phone_country', 'phone_dial_code'].includes(classifyFieldSemantics(item).semantic)).length === 1);
  }) || null;
}

export function validatePlannedValueForControl(field, semantics, value) {
  const normalized = semantics.category === 'custom_motivation_experience_narrative'
    ? normalizeNarrativeText(value)
    : cleanFormText(value);
  if (semantics.semantic === 'phone' && cleanFormText(field.type).toLowerCase() === 'tel'
      && /[A-Za-z]/.test(normalized)) {
    throw new Error('Telephone-number inputs cannot receive alphabetic country names');
  }
  if (['phone_country', 'phone_dial_code'].includes(semantics.semantic) && !selectorShape(field)) {
    throw new Error('Phone country/dial-code values require an explicit selector control');
  }
  if (semantics.semantic === 'phone_dial_code' && !/^\+?\d{1,4}$/.test(normalized.replace(/\s+/g, ''))) {
    throw new Error('Phone dial-code controls require an explicit numeric dial code');
  }
  return normalized;
}

function hasConfiguredCountryCapability(context, homeCountry) {
  const target = normalizeFormQuestion(homeCountry);
  if (!target) return false;
  return Object.entries(context || {}).some(([key, value]) => {
    if (value !== true || !key.startsWith('canEmployFrom')) return false;
    const suffix = key.slice('canEmployFrom'.length).replace(/([a-z])([A-Z])/g, '$1 $2');
    return normalizeFormQuestion(suffix) === target;
  });
}

function configuredUniversity(profile) {
  const explicit = cleanFormText(
    profile?.formRules?.education?.university
      || profile?.education?.university
      || profile?.currentStatus?.university,
  );
  if (explicit) return explicit;
  const summary = cleanFormText(profile?.currentStatus?.summary);
  const match = summary.match(/\b(?:at|from)\s+(.+?)(?:[.;]|$)/i);
  return cleanFormText(match?.[1]) || null;
}

export function resolveAuthorizationAnswer(profile, semantic, context = {}) {
  const rules = formRules(profile);
  const arrangement = normalizeFormQuestion(context.hiringArrangement);
  const country = cleanFormText(context.jobCountry);
  const normalizedHomeCountry = normalizeFormQuestion(rules.homeCountry);
  const remoteFromHomeCountry = Boolean(normalizedHomeCountry) && (
    arrangement === `remote ${normalizedHomeCountry}`
    || arrangement === `employ from ${normalizedHomeCountry}`
    || context.canEmployFromHomeCountry === true
    || hasConfiguredCountryCapability(context, rules.homeCountry)
  );
  const sameCountry = Boolean(country && normalizedHomeCountry)
    && normalizeFormQuestion(country) === normalizedHomeCountry;
  if (remoteFromHomeCountry || sameCountry) {
    return semantic === 'work_authorization' ? 'Yes' : semantic === 'sponsorship' ? 'No' : null;
  }
  if (country) return semantic === 'work_authorization' ? 'No' : semantic === 'sponsorship' ? 'Yes' : null;
  return null;
}

export function canonicalFieldValue(profile, semantics, {
  field = {},
  snapshot = { fields: [] },
  context = {},
} = {}) {
  const { category, semantic } = semantics;
  const rules = formRules(profile);
  const candidate = profile?.candidate || {};
  const fullName = cleanFormText(candidate.full_name);
  const nameParts = fullName.split(/\s+/).filter(Boolean);
  const identity = {
    first_name: nameParts[0] || null,
    last_name: nameParts.length > 1 ? nameParts.slice(1).join(' ') : null,
    full_name: fullName || null,
    email: candidate.email || null,
    phone: candidate.phone || null,
    phone_country: rules.homeCountry,
    phone_dial_code: rules.phoneDialCode || null,
    linkedin: candidate.linkedin || null,
    github: candidate.github || null,
  };
  if (category === 'identity_contact') {
    if (semantic === 'website') {
      if (candidate.portfolio_url) return candidate.portfolio_url;
      const distinctGithub = (snapshot.fields || []).some((item) => classifyFieldSemantics(item).semantic === 'github');
      return field.required && !candidate.portfolio_url && !distinctGithub ? candidate.github || null : null;
    }
    let value = identity[semantic] ?? null;
    if (semantic === 'phone' && pairedPhoneSelector(field, snapshot.fields)) {
      const dialCode = identity.phone_dial_code;
      if (dialCode) value = cleanFormText(value).replace(new RegExp(`^${dialCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s-]*`), '');
    }
    return value;
  }
  if (category === 'current_location') {
    if (semantic === 'city') return rules.currentLocation.city;
    if (semantic === 'country') return rules.currentLocation.country;
    return rules.currentLocation.combined;
  }
  if (category === 'work_authorization' || category === 'sponsorship_employer_support') {
    return resolveAuthorizationAnswer(profile, semantic, context);
  }
  if (category === 'source_how_heard') return rules.source;
  if (category === 'education') {
    if (semantic === 'university') return configuredUniversity(profile);
    if (semantic === 'graduation') return profile?.education?.expected_graduation_date || null;
    return null;
  }
  if (category === 'salary') return profile?.compensation?.target_range || null;
  if (category === 'availability') return profile?.currentStatus?.availability?.start || null;
  if (category === 'relocation') {
    return cleanFormText(profile?.formRules?.relocation?.value) || null;
  }
  return null;
}

export function preferredDeclineOption(options = []) {
  const labels = options.flatMap((option) => [cleanFormText(option?.label), cleanFormText(option?.value)]).filter(Boolean);
  return labels.find((label) => /prefer not to (?:say|answer|disclose)|decline to (?:say|answer|self identify)/i.test(label)) || null;
}
