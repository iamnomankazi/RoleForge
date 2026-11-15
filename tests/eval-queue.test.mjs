import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildEvalQueue } from '../eval-queue.mjs';

const SCRIPT = resolve(import.meta.dirname, '..', 'eval-queue.mjs');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const cid = (char) => `cand_v1_${char.repeat(64)}`;
const description = 'This fictional role builds useful tools with a small team. The work includes designing reliable services, writing clear documentation, and collaborating with colleagues on practical customer problems every week.';

function put(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}

function putJson(file, value) { put(file, `${JSON.stringify(value, null, 2)}\n`); }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'eval-queue-'));
  mkdirSync(join(root, 'reports'), { recursive: true });
  mkdirSync(join(root, 'output', 'scan-runs'), { recursive: true });
  mkdirSync(join(root, 'output', 'identity-corrections'), { recursive: true });
  put(join(root, 'applications.md'), '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n');
  put(join(root, 'config', 'profile.yml'), 'home_country: Finland\nauthorized_countries: [Finland]\nlanguages:\n  english: fluent\n');
  return { root, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

function candidate(id, overrides = {}) {
  return { candidate_id: id, company: 'Example Oy', title: 'Platform Engineer', location: 'Helsinki, Finland',
    url: `https://jobs.example.test/openings/${id.slice(-1)}`, description, liveness_status: 'active',
    location_eligibility: 'eligible', ...overrides };
}

function putRun(f, runId, candidates, { created = '2026-11-10T00:00:00.000Z', enrichment, enriched = false, expectedHash } = {}) {
  const dir = join(f.root, 'output', 'scan-runs', runId);
  const manifest = { run_id: runId, created_at: created };
  if (enriched) {
    manifest.metadata = { tool: 'enrich-run', enrichment_sha256: expectedHash ?? hash(enrichment ?? '') };
  }
  putJson(join(dir, 'manifest.json'), manifest);
  putJson(join(dir, 'candidates.json'), candidates);
  if (enrichment !== undefined) put(join(dir, 'enrichment.json'), enrichment);
  return dir;
}

function trackerRow(id, { company = 'Another Oy', role = 'Tracked Role', status = 'Evaluated', number = 1, notes = `Canonical candidate ID: ${id}`, report = '' } = {}) {
  return `| ${number} | 2026-11-01 | ${company} | ${role} | 4/5 | ${status} | | ${report} | ${notes} |`;
}

function setTracker(f, ...rows) {
  put(join(f.root, 'applications.md'), `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
}

function report(f, id, number = '001') {
  put(join(f.root, 'reports', `${number}-fixture.md`), `**Candidate ID:** ${id}\n\nSynthetic report fixture.\n`);
}

function queue(f, runDirs, options = {}) {
  return buildEvalQueue({ root: f.root, runDirs, now: '2026-11-15T12:00:00Z', ...options });
}

test('includes active candidates and excludes IDs found in tracker notes, report headers, and valid enrichment mappings', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const notesId = cid('a'); const reportId = cid('b'); const oldId = cid('c'); const newId = cid('d'); const cleanId = cid('e');
  setTracker(f, trackerRow(notesId), trackerRow(oldId, { number: 2 }));
  report(f, reportId, '007');
  const clean = putRun(f, 'clean', [candidate(cleanId)]);
  const notesRun = putRun(f, 'notes', [candidate(notesId)]);
  const reportRun = putRun(f, 'report', [candidate(reportId)]);
  const enrichment = JSON.stringify([{ source_candidate_id: oldId, candidate_id: newId }]);
  const mappedRun = putRun(f, 'mapped', [candidate(newId)], { enriched: true, enrichment });
  const result = queue(f, [clean, notesRun, reportRun, mappedRun]);
  assert.deepEqual(result.include.map((entry) => entry.candidate_id), [cleanId]);
  assert.deepEqual(result.exclude.map((entry) => entry.reason), ['already_tracked', 'already_tracked', 'already_tracked']);
  assert.deepEqual(result.exclude[0].detail.tracker_rows.map((row) => row.num), [1]);
  assert.deepEqual(result.exclude[1].detail.report_numbers, [7]);
  assert.equal(result.exclude[2].detail.matched_candidate_ids.includes(oldId), true);
});

test('weak URL and company-role matches remain included with possible duplicate evidence; ambiguous IDs do not exclude', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const trackedId = cid('f'); const urlId = cid('0'); const textId = cid('1'); const ambiguousId = cid('2');
  setTracker(f, trackerRow(trackedId, { company: 'Example Oy', role: 'Platform Engineer' }),
    trackerRow(ambiguousId, { company: 'Sample GmbH', role: 'Research Engineer', number: 2 }));
  putJson(join(f.root, 'output', 'identity-corrections', 'ambiguous.json'), {
    entries: [], old_ids_shared_by_distinct_openings: [{ old_candidate_id: ambiguousId, distinct_openings: ['x', 'y'] }],
  });
  const trackedUrl = 'https://jobs.example.test/shared?utm_source=tracker';
  const anchor = putRun(f, 'tracked-record', [candidate(trackedId, { url: trackedUrl, company: 'Example Oy', title: 'Platform Engineer' }),
    candidate(ambiguousId, { company: 'Sample GmbH', title: 'Research Engineer' })]);
  const urlRun = putRun(f, 'url-match', [candidate(urlId, { url: 'https://jobs.example.test/shared?utm_source=other',
    url_aliases: [trackedUrl], company: 'Different Ltd', title: 'Different Role' })]);
  const textRun = putRun(f, 'text-match', [candidate(textId, { company: 'Example Ltd', title: 'Platform-Engineer' })]);
  const ambiguousRun = putRun(f, 'ambiguous', [candidate(ambiguousId, { company: 'Sample GmbH', title: 'Research Engineer' })]);
  const result = queue(f, [anchor, urlRun, textRun, ambiguousRun]);
  assert.deepEqual(result.exclude.map((entry) => entry.reason), ['already_tracked']);
  const byId = new Map(result.include.map((entry) => [entry.candidate_id, entry]));
  assert.ok(byId.get(urlId).possible_duplicates.some((entry) => entry.reason === 'shared_url_alias'));
  assert.ok(byId.get(textId).possible_duplicates.some((entry) => entry.reason === 'company_role_match'));
  assert.ok(byId.get(ambiguousId).possible_duplicates.some((entry) => entry.reason === 'ambiguous_id'));
});

test('fresh liveness requires exact ID and a timestamp strictly newer than the run', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const staleId = cid('3'); const activeId = cid('4'); const expiredId = cid('5'); const otherId = cid('6');
  const run = putRun(f, 'freshness', [candidate(staleId, { liveness_status: 'unconfirmed' }), candidate(activeId, { liveness_status: 'unconfirmed' }),
    candidate(expiredId), candidate(otherId, { liveness_status: 'unconfirmed' })]);
  const staleDir = join(f.root, 'artifacts', 'stale'); const activeDir = join(f.root, 'artifacts', 'active');
  const expiredDir = join(f.root, 'artifacts', 'expired'); const wrongIdDir = join(f.root, 'artifacts', 'wrong-id');
  putJson(join(staleDir, 'liveness.json'), { [staleId]: { status: 'active', checked_at: '2026-11-09T23:59:59Z' } });
  putJson(join(activeDir, 'liveness.json'), { [activeId]: { status: 'active', checked_at: '2026-11-10T00:00:01Z' } });
  putJson(join(expiredDir, 'liveness.json'), { [expiredId]: { status: 'expired', checked_at: '2026-11-11T00:00:00Z' } });
  putJson(join(wrongIdDir, 'liveness.json'), { [cid('7')]: { status: 'active', checked_at: '2026-11-12T00:00:00Z' } });
  const result = queue(f, [run], { livenessDirs: [staleDir, activeDir, expiredDir, wrongIdDir] });
  assert.deepEqual(result.include.map((entry) => entry.candidate_id), [activeId]);
  assert.deepEqual(result.needs_liveness.map((entry) => entry.candidate_id), [staleId, otherId]);
  assert.equal(result.exclude[0].reason, 'liveness_expired');
  assert.equal(result.needs_liveness[0].liveness.source, 'run');
  assert.equal(result.include[0].liveness.source, activeDir);
  assert.equal(result.include[0].liveness.liveness_json_sha256, hash(readFileSync(join(activeDir, 'liveness.json'))));
});

test('latest exact-ID liveness artifact wins in either input order and newer negative evidence overrides active', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const id = cid('8'); const run = putRun(f, 'latest-live', [candidate(id)]);
  const first = join(f.root, 'liveness-a'); const second = join(f.root, 'liveness-b');
  putJson(join(first, 'liveness.json'), { [id]: { status: 'active', checked_at: '2026-11-11T00:00:00Z' } });
  putJson(join(second, 'liveness.json'), { [id]: { status: 'unconfirmed', checked_at: '2026-11-12T00:00:00Z' } });
  for (const dirs of [[first, second], [second, first]]) {
    const result = queue(f, [run], { livenessDirs: dirs });
    assert.equal(result.needs_liveness[0].candidate_id, id);
    assert.equal(result.needs_liveness[0].liveness.source, second);
    assert.equal(result.needs_liveness[0].liveness.liveness_json_sha256, hash(readFileSync(join(second, 'liveness.json'))));
  }
});

test('embedded uncertain and unverified statuses are held for liveness, not treated as expired', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const uncertain = cid('9'); const unverified = cid('a');
  const run = putRun(f, 'embedded', [candidate(uncertain, { liveness_status: 'uncertain' }), candidate(unverified, { liveness_status: 'unverified' })]);
  const result = queue(f, [run]);
  assert.deepEqual(result.needs_liveness.map((entry) => entry.candidate_id), [uncertain, unverified]);
  assert.deepEqual(result.exclude, []);
  assert.deepEqual(result.needs_liveness.map((entry) => entry.liveness.status), ['unconfirmed', 'unconfirmed']);
});

test('no-description recoverability, region eligibility, and prescreen blockers preserve evidence', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const shortActive = cid('b'); const shortUnconfirmed = cid('c'); const region = cid('d'); const uncertainRegion = cid('e'); const blocked = cid('f');
  const blockedDescription = `German C1 is required. ${description}`;
  const run = putRun(f, 'filters', [candidate(shortActive, { description: 'short', liveness_status: 'active' }),
    candidate(shortUnconfirmed, { description: 'short', liveness_status: 'uncertain' }),
    candidate(region, { location_eligibility: 'ineligible' }), candidate(uncertainRegion, { location_eligibility: 'uncertain' }),
    candidate(blocked, { description: blockedDescription })]);
  const result = queue(f, [run]);
  const byReason = new Map(result.exclude.map((entry) => [entry.reason, entry]));
  const noDescriptions = result.exclude.filter((entry) => entry.reason === 'no_description');
  assert.equal(noDescriptions[0].detail.recoverable, false);
  assert.equal(noDescriptions[1].detail.recoverable, true);
  assert.ok(byReason.has('region'));
  assert.ok(byReason.has('prescreen_blocked'));
  assert.ok(byReason.get('prescreen_blocked').detail.blockers.some((item) => item.code === 'language_required'
    && item.evidence.includes('German C1 is required') && item.detail.includes('not recorded')));
  assert.deepEqual(result.include.map((entry) => entry.candidate_id), [uncertainRegion]);
});

test('duplicate queue keeps latest run, including source versus enriched IDs linked by a one-to-one edge', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const sameId = cid('0'); const sourceId = cid('1'); const enrichedId = cid('2');
  const old = putRun(f, 'old', [candidate(sameId)], { created: '2026-11-09T00:00:00Z' });
  const latest = putRun(f, 'latest', [candidate(sameId)], { created: '2026-11-11T00:00:00Z' });
  const source = putRun(f, 'source', [candidate(sourceId)], { created: '2026-11-08T00:00:00Z' });
  const enrichment = JSON.stringify([{ source_candidate_id: sourceId, candidate_id: enrichedId }]);
  const enriched = putRun(f, 'enriched', [candidate(enrichedId)], { created: '2026-11-12T00:00:00Z', enriched: true, enrichment });
  const result = queue(f, [old, latest, source, enriched]);
  assert.deepEqual(result.include.map((entry) => entry.candidate_id), [sameId, enrichedId]);
  assert.deepEqual(result.exclude.map((entry) => entry.reason), ['duplicate_in_queue', 'duplicate_in_queue']);
  assert.equal(result.exclude[0].detail.kept_run_id, 'latest');
  assert.equal(result.exclude[1].detail.kept_candidate_id, enrichedId);
});

test('incomplete enriched runs fail closed while non-enriched runs need no enrichment file', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const missing = putRun(f, 'missing-enrichment', [candidate(cid('3'))], { enriched: true });
  assert.throws(() => queue(f, [missing]), /incomplete enriched run.*enrichment\.json is missing/);
  const mismatch = putRun(f, 'mismatch-enrichment', [candidate(cid('4'))], { enriched: true, enrichment: '[]', expectedHash: '0'.repeat(64) });
  assert.throws(() => queue(f, [mismatch]), /incomplete enriched run.*SHA-256/);
  const normal = putRun(f, 'ordinary', [candidate(cid('5'))]);
  assert.equal(queue(f, [normal]).include.length, 1);
});

test('run and liveness inputs stay byte-identical and CLI refuses output inside a run', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const run = putRun(f, 'immutable', [candidate(cid('6'))]);
  const live = join(f.root, 'liveness');
  putJson(join(live, 'liveness.json'), { [cid('6')]: { status: 'active', checked_at: '2026-11-11T00:00:00Z' } });
  const before = ['manifest.json', 'candidates.json'].map((name) => readFileSync(join(run, name)));
  const liveBefore = readFileSync(join(live, 'liveness.json'));
  queue(f, [run], { livenessDirs: [live] });
  assert.deepEqual(['manifest.json', 'candidates.json'].map((name) => readFileSync(join(run, name))), before);
  assert.deepEqual(readFileSync(join(live, 'liveness.json')), liveBefore);
  const result = spawnSync(process.execPath, [SCRIPT, '--root', f.root, '--run', run, '--out', join(run, 'queue.json')], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing --out inside an input run/);
  assert.equal(existsSync(join(run, 'queue.json')), false);
});

test('CLI JSON smoke test uses the supplied root and reports queue structure', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const run = putRun(f, 'cli-run', [candidate(cid('7'))]);
  const result = spawnSync(process.execPath, [SCRIPT, '--root', f.root, '--run', run, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schema, 'eval-queue/1');
  assert.equal(parsed.include.length, 1);
  assert.equal(parsed.counts.include, 1);
});
