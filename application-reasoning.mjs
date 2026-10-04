import { createHash } from 'node:crypto';
import {
  cleanFormText,
  hashFormValue,
  narrativeReadyEvidenceText,
  normalizeNarrativeText,
  normalizeFormQuestion,
} from './application-form-policy.mjs';
import { resolveConfiguredNarrativeEvidence } from './application-evidence.mjs';

export const APPLICATION_REASONING_SCHEMA_VERSION = 1;
export const DEFAULT_APPLICATION_REASONING_LIMITS = Object.freeze({
  fallbackCalls: 3,
  verifierCalls: 1,
  totalCalls: 4,
  repairCycles: 1,
  timeoutMs: 15_000,
});

const SAFE_SEMANTICS = Object.freeze({
  first_name: ['identity_contact', 'first_name'],
  last_name: ['identity_contact', 'last_name'],
  full_name: ['identity_contact', 'full_name'],
  email: ['identity_contact', 'email'],
  phone: ['identity_contact', 'phone'],
  phone_country: ['identity_contact', 'phone_country'],
  phone_dial_code: ['identity_contact', 'phone_dial_code'],
  linkedin: ['identity_contact', 'linkedin'],
  github: ['identity_contact', 'github'],
  website: ['identity_contact', 'website'],
  current_location: ['current_location', 'current_location'],
  city: ['current_location', 'city'],
  country: ['current_location', 'country'],
  work_authorization: ['work_authorization', 'work_authorization'],
  sponsorship: ['sponsorship_employer_support', 'sponsorship'],
  application_source: ['source_how_heard', 'application_source'],
  university: ['education', 'university'],
  degree: ['education', 'degree'],
  graduation: ['education', 'graduation'],
  availability: ['availability', 'availability'],
  relocation: ['relocation', 'relocation'],
  custom_narrative: ['custom_motivation_experience_narrative', 'custom_narrative'],
  cover_letter_text: ['custom_motivation_experience_narrative', 'cover_letter_text'],
});
export const ALLOWED_APPLICATION_SEMANTICS = Object.freeze(Object.keys(SAFE_SEMANTICS));
export const GENERIC_APPLICATION_CLASSIFICATION_SEMANTICS = Object.freeze(
  Object.entries(SAFE_SEMANTICS)
    .filter(([, [category]]) => category !== 'custom_motivation_experience_narrative')
    .map(([semantic]) => semantic),
);
const NARRATIVE_TEMPLATES = new Set(['role-fit-v1', 'role-fit-evidence-only-v1']);
const NARRATIVE_TOPICS = new Set([
  'data_engineering', 'analytics', 'python_sql', 'ai_ml', 'software_backend', 'motivation_fit',
]);
const SEMANTIC_VALUE_VISIBLE_CATEGORIES = new Set([
  'current_location', 'work_authorization', 'sponsorship_employer_support',
  'source_how_heard', 'education', 'salary', 'availability', 'relocation',
]);

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertKnownFields(value, allowed, label) {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
  }
}

function controlType(field = {}) {
  return [field.tag, field.type, field.role, field.autocomplete].map(cleanFormText).join('|');
}

export function visibleOptionsDigest(field = {}) {
  return sha256((field.options || []).map((option) => ({
    label: cleanFormText(option?.label),
    value: cleanFormText(option?.value),
  })));
}

export function fieldResolutionKey(field = {}, applicationFormId = '') {
  const basis = {
    applicationFormId: cleanFormText(applicationFormId || field.formId),
    question: normalizeFormQuestion(field.questionText || field.groupLabel || field.label),
    controlType: controlType(field),
    controlHint: cleanFormText(field.name || field.id),
    controlVariant: ['radio', 'checkbox'].includes(cleanFormText(field.type).toLowerCase())
      ? normalizeFormQuestion(field.optionLabel || field.value || field.label)
      : '',
  };
  return `resolution:${createHash('sha256').update(JSON.stringify(basis)).digest('hex')}`;
}

export function semanticFromAnnotation(annotation) {
  const pair = SAFE_SEMANTICS[annotation?.semantic];
  return pair ? { category: pair[0], semantic: pair[1] } : null;
}

function exactIdentity(field, snapshot, context) {
  const question = normalizeFormQuestion(field.questionText || field.groupLabel || field.label);
  return {
    batchId: cleanFormText(context?.batchId) || null,
    candidateId: cleanFormText(context?.candidate?.candidate_id || context?.candidate?.candidateId) || null,
    applicationFormId: cleanFormText(snapshot?.applicationFormId),
    resolutionKey: fieldResolutionKey(field, snapshot?.applicationFormId),
    questionDigest: sha256(question),
    controlType: controlType(field),
  };
}

function narrativeCapabilities(profile) {
  const configured = Array.isArray(profile?.formRules?.narrative_evidence)
    ? profile.formRules.narrative_evidence
    : [];
  const evidenceCatalogue = configured.flatMap((entry) => {
    const evidenceId = cleanFormText(entry?.id);
    const topicIds = [...new Set((entry?.topics || [])
      .map((topic) => cleanFormText(topic).toLowerCase().replace(/\s+/g, '_'))
      .filter((topic) => NARRATIVE_TOPICS.has(topic)))];
    if (!evidenceId || !topicIds.length) return [];
    try {
      const approved = resolveConfiguredNarrativeEvidence(profile, new Set(topicIds))
        .filter((item) => item.configuredEvidenceId === evidenceId)
        .map((item) => narrativeReadyEvidenceText(item.text));
      if (!approved.length) return [];
      return [{ evidenceId, topicIds, shortFactualText: approved.join(' ') }];
    } catch {
      return [];
    }
  });
  const topicIds = [...new Set(evidenceCatalogue.flatMap((entry) => entry.topicIds))];
  const evidenceIds = evidenceCatalogue.map((entry) => entry.evidenceId);
  return { templateIds: [...NARRATIVE_TEMPLATES], topicIds, evidenceIds, evidenceCatalogue };
}

export function buildReasoningCandidate(field, snapshot, context, {
  kind,
  reasonCode,
  canonicalValue = null,
  profile = null,
} = {}) {
  const identity = exactIdentity(field, snapshot, context);
  const candidate = {
    ...identity,
    kind,
    reasonCode,
    question: cleanFormText(field.questionText || field.groupLabel || field.label),
    required: Boolean(field.required),
    options: (field.options || []).map((option) => ({
      label: cleanFormText(option?.label), value: cleanFormText(option?.value),
    })),
  };
  if (kind === 'option_mapping') {
    candidate.canonicalValue = cleanFormText(canonicalValue);
    candidate.canonicalValueHash = hashFormValue(candidate.canonicalValue);
    candidate.optionsDigest = visibleOptionsDigest(field);
  }
  if (kind === 'semantic_classification') {
    candidate.allowedSemantics = [...GENERIC_APPLICATION_CLASSIFICATION_SEMANTICS];
  }
  if (kind === 'narrative_routing') Object.assign(candidate, narrativeCapabilities(profile));
  return candidate;
}

export function validateResolutionForField(entry, field, snapshot, context) {
  if (!entry || entry.schemaVersion !== APPLICATION_REASONING_SCHEMA_VERSION) return null;
  const expected = exactIdentity(field, snapshot, context);
  for (const key of ['batchId', 'candidateId', 'applicationFormId', 'resolutionKey', 'questionDigest', 'controlType']) {
    if ((entry[key] ?? null) !== (expected[key] ?? null)) return null;
  }
  if (entry.kind === 'option_mapping' && entry.optionsDigest !== visibleOptionsDigest(field)) return null;
  if (!['semantic_classification', 'option_mapping', 'narrative_routing'].includes(entry.kind)) return null;
  return entry;
}

export function resolutionForField(ledger, field, snapshot, context, kind = null) {
  const key = fieldResolutionKey(field, snapshot?.applicationFormId);
  const candidates = (ledger || []).filter((entry) => entry.resolutionKey === key && (!kind || entry.kind === kind));
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const accepted = validateResolutionForField(candidates[index], field, snapshot, context);
    if (accepted) return accepted;
  }
  return null;
}

function parseStructuredResponse(raw, label) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { throw new Error(`${label} returned malformed JSON`); }
  }
  return raw;
}

function validateStringArray(values, allowed, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string')) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  const unique = [...new Set(values)];
  if (unique.length !== values.length || unique.some((value) => !allowed.includes(value))) {
    throw new Error(`${label} contains an unsupported value`);
  }
  return unique;
}

function evidenceBindings(profile, topicIds, evidenceIds) {
  const resolved = resolveConfiguredNarrativeEvidence(profile, new Set(topicIds));
  const selected = resolved.filter((entry) => evidenceIds.includes(entry.configuredEvidenceId));
  for (const id of evidenceIds) {
    if (!selected.some((entry) => entry.configuredEvidenceId === id)) {
      throw new Error(`Narrative evidence identity is unavailable: ${id}`);
    }
  }
  return selected.map((entry) => ({
    configuredEvidenceId: entry.configuredEvidenceId,
    evidenceIdentity: entry.evidenceIdentity,
    evidenceHash: entry.evidenceHash,
    sourceHash: entry.sourceHash,
  }));
}

export function validateSemanticAnnotationResponse(raw, request, {
  providerIdentity = {},
  profile = null,
} = {}) {
  const response = parseStructuredResponse(raw, 'Semantic reasoning provider');
  assertKnownFields(response, new Set(['schemaVersion', 'annotations']), 'Semantic reasoning response');
  if (response.schemaVersion !== APPLICATION_REASONING_SCHEMA_VERSION || !Array.isArray(response.annotations)) {
    throw new Error('Semantic reasoning response schema is invalid');
  }
  const requested = new Map(request.fields.map((field) => [field.resolutionKey, field]));
  const seen = new Set();
  const responseDigest = sha256(JSON.stringify(response));
  return response.annotations.map((annotation) => {
    assertPlainObject(annotation, 'Semantic annotation');
    const expected = requested.get(annotation.resolutionKey);
    if (!expected || seen.has(annotation.resolutionKey)) throw new Error('Semantic annotation refers to an unknown or duplicate resolution key');
    seen.add(annotation.resolutionKey);
    if (annotation.kind !== expected.kind) throw new Error('Semantic annotation kind does not match the requested resolution kind');
    let accepted;
    if (annotation.kind === 'semantic_classification') {
      assertKnownFields(annotation, new Set(['resolutionKey', 'kind', 'semantic']), 'Semantic classification annotation');
      if (!expected.allowedSemantics?.includes(annotation.semantic) || !semanticFromAnnotation(annotation)) {
        throw new Error(`Unsupported semantic classification: ${annotation.semantic}`);
      }
      accepted = { semantic: annotation.semantic };
    } else if (annotation.kind === 'option_mapping') {
      assertKnownFields(annotation, new Set([
        'resolutionKey', 'kind', 'canonicalValueHash', 'selectedVisibleOption', 'noSemanticMatch',
      ]), 'Option mapping annotation');
      if (annotation.canonicalValueHash !== expected.canonicalValueHash) throw new Error('Option mapping changed the canonical answer identity');
      const noSemanticMatch = annotation.noSemanticMatch === true;
      if (noSemanticMatch && annotation.selectedVisibleOption !== undefined) {
        throw new Error('Option mapping cannot select an option and refuse the mapping together');
      }
      if (!noSemanticMatch && typeof annotation.selectedVisibleOption !== 'string') {
        throw new Error('Option mapping must select an exact supplied option or return noSemanticMatch');
      }
      if (annotation.noSemanticMatch !== undefined && annotation.noSemanticMatch !== true) {
        throw new Error('Option mapping noSemanticMatch must be exactly true when present');
      }
      const selected = expected.options.find((option) => (
        annotation.selectedVisibleOption === option.label || annotation.selectedVisibleOption === option.value
      ));
      if (!noSemanticMatch && !selected) throw new Error('Option mapping selected an option that was not supplied');
      accepted = noSemanticMatch
        ? { canonicalValueHash: expected.canonicalValueHash, noSemanticMatch: true }
        : {
          canonicalValueHash: expected.canonicalValueHash,
          selectedVisibleOption: annotation.selectedVisibleOption,
        };
    } else if (annotation.kind === 'narrative_routing') {
      assertKnownFields(annotation, new Set(['resolutionKey', 'kind', 'templateId', 'topicIds', 'evidenceIds']), 'Narrative routing annotation');
      if (!expected.templateIds.includes(annotation.templateId)) throw new Error('Narrative routing selected an unsupported template');
      const topicIds = validateStringArray(annotation.topicIds, expected.topicIds, 'Narrative topic IDs');
      const evidenceIds = validateStringArray(annotation.evidenceIds, expected.evidenceIds, 'Narrative evidence IDs');
      accepted = {
        templateId: annotation.templateId,
        topicIds,
        evidenceIds,
        evidenceBindings: evidenceBindings(profile, topicIds, evidenceIds),
      };
    } else {
      throw new Error(`Unsupported semantic annotation kind: ${annotation.kind}`);
    }
    return {
      schemaVersion: APPLICATION_REASONING_SCHEMA_VERSION,
      batchId: expected.batchId,
      candidateId: expected.candidateId,
      applicationFormId: expected.applicationFormId,
      resolutionKey: expected.resolutionKey,
      questionDigest: expected.questionDigest,
      controlType: expected.controlType,
      kind: annotation.kind,
      optionsDigest: annotation.kind === 'option_mapping' ? expected.optionsDigest : null,
      annotation: accepted,
      provider: cleanFormText(providerIdentity.provider) || 'injected',
      model: cleanFormText(providerIdentity.model) || 'unspecified',
      requestDigest: request.requestDigest,
      responseDigest,
    };
  });
}

export function mergeResolutionLedger(current = [], additions = []) {
  const merged = [...current];
  for (const entry of additions) {
    const index = merged.findIndex((row) => row.resolutionKey === entry.resolutionKey && row.kind === entry.kind);
    if (index >= 0) merged[index] = entry;
    else merged.push(entry);
  }
  return merged;
}

export function createSemanticReasoningRequest(candidates) {
  const fields = candidates.map((candidate) => ({ ...candidate }));
  if (new Set(fields.map((field) => field.resolutionKey)).size !== fields.length) {
    throw new Error('Semantic reasoning request contains ambiguous duplicate resolution keys');
  }
  const request = {
    schemaVersion: APPLICATION_REASONING_SCHEMA_VERSION,
    task: 'semantic_annotations_only',
    fields,
  };
  request.requestDigest = sha256(JSON.stringify(request));
  return request;
}

export function resolveReasoningLimits(profile = {}) {
  const configured = profile?.formRules?.reasoning || {};
  const cap = (key, maximum) => {
    const value = Number(configured[key]);
    return Number.isInteger(value) && value >= 0 ? Math.min(value, maximum) : maximum;
  };
  return {
    fallbackCalls: cap('max_fallback_calls', DEFAULT_APPLICATION_REASONING_LIMITS.fallbackCalls),
    verifierCalls: cap('max_verifier_calls', DEFAULT_APPLICATION_REASONING_LIMITS.verifierCalls),
    totalCalls: cap('max_total_calls', DEFAULT_APPLICATION_REASONING_LIMITS.totalCalls),
    repairCycles: cap('max_repair_cycles', DEFAULT_APPLICATION_REASONING_LIMITS.repairCycles),
    timeoutMs: Math.min(
      Number.isInteger(Number(configured.timeout_ms)) && Number(configured.timeout_ms) > 0
        ? Number(configured.timeout_ms)
        : DEFAULT_APPLICATION_REASONING_LIMITS.timeoutMs,
      30_000,
    ),
  };
}

export async function boundedProviderCall(provider, method, payload, state) {
  if (!provider || typeof provider[method] !== 'function') throw new Error('Application reasoning provider is unavailable');
  const kind = method === 'verify' ? 'verifier' : 'fallback';
  if (state.calls.total >= state.limits.totalCalls || state.calls[kind] >= state.limits[`${kind}Calls`]) {
    throw new Error(`Application reasoning ${kind} call budget is exhausted`);
  }
  state.calls.total += 1;
  state.calls[kind] += 1;
  let timer;
  const controller = new AbortController();
  try {
    return await Promise.race([
      provider[method](payload, { signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Application reasoning provider timed out'));
        }, state.limits.timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createReasoningState(profile, provider, previousEvidence = null) {
  const previous = previousEvidence?.reasoning;
  const limits = resolveReasoningLimits(profile);
  const calls = {
    fallback: Math.min(Number(previous?.calls?.fallback || 0), limits.fallbackCalls),
    verifier: Math.min(Number(previous?.calls?.verifier || 0), limits.verifierCalls),
    total: Math.min(Number(previous?.calls?.total || 0), limits.totalCalls),
  };
  const semanticResolutions = Array.isArray(previous?.semanticResolutions) ? structuredClone(previous.semanticResolutions) : [];
  const preparedAnswerSummary = Array.isArray(previous?.preparedAnswerSummary) ? structuredClone(previous.preparedAnswerSummary) : [];
  const riskReasons = new Set();
  for (const entry of semanticResolutions) {
    riskReasons.add(entry.kind === 'option_mapping'
      ? 'nontrivial_option_mapping'
      : entry.kind === 'narrative_routing'
        ? 'narrative_semantic_fallback'
        : 'semantic_fallback_used');
  }
  if (provider && preparedAnswerSummary.some((row) => row.category === 'custom_motivation_experience_narrative')) {
    riskReasons.add('deterministic_narrative_prepared');
  }
  return {
    provider,
    providerIdentity: {
      provider: cleanFormText(provider?.identity?.provider) || null,
      model: cleanFormText(provider?.identity?.model) || null,
    },
    limits,
    calls,
    semanticResolutions,
    rejectedResolutions: Array.isArray(previous?.rejectedResolutions)
      ? structuredClone(previous.rejectedResolutions).slice(-12)
      : [],
    preparedAnswerSummary,
    transientNarrativeAnswers: [],
    riskReasons,
    semanticVerification: {
      disposition: 'not_required',
      triggerReasons: [],
      findings: [],
      requestDigest: null,
      responseDigest: null,
      repair: { attempted: false, outcome: 'not_attempted', resolutionKey: null },
    },
  };
}

export function reasoningEvidence(state) {
  return {
    schemaVersion: APPLICATION_REASONING_SCHEMA_VERSION,
    provider: state.providerIdentity.provider,
    model: state.providerIdentity.model,
    calls: { ...state.calls },
    limits: { ...state.limits },
    semanticResolutions: structuredClone(state.semanticResolutions),
    rejectedResolutions: structuredClone(state.rejectedResolutions).slice(-12),
    preparedAnswerSummary: structuredClone(state.preparedAnswerSummary),
  };
}

export function addPreparedAnswers(state, plan, stepFingerprint, snapshot = null) {
  const actionRows = (plan.actions || []).filter((action) => action.action !== 'upload').map((action) => ({
    resolutionKey: action.resolutionKey,
    stableFieldId: action.stableFieldId,
    normalizedQuestion: normalizeFormQuestion(action.label),
    category: action.category,
    semantic: action.semantic,
    committedValue: SEMANTIC_VALUE_VISIBLE_CATEGORIES.has(action.category) ? cleanFormText(action.value) : null,
    committedValueHash: action.valueHash,
    selectedVisibleLabel: ['select', 'autocomplete', 'radio', 'check'].includes(action.action)
      ? cleanFormText(action.value) : null,
    evidenceIds: action.narrativeRouting?.evidenceIds || [],
    stepFingerprint,
  }));
  const preservedRows = (plan.preservedFields || []).filter((row) => row.category !== 'file_upload').map((row) => {
    const field = (snapshot?.fields || []).find((candidate) => (
      fieldResolutionKey(candidate, snapshot?.applicationFormId) === row.resolutionKey
    ));
    const committedValue = SEMANTIC_VALUE_VISIBLE_CATEGORIES.has(row.category)
      ? cleanFormText(field?.selectedLabel || field?.value || field?.optionLabel)
      : null;
    return {
      resolutionKey: row.resolutionKey,
      stableFieldId: row.stableFieldId,
      normalizedQuestion: normalizeFormQuestion(row.label),
      category: row.category,
      semantic: row.semantic,
      committedValue: committedValue || null,
      committedValueHash: row.valueHash,
      selectedVisibleLabel: cleanFormText(field?.selectedLabel || field?.optionLabel) || null,
      evidenceIds: row.narrativeRouting?.evidenceIds || [],
      stepFingerprint,
    };
  });
  const rows = [...actionRows, ...preservedRows];
  for (const row of rows) {
    const index = state.preparedAnswerSummary.findIndex((item) => item.resolutionKey === row.resolutionKey);
    if (index >= 0) state.preparedAnswerSummary[index] = row;
    else state.preparedAnswerSummary.push(row);
  }
  const narrativeActions = (plan.actions || [])
    .filter((action) => action.category === 'custom_motivation_experience_narrative')
    .map((action) => ({ action, preparedAnswer: normalizeNarrativeText(action.value) }));
  const narrativePreserved = (plan.preservedFields || [])
    .filter((row) => row.category === 'custom_motivation_experience_narrative')
    .map((row) => {
      const field = (snapshot?.fields || []).find((candidate) => (
        fieldResolutionKey(candidate, snapshot?.applicationFormId) === row.resolutionKey
      ));
      return { action: row, preparedAnswer: normalizeNarrativeText(field?.value) };
    });
  for (const { action, preparedAnswer } of [...narrativeActions, ...narrativePreserved]) {
    if (!preparedAnswer) continue;
    const normalizedQuestion = normalizeFormQuestion(action.label);
    const provenance = (plan.answerRecords || []).find((record) => record.normalizedQuestion === normalizedQuestion);
    const transient = {
      resolutionKey: action.resolutionKey,
      question: cleanFormText(action.label),
      normalizedQuestion,
      preparedAnswer,
      templateId: provenance?.templateId || action.narrativeRouting?.templateId || null,
      evidenceIds: [...new Set([
        ...(action.narrativeRouting?.evidenceIds || []),
        ...(provenance?.factualSources || []).map((source) => source.configuredEvidenceId).filter(Boolean),
      ])],
      category: action.category,
      semantic: action.semantic,
    };
    const index = state.transientNarrativeAnswers.findIndex((item) => item.resolutionKey === transient.resolutionKey);
    if (index >= 0) state.transientNarrativeAnswers[index] = transient;
    else state.transientNarrativeAnswers.push(transient);
  }
}

export function verifierTriggerReasons(state, plan, execution) {
  const reasons = new Set(state.riskReasons);
  if (!state.provider && state.semanticResolutions.length === 0) return [...reasons];
  if ((plan.answerRecords || []).length > 0) reasons.add('deterministic_narrative_prepared');
  if ((execution.attemptLedger || []).some((row) => row.success === false)) reasons.add('validation_anomaly_observed');
  const consequential = state.preparedAnswerSummary.filter((row) => (
    ['work_authorization', 'sponsorship', 'current_location', 'city', 'country'].includes(row.semantic)
  ));
  if (consequential.length >= 3) reasons.add('cross_field_consistency_risk');
  return [...reasons];
}

export function createSemanticVerifierRequest(state, liveFields = []) {
  if (new Set(liveFields.map((field) => field.resolutionKey)).size !== liveFields.length) {
    throw new Error('Semantic verifier request contains ambiguous duplicate live-field keys');
  }
  const narrativeKeys = state.preparedAnswerSummary
    .filter((row) => row.category === 'custom_motivation_experience_narrative')
    .map((row) => row.resolutionKey);
  if (narrativeKeys.some((key) => !state.transientNarrativeAnswers.some((row) => row.resolutionKey === key))) {
    throw new Error('Semantic verifier lacks transient text for a prepared narrative answer');
  }
  const request = {
    schemaVersion: APPLICATION_REASONING_SCHEMA_VERSION,
    task: 'semantic_verification_only',
    preparedAnswers: state.preparedAnswerSummary,
    narrativeAnswers: structuredClone(state.transientNarrativeAnswers),
    liveFields,
    triggerReasons: [...state.riskReasons],
  };
  request.requestDigest = sha256(JSON.stringify(request));
  return request;
}

function validateRepair(repair, liveField) {
  if (repair == null) return null;
  assertPlainObject(repair, 'Verifier repair');
  if (!liveField) throw new Error('Verifier repair targets a field that is not currently live');
  if (repair.kind === 'semantic_classification') {
    assertKnownFields(repair, new Set(['resolutionKey', 'kind', 'semantic']), 'Verifier semantic repair');
    if (!liveField.allowedSemantics?.includes(repair.semantic) || !semanticFromAnnotation(repair)) {
      throw new Error('Verifier repair selected an unsupported semantic');
    }
    return { ...repair };
  }
  if (repair.kind === 'option_mapping') {
    assertKnownFields(repair, new Set(['resolutionKey', 'kind', 'canonicalValueHash', 'selectedVisibleOption']), 'Verifier option repair');
    if (repair.canonicalValueHash !== liveField.canonicalValueHash) throw new Error('Verifier option repair changed the canonical answer identity');
    if (!liveField.options.some((option) => repair.selectedVisibleOption === option.label || repair.selectedVisibleOption === option.value)) {
      throw new Error('Verifier option repair selected an unavailable visible option');
    }
    return { ...repair };
  }
  if (repair.kind === 'narrative_routing') {
    assertKnownFields(repair, new Set(['resolutionKey', 'kind', 'templateId', 'topicIds', 'evidenceIds']), 'Verifier narrative repair');
    if (!liveField.templateIds?.includes(repair.templateId)) throw new Error('Verifier narrative repair selected an unsupported template');
    validateStringArray(repair.topicIds, liveField.topicIds || [], 'Verifier narrative topic IDs');
    validateStringArray(repair.evidenceIds, liveField.evidenceIds || [], 'Verifier narrative evidence IDs');
    return { ...repair };
  }
  throw new Error('Verifier repair contains an unsupported annotation kind');
}

export function validateSemanticVerifierResponse(raw, request) {
  const response = parseStructuredResponse(raw, 'Semantic verifier');
  assertKnownFields(response, new Set(['schemaVersion', 'disposition', 'findings']), 'Semantic verifier response');
  if (response.schemaVersion !== APPLICATION_REASONING_SCHEMA_VERSION
      || !['pass', 'review_required'].includes(response.disposition)
      || !Array.isArray(response.findings)) {
    throw new Error('Semantic verifier response schema is invalid');
  }
  if (response.disposition === 'pass' && response.findings.length) throw new Error('PASS semantic verification cannot contain findings');
  if (response.disposition === 'review_required' && !response.findings.length) throw new Error('Semantic review_required disposition needs a finding');
  const live = new Map(request.liveFields.map((field) => [field.resolutionKey, field]));
  const summaryKeys = new Set(request.preparedAnswers.map((row) => row.resolutionKey));
  const findings = response.findings.map((finding) => {
    assertKnownFields(finding, new Set(['code', 'resolutionKey', 'message', 'repair']), 'Semantic verifier finding');
    if (!cleanFormText(finding.code) || !cleanFormText(finding.message) || !summaryKeys.has(finding.resolutionKey)) {
      throw new Error('Semantic verifier finding does not bind to a prepared answer');
    }
    return {
      code: cleanFormText(finding.code),
      resolutionKey: finding.resolutionKey,
      message: cleanFormText(finding.message).slice(0, 500),
      live: live.has(finding.resolutionKey),
      repair: validateRepair(finding.repair, live.get(finding.resolutionKey)),
    };
  });
  return { ...response, findings, responseDigest: sha256(JSON.stringify(response)) };
}

export function makeRepairLedgerEntry(repair, liveField, request, state, profile) {
  const raw = {
    schemaVersion: APPLICATION_REASONING_SCHEMA_VERSION,
    annotations: [repair],
  };
  return validateSemanticAnnotationResponse(raw, {
    schemaVersion: APPLICATION_REASONING_SCHEMA_VERSION,
    task: 'semantic_annotations_only',
    fields: [liveField],
    requestDigest: request.requestDigest,
  }, { providerIdentity: state.providerIdentity, profile })[0];
}

export function publicLiveReasoningField(field, snapshot, context, profile, semantics, canonicalValue = null) {
  const kind = semantics?.category === 'custom_motivation_experience_narrative'
    ? 'narrative_routing'
    : (field.options || []).length && canonicalValue
      ? 'option_mapping'
      : 'semantic_classification';
  return buildReasoningCandidate(field, snapshot, context, {
    kind,
    reasonCode: 'final_semantic_verifier',
    canonicalValue,
    profile,
  });
}

export function hashReasoningValue(value) {
  return sha256(value);
}
