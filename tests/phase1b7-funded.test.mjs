import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import yaml from 'js-yaml';

import { buildScanRelevanceEvaluator } from '../scan.mjs';
import { loadProviders, resolveProvider } from '../providers/_registry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = resolve(ROOT, 'output/phase1b7-evidence-20261001');
const evidenceAvailable = existsSync(EVIDENCE_DIR);
const evidence = evidenceAvailable ? JSON.parse(readFileSync(resolve(EVIDENCE_DIR, 'C-funded-delta.json'), 'utf8')) : null;
const baselineText = evidenceAvailable ? readFileSync(resolve(EVIDENCE_DIR, 'C-portals-preimage.yml'), 'utf8') : '';
const currentText = evidenceAvailable ? readFileSync(resolve(ROOT, 'portals.yml'), 'utf8') : '';
const baseline = evidenceAvailable ? yaml.load(baselineText) : null;
const current = evidenceAvailable ? yaml.load(currentText) : null;
const PHASE2_TITLE_POSITIVE_ALIASES = [
  'Computer Vision Engineer',
  'Fullstack Entwickler',
  'Werkstudent*In Data & Automation',
  'Working Student - AI Platform and Enablement',
];

function removeApprovedPhase2TitleAliases(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const titleFilterAt = text.indexOf('title_filter:');
  const positiveAt = text.indexOf(`  positive:${newline}`, titleFilterAt);
  const negativeAt = text.indexOf(`  negative:${newline}`, positiveAt);
  assert.notEqual(titleFilterAt, -1, 'title_filter must exist');
  assert.notEqual(positiveAt, -1, 'title_filter.positive must exist');
  assert.notEqual(negativeAt, -1, 'title_filter.negative must terminate the positive list');

  let positiveBlock = text.slice(positiveAt, negativeAt);
  for (const alias of PHASE2_TITLE_POSITIVE_ALIASES) {
    const exactLine = `    - ${JSON.stringify(alias)}${newline}`;
    const occurrences = positiveBlock.split(exactLine).length - 1;
    assert.equal(occurrences, 1, `the exact approved alias line must appear once in title_filter.positive: ${alias}`);
    positiveBlock = positiveBlock.replace(exactLine, '');
  }
  return `${text.slice(0, positiveAt)}${positiveBlock}${text.slice(negativeAt)}`;
}

const currentTextWithoutPhase2Aliases = evidenceAvailable ? removeApprovedPhase2TitleAliases(currentText) : '';
const currentWithoutPhase2Aliases = evidenceAvailable ? yaml.load(currentTextWithoutPhase2Aliases) : null;

function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function findRole(pattern) {
  return evidence.isarRoleEvidence.find(item => pattern.test(item.title));
}

function skipIfEvidenceMissing(t) {
  if (evidenceAvailable) return false;
  t.skip('phase1b7 evidence directory is missing; funded-company evidence checks require the archived fixtures');
  return true;
}

test('Isar funding and current board support one review-required useful entry', (t) => {
  if (skipIfEvidenceMissing(t)) return;
  const decision = evidence.decisions.find(item => item.company === 'Isar Aerospace');
  assert.equal(decision?.decision, 'add');

  const funding = evidence.fundingSourceSnapshots.find(item => item.url === decision.fundingUrl);
  assert.ok(funding, 'official funding source snapshot is retained');
  assert.match(funding.excerpt, /EUR 270m Series D/i);

  const board = evidence.boardSnapshots.find(item => item.url === decision.api || item.url.startsWith(`${decision.api}?`));
  assert.equal(board?.evidenceClass, 'A');
  assert.equal(board?.jobCount, 104);

  const applicationSoftware = findRole(/Application Software Engineer/i);
  assert.ok(applicationSoftware);
  assert.equal(applicationSoftware.searchRelevanceResult.eligible, true);
  assert.equal(applicationSoftware.applicationEligibilityAssessment.status, 'review_required');
  assert.match(evidence.portalsEntry.notes, /^REVIEW REQUIRED/);
  assert.match(evidence.portalsEntry.notes, /mandatory question.*enrollment.*Germany/i);
  assert.match(evidence.portalsEntry.notes, /University of Eastern Finland, Finland/);
  assert.match(evidence.portalsEntry.notes, /German work authorization\/sponsorship/);
  assert.match(evidence.portalsEntry.notes, /No eligibility or sponsorship is inferred/i);
});

test('current provider resolves and unchanged evaluator records search relevance only', async (t) => {
  if (skipIfEvidenceMissing(t)) return;
  const providers = await loadProviders(resolve(ROOT, 'providers'));
  const resolved = resolveProvider(evidence.portalsEntry, providers);
  assert.equal(resolved?.provider?.id, 'greenhouse');
  assert.deepEqual(resolved.provider.detect(evidence.portalsEntry), {
    url: evidence.providerResolution.detectedUrl,
  });

  const evaluate = buildScanRelevanceEvaluator(current);
  const studentSoftware = findRole(/Working Student Software Engineer/i);
  const applicationSoftware = findRole(/Application Software Engineer/i);
  const analyst = findRole(/Environmental Data Analyst/i);

  for (const role of [studentSoftware, applicationSoftware, analyst]) {
    assert.ok(role);
    const result = evaluate({
      title: role.title,
      location: role.location,
      description: role.evaluatorFixtureDescription,
      company: 'Isar Aerospace',
      url: role.url,
    });
    assert.equal(result.eligible, role.searchRelevanceResult.eligible, `${role.title} relevance evidence must match the unchanged evaluator`);
    assert.equal(result.locationEligibility.status, role.searchRelevanceResult.locationStatus);
  }

  assert.equal(studentSoftware.searchRelevanceResult.eligible, true);
  assert.equal(applicationSoftware.searchRelevanceResult.eligible, true);
  assert.equal(analyst.searchRelevanceResult.eligible, false);
  assert.equal(analyst.searchRelevanceResult.reason, 'content');
});

test('mandatory Germany-enrollment question is not confused with search relevance', (t) => {
  if (skipIfEvidenceMissing(t)) return;
  const studentSoftware = findRole(/Working Student Software Engineer/i);
  assert.equal(studentSoftware.searchRelevanceResult.eligible, true, 'title/location/content relevance is still recorded accurately');
  assert.equal(studentSoftware.searchRelevanceResult.interpretation.includes('does not establish application eligibility'), true);

  assert.equal(evidence.applicationFormEvidence.mandatory, true);
  assert.equal(
    evidence.applicationFormEvidence.question,
    'Are you currently enrolled in a bachelor\u2019s or master\u2019s program in Germany?'
  );
  assert.equal(
    studentSoftware.applicationEligibilityAssessment.status,
    'not_supported_by_recorded_profile'
  );
  assert.match(studentSoftware.applicationEligibilityAssessment.finding, /University of Eastern Finland in Finland/);
  assert.match(studentSoftware.applicationEligibilityAssessment.finding, /do not treat this posting as eligible/i);

  assert.equal(evidence.userEligibilityContext.locationCountry, 'Finland');
  assert.match(evidence.userEligibilityContext.currentStatusSummary, /University of Eastern Finland/);

  const applicationSoftware = findRole(/Application Software Engineer/i);
  assert.equal(applicationSoftware.applicationEligibilityAssessment.status, 'review_required');
  assert.ok(applicationSoftware.applicationEligibilityAssessment.reasons.some(reason => /sponsorship/i.test(reason)));
  assert.ok(applicationSoftware.applicationEligibilityAssessment.reasons.some(reason => /§13.*SÜG/i.test(reason)));
});

test('the one-entry delta preserves the complete portals preimage and search policy', (t) => {
  if (skipIfEvidenceMissing(t)) return;
  const baselineMarker = baselineText.indexOf('\njob_boards:');
  const currentMarker = currentTextWithoutPhase2Aliases.indexOf('\njob_boards:');
  assert.notEqual(baselineMarker, -1);
  assert.notEqual(currentMarker, -1);
  assert.equal(currentTextWithoutPhase2Aliases.indexOf('\njob_boards:', currentMarker + 1), -1);

  assert.equal(currentTextWithoutPhase2Aliases.slice(0, baselineMarker), baselineText.slice(0, baselineMarker));
  assert.equal(currentTextWithoutPhase2Aliases.slice(currentMarker), baselineText.slice(baselineMarker));
  assert.equal(
    currentTextWithoutPhase2Aliases.slice(baselineMarker, currentMarker),
    evidence.portalsInsertionText,
    'the sole byte delta must be the recorded Isar entry'
  );

  const baselineCompanies = baseline.tracked_companies ?? [];
  const currentCompanies = currentWithoutPhase2Aliases.tracked_companies ?? [];
  assert.deepEqual(currentCompanies.slice(0, baselineCompanies.length), baselineCompanies);
  assert.equal(currentCompanies.length, baselineCompanies.length + 1);
  assert.deepEqual(currentCompanies.at(-1), evidence.portalsEntry);

  for (const key of ['title_filter', 'location_filter', 'content_filter', 'experience_policy', 'search_queries', 'job_boards']) {
    assert.deepEqual(currentWithoutPhase2Aliases[key], baseline[key], `${key} must remain unchanged after removing only approved Phase2 title aliases`);
  }

  const expectedCurrent = structuredClone(currentWithoutPhase2Aliases);
  expectedCurrent.title_filter.positive.push(...PHASE2_TITLE_POSITIVE_ALIASES);
  assert.deepEqual(current, expectedCurrent, 'live config must equal the historical one-entry config plus exactly the four approved title positives');
  assert.deepEqual(
    current.title_filter.positive.slice(-PHASE2_TITLE_POSITIVE_ALIASES.length),
    PHASE2_TITLE_POSITIVE_ALIASES,
    'the exact approved aliases must remain the positive-list suffix'
  );
  assert.deepEqual(current.title_filter.negative, baseline.title_filter.negative, 'Phase2 aliases must not alter title negatives');

  const newline = currentText.includes('\r\n') ? '\r\n' : '\n';
  const negativeMarker = currentText.indexOf(`  negative:${newline}`);
  assert.notEqual(negativeMarker, -1, 'title_filter.negative must exist for the mutation check');
  const unauthorizedPositive = `${currentText.slice(0, negativeMarker)}    - "Unapproved Policy Change"${newline}${currentText.slice(negativeMarker)}`;
  assert.notEqual(
    removeApprovedPhase2TitleAliases(unauthorizedPositive),
    currentTextWithoutPhase2Aliases,
    'removing the four approved aliases must not conceal any other positive-list change'
  );

  const trackedNames = currentCompanies.map(item => normalizeName(item.name));
  assert.equal(new Set(trackedNames).size, trackedNames.length, 'tracked company names must remain unique');
  for (const property of ['careers_url', 'api']) {
    const candidateUrl = evidence.portalsEntry[property];
    assert.ok(candidateUrl);
    assert.ok(!(baselineCompanies ?? []).some(item => item[property] === candidateUrl), `${property} must not duplicate`);
  }
});

test('manual, excluded, and already tracked candidates are not added', (t) => {
  if (skipIfEvidenceMissing(t)) return;
  assert.equal(evidence.decisions.filter(item => item.decision === 'add').length, 1);
  const additions = current.tracked_companies.filter(item => normalizeName(item.name) === 'isar aerospace');
  assert.equal(additions.length, 1);

  const currentNames = new Set(current.tracked_companies.map(item => normalizeName(item.name)));
  for (const name of evidence.existingDuplicates) {
    assert.ok((baseline.tracked_companies ?? []).some(item => normalizeName(item.name) === normalizeName(name)));
  }
  for (const decision of evidence.decisions.filter(item => item.decision !== 'add')) {
    assert.ok(!currentNames.has(normalizeName(decision.company)), `${decision.company} must not be added from uncertain or excluded evidence`);
  }

  assert.deepEqual(evidence.coverageAssessment.seedSources, ['yc', 'a16z']);
  assert.equal(evidence.coverageAssessment.considerAndGetro.includes('no configured company-wide Consider/Getro portfolio board'), true);
});
