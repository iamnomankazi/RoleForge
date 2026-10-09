import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateCandidateFactClaims } from '../application-form-policy.mjs';
import { createDraftManifest } from '../cv-claims.mjs';

function fixture({ includeManifest = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-policy-'));
  const cv = '# Project: Inventory Tracker\nBuilt a Python and SQL application for data validation.';
  writeFileSync(join(root, 'cv.md'), cv);
  if (includeManifest) {
    const manifest = createDraftManifest(cv);
    manifest.claims.forEach((claim) => { claim.state = 'asserted'; });
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'cv-claim-anchors.json'), JSON.stringify(manifest));
  }
  return { root, cv };
}

test('candidate-fact claim validation passes only supported facts', () => {
  const f = fixture();
  try {
    const supported = validateCandidateFactClaims([{ id: 'fact-1', text: 'Built a Python and SQL application for data validation.' }], { root: f.root });
    assert.equal(supported.status, 'pass');
    const unsupported = validateCandidateFactClaims([{ id: 'fact-2', text: 'Built a Go service for 500K customers.' }], { root: f.root });
    assert.equal(unsupported.status, 'review_required');
    assert.ok(unsupported.reasonCodes.includes('unsupported_technology') || unsupported.reasonCodes.includes('unsupported_metric'));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('missing CV claim manifest never silently passes', () => {
  const f = fixture({ includeManifest: false });
  try {
    const result = validateCandidateFactClaims([{ id: 'fact-1', text: 'Built a Python and SQL application.' }], { root: f.root });
    assert.equal(result.status, 'review_required');
    assert.equal(result.reasonCode, 'claim_manifest_missing');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
