import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseUnifiedDiff } from '../scripts/privacy-guard.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GUARD = join(ROOT, 'scripts', 'privacy-guard.mjs');
const SAMPLE_EMAIL = 'jane.doe@example.com';
const SAMPLE_PHONE = '+358 40 123 4567';
const SAMPLE_COMPANY = 'Example Oy';

function tempDir(t) {
  const path = mkdtempSync(join(tmpdir(), 'privacy-guard-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo(t) {
  const root = tempDir(t);
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Privacy Guard Test');
  git(root, 'config', 'core.autocrlf', 'false');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'base.md'), 'Public baseline.\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  return root;
}

function commitAll(repo, message) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function denylist(repo, { hard = [], soft = [{ category: 'name', value: 'Unrelated Example' }], sources = [] } = {}) {
  const path = join(repo, 'local', 'privacy-denylist.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, built_at: new Date().toISOString(), sources, hard, soft }, null, 2));
  return path;
}

function invoke(repo, args, { input = '', env = {} } = {}) {
  return spawnSync(process.execPath, [GUARD, ...args], {
    cwd: repo,
    input,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CAREER_OPS_TRACKER: '', ROLEFORGE_PRIVACY_DENYLIST: '', ...env },
  });
}

function stageText(repo, path, text) {
  const absolute = join(repo, ...path.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
  git(repo, 'add', path);
}

test('invalid mode combinations return the usage-error status', (t) => {
  const repo = makeRepo(t);
  const result = invoke(repo, ['--staged', '--range', 'HEAD..HEAD']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage error/);
});

test('parses added line numbers, binary sections, and deleted paths', () => {
  const parsed = parseUnifiedDiff([
    'diff --git a/docs/note.md b/docs/note.md',
    '--- a/docs/note.md',
    '+++ b/docs/note.md',
    '@@ -2,2 +2,4 @@',
    ' old',
    '+first',
    '-removed',
    '+second',
    '+++third',
    'diff --git a/docs/image.bin b/docs/image.bin',
    'new file mode 100644',
    'GIT binary patch',
    'literal 3',
    'diff --git a/docs/gone.md b/docs/gone.md',
    'deleted file mode 100644',
    '--- a/docs/gone.md',
    '+++ /dev/null',
  ].join('\n'));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0].addedLines, [
    { line: 3, text: 'first' },
    { line: 4, text: 'second' },
    { line: 5, text: '++third' },
  ]);
  assert.equal(parsed[1].binary, true);
  assert.equal(parsed[2].newPath, null);
  assert.equal(parsed[2].deleted, true);
});

test('hunk lines that resemble file headers remain content', (t) => {
  const repo = makeRepo(t);
  const list = denylist(repo, { hard: [{ category: 'email', value: SAMPLE_EMAIL }] });
  const patch = [
    'diff --git a/cv.md b/cv.md',
    '--- a/cv.md',
    '+++ b/cv.md',
    '@@ -0,0 +1,2 @@',
    '+++ /dev/null',
    `+Contact ${SAMPLE_EMAIL}`,
  ].join('\n');
  const parsed = parseUnifiedDiff(patch);
  assert.equal(parsed[0].newPath, 'cv.md');
  assert.deepEqual(parsed[0].addedLines.map(({ text }) => text), [`++ /dev/null`, `Contact ${SAMPLE_EMAIL}`]);
  const patchPath = join(repo, 'change.diff');
  writeFileSync(patchPath, patch);
  const result = invoke(repo, ['--patch', patchPath, '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private path: cv\.md/);
  assert.match(result.stderr, /cv\.md:2 email/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(SAMPLE_EMAIL.replace('.', '\\.')));
});

test('path denylist blocks private paths and allows README/.gitkeep scaffolds', (t) => {
  const repo = makeRepo(t);
  const list = denylist(repo);
  for (const path of ['cv.md', 'data/x.md', 'reports/1.md']) stageText(repo, path, 'synthetic content\n');
  let result = invoke(repo, ['--staged', '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 1, result.stderr);
  for (const path of ['cv.md', 'data/x.md', 'reports/1.md']) assert.match(result.stderr, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  git(repo, 'reset', '--hard', 'HEAD');
  stageText(repo, 'data/README.md', '# Scaffold\n');
  stageText(repo, 'local/.gitkeep', '');
  result = invoke(repo, ['--staged', '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /content scan performed/);
});

test('hard email hits are detected without revealing the value', (t) => {
  const repo = makeRepo(t);
  const list = denylist(repo, { hard: [{ category: 'email', value: SAMPLE_EMAIL }] });
  stageText(repo, 'docs/change.md', `Contact ${SAMPLE_EMAIL}\n`);
  const result = invoke(repo, ['--staged', '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/change\.md:1 email/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(SAMPLE_EMAIL.replace('.', '\\.')));
});

test('phone values match when punctuation and spacing differ', (t) => {
  const repo = makeRepo(t);
  const list = denylist(repo, { hard: [{ category: 'phone', value: SAMPLE_PHONE }] });
  stageText(repo, 'docs/change.md', 'Reach me at +358-40 (123) 45.67\n');
  const result = invoke(repo, ['--staged', '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/change\.md:1 phone/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /358.?40.?123.?4567/);
});

test('soft matches block unless present in the base tree or explicitly acknowledged', (t) => {
  const repo = makeRepo(t);
  const list = denylist(repo, { soft: [{ category: 'company', value: SAMPLE_COMPANY }] });
  stageText(repo, 'docs/change.md', `Worked at ${SAMPLE_COMPANY}.\n`);
  let result = invoke(repo, ['--staged', '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Example Oy/);

  git(repo, 'reset', '--hard', 'HEAD');
  stageText(repo, 'docs/public-reference.md', `${SAMPLE_COMPANY} is already public.\n`);
  commitAll(repo, 'publish public company reference');
  stageText(repo, 'docs/change.md', `Worked at ${SAMPLE_COMPANY}.\n`);
  result = invoke(repo, ['--staged', '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 0, result.stderr);

  git(repo, 'reset', '--hard', 'HEAD');
  stageText(repo, 'docs/change.md', `Worked at ${SAMPLE_COMPANY}.\n`);
  result = invoke(repo, ['--staged', '--repo', repo, '--denylist', list], {
    env: { ROLEFORGE_PRIVACY_ACK: 'reviewed public portfolio entry' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /reviewed public portfolio entry/);
});

test('missing, empty, and stale denylists fail closed', (t) => {
  const repo = makeRepo(t);
  const missing = join(repo, 'local', 'missing.json');
  let result = invoke(repo, ['--staged', '--repo', repo, '--denylist', missing]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /content scan not performed/);
  assert.match(result.stderr, /node scripts\/privacy-guard\.mjs --build-denylist/);

  const empty = denylist(repo, { hard: [], soft: [], sources: [] });
  result = invoke(repo, ['--staged', '--repo', repo, '--denylist', empty]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /content scan not performed/);

  const source = join(repo, 'config', 'profile.yml');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, 'email: old@example.invalid\n');
  const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
  const stale = denylist(repo, {
    hard: [{ category: 'email', value: 'old@example.invalid' }],
    sources: [{ path: 'config/profile.yml', sha256: sourceHash }],
  });
  writeFileSync(source, 'email: new@example.invalid\n');
  result = invoke(repo, ['--staged', '--repo', repo, '--denylist', stale]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /content scan not performed/);
});

test('--paths-only scans a range without loading a denylist', (t) => {
  const repo = makeRepo(t);
  const base = git(repo, 'rev-parse', 'HEAD');
  stageText(repo, 'docs/change.md', 'Public change.\n');
  const head = commitAll(repo, 'public change');
  const result = invoke(repo, ['--paths-only', '--range', `${base}..${head}`, '--repo', repo]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /paths-only: no content scan performed/);
});

test('default denylist lookup uses the shared git common directory for a linked worktree', (t) => {
  const main = makeRepo(t);
  const list = denylist(main, { hard: [{ category: 'email', value: SAMPLE_EMAIL }] });
  const linked = join(tempDir(t), 'linked');
  git(main, 'worktree', 'add', '--detach', linked, 'HEAD');
  const result = invoke(linked, ['--staged', '--repo', linked]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /content scan performed/);
  assert.ok(readFileSync(list, 'utf8').includes(SAMPLE_EMAIL));
});

test('--range catches a private file added in an intermediate commit and later deleted', (t) => {
  const repo = makeRepo(t);
  const list = denylist(repo, { hard: [{ category: 'email', value: SAMPLE_EMAIL }] });
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'cv.md'), `Contact ${SAMPLE_EMAIL}\n`);
  const added = commitAll(repo, 'add private content');
  rmSync(join(repo, 'cv.md'));
  const head = commitAll(repo, 'remove private content');
  assert.notEqual(added, head);
  const result = invoke(repo, ['--range', `${base}..${head}`, '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private path: cv\.md/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(SAMPLE_EMAIL.replace('.', '\\.')));
});

test('--pre-push scans new commits with both zero and known remote shas', (t) => {
  const repo = makeRepo(t);
  const list = denylist(repo, { hard: [{ category: 'email', value: SAMPLE_EMAIL }] });
  const remoteSha = git(repo, 'rev-parse', 'HEAD');
  stageText(repo, 'docs/pushed.md', `Contact ${SAMPLE_EMAIL}\n`);
  const localSha = commitAll(repo, 'local push candidate');
  const zero = '0'.repeat(localSha.length);
  const stdinZero = `refs/heads/topic ${localSha} refs/heads/topic ${zero}\n`;
  let result = invoke(repo, ['--pre-push', 'origin', '--repo', repo, '--denylist', list], { input: stdinZero });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/pushed\.md:1 email/);

  const stdinKnown = `refs/heads/topic ${localSha} refs/heads/main ${remoteSha}\n`;
  result = invoke(repo, ['--pre-push', 'origin', '--repo', repo, '--denylist', list], { input: stdinKnown });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/pushed\.md:1 email/);
});

test('--patch handles binary additions and deletion-only content', (t) => {
  const repo = makeRepo(t);
  const list = denylist(repo, { hard: [{ category: 'email', value: SAMPLE_EMAIL }] });
  const base = git(repo, 'rev-parse', 'HEAD');
  stageText(repo, 'cv.md', `Contact ${SAMPLE_EMAIL}\n`);
  commitAll(repo, 'add synthetic old file');
  const old = git(repo, 'rev-parse', 'HEAD');
  rmSync(join(repo, 'cv.md'));
  writeFileSync(join(repo, 'docs', 'image.bin'), Buffer.from([0, 1, 2, 3, 255]));
  const head = commitAll(repo, 'delete and add binary');
  const patch = git(repo, 'diff', '--binary', '--find-renames', '--unified=0', old, head);
  assert.match(patch, /GIT binary patch/);
  const patchFile = join(repo, 'change.diff');
  writeFileSync(patchFile, patch);
  const result = invoke(repo, ['--patch', patchFile, '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /binary file: docs\/image\.bin/);
  const acknowledged = invoke(repo, ['--patch', patchFile, '--repo', repo, '--denylist', list], {
    env: { ROLEFORGE_PRIVACY_ACK: 'reviewed binary addition' },
  });
  assert.equal(acknowledged.status, 0, acknowledged.stderr);
  assert.match(acknowledged.stderr, /acknowledged binary file: docs\/image\.bin/);
  assert.match(acknowledged.stdout, /content scan performed/);
  assert.equal(base.length > 0, true);
});

test('binary additions and modifications block unless acknowledged; binary deletion is allowed', (t) => {
  const repo = makeRepo(t);
  const list = denylist(repo);
  const binaryPath = join(repo, 'docs', 'media.bin');
  writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3, 255]));
  git(repo, 'add', 'docs/media.bin');
  let result = invoke(repo, ['--staged', '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /binary file: docs\/media\.bin/);
  result = invoke(repo, ['--staged', '--repo', repo, '--denylist', list], {
    env: { ROLEFORGE_PRIVACY_ACK: 'reviewed binary file' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /acknowledged binary file: docs\/media\.bin/);

  commitAll(repo, 'add synthetic binary');
  writeFileSync(binaryPath, Buffer.from([255, 3, 2, 1, 0]));
  git(repo, 'add', 'docs/media.bin');
  result = invoke(repo, ['--staged', '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /binary file: docs\/media\.bin/);

  git(repo, 'reset', '--hard', 'HEAD');
  rmSync(binaryPath);
  git(repo, 'add', '-u', 'docs/media.bin');
  result = invoke(repo, ['--staged', '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 0, result.stderr);
  const deletionPatch = join(repo, 'delete-binary.diff');
  writeFileSync(deletionPatch, git(repo, 'diff', '--cached', '--binary', 'HEAD', '--'));
  result = invoke(repo, ['--patch', deletionPatch, '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 0, result.stderr);
});

test('path parsing preserves spaces and checks copy destinations', (t) => {
  const repo = makeRepo(t);
  const list = denylist(repo);
  const parsed = parseUnifiedDiff([
    'diff --git a/docs/source file.md b/docs/source file.md',
    'old mode 100644',
    'new mode 100755',
  ].join('\n'));
  assert.equal(parsed[0].path, 'docs/source file.md');

  const patch = [
    'diff --git a/docs/source.md b/local/copied private file.md',
    'similarity index 100%',
    'copy from docs/source.md',
    'copy to local/copied private file.md',
  ].join('\n');
  const patchPath = join(repo, 'copy.diff');
  writeFileSync(patchPath, patch);
  const result = invoke(repo, ['--patch', patchPath, '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private path: local\/copied private file\.md/);
});

test('a denylist written outside local/ checks sources under the recorded root', (t) => {
  const root = tempDir(t);
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Privacy Guard Test');
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'profile.yml'), 'candidate:\n  email: jane.doe@example.com\n');
  mkdirSync(join(root, 'interview-prep'), { recursive: true });
  writeFileSync(join(root, 'interview-prep', 'first.md'), 'Recruiter: Riley Sample\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'synthetic denylist inputs');
  const out = join(root, 'privacy-denylist.json');
  assert.equal(invoke(root, ['--build-denylist', '--root', root, '--out', out]).status, 0);
  const check = () => invoke(root, ['--staged', '--repo', root, '--denylist', out]);
  assert.equal(check().status, 0, 'a fresh list in a custom location is not stale');
  writeFileSync(join(root, 'interview-prep', 'second.md'), 'Contact: Taylor Person\n');
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /content scan not performed/);
});

test('denylist interview inventory changes are stale when files are added, removed, or changed', (t) => {
  const root = tempDir(t);
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Privacy Guard Test');
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'profile.yml'), 'candidate:\n  email: jane.doe@example.com\n');
  mkdirSync(join(root, 'interview-prep'), { recursive: true });
  writeFileSync(join(root, 'interview-prep', 'first.md'), 'Recruiter: Riley Sample\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'synthetic denylist inputs');
  const out = join(root, 'local', 'privacy-denylist.json');
  const build = () => invoke(root, ['--build-denylist', '--root', root, '--out', out]);
  const check = () => invoke(root, ['--staged', '--repo', root, '--denylist', out]);

  let result = build();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(check().status, 0, 'inventory is fresh immediately after building');
  let json = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(json.sources.some((source) => source.path === 'interview-prep/first.md' && /^[a-f0-9]{64}$/.test(source.sha256)));
  assert.ok(!json.sources.some((source) => source.path === 'interview-prep/*.md'));
  json.sources.push({ path: 'interview-prep/*.md', sha256: null });
  writeFileSync(out, JSON.stringify(json));
  result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /content scan not performed/);
  result = build();
  assert.equal(result.status, 0, result.stderr);

  writeFileSync(join(root, 'interview-prep', 'second.md'), 'Contact Taylor Person\n');
  result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /content scan not performed/);

  result = build();
  assert.equal(result.status, 0, result.stderr);
  rmSync(join(root, 'interview-prep', 'first.md'));
  result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /content scan not performed/);

  result = build();
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(root, 'interview-prep', 'second.md'), 'Contact Morgan Sample\n');
  result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /content scan not performed/);
});

test('diagnostics redact hard values from paths, soft values, and acknowledgement reasons', (t) => {
  const repo = makeRepo(t);
  const list = denylist(repo, {
    hard: [
      { category: 'email', value: SAMPLE_EMAIL },
      { category: 'phone', value: SAMPLE_PHONE },
    ],
    soft: [{ category: 'company', value: SAMPLE_EMAIL }],
  });
  const privatePath = `local/${SAMPLE_EMAIL}-358-40-123-4567.md`;
  stageText(repo, privatePath, `Contact ${SAMPLE_EMAIL}.\n`);
  let result = invoke(repo, ['--staged', '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /jane\.do@example\.com/i);
  result = invoke(repo, ['--staged', '--repo', repo, '--denylist', list], {
    env: { ROLEFORGE_PRIVACY_ACK: `reviewed ${SAMPLE_EMAIL.toUpperCase()} and +358-40-123-4567` },
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /jane\.do@example\.com/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /358\D*40\D*123\D*4567/);
  assert.match(result.stderr, /private path: local\/\[REDACTED\]/);
});

test('--range with an empty base scans the root commit', (t) => {
  const repo = tempDir(t);
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Privacy Guard Test');
  writeFileSync(join(repo, 'cv.md'), 'Synthetic private root content.\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'root with private path');
  const head = git(repo, 'rev-parse', 'HEAD');
  const result = invoke(repo, ['--paths-only', '--range', `..${head}`, '--repo', repo]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /private path: cv\.md/);
});

test('binary additions still receive private-path checks', (t) => {
  const repo = makeRepo(t);
  const list = denylist(repo);
  mkdirSync(join(repo, 'data'), { recursive: true });
  writeFileSync(join(repo, 'data', 'synthetic.bin'), Buffer.from([1, 2, 3, 4]));
  git(repo, 'add', 'data/synthetic.bin');
  const result = invoke(repo, ['--staged', '--repo', repo, '--denylist', list]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private path: data\/synthetic\.bin/);
});

test('--build-denylist collects synthetic profile, tracker, and interview values without printing them', (t) => {
  const root = tempDir(t);
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'profile.yml'), [
    'candidate:',
    '  full_name: Jane Example',
    '  email: jane.doe@example.com',
    '  phone: "+358 40 123 4567"',
    'target_roles:',
    '  archetypes:',
    '    - name: Generic Data Engineer',
    'address:',
    '  street: "123 Fictional Street"',
    '  postal_code: "00100 Fiction City"',
    'date_of_birth: "1990-01-02"',
    'passport_number: "ABCD123456"',
  ].join('\n') + '\n');
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'), [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 1 | 2025-01-01 | Example Oy | Engineer | 4/5 | Applied | | | |',
  ].join('\n') + '\n');
  mkdirSync(join(root, 'interview-prep'), { recursive: true });
  writeFileSync(join(root, 'interview-prep', 'example.md'), 'Recruiter - Riley Sample\nHiring manager: Taylor Person\n');
  const out = join(root, 'local', 'privacy-denylist.json');
  const result = invoke(root, ['--build-denylist', '--root', root, '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(readFileSync(out, 'utf8'));
  const values = new Set([...json.hard, ...json.soft].map((entry) => entry.value));
  for (const value of [
    'Jane Example', 'jane.doe@example.com', '+358 40 123 4567', '123 Fictional Street',
    '00100 Fiction City', '1990-01-02', 'ABCD123456', 'Example Oy', 'Riley Sample', 'Taylor Person',
  ]) assert.ok(values.has(value), `missing synthetic value ${value}`);
  assert.ok(!values.has('Generic Data Engineer'), 'only the candidate full name is a personal name');
  assert.ok(json.sources.some((source) => source.path === 'config/profile.yml' && /^[a-f0-9]{64}$/.test(source.sha256)));
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /jane\.do@example\.com|Jane Example|Example Oy|Riley Sample/);
  assert.match(result.stdout, /\d+ hard, \d+ soft entries/);
});

test('USER_PATHS stays in sync with update-system.mjs', () => {
  const updateText = readFileSync(join(ROOT, 'update-system.mjs'), 'utf8');
  const guardText = readFileSync(GUARD, 'utf8');
  const entries = (source) => {
    const match = source.match(/const USER_PATHS = \[([\s\S]*?)\];/);
    assert.ok(match, 'USER_PATHS declaration found');
    return [...match[1].matchAll(/^\s*'([^']+)'\s*,?\s*$/gm)].map((item) => item[1]);
  };
  const updatePaths = entries(updateText);
  const guardPaths = new Set(entries(guardText));
  for (const path of updatePaths) assert.ok(guardPaths.has(path), `guard is missing ${path}`);
});

test('importing the guard does not run CLI output or mutate process state', () => {
  const probe = `
    const before = process.exitCode;
    const guard = await import(${JSON.stringify(pathToFileURL(GUARD).href)});
    if (process.exitCode !== before || typeof guard.parseUnifiedDiff !== 'function') process.exitCode = 1;
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
