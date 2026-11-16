import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildEvalQueue } from '../eval-queue.mjs';

const SCRIPT = resolve(import.meta.dirname, '..', 'eval-queue.mjs');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const cid = (char) => `cand_v1_${char.repeat(64)}`;
const description = 'This fictional role builds useful tools with a small team. The work includes designing reliable services, writing clear documentation, and collaborating with colleagues on practical customer problems every week.';
const variantDescription = (location) => `This synthetic opening is available in ${location}. Our engineering group develops tools that help teams understand and improve their software delivery workflows. You will design reliable services, investigate customer feedback, and work alongside colleagues who value thoughtful communication and practical solutions. We build automated testing systems, maintain clear documentation, and review changes together before releasing improvements. The product connects several data sources through well documented interfaces and provides useful insights into application performance. Engineers collaborate with designers to simplify complex tasks and make the experience accessible to a broad range of users. Daily work includes planning small experiments, measuring outcomes, and sharing findings with the wider organization. We encourage curiosity, independent problem solving, and respectful discussion of technical tradeoffs. You will have time to learn unfamiliar technologies and contribute ideas that improve our development process. The team offers flexible working hours, equipment for a comfortable workspace, and opportunities to participate in internal learning sessions. This position supports colleagues throughout ${location}.`;

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

function putBatch(f, batchId, candidateIds, { states = [], rawManifest, rawState } = {}) {
  const dir = join(f.root, 'output', 'application-batches', batchId);
  const manifest = rawManifest ?? { batchId, candidates: candidateIds.map((candidate_id) => ({ candidate_id })) };
  putJson(join(dir, 'manifest.json'), manifest);
  if (rawState !== undefined) put(join(dir, 'state.json'), rawState);
  else if (states.length) {
    putJson(join(dir, 'state.json'), { candidates: states.map((state, index) => (
      state && typeof state === 'object' ? state : { candidate_id: candidateIds[index], state }
    )) });
  }
  return dir;
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

test('uses scan experience policy for prescreening and keeps the default policy behavior', (t) => {
  const configured = fixture(); t.after(configured.cleanup);
  const configuredId = cid('0');
  const jobDescription = `Requirements:\n- At least 5 years of professional experience. ${description}`;
  put(join(configured.root, 'portals.yml'), 'experience_policy:\n  normal_max_years: 5\n');
  const configuredRun = putRun(configured, 'configured-experience', [candidate(configuredId, { description: jobDescription })]);
  const configuredResult = queue(configured, [configuredRun]);
  assert.deepEqual(configuredResult.include.map((entry) => entry.candidate_id), [configuredId]);

  const defaults = fixture(); t.after(defaults.cleanup);
  const defaultId = cid('1');
  const defaultRun = putRun(defaults, 'default-experience', [candidate(defaultId, { description: jobDescription })]);
  const defaultResult = queue(defaults, [defaultRun]);
  assert.equal(defaultResult.exclude[0].reason, 'prescreen_blocked');
  assert.ok(defaultResult.exclude[0].detail.blockers.some((blocker) => blocker.code === 'experience_outside'));
});

test('identity, report, and tracker source warnings that could hide evidence fail closed', (t) => {
  const ledgerFixture = fixture(); t.after(ledgerFixture.cleanup);
  const ledgerRun = putRun(ledgerFixture, 'ledger-warning', [candidate(cid('2'))]);
  put(join(ledgerFixture.root, 'output', 'identity-corrections', 'broken.json'), '{"entries":');
  assert.throws(() => queue(ledgerFixture, [ledgerRun]), /Could not safely load identity mappings:[\s\S]*identity corrections ledger/);

  const reportFixture = fixture(); t.after(reportFixture.cleanup);
  const reportRun = putRun(reportFixture, 'report-warning', [candidate(cid('3'))]);
  rmSync(join(reportFixture.root, 'reports'), { recursive: true, force: true });
  put(join(reportFixture.root, 'reports'), 'not a directory');
  assert.throws(() => queue(reportFixture, [reportRun]), /Could not read reports directory/);

  const trackerFixture = fixture(); t.after(trackerFixture.cleanup);
  const trackerRun = putRun(trackerFixture, 'tracker-warning', [candidate(cid('4'))]);
  rmSync(join(trackerFixture.root, 'applications.md'));
  mkdirSync(join(trackerFixture.root, 'applications.md'));
  assert.throws(() => queue(trackerFixture, [trackerRun]), /Could not safely load tracker identity evidence:[\s\S]*Could not read tracker/);
});

test('non-empty trackers without parsed rows or a recognizable header fail closed', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const run = putRun(f, 'tracker-structure', [candidate(cid('5'))]);
  for (const content of ['# Applications\nTracker content was lost.\n',
    '| Item | Value |\n|---|---|\n| Example | Text |\n',
    '| # | Date | Company | Role |\n|---|---|---|---|\n']) {
    put(join(f.root, 'applications.md'), content);
    assert.throws(() => queue(f, [run]), /Could not safely load tracker identity evidence: no recognizable tracker table/);
  }
});

test('empty trackers and valid tracker tables with zero data rows are allowed', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const id = cid('6'); const run = putRun(f, 'empty-tracker', [candidate(id)]);
  for (const content of ['', ' \n',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n',
    '| num | Empresa | Puesto | Status | Score |\n|---|---|---|---|---|\n']) {
    put(join(f.root, 'applications.md'), content);
    assert.deepEqual(queue(f, [run]).include.map((entry) => entry.candidate_id), [id]);
  }
  // Existing legacy rows remain recognizable even without a header.
  put(join(f.root, 'applications.md'), trackerRow(id));
  assert.equal(queue(f, [run]).exclude[0].reason, 'already_tracked');
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

test('application-batch identity evidence excludes exact and strongly equivalent IDs with candidate state details', (t) => {
  const exactFixture = fixture(); t.after(exactFixture.cleanup);
  const exactId = cid('5');
  const exactRun = putRun(exactFixture, 'already-batched', [candidate(exactId)]);
  putBatch(exactFixture, 'fixture-batch', [exactId], { states: ['submitted'] });
  // Internal claim directories without a manifest are not batches and must not fail the queue.
  mkdirSync(join(exactFixture.root, 'output', 'application-batches', '.candidate-claims', exactId), { recursive: true });
  const exactResult = queue(exactFixture, [exactRun]);
  assert.equal(exactResult.exclude[0].reason, 'in_application_batch');
  assert.deepEqual(exactResult.exclude[0].detail, {
    batch_ids: ['fixture-batch'], candidate_states: [{ batch_id: 'fixture-batch', state: 'submitted' }],
  });

  const mappedFixture = fixture(); t.after(mappedFixture.cleanup);
  const originalId = cid('6'); const enrichedId = cid('7');
  const enrichment = JSON.stringify([{ source_candidate_id: originalId, candidate_id: enrichedId }]);
  const mappedRun = putRun(mappedFixture, 'mapped-batch-candidate', [candidate(enrichedId)], { enriched: true, enrichment });
  putBatch(mappedFixture, 'equivalent-batch', [originalId], { rawState: '{broken' });
  const mappedResult = queue(mappedFixture, [mappedRun]);
  assert.equal(mappedResult.exclude[0].reason, 'in_application_batch');
  assert.deepEqual(mappedResult.exclude[0].detail, {
    batch_ids: ['equivalent-batch'], candidate_states: [{ batch_id: 'equivalent-batch', state: null }],
  });
  assert.ok(mappedResult.exclude[0].liveness);
});

test('malformed application-batch manifests fail closed and a missing batches directory is allowed', (t) => {
  const missing = fixture(); t.after(missing.cleanup);
  const missingRun = putRun(missing, 'no-batches', [candidate(cid('8'))]);
  assert.equal(queue(missing, [missingRun]).include.length, 1);

  const broken = fixture(); t.after(broken.cleanup);
  const brokenRun = putRun(broken, 'broken-batch', [candidate(cid('9'))]);
  put(join(broken.root, 'output', 'application-batches', 'broken', 'manifest.json'), '{not json');
  assert.throws(() => queue(broken, [brokenRun]), /Could not parse application-batch manifest/);
});

test('queued candidates report shared URL and company-role duplicates symmetrically', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const sharedUrl = 'https://jobs.example.test/shared-opening';
  const ids = ['c', 'd', 'e', 'f'].map(cid);
  const run = putRun(f, 'queued-duplicates', [
    candidate(ids[0], { company: 'First Ltd', title: 'First Role', url: sharedUrl }),
    candidate(ids[1], { company: 'Second GmbH', title: 'Second Role', url: `${sharedUrl}?utm_source=other` }),
    candidate(ids[2], { company: 'Example Oy', title: 'Research Engineer', url: 'https://jobs.example.test/text-one' }),
    candidate(ids[3], { company: 'Example Ltd', title: 'Research-Engineer', url: 'https://jobs.example.test/text-two' }),
  ]);
  const result = queue(f, [run]);
  const byId = new Map(result.include.map((entry) => [entry.candidate_id, entry]));
  for (const [left, right, reason] of [[ids[0], ids[1], 'shared_url_alias'], [ids[2], ids[3], 'company_role_match']]) {
    assert.ok(byId.get(left).possible_duplicates.some((item) => item.reason === reason && item.candidate_id === right));
    assert.ok(byId.get(right).possible_duplicates.some((item) => item.reason === reason && item.candidate_id === left));
  }
});

test('ambiguous IDs are surfaced without tracker evidence and discarded endpoints resolve strong equivalents', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const ambiguous = cid('0'); const oldId = cid('1'); const mappedId = cid('2'); const trackedId = cid('3'); const otherId = cid('4');
  putJson(join(f.root, 'output', 'identity-corrections', 'ambiguous.json'), {
    entries: [], old_ids_shared_by_distinct_openings: [{ old_candidate_id: ambiguous, distinct_openings: ['left', 'right'] }],
  });
  const edges = JSON.stringify([
    { source_candidate_id: oldId, candidate_id: mappedId },
    { source_candidate_id: oldId, candidate_id: otherId },
    { source_candidate_id: mappedId, candidate_id: trackedId },
  ]);
  putRun(f, 'mapping-edges', [], { enriched: true, enrichment: edges });
  setTracker(f, trackerRow(trackedId));
  const run = putRun(f, 'discarded-endpoint', [candidate(ambiguous, { company: 'Ambiguous Co', title: 'Ambiguous Role' }),
    candidate(oldId, { company: 'Old Co', title: 'Old Role' })]);
  const result = queue(f, [run]);
  const byId = new Map(result.include.map((entry) => [entry.candidate_id, entry]));
  const ambiguousEvidence = byId.get(ambiguous).possible_duplicates.find((item) => item.reason === 'ambiguous_id');
  assert.deepEqual(ambiguousEvidence.evidence, []);
  const discardedEvidence = byId.get(oldId).possible_duplicates.find((item) => item.reason === 'discarded_mapping');
  assert.ok(discardedEvidence);
  assert.ok(discardedEvidence.candidate_ids.includes(trackedId));
});

test('explicit run directories must resolve inside the root scan-runs directory', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const externalRoot = mkdtempSync(join(tmpdir(), 'eval-queue-outside-'));
  t.after(() => rmSync(externalRoot, { recursive: true, force: true }));
  const externalRun = join(externalRoot, 'external-run');
  putJson(join(externalRun, 'manifest.json'), { run_id: 'external-run', created_at: '2026-11-10T00:00:00Z' });
  putJson(join(externalRun, 'candidates.json'), [candidate(cid('a'))]);
  assert.throws(() => queue(f, [externalRun]), /Refusing --run outside <root>\/output\/scan-runs/);
});

test('missing, malformed, and explicit missing profiles are errors', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const run = putRun(f, 'profile-required', [candidate(cid('b'))]);
  const defaultProfile = join(f.root, 'config', 'profile.yml');
  rmSync(defaultProfile);
  assert.throws(() => queue(f, [run]), /Could not load required prescreen profile/);
  const explicitProfile = join(f.root, 'custom-profile.yml');
  assert.throws(() => queue(f, [run], { profilePath: explicitProfile }), /Could not load required prescreen profile/);
  put(explicitProfile, 'languages: [\n');
  assert.throws(() => queue(f, [run], { profilePath: explicitProfile }), /Could not load required prescreen profile/);
});

test('invalid profile shapes cannot bypass a graduation blocker', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const run = putRun(f, 'profile-shape', [candidate(cid('c'), {
    description: `Applicants must graduate between June 2025 and June 2026. ${description}`,
  })]);
  const profilePath = join(f.root, 'config', 'profile.yml');
  put(profilePath, "graduation_date: '2026-12-31'\n");
  const result = queue(f, [run]);
  assert.equal(result.exclude[0].reason, 'prescreen_blocked');
  assert.equal(result.exclude[0].detail.blockers[0].code, 'graduation_window');
  for (const content of ['[]', 'true', '42', '', 'null', '{}', 'profile text', '2026-12-31']) {
    put(profilePath, content);
    assert.throws(() => queue(f, [run]), /Could not load required prescreen profile.*non-empty plain profile mapping/);
  }
});

test('wrong types in prescreen profile fields fail before normalization', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const run = putRun(f, 'profile-field-types', [candidate(cid('d'))]);
  const invalidProfiles = [
    { graduation_date: [] }, { expected_graduation_date: 2026 },
    { education_details: { expected_graduation_date: true } }, { education_details: [] },
    { languages: 'German C1' }, { languages: [] }, { languages: { german: false } },
    { languages: { german: { cefr: [] } } }, { languages: { german: { level: 42 } } },
    { language: { additional_proficiencies: [] } }, { language: 'German' },
    { work_authorization: [] }, { work_authorization: { finland_authorized: [] } },
    { application_form: { work_authorization: true } },
    { application_answers: { work_authorization: { outside_finland_local_authorized: {} } } },
    { application_form: [] }, { outside_home_authorized: [] }, { sponsorship_outside_home: {} },
    { authorized_countries: 'Finland' }, { authorized_countries: [true] },
    { citizenship_countries: {} }, { home_country: [] }, { residence_country: false },
    { location: { country: [] } }, { candidate: { citizenship: true } }, { languages: null },
  ];
  for (const profile of invalidProfiles) {
    putJson(join(f.root, 'config', 'profile.yml'), profile);
    assert.throws(() => queue(f, [run]), /Could not load required prescreen profile.*Profile .* must be/,
      JSON.stringify(profile));
  }
});

test('validated raw YAML retains nested profile normalization and the original byte hash', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const id = cid('e');
  const run = putRun(f, 'nested-profile', [candidate(id, {
    description: `German C1 is required. Applicants must graduate between June 2025 and June 2026. ${description}`,
  })]);
  const profile = '\uFEFFeducation_details:\n  expected_graduation_date: "30/06/2026"\n'
    + 'language:\n  additional_proficiencies:\n    german:\n      cefr: C1\n'
    + 'application_form:\n  work_authorization:\n    home_country: Finland\n    finland_authorized: "Yes"\n';
  put(join(f.root, 'config', 'profile.yml'), profile);
  const result = queue(f, [run]);
  assert.deepEqual(result.include.map((entry) => entry.candidate_id), [id]);
  assert.equal(result.inputs.profile_sha256, hash(profile));
  assert.equal(result.include[0].prescreen.graduation_window.eligible, true);
  assert.equal(result.include[0].prescreen.work_authorization.status, 'authorized');
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

test('equal, missing, invalid, stale, and strongly equivalent liveness entries are ignored', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const equalId = cid('5'); const missingId = cid('6'); const invalidId = cid('7');
  const staleExpiredId = cid('8'); const equivalentId = cid('9'); const sourceId = cid('a');
  const enrichment = JSON.stringify([{ source_candidate_id: sourceId, candidate_id: equivalentId }]);
  putRun(f, 'liveness-mapping', [], { enriched: true, enrichment });
  const run = putRun(f, 'exact-freshness', [candidate(equalId, { liveness_status: 'unconfirmed' }),
    candidate(missingId, { liveness_status: 'unconfirmed' }), candidate(invalidId, { liveness_status: 'unconfirmed' }),
    candidate(staleExpiredId), candidate(sourceId, { liveness_status: 'unconfirmed' })]);
  const evidence = join(f.root, 'liveness-evidence');
  putJson(join(evidence, 'liveness.json'), {
    [equalId]: { status: 'active', checked_at: '2026-11-10T00:00:00Z' },
    [missingId]: { status: 'active' },
    [invalidId]: { status: 'active', checked_at: 'not-a-date' },
    [staleExpiredId]: { status: 'expired', checked_at: '2026-11-09T00:00:00Z' },
    [equivalentId]: { status: 'active', checked_at: '2026-11-12T00:00:00Z' },
  });
  const result = queue(f, [run], { livenessDirs: [evidence] });
  assert.deepEqual(result.include.map((entry) => entry.candidate_id), [staleExpiredId]);
  assert.deepEqual(result.needs_liveness.map((entry) => entry.candidate_id), [equalId, missingId, invalidId, sourceId]);
  assert.equal(result.needs_liveness[3].liveness.source, 'run');
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

test('latest expired and unknown exact-ID liveness results win in both argument orders', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const expiredId = cid('b'); const unknownId = cid('c');
  const run = putRun(f, 'latest-negative-live', [candidate(expiredId), candidate(unknownId)]);
  const active = join(f.root, 'latest-active'); const expired = join(f.root, 'latest-expired');
  const unknown = join(f.root, 'latest-unknown');
  putJson(join(active, 'liveness.json'), {
    [expiredId]: { status: 'active', checked_at: '2026-11-11T00:00:00Z' },
    [unknownId]: { status: 'active', checked_at: '2026-11-11T00:00:00Z' },
  });
  putJson(join(expired, 'liveness.json'), { [expiredId]: { status: 'expired', checked_at: '2026-11-12T00:00:00Z' } });
  putJson(join(unknown, 'liveness.json'), { [unknownId]: { status: 'unknown-status', checked_at: '2026-11-12T00:00:00Z' } });
  for (const dirs of [[active, expired, unknown], [unknown, expired, active]]) {
    const result = queue(f, [run], { livenessDirs: dirs });
    assert.equal(result.exclude.find((entry) => entry.candidate_id === expiredId).reason, 'liveness_expired');
    assert.equal(result.exclude.find((entry) => entry.candidate_id === expiredId).liveness.source, expired);
    assert.equal(result.needs_liveness.find((entry) => entry.candidate_id === unknownId).liveness.source, unknown);
    assert.equal(result.needs_liveness.find((entry) => entry.candidate_id === unknownId).liveness.status, 'unconfirmed');
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
  for (const entry of [...result.include, ...result.needs_liveness, ...result.exclude]) assert.ok(entry.liveness);
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

test('country variants keep Finland across runs and fold company, title punctuation, and country names', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const countries = ['Germany', 'Finland', 'Denmark', 'Netherlands'];
  const ids = ['1', '2', '3', '4'].map(cid);
  const runs = countries.map((location, index) => putRun(f, `variant-${index}`, [candidate(ids[index], {
    company: index === 1 ? 'SYNTHETIC Aggregator Ltd' : 'Synthetic Aggregator GmbH',
    title: index === 1 ? ' software   engineer — AI tooling ' : 'Software Engineer - AI Tooling',
    location, description: `${variantDescription(location)} Collaboration is remote across ${index === 1 ? 'Norway' : 'Sweden'}.`,
  })], { created: index === 1 ? '2026-11-08T00:00:00Z' : '2026-11-12T00:00:00Z' }));
  const result = queue(f, runs);
  assert.deepEqual(result.include.map((entry) => entry.candidate_id), [ids[1]]);
  assert.deepEqual(result.needs_liveness, []);
  assert.equal(result.include[0].variant_locations.length, 4);
  assert.deepEqual([...result.include[0].variant_locations].sort(), [...countries].sort());
  assert.equal(result.exclude.length, 3);
  for (const entry of result.exclude) {
    assert.equal(entry.reason, 'duplicate_in_queue');
    assert.deepEqual(entry.detail, { rule: 'country_variant', kept_candidate_id: ids[1],
      kept_run_id: 'variant-1', kept_location: 'Finland', similarity: 1 });
  }
});

test('country variants normalize own city and country tokens and use token similarity above the threshold', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const winner = cid('5'); const other = cid('6');
  const run = putRun(f, 'near-variants', [
    candidate(other, { location: 'Berlin, Germany', country: 'DE', description: variantDescription('Berlin, Germany') }),
    candidate(winner, { location: 'Helsinki, Finland', country: 'FI',
      description: variantDescription('Helsinki, Finland').replace('practical solutions', 'practical approaches') }),
  ]);
  const result = queue(f, [run]);
  assert.deepEqual(result.include.map((entry) => entry.candidate_id), [winner]);
  assert.equal(result.exclude[0].detail.rule, 'country_variant');
  assert.ok(result.exclude[0].detail.similarity >= 0.95);
  assert.ok(result.exclude[0].detail.similarity < 1);
});

test('similar descriptions keep distinct same-country or unknown-country requisitions with weak evidence', (t) => {
  const cases = [
    [{ location: 'Helsinki, Finland' }, { location: 'Helsinki, Finland' }],
    [{ country: ' fi ', location: 'Helsinki' }, { country: 'FINLAND', location: 'Espoo' }],
    [{ location: 'Berlin, DE' }, { location: 'Germany' }],
    [{ location: 'Remote' }, { location: 'Remote' }],
    [{ location: 'Helsinki' }, { location: 'Berlin' }],
    [{ location: 'Finland' }, { location: 'Unknown' }],
    // Present country metadata takes precedence, even when it is unrecognized.
    [{ country: 'ZZ', location: 'Finland' }, { location: 'Germany' }],
    [{ country: 'FI', location: 'Germany' }, { location: 'Finland' }],
  ];
  const common = Array.from({ length: 200 }, (_, index) => `word${index}`).join(' ');
  for (const [left, right] of cases) {
    const f = fixture(); t.after(f.cleanup);
    const ids = [cid('1'), cid('2')];
    const run = putRun(f, 'separate-requisitions', [left, right].map((overrides, index) => candidate(ids[index], {
      title: 'Software Engineer', description: `${common} Requisition ${1001 + index}`, ...overrides,
    })));
    const result = queue(f, [run]);
    assert.deepEqual(result.include.map((entry) => entry.candidate_id), ids, JSON.stringify([left, right]));
    assert.deepEqual(result.exclude, []);
    for (const [index, entry] of result.include.entries()) {
      assert.equal('variant_locations' in entry, false);
      assert.ok(entry.possible_duplicates.some((evidence) => evidence.reason === 'company_role_match'
        && evidence.candidate_id === ids[1 - index]));
    }
  }
});

test('Finland preference recognizes country metadata and location country codes', (t) => {
  const cases = [
    [{ location: 'Germany' }, { location: 'Helsinki', country: 'FI' }],
    [{ location: 'Germany' }, { location: 'Helsinki', country: ' finland ' }],
    [{ location: 'Berlin, DE' }, { location: 'Helsinki, fi' }],
    [{ location: 'Germany' }, { location: 'FI' }],
    // Country metadata overrides misleading location text for the preference too.
    [{ location: 'Finland', country: 'DE' }, { location: 'Germany', country: 'FI' }],
  ];
  for (const [left, right] of cases) {
    const f = fixture(); t.after(f.cleanup);
    const german = cid('3'); const finnish = cid('4');
    const run = putRun(f, 'metadata-preference', [candidate(german, {
      description: variantDescription('Remote'), ...left,
    }), candidate(finnish, { description: variantDescription('Remote'), ...right })]);
    const result = queue(f, [run]);
    assert.deepEqual(result.include.map((entry) => entry.candidate_id), [finnish], JSON.stringify([left, right]));
    assert.deepEqual(result.include[0].variant_locations, [right.location, left.location]);
    assert.equal(result.exclude[0].candidate_id, german);
    assert.equal(result.exclude[0].detail.rule, 'country_variant');
    assert.equal(result.exclude[0].detail.kept_candidate_id, finnish);
  }
});

test('a country variant group cannot hide a second requisition from the same country', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const ids = ['5', '6', '7'].map(cid);
  const run = putRun(f, 'repeated-country', ['Finland', 'Germany', 'DE'].map((location, index) => candidate(ids[index], {
    location, description: variantDescription('Remote'),
  })));
  const result = queue(f, [run]);
  assert.deepEqual(result.include.map((entry) => entry.candidate_id), [ids[0], ids[2]]);
  assert.deepEqual(result.include[0].variant_locations, ['Finland', 'Germany']);
  assert.equal(result.exclude.length, 1);
  assert.equal(result.exclude[0].candidate_id, ids[1]);
  assert.ok(result.include[1].possible_duplicates.some((evidence) => evidence.reason === 'company_role_match'
    && evidence.candidate_id === ids[0]));
});

test('country variants without Finland use newest run, then run index, then candidate order', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const ids = ['7', '8', '9', 'a'].map(cid);
  const make = (id, location) => candidate(id, { location, description: variantDescription(location), liveness_status: 'unconfirmed' });
  const old = putRun(f, 'variant-old', [make(ids[0], 'Germany')], { created: '2026-11-08T00:00:00Z' });
  const first = putRun(f, 'variant-first', [make(ids[1], 'Denmark'), make(ids[2], 'Netherlands')]);
  const second = putRun(f, 'variant-second', [make(ids[3], 'Sweden')]);
  const result = queue(f, [old, first, second]);
  assert.deepEqual(result.include, []);
  assert.deepEqual(result.needs_liveness.map((entry) => entry.candidate_id), [ids[1]]);
  assert.equal(result.needs_liveness[0].variant_locations.length, 4);
  assert.equal(result.exclude.length, 3);
  assert.ok(result.exclude.every((entry) => entry.detail.kept_run_id === 'variant-first'
    && entry.detail.kept_candidate_id === ids[1]));
});

test('country variant evidence requires a known matching company, exact normalized title, and long similar descriptions', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const records = [
    { company: 'First Synthetic', title: 'Software Engineer - AI Tooling' },
    { company: 'Second Synthetic', title: 'Software Engineer - AI Tooling' },
    { company: 'First Synthetic', title: 'Software Engineer - AI Tooling Infrastructure' },
    { company: '?', title: 'Unknown Engineer' }, { company: '?', title: 'Unknown Engineer' },
    { company: '', title: 'Missing Engineer' }, { company: '', title: 'Missing Engineer' },
    { company: 'Different Descriptions', title: 'Platform Engineer' },
    { company: 'Different Descriptions', title: 'Platform Engineer', description:
      'This fictional position focuses on warehouse inventory and stock management. You will organize deliveries, maintain supplier records, coordinate transport schedules, and prepare monthly purchasing forecasts. '.repeat(5) },
    { company: 'Short Descriptions', description }, { company: 'Short Descriptions', description },
    { company: 'Boundary Length', description: 'z'.repeat(299) }, { company: 'Boundary Length', description: 'z'.repeat(299) },
  ].map((overrides, index) => candidate(`cand_v1_${hash(`country-negative-${index}`)}`, {
    description: variantDescription('Finland'), ...overrides,
  }));
  const run = putRun(f, 'country-negatives', records);
  const result = queue(f, [run]);
  assert.equal(result.include.length, records.length);
  assert.deepEqual(result.exclude, []);
  for (const index of [7, 8, 9, 10, 11, 12]) {
    const entry = result.include.find((item) => item.candidate_id === records[index].candidate_id);
    assert.ok(entry.possible_duplicates.some((item) => item.reason === 'company_role_match'));
    assert.equal('variant_locations' in entry, false);
  }
});

test('country variant winners must pass tracked, batch, liveness, region, and prescreen filters', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const ids = ['0', '1', '2', '3', '4', '5'].map(cid);
  setTracker(f, trackerRow(ids[0]));
  putBatch(f, 'variant-in-progress', [ids[1]], { states: ['form_prepared'] });
  const run = putRun(f, 'variant-filter-order', ids.map((id, index) => candidate(id, {
    location: index === 5 ? 'Germany' : 'Finland',
    description: variantDescription(index === 5 ? 'Germany' : 'Finland'),
    ...(index === 2 ? { liveness_status: 'expired' } : {}),
    ...(index === 3 ? { location_eligibility: 'ineligible' } : {}),
    ...(index === 4 ? { description: `German C1 is required. ${variantDescription('Finland')}` } : {}),
  })));
  const result = queue(f, [run]);
  assert.deepEqual(result.include.map((entry) => entry.candidate_id), [ids[5]]);
  assert.deepEqual(result.exclude.map((entry) => entry.reason), [
    'already_tracked', 'in_application_batch', 'liveness_expired', 'region', 'prescreen_blocked',
  ]);
  assert.equal('variant_locations' in result.include[0], false);
});

test('strong-ID selection precedes country preference and retains strong duplicate details', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const strongId = cid('b'); const variantId = cid('c');
  const old = putRun(f, 'strong-old-finland', [candidate(strongId, {
    location: 'Finland', description: variantDescription('Finland'),
  })], { created: '2026-11-08T00:00:00Z' });
  const latest = putRun(f, 'strong-new-germany', [candidate(strongId, {
    location: 'Germany', description: variantDescription('Germany'),
  })]);
  const variant = putRun(f, 'strong-variant', [candidate(variantId, {
    location: 'Denmark', description: variantDescription('Denmark'),
  })], { created: '2026-11-09T00:00:00Z' });
  const result = queue(f, [old, latest, variant]);
  assert.deepEqual(result.include.map((entry) => [entry.candidate_id, entry.run_id]), [[strongId, 'strong-new-germany']]);
  assert.deepEqual(result.include[0].variant_locations, ['Germany', 'Denmark']);
  assert.deepEqual(result.exclude[0].detail, {
    kept_run_id: 'strong-new-germany', kept_run_dir: latest, kept_candidate_id: strongId,
  });
  assert.equal(result.exclude[1].detail.rule, 'country_variant');
});

test('incomplete enriched runs fail closed while non-enriched runs need no enrichment file', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const missing = putRun(f, 'missing-enrichment', [candidate(cid('3'))], { enriched: true });
  assert.throws(() => queue(f, [missing]), /incomplete enriched run.*enrichment\.json is missing/);
  const mismatch = putRun(f, 'mismatch-enrichment', [candidate(cid('4'))], { enriched: true, enrichment: '[]', expectedHash: '0'.repeat(64) });
  assert.throws(() => queue(f, [mismatch]), /incomplete enriched run.*SHA-256/);
  const clean = fixture(); t.after(clean.cleanup);
  const normal = putRun(clean, 'ordinary', [candidate(cid('5'))]);
  assert.equal(queue(clean, [normal]).include.length, 1);
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

test('--out refuses existing targets and every protected input or project evidence directory', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const run = putRun(f, 'protected-output-run', [candidate(cid('d'))]);
  const live = join(f.root, 'liveness-protected');
  putJson(join(live, 'liveness.json'), {});
  const protectedDirs = [
    ['liveness', live],
    ['scan-runs', join(f.root, 'output', 'scan-runs')],
    ['reports', join(f.root, 'reports')],
    ['data', join(f.root, 'data')],
    ['application-batches', join(f.root, 'output', 'application-batches')],
    ['identity-corrections', join(f.root, 'output', 'identity-corrections')],
    ['config', join(f.root, 'config')],
  ];
  for (const [label, directory] of protectedDirs) mkdirSync(directory, { recursive: true });
  for (const [label, directory] of protectedDirs) {
    const out = join(directory, `${label}-queue.json`);
    const result = spawnSync(process.execPath, [SCRIPT, '--root', f.root, '--run', run, '--liveness', live,
      '--out', out], { encoding: 'utf8' });
    assert.equal(result.status, 2, `${label}: ${result.stderr}`);
    assert.match(result.stderr, /Refusing --out inside/);
    assert.equal(existsSync(out), false);
  }

  const existing = join(f.root, 'existing-queue.json');
  put(existing, 'keep this file');
  const existingResult = spawnSync(process.execPath, [SCRIPT, '--root', f.root, '--run', run, '--out', existing], { encoding: 'utf8' });
  assert.equal(existingResult.status, 2);
  assert.match(existingResult.stderr, /destination already exists/);
  assert.equal(readFileSync(existing, 'utf8'), 'keep this file');
});

test('--out protects identity corrections through canonical directory aliases', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const run = putRun(f, 'correction-output-alias', [candidate(cid('f'))]);
  const corrections = join(f.root, 'output', 'identity-corrections');
  const alias = join(f.root, 'corrections-alias');
  symlinkSync(corrections, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const out = join(alias, 'nested', 'queue.json');
  const result = spawnSync(process.execPath, [SCRIPT, '--root', f.root, '--run', run, '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Refusing --out inside output\/identity-corrections/);
  assert.equal(existsSync(join(corrections, 'nested')), false);
});

test('--out relative paths resolve from the current working directory', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const run = putRun(f, 'relative-output', [candidate(cid('e'))]);
  const cwd = mkdtempSync(join(tmpdir(), 'eval-queue-cwd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [SCRIPT, '--root', f.root, '--run', run, '--out', 'queue.json'], {
    cwd, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(cwd, 'queue.json')), true);
  assert.equal(existsSync(join(f.root, 'queue.json')), false);
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

test('scales across 150 queued candidates, 1,500 indexed run records, and 400 reports', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const indexed = Array.from({ length: 1500 }, (_, index) => {
    const id = `cand_v1_${hash(`indexed-${index}`)}`;
    return { candidate_id: id, company: `Indexed Company ${index}`, title: `Indexed Role ${index}`,
      url: `https://jobs.example.test/indexed/${index}` };
  });
  putRun(f, 'large-index', indexed);
  for (let index = 0; index < 400; index += 1) {
    report(f, `cand_v1_${hash(`report-${index}`)}`, String(index + 1).padStart(3, '0'));
  }
  const queued = Array.from({ length: 150 }, (_, index) => {
    const id = `cand_v1_${hash(`queued-${index}`)}`;
    return candidate(id, { company: `Queued Company ${index}`, title: `Queued Role ${index}`,
      url: `https://jobs.example.test/queued/${index}` });
  });
  const run = putRun(f, 'large-queue', queued);
  const start = performance.now();
  const result = queue(f, [run]);
  t.diagnostic(`large synthetic queue completed in ${(performance.now() - start).toFixed(0)} ms`);
  assert.equal(result.include.length, 150);
});

test('blank optional language subfields are accepted and fall back to the level', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const id = cid('f');
  const run = putRun(f, 'null-cefr-profile', [candidate(id, {
    description: `German C1 is required. ${description}`,
  })]);
  put(join(f.root, 'config', 'profile.yml'),
    'home_country: Finland\nauthorized_countries: [Finland]\nlanguages:\n  english: fluent\n  german:\n    cefr: null\n    level: C1\n');
  const result = queue(f, [run]);
  assert.deepEqual(result.include.map((entry) => entry.candidate_id), [id]);
});

test('abandoned-only application batches do not exclude; active, missing, malformed or mismatched state still does', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const onlyAbandoned = cid('a'); const mixed = cid('b'); const noState = cid('c'); const noId = cid('d');
  const wrongId = cid('e'); const sibling = cid('f'); const mappedOld = cid('1'); const mappedNew = cid('2');
  const brokenRows = cid('3');
  putBatch(f, 'old-attempt', [onlyAbandoned, mixed, sibling], { states: ['abandoned', 'abandoned', 'form_prepared'] });
  putBatch(f, 'later-attempt', [mixed], { states: ['not_opened'] });
  putBatch(f, 'no-state', [noState]);
  putBatch(f, 'state-without-id', [noId], { states: [{ state: 'abandoned' }] });
  putBatch(f, 'state-other-id', [wrongId], { states: [{ candidate_id: cid('9'), state: 'abandoned' }] });
  putBatch(f, 'state-rows-not-array', [brokenRows], { rawState: JSON.stringify({ candidates: { 0: { candidate_id: brokenRows, state: 'abandoned' } } }) });
  putBatch(f, 'mapped-abandoned', [mappedOld], { states: ['abandoned'] });
  const run = putRun(f, 'mixed-batches', [candidate(onlyAbandoned), candidate(mixed), candidate(noState), candidate(noId),
    candidate(wrongId), candidate(sibling), candidate(brokenRows)]);
  const enrichment = JSON.stringify([{ source_candidate_id: mappedOld, candidate_id: mappedNew }]);
  const mappedRun = putRun(f, 'mapped-abandoned-run', [candidate(mappedNew)], { enriched: true, enrichment });
  const result = queue(f, [run, mappedRun]);
  const excluded = new Map(result.exclude.map((entry) => [entry.candidate_id, entry]));
  for (const id of [mixed, noState, noId, wrongId, sibling, brokenRows]) {
    assert.equal(excluded.get(id)?.reason, 'in_application_batch', id);
    assert.equal('active' in excluded.get(id).detail, false);
  }
  assert.deepEqual(excluded.get(mixed).detail.candidate_states, [
    { batch_id: 'later-attempt', state: 'not_opened' }, { batch_id: 'old-attempt', state: 'abandoned' },
  ]);
  const included = new Map([...result.include, ...result.needs_liveness].map((entry) => [entry.candidate_id, entry]));
  for (const [id, batchId] of [[onlyAbandoned, 'old-attempt'], [mappedNew, 'mapped-abandoned']]) {
    assert.ok(included.has(id), id);
    assert.deepEqual(included.get(id).possible_duplicates.filter((entry) => entry.reason === 'abandoned_application_batch'),
      [{ reason: 'abandoned_application_batch', batch_ids: [batchId] }]);
  }
});

test('an abandoned row never hides an active row of the same batch (repeated or strongly equivalent IDs, both orders)', (t) => {
  for (const order of [['form_prepared', 'abandoned'], ['abandoned', 'form_prepared']]) {
    const repeated = fixture(); t.after(repeated.cleanup);
    const id = cid('4');
    putBatch(repeated, 'repeat-batch', [id, id], { states: order });
    const repeatedResult = queue(repeated, [putRun(repeated, 'repeat-run', [candidate(id)])]);
    assert.equal(repeatedResult.exclude[0]?.reason, 'in_application_batch', order.join('>'));
    assert.deepEqual(repeatedResult.exclude[0].detail.batch_ids, ['repeat-batch']);
    assert.equal(repeatedResult.exclude[0].detail.candidate_states.length, 2);

    const equivalent = fixture(); t.after(equivalent.cleanup);
    const current = cid('5'); const source = cid('6');
    putBatch(equivalent, 'equivalent-batch', [current, source], { states: order });
    const enrichment = JSON.stringify([{ source_candidate_id: source, candidate_id: current }]);
    const run = putRun(equivalent, 'equivalent-run', [candidate(current)], { enriched: true, enrichment });
    const equivalentResult = queue(equivalent, [run]);
    assert.equal(equivalentResult.exclude[0]?.reason, 'in_application_batch', order.join('>'));
    assert.deepEqual(equivalentResult.exclude[0].detail.batch_ids, ['equivalent-batch']);
    assert.equal(equivalentResult.exclude[0].detail.candidate_states.length, 2);
  }
});
