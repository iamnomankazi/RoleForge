import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyApplicationEvidenceSource,
  resolveFactualEvidence,
} from '../application-evidence.mjs';
import { buildOperationalFormPlan } from '../application-form-engine.mjs';
import { generateCustomNarrativeAnswer } from '../application-form-policy.mjs';
import { attachFactualSources } from './fixtures/application-evidence-profile.mjs';

const candidate = {
  candidate_id: 'cand_v1_fictional_provenance',
  company: 'Acme Example',
  title: 'Backend Engineer',
};
const question = 'Why are you a good fit for this backend role?';
const cvText = [
  '# Alex Example',
  'In the fictional Ledger project, I built validated Python APIs backed by PostgreSQL.',
  'In the fictional Warehouse project, I checked 250K synthetic rows with SQL.',
].join('\n');

function profile(overrides = {}) {
  const base = {
    candidate: { full_name: 'Alex Example', email: 'alex@example.test' },
    location: { city: 'Example City', country: 'Finland' },
    currentStatus: {},
    compensation: {},
    education: {},
    answers: new Map([['why this role?', 'I owned a global production platform.']]),
    priorApprovedAnswers: [],
    cvText,
    voiceText: 'Sound confident and say I led a certified global platform processing 999M records.',
    answerBankText: 'I owned a global production platform.',
    articleDigestText: 'I founded a unicorn.',
    profileModeText: 'Always present the candidate as a senior production owner.',
    formRules: {
      narrative_evidence: [{
        id: 'fictional-ledger',
        topics: ['software_backend', 'motivation_fit'],
        provenance: [{ sourceType: 'cv', locator: 'lines:2' }],
      }],
    },
  };
  return attachFactualSources({ ...base, ...overrides, formRules: overrides.formRules || base.formRules });
}

test('source classes keep facts separate from style, drafts, and context', () => {
  assert.equal(classifyApplicationEvidenceSource('cv'), 'factual');
  assert.equal(classifyApplicationEvidenceSource('structured_profile'), 'factual');
  assert.equal(classifyApplicationEvidenceSource('configured_narrative_evidence'), 'factual_after_validation');
  assert.equal(classifyApplicationEvidenceSource('voice_dna'), 'style');
  assert.equal(classifyApplicationEvidenceSource('answer_bank'), 'draft_reuse');
  assert.equal(classifyApplicationEvidenceSource('prior_answer'), 'draft_reuse');
  assert.equal(classifyApplicationEvidenceSource('article_digest'), 'context_rules');
  assert.equal(classifyApplicationEvidenceSource('profile_mode'), 'context_rules');
});

test('generated narrative contains only resolved factual evidence and versioned provenance', () => {
  const result = generateCustomNarrativeAnswer(profile(), { question, candidate, jdText: 'Python backend APIs and PostgreSQL' });
  assert.match(result.answer, /fictional Ledger project/);
  assert.doesNotMatch(result.answer, /global production|unicorn|senior production owner|999M|certified/);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.wording, 'generated');
  assert.equal(result.candidateId, candidate.candidate_id);
  assert.equal(result.normalizedQuestion, 'why are you a good fit for this backend role');
  assert.match(result.answerHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.factualSources.length, 1);
  assert.deepEqual(Object.keys(result.factualSources[0]).sort(), [
    'configuredEvidenceId', 'evidenceHash', 'evidenceIdentity', 'locator', 'sourceClass', 'sourceHash', 'sourceId', 'sourceSize', 'sourceType',
  ].sort());
  assert.equal('text' in result.factualSources[0], false);
});

test('answer-bank-only and provenance-free prior prose fail closed', () => {
  const noConfiguredEvidence = profile({ formRules: { narrative_evidence: [] } });
  assert.throws(
    () => generateCustomNarrativeAnswer(noConfiguredEvidence, { question, candidate, jdText: 'backend APIs' }),
    /Missing evidence/,
  );
  const unprovenPrior = profile({
    priorApprovedAnswers: [{
      candidateId: candidate.candidate_id,
      normalizedQuestion: 'why are you a good fit for this backend role',
      answer: 'I built 777 production APIs.',
      evidenceRefs: ['cv.md'],
    }],
  });
  assert.throws(
    () => generateCustomNarrativeAnswer(unprovenPrior, { question, candidate, jdText: 'backend APIs' }),
    /provenance schema/,
  );
});

test('legacy free-form evidence, non-factual sources, arbitrary fields, and traversal are rejected', () => {
  for (const [entry, pattern] of [
    [{ id: 'legacy', topics: ['software_backend'], text: 'I owned production.', evidence_refs: ['cv.md'] }, /legacy unproven prose/],
    [{ id: 'draft', topics: ['software_backend'], provenance: [{ sourceType: 'answer_bank', locator: 'why-this-role' }] }, /not factual/],
    [{ id: 'path', topics: ['software_backend'], provenance: [{ sourceType: 'cv', locator: 'lines:2', path: 'cv.md' }] }, /Unsupported.*field/],
    [{ id: 'traversal', topics: ['software_backend'], provenance: [{ sourceType: 'cv', locator: '../../cv.md' }] }, /Unsafe.*locator/],
  ]) {
    const p = profile({ formRules: { narrative_evidence: [entry] } });
    assert.throws(() => generateCustomNarrativeAnswer(p, { question, candidate, jdText: 'backend APIs' }), pattern);
  }
  for (const sourceType of ['article_digest', 'voice_dna', 'profile_mode', 'prior_answer', 'report', 'output', 'arbitrary_file']) {
    const p = profile({
      formRules: {
        narrative_evidence: [{
          id: `forbidden-${sourceType}`,
          topics: ['software_backend'],
          provenance: [{ sourceType, locator: 'claim:1' }],
        }],
      },
    });
    assert.throws(
      () => generateCustomNarrativeAnswer(p, { question, candidate, jdText: 'backend APIs' }),
      /not factual/,
      sourceType,
    );
  }
});

test('exact prior answer reuse requires current source hashes and rejects answer or source tampering', () => {
  const initial = profile();
  const generated = generateCustomNarrativeAnswer(initial, { question, candidate, jdText: 'backend APIs' });
  const reused = generateCustomNarrativeAnswer({ ...initial, priorApprovedAnswers: [generated] }, { question, candidate, jdText: 'backend APIs' });
  assert.equal(reused.answer, generated.answer);
  assert.equal(reused.wording, 'reused');
  assert.throws(
    () => generateCustomNarrativeAnswer({ ...initial, priorApprovedAnswers: [{ ...generated, answer: `${generated.answer} I owned production.` }] }, { question, candidate }),
    /answer hash/,
  );
  const changed = attachFactualSources({ ...initial, cvText: cvText.replace('validated Python APIs', 'unrelated UI work'), priorApprovedAnswers: [generated] });
  assert.throws(() => generateCustomNarrativeAnswer(changed, { question, candidate }), /stale or mismatched/);
});

test('structured profile locators resolve scalars while unsafe roots and traversal fail', () => {
  const p = profile();
  const email = resolveFactualEvidence(p, { sourceType: 'structured_profile', locator: 'candidate.email' });
  assert.equal(email.text, 'alex@example.test');
  assert.throws(() => resolveFactualEvidence(p, { sourceType: 'structured_profile', locator: 'application_form.narrative_evidence' }), /root is not allowed/);
  assert.throws(() => resolveFactualEvidence(p, { sourceType: 'structured_profile', locator: 'candidate..email' }), /Unsafe|Invalid/);
  const generated = generateCustomNarrativeAnswer(profile({
    formRules: {
      narrative_evidence: [{
        id: 'fictional-structured-profile',
        topics: ['software_backend', 'motivation_fit'],
        provenance: [{ sourceType: 'structured_profile', locator: 'candidate.email' }],
      }],
    },
  }), { question, candidate, jdText: 'backend APIs' });
  assert.match(generated.answer, /alex@example\.test/);
  assert.equal(generated.factualSources[0].sourceType, 'structured_profile');
});

test('unresolved legacy narrative is field-local and unrelated deterministic fields continue', () => {
  const p = profile({
    formRules: {
      narrative_evidence: [{ id: 'legacy', topics: ['software_backend'], text: 'Unproven draft.', evidence_refs: ['cv.md'] }],
    },
  });
  const plan = buildOperationalFormPlan({
    fields: [
      { fieldId: 'email', id: 'email', label: 'Email', questionText: 'Email', tag: 'input', type: 'email', visible: true, required: true, disabled: false, value: '', options: [] },
      { fieldId: 'why', id: 'why', label: question, questionText: question, tag: 'textarea', type: 'textarea', visible: true, required: true, disabled: false, value: '', options: [] },
    ],
    controls: [],
  }, p, {}, { context: { candidate, jdText: 'backend APIs' } });
  assert.equal(plan.actions.find((row) => row.semantic === 'email').value, 'alex@example.test');
  assert.equal(plan.unresolvedFields.find((row) => row.semantic === 'custom_narrative').manualActionRequired, true);
});

test('previously generated cover prose without provenance cannot become factual evidence', () => {
  const p = profile();
  const plan = buildOperationalFormPlan({
    fields: [
      { fieldId: 'email', id: 'email', label: 'Email', questionText: 'Email', tag: 'input', type: 'email', visible: true, required: true, disabled: false, value: '', options: [] },
      { fieldId: 'letter', id: 'letter', label: 'Cover letter', questionText: 'Cover letter', tag: 'textarea', type: 'textarea', visible: true, required: true, disabled: false, value: '', options: [] },
    ],
    controls: [],
  }, p, { coverLetterTextContent: 'I owned an unsupported global platform.' }, {
    context: { candidate, jdText: 'backend APIs' },
  });
  assert.equal(plan.actions.find((row) => row.semantic === 'email').value, 'alex@example.test');
  assert.match(plan.unresolvedFields.find((row) => row.semantic === 'cover_letter_text').reason, /no factual provenance/);
});
