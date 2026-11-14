import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  companyDuplicateKey, findCandidateRecord, groupTrackerRows, loadIdentityMappings,
  loadReportIndex, loadRunCandidates, loadTrackerRows, roleDuplicateKey,
} from '../tracker-identity.mjs';
import { loadCanonicalStates } from '../tracker-utils.mjs';
import { createWorkTreeFixture, reportMarkdown, trackerTable } from './work-tree-fixture.mjs';

const cid = (char) => `cand_v1_${char.repeat(64)}`;
const summary = (company = 'Example Oy', role = 'Engineer', action = 'apply') => [
  `company: ${company}`, `role: ${role}`, 'location_country: Finland', 'fit_score: 4.6',
  'liveness: confirmed', 'liveness_date: 2026-11-10', 'blockers: []', 'flags: []',
  ...(action === 'review' ? ['review_reason: Needs a closer look'] : []),
].join('\n');
const row = (num, company, role, status, report = '', notes = '') => [num, '2026-11-01', company, role, '4/5', status, '', report, notes];

function groupFixture({ tracker, reports = {}, scanRuns = {}, corrections = {} }) {
  const fixture = createWorkTreeFixture({ tracker, reports, scanRuns, corrections });
  const states = loadCanonicalStates(join(fixture.root, 'templates', 'states.yml'));
  const loadedRows = loadTrackerRows(join(fixture.root, 'applications.md'));
  const reportIndex = loadReportIndex(join(fixture.root, 'reports'));
  const mappings = loadIdentityMappings({ scanRunsDir: join(fixture.root, 'output', 'scan-runs'), correctionsDir: join(fixture.root, 'output', 'identity-corrections') });
  const runCandidates = loadRunCandidates(join(fixture.root, 'output', 'scan-runs'));
  return { fixture, states, loadedRows, reportIndex, mappings, runCandidates,
    groups: groupTrackerRows(loadedRows.rows, reportIndex, mappings, { states, runCandidates }) };
}

test('Notes ID and report header ID join tracker rows despite different role text', (t) => {
  const id = cid('a');
  const report = '[12](reports/012-example-2026-11-01.md)';
  const tree = groupFixture({
    tracker: trackerTable([row(1, 'Example Oy', 'Engineer', 'Evaluated', '', `Canonical candidate ID: ${id}`), row(2, 'Example Oy', 'Platform Lead', 'Evaluated', report)]),
    reports: { '012-example-2026-11-01.md': reportMarkdown({ candidateId: id, summary: summary('Example Oy', 'Platform Lead') }) },
  });
  t.after(() => tree.fixture.cleanup());
  assert.equal(tree.groups.length, 1);
  assert.deepEqual(tree.groups[0].rows.map((entry) => entry.num), [1, 2]);
  assert.deepEqual([...tree.groups[0].ids], [id]);
});

test('stale Machine Summary IDs never group rows and mismatches flag only the linked group', (t) => {
  const headerId = cid('a'); const staleId = cid('b');
  const tree = groupFixture({
    tracker: trackerTable([
      row(1, 'Example Oy', 'Current Engineer', 'Evaluated', '[12](reports/012-current.md)'),
      row(2, 'Example Oy', 'Rejected Engineer', 'Rejected', '', `Canonical candidate ID: ${staleId}`),
      row(3, 'Example Oy', 'Summary Only', 'Evaluated', '[13](reports/013-summary-only.md)'),
      row(4, 'Example Oy', 'Same ID', 'Evaluated', '[14](reports/014-matching.md)'),
      row(5, 'Example Oy', 'Invalid Summary ID', 'Evaluated', '[15](reports/015-invalid.md)'),
    ]),
    reports: {
      '012-current.md': reportMarkdown({ candidateId: headerId, summary: `${summary()}\ncandidate_id: ${staleId}` }),
      '013-summary-only.md': reportMarkdown({ summary: `${summary()}\ncandidate_id: ${staleId}` }),
      '014-matching.md': reportMarkdown({ candidateId: headerId, summary: `${summary()}\ncandidate_id: ${headerId}` }),
      '015-invalid.md': reportMarkdown({ summary: `${summary()}\ncandidate_id: invalid` }),
    },
  });
  t.after(() => tree.fixture.cleanup());
  assert.equal(tree.groups.length, 4);
  const current = tree.groups.find((group) => group.rows.some((entry) => entry.num === 1));
  assert.deepEqual(current.rows.map((entry) => entry.num), [1, 4]);
  assert.deepEqual([...current.ids], [headerId]);
  assert.equal(current.open, true);
  assert.equal(current.status, 'Evaluated');
  assert.ok(current.flags.includes('report_id_mismatch'));
  const rejected = tree.groups.find((group) => group.rows.some((entry) => entry.num === 2));
  assert.equal(rejected.status, 'Rejected');
  assert.ok(tree.groups.filter((group) => group !== current).every((group) => !group.flags.includes('report_id_mismatch')));
  assert.deepEqual([...tree.groups.find((group) => group.rows.some((entry) => entry.num === 3)).ids], []);
  assert.ok(tree.reportIndex.warnings.some((message) => message.includes('012-current.md') && message.includes(headerId) && message.includes(staleId)));
  assert.ok(!tree.reportIndex.warnings.some((message) => /013-summary-only|014-matching|015-invalid/.test(message)));
});

test('URL aliases and equal company/role keys are possible duplicates but never grouping evidence', (t) => {
  const a = cid('a'); const b = cid('b');
  const url = 'https://jobs.example.test/opening/1?utm_source=first';
  const tree = groupFixture({
    tracker: trackerTable([row(1, 'Example Oy', 'Engineer', 'Evaluated', '', `Canonical candidate ID: ${a}`), row(2, 'Example Oy', 'Engineer', 'Evaluated', '', `Canonical candidate ID: ${b}`)]),
    scanRuns: { run: { manifest: { created_at: '2026-11-01' }, candidates: [
      { candidate_id: a, company: 'Example Oy', title: 'Engineer', url },
      { candidate_id: b, company: 'Example Oy', title: 'Engineer', original_url: 'https://jobs.example.test/opening/1?utm_source=other' },
    ] } },
  });
  t.after(() => tree.fixture.cleanup());
  assert.equal(tree.groups.length, 2);
  assert.ok(tree.groups.every((group) => group.possibleDuplicates.some((entry) => entry.reason === 'shared_url_alias')));
  assert.ok(tree.groups.every((group) => group.possibleDuplicates.some((entry) => entry.reason === 'company_role_match')));
});

test('text-only company and role matches stay separate and are reported as possible duplicates', (t) => {
  const tree = groupFixture({ tracker: trackerTable([
    row(1, 'Example Oy', 'Platform Engineer', 'Evaluated'),
    row(2, 'Example Oy', 'Platform-Engineer', 'Evaluated'),
  ]) });
  t.after(() => tree.fixture.cleanup());
  assert.equal(tree.groups.length, 2);
  assert.ok(tree.groups.every((group) => group.possibleDuplicates.some((entry) => entry.reason === 'company_role_match')));
});

test('one-to-one enrichment mapping groups IDs, and chains remain equivalent', (t) => {
  const a = cid('a'); const b = cid('b'); const c = cid('c');
  const tree = groupFixture({
    tracker: trackerTable([row(1, 'Example Oy', 'Old', 'Evaluated', '', `Canonical candidate ID: ${a}`), row(2, 'Example Oy', 'New', 'Evaluated', '', `Canonical candidate ID: ${c}`)]),
    scanRuns: {
      first: { enrichment: [{ source_candidate_id: a, candidate_id: b }] },
      second: { enrichment: { mappings: [{ source_candidate_id: b, candidate_id: c }] } },
    },
  });
  t.after(() => tree.fixture.cleanup());
  assert.equal(tree.groups.length, 1);
  assert.equal(tree.mappings.equivalent.get(a).size, 3);
  assert.ok(findCandidateRecord(new Map([[b, { candidate_id: b }]]), tree.mappings, a));
});

test('ledger one-target correction groups; multiple targets and shared IDs are ambiguous', (t) => {
  const a = cid('a'); const b = cid('b');
  const one = groupFixture({
    tracker: trackerTable([row(1, 'Example Oy', 'Old', 'Evaluated', '', `Canonical candidate ID: ${a}`), row(2, 'Example Oy', 'New', 'Evaluated', '', `Canonical candidate ID: ${b}`)]),
    corrections: { 'ledger.json': { entries: [{ old_candidate_id: a, corrected: [{ candidate_id: b }] }] } },
  });
  t.after(() => one.fixture.cleanup());
  assert.equal(one.groups.length, 1);

  const c = cid('c'); const d = cid('d'); const e = cid('e'); const f = cid('f');
  const many = groupFixture({
    tracker: trackerTable([row(1, 'Example Oy', 'Old', 'Evaluated', '', `Canonical candidate ID: ${c}`), row(2, 'Example Oy', 'New A', 'Evaluated', '', `Canonical candidate ID: ${d}`), row(3, 'Example Oy', 'New B', 'Evaluated', '', `Canonical candidate ID: ${e}`), row(4, 'Acme GmbH', 'Distinct A', 'Evaluated', '', `Canonical candidate ID: ${f}`), row(5, 'Acme GmbH', 'Distinct B', 'Evaluated', '', `Canonical candidate ID: ${f}`)]),
    corrections: { 'ledger.json': { entries: [{ old_candidate_id: c, corrected: [{ candidate_id: d }, { candidate_id: e }] }], old_ids_shared_by_distinct_openings: [{ old_candidate_id: f, distinct_openings: ['one', 'two'] }] } },
  });
  t.after(() => many.fixture.cleanup());
  assert.equal(many.groups.length, 5);
  assert.ok(many.mappings.ambiguous.has(c));
  assert.ok(many.groups.some((group) => group.possibleDuplicates.some((entry) => entry.reason === 'ambiguous_id')));
});

test('many-to-one and one-to-many edges are discarded across all enrichment files', (t) => {
  const oldA = cid('a'); const oldB = cid('b'); const next = cid('c'); const next2 = cid('d');
  const tree = groupFixture({
    tracker: trackerTable([row(1, 'Example Oy', 'One', 'Evaluated', '', `Canonical candidate ID: ${oldA}`), row(2, 'Example Oy', 'Two', 'Evaluated', '', `Canonical candidate ID: ${oldB}`)]),
    scanRuns: {
      a: { enrichment: [{ source_candidate_id: oldA, candidate_id: next }] },
      b: { enrichment: [{ source_candidate_id: oldB, candidate_id: next }] },
      c: { enrichment: [{ source_candidate_id: oldA, candidate_id: next2 }] },
    },
  });
  t.after(() => tree.fixture.cleanup());
  assert.equal(tree.groups.length, 2);
  assert.ok(tree.mappings.ambiguous.has(oldA));
  assert.ok(tree.mappings.discardedEdges.length >= 3);
  assert.ok(tree.groups.every((group) => group.possibleDuplicates.some((entry) => entry.reason === 'discarded_mapping')));
});

test('converged edges count toward cardinality across enrichment and correction sources', (t) => {
  const a = cid('a'); const b = cid('b'); const c = cid('c');
  const tree = groupFixture({
    tracker: trackerTable([
      row(1, 'Example Oy', 'Source A', 'Evaluated', '', `Canonical candidate ID: ${a}`),
      row(2, 'Example Oy', 'Source B', 'Evaluated', '', `Canonical candidate ID: ${b}`),
      row(3, 'Example Oy', 'Target', 'Rejected', '', `Canonical candidate ID: ${c}`),
    ]),
    scanRuns: { converged: { enrichment: [{ source_candidate_id: a, candidate_id: c, converged: true }] } },
    corrections: { 'ledger.json': { entries: [{ old_candidate_id: b, corrected: [{ candidate_id: c }] }] } },
  });
  t.after(() => tree.fixture.cleanup());
  assert.equal(tree.groups.length, 3);
  assert.equal(tree.mappings.equivalent.size, 0);
  assert.deepEqual(tree.mappings.discardedEdges.map((edge) => [edge.old, edge.new, edge.reason]), [
    [a, c, 'many_to_one'], [b, c, 'many_to_one'],
  ]);
  assert.ok(tree.groups.every((group) => group.possibleDuplicates.some((entry) =>
    entry.reason === 'discarded_mapping' && entry.edgeReasons.includes('many_to_one'))));
});

test('bad hashes, missing marker, hidden staging and converged mapping do not create edges and warn', (t) => {
  const a = cid('a'); const b = cid('b'); const c = cid('c'); const d = cid('d');
  const tree = createWorkTreeFixture({ scanRuns: {
    wrong: { enrichment: [{ source_candidate_id: a, candidate_id: b }], hash: 'sha256-wrong' },
    marker: { enrichment: [{ source_candidate_id: a, candidate_id: c }], omitEnrichmentMarker: true },
    '.staging-run': { enrichment: [{ source_candidate_id: a, candidate_id: d }] },
    converged: { enrichment: [{ source_candidate_id: a, candidate_id: d, converged: true }] },
  } });
  t.after(() => tree.cleanup());
  const mappings = loadIdentityMappings({ scanRunsDir: join(tree.root, 'output', 'scan-runs'), correctionsDir: join(tree.root, 'output', 'identity-corrections') });
  assert.equal(mappings.equivalent.size, 0);
  assert.ok(mappings.warnings.some((message) => message.includes('hash')));
  assert.ok(mappings.warnings.some((message) => message.includes('not enrich-run')));
  assert.ok(mappings.warnings.some((message) => message.includes('hidden')));
});

test('supersedes joins rows; canonical work state rules and conflict flags are applied', (t) => {
  const id = cid('a'); const reportId = cid('b');
  const tree = groupFixture({
    tracker: trackerTable([
      row(1, 'Example Oy', 'Engineer', 'Evaluated', '[10](reports/010-old.md)'),
      row(2, 'Example Oy', 'Engineer', 'Discarded', '[11](reports/011-new.md)'),
      row(3, 'Example Oy', 'Analyst', 'Applied'),
      row(4, 'Acme GmbH', 'Analyst', 'Rejected'),
      row(5, 'Example Oy', 'Manager', 'Unknown'),
      row(6, 'Example Oy', 'A', 'Applied', '', `Canonical candidate ID: ${id}`),
      row(7, 'Acme GmbH', 'B', 'Rejected', '', `Canonical candidate ID: ${id}`),
      row(8, 'Example Oy', 'Analyst', 'Evaluated', '', `Canonical candidate ID: ${cid('9')}`),
      row(9, 'Example Oy', 'Analyst II', 'Rejected', '', `Canonical candidate ID: ${cid('9')}`),
    ]),
    reports: {
      '010-old.md': reportMarkdown({ candidateId: reportId, summary: summary() }),
      '011-new.md': reportMarkdown({ supersedes: 10, summary: summary() }),
    },
  });
  t.after(() => tree.fixture.cleanup());
  assert.equal(tree.groups.length, 6);
  const superseded = tree.groups.find((group) => group.rows.some((entry) => entry.num === 1));
  assert.equal(superseded.open, false);
  assert.equal(superseded.status, 'Discarded');
  const mixed = tree.groups.find((group) => group.rows.some((entry) => entry.num === 6));
  assert.equal(mixed.status, 'Rejected');
  assert.ok(mixed.flags.includes('mixed_status'));
  assert.ok(mixed.flags.includes('conflict'));
  const evaluatedRejected = tree.groups.find((group) => group.rows.some((entry) => entry.num === 8));
  assert.equal(evaluatedRejected.open, false);
  assert.equal(evaluatedRejected.status, 'Rejected');
  assert.ok(!evaluatedRejected.flags.includes('mixed_status'));
  const unknown = tree.groups.find((group) => group.rows.some((entry) => entry.num === 5));
  assert.equal(unknown.open, false);
  assert.ok(unknown.flags.includes('unknown_status'));
});

test('Supersedes components join rows through reports without tracker rows', (t) => {
  const tree = groupFixture({
    tracker: trackerTable([
      row(1, 'Example Oy', 'Original', 'Rejected', '[1](reports/001-original.md)'),
      row(2, 'Example Oy', 'Latest', 'Evaluated', '[3](reports/003-latest.md)'),
      row(3, 'Example Oy', 'Other', 'Evaluated', '[4](reports/004-other.md)'),
    ]),
    reports: {
      '001-original.md': reportMarkdown({ summary: summary() }),
      '002-middle.md': reportMarkdown({ supersedes: 1, summary: summary() }),
      '003-latest.md': reportMarkdown({ supersedes: 2, summary: summary() }),
      '004-other.md': reportMarkdown({ summary: summary() }),
    },
  });
  t.after(() => tree.fixture.cleanup());
  assert.equal(tree.groups.length, 2);
  const chain = tree.groups.find((group) => group.rows.some((entry) => entry.num === 1));
  assert.deepEqual(chain.rows.map((entry) => entry.num), [1, 2]);
  assert.deepEqual(chain.reports, [1, 3]);
  assert.equal(chain.status, 'Rejected');
  assert.equal(chain.open, false);
});

test('malformed tracker rows, reports and JSON are tolerated with warnings', (t) => {
  const tree = createWorkTreeFixture({
    tracker: `${trackerTable([row(1, 'Example Oy', 'Engineer', 'Evaluated')])}| malformed |\n`,
    reports: { '012-bad.md': '## Machine Summary\n\n```yaml\n: invalid: [\n```\n' },
    scanRuns: { broken: { manifest: {}, candidates: '{bad json' } },
  });
  t.after(() => tree.cleanup());
  const loaded = loadTrackerRows(join(tree.root, 'applications.md'));
  const reports = loadReportIndex(join(tree.root, 'reports'));
  const runs = loadRunCandidates(join(tree.root, 'output', 'scan-runs'));
  assert.equal(loaded.rows.length, 1);
  assert.ok(loaded.warnings.length);
  assert.ok(reports.has(12));
  assert.ok(reports.warnings.length);
  assert.ok(runs.warnings.length);
});

test('duplicate key helpers match pinned application-batch behavior', () => {
  const companyCases = [
    ['Example Oy', 'example'], ['Acme GmbH', 'acme'], ['Foo GmbH & Co. KG', 'foo'],
    ['ACME Oyj', 'acme'], ['Blue & Green, Inc.', 'bluegreen'], ['A.B. Corporation', 'ab'],
    ['Åland Ab', 'åland'], ['Data BV', 'data'], ['Company SA', 'company'], ['Company KG', 'company'],
  ];
  for (const [value, expected] of companyCases) assert.equal(companyDuplicateKey(value), expected, value);
  const roleCases = [
    ['Senior C++ Engineer', 'seniorcplusplusengineer'], ['C# Developer', 'csharpdeveloper'],
    ['.NET Engineer', 'dotnetengineer'], ['F# Engineer', 'fsharpengineer'], ['Product Manager', 'productmanager'],
    ['Data Analyst', 'dataanalyst'], ['QA / Test Engineer', 'qatestengineer'], ['UX/UI Designer', 'uxuidesigner'],
    ['SRE (Platform)', 'sreplatform'], ['Backend Developer', 'backenddeveloper'],
  ];
  for (const [value, expected] of roleCases) assert.equal(roleDuplicateKey(value), expected, value);
});

test('groupTrackerRows tolerates malformed row arrays and options', () => {
  assert.doesNotThrow(() => groupTrackerRows([null, 'bad row'], null, null, null));
});
