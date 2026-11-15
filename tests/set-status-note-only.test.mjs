import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function fixture(t, status = 'Applied', reportNumber = 1) {
  const dir = mkdtempSync(join(ROOT, '.outcomes-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tracker = join(dir, 'applications.md');
  const content = [
    '# Synthetic applications', '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    `| 1 | 2026-11-01 | Example Oy | Engineer | 4/5 | ${status} | — | [${reportNumber}](reports/${String(reportNumber).padStart(3, '0')}-example.md) | Existing note |`,
    '',
  ].join('\n');
  writeFileSync(tracker, content);
  return {
    content,
    read: () => readFileSync(tracker, 'utf8'),
    run: (...args) => spawnSync(process.execPath, [join(ROOT, 'set-status.mjs'), ...args, '--json'], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, CAREER_OPS_TRACKER: tracker, TEMP: dir, TMP: dir },
    }),
  };
}

test('Applied --note on an already Applied row still requires submission confirmation', (t) => {
  const f = fixture(t);
  const result = f.run('--row', '1', 'Applied', '--note', 'No reply as of 2026-11-15');
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, 'applied-confirmation-required');
  assert.equal(f.read(), f.content);
});

for (const status of ['Responded', 'Interview', 'Offer', 'Rejected']) {
  test(`Applied can still transition to ${status} with an outcome note`, (t) => {
    const f = fixture(t);
    const result = f.run('--row', '1', status, '--note', 'Owner confirmed outcome');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).newStatus, status);
    assert.ok(f.read().includes(`| ${status} |`));
    assert.ok(f.read().includes('Existing note; Owner confirmed outcome'));
  });
}

test('note-only appends to Applied, preserves status and other cells, and is idempotent', (t) => {
  const f = fixture(t);
  const note = 'No reply as of 2026-11-15; owner confirmed';
  const args = ['--row', '1', '--note-only', '--note', note];
  const result = f.run(...args);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.oldStatus, 'Applied');
  assert.equal(json.newStatus, 'Applied');
  assert.equal(json.changed, true);
  assert.ok(!('followupSeedCandidate' in json));
  assert.ok(!result.stderr.includes('follow-up'));
  assert.equal(f.read(), f.content.replace('Existing note', `Existing note; ${note}`));
  const again = f.run(...args);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).changed, false);
  assert.equal(f.read(), f.content.replace('Existing note', `Existing note; ${note}`));
});

for (const status of ['Evaluated', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP', 'Custom legacy state']) {
  test(`note-only preserves ${status}`, (t) => {
    const f = fixture(t, status);
    const result = f.run('--row', '1', '--note-only', '--note', 'Owner supplied note');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).newStatus, status);
    assert.equal(f.read(), f.content.replace('Existing note', 'Existing note; Owner supplied note'));
  });
}

test('note-only dry-run previews without writing or emitting an Applied hint', (t) => {
  const f = fixture(t);
  const result = f.run('--row', '1', '--note-only', '--note', 'No reply as of 2026-11-15', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.dryRun, true);
  assert.equal(json.changed, true);
  assert.equal(json.newStatus, 'Applied');
  assert.ok(!('followupSeedCandidate' in json));
  assert.equal(f.read(), f.content);
});

for (const args of [
  ['--row', '1', 'Rejected', '--note-only', '--note', 'Owner note'],
  ['--row', '1', 'Applied', '--note-only', '--note', 'Owner note'],
  ['--row', '1', '--note-only'],
  ['--row', '1', '--note-only', '--note', '   '],
  ['Example Oy', '--note-only', '--note', 'Owner note'],
  ['Example Oy', '--role', 'Engineer', '--note-only', '--note', 'Owner note'],
  ['--row', '1', '--report', '1', '--note-only', '--note', 'Owner note'],
]) {
  test(`note-only rejects invalid invocation: ${JSON.stringify(args)}`, (t) => {
    const f = fixture(t);
    const result = f.run(...args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'usage');
    assert.equal(f.read(), f.content);
  });
}

for (const selector of [['1'], ['--report', '1']]) {
  test(`note-only accepts exact selector ${selector.join(' ')}`, (t) => {
    const f = fixture(t);
    const result = f.run(...selector, '--note-only', '--note', 'Owner note');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).newStatus, 'Applied');
    assert.ok(f.read().includes('Existing note; Owner note'));
  });
}

test('note-only keeps the bare numeric report mismatch guard', (t) => {
  const f = fixture(t, 'Applied', 12);
  const result = f.run('1', '--note-only', '--note', 'Owner note');
  assert.equal(result.status, 3);
  assert.equal(JSON.parse(result.stdout).code, 'report-number-mismatch');
  assert.equal(f.read(), f.content);
  const explicit = f.run('--report', '12', '--note-only', '--note', 'Owner note');
  assert.equal(explicit.status, 0, explicit.stderr);
});
