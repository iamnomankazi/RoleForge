import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { collectReports, parseArgs, renderShortlist } from '../shortlist.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = { company: 'Synthetic', role: 'Developer', fit_score: 4.5, blockers: [], flags: [], liveness: 'confirmed', location_country: 'Finland' };

function fixture(t) {
  const dir = mkdtempSync(join(root, 'tests', 'shortlist-fixture-'));
  const reports = join(dir, 'reports');
  mkdirSync(reports);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const add = (filename, extra, header = '') => writeFileSync(join(reports, filename), `# Synthetic report\n${header}\n## Machine Summary\n\n\`\`\`yaml\n${yaml.dump({ ...base, ...extra })}\`\`\`\n## A) Role\nSynthetic content.\n`);
  return { dir, reports, add, out: join(dir, 'output', 'shortlist.md') };
}

test('shortlist puts Finland first, other target countries next, remote next, then score descending', (t) => {
  const { reports, add, out } = fixture(t);
  add('remote.md', { company: 'Remote', location_country: 'EU-remote', fit_score: 5 });
  add('germany.md', { company: 'Germany', location_country: 'Germany', fit_score: 5 });
  add('denmark.md', { company: 'Denmark', location_country: 'DK', fit_score: 4 });
  add('netherlands.md', { company: 'Netherlands', location_country: 'Netherlands', fit_score: 4.8 });
  add('finland-low.md', { company: 'Finland low', location_country: 'FI', fit_score: 4 });
  add('finland-high.md', { company: 'Finland high', fit_score: 4.7 });
  add('other.md', { company: 'Other', location_country: 'France', fit_score: 5 });
  const result = collectReports({ reports });
  assert.deepEqual(result.apply.map((entry) => entry.company), ['Finland high', 'Finland low', 'Germany', 'Netherlands', 'Denmark', 'Remote', 'Other']);
  const markdown = renderShortlist(result, out);
  assert.match(markdown, /## Apply \(7\)/);
  assert.match(markdown, /\| Report \| Company \| Role \| Location \| Fit score \| Action \| Flags \| Review reason \|/);
  assert.match(markdown, /\]\(<\.\.\/reports\/finland-high.md>\)/);
});

test('sections derive actions, skip is count only, legacy reports are separate', (t) => {
  const { reports, add, out } = fixture(t);
  add('apply.md', { flags: [{ code: 'sponsorship_unknown', evidence: 'No sponsorship statement in synthetic JD.' }] });
  add('review-remote.md', { company: 'Remote review', location_country: 'Remote', liveness: 'unconfirmed', fit_score: 5, review_reason: 'Confirm liveness.' });
  add('review-finland.md', { company: 'Finland review', fit_score: 3.5, review_reason: 'Confirm experience expectations.' });
  add('skip.md', { company: 'Skipped', fit_score: 5, blockers: [{ code: 'language_required', evidence: 'Fluent German required.' }] });
  add('weak.md', { company: 'Weak', fit_score: 3.49 });
  writeFileSync(join(reports, 'legacy.md'), '## Machine Summary\n\n    company: Legacy\n    role: Developer\n    score: 5\n    bucket: Strong Match\n    blockers: []\n');
  const result = collectReports({ reports });
  assert.deepEqual(['apply', 'review', 'skip', 'legacy', 'invalid'].map((key) => result[key].length), [1, 2, 2, 1, 0]);
  assert.deepEqual(result.review.map((entry) => entry.company), ['Finland review', 'Remote review']);
  const markdown = renderShortlist(result, out);
  for (const heading of ['## Apply (1)', '## Review (2)', '## Skip (2)', '## Needs re-assessment (legacy format) (1)']) assert.ok(markdown.includes(heading));
  assert.ok(markdown.includes('sponsorship_unknown'));
  assert.ok(markdown.includes('Confirm experience expectations.'));
  assert.ok(!markdown.includes('skip.md'));
  assert.ok(!markdown.includes('weak.md'));
  assert.ok(markdown.includes('legacy.md'));
});

test('nested YAML fence layout retains blockers and free-text arrays route as legacy', (t) => {
  const { reports } = fixture(t);
  writeFileSync(join(reports, 'blocked.md'), `## Machine Summary

\`\`\`yaml
company: Synthetic
role: Developer
fit_score: 4.5
blockers: []
flags: []
liveness: confirmed
location_country: FI
top_strengths:
  - |
    \`\`\`
    Synthetic literal content
    \`\`\`
prescreen:
  blockers:
    - code: language_required
      evidence: German required
  flags: []
\`\`\`
## A) Role
`);
  writeFileSync(join(reports, 'old-text.md'), `## Machine Summary

\`\`\`yaml
company: Legacy
role: Developer
score: 4.5
blockers:
  - German required
flags:
  - Check sponsorship
location_country: FI
\`\`\`
`);
  const result = collectReports({ reports });
  assert.equal(result.apply.length, 0);
  assert.equal(result.review.length, 0);
  assert.deepEqual(result.skip.map((entry) => entry.report.split(/[\\/]/).at(-1)), ['blocked.md']);
  assert.deepEqual(result.legacy.map((entry) => entry.report.split(/[\\/]/).at(-1)), ['old-text.md']);
  assert.equal(result.invalid.length, 0);
});

test('invalid and contradictory reports never enter Apply or Review', (t) => {
  const { reports, add, out } = fixture(t);
  add('bad-action.md', { action: 'skip' });
  add('bad-evidence.md', { blockers: [{ code: 'profile_exclusion' }] });
  add('bad-review.md', { fit_score: 3.5 });
  writeFileSync(join(reports, 'missing.md'), '# No machine summary');
  writeFileSync(join(reports, 'broken.md'), '## Machine Summary\n\`\`\`yaml\nfit_score: [\n\`\`\`');
  const result = collectReports({ reports });
  assert.equal(result.apply.length + result.review.length + result.skip.length, 0);
  assert.equal(result.invalid.length, 5);
  assert.match(renderShortlist(result, out), /## Invalid reports \(5\)/);
});

test('since filters inclusively by summary date, Date/Fecha header, or filename', (t) => {
  const { reports, add } = fixture(t);
  add('older-2026-10-01.md', {});
  add('same-2026-10-05.md', {});
  add('header.md', {}, '**Fecha:** 2026-10-06');
  add('summary.md', { date: '2026-10-07' });
  add('unknown.md', {});
  const result = collectReports({ reports, since: '2026-10-05' });
  assert.equal(result.apply.length, 3);
  assert.equal(result.excluded, 2);
});

test('CLI writes Markdown and emits JSON counts; unknown flags and missing values fail', (t) => {
  const { reports, add, out } = fixture(t);
  add('apply.md', {});
  const run = (...args) => spawnSync(process.execPath, [join(root, 'shortlist.mjs'), ...args], { cwd: root, encoding: 'utf8' });
  const result = run('--reports', reports, '--out', out, '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).counts, { apply: 1, review: 0, skip: 0, legacy: 0, invalid: 0, excluded: 0 });
  assert.match(readFileSync(out, 'utf8'), /## Apply \(1\)/);
  assert.equal(run('--help').status, 0);
  assert.match(run('--help').stdout, /Usage: node shortlist.mjs/);
  for (const args of [['--wat'], ['--reports'], ['--out', '--json'], ['--since', '2026-02-30'], ['--since', '2026-1-1']]) {
    assert.equal(run(...args).status, 1);
    assert.throws(() => parseArgs(args));
  }
  add('invalid.md', { action: 'skip' });
  const invalid = run('--reports', reports, '--out', out, '--json');
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).counts.invalid, 1);
});

test('Markdown escapes table separators and links encode spaces', (t) => {
  const { reports, add, out } = fixture(t);
  add('space name.md', { company: 'Example | Group', role: 'Developer\nBackend' });
  const markdown = renderShortlist(collectReports({ reports }), out);
  assert.match(markdown, /Example &#124; Group/);
  assert.match(markdown, /Developer Backend/);
  assert.match(markdown, /space%20name.md/);
});
