import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKER_CODES, FLAG_CODES, fitBand, deriveAssessment, validateMachineSummary, parseReportMachineSummary } from '../assessment-contract.mjs';

const summary = (extra = {}) => ({ company: 'Example', role: 'Backend Developer', fit_score: 4.2, blockers: [], flags: [], liveness: 'confirmed', location_country: 'Finland', ...extra });
const evidence = (code) => ({ code, evidence: 'Synthetic JD requirement or profile fact', detail: 'Synthetic explanation' });

test('fit bands and actions at all boundaries, with compatible buckets', () => {
  for (const [fit_score, fit_band, action, bucket] of [
    [1, 'weak', 'skip', 'Stretch Credible'], [3.49, 'weak', 'skip', 'Stretch Credible'],
    [3.5, 'possible', 'review', 'Stretch Credible'], [3.99, 'possible', 'review', 'Stretch Credible'],
    [4, 'good', 'apply', 'Viable Apply'], [4.49, 'good', 'apply', 'Viable Apply'],
    [4.5, 'strong', 'apply', 'Strong Match'], [5, 'strong', 'apply', 'Strong Match'],
  ]) {
    assert.equal(fitBand(fit_score), fit_band);
    assert.deepEqual(deriveAssessment(summary({ fit_score, review_reason: 'Check fit with the hiring team.' })), { fit_band, action, bucket, errors: [] });
  }
});

test('every blocker skips even with strong technical fit; score is not reduced', () => {
  assert.deepEqual(BLOCKER_CODES, ['language_required', 'work_auth_restricted', 'location_ineligible', 'graduation_window', 'experience_outside', 'seniority_title', 'profile_exclusion', 'skill_gap_hard', 'posting_closed']);
  for (const code of BLOCKER_CODES) {
    const result = deriveAssessment(summary({ fit_score: 5, blockers: [evidence(code)], liveness: code === 'posting_closed' ? 'unconfirmed' : 'confirmed' }));
    assert.deepEqual(result, { fit_band: 'strong', action: 'skip', bucket: 'Blocked', errors: [] });
  }
});

test('flags are non-blocking; sponsorship unknown can apply', () => {
  assert.deepEqual(FLAG_CODES, ['sponsorship_unknown', 'liveness_unconfirmed', 'experience_stretch', 'language_preferred']);
  for (const code of FLAG_CODES.filter((value) => value !== 'liveness_unconfirmed')) {
    assert.equal(validateMachineSummary(summary({ flags: [evidence(code)] })).action, 'apply');
    assert.equal(validateMachineSummary(summary({ flags: [evidence(code)] })).valid, true);
  }
});

test('unconfirmed liveness caps high fits at review, but weak fit still skips', () => {
  for (const fit_score of [3.5, 4, 4.5, 5]) {
    const result = validateMachineSummary(summary({ fit_score, liveness: 'unconfirmed', flags: [evidence('liveness_unconfirmed')], review_reason: 'Confirm the posting is active.' }));
    assert.equal(result.action, 'review');
    assert.equal(result.valid, true);
  }
  assert.equal(deriveAssessment(summary({ fit_score: 3.49, liveness: 'unconfirmed' })).action, 'skip');
  assert.equal(deriveAssessment(summary({ liveness: 'unconfirmed', review_reason: 'Verify posting.' })).action, 'review');
});

test('review requires a non-empty one-line reason', () => {
  for (const review_reason of [undefined, null, '', '  ', 42, 'First line\nSecond line', 'First\rSecond']) {
    const result = validateMachineSummary(summary({ fit_score: 3.5, review_reason }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('review_reason')));
  }
  assert.equal(validateMachineSummary(summary({ fit_score: 3.5, review_reason: 'Confirm whether the team accepts the experience stretch.' })).valid, true);
  assert.equal(validateMachineSummary(summary({ fit_score: 3 })).valid, true);
});

test('rejects unknown or mistyped codes and missing evidence or invalid detail', () => {
  for (const key of ['blockers', 'flags']) {
    const code = key === 'blockers' ? BLOCKER_CODES[0] : FLAG_CODES[0];
    for (const entry of [{ code: 'invented', evidence: 'JD quote' }, { code }, { code, evidence: ' ' }, { code, evidence: 123 }, { code, evidence: 'quote', detail: 123 }, 'free text', null]) {
      assert.equal(validateMachineSummary(summary({ [key]: [entry] })).valid, false);
    }
    assert.equal(validateMachineSummary(summary({ [key]: null })).valid, false);
    assert.equal(validateMachineSummary(summary({ [key]: 'free text' })).valid, false);
    assert.equal(validateMachineSummary(summary({ [key]: [evidence(key === 'blockers' ? FLAG_CODES[0] : BLOCKER_CODES[0])] })).valid, false);
  }
});

test('invalid fit scores and required machine fields are rejected', () => {
  for (const fit_score of [0.99, 5.01, NaN, Infinity, '4.2', null, undefined]) {
    assert.equal(fitBand(fit_score), null);
    assert.equal(validateMachineSummary(summary({ fit_score })).valid, false);
  }
  for (const key of ['company', 'role', 'location_country', 'blockers', 'flags', 'liveness', 'fit_score']) {
    const input = summary();
    delete input[key];
    assert.equal(validateMachineSummary(input).valid, false, key);
  }
  for (const input of [null, [], 'summary']) assert.equal(validateMachineSummary(input).valid, false);
});

test('rejects contradictory decisions, liveness, and legacy decision aliases', () => {
  for (const extra of [{ action: 'skip' }, { bucket: 'Blocked' }, { fit_band: 'weak' }, { score: 4.2 }, { final_decision: 'Apply' }, { hard_blockers: [] }, { application_worthy: true }]) {
    assert.equal(validateMachineSummary(summary(extra)).valid, false);
  }
  assert.equal(validateMachineSummary(summary({ action: 'apply', fit_band: 'good', bucket: 'Viable Apply' })).valid, true);
  assert.equal(validateMachineSummary(summary({ flags: [evidence('liveness_unconfirmed')], review_reason: 'Confirm posting.' })).valid, false);
  assert.equal(validateMachineSummary(summary({ blockers: [evidence('posting_closed')] })).valid, false);
  assert.equal(validateMachineSummary(summary({ liveness: 'maybe' })).valid, false);
});

test('pre-screen blockers and flags are merged without mutation', () => {
  const input = summary({ prescreen: { blockers: [evidence('graduation_window')], flags: [evidence('sponsorship_unknown')] } });
  const original = structuredClone(input);
  assert.equal(validateMachineSummary(input).action, 'skip');
  assert.equal(validateMachineSummary(input).valid, true);
  assert.deepEqual(input, original);
  assert.equal(validateMachineSummary(summary({ prescreen: { blockers: [], flags: [evidence('experience_stretch')] } })).action, 'apply');
  assert.equal(validateMachineSummary(summary({ prescreen: { blockers: [{ code: 'new', evidence: 'quote' }], flags: [] } })).valid, false);
});

test('modern fenced and indented summaries parse and validate', () => {
  const body = 'company: Example\nrole: Developer\nfit_score: 4.5\nblockers: []\nflags: []\nliveness: confirmed\nlocation_country: FI';
  for (const markdown of [`## Machine Summary\n\n\`\`\`yaml\n${body}\n\`\`\`\n## A) Role`, `#### Machine Summary\n\n${body.split('\n').map((line) => `    ${line}`).join('\n')}\n\n## A) Role`]) {
    const parsed = parseReportMachineSummary(markdown);
    assert.equal(parsed.legacy, false);
    assert.equal(validateMachineSummary(parsed).valid, true);
  }
});

test('legacy free-text blockers stay legacy without invented codes', () => {
  const body = 'company: Example\nrole: Developer\nscore: 4.5\nbucket: Blocked\napplication_worthy: false\nblockers:\n  - Must speak German';
  for (const markdown of [`## Machine Summary\n\n\`\`\`yaml\n${body}\n\`\`\``, `## Machine Summary\n\n${body.split('\n').map((line) => `    ${line}`).join('\n')}\n\n---\n\n## A) Role`, `## Machine Summary\n\n${body.split('\n').map((line) => `    ${line}`).join('\n')}\n\nSource evidence: [Q1] [Q2]\n\n## A) Role`]) {
    const parsed = parseReportMachineSummary(markdown);
    assert.equal(parsed.legacy, true);
    assert.deepEqual(parsed.blockers, ['Must speak German']);
    assert.equal(parsed.fit_score, undefined);
    assert.equal(validateMachineSummary(parsed).valid, false);
  }
});

test('missing, malformed, duplicate-key, and partial new summaries fail validation', () => {
  assert.equal(parseReportMachineSummary('# No summary'), null);
  for (const markdown of ['## Machine Summary\n\`\`\`yaml\ncompany: Example', '## Machine Summary\n\`\`\`yaml\nfoo: [\n\`\`\`', '## Machine Summary\n\`\`\`yaml\ncompany: One\ncompany: Two\n\`\`\`', '## Machine Summary\n\`\`\`yaml\nflags: []\n\`\`\`']) {
    const parsed = parseReportMachineSummary(markdown);
    assert.equal(parsed.legacy, false);
    assert.equal(validateMachineSummary(parsed).valid, false);
  }
});
