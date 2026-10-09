import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatApplicationAnswersSection, validateApplicationAnswersSnapshot } from '../application-answers.mjs';
import { createDraftManifest } from '../cv-claims.mjs';

function fixture({ includeManifest = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-answers-'));
  const cv = '# Inventory Tracker project\nBuilt a Python and SQL application for data validation.';
  const cvPath = join(root, 'cv.md');
  mkdirSync(dirname(cvPath), { recursive: true });
  writeFileSync(cvPath, cv);
  if (includeManifest) {
    const manifest = createDraftManifest(cv);
    manifest.claims.forEach((claim) => { claim.state = 'asserted'; });
    const manifestPath = join(root, 'data', 'cv-claim-anchors.json');
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  return { root };
}

test('free-text application answers are flagged when their candidate facts fail claim validation', () => {
  const f = fixture();
  try {
    const snapshot = validateApplicationAnswersSnapshot({
      state: 'filled',
      freeText: [{ question: 'Describe a project', answer: 'I delivered a Go service for 500K users.' }],
    }, { root: f.root });
    assert.equal(snapshot.state, 'filled');
    assert.equal(snapshot.freeText[0].claimValidation.status, 'review_required');
    assert.ok(snapshot.freeText[0].claimValidation.reasonCodes.length > 0);
    const report = formatApplicationAnswersSection(snapshot, { root: f.root });
    assert.match(report, /Claim validation: \*\*REVIEW REQUIRED\*\*/);
    assert.doesNotMatch(report, /\*\*State:\*\* submitted/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('missing claim manifest is shown as review-required in the answers report', () => {
  const f = fixture({ includeManifest: false });
  try {
    const report = formatApplicationAnswersSection({
      freeText: [{ question: 'Describe a project', answer: 'I used Python for data validation.' }],
    }, { root: f.root });
    assert.match(report, /claim_manifest_missing/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
