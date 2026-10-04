import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import {
  buildOperationalFormPlan,
  prepareOperationalApplicationForm,
} from '../application-form-engine.mjs';
import {
  boundedProviderCall,
  buildReasoningCandidate,
  createReasoningState,
  createSemanticReasoningRequest,
  createSemanticVerifierRequest,
  fieldResolutionKey,
  mergeResolutionLedger,
  publicLiveReasoningField,
  resolutionForField,
  validateSemanticAnnotationResponse,
  validateSemanticVerifierResponse,
} from '../application-reasoning.mjs';
import { createConfiguredApplicationReasoningProvider } from '../application-reasoning-provider.mjs';
import { stableFieldIdentity } from '../application-form-policy.mjs';
import { appendFormPreparationEvidence } from '../application-batch.mjs';
import { attachFactualSources } from './fixtures/application-evidence-profile.mjs';

const candidate = {
  candidate_id: `cand_v1_${'a'.repeat(64)}`,
  company: 'Example Company',
  title: 'Data Engineer',
};
const context = { batchId: 'reasoning-batch', candidate, jobCountry: 'Finland', jdText: 'Build Python and SQL data pipelines.' };
const profile = attachFactualSources({
  candidate: {
    full_name: 'Alex Example', email: 'alex@example.test', phone: '+358 40 123 4567',
    location: 'Example City, Finland', linkedin: 'https://linkedin.test/alex', github: 'https://github.test/alex',
  },
  location: { country: 'Finland', city: 'Example City' },
  currentStatus: { summary: 'Graduate student at Example University', availability: { start: 'Immediately' } },
  compensation: {},
  education: {},
  formRules: {
    current_location: { city: 'Example City', country: 'Finland', combined: 'Example City, Finland' },
    work_authorization: { home_country: 'Finland' },
    source: { value: 'LinkedIn' },
    narrative_evidence: [{
      id: 'warehouse-proof', topics: ['data_engineering', 'python_sql'],
      provenance: [{ sourceType: 'cv', locator: 'lines:1' }],
    }, {
      id: 'vision-proof', topics: ['ai_ml'],
      provenance: [{ sourceType: 'cv', locator: 'lines:2' }],
    }],
  },
  answers: new Map(),
  priorApprovedAnswers: [],
  cvText: [
    'In the fictional Warehouse project, I built validated Python and SQL data pipelines.',
    'In the fictional Vision project, I evaluated image models with approved reproducible tests.',
  ].join('\n'),
  articleDigestText: '', answerBankText: '', profileModeText: '',
});

function field(overrides = {}) {
  return {
    fieldId: overrides.fieldId || overrides.id || 'field',
    formId: overrides.formId ?? 'application',
    applicationFormOwned: overrides.applicationFormOwned ?? true,
    id: overrides.id || '', name: overrides.name || '', tag: overrides.tag || 'input',
    type: overrides.type || 'text', role: overrides.role || '', autocomplete: overrides.autocomplete || '',
    label: overrides.label || '', questionText: overrides.questionText || overrides.label || '', groupLabel: overrides.groupLabel || '',
    required: overrides.required ?? true, disabled: overrides.disabled ?? false, visible: overrides.visible ?? true,
    value: overrides.value || '', checked: overrides.checked || false, files: overrides.files || [],
    options: overrides.options || [], maxLength: overrides.maxLength || null, selectedLabel: overrides.selectedLabel || '',
  };
}

function snapshot(fields, controls = []) {
  return { applicationFormId: 'application', fields, controls };
}

function accept(plan, annotations) {
  const request = createSemanticReasoningRequest(plan.reasoningCandidates);
  return validateSemanticAnnotationResponse({ schemaVersion: 1, annotations }, request, {
    providerIdentity: { provider: 'fake', model: 'fake-luna' }, profile,
  });
}

test('ordinary deterministic plans need no reasoning and eligibility excludes manual/operational classes', () => {
  const ordinary = buildOperationalFormPlan(snapshot([
    field({ id: 'email', label: 'Email', type: 'email' }),
    field({ id: 'legal', label: 'I certify this information is accurate', type: 'checkbox' }),
    field({ id: 'eeo', label: 'Gender', tag: 'select', type: 'select-one', options: [{ label: 'Female', value: 'f' }] }),
    field({ id: 'upload', label: 'Attachment', type: 'file' }),
    field({ id: 'preferred', label: 'Preferred office location' }),
    field({ id: 'salary', label: 'Salary expectation' }),
    field({ id: 'unknown-consent', label: 'Unfamiliar acknowledgement', type: 'checkbox' }),
  ]), profile, {}, { context });
  assert.equal(ordinary.reasoningCandidates.length, 0);
  assert.equal(ordinary.actions.some((action) => action.semantic === 'legal_declaration'), false);
  assert.ok(ordinary.unresolvedFields.some((row) => row.reasonCode === 'unknown_consent_or_declaration'));
  const unverified = buildOperationalFormPlan({ applicationFormId: '', fields: [], controls: [] }, profile, {}, { context });
  assert.equal(unverified.reasoningCandidates.length, 0);
});

test('multiple eligible ambiguities are batched into one strict annotation request', async () => {
  const plan = buildOperationalFormPlan(snapshot([
    field({ id: 'correo', label: 'Correo de contacto' }),
    field({ id: 'nombre', label: 'Nombre completo de la persona candidata' }),
  ]), profile, {}, { context });
  assert.equal(plan.reasoningCandidates.length, 2);
  let calls = 0;
  const state = createReasoningState(profile, {
    identity: { provider: 'fake', model: 'fake-luna' },
    annotate: async (request) => {
      calls += 1;
      return { schemaVersion: 1, annotations: request.fields.map((item, index) => ({
        resolutionKey: item.resolutionKey, kind: 'semantic_classification', semantic: index ? 'full_name' : 'email',
      })) };
    },
  });
  const request = createSemanticReasoningRequest(plan.reasoningCandidates);
  const raw = await boundedProviderCall(state.provider, 'annotate', request, state);
  const ledger = validateSemanticAnnotationResponse(raw, request, { providerIdentity: state.providerIdentity, profile });
  assert.equal(calls, 1);
  assert.equal(ledger.length, 2);
  assert.equal(state.calls.fallback, 1);
});

test('semantic annotations classify meaning only and executable/factual output is rejected', () => {
  const plan = buildOperationalFormPlan(snapshot([field({ id: 'correo', label: 'Correo de contacto' })]), profile, {}, { context });
  const request = createSemanticReasoningRequest(plan.reasoningCandidates);
  const key = request.fields[0].resolutionKey;
  assert.ok(request.fields[0].allowedSemantics.includes('email'));
  assert.ok(request.fields[0].allowedSemantics.includes('full_name'));
  assert.ok(request.fields[0].allowedSemantics.includes('sponsorship'));
  assert.equal(request.fields[0].allowedSemantics.includes('email_address'), false);
  assert.equal(request.fields[0].allowedSemantics.includes('custom_narrative'), false);
  assert.equal(request.fields[0].allowedSemantics.includes('cover_letter_text'), false);
  const ledger = validateSemanticAnnotationResponse({
    schemaVersion: 1,
    annotations: [{ resolutionKey: key, kind: 'semantic_classification', semantic: 'email' }],
  }, request, { providerIdentity: { provider: 'fake', model: 'fake-luna' }, profile });
  const replanned = buildOperationalFormPlan(snapshot([field({ id: 'correo', label: 'Correo de contacto' })]), profile, {}, {
    context, semanticResolutions: ledger,
  });
  assert.equal(replanned.actions[0].value, 'alex@example.test');
  assert.equal(replanned.actions[0].sourceRef, 'config/profile.yml');
  assert.throws(() => validateSemanticAnnotationResponse({
    schemaVersion: 1,
    annotations: [{ resolutionKey: key, kind: 'semantic_classification', semantic: 'email_address' }],
  }, request, { profile }), /Unsupported semantic classification/);
  assert.throws(() => validateSemanticAnnotationResponse({
    schemaVersion: 1,
    annotations: [{ resolutionKey: key, kind: 'semantic_classification', semantic: 'invented_candidate_fact' }],
  }, request, { profile }), /Unsupported semantic classification/);
  for (const semantic of ['custom_narrative', 'cover_letter_text']) {
    assert.throws(() => validateSemanticAnnotationResponse({
      schemaVersion: 1,
      annotations: [{ resolutionKey: key, kind: 'semantic_classification', semantic }],
    }, request, { profile }), /Unsupported semantic classification/);
  }
  assert.throws(() => validateSemanticAnnotationResponse({
    schemaVersion: 1,
    annotations: [{ resolutionKey: key, kind: 'semantic_classification', semantic: 'email', answer: 'invented@example.test' }],
  }, request, { profile }), /unsupported field/);
  assert.throws(() => validateSemanticAnnotationResponse({
    schemaVersion: 1,
    annotations: [{ resolutionKey: key, kind: 'semantic_classification', semantic: 'email', action: 'click submit' }],
  }, request, { profile }), /unsupported field/);
});

test('semantic-neutral field keys survive harmless rerenders but reject changed observed identity', () => {
  const original = field({ id: 'correo', name: 'candidate_value', label: 'Correo de contacto' });
  const rerendered = { ...original, fieldId: 'runtime-rerender-99', id: 'generated-rerender-id', value: 'changed display value', required: false };
  assert.equal(fieldResolutionKey(original, 'application'), fieldResolutionKey(rerendered, 'application'));
  assert.notEqual(stableFieldIdentity(original), stableFieldIdentity(original, { category: 'identity_contact', semantic: 'email' }));
  const plan = buildOperationalFormPlan(snapshot([original]), profile, {}, { context });
  const key = plan.reasoningCandidates[0].resolutionKey;
  const ledger = accept(plan, [{ resolutionKey: key, kind: 'semantic_classification', semantic: 'email' }]);
  assert.ok(resolutionForField(ledger, rerendered, snapshot([rerendered]), context));
  assert.equal(resolutionForField(ledger, { ...rerendered, questionText: 'Different question', label: 'Different question' }, snapshot([]), context), null);
  assert.equal(resolutionForField(ledger, { ...rerendered, type: 'date' }, snapshot([]), context), null);
});

test('option mappings bind the grounded value and exact visible options', () => {
  const source = field({
    id: 'source', label: 'How did you hear about us?', tag: 'select', type: 'select-one',
    options: [{ label: 'Choose', value: '' }, { label: 'Professional network', value: 'network' }],
  });
  const first = buildOperationalFormPlan(snapshot([source]), profile, {}, { context });
  assert.equal(first.reasoningCandidates[0].kind, 'option_mapping');
  const requestField = first.reasoningCandidates[0];
  const ledger = accept(first, [{
    resolutionKey: requestField.resolutionKey,
    kind: 'option_mapping',
    canonicalValueHash: requestField.canonicalValueHash,
    selectedVisibleOption: 'Professional network',
  }]);
  const replanned = buildOperationalFormPlan(snapshot([source]), profile, {}, { context, semanticResolutions: ledger });
  assert.equal(replanned.actions[0].value, 'Professional network');
  const mutated = { ...source, options: [...source.options, { label: 'Social media', value: 'social' }] };
  const stale = buildOperationalFormPlan(snapshot([mutated]), profile, {}, { context, semanticResolutions: ledger });
  assert.equal(stale.actions.length, 0);
  assert.equal(stale.reasoningCandidates[0].kind, 'option_mapping');
  const noMatchLedger = accept(first, [{
    resolutionKey: requestField.resolutionKey,
    kind: 'option_mapping',
    canonicalValueHash: requestField.canonicalValueHash,
    noSemanticMatch: true,
  }]);
  const refused = buildOperationalFormPlan(snapshot([source]), profile, {}, {
    context, semanticResolutions: noMatchLedger,
  });
  assert.equal(refused.actions.length, 0);
  assert.equal(refused.reasoningCandidates.length, 0);
  assert.equal(refused.unresolvedFields[0].reasonCode, 'reasoning_option_no_semantic_match');
  assert.throws(() => accept(first, [{
    resolutionKey: requestField.resolutionKey,
    kind: 'option_mapping',
    canonicalValueHash: requestField.canonicalValueHash,
    selectedVisibleOption: 'Invented closest option',
  }]), /not supplied/);
});

test('narrative routing selects only approved templates/topics/evidence and preserves provenance', () => {
  const narrative = field({ id: 'story', label: 'Schildern Sie Ihren Beitrag', tag: 'textarea', type: 'textarea', maxLength: 500 });
  const first = buildOperationalFormPlan(snapshot([narrative]), profile, {}, { context });
  const requested = first.reasoningCandidates[0];
  assert.equal(requested.kind, 'narrative_routing');
  assert.deepEqual(requested.evidenceCatalogue.map((entry) => entry.evidenceId), ['warehouse-proof', 'vision-proof']);
  assert.deepEqual(requested.evidenceCatalogue[0].topicIds, ['data_engineering', 'python_sql']);
  assert.match(requested.evidenceCatalogue[0].shortFactualText, /Warehouse project/);
  assert.match(requested.evidenceCatalogue[1].shortFactualText, /Vision project/);
  const ledger = accept(first, [{
    resolutionKey: requested.resolutionKey,
    kind: 'narrative_routing',
    templateId: 'role-fit-v1',
    topicIds: ['data_engineering'],
    evidenceIds: ['warehouse-proof'],
  }]);
  const replanned = buildOperationalFormPlan(snapshot([narrative]), profile, {}, { context, semanticResolutions: ledger });
  assert.equal(replanned.actions.length, 1);
  assert.equal(replanned.answerRecords.length, 1);
  assert.equal(replanned.answerRecords[0].factualSources[0].configuredEvidenceId, 'warehouse-proof');
  assert.throws(() => accept(first, [{
    resolutionKey: requested.resolutionKey,
    kind: 'narrative_routing', templateId: 'role-fit-v1', topicIds: ['data_engineering'],
    evidenceIds: ['warehouse-proof'], answer: 'LLM-authored prose',
  }]), /unsupported field/);
  assert.throws(() => accept(first, [{
    resolutionKey: requested.resolutionKey,
    kind: 'narrative_routing', templateId: 'role-fit-v1', topicIds: ['data_engineering'],
    evidenceIds: ['unsupported-proof'],
  }]), /unsupported value/);
  const committed = { ...narrative, value: replanned.actions[0].value };
  const reconstructed = buildOperationalFormPlan(snapshot([committed]), profile, {}, {
    context, semanticResolutions: ledger, previousEvidence: { answerRecords: replanned.answerRecords },
  });
  assert.equal(reconstructed.unresolvedFields.length, 0);
  assert.equal(reconstructed.preservedFields.length, 1);
  const changedProfile = {
    ...profile,
    cvText: 'In a different fictional project, I changed the approved factual evidence.',
    sourceFiles: { ...profile.sourceFiles, cv: { ...profile.sourceFiles.cv, sha256: `sha256:${'b'.repeat(64)}` } },
  };
  const stale = buildOperationalFormPlan(snapshot([narrative]), changedProfile, {}, { context, semanticResolutions: ledger });
  assert.equal(stale.actions.length, 0);
  assert.match(stale.unresolvedFields[0].reason, /stale or mismatched/);

  const deterministic = buildOperationalFormPlan(snapshot([
    field({
      id: 'why-fit', label: 'Why are you a good fit for this data engineering role?',
      tag: 'textarea', type: 'textarea', maxLength: 500,
    }),
  ]), profile, {}, { context });
  assert.equal(deterministic.reasoningCandidates.length, 0);
  assert.equal(deterministic.actions[0].semantic, 'custom_narrative');
  assert.equal(deterministic.answerRecords.length, 1);
});

test('strict verifier detects cross-step findings and never treats inaccessible fields as repairable', () => {
  const state = createReasoningState(profile, null);
  state.preparedAnswerSummary = [{ resolutionKey: 'resolution:earlier', semantic: 'work_authorization' }];
  state.riskReasons.add('cross_field_consistency_risk');
  const request = createSemanticVerifierRequest(state, []);
  const result = validateSemanticVerifierResponse({
    schemaVersion: 1,
    disposition: 'review_required',
    findings: [{ code: 'contradiction', resolutionKey: 'resolution:earlier', message: 'Earlier answers conflict.', repair: null }],
  }, request);
  assert.equal(result.findings[0].live, false);
  assert.equal(result.findings[0].repair, null);
  assert.throws(() => validateSemanticVerifierResponse({
    schemaVersion: 1, disposition: 'pass', findings: [{ code: 'x', resolutionKey: 'resolution:earlier', message: 'x', repair: null }],
  }, request), /PASS/);

  const ordinary = field({ id: 'ordinary-live', label: 'Unfamiliar short field' });
  const liveField = publicLiveReasoningField(
    ordinary,
    snapshot([ordinary]),
    context,
    profile,
    { category: 'unknown', semantic: 'unknown' },
  );
  assert.equal(liveField.kind, 'semantic_classification');
  assert.equal(liveField.allowedSemantics.includes('custom_narrative'), false);
  assert.equal(liveField.allowedSemantics.includes('cover_letter_text'), false);
  const liveState = createReasoningState(profile, null);
  liveState.preparedAnswerSummary = [{
    resolutionKey: liveField.resolutionKey,
    category: 'unknown',
    semantic: 'unknown',
  }];
  const liveRequest = createSemanticVerifierRequest(liveState, [liveField]);
  for (const semantic of ['custom_narrative', 'cover_letter_text']) {
    assert.throws(() => validateSemanticVerifierResponse({
      schemaVersion: 1,
      disposition: 'review_required',
      findings: [{
        code: 'wrong_semantic',
        resolutionKey: liveField.resolutionKey,
        message: 'Attempt narrative reclassification.',
        repair: { resolutionKey: liveField.resolutionKey, kind: 'semantic_classification', semantic },
      }],
    }, liveRequest), /unsupported semantic/);
  }
});

test('reasoning budgets, provider failures, and configuration fail closed without a Luna guess', async () => {
  const cappedProfile = { ...profile, formRules: { ...profile.formRules, reasoning: { max_fallback_calls: 1, max_total_calls: 1, timeout_ms: 5 } } };
  const state = createReasoningState(cappedProfile, { annotate: async () => ({}) });
  await boundedProviderCall(state.provider, 'annotate', {}, state);
  await assert.rejects(() => boundedProviderCall(state.provider, 'annotate', {}, state), /budget is exhausted/);
  const timed = createReasoningState(cappedProfile, { annotate: async () => new Promise(() => {}) });
  await assert.rejects(() => boundedProviderCall(timed.provider, 'annotate', {}, timed), /timed out/);
  assert.equal(createConfiguredApplicationReasoningProvider(profile), null);
  assert.throws(() => createConfiguredApplicationReasoningProvider({
    ...profile, formRules: { ...profile.formRules, reasoning: { enabled: true, provider: 'openai_compatible', base_url: 'https://reasoning.test/v1', model: '' } },
  }, { env: { CAREER_OPS_REASONING_API_KEY: 'test' }, fetchImpl: async () => null }), /model is not configured/);
});

test('real provider seam serializes bounded contracts and deserializes mocked structured responses', async () => {
  const semanticPlan = buildOperationalFormPlan(snapshot([
    field({ id: 'correo-transport', label: 'Correo de contacto' }),
  ]), profile, {}, { context });
  const optionPlan = buildOperationalFormPlan(snapshot([field({
    id: 'source-transport', label: 'How did you hear about us?', tag: 'select', type: 'select-one',
    options: [{ label: 'Choose', value: '' }, { label: 'Professional network', value: 'network' }],
  })]), profile, {}, { context });
  const narrativePlan = buildOperationalFormPlan(snapshot([
    field({ id: 'narrative-transport', label: 'Schildern Sie Ihren Beitrag', tag: 'textarea', type: 'textarea', maxLength: 500 }),
  ]), profile, {}, { context });
  const request = createSemanticReasoningRequest([
    ...semanticPlan.reasoningCandidates,
    ...optionPlan.reasoningCandidates,
    ...narrativePlan.reasoningCandidates,
  ]);
  const responses = [
    { schemaVersion: 1, annotations: [{
      resolutionKey: semanticPlan.reasoningCandidates[0].resolutionKey,
      kind: 'semantic_classification',
      semantic: 'email',
    }] },
    { schemaVersion: 1, disposition: 'pass', findings: [] },
  ];
  const calls = [];
  const configuredProfile = {
    ...profile,
    formRules: {
      ...profile.formRules,
      reasoning: {
        enabled: true, provider: 'openai_compatible', base_url: 'https://reasoning.test/v1', model: 'luna-configured-by-test',
      },
    },
  };
  const provider = createConfiguredApplicationReasoningProvider(configuredProfile, {
    env: { CAREER_OPS_REASONING_API_KEY: 'test-key' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      const content = JSON.stringify(responses.shift());
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    },
  });
  const raw = await provider.annotate(request);
  const accepted = validateSemanticAnnotationResponse(raw, request, { providerIdentity: provider.identity, profile });
  assert.equal(accepted[0].annotation.semantic, 'email');
  const annotationInput = JSON.parse(calls[0].body.messages[1].content);
  const serialized = JSON.stringify(annotationInput);
  assert.ok(annotationInput.untrustedData.fields[0].allowedSemantics.includes('email'));
  assert.ok(annotationInput.untrustedData.fields.find((item) => item.kind === 'narrative_routing')
    .evidenceCatalogue.some((entry) => entry.evidenceId === 'vision-proof' && /Vision project/.test(entry.shortFactualText)));
  assert.match(serialized, /noSemanticMatch/);
  for (const forbidden of ['cvText', 'sourceFiles', 'profileModeText', 'projectRoot', 'resolvedPath']) {
    assert.equal(serialized.includes(forbidden), false);
  }

  const state = createReasoningState(profile, provider);
  state.preparedAnswerSummary = [{
    resolutionKey: 'resolution:transport-narrative',
    stableFieldId: 'field:transport',
    normalizedQuestion: 'why are you a fit',
    category: 'custom_motivation_experience_narrative',
    semantic: 'custom_narrative',
    committedValue: null,
    committedValueHash: 'sha256:answer',
    selectedVisibleLabel: null,
    evidenceIds: ['warehouse-proof'],
    stepFingerprint: 'sha256:step',
  }];
  state.transientNarrativeAnswers = [{
    resolutionKey: 'resolution:transport-narrative',
    question: 'Why are you a fit?',
    normalizedQuestion: 'why are you a fit',
    preparedAnswer: 'Approved transient narrative answer.',
    templateId: 'role-fit-v1',
    evidenceIds: ['warehouse-proof'],
    category: 'custom_motivation_experience_narrative',
    semantic: 'custom_narrative',
  }];
  const verifierRequest = createSemanticVerifierRequest(state, []);
  const verifierRaw = await provider.verify(verifierRequest);
  assert.equal(validateSemanticVerifierResponse(verifierRaw, verifierRequest).disposition, 'pass');
  const verifierInput = JSON.parse(calls[1].body.messages[1].content);
  assert.equal(verifierInput.untrustedData.narrativeAnswers[0].preparedAnswer, 'Approved transient narrative answer.');
  assert.equal(calls[0].url, 'https://reasoning.test/v1/chat/completions');
});

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function withPage(html, fn) {
  const page = await browser.newPage();
  try { await page.setContent(html); return await fn(page); } finally { await page.close(); }
}

test('zero-call deterministic preparation completes and leaves final Submit untouched', async () => {
  let calls = 0;
  const provider = {
    identity: { provider: 'fake', model: 'fake-luna' },
    annotate: async () => { calls += 1; throw new Error('unexpected'); },
    verify: async () => { calls += 1; throw new Error('unexpected'); },
  };
  await withPage('<form><label>Email<input name="email" type="email" required></label><button type="submit">Submit application</button></form>', async (page) => {
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context, reasoningProvider: provider });
    assert.equal(calls, 0);
    assert.equal(result.evidence.reviewComplete, true);
    assert.equal(result.evidence.semanticVerification.disposition, 'not_required');
    assert.equal(result.evidence.finalAction.activated, false);
    assert.equal(await page.locator('input').inputValue(), 'alex@example.test');
  });
});

test('batched semantic fallback replans deterministically and conditional verifier passes once', async () => {
  let fallbackCalls = 0;
  let verifierCalls = 0;
  const provider = {
    identity: { provider: 'fake', model: 'fake-luna' },
    annotate: async (request) => {
      fallbackCalls += 1;
      return { schemaVersion: 1, annotations: request.fields.map((item, index) => ({
        resolutionKey: item.resolutionKey, kind: 'semantic_classification', semantic: index ? 'full_name' : 'email',
      })) };
    },
    verify: async () => { verifierCalls += 1; return { schemaVersion: 1, disposition: 'pass', findings: [] }; },
  };
  await withPage(`<form>
    <label>Correo de contacto<input id="correo" required></label>
    <label>Nombre completo de la persona candidata<input id="nombre" required></label>
    <button type="submit">Submit application</button></form>`, async (page) => {
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context, reasoningProvider: provider });
    assert.equal(fallbackCalls, 1);
    assert.equal(verifierCalls, 1);
    assert.equal(result.evidence.reasoning.calls.total, 2);
    assert.equal(result.evidence.reviewComplete, true);
    assert.equal(result.evidence.semanticVerification.disposition, 'passed');
    assert.deepEqual(await page.locator('input').evaluateAll((inputs) => inputs.map((input) => input.value)), ['alex@example.test', 'Alex Example']);
    assert.equal(result.evidence.finalAction.activated, false);
  });
});

test('malformed or action-bearing reasoning fails closed and cannot submit or mark review complete', async () => {
  const provider = {
    identity: { provider: 'fake', model: 'fake-luna' },
    annotate: async (request) => ({
      schemaVersion: 1,
      annotations: [{ resolutionKey: request.fields[0].resolutionKey, kind: 'semantic_classification', semantic: 'email', action: 'click Submit' }],
    }),
    verify: async () => ({ schemaVersion: 1, disposition: 'pass', findings: [] }),
  };
  await withPage('<form><label>Correo de contacto<input required></label><button type="submit">Submit application</button></form>', async (page) => {
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context, reasoningProvider: provider });
    assert.equal(result.evidence.reviewComplete, false);
    assert.equal(result.evidence.finalAction.activated, false);
    assert.equal(result.gate.state, 'review_required');
    assert.equal(result.evidence.reasoning.calls.verifier, 0);
  });
});

test('explicit option no-match leaves the required field unresolved without another model call', async () => {
  let fallbackCalls = 0;
  let verifierCalls = 0;
  const provider = {
    identity: { provider: 'fake', model: 'fake-luna' },
    annotate: async (request) => {
      fallbackCalls += 1;
      const requested = request.fields[0];
      return { schemaVersion: 1, annotations: [{
        resolutionKey: requested.resolutionKey,
        kind: 'option_mapping',
        canonicalValueHash: requested.canonicalValueHash,
        noSemanticMatch: true,
      }] };
    },
    verify: async () => { verifierCalls += 1; return { schemaVersion: 1, disposition: 'pass', findings: [] }; },
  };
  await withPage(`<form><label>How did you hear about us?<select required>
    <option value="">Choose</option><option value="conference">Industry conference</option>
    </select></label><button type="submit">Submit application</button></form>`, async (page) => {
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context, reasoningProvider: provider });
    assert.equal(fallbackCalls, 1);
    assert.equal(verifierCalls, 0);
    assert.equal(result.gate.state, 'review_required');
    assert.equal(result.evidence.reviewComplete, false);
    assert.ok(result.evidence.unresolvedFields.some((row) => row.reasonCode === 'reasoning_option_no_semantic_match'));
    assert.equal(result.evidence.finalAction.activated, false);
    const candidateState = { formPreparation: null, formPreparationHistory: [] };
    appendFormPreparationEvidence(candidateState, result.evidence);
    assert.equal(candidateState.formPreparation.reasoning.semanticResolutions[0].annotation.noSemanticMatch, true);
  });
});

test('final verifier receives narrative text transiently and distinguishes responsive from irrelevant grounded prose', async () => {
  const verifierRequests = [];
  const provider = {
    identity: { provider: 'fake', model: 'fake-luna' },
    annotate: async () => ({ schemaVersion: 1, annotations: [] }),
    verify: async (request) => {
      verifierRequests.push(structuredClone(request));
      const narrative = request.narrativeAnswers[0];
      if (/conflict/.test(narrative.normalizedQuestion) && !/conflict/.test(narrative.preparedAnswer.toLowerCase())) {
        return {
          schemaVersion: 1,
          disposition: 'review_required',
          findings: [{
            code: 'grounded_but_nonresponsive',
            resolutionKey: narrative.resolutionKey,
            message: 'The factual answer does not address the conflict question.',
            repair: null,
          }],
        };
      }
      return { schemaVersion: 1, disposition: 'pass', findings: [] };
    },
  };
  await withPage('<form><label>Describe how you resolved a team conflict<textarea required></textarea></label><button type="submit">Submit application</button></form>', async (page) => {
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context, reasoningProvider: provider });
    const transient = verifierRequests[0].narrativeAnswers[0];
    assert.match(transient.preparedAnswer, /Warehouse project/);
    assert.match(transient.question, /team conflict/);
    assert.equal(result.gate.state, 'review_required');
    assert.equal(result.evidence.reviewComplete, false);
    assert.equal(JSON.stringify(result.evidence.reasoning).includes(transient.preparedAnswer), false);
    assert.equal(result.evidence.answerRecords[0].factualSources[0].configuredEvidenceId, 'warehouse-proof');
  });
  await withPage('<form><label>Why are you a good fit for this data engineering role?<textarea required></textarea></label><button type="submit">Submit application</button></form>', async (page) => {
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context, reasoningProvider: provider });
    const transient = verifierRequests[1].narrativeAnswers[0];
    assert.match(transient.preparedAnswer, /Warehouse project/);
    assert.equal(result.evidence.semanticVerification.disposition, 'passed');
    assert.equal(result.evidence.reviewComplete, true);
    assert.equal(JSON.stringify(result.evidence.reasoning).includes(transient.preparedAnswer), false);
    assert.equal(result.evidence.finalAction.activated, false);
  });
});

test('narrative repair replaces superseded provenance and controlled resume reuses only the repaired answer', async () => {
  let answerA;
  const provider = {
    identity: { provider: 'fake', model: 'fake-luna' },
    annotate: async () => { throw new Error('deterministic narrative must not request fallback annotation'); },
    verify: async (request) => {
      const narrative = request.narrativeAnswers[0];
      answerA = narrative.preparedAnswer;
      return {
        schemaVersion: 1,
        disposition: 'review_required',
        findings: [{
          code: 'narrative_route_repair',
          resolutionKey: narrative.resolutionKey,
          message: 'Use the approved evidence-only narrative route.',
          repair: {
            resolutionKey: narrative.resolutionKey,
            kind: 'narrative_routing',
            templateId: 'role-fit-evidence-only-v1',
            topicIds: ['data_engineering'],
            evidenceIds: ['warehouse-proof'],
          },
        }],
      };
    },
  };
  const question = 'Why are you a good fit for this data engineering role?';
  await withPage(`<form><label>${question}<textarea id="why-fit" required></textarea></label>
    <button id="final-submit" type="submit">Submit application</button></form>
    <script>document.querySelector('form').addEventListener('submit',event=>{window.finalSubmits=(window.finalSubmits||0)+1;event.preventDefault();});</script>`, async (page) => {
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context, reasoningProvider: provider });
    const answerB = await page.locator('#why-fit').inputValue();
    assert.ok(answerA);
    assert.notEqual(answerB, answerA);
    assert.equal(result.evidence.semanticVerification.repair.outcome, 'executed_and_fresh_reviewed');
    assert.equal(result.evidence.semanticVerification.disposition, 'passed');
    assert.equal(result.evidence.reviewComplete, true);
    assert.equal(result.evidence.finalAction.activated, false);
    assert.equal(await page.evaluate(() => window.finalSubmits || 0), 0);

    const normalizedQuestion = 'why are you a good fit for this data engineering role';
    const active = result.evidence.answerRecords.filter((record) => (
      record.candidateId === candidate.candidate_id && record.normalizedQuestion === normalizedQuestion
    ));
    assert.equal(active.length, 1);
    assert.equal(active[0].answer, answerB);
    assert.notEqual(active[0].answer, answerA);
    assert.equal(active[0].templateId, 'role-fit-evidence-only-v1');
    assert.match(active[0].answerHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(active[0].factualSources[0].configuredEvidenceId, 'warehouse-proof');
    assert.match(active[0].factualSources[0].sourceHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(active[0].factualSources[0].evidenceHash, /^sha256:[a-f0-9]{64}$/);

    const resumeField = field({
      id: 'why-fit-resume', label: question, tag: 'textarea', type: 'textarea', maxLength: 500,
    });
    const resumed = buildOperationalFormPlan(snapshot([resumeField]), profile, {}, {
      context,
      previousEvidence: { answerRecords: result.evidence.answerRecords },
    });
    assert.equal(resumed.actions.length, 1);
    assert.equal(resumed.actions[0].value, answerB);
    assert.notEqual(resumed.actions[0].value, answerA);
    assert.equal(resumed.answerRecords.length, 1);
    assert.equal(resumed.answerRecords[0].wording, 'reused');
    assert.equal(resumed.answerRecords[0].answerHash, active[0].answerHash);
    assert.equal(JSON.stringify(result.evidence.reasoning).includes(answerB), false);
  });
});

test('unsupported narrative intent stays unresolved when the provider declines to route it', async () => {
  let fallbackCalls = 0;
  const provider = {
    identity: { provider: 'fake', model: 'fake-luna' },
    annotate: async () => { fallbackCalls += 1; return { schemaVersion: 1, annotations: [] }; },
    verify: async () => { throw new Error('verifier must not run'); },
  };
  await withPage('<form><label>Discuss an unsupported personal preference<textarea required></textarea></label><button type="submit">Submit application</button></form>', async (page) => {
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context, reasoningProvider: provider });
    assert.equal(fallbackCalls, 1);
    assert.equal(result.gate.state, 'review_required');
    assert.equal(result.evidence.reviewComplete, false);
    assert.equal(result.evidence.finalAction.activated, false);
  });
});

test('one live-field verifier repair is recompiled and freshly reviewed', async () => {
  const provider = {
    identity: { provider: 'fake', model: 'fake-luna' },
    annotate: async (request) => ({ schemaVersion: 1, annotations: [{
      resolutionKey: request.fields[0].resolutionKey, kind: 'semantic_classification', semantic: 'email',
    }] }),
    verify: async (request) => ({
      schemaVersion: 1,
      disposition: 'review_required',
      findings: [{
        code: 'wrong_semantic',
        resolutionKey: request.preparedAnswers[0].resolutionKey,
        message: 'The field asks for the full candidate name.',
        repair: {
          resolutionKey: request.preparedAnswers[0].resolutionKey,
          kind: 'semantic_classification',
          semantic: 'full_name',
        },
      }],
    }),
  };
  await withPage('<form><label>Identificación de la persona<input id="identity" required></label><button type="submit">Submit application</button></form>', async (page) => {
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context, reasoningProvider: provider });
    assert.equal(await page.locator('#identity').inputValue(), 'Alex Example');
    assert.equal(result.evidence.semanticVerification.repair.attempted, true);
    assert.equal(result.evidence.semanticVerification.repair.outcome, 'executed_and_fresh_reviewed');
    assert.equal(result.evidence.reviewComplete, true);
    assert.equal(result.evidence.finalAction.activated, false);
  });
});

test('conditional fields exposed by the sole repair fail the mandatory fresh deterministic review', async () => {
  const provider = {
    identity: { provider: 'fake', model: 'fake-luna' },
    annotate: async (request) => ({ schemaVersion: 1, annotations: [{
      resolutionKey: request.fields[0].resolutionKey, kind: 'semantic_classification', semantic: 'email',
    }] }),
    verify: async (request) => ({
      schemaVersion: 1,
      disposition: 'review_required',
      findings: [{ code: 'wrong_semantic', resolutionKey: request.preparedAnswers[0].resolutionKey, message: 'Use the full name.', repair: {
        resolutionKey: request.preparedAnswers[0].resolutionKey, kind: 'semantic_classification', semantic: 'full_name',
      } }],
    }),
  };
  await withPage(`<form><label>Identificación de la persona<input id="identity" required></label><button type="submit">Submit application</button></form>
    <script>identity.addEventListener('input',()=>{if(identity.value.includes(' ')&&!document.querySelector('#conditional')){const l=document.createElement('label');l.textContent='Unfamiliar follow-up';l.innerHTML+='<input id="conditional" required>';identity.after(l);}})</script>`, async (page) => {
    const result = await prepareOperationalApplicationForm(page, profile, {}, { context, reasoningProvider: provider });
    assert.equal(result.evidence.reviewComplete, false);
    assert.equal(result.evidence.semanticVerification.disposition, 'review_required');
    assert.equal(result.evidence.semanticVerification.repair.outcome, 'fresh_deterministic_review_failed');
    assert.equal(result.gate.state, 'review_required');
    assert.equal(result.evidence.finalAction.activated, false);
  });
});
