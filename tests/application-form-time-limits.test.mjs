import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIVE_FORM_LIMITS,
  actionAttemptLimitMs,
  buildOperationalFormPlan,
  executeOperationalFormPlan,
  resolveOperationalFormLimits,
} from '../application-form-engine.mjs';
import { attachFactualSources } from './fixtures/application-evidence-profile.mjs';

const fakePage = { evaluate: async () => {} };

function action(id, kind = 'fill') {
  return {
    fieldId: id,
    stableFieldId: `stable:${id}`,
    label: id,
    category: kind === 'upload' ? 'file_upload' : 'identity_contact',
    semantic: kind === 'upload' ? 'cv_upload' : id,
    action: kind,
    value: id,
    valueHash: `sha256:${id}`,
    artifact: kind === 'upload'
      ? { intendedFilename: 'CV.pdf', sha256: 'sha256:cv' }
      : null,
  };
}

test('default and profile-configured limits map to normal, choice, and upload attempts', () => {
  assert.deepEqual(DEFAULT_LIVE_FORM_LIMITS, {
    sessionMs: 300_000,
    normalFieldMs: 10_000,
    choiceMs: 20_000,
    uploadMs: 30_000,
    maxAttempts: 2,
  });
  const configured = resolveOperationalFormLimits({
    formRules: {
      time_limits: {
        session_seconds: 12,
        normal_field_seconds: 3,
        dropdown_autocomplete_seconds: 4,
        upload_seconds: 5,
        max_attempts: 9,
      },
    },
  });
  assert.equal(configured.sessionMs, 12_000);
  assert.equal(configured.maxAttempts, 2);
  assert.equal(actionAttemptLimitMs(action('name'), configured), 3_000);
  assert.equal(actionAttemptLimitMs(action('country', 'select'), configured), 4_000);
  assert.equal(actionAttemptLimitMs(action('city', 'autocomplete'), configured), 4_000);
  assert.equal(actionAttemptLimitMs(action('cv', 'upload'), configured), 5_000);
  assert.deepEqual(resolveOperationalFormLimits({}, {
    sessionMs: 999_999,
    normalFieldMs: 99_999,
    choiceMs: 99_999,
    uploadMs: 99_999,
    maxAttempts: 9,
  }), DEFAULT_LIVE_FORM_LIMITS);
});

test('a field attempt timeout retries at most twice and leaves only that field unresolved', async () => {
  const plan = {
    actions: [action('email')],
    preservedFields: [],
    preservedUploads: [],
    formFingerprint: 'form:timeout',
  };
  const result = await executeOperationalFormPlan(fakePage, plan, {
    limits: {
      sessionMs: 1_000,
      normalFieldMs: 5,
      choiceMs: 20,
      uploadMs: 30,
      maxAttempts: 2,
    },
    performActionImpl: async () => new Promise((resolve) => setTimeout(() => resolve('late'), 30)),
  });
  assert.equal(result.completed.length, 0);
  assert.equal(result.unresolvedFields.length, 1);
  assert.equal(result.attemptLedger.length, 2);
  assert.ok(result.attemptLedger.every((row) => row.limitReached === 'FIELD_ATTEMPT_TIMEOUT'));
  assert.equal(result.sessionLimitReached, false);
});

test('the session cap preserves completed fields and uploads and marks only pending fields unresolved', async () => {
  let clockMs = 0;
  const invoked = [];
  const plan = {
    actions: [action('name'), action('cv', 'upload'), action('phone')],
    preservedFields: [],
    preservedUploads: [],
    formFingerprint: 'form:session-cap',
  };
  const result = await executeOperationalFormPlan(fakePage, plan, {
    clock: () => clockMs,
    limits: {
      sessionMs: 40,
      normalFieldMs: 100,
      choiceMs: 100,
      uploadMs: 100,
      maxAttempts: 2,
    },
    performActionImpl: async (_page, current) => {
      invoked.push(current.fieldId);
      clockMs += 20;
      return current.action === 'upload' ? current.artifact.intendedFilename : current.value;
    },
  });
  assert.deepEqual(invoked, ['name', 'cv']);
  assert.deepEqual(result.completed.map((row) => row.fieldId), ['name', 'cv']);
  assert.equal(result.uploadedArtifacts.length, 1);
  assert.deepEqual(result.unresolvedFields.map((row) => row.fieldId), ['phone']);
  assert.equal(result.sessionLimitReached, true);
});

test('custom narrative answers are precomputed in the plan before browser execution', () => {
  const profile = attachFactualSources({
    candidate: {},
    location: {},
    currentStatus: {},
    education: {},
    compensation: {},
    answers: new Map(),
    cvText: 'I built a grounded backend project using APIs and PostgreSQL.',
    articleDigestText: '',
    answerBankText: '',
    profileModeText: '',
    formRules: {
      narrative_evidence: [{
        id: 'fictional-backend-project',
        topics: ['software_backend'],
        provenance: [{ sourceType: 'cv', locator: 'lines:1' }],
      }],
    },
  });
  const plan = buildOperationalFormPlan({
    fields: [{
      fieldId: 'why',
      id: 'why',
      label: 'Why are you a good fit for this backend role?',
      questionText: 'Why are you a good fit for this backend role?',
      tag: 'textarea',
      type: 'textarea',
      visible: true,
      required: true,
      disabled: false,
      value: '',
      options: [],
      maxLength: 500,
    }],
    controls: [],
  }, profile, {}, {
    context: {
      candidate: { candidate_id: 'candidate-1', company: 'Acme', title: 'Backend Engineer' },
      jdText: 'Backend APIs and PostgreSQL',
    },
  });
  assert.equal(plan.answerRecords.length, 1);
  assert.match(plan.actions[0].value, /backend project using APIs and PostgreSQL/);
});
