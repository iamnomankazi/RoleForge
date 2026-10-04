import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { classifyTier } from '../classify-tier.mjs';
import { createApplicationBatch } from '../application-batch.mjs';
import { mergeCandidates } from '../merge-scan-results.mjs';
import {
  buildScanRelevanceEvaluator,
  loadReApplyWindows,
  persistStandardScanRun,
} from '../scan.mjs';
import { writeImmutableScanRun } from '../scan-candidate-contract.mjs';
import {
  INTERAMT_HOME_URL,
  buildInteramtConfig,
  createInteramtPageOperations,
  discoverInteramtSearches,
  filterAndDeduplicateInteramtRows,
  normalizeInteramtOptions,
  normalizeInteramtResultRow,
  normalizeInteramtSearches,
  parseInteramtArgs,
  parseInteramtDate,
  resolveInteramtPaths,
  runInteramtScan,
} from '../scan-interamt.mjs';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const FIXTURE_HTML = readFileSync(join(ROOT, 'tests', 'fixtures', 'interamt-results.html'), 'utf8');
const LIVE_STRUCTURE_HTML = readFileSync(join(ROOT, 'tests', 'fixtures', 'interamt-live-structure.html'), 'utf8');
const INTERAMT_RESULT_ROW_SELECTOR = 'table.ia-e-table--searchresults > tbody > tr.ia-e-table__row';

function parseRowBlock(block) {
  const fields = {};
  for (const match of block.matchAll(/<td\b[^>]*data-field="([^"]+)"[^>]*>([\s\S]*?)<\/td>/gi)) {
    fields[match[1]] = match[2]
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return { fields, presentFields: Object.keys(fields) };
}

function fixtureRows(html = FIXTURE_HTML) {
  const blocks = [...html.matchAll(/<tr\b[^>]*class="[^"]*ia-e-table__row[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi)];
  return blocks.map(([, block]) => parseRowBlock(block));
}

function liveResultFixtureRows(html = LIVE_STRUCTURE_HTML) {
  const table = html.match(/<table\b(?=[^>]*class="[^"]*ia-e-table--searchresults[^"]*")[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  const body = table?.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
  if (!body) return [];
  const blocks = [...body.matchAll(/<tr\b[^>]*class="[^"]*ia-e-table__row[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi)];
  return blocks.map(([, block]) => parseRowBlock(block));
}

function allLiveStructureRows(html = LIVE_STRUCTURE_HTML) {
  const blocks = [...html.matchAll(/<tr\b[^>]*class="[^"]*ia-e-table__row[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi)];
  return blocks.map(([, block]) => parseRowBlock(block));
}

function makeDomRow(raw) {
  const cells = raw.presentFields.map((field) => ({
    innerText: raw.fields[field],
    getAttribute(name) { return name === 'data-field' ? field : null; },
    querySelector(selector) {
      if (field !== 'StellenangebotId' || selector !== 'span') return null;
      return { innerText: raw.fields[field] };
    },
  }));
  return { querySelectorAll(selector) { return selector === 'td[data-field]' ? cells : []; } };
}

class FakeLocator {
  constructor(page, selector) {
    this.page = page;
    this.selector = selector;
  }

  first() { return this; }

  count() {
    if (this.selector === INTERAMT_RESULT_ROW_SELECTOR) return this.page.rows.length;
    if (this.selector === 'tr.ia-e-table__row') return this.page.globalRows.length;
    if (this.selector === 'button.ia-m-searchresults__btn-load') return this.page.more ? 1 : 0;
    if (this.selector === '#idOrSuchtext') return this.page.landing ? 1 : 0;
    if (this.selector === '#ida') return this.page.landing ? 1 : 0;
    if (this.selector === 'button.ia-e-button--primary.ia-e-button--icon') return 0;
    if (this.selector.startsWith('a.ia-e-link--icon:has-text') || this.selector.startsWith('a:has-text')) {
      return this.page.criteriaAvailable ? 1 : 0;
    }
    if (this.selector.startsWith('input[name=')) return this.page.criteriaForm ? 1 : 0;
    if (this.selector.includes('Detailsuche')) return this.page.criteriaForm ? 1 : 0;
    if (this.selector === 'a.ia-e-link--icon:has-text("Suchkriterien ändern")'
        || this.selector === 'a:has-text("Suchkriterien ändern")') return 0;
    if (this.selector === '.ia-e-no-results' || this.selector === '.ia-no-results'
        || this.selector === '[class*="no-result"]') return this.page.noResults ? 1 : 0;
    if (this.selector === '.ia-e-backdrop' || this.selector === '.modal-backdrop'
        || this.selector === '.ui-widget-overlay' || this.selector === '[class*="backdrop"]') return 0;
    return 0;
  }

  async isVisible() {
    if (this.selector === INTERAMT_RESULT_ROW_SELECTOR) return this.page.rows.length > 0;
    if (this.selector === 'tr.ia-e-table__row') return this.page.globalRows.length > 0;
    if (this.selector === 'button.ia-m-searchresults__btn-load') return this.page.more;
    if (this.selector === '#idOrSuchtext' || this.selector === '#ida') return this.page.landing;
    if (this.selector.startsWith('a.ia-e-link--icon:has-text') || this.selector.startsWith('a:has-text')) return this.page.criteriaAvailable;
    if (this.selector.startsWith('input[name=')) return this.page.criteriaForm;
    if (this.selector.includes('Detailsuche')) return this.page.criteriaForm;
    if (this.selector.includes('no-result')) return this.page.noResults;
    return false;
  }

  async isEnabled() { return true; }

  async fill(value) { this.page.searchTerm = value; }

  async innerText() { return ''; }

  async evaluateAll(callback) {
    const rows = this.selector === INTERAMT_RESULT_ROW_SELECTOR ? this.page.rows : this.page.globalRows;
    return callback(rows.map(makeDomRow));
  }

  async all() { return []; }

  async waitFor({ state }) {
    if (state !== 'hidden') throw new Error(`unexpected wait state ${state}`);
  }

  async click() {
    if (this.selector.startsWith('a.ia-e-link--icon:has-text') || this.selector.startsWith('a:has-text')) {
      this.page.criteriaForm = true;
      this.page.rows = [];
      this.page.more = false;
      this.page.noResults = false;
      return;
    }
    if (this.selector === '#ida' || this.selector === 'button.ia-e-button--primary.ia-e-button--icon'
        || this.selector.includes('Detailsuche')) {
      const usingCriteriaForm = this.page.criteriaForm;
      this.page.landing = false;
      this.page.criteriaForm = false;
      this.page.criteriaAvailable = true;
      this.page.noResults = this.page.mode === 'empty';
      this.page.rows = this.page.noResults || this.page.mode === 'header-only' ? [] : [this.page.allRows[0]];
      this.page.more = !this.page.noResults;
      if (!usingCriteriaForm) this.page.currentUrl = `${INTERAMT_HOME_URL}?search=${encodeURIComponent(this.page.searchTerm)}`;
      return;
    }
    if (this.selector === 'button.ia-m-searchresults__btn-load') {
      if (!this.page.noGrowth && this.page.allRows[1]) this.page.rows.push(this.page.allRows[1]);
      if (!this.page.noGrowth) this.page.more = false;
      return;
    }
    throw new Error(`unexpected click on ${this.selector}`);
  }
}

class FakePage {
  constructor({ mode = 'results', rows = fixtureRows(), globalRows = rows, noGrowth = false } = {}) {
    this.allRows = rows;
    this.rows = [];
    this.globalRows = globalRows;
    this.mode = mode;
    this.noGrowth = noGrowth;
    this.landing = true;
    this.criteriaAvailable = false;
    this.criteriaForm = false;
    this.more = false;
    this.noResults = false;
    this.searchTerm = '';
    this.currentUrl = 'about:blank';
  }

  locator(selector) { return new FakeLocator(this, selector); }

  async goto(url) {
    this.currentUrl = url;
    this.landing = true;
    this.criteriaAvailable = false;
    this.criteriaForm = false;
    this.rows = [];
    this.more = false;
    this.noResults = false;
  }

  url() { return this.currentUrl; }

  async waitForTimeout(ms) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
  }
}

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'career-ops-interamt-'));
}

function writePortals(root, value) {
  writeFileSync(join(root, 'portals.yml'), value, 'utf8');
}

function fakeBrowser(page) {
  return {
    async newPage(options) {
      page.contextOptions = options;
      return page;
    },
    async close() { page.browserClosed = true; },
  };
}

test('Interamt CLI parsing is bounded and rejects malformed/help-mixed invocations', () => {
  assert.deepEqual(parseInteramtArgs(['--dry-run', '--keyword', ' Python ', '--keyword=Data Engineer']), {
    help: false, dryRun: true, keywords: ['Python', 'Data Engineer'],
  });
  assert.equal(parseInteramtArgs(['-h']).help, true);
  for (const args of [
    ['--unknown'], ['role'], ['--keyword'], ['--keyword', '--dry-run'], ['--keyword='],
    ['--dry-run', '--dry-run'], ['--help', '--unknown'], ['--help', 'role'],
  ]) {
    assert.throws(() => parseInteramtArgs(args), undefined, args.join(' '));
  }
});

test('Interamt search config trims/deduplicates values, supports profile fallback, and enforces option caps', () => {
  assert.deepEqual(normalizeInteramtSearches([{ was: ' Data Engineer ' }, { was: 'data engineer' }]), [
    { was: 'Data Engineer' },
  ]);
  assert.deepEqual(buildInteramtConfig({
    portalsConfig: { interamt_searches: [], interamt: { max_load_more: 3 } },
    profileConfig: { target_roles: { primary: [' Python Developer ', 'Python Developer'] } },
  }), {
    searches: [{ was: 'Python Developer' }],
    options: { max_load_more: 3, page_timeout_ms: 15_000, wait_timeout_ms: 10_000 },
  });
  assert.deepEqual(normalizeInteramtOptions({}), {
    max_load_more: 10, page_timeout_ms: 15_000, wait_timeout_ms: 10_000,
  });
  assert.throws(() => normalizeInteramtOptions({ max_load_more: 51 }), /0 to 50/);
  assert.throws(() => normalizeInteramtOptions({ page_timeout_ms: 60_001 }), /1 to 60000/);
  assert.throws(() => normalizeInteramtOptions({ unknown: 1 }), /unknown interamt option/);
  assert.throws(() => normalizeInteramtSearches([{ was: ' ' }]), /must not be empty/);
  assert.throws(() => normalizeInteramtSearches(Array.from({ length: 21 }, (_, i) => ({ was: `role ${i}` }))), /at most 20/);
});

test('Interamt config paths resolve from the selected root and honor explicit portals/profile paths', () => {
  const cwd = makeTempRoot();
  try {
    const paths = resolveInteramtPaths({
      cwd,
      projectRoot: 'C:/career-ops',
      env: {
        CAREER_OPS_SCAN_ROOT: 'fixture-root',
        CAREER_OPS_PORTALS: 'settings/private-portals.yml',
        CAREER_OPS_PROFILE: 'profiles/private-profile.yml',
      },
    });
    assert.equal(paths.root, join(cwd, 'fixture-root'));
    assert.equal(paths.portalsPath, join(cwd, 'fixture-root', 'settings', 'private-portals.yml'));
    assert.equal(paths.profilePath, join(cwd, 'fixture-root', 'profiles', 'private-profile.yml'));
    assert.equal(paths.scanHistoryPath, join(cwd, 'fixture-root', 'data', 'scan-history.tsv'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('Interamt dates stay strict while the known deadline marker maps to nullable expiry', () => {
  assert.equal(parseInteramtDate('29.02.2024'), '2024-02-29');
  assert.equal(parseInteramtDate('31.12.2026'), '2026-12-31');
  assert.equal(parseInteramtDate(''), null);
  assert.throws(() => parseInteramtDate('baldmöglichst'), /DD\.MM\.YYYY/);
  for (const value of ['29.02.2025', '31.04.2026', '1.01.2026', '2026-01-01', '00.12.2026']) {
    assert.throws(() => parseInteramtDate(value), /DD\.MM\.YYYY|calendar date/);
  }
  const [raw] = fixtureRows();
  const row = normalizeInteramtResultRow(raw);
  assert.equal(row.url, `${INTERAMT_HOME_URL}stelle?id=624001`);
  assert.equal(row.sourceUrl, INTERAMT_HOME_URL);
  assert.equal(row.provider, 'interamt');
  assert.equal(row.sourceId, '624001');
  assert.equal(row.company, 'Bundesamt für Datenverarbeitung');
  assert.equal(row.location, 'Bonn, 53117 Bonn');
  assert.equal(row.postedAt, '2026-09-01');
  assert.equal(row.expiresAt, '2026-10-30');
  const markerRow = normalizeInteramtResultRow({
    ...raw, fields: { ...raw.fields, Bewerbungsfrist: '  baldmöglichst  ' },
  });
  assert.equal(markerRow.expiresAt, null, 'the known open-ended marker carries no inferred expiry date');
  const emptyDeadlineRow = normalizeInteramtResultRow({
    ...raw, fields: { ...raw.fields, Bewerbungsfrist: '' },
  });
  assert.equal(emptyDeadlineRow.expiresAt, null);
  for (const value of ['ab sofort', 'unbekannt', '31.04.2026']) {
    assert.throws(() => normalizeInteramtResultRow({
      ...raw, fields: { ...raw.fields, Bewerbungsfrist: value },
    }), /Interamt Bewerbungsfrist (must use DD\.MM\.YYYY|is not a real calendar date)/);
  }
  assert.throws(() => normalizeInteramtResultRow({
    ...raw, fields: { ...raw.fields, Von: 'baldmöglichst' },
  }), /Interamt Von must use DD\.MM\.YYYY/);
  assert.doesNotMatch(JSON.stringify(row), /wicket|\?\d{1,5}:/i);
  assert.throws(() => normalizeInteramtResultRow({
    ...raw, fields: { ...raw.fields, StellenangebotId: '624001x' },
  }), /positive numeric ID/);
  assert.throws(() => normalizeInteramtResultRow({
    ...raw, presentFields: raw.presentFields.filter((field) => field !== 'Bewerbungsfrist'),
  }), /missing td\[data-field="Bewerbungsfrist"\]/);
});

test('a textual deadline survives production search normalization with its source query intact', async () => {
  const [base] = fixtureRows();
  const rows = [
    { ...base, fields: { ...base.fields, Bewerbungsfrist: '  baldmöglichst  ' } },
    {
      ...base,
      fields: {
        ...base.fields,
        StellenangebotId: '624002',
        Bewerbungsfrist: '15.11.2026',
      },
    },
  ];
  const page = new FakePage({ rows });
  await page.goto(INTERAMT_HOME_URL);
  const discovered = await discoverInteramtSearches({
    searches: [{ was: 'Data Analyst' }],
    pageOperations: createInteramtPageOperations(
      page,
      normalizeInteramtOptions({ max_load_more: 1, wait_timeout_ms: 100 }),
    ),
  });

  assert.equal(discovered.searchesSucceeded, 1);
  assert.equal(discovered.searchesEmpty, 0);
  assert.deepEqual(discovered.errors, []);
  assert.deepEqual(discovered.rows.map((row) => row.sourceId), ['624001', '624002']);
  assert.deepEqual(discovered.rows.map((row) => row.expiresAt), [null, '2026-11-15']);
  assert.deepEqual(discovered.rows.map((row) => row.sourceQuery), ['Data Analyst', 'Data Analyst']);
  assert.ok(discovered.rows.every((row) => row.sourceQueries.includes('Data Analyst')));
});

test('shared relevance evaluator applies title, tier, location, salary, content, sponsorship, and numeric experience policy', () => {
  const evaluate = buildScanRelevanceEvaluator({
    title_filter: { positive: ['Data Engineer'], negative: ['Principal'] },
    skip_tiers: ['senior'],
    location_filter: { always_allow: ['Germany', 'Finland'], allow: ['Remote Europe'] },
    salary_filter: { min: 55_000, max: 0, currency: 'EUR' },
    experience_policy: { normal_max_years: 2, outside_min_years: 4 },
    content_filter: { negative: ['no visa sponsorship', '5 years'] },
  }, { classifyTier });
  const base = { title: 'Data Engineer', company: 'Agency', url: `${INTERAMT_HOME_URL}stelle?id=9001` };
  assert.equal(evaluate({ ...base, title: 'Python Developer' }).reason, 'title');
  assert.equal(evaluate({ ...base, title: 'Senior Data Engineer' }).reason, 'tier');
  assert.equal(evaluate({ ...base, location: 'Boston, United States' }).reason, 'location');
  assert.equal(evaluate({ ...base, location: 'Berlin, Germany', salary: { min: 50_000, currency: 'EUR' } }).reason, 'salary');
  assert.equal(evaluate({ ...base, location: 'Berlin, Germany', description: 'No visa sponsorship is available.' }).reason, 'content');

  const numeric = { ...base, location: 'Berlin, Germany', description: 'Required qualifications: 5 years of professional data engineering experience.' };
  const result = evaluate(numeric);
  assert.equal(result.eligible, true);
  assert.equal(numeric.experienceMetadata.numeric_hard_blocker, true);
  assert.match(numeric.hardBlockers[0], /required experience starts at 5 years/);
  assert.equal(numeric.locationEligibility, 'eligible');
  assert.equal(evaluate({ ...base, location: '', description: '' }).eligible, true, 'missing descriptions and locations retain conservative standard-scan behavior');
});

test('Interamt filters before dedup and merges query provenance without poisoning unseen rows', () => {
  const evaluate = buildScanRelevanceEvaluator({
    title_filter: { positive: ['Data Engineer'] },
    location_filter: { always_allow: ['Germany'] },
  });
  const raw = fixtureRows().map(normalizeInteramtResultRow);
  const rejectedThenAllowed = {
    ...raw[0], location: 'Boston, United States', sourceQuery: 'first query', sourceQueries: ['first query'],
  };
  const allowedSameId = {
    ...raw[0], location: 'Bonn, Germany', sourceQuery: 'second query', sourceQueries: ['second query'],
  };
  const duplicateQuery = {
    ...raw[0], location: 'Bonn, Germany', sourceQuery: 'third query', sourceQueries: ['third query'],
  };
  const historyDuplicate = { ...raw[1], location: 'Berlin, Germany', sourceQuery: 'history query' };
  const result = filterAndDeduplicateInteramtRows(
    [rejectedThenAllowed, allowedSameId, duplicateQuery, historyDuplicate],
    {
      evaluateRelevance: evaluate,
      seenUrls: new Set([raw[1].url]),
    },
  );
  assert.equal(result.filtered.location, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceId, '624001');
  assert.deepEqual(result.candidates[0].sourceQueries, ['second query', 'third query']);
  assert.equal(result.duplicates, 2);
});

test('same company/role listings retain distinct IDs and canonical duplicate review notes', () => {
  const evaluate = buildScanRelevanceEvaluator({});
  const [base] = fixtureRows().map(normalizeInteramtResultRow);
  const rows = [
    { ...base, title: 'Data Engineer', sourceId: '624101', url: `${INTERAMT_HOME_URL}stelle?id=624101` },
    { ...base, title: 'Data Engineer', sourceId: '624102', url: `${INTERAMT_HOME_URL}stelle?id=624102` },
  ];
  const result = filterAndDeduplicateInteramtRows(rows, {
    evaluateRelevance: evaluate,
    seenCompanyRoles: new Set([`${base.company.toLowerCase()}::data engineer`]),
  });
  assert.equal(result.candidates.length, 2, 'distinct Interamt posting IDs remain reviewable separately');
  assert.ok(result.candidates.every((candidate) => candidate.possibleDuplicate === true));
  assert.ok(result.candidates.every((candidate) => candidate.notes.includes('applications tracker row')));
  assert.ok(result.candidates.every((candidate) => candidate.notes.includes('another Interamt listing')));
  const root = makeTempRoot();
  try {
    const written = writeImmutableScanRun({
      root,
      runId: 'interamt-duplicate-review',
      createdAt: '2026-10-01T12:00:00.000Z',
      sourceArchitecture: 'interamt_scan',
      inputs: [{ name: 'interamt', rows: result.candidates }],
    });
    const candidates = JSON.parse(readFileSync(join(written.runDir, 'candidates.json'), 'utf8'));
    assert.equal(candidates.length, 2);
    assert.equal(new Set(candidates.map((candidate) => candidate.candidate_id)).size, 2);
    assert.ok(candidates.every((candidate) => candidate.notes.includes('Possible duplicate:')));

    const merged = mergeCandidates([{ name: 'interamt-candidates.json', rows: candidates }], { runId: 'interamt-duplicate-merge' });
    assert.equal(merged.candidates.length, 2);
    assert.ok(merged.candidates.every((candidate) => candidate.source === 'interamt'));
    const batch = createApplicationBatch({
      root,
      sourceRunId: 'interamt-duplicate-review',
      selectedCandidateIds: candidates.map((candidate) => candidate.candidate_id),
      batchId: 'interamt-duplicate-batch',
    });
    assert.equal(batch.manifest.candidates.length, 2);
    assert.deepEqual(batch.manifest.candidates.map((candidate) => candidate.candidate_id), candidates.map((candidate) => candidate.candidate_id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Wicket page operations handle load-more growth, explicit empty results, cap partials, and no-growth failures', async () => {
  const options = normalizeInteramtOptions({ max_load_more: 1, wait_timeout_ms: 100 });
  const page = new FakePage();
  await page.goto(INTERAMT_HOME_URL);
  const search = await createInteramtPageOperations(page, options).search('Data Engineer');
  assert.equal(search.empty, false);
  assert.equal(search.capped, false);
  assert.equal(search.rows.length, 2);
  assert.deepEqual(search.rows.map((row) => row.sourceQuery), ['Data Engineer', 'Data Engineer']);

  const emptyPage = new FakePage({ mode: 'empty' });
  await emptyPage.goto(INTERAMT_HOME_URL);
  const emptyOperations = createInteramtPageOperations(emptyPage, options);
  assert.deepEqual(await emptyOperations.search('No matching role'), {
    rows: [], empty: true, capped: false,
  });
  assert.deepEqual(await emptyOperations.search('Another unmatched role'), {
    rows: [], empty: true, capped: false,
  }, 'a previous no-results marker must not prevent later explicit empty searches');

  const capPage = new FakePage();
  await capPage.goto(INTERAMT_HOME_URL);
  const capped = await createInteramtPageOperations(capPage, normalizeInteramtOptions({ max_load_more: 0 }))
    .search('Data Engineer');
  assert.equal(capped.capped, true);
  assert.equal(capped.rows.length, 1);

  const noGrowthPage = new FakePage({ noGrowth: true });
  await noGrowthPage.goto(INTERAMT_HOME_URL);
  await assert.rejects(
    createInteramtPageOperations(noGrowthPage, normalizeInteramtOptions({ wait_timeout_ms: 10 }))
      .search('Data Engineer'),
    /made no row growth/,
  );
});

test('Interamt page operations scope header, load-more, and cookie rows away from strict result validation', async () => {
  const resultRows = liveResultFixtureRows();
  const globalRows = allLiveStructureRows();
  assert.equal(resultRows.length, 20);
  assert.ok(resultRows.every((row) => row.presentFields.length === 10));
  assert.equal(globalRows.length, 31, 'the broad class selector also sees the header and consent detail rows');
  assert.equal(globalRows.filter((row) => row.presentFields.length === 0).length, 11);

  const page = new FakePage({ rows: resultRows, globalRows });
  await page.goto(INTERAMT_HOME_URL);
  const result = await createInteramtPageOperations(page, normalizeInteramtOptions({ max_load_more: 1 }))
    .search('Informatik');
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((row) => row.title.startsWith('Informatik Fachkraft')));

  const malformedResult = {
    ...resultRows[0],
    presentFields: resultRows[0].presentFields.filter((field) => field !== 'Stellenbezeichnung'),
  };
  const malformedPage = new FakePage({ rows: [malformedResult], globalRows });
  await malformedPage.goto(INTERAMT_HOME_URL);
  await assert.rejects(
    createInteramtPageOperations(malformedPage, normalizeInteramtOptions({ max_load_more: 0 }))
      .search('Informatik'),
    /missing td\[data-field="Stellenbezeichnung"\]/,
  );

  const reusedHeaderOnlyPage = new FakePage({ mode: 'header-only', rows: resultRows, globalRows });
  await reusedHeaderOnlyPage.goto(INTERAMT_HOME_URL);
  reusedHeaderOnlyPage.landing = false;
  reusedHeaderOnlyPage.criteriaAvailable = true;
  reusedHeaderOnlyPage.rows = [resultRows[0]];
  reusedHeaderOnlyPage.currentUrl = `${INTERAMT_HOME_URL}trefferliste?reused`;
  await assert.rejects(
    createInteramtPageOperations(reusedHeaderOnlyPage, normalizeInteramtOptions({ wait_timeout_ms: 25 }))
      .search('Informatik'),
    /timed out without new result rows or an explicit no-results marker/,
    'header and consent rows alone must not make a reused search appear ready',
  );
});

test('search orchestration records local errors, accepts explicit empties, and fails when every query fails', async () => {
  const calls = [];
  const result = await discoverInteramtSearches({
    searches: [{ was: 'empty' }, { was: 'partial failure' }, { was: 'results' }],
    pageOperations: {
      async search(was) {
        calls.push(was);
        if (was === 'empty') return { rows: [], empty: true, capped: false };
        if (was === 'partial failure') throw new Error('Wicket request timed out');
        return { rows: [{ company: 'Agency', title: 'Data Engineer', url: 'https://interamt.de/koop/app/stelle?id=77' }], empty: false, capped: true };
      },
    },
  });
  assert.deepEqual(calls, ['empty', 'partial failure', 'results']);
  assert.equal(result.searchesSucceeded, 2);
  assert.equal(result.searchesEmpty, 1);
  assert.equal(result.searchesCapped, 1);
  assert.deepEqual(result.errors, [{ was: 'partial failure', error: 'Wicket request timed out' }]);
  const malformed = await discoverInteramtSearches({
    searches: [{ was: 'malformed row' }, { was: 'empty' }],
    pageOperations: { async search(was) {
      return was === 'empty'
        ? { rows: [], empty: true, capped: false }
        : { rows: [null], empty: false, capped: false };
    } },
  });
  assert.equal(malformed.searchesSucceeded, 1);
  assert.deepEqual(malformed.errors, [{ was: 'malformed row', error: 'Interamt search returned a non-object row' }]);
  await assert.rejects(discoverInteramtSearches({
    searches: [{ was: 'failed' }],
    pageOperations: { async search() { throw new Error('timeout'); } },
  }), /all Interamt searches failed; no scan run was written/);
});

test('imports, invalid CLI, help, and dry runs create no directories or artifacts', async () => {
  const root = makeTempRoot();
  try {
    const moduleUrl = pathToFileURL(join(ROOT, 'scan-interamt.mjs')).href;
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)})`], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CAREER_OPS_SCAN_ROOT: root },
    });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, '');
    assert.equal(existsSync(join(root, 'data')), false);
    assert.equal(existsSync(join(root, 'output')), false);

    let launched = 0;
    let wrote = 0;
    await assert.rejects(runInteramtScan({
      argv: ['--help', '--unknown'], browserFactory: async () => { launched++; }, writeRun: () => { wrote++; },
    }), /unknown option/);
    assert.equal(launched, 0);
    assert.equal(wrote, 0);
    const help = await runInteramtScan({
      argv: ['--help'], browserFactory: async () => { launched++; }, writeRun: () => { wrote++; }, log() {},
    });
    assert.equal(help.exitCode, 0);
    assert.equal(launched, 0);

    writePortals(root, 'interamt_searches:\n  - was: Data Engineer\n');
    const page = new FakePage();
    const dryRun = await runInteramtScan({
      argv: ['--dry-run'], env: { CAREER_OPS_SCAN_ROOT: root }, cwd: root, projectRoot: root,
      browserFactory: async () => { launched++; return fakeBrowser(page); },
      pageOperationsFactory: () => ({ async search(was) {
        const row = normalizeInteramtResultRow(fixtureRows()[0]);
        return { rows: [{ ...row, sourceQuery: was, sourceQueries: [was] }], empty: false, capped: false };
      } }),
      writeRun: () => { wrote++; }, now: () => new Date('2026-10-01T12:00:00.000Z'), log() {},
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.candidates, 1);
    assert.equal(wrote, 0);
    assert.equal(existsSync(join(root, 'data')), false);
    assert.equal(existsSync(join(root, 'output')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared scanner default helpers read environment paths when called, while CLI dotenv loads before config resolution', () => {
  const root = makeTempRoot();
  const originalProfile = process.env.CAREER_OPS_PROFILE;
  const originalScanRoot = process.env.CAREER_OPS_SCAN_ROOT;
  try {
    const profile = join(root, 'profile.yml');
    const scanRoot = join(root, 'scan-root');
    writeFileSync(profile, [
      're_apply_windows:',
      '  Acme:',
      '    last_apply_date: "2026-09-01"',
      '    same_role_days: 30',
    ].join('\n') + '\n', 'utf8');
    process.env.CAREER_OPS_PROFILE = profile;
    process.env.CAREER_OPS_SCAN_ROOT = scanRoot;
    assert.deepEqual(loadReApplyWindows(), {
      Acme: { last_apply_date: '2026-09-01', same_role_days: 30 },
    });
    const persisted = persistStandardScanRun({ runId: 'env-root-run', offers: [] });
    assert.equal(persisted.runDir, join(scanRoot, 'output', 'scan-runs', 'env-root-run'));
  } finally {
    if (originalProfile === undefined) delete process.env.CAREER_OPS_PROFILE;
    else process.env.CAREER_OPS_PROFILE = originalProfile;
    if (originalScanRoot === undefined) delete process.env.CAREER_OPS_SCAN_ROOT;
    else process.env.CAREER_OPS_SCAN_ROOT = originalScanRoot;
    rmSync(root, { recursive: true, force: true });
  }

  const fixture = makeTempRoot();
  try {
    const portalsPath = join(fixture, 'custom-portals.yml');
    const profilePath = join(fixture, 'custom-profile.yml');
    const providersPath = join(fixture, 'custom-providers');
    mkdirSync(providersPath);
    writeFileSync(portalsPath, [
      'tracked_companies:',
      '  - name: Example',
      '    provider: fixture',
      '    enabled: true',
      '    careers_url: https://fixture.example/jobs',
      'title_filter:',
      '  positive: [engineer]',
    ].join('\n') + '\n', 'utf8');
    writeFileSync(join(providersPath, 'fixture.mjs'), [
      "export default { id: 'fixture', async fetch(entry) { return [{ company: entry.name, title: 'Data Engineer', url: 'https://fixture.example/jobs/123', location: 'Helsinki, Finland' }]; } };",
    ].join('\n'), 'utf8');
    writeFileSync(profilePath, [
      're_apply_windows:',
      '  Example:',
      `    last_apply_date: "${new Date().toISOString().slice(0, 10)}"`,
      '    same_role_days: 30',
      '    applied_to: [Data Engineer]',
    ].join('\n') + '\n', 'utf8');
    writeFileSync(join(fixture, '.env'), [
      `CAREER_OPS_PORTALS=${portalsPath.replace(/\\/g, '/')}`,
      `CAREER_OPS_PROFILE=${profilePath.replace(/\\/g, '/')}`,
      `CAREER_OPS_PROVIDERS_DIR=${providersPath.replace(/\\/g, '/')}`,
      `CAREER_OPS_SCAN_ROOT=${fixture.replace(/\\/g, '/')}`,
    ].join('\n') + '\n', 'utf8');

    const childEnv = { ...process.env, CAREER_OPS_SCAN_ROOT: fixture };
    delete childEnv.CAREER_OPS_PORTALS;
    delete childEnv.CAREER_OPS_PROFILE;
    delete childEnv.CAREER_OPS_PROVIDERS_DIR;
    const child = spawnSync(process.execPath, [join(ROOT, 'scan.mjs'), '--dry-run'], {
      cwd: fixture,
      encoding: 'utf8',
      env: childEnv,
      timeout: 15_000,
    });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /Companies scanned:\s+1/);
    assert.match(child.stdout, /Filtered by cooldown:\s+1 removed/);
    assert.equal(existsSync(join(fixture, 'data')), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('normal Interamt scan writes only the canonical review run under the injected root', async () => {
  const root = makeTempRoot();
  try {
    writePortals(root, 'interamt_searches:\n  - was: Data Engineer\n');
    const page = new FakePage();
    const row = normalizeInteramtResultRow(fixtureRows()[0]);
    const result = await runInteramtScan({
      argv: [], env: { CAREER_OPS_SCAN_ROOT: root }, cwd: root, projectRoot: root,
      browserFactory: async () => fakeBrowser(page),
      pageOperationsFactory: () => ({ async search(was) {
        return { rows: [{ ...row, sourceQuery: was, sourceQueries: [was] }], empty: false, capped: false };
      } }),
      writeRun: (options) => writeImmutableScanRun(options),
      now: () => new Date('2026-10-01T12:00:00.000Z'), pid: 77, log() {},
    });
    assert.equal(result.candidates, 1);
    assert.ok(result.output.startsWith(join(root, 'output', 'scan-runs')));
    assert.equal(existsSync(join(root, 'data')), false);
    const manifest = JSON.parse(readFileSync(join(result.output, 'manifest.json'), 'utf8'));
    const [candidate] = JSON.parse(readFileSync(join(result.output, 'candidates.json'), 'utf8'));
    assert.equal(manifest.source_architecture, 'interamt_scan');
    assert.equal(manifest.metadata.scanner, 'interamt');
    assert.equal(manifest.metadata.coverage.status, 'complete');
    assert.deepEqual(manifest.metadata.errors, []);
    assert.equal(candidate.provider, 'interamt');
    assert.equal(candidate.source, 'interamt');
    assert.equal(candidate.source_id, '624001');
    assert.equal(candidate.source_query, 'Data Engineer');
    assert.deepEqual(candidate.source_queries, ['Data Engineer']);
    assert.equal(candidate.source_url, INTERAMT_HOME_URL);
    assert.equal(candidate.expires_at, '2026-10-30');
    assert.equal(candidate.url, `${INTERAMT_HOME_URL}stelle?id=624001`);
    assert.doesNotMatch(candidate.url, /wicket/i);
    const merged = mergeCandidates([{ name: 'interamt-candidates.json', rows: [candidate] }], { runId: 'interamt-roundtrip' });
    assert.equal(merged.candidates[0].source, 'interamt');
    assert.equal(merged.candidates[0].source_id, candidate.source_id);
    const batch = createApplicationBatch({
      root, sourceRunId: result.runId, selectedCandidateIds: [candidate.candidate_id], batchId: 'interamt-compatibility',
    });
    assert.equal(batch.manifest.candidates[0].candidate_id, candidate.candidate_id);
    assert.equal(batch.manifest.candidates[0].listingUrl, candidate.url);
    assert.deepEqual(readdirSync(join(root, 'output', 'scan-runs', result.runId)).sort(), [
      'candidates.json', 'candidates.tsv', 'manifest.json', 'review.csv', 'review.md',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Interamt reads canonical URL history from its selected root and leaves history bytes untouched', async () => {
  const root = makeTempRoot();
  try {
    writePortals(root, [
      'scan_history:',
      '  recheck_after_days: 30',
      'interamt_searches:',
      '  - was: Data Engineer',
    ].join('\n') + '\n');
    mkdirSync(join(root, 'data'), { recursive: true });
    const historyPath = join(root, 'data', 'scan-history.tsv');
    const history = [
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation',
      'https://interamt.de/koop/app/stelle?id=624001\t2026-09-30\tinteramt\tJunior Data Engineer\tBundesamt\tadded\tBonn, Germany',
      '',
    ].join('\n');
    writeFileSync(historyPath, history, 'utf8');
    const page = new FakePage();
    const row = normalizeInteramtResultRow(fixtureRows()[0]);
    const result = await runInteramtScan({
      argv: [], env: { CAREER_OPS_SCAN_ROOT: root }, cwd: root, projectRoot: root,
      browserFactory: async () => fakeBrowser(page),
      pageOperationsFactory: () => ({ async search(was) {
        return { rows: [{ ...row, sourceQuery: was, sourceQueries: [was] }], empty: false, capped: false };
      } }),
      writeRun: (options) => writeImmutableScanRun(options),
      now: () => new Date('2026-10-01T12:00:00.000Z'), pid: 79, log() {},
    });
    assert.equal(result.candidates, 0);
    assert.equal(result.metadata.coverage.rows_deduplicated, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(result.output, 'candidates.json'), 'utf8')), []);
    assert.equal(readFileSync(historyPath, 'utf8'), history);
    assert.equal(existsSync(join(root, 'data', 'pipeline.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed config fails before browser launch or output creation', async () => {
  const root = makeTempRoot();
  try {
    writePortals(root, 'interamt_searches:\n  - was: Data Engineer\ninteramt:\n  max_load_more: 51\n');
    let launched = 0;
    await assert.rejects(runInteramtScan({
      argv: [], env: { CAREER_OPS_SCAN_ROOT: root }, cwd: root, projectRoot: root,
      browserFactory: async () => { launched++; }, log() {},
    }), /max_load_more must be an integer from 0 to 50/);
    assert.equal(launched, 0);
    assert.deepEqual(readdirSync(root), ['portals.yml']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('partial discovery is visible in canonical metadata; all-search failure writes no run', async () => {
  const root = makeTempRoot();
  try {
    writePortals(root, [
      'interamt_searches:',
      '  - was: No matching role',
      '  - was: Timed out role',
    ].join('\n') + '\n');
    const emptyPage = new FakePage({ mode: 'empty' });
    const partial = await runInteramtScan({
      argv: [], env: { CAREER_OPS_SCAN_ROOT: root }, cwd: root, projectRoot: root,
      browserFactory: async () => fakeBrowser(emptyPage),
      pageOperationsFactory: () => ({ async search(was) {
        if (was === 'Timed out role') throw new Error('Wicket response timed out');
        return { rows: [], empty: true, capped: false };
      } }),
      writeRun: (options) => writeImmutableScanRun(options),
      now: () => new Date('2026-10-01T12:00:00.000Z'), pid: 78, log() {},
    });
    const partialManifest = JSON.parse(readFileSync(join(partial.output, 'manifest.json'), 'utf8'));
    assert.equal(partialManifest.metadata.coverage.status, 'partial');
    assert.equal(partialManifest.metadata.coverage.searches_succeeded, 1);
    assert.equal(partialManifest.metadata.coverage.searches_failed, 1);
    assert.deepEqual(partialManifest.metadata.errors, [{ was: 'Timed out role', error: 'Wicket response timed out' }]);
    assert.equal(partialManifest.candidate_count, 0);
    assert.equal(existsSync(join(root, 'data')), false);

    rmSync(join(root, 'output'), { recursive: true, force: true });
    let writes = 0;
    await assert.rejects(runInteramtScan({
      argv: [], env: { CAREER_OPS_SCAN_ROOT: root }, cwd: root, projectRoot: root,
      browserFactory: async () => fakeBrowser(new FakePage()),
      pageOperationsFactory: () => ({ async search(was) { throw new Error(`failed ${was}`); } }),
      writeRun: () => { writes++; }, log() {},
    }), /all Interamt searches failed; no scan run was written/);
    assert.equal(writes, 0);
    assert.equal(existsSync(join(root, 'output')), false);
    assert.equal(existsSync(join(root, 'data')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
