import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveCandidateId } from '../candidate-identity.mjs';
import { createApplicationBatch } from '../application-batch.mjs';

const RUN = 'run-prefix-era';
const greenhouse = { company: 'Example Oy', title: 'Graduate Software Engineer', location: 'Helsinki, Finland', url: 'https://job-boards.greenhouse.io/example/jobs/1234567', run_id: RUN };
// A Workday record persisted before the identity fix: the site name gave the requisition ("externalsite") and two
// distinct openings were merged under one ID.
const workdayMerged = {
  company: 'Example Aero', title: 'Software Engineer', location: 'Remote', run_id: RUN,
  url: 'https://example.wd5.myworkdayjobs.com/ex_externalsite/job/Remote/Software-Engineer_R100-1',
  url_aliases: ['https://example.wd5.myworkdayjobs.com/ex_externalsite/job/Remote/Software-Engineer_R100-1',
    'https://example.wd5.myworkdayjobs.com/ex_externalsite/job/Remote/Data-Engineer_R200-1'],
  provider: 'workday', ats_provider: 'workday', ats_tenant: 'example.wd5.myworkdayjobs.com:ex_externalsite', requisition_id: 'externalsite',
};

function fixture(t, rows) {
  const root = mkdtempSync(join(tmpdir(), 'prefix-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runDir = join(root, 'output', 'scan-runs', RUN);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n');
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ run_id: RUN }));
  writeFileSync(join(runDir, 'candidates.json'), JSON.stringify(rows, null, 2));
  return root;
}

const withId = (row, options) => ({ ...row, candidate_id: deriveCandidateId(row, options) });

test('a historical run with a pre-fix Workday record still loads, and its neighbours stay batchable', (t) => {
  const gh = withId(greenhouse);
  const root = fixture(t, [gh, withId(workdayMerged, { workdayRule: 'prefix_v1' })]);
  const { manifest } = createApplicationBatch({ root, sourceRunId: RUN, selectedCandidateIds: [gh.candidate_id], batchId: 'batch-gh' });
  assert.equal(manifest.candidates[0].candidate_id, gh.candidate_id);
  assert.equal(manifest.candidates[0].identityStatus, 'stable');
});

test('a pre-fix Workday identity is never selectable for a new batch', (t) => {
  const old = withId(workdayMerged, { workdayRule: 'prefix_v1' });
  const root = fixture(t, [withId(greenhouse), old]);
  assert.throws(
    () => createApplicationBatch({ root, sourceRunId: RUN, selectedCandidateIds: [old.candidate_id], batchId: 'batch-old' }),
    /pre-fix Workday identity/,
  );
});

test('a persisted ID matching neither identity rule still fails closed', (t) => {
  const tampered = { ...withId(greenhouse), candidate_id: `cand_v1_${'0'.repeat(64)}` };
  const root = fixture(t, [tampered]);
  assert.throws(() => createApplicationBatch({ root, sourceRunId: RUN, selectedCandidateIds: [tampered.candidate_id], batchId: 'batch-x' }),
    /does not match deterministic identity/);
});

test('two distinct openings sharing one pre-fix ID are reported as ambiguous, never merged', (t) => {
  const first = { ...workdayMerged, url: workdayMerged.url_aliases[0], url_aliases: [workdayMerged.url_aliases[0]], title: 'Software Engineer' };
  const second = { ...workdayMerged, url: workdayMerged.url_aliases[1], url_aliases: [workdayMerged.url_aliases[1]], title: 'Data Engineer' };
  const root = fixture(t, [withId(greenhouse), withId(first, { workdayRule: 'prefix_v1' }), withId(second, { workdayRule: 'prefix_v1' })]);
  assert.throws(() => createApplicationBatch({ root, sourceRunId: RUN, selectedCandidateIds: [withId(greenhouse).candidate_id], batchId: 'batch-y' }),
    /ambiguous candidate_id/);
});
