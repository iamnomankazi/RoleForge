// Salary evidence: complete-posting captures and exact-candidate report compensation. Synthetic files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFreshnessProblem, POSTING_CAPTURE_MAX_AGE_DAYS, reportCompensationFor, verifiedPostingCapture } from '../salary-evidence.mjs';
import { buildCandidateFormContext } from '../application-browser-executor.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const ID = `cand_v1_${'a'.repeat(64)}`;
const OTHER = `cand_v1_${'b'.repeat(64)}`;
const POSTING = 'Data Engineer at Example Oy. Build pipelines in Python and SQL. Apply by Friday.';

const URL_1 = 'https://boards.example-ats.test/jobs/1';

function fixture({ record = {}, entry = {}, tool = 'enrich-run', text = POSTING, tamperLiveness = false, tamperEnrichment = null,
  candidateUrl = URL_1, enrichmentHash = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'salary-evidence-'));
  const live = join(root, 'liveness');
  mkdirSync(join(live, 'descriptions'), { recursive: true });
  writeFileSync(join(live, 'descriptions', `${ID}.txt`), `${text}\n`);
  const rows = { [ID]: {
    status: 'active', method: 'api', checked_at: new Date(Date.now() - 86_400_000).toISOString(), final_url: URL_1,
    description_chars: POSTING.length, description_sha256: sha(Buffer.from(POSTING, 'utf8')), description_source: 'api', posting_complete: true,
    reason: 'live', ...record,
  } };
  const bytes = Buffer.from(JSON.stringify(rows));
  writeFileSync(join(live, 'liveness.json'), bytes);
  const run = join(root, 'run');
  mkdirSync(run);
  const enrichment = Buffer.from(JSON.stringify([{ source_candidate_id: ID, candidate_id: ID, changes: ['liveness_copied'], liveness_status: 'active', ...entry }]));
  writeFileSync(join(run, 'manifest.json'), JSON.stringify({ metadata: {
    tool, liveness_dir: live, liveness_sha256: sha(bytes), ...(enrichmentHash ? { enrichment_sha256: sha(enrichment) } : {}),
  } }));
  writeFileSync(join(run, 'enrichment.json'), tamperEnrichment ? Buffer.from(JSON.stringify(tamperEnrichment)) : enrichment);
  writeFileSync(join(run, 'candidates.json'), JSON.stringify([{ candidate_id: ID, url: candidateUrl }, { candidate_id: OTHER, url: 'https://boards.example-ats.test/jobs/2' }]));
  if (tamperLiveness) writeFileSync(join(live, 'liveness.json'), Buffer.from(JSON.stringify({ ...rows, extra: {} })));
  return { root, candidatesPath: join(run, 'candidates.json') };
}

function withFixture(options, check) {
  const { root, candidatesPath } = fixture(options);
  try { return check(verifiedPostingCapture({ candidatesPath, candidateId: ID }), { root, candidatesPath }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('an intact API capture recorded as the whole posting, of the exact candidate URL, is the complete posting', () => {
  withFixture({}, (result) => {
    assert.equal(result.complete, true);
    assert.equal(result.text, POSTING);
    assert.match(result.basis, /^api capture/);
  });
  withFixture({ candidateUrl: `${URL_1}/#apply` }, (result) => assert.equal(result.complete, true, 'trailing slash and fragment ignored'));
});

test('excerpts, older captures, partial pages and tampered or re-sourced records are never complete', () => {
  const cases = [
    [{ record: { description_source: undefined } }, /captures made before/],
    [{ record: { description_source: 'prior' } }, /came from the posting itself/],
    // A browser capture reads one page section (a pay sidebar may sit outside it): never the whole posting.
    [{ record: { method: 'browser', description_source: 'browser', posting_complete: false } }, /not recorded as the whole posting/],
    [{ record: { posting_complete: undefined } }, /not recorded as the whole posting/],
    // A redirect to another requisition is not this candidate's posting.
    [{ record: { final_url: 'https://boards.example-ats.test/jobs/456' } }, /different address/],
    [{ candidateUrl: 'https://boards.example-ats.test/jobs/123' }, /different address/],
    // The candidate-to-capture mapping must be the one the run was built with.
    [{ tamperEnrichment: [{ source_candidate_id: OTHER, candidate_id: ID, changes: [], liveness_status: 'active' }] }, /enrichment record changed/],
    [{ enrichmentHash: false }, /does not record its enrichment hash/],
    [{ record: { status: 'unconfirmed' } }, /not of an active posting/],
    [{ entry: { changes: ['listing_url_resourced'] } }, /re-sourced/],
    [{ entry: { liveness_status: 'unconfirmed' } }, /capture status/],
    [{ tool: 'standard-scan' }, /not linked to a liveness capture/],
    [{ tamperLiveness: true }, /changed after the run/],
    [{ text: `${POSTING} Salary EUR 90,000 per year.` }, /does not match its recorded hash/],
  ];
  for (const [options, reason] of cases) {
    withFixture(options, (result) => {
      assert.equal(result.complete, false, JSON.stringify(options));
      assert.match(result.reason, reason, JSON.stringify(options));
    });
  }
  const { root, candidatesPath } = fixture();
  try {
    assert.equal(verifiedPostingCapture({ candidatesPath, candidateId: OTHER }).complete, false, 'another candidate never borrows the capture');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function report(dir, number, candidateId, summary, company = 'Example Oy', role = 'Data Engineer') {
  writeFileSync(join(dir, `${String(number).padStart(3, '0')}-example-oy-2031-01-01.md`), [
    `# Evaluation: ${company} - ${role}`, '', `**Candidate ID:** ${candidateId}`, '', '## Machine Summary', '', '```yaml',
    JSON.stringify({ company, role, ...summary }, null, 2), '```', '',
  ].join('\n'));
}

test('report compensation comes only from reports headed with the exact candidate ID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'salary-reports-'));
  try {
    report(dir, 1, OTHER, { advertised_comp: 'EUR 80,000-90,000 per year' });
    assert.deepEqual(reportCompensationFor(ID, { reportsDir: dir }), { status: 'none', values: [], reason: null },
      'same company and role under another candidate ID is not borrowed');
    report(dir, 2, ID, { advertised_comp: null });
    assert.equal(reportCompensationFor(ID, { reportsDir: dir }).status, 'matched');
    report(dir, 3, ID, { advertised_comp: 'EUR 60,000-70,000 per year' });
    assert.deepEqual(reportCompensationFor(ID, { reportsDir: dir }).values, [{ report: 3, value: 'EUR 60,000-70,000 per year' }]);
    report(dir, 4, ID, { advertised_comp: 'EUR 1/year', candidate_id: OTHER });
    assert.equal(reportCompensationFor(ID, { reportsDir: dir }).status, 'conflict', 'mismatched IDs inside a report');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a report naming the candidate only in its Machine Summary, or unreadable reports, never read as "no pay"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'salary-reports-'));
  try {
    report(dir, 1, OTHER, { advertised_comp: 'EUR 80,000-90,000 per year', candidate_id: ID });
    assert.equal(reportCompensationFor(ID, { reportsDir: dir }).status, 'conflict', 'header B, summary A is contradictory for A');
    assert.equal(reportCompensationFor(ID, { reportsDir: join(dir, 'missing') }).status, 'unverified', 'no reports directory: nothing was inspected');
    const notDir = join(dir, '001-example-oy-2031-01-01.md');
    const unreadable = reportCompensationFor(ID, { reportsDir: notDir });
    assert.equal(unreadable.status, 'unverified', 'a reports path that cannot be listed');
    assert.match(unreadable.reason, /could not be read|not available/);
    assert.equal(reportCompensationFor(null, { reportsDir: dir }).status, 'unverified');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the browser form context carries both kinds of evidence, and a legacy-derived identity carries none', () => {
  const { root, candidatesPath } = fixture();
  try {
    mkdirSync(join(root, 'reports'));
    const base = { manifest: { batchId: 'b' }, root, sourceCandidatesPath: candidatesPath, sourceCandidate: { sourceRow: { jobCountry: 'Finland', description: 'Teaser.' } } };
    const context = buildCandidateFormContext({ ...base, candidate: { candidate_id: ID, listingUrl: 'https://jobs.example.test/1' } });
    assert.equal(context.postingEvidence.complete, true);
    assert.equal(context.reportCompensation.status, 'none');
    const legacy = buildCandidateFormContext({ ...base, candidate: { candidate_id: ID, identityStatus: 'legacy_derived' } });
    assert.equal(legacy.postingEvidence.complete, false);
    assert.equal(legacy.reportCompensation.status, 'unverified');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fourth review: two report files with the same number make report pay unverified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'salary-reports-'));
  try {
    writeFileSync(join(dir, '442-a.md'), ['# Evaluation: Example Oy - Data Engineer', '', `**Candidate ID:** ${ID}`, '', '## Machine Summary', '', '```yaml',
      JSON.stringify({ advertised_comp: 'EUR 3000/month' }), '```', ''].join('\n'));
    assert.equal(reportCompensationFor(ID, { reportsDir: dir }).status, 'matched');
    writeFileSync(join(dir, '442-b.md'), ['# Evaluation: Other Oy - Engineer', '', `**Candidate ID:** ${OTHER}`, '', '## Machine Summary', '', '```yaml',
      JSON.stringify({ advertised_comp: null }), '```', ''].join('\n'));
    assert.equal(reportCompensationFor(ID, { reportsDir: dir }).status, 'unverified');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('final pass: an unavailable reports directory is unverified; none needs an inspected directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'salary-reports-'));
  try {
    assert.equal(reportCompensationFor(ID, { reportsDir: dir }).status, 'none', 'inspected, empty directory');
    for (const reportsDir of [join(dir, 'missing'), undefined, '']) {
      const result = reportCompensationFor(ID, { reportsDir });
      assert.equal(result.status, 'unverified', String(reportsDir));
      assert.match(result.reason, /not available/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('final pass: posting captures must be recent; missing, malformed, future and expired times never count', () => {
  const now = new Date('2031-06-15T12:00:00.000Z');
  const at = (days) => new Date(now.getTime() - days * 86_400_000).toISOString();
  assert.equal(captureFreshnessProblem(at(1), { now }), null);
  assert.equal(captureFreshnessProblem(at(POSTING_CAPTURE_MAX_AGE_DAYS), { now }), null, 'exactly at the limit');
  assert.equal(captureFreshnessProblem(new Date(now.getTime() + 60_000).toISOString(), { now }), null, 'small clock skew');
  const cases = [
    [undefined, /missing or malformed/], ['', /missing or malformed/], ['yesterday', /missing or malformed/],
    ['2031-06-15', /missing or malformed/], ['2031-02-30T00:00:00Z', /missing or malformed/], ['2031-04-31T00:00:00Z', /missing or malformed/], ['2031-06-10T24:00:00Z', /missing or malformed/],
    [new Date(now.getTime() + 3_600_000).toISOString(), /in the future/],
    [at(POSTING_CAPTURE_MAX_AGE_DAYS + 1), /days old/],
  ];
  for (const [checkedAt, reason] of cases) assert.match(captureFreshnessProblem(checkedAt, { now }) || '', reason, String(checkedAt));
  for (const [checkedAt, reason] of [[at(30), /days old/], [undefined, /malformed/], [new Date(now.getTime() + 86_400_000).toISOString(), /future/]]) {
    const { root, candidatesPath } = fixture({ record: { checked_at: checkedAt } });
    try {
      const result = verifiedPostingCapture({ candidatesPath, candidateId: ID, now });
      assert.equal(result.complete, false, String(checkedAt));
      assert.match(result.reason, reason);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const { root, candidatesPath } = fixture({ record: { checked_at: at(2) } });
  try { assert.equal(verifiedPostingCapture({ candidatesPath, candidateId: ID, now }).complete, true); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
