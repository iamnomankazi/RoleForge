import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { buildWorklist, renderWorklist } from '../worklist.mjs';
import { createWorkTreeFixture, reportMarkdown, trackerTable } from './work-tree-fixture.mjs';

const SOURCE_ROOT = resolve(import.meta.dirname, '..');
const cid = (char) => `cand_v1_${char.repeat(64)}`;
const summary = (company, role, fit = 4.6, liveness = 'confirmed') => [
  `company: ${company}`, `role: ${role}`, 'location_country: Finland', `fit_score: ${fit}`,
  `liveness: ${liveness}`, 'liveness_date: 2026-11-10', 'blockers: []', 'flags: []',
  ...(fit < 4 ? ['review_reason: Needs a closer look'] : []),
].join('\n');
const reportLink = (number) => `[${number}](reports/${String(number).padStart(3, '0')}-fixture.md)`;
const row = (num, date, company, role, status, report = '', notes = '') => [num, date, company, role, '4/5', status, '', report, notes];

function makeWorklistFixture() {
  const applyId = cid('a'); const reviewId = cid('b'); const appliedId = cid('c');
  const discardId = cid('d'); const rejectId = cid('e'); const orphanId = cid('f'); const supersedesId = cid('g');
  const fixture = createWorkTreeFixture({
    tracker: trackerTable([
      row(1, '2026-11-01', 'Example Oy', 'Engineer', 'Evaluated', reportLink(12), `Canonical candidate ID: ${applyId}`),
      row(2, '2026-11-02', 'Acme GmbH', 'Researcher', 'Evaluated', reportLink(13), `Canonical candidate ID: ${reviewId}; APPLY`),
      row(3, '2026-10-20', 'Example Oy', 'Designer', 'Applied', '', `Canonical candidate ID: ${appliedId}; applied through portal`),
      row(4, '2026-10-10', 'Example Oy', 'Closed Engineer', 'Discarded', reportLink(14), `Canonical candidate ID: ${discardId}`),
      row(5, '2026-10-11', 'Acme GmbH', 'Rejected Engineer', 'Rejected', '', `Canonical candidate ID: ${rejectId}`),
      row(6, '2026-10-20', 'Example Oy', 'Designer II', 'Evaluated', '', `Canonical candidate ID: ${appliedId}`),
      row(7, '2026-11-03', 'Example Oy', 'Current Engineer', 'Evaluated', reportLink(16), `Canonical candidate ID: ${supersedesId}`),
    ]),
    reports: {
      '012-apply.md': reportMarkdown({ candidateId: applyId, summary: summary('Example Oy', 'Engineer') }),
      '013-review.md': reportMarkdown({ candidateId: reviewId, summary: summary('Acme GmbH', 'Researcher', 3.8, 'unconfirmed') }),
      '014-discarded.md': reportMarkdown({ candidateId: discardId, summary: summary('Example Oy', 'Closed Engineer') }),
      '015-untracked.md': reportMarkdown({ candidateId: orphanId, summary: summary('Orphan Ltd', 'Untracked Role') }),
      '016-old-review.md': reportMarkdown({ candidateId: supersedesId, summary: summary('Example Oy', 'Old Engineer', 3.8, 'unconfirmed') }),
      '017-current-apply.md': reportMarkdown({ supersedes: 16, summary: summary('Example Oy', 'Current Engineer') }),
    },
    scanRuns: { latest: { manifest: { created_at: '2026-11-12T00:00:00Z' }, candidates: [
      { candidate_id: applyId, company: 'Example Talent Group', ats_tenant: 'example' },
    ] } },
    batches: {
      'batch-open': { manifest: { batchId: 'batch-open', sourceRunId: 'run', candidates: [
        { candidate_id: applyId, company: 'Example Oy', title: 'Engineer' },
        { candidate_id: orphanId, company: 'Orphan Ltd', title: 'Untracked Role' },
      ] }, state: { candidates: [{ candidate_id: applyId, state: 'not_opened' }, { candidate_id: orphanId, state: 'blocked' }] } },
      'batch-completed': { manifest: { batchId: 'batch-completed', candidates: [{ candidate_id: rejectId, company: 'Acme GmbH', title: 'Rejected Engineer' }] }, state: { candidates: [{ candidate_id: rejectId, state: 'abandoned' }] } },
    },
  });
  return { fixture, ids: { applyId, reviewId, appliedId, discardId, rejectId, orphanId, supersedesId } };
}

test('buildWorklist populates sections, honors closed states and reports data problems', (t) => {
  const { fixture, ids } = makeWorklistFixture();
  t.after(() => fixture.cleanup());
  const worklist = buildWorklist({ root: fixture.root, now: new Date('2026-11-14T12:00:00Z') });
  const { openApply, awaitingOutcome, inProgress, review, dataProblems } = worklist.sections;
  assert.equal(openApply.length, 2);
  assert.equal(openApply[0].tracker_rows, '#1');
  assert.equal(openApply[0].company, 'Example Talent Group');
  assert.equal(openApply[0].batch.id, 'batch-open');
  assert.equal(openApply[0].batch.state, 'not_opened');
  assert.equal(openApply[0].age_days, 4);
  assert.ok(openApply.some((entry) => entry.tracker_rows === '#7' && entry.report === '017-current-apply.md'));
  assert.equal(review.length, 1);
  assert.equal(review[0].tracker_rows, '#2');
  assert.equal(awaitingOutcome.length, 1);
  assert.equal(awaitingOutcome[0].tracker_rows, '#3, #6');
  assert.equal(awaitingOutcome[0].applied_date, '2026-10-20');
  assert.equal(awaitingOutcome[0].last_notes, 'applied through portal');
  assert.equal(inProgress.length, 2);
  assert.ok(inProgress.some((entry) => entry.candidate_id === ids.orphanId && !entry.open_tracker_group));
  assert.ok(!openApply.some((entry) => entry.tracker_rows === '#4' || entry.tracker_rows === '#5'));
  assert.ok(!review.some((entry) => entry.tracker_rows === '#4' || entry.tracker_rows === '#5'));
  assert.ok(dataProblems.some((entry) => entry.type === 'report_without_tracker' && entry.report_number === 15));
  assert.ok(!dataProblems.some((entry) => entry.type === 'report_without_tracker' && entry.report_number === 17));
  assert.ok(dataProblems.some((entry) => entry.notes_action_conflicts?.some((conflict) => conflict.note === 'APPLY')));
  assert.deepEqual(worklist.groups.find((group) => group.rows.some((entry) => entry.num === 4)).ids, [ids.discardId]);
});

test('renderer includes all requested section headings and markdown output', (t) => {
  const { fixture } = makeWorklistFixture();
  t.after(() => fixture.cleanup());
  const rendered = renderWorklist(buildWorklist({ root: fixture.root, now: '2026-11-14T12:00:00Z' }));
  for (const title of ['Open Apply', 'Awaiting outcome', 'In progress', 'Review', 'Data problems']) assert.ok(rendered.includes(`## ${title}`));
  assert.ok(rendered.includes('| Tracker rows | Report | Company | Role |'));
});

test('CLI JSON prints structure, --out writes markdown, and default output writes no files', (t) => {
  const { fixture } = makeWorklistFixture();
  t.after(() => fixture.cleanup());
  const defaultRun = spawnSync(process.execPath, [join(SOURCE_ROOT, 'worklist.mjs'), '--root', fixture.root], { encoding: 'utf8' });
  assert.equal(defaultRun.status, 0, defaultRun.stderr);
  assert.ok(defaultRun.stdout.includes('# Open worklist'));
  assert.equal(existsSync(join(fixture.root, 'worklist.md')), false);

  const jsonRun = spawnSync(process.execPath, [join(SOURCE_ROOT, 'worklist.mjs'), '--root', fixture.root, '--json'], { encoding: 'utf8' });
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const parsed = JSON.parse(jsonRun.stdout);
  assert.ok(Array.isArray(parsed.sections.openApply));
  assert.ok(Array.isArray(parsed.sections.dataProblems));

  const outRun = spawnSync(process.execPath, [join(SOURCE_ROOT, 'worklist.mjs'), '--root', fixture.root, '--out', 'data/worklist.md'], { encoding: 'utf8' });
  assert.equal(outRun.status, 0, outRun.stderr);
  assert.equal(outRun.stdout, '');
  assert.ok(readFileSync(join(fixture.root, 'data', 'worklist.md'), 'utf8').startsWith('# Open worklist'));
});
