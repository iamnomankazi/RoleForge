// tests/stats.test.mjs — moved verbatim from test-all.mjs (#1604).
import { pass, fail, run, NODE, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { computeAllStats, computeOutcomeStats, printSummary } from '../stats.mjs';

console.log('\nstats.mjs — lifetime pipeline stats aggregator (#1604)');
try {
  const stats = await import(pathToFileURL(join(ROOT, 'stats.mjs')).href);

  // Tracker roll-up — CRLF input on purpose (Windows checkouts).
  const trackerMd = [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-06-01 | Acme | Eng | 4.5/5 | Applied | ✅ | [1](../reports/001-acme-2026-06-01.md) | note |',
    '| 2 | 2026-06-02 | Beta | Eng | 3.8/5 | Evaluated | ❌ | [2](../reports/002-beta-2026-06-02.md) | note |',
    '| 3 | 2026-06-03 | Gama | Eng | 4.2/5 | Interview | ✅ | ❌ | note |',
  ].join('\r\n');
  const t = stats.computeTrackerStats(trackerMd);
  if (t.total === 3 && t.byStatus.Applied === 1 && t.byStatus.Evaluated === 1
      && t.byStatus.Interview === 1 && t.avgScore === 4.2 && t.avgScoreApplied === 4.4
      && t.topScore === 4.5 && t.pdfPct === 66.7 && t.reportPct === 66.7 && t.activeApps === 2) {
    pass('computeTrackerStats counts statuses, scores, pdf/report pct, active apps (CRLF input)');
  } else {
    fail(`computeTrackerStats wrong output: ${JSON.stringify(t)}`);
  }

  // Funnel — Rejected counts into everApplied (mirrors dashboard ComputeProgressMetrics).
  const f = stats.computeFunnel({ Applied: 4, Responded: 2, Interview: 1, Offer: 1, Rejected: 2, Evaluated: 9 });
  if (f.everApplied === 10 && f.everResponded === 4 && f.everInterview === 2 && f.everOffer === 1
      && f.responseRate === 40 && f.offerRate === 10 && f.smallSample === false) {
    pass('computeFunnel cumulative ever* stages match the dashboard math');
  } else {
    fail(`computeFunnel wrong output: ${JSON.stringify(f)}`);
  }
  if (stats.computeFunnel({ Applied: 3 }).smallSample === true) {
    pass('computeFunnel flags small samples (everApplied < 10)');
  } else {
    fail('computeFunnel should flag everApplied < 10 as smallSample');
  }

  // Lifetime scan totals — CRLF input, torn row skipped, fingerprint column tolerated.
  const scanTsv = [
    'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation',
    'https://a/1\t2026-06-20\tgreenhouse\tEng\tAcme\tadded\tRemote',
    'https://a/2\t2026-06-21\tgreenhouse\tEng2\tAcme\tadded\tRemote\tdeadbeefdeadbeef',
    'https://b/1\t2026-06-22\tashby\tEng\tBeta\tskipped_expired\tNY',
    'https://c/1\t2026-06-2',
  ].join('\r\n');
  const s = stats.computeScanStats(scanTsv);
  if (s.totalRecorded === 4 && s.added === 3 && s.byPortal.greenhouse === 2
      && s.byStatus.skipped_expired === 1 && s.distinctCompanies === 2
      && s.firstSeen === '2026-06-20' && s.lastSeen === '2026-06-22'
      && s.addedPerWeek.some(w => w.week === '2026-W25' && w.count === 2)) {
    pass('computeScanStats lifetime totals from scan-history.tsv (CRLF, extra fingerprint col)');
  } else {
    fail(`computeScanStats wrong output: ${JSON.stringify(s)}`);
  }

  // ISO week year-boundary — the one place hand-rolled week math fails.
  const wk = [stats.isoWeek('2025-12-29'), stats.isoWeek('2026-01-01'), stats.isoWeek('2024-12-31'), stats.isoWeek('2027-01-01')];
  if (wk[0] === '2026-W01' && wk[1] === '2026-W01' && wk[2] === '2025-W01' && wk[3] === '2026-W53') {
    pass('isoWeek handles year boundaries');
  } else {
    fail(`isoWeek boundary math wrong: ${JSON.stringify(wk)}`);
  }

  // Portal coverage — real portals.yml keys (tracked_companies / job_boards).
  const portalsYml = [
    'tracked_companies:',
    '  - name: Acme',
    '    careers_url: https://boards.greenhouse.io/acme',
    '  - name: Beta',
    '    careers_url: https://jobs.ashbyhq.com/beta',
    '  - name: Gama',
    '    careers_url: https://gama.example.com/jobs',
    'job_boards:',
    '  - name: BigBoard',
    '    url: https://bigboard.example.com',
  ].join('\n');
  const p = stats.computePortalStats(portalsYml, { byPortal: { greenhouse: 5, ashby: 2 } }, ['acme', 'beta']);
  if (p.configuredCompanies === 3 && p.configuredBoards === 1
      && p.activePortals === 2 && p.producingCompanies === 2 && p.producingPct === 66.7) {
    pass('computePortalStats configured vs producing coverage');
  } else {
    fail(`computePortalStats wrong output: ${JSON.stringify(p)}`);
  }

  // Follow-up compliance.
  const followupsMd = [
    '# Follow-ups',
    '| # | App | Date | Company | Role | Channel | Contact | Notes |',
    '|---|-----|------|---------|------|---------|---------|-------|',
    '| 1 | 1 | 2026-06-10 | Acme | Eng | email | jane | pinged |',
    '| 2 | 1 | 2026-06-17 | Acme | Eng | email | jane | pinged again |',
    '| 3 | 3 | 2026-06-12 | Gama | Eng | linkedin | bob | intro |',
  ].join('\n');
  const trackerByNum = new Map([[1, 'Applied'], [2, 'Applied'], [3, 'Interview']]);
  const fu = stats.computeFollowupStats(followupsMd, trackerByNum);
  if (fu.totalFollowups === 3 && fu.appsWithFollowups === 2
      && fu.appliedWithoutFollowup === 1 && fu.avgPerApp === 1.5) {
    pass('computeFollowupStats compliance from follow-ups.md');
  } else {
    fail(`computeFollowupStats wrong output: ${JSON.stringify(fu)}`);
  }

  // CLI smoke — must emit the full contract with null sections in a checkout
  // with no user data (exactly the CI environment).
  const cliOut = run(NODE, [join(ROOT, 'stats.mjs')]);
  const parsed = JSON.parse(cliOut);
  if (parsed && parsed.metadata && 'tracker' in parsed && 'scan' in parsed && 'portals' in parsed
      && 'followups' in parsed && 'funnel' in parsed && 'runs' in parsed) {
    pass('stats.mjs CLI emits the full JSON contract (sections null when sources missing)');
  } else {
    fail(`stats.mjs CLI missing sections: ${parsed ? Object.keys(parsed).join(',') : cliOut}`);
  }
  const summaryOut = run(NODE, [join(ROOT, 'stats.mjs'), '--summary']);
  if (summaryOut && summaryOut.includes('Pipeline Stats')) {
    pass('stats.mjs --summary renders the human table');
  } else {
    fail('stats.mjs --summary missing header');
  }
} catch (e) {
  fail(`stats.mjs tests crashed: ${e.message}`);
}

const outcomeId = (char) => `cand_v1_${char.repeat(64)}`;
const outcomeRow = (num, status, notes = '') => `| ${num} | 2026-11-01 | Example Oy | Role ${num} | 4/5 | ${status} | | | ${notes} |`;
const outcomeTracker = [
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
  outcomeRow(1, 'Applied', 'No reply as of 2026-11-14; NO REPLY AS OF 2026-11-10'),
  outcomeRow(2, 'Applied', 'Closed by user 2026-10-01: no response; re-applied later'),
  outcomeRow(3, 'Rejected', `Canonical candidate ID: ${outcomeId('b')}`),
  outcomeRow(4, 'Applied', `Canonical candidate ID: ${outcomeId('b')}; No reply as of 2026-11-13`),
  outcomeRow(5, 'Applied', `Canonical candidate ID: ${outcomeId('a')}`),
  outcomeRow(6, 'Evaluated', `Canonical candidate ID: ${outcomeId('a')}; no reply as of 2026-11-15`),
  outcomeRow(7, 'Discarded', `Canonical candidate ID: ${outcomeId('c')}; Closed by user 2026-11-01: no response`),
  outcomeRow(8, 'Discarded', `Canonical candidate ID: ${outcomeId('c')}; CLOSED BY USER 2026-11-02: NO RESPONSE`),
  ...['Responded', 'Interview', 'Offer', 'Hired'].map((status, index) => outcomeRow(9 + index, status)),
  outcomeRow(13, 'Evaluated', 'No reply as of 2026-11-30'),
  outcomeRow(14, 'Discarded', 'Closed by user: owner withdrew'),
  outcomeRow(15, 'Discarded', 'no response'),
  '',
].join('\r\n');

const expectedOutcomes = {
  responded: 5,
  responded_by_status: { Responded: 1, Interview: 1, Offer: 1, Hired: 1, Rejected: 1 },
  no_reply_noted: 2,
  latest_no_reply_date: '2026-11-15',
  unchecked: 1,
  awaiting_total: 3,
  closed_without_reply: 2,
  closure_note_on_active_rows: [2],
  warnings: [],
};

test('outcomes count posting groups, latest no-reply checks and closure rows separately', () => {
  assert.deepEqual(computeOutcomeStats(outcomeTracker), expectedOutcomes);
  assert.deepEqual(computeOutcomeStats(''), {
    responded: 0,
    responded_by_status: { Responded: 0, Interview: 0, Offer: 0, Hired: 0, Rejected: 0 },
    no_reply_noted: 0, latest_no_reply_date: null, unchecked: 0, awaiting_total: 0,
    closed_without_reply: 0, closure_note_on_active_rows: [], warnings: [],
  });
});

test('assembled stats add outcomes without changing funnel or rewriting tracker', (t) => {
  const root = mkdtempSync(join(ROOT, '.outcomes-stats-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data'));
  const appsFile = join(root, 'data', 'applications.md');
  writeFileSync(appsFile, outcomeTracker);
  const options = {
    appsFile, root,
    scanHistoryFile: join(root, 'missing-scan.tsv'), followupsFile: join(root, 'missing-followups.md'),
    scanRunsFile: join(root, 'missing-runs.tsv'), portalsFile: join(root, 'missing-portals.yml'),
  };
  const result = computeAllStats(options);
  assert.deepEqual(result.outcomes, expectedOutcomes);
  assert.equal(result.tracker.total, 15);
  assert.equal(result.tracker.byStatus.Applied, 4);
  assert.equal(result.funnel.everApplied, 8);
  assert.equal(result.funnel.everResponded, 3);
  assert.equal(readFileSync(appsFile, 'utf8'), outcomeTracker);
  assert.equal(computeAllStats({ ...options, appsFile: join(root, 'missing.md') }).outcomes, null);
  const summaryLines = [];
  t.mock.method(console, 'log', (line) => summaryLines.push(line));
  printSummary(result);
  assert.ok(summaryLines.some((line) => line.includes('Outcomes:   5 responded') && line.includes('3 awaiting')));
  assert.ok(summaryLines.some((line) => line.includes('2 no reply noted (latest 2026-11-15) | 1 unchecked | 2 closed without reply (rows)')));
  assert.ok(summaryLines.some((line) => line.includes('Closure note on active rows') && line.includes('#2')));
  t.mock.restoreAll();

  mkdirSync(join(root, 'output', 'identity-corrections'), { recursive: true });
  writeFileSync(join(root, 'output', 'identity-corrections', 'broken.json'), '{');
  const fallback = computeAllStats(options).outcomes;
  assert.equal(fallback.awaiting_total, 4);
  assert.equal(fallback.unchecked, 2);
  assert.equal(fallback.no_reply_noted, 2);
  assert.equal(fallback.latest_no_reply_date, '2026-11-14');
  assert.equal(fallback.closed_without_reply, 2);
  assert.deepEqual(fallback.closure_note_on_active_rows, [2]);
  assert.equal(fallback.responded, 5);
  assert.ok(fallback.warnings.some((warning) => warning.includes('identity corrections')));
  assert.equal(readFileSync(appsFile, 'utf8'), outcomeTracker);
});
