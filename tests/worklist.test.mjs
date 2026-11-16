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
    livenessFiles: {
      'run-2026-11-10/liveness-standard/liveness.json': {
        [applyId]: { status: 'confirmed', checked_at: '2026-11-10T08:00:00Z' },
      },
    },
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
  assert.equal(openApply[0].liveness_status, 'confirmed');
  assert.equal(openApply[0].liveness_date, '2026-11-10');
  assert.ok(openApply.some((entry) => entry.tracker_rows === '#7' && entry.report === '017-current-apply.md'));
  assert.equal(review.length, 1);
  assert.equal(review[0].tracker_rows, '#2');
  assert.equal(awaitingOutcome.length, 1);
  assert.equal(awaitingOutcome[0].tracker_rows, '#3, #6');
  assert.equal(awaitingOutcome[0].applied_date, '2026-10-20');
  assert.equal(awaitingOutcome[0].last_notes, 'applied through portal');
  assert.equal(inProgress.length, 2);
  assert.ok(inProgress.some((entry) => entry.candidate_id === ids.orphanId && !entry.open_tracker_group && entry.match === 'none'));
  assert.ok(inProgress.some((entry) => entry.candidate_id === ids.applyId && entry.match === 'id' && entry.group_status === 'Evaluated'));
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
  assert.ok(rendered.includes('| Liveness status | Liveness date |'));
  assert.ok(rendered.includes('| Batch | Candidate ID | State | Match |'));
  assert.ok(rendered.includes('| Group status |'));
});

test('liveness files choose the latest entry across IDs and fall back to report status', (t) => {
  const primaryId = cid('a'); const equivalentId = cid('b'); const reportFallbackId = cid('c');
  const fixture = createWorkTreeFixture({
    tracker: trackerTable([
      row(1, '2026-11-01', 'Example Oy', 'Latest Liveness', 'Evaluated', reportLink(21), `Canonical candidate ID: ${primaryId}`),
      row(2, '2026-11-02', 'Example Oy', 'Report Fallback', 'Evaluated', reportLink(22), `Canonical candidate ID: ${reportFallbackId}`),
    ]),
    reports: {
      '021-latest.md': reportMarkdown({ candidateId: primaryId, summary: summary('Example Oy', 'Latest Liveness') }),
      '022-report-fallback.md': reportMarkdown({ candidateId: reportFallbackId, summary: summary('Example Oy', 'Report Fallback', 3.8, 'unconfirmed') }),
    },
    scanRuns: { mapping: { enrichment: [{ source_candidate_id: primaryId, candidate_id: equivalentId }] } },
    livenessFiles: {
      'run-a/liveness-old/liveness.json': { [primaryId]: { status: 'old', checked_at: '2026-11-10T08:00:00Z' } },
      'run-b/liveness-repeat/liveness.json': { [primaryId]: { status: 'newer', checked_at: '2026-11-11T08:00:00Z' } },
      'liveness/run-c-20261112/liveness.json': { [equivalentId]: { status: 'latest-equivalent', checked_at: '2026-11-12T08:00:00Z' } },
      'run-c/liveness-malformed/liveness.json': '{ malformed json',
    },
  });
  t.after(() => fixture.cleanup());

  const result = buildWorklist({ root: fixture.root, now: '2026-11-14T12:00:00Z' });
  const actionRows = [...result.sections.openApply, ...result.sections.review];
  const latest = actionRows.find((entry) => entry.tracker_rows === '#1');
  const reportFallback = actionRows.find((entry) => entry.tracker_rows === '#2');
  assert.equal(latest.liveness_status, 'latest-equivalent');
  assert.equal(latest.liveness_date, '2026-11-12');
  assert.equal(latest.age_days, 2);
  assert.equal(reportFallback.liveness_status, 'unconfirmed');
  assert.equal(reportFallback.liveness_date, null);
  assert.equal(reportFallback.age_days, null);
  assert.ok(result.warnings.some((message) => message.includes('liveness results') && message.includes('liveness-malformed')));
});

for (const newerLayout of ['historical', 'default']) {
  test(`latest liveness wins across layouts when ${newerLayout} is newer`, (t) => {
    const id = cid('a');
    const fixture = createWorkTreeFixture({
      tracker: trackerTable([row(1, '2026-11-01', 'Example Oy', 'Engineer', 'Evaluated', reportLink(1), `Canonical candidate ID: ${id}`)]),
      reports: { '001-fixture.md': reportMarkdown({ candidateId: id, summary: summary('Example Oy', 'Engineer') }) },
      livenessFiles: Object.fromEntries([
        ['historical', 'run-a/liveness-standard/liveness.json'],
        ['default', 'liveness/run-a-20261112/liveness.json'],
      ].map(([layout, file]) => [file, {
        [id]: { status: layout, checked_at: layout === newerLayout ? '2026-11-12T08:00:00Z' : '2026-11-10T08:00:00Z' },
      }])),
    });
    t.after(() => fixture.cleanup());

    const result = buildWorklist({ root: fixture.root, now: '2026-11-14T12:00:00Z' });
    assert.equal(result.groups.length, 1);
    const [entry] = result.sections.openApply;
    assert.equal(entry.liveness_status, newerLayout);
    assert.equal(entry.liveness_date, '2026-11-12');
    assert.equal(entry.age_days, 2);
  });
}

test('default-layout liveness is found only at the required depth', (t) => {
  const id = cid('a');
  const fixture = createWorkTreeFixture({
    tracker: trackerTable([row(1, '2026-11-01', 'Example Oy', 'Engineer', 'Evaluated', reportLink(1), `Canonical candidate ID: ${id}`)]),
    reports: { '001-fixture.md': reportMarkdown({ candidateId: id, summary: summary('Example Oy', 'Engineer') }) },
    livenessFiles: {
      'liveness/run-a-20261112/liveness.json': { [id]: { status: 'confirmed', checked_at: '2026-11-12T08:00:00Z' } },
      'liveness/liveness.json': { [id]: { status: 'too-shallow', checked_at: '2026-11-13T08:00:00Z' } },
      'liveness/run-a/nested/liveness.json': { [id]: { status: 'too-deep', checked_at: '2026-11-13T08:00:00Z' } },
      'run-b/other/liveness.json': { [id]: { status: 'unrelated', checked_at: '2026-11-13T08:00:00Z' } },
      'run-b/liveness-standard/nested/liveness.json': { [id]: { status: 'historical-too-deep', checked_at: '2026-11-13T08:00:00Z' } },
    },
  });
  t.after(() => fixture.cleanup());

  const result = buildWorklist({ root: fixture.root, now: '2026-11-14T12:00:00Z' });
  const [entry] = result.sections.openApply;
  assert.equal(entry.liveness_status, 'confirmed');
  assert.equal(entry.liveness_date, '2026-11-12');
});

test('liveness paths matching both layouts are processed once, including malformed files', (t) => {
  const id = cid('a');
  const fixture = createWorkTreeFixture({
    tracker: trackerTable([row(1, '2026-11-01', 'Example Oy', 'Engineer', 'Evaluated', reportLink(1), `Canonical candidate ID: ${id}`)]),
    reports: { '001-fixture.md': reportMarkdown({ candidateId: id, summary: summary('Example Oy', 'Engineer') }) },
    livenessFiles: {
      'liveness/liveness-valid/liveness.json': { [id]: { status: 'confirmed', checked_at: '2026-11-12T08:00:00Z' } },
      'liveness/liveness-malformed/liveness.json': '{ malformed json',
      'liveness/run-malformed/liveness.json': '[]',
    },
  });
  t.after(() => fixture.cleanup());

  const result = buildWorklist({ root: fixture.root, now: '2026-11-14T12:00:00Z' });
  assert.equal(result.sections.openApply[0].liveness_status, 'confirmed');
  for (const name of ['liveness-malformed', 'run-malformed']) {
    const file = join(fixture.root, 'output', 'liveness', name, 'liveness.json');
    assert.equal(result.warnings.filter((message) => message.includes(file)).length, 1);
  }
});

test('unmatched batch IDs use unique company and role fallback, while ambiguous and absent matches remain visible', (t) => {
  const appliedId = cid('e'); const evaluatedId = cid('f'); const duplicateOneId = cid('0'); const duplicateTwoId = cid('1');
  const tracker = trackerTable([
    row(1, '2026-10-01', 'Example Oy', 'Designer', 'Applied', '', `Canonical candidate ID: ${appliedId}`),
    row(2, '2026-10-02', 'Example Oy', 'Engineer', 'Evaluated', '', `Canonical candidate ID: ${evaluatedId}`),
    row(3, '2026-10-03', 'Example Oy', 'Platform Engineer', 'Evaluated', '', `Canonical candidate ID: ${duplicateOneId}`),
    row(4, '2026-10-04', 'Example Oy', 'Platform-Engineer', 'Evaluated', '', `Canonical candidate ID: ${duplicateTwoId}`),
  ]);
  const batch = (id, company, role) => ({ manifest: { candidates: [{ candidate_id: id, company, role }] },
    state: { candidates: [{ candidate_id: id, state: 'not_opened' }] } });
  const fixture = createWorkTreeFixture({ tracker, batches: {
    applied: batch(cid('2'), 'Example Ltd', 'Designer'),
    evaluated: batch(cid('3'), 'Example Oy', 'Engineer'),
    ambiguous: batch(cid('4'), 'Example Oy', 'Platform Engineer'),
    none: batch(cid('5'), 'Unmatched Inc', 'Unmatched Role'),
  } });
  t.after(() => fixture.cleanup());

  const { inProgress } = buildWorklist({ root: fixture.root }).sections;
  assert.equal(inProgress.length, 3);
  const byBatch = Object.fromEntries(inProgress.map((entry) => [entry.batch_id, entry]));
  assert.equal(byBatch.evaluated.match, 'text');
  assert.equal(byBatch.evaluated.tracker_rows, '#2');
  assert.equal(byBatch.evaluated.group_status, 'Evaluated');
  assert.equal(byBatch.ambiguous.match, 'ambiguous');
  assert.equal(byBatch.ambiguous.tracker_rows, '');
  assert.equal(byBatch.none.match, 'none');
  assert.ok(!byBatch.applied);
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

test('a newer live requisition on a row is not hidden by closed rows of an older requisition', (t) => {
  const oldId = cid('7'); const newId = cid('8');
  const build = (extraRows = []) => createWorkTreeFixture({
    tracker: trackerTable([
      row(20, '2026-10-12', 'Example Oy', 'Data Engineer', 'Discarded', reportLink(31), `Canonical candidate ID: ${oldId}`),
      row(21, '2026-11-16', 'Example Oy', 'Data Engineer', 'Evaluated', `${reportLink(30)}; ${reportLink(32)}`,
        `Canonical candidate ID: ${newId}`),
      ...extraRows,
    ]),
    reports: {
      '030-old.md': reportMarkdown({ candidateId: oldId, summary: summary('Example Oy', 'Data Engineer') }),
      '031-old-recheck.md': reportMarkdown({ candidateId: oldId, supersedes: 30, summary: summary('Example Oy', 'Data Engineer') }),
      '032-new.md': reportMarkdown({ candidateId: newId, summary: summary('Example Oy', 'Data Engineer') }),
    },
  });
  const now = new Date('2026-11-16T12:00:00Z');

  const live = build();
  t.after(() => live.cleanup());
  const { openApply, dataProblems } = buildWorklist({ root: live.root, now }).sections;
  assert.equal(openApply.length, 1);
  assert.equal(openApply[0].report, '032-new.md');
  assert.ok(openApply[0].flags.includes('closed_older_requisition'));
  assert.ok(dataProblems.some((problem) => problem.tracker_rows.includes('#21')));

  // A closed row carrying the current requisition's own ID still hides it.
  const closed = build([row(22, '2026-11-16', 'Example Oy', 'Data Engineer', 'Discarded', '', `Canonical candidate ID: ${newId}`)]);
  t.after(() => closed.cleanup());
  const sections = buildWorklist({ root: closed.root, now }).sections;
  assert.equal(sections.openApply.length, 0);
  assert.equal(sections.review.length, 0);
});
