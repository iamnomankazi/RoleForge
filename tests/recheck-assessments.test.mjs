import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { recheckAssessments } from '../recheck-assessments.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const candidateId = (letter) => `cand_v1_${letter.repeat(64)}`;
const digest = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

function summary({ id, blockers = [], flags = [], softGaps = [], legacy = false }) {
  return [
    'company: Example Oy', 'role: Senior Software Engineer', 'location: Helsinki, Finland',
    'location_country: Finland',
    ...(legacy ? ['score: 4.5', 'blockers: [Old blocker wording]', 'flags: []'] : [
      'fit_score: 4.5', 'liveness: confirmed',
      `blockers: ${JSON.stringify(blockers)}`, `flags: ${JSON.stringify(flags)}`,
      `soft_gaps: ${JSON.stringify(softGaps)}`,
    ]),
    ...(id ? [`candidate_id: ${id}`] : []),
  ].join('\n');
}

function report({ id, body, supersedes }) {
  return [
    id ? `**Candidate ID:** ${id}` : '',
    supersedes ? `**Supersedes:** [${supersedes}](reports/${supersedes}-retired.md)` : '',
    '', '## Machine Summary', '', '```yaml', body, '```', '', '## Evaluation', 'Synthetic report content.',
  ].filter((line, index, lines) => !(line === '' && lines[index - 1] === '')).join('\n');
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function allFileBytes(root) {
  const files = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else files.set(file, readFileSync(file));
    }
  };
  walk(root);
  return files;
}

function makeFixture() {
  const root = resolve(tmpdir(), `roleforge-recheck-${process.pid}-${Date.now()}`);
  const reports = join(root, 'reports');
  const runs = join(root, 'output', 'scan-runs', 'run-synthetic');
  const liveness = join(root, 'liveness-synthetic');
  for (const directory of [join(root, 'config'), reports, runs, join(liveness, 'descriptions')]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(join(root, 'config', 'profile.yml'), [
    'education_details:', '  expected_graduation_date: 31/05/2027',
    'experience_policy:', '  normal_max_years: 2', '  outside_min_years: 4', '',
  ].join('\n'));

  const ids = Object.fromEntries(Object.entries({ a: 'a', b: 'b', c: 'c', d: 'd', e: 'e', f: 'f', g: '0' })
    .map(([label, letter]) => [label, candidateId(letter)]));
  const clearDescription = `Applicants must have graduated between 2026 and 2028. ${'Synthetic role requirements continue. '.repeat(5)}`;
  const appearCapture = `Applicants must have graduated between 2023 and 2025. ${'Synthetic role requirements continue. '.repeat(4)}`;
  const invalidExpected = `Applicants must have graduated between 2024 and 2026. ${'Synthetic role requirements continue. '.repeat(4)}`;
  const invalidStored = `Applicants must have graduated between 2024 and 2026. ${'Different stored text. '.repeat(5)}`;
  const wordingDescription = `The role is open to applicants. ${'Synthetic role requirements continue. '.repeat(5)}`;
  const unchangedDescription = `Build reliable software for customers. ${'Synthetic role requirements continue. '.repeat(5)}`;
  const stillAppliesDescription = `Applicants must have graduated between 2023 and 2025. ${'Synthetic role requirements continue. '.repeat(4)}`;
  writeJson(join(runs, 'manifest.json'), { created_at: '2026-11-01T00:00:00.000Z' });
  writeJson(join(runs, 'candidates.json'), [
    { candidate_id: ids.a, company: 'Example Oy', title: 'Senior Software Engineer', location: 'Helsinki, Finland', description: clearDescription },
    { candidate_id: ids.b, company: 'Example Oy', title: 'Senior Software Engineer', location: 'Helsinki, Finland', description: 'Short listing.' },
    { candidate_id: ids.c, company: 'Example Oy', title: 'Senior Software Engineer', location: 'Helsinki, Finland', description: 'Short listing.' },
    { candidate_id: ids.d, company: 'Example Oy', title: 'Senior Software Engineer', location: 'Helsinki, Finland', description: wordingDescription },
    { candidate_id: ids.e, company: 'Example Oy', title: 'Senior Software Engineer', location: 'Helsinki, Finland', description: unchangedDescription },
    { candidate_id: ids.f, company: 'Example Oy', title: 'Senior Software Engineer', location: 'Helsinki, Finland', description: stillAppliesDescription },
    { candidate_id: ids.g, company: 'Example Oy', title: 'Senior Software Engineer', location: 'Helsinki, Finland', description: wordingDescription },
  ]);

  const addReport = (number, id, body, extra = {}) => writeFileSync(
    join(reports, `${number}-synthetic.md`), report({ id, body, ...extra }),
  );
  addReport('010', ids.a, summary({ id: ids.a, blockers: [{ code: 'graduation_window', evidence: 'Graduation date: 31/12/2026.' }] }));
  addReport('011', ids.b, summary({ id: ids.b }));
  addReport('012', ids.c, summary({ id: ids.c }));
  addReport('013', ids.d, summary({ id: ids.d, flags: [{ code: 'language_preferred', evidence: 'Graduation in May 2027 is listed.' }] }));
  addReport('014', null, summary({}));
  addReport('015', ids.e, summary({ id: ids.e, legacy: true }));
  addReport('016', ids.e, summary({ id: ids.e }));
  addReport('017', ids.e, summary({ id: ids.e }), { supersedes: '016' });
  addReport('018', ids.f, summary({ id: ids.f, blockers: [{ code: 'graduation_window', evidence: 'Graduation date: May 2027.' }] }));
  addReport('019', ids.g, summary({ id: ids.g, blockers: [{ code: 'graduation_window', evidence: '31/12/2026' }] }));

  writeFileSync(join(liveness, 'descriptions', `${ids.b}.txt`), `${appearCapture}\n`);
  writeFileSync(join(liveness, 'descriptions', `${ids.c}.txt`), `${invalidStored}\n`);
  writeJson(join(liveness, 'liveness.json'), {
    [ids.b]: { status: 'failed', description_sha256: digest(appearCapture) },
    [ids.c]: { status: 'unconfirmed', description_sha256: digest(invalidExpected) },
  });
  return { root, reports, runs, liveness, ids };
}

function withResult(callback) {
  const fixture = makeFixture();
  try {
    callback(recheckAssessments({ root: fixture.root, livenessDirs: [fixture.liveness] }), fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('recheck replays graduation windows, verifies liveness captures, and leaves input bytes unchanged', () => {
  const fixture = makeFixture();
  try {
    const before = allFileBytes(fixture.root);
    const result = recheckAssessments({ root: fixture.root, livenessDirs: [fixture.liveness] });
    assert.equal(result.schema, 'recheck-assessments/1');
    assert.equal(result.profile_graduation_date, '2027-05-31');
    assert.deepEqual(result.counts, {
      blocker_would_clear: 1, blocker_still_applies: 1, blocker_not_reproducible: 1,
      blocker_would_appear: 1, wording_mentions_graduation: 1,
      cannot_check: 2, unchanged: 1, skipped_legacy: 1, skipped_superseded: 1,
    });
    const clear = result.lists.blocker_would_clear[0];
    assert.equal(clear.report, 10);
    assert.equal(clear.candidate_id, fixture.ids.a);
    assert.equal(clear.replay_graduation.eligible, true);
    assert.equal(clear.replay_blocker, null);
    assert.deepEqual(clear.cites_profile_dates, ['2026-12']);
    assert.equal(clear.cites_stale_profile_date, true);
    const stillApplies = result.lists.blocker_still_applies[0];
    assert.equal(stillApplies.report, 18);
    assert.ok(stillApplies.replay_blocker);
    assert.deepEqual(stillApplies.cites_profile_dates, ['2027-05']);
    assert.equal(stillApplies.cites_stale_profile_date, false);
    const notReproducible = result.lists.blocker_not_reproducible[0];
    assert.equal(notReproducible.report, 19);
    assert.equal(notReproducible.replay_graduation, null);
    assert.deepEqual(notReproducible.cites_profile_dates, ['2026-12']);
    assert.equal(notReproducible.cites_stale_profile_date, true);
    const appear = result.lists.blocker_would_appear[0];
    assert.equal(appear.report, 11);
    assert.equal(appear.description_source, resolve(fixture.liveness));
    assert.equal(appear.description_sha256, digest(`Applicants must have graduated between 2023 and 2025. ${'Synthetic role requirements continue. '.repeat(4)}`));
    assert.equal(appear.replay_blocker.evidence, 'Applicants must have graduated between 2023 and 2025');
    assert.equal(result.lists.wording_mentions_graduation[0].report, 13);
    assert.deepEqual(result.lists.wording_mentions_graduation[0].cites_profile_dates, ['2027-05']);
    assert.equal(result.lists.wording_mentions_graduation[0].cites_stale_profile_date, false);
    assert.equal(result.lists.blocker_would_appear[0].report, 11);
    assert.ok(result.lists.cannot_check.some((entry) => entry.report === 12 && entry.reason === 'no_verified_description'));
    assert.ok(result.lists.cannot_check.some((entry) => entry.report === 14 && entry.reason === 'no_candidate_id'));
    assert.equal(before.size, allFileBytes(fixture.root).size);
    for (const [file, bytes] of before) assert.deepEqual(readFileSync(file), bytes, file);

    const cli = spawnSync(process.execPath, [
      resolve(ROOT, 'recheck-assessments.mjs'), '--root', fixture.root,
      '--profile', join(fixture.root, 'config', 'profile.yml'), '--liveness', fixture.liveness, '--json',
    ], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).schema, 'recheck-assessments/1');
    const human = spawnSync(process.execPath, [
      resolve(ROOT, 'recheck-assessments.mjs'), '--root', fixture.root,
      '--profile', join(fixture.root, 'config', 'profile.yml'), '--liveness', fixture.liveness,
    ], { encoding: 'utf8' });
    assert.equal(human.status, 0, human.stderr);
    for (const heading of ['blocker would clear', 'blocker still applies', 'blocker not reproducible', 'blocker would appear', 'wording mentions graduation']) {
      assert.match(human.stdout, new RegExp(heading));
    }
    assert.match(human.stdout, /#19 Senior Software Engineer cites_stale_profile_date=true/);
    const refused = spawnSync(process.execPath, [
      resolve(ROOT, 'recheck-assessments.mjs'), '--root', fixture.root,
      '--profile', join(fixture.root, 'config', 'profile.yml'), '--out', join(fixture.reports, '010-synthetic.md'),
    ], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /cannot point inside reports/);
    for (const [file, bytes] of before) assert.deepEqual(readFileSync(file), bytes, file);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('blocker_would_clear requires an eligible replay window', () => {
  withResult((result) => {
    assert.equal(result.lists.blocker_would_clear.length, 1);
    assert.equal(result.lists.blocker_would_clear[0].report, 10);
    assert.equal(result.lists.blocker_would_clear[0].replay_graduation.eligible, true);
  });
});

test('blocker_still_applies contains reports whose replay keeps a graduation blocker', () => {
  withResult((result) => {
    assert.equal(result.lists.blocker_still_applies.length, 1);
    assert.equal(result.lists.blocker_still_applies[0].report, 18);
    assert.ok(result.lists.blocker_still_applies[0].replay_blocker);
  });
});

test('blocker_not_reproducible identifies reports whose description has no graduation window', () => {
  withResult((result) => {
    const entry = result.lists.blocker_not_reproducible[0];
    assert.equal(entry.report, 19);
    assert.equal(entry.replay_graduation, null);
    assert.deepEqual(entry.cites_profile_dates, ['2026-12']);
    assert.equal(entry.cites_stale_profile_date, true);
  });
});

test('blocker_would_appear remains reserved for a new replay blocker', () => {
  withResult((result) => {
    assert.equal(result.lists.blocker_would_appear.length, 1);
    assert.equal(result.lists.blocker_would_appear[0].report, 11);
    assert.ok(result.lists.blocker_would_appear[0].replay_blocker);
  });
});

test('wording_mentions_graduation keeps reports outside blocker classifications and cites dates', () => {
  withResult((result) => {
    const entry = result.lists.wording_mentions_graduation[0];
    assert.equal(entry.report, 13);
    assert.deepEqual(entry.cites_profile_dates, ['2027-05']);
    assert.equal(entry.cites_stale_profile_date, false);
  });
});
