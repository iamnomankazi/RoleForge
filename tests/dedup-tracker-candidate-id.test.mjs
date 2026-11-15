import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = fileURLToPath(new URL('../dedup-tracker.mjs', import.meta.url));
const HEADER = [
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
].join('\n');

function fixture(rows) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-dedup-candidate-id-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const trackerPath = join(dataDir, 'applications.md');
  writeFileSync(trackerPath, `${HEADER}\n${rows.join('\n')}\n`);
  return {
    root,
    trackerPath,
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function trackerRow({ num, company = 'Example Oy', role, score = '4/5', status = 'Evaluated', report = '-', notes = '' }) {
  return `| ${num} | 2026-10-01 | ${company} | ${role} | ${score} | ${status} | - | ${report} | ${notes} |`;
}

function id(letter) {
  return `cand_v1_${letter.repeat(64)}`;
}

function run(fx, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: fx.root,
    encoding: 'utf8',
    env: { ...process.env, CAREER_OPS_TRACKER: fx.trackerPath },
  });
}

test('candidate-ID dry run lists the exact keeper and removed row and writes nothing', () => {
  const candidate = id('a');
  const fx = fixture([
    trackerRow({ num: 7, role: 'Senior Fictional Engineer', score: '4/5', status: 'Applied', report: '[7](../reports/007-example.md)', notes: `Canonical candidate ID: ${candidate}; keeper note` }),
    trackerRow({ num: 9, role: 'Platform Fictional Engineer', score: '3/5', status: 'Evaluated', report: '[9](../reports/009-example.md)', notes: `Canonical candidate ID: ${candidate}; removed note` }),
  ]);
  try {
    const before = readFileSync(fx.trackerPath, 'utf8');
    const result = run(fx, ['--by-candidate-id', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Merge group \(cand_v1_a{64}\)/);
    assert.match(result.stdout, /Keep #7 \| Example Oy \| Senior Fictional Engineer \| Applied \| \[7\]\(\.\.\/reports\/007-example\.md\)/);
    assert.match(result.stdout, /Remove #9 \| Example Oy \| Platform Fictional Engineer \| Evaluated \| \[9\]\(\.\.\/reports\/009-example\.md\)/);
    assert.equal((result.stdout.match(/Remove #9/g) ?? []).length, 1);
    assert.match(result.stdout, /Report links from removed rows are stored in Notes/);
    assert.match(result.stdout, /dry-run - no changes written/);
    assert.equal(readFileSync(fx.trackerPath, 'utf8'), before);
    assert.equal(existsSync(`${fx.trackerPath}.bak`), false);
  } finally {
    fx.cleanup();
  }
});

test('candidate-ID merge keeps the display-status row and preserves removed notes and report links', () => {
  const candidate = id('b');
  const fx = fixture([
    trackerRow({ num: 12, role: 'Original Fictional Role', score: '2/5', status: 'Evaluated', report: '[12](../reports/012-example.md)', notes: `Canonical candidate ID: ${candidate}; original note` }),
    trackerRow({ num: 15, role: 'Renamed Fictional Role', score: '4/5', status: 'Applied', report: '[15](../reports/015-example.md)', notes: `Canonical candidate ID: ${candidate}; submission note` }),
  ]);
  try {
    const original = readFileSync(fx.trackerPath, 'utf8');
    const result = run(fx, ['--by-candidate-id']);
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(fx.trackerPath, 'utf8');
    assert.ok(existsSync(`${fx.trackerPath}.bak`));
    assert.equal(content.includes('| 12 |'), false);
    assert.match(content, /^\| 15 \| 2026-10-01 \| Example Oy \| Renamed Fictional Role \| 4\/5 \| Applied \| - \| \[15\]\(\.\.\/reports\/015-example\.md\) \|/m);
    assert.match(content, /original note/);
    assert.match(content, /submission note/);
    assert.match(content, /Merged #12 \[12\]\(\.\.\/reports\/012-example\.md\)/);
    assert.equal(readFileSync(`${fx.trackerPath}.bak`, 'utf8'), original);
    assert.doesNotMatch(content, /\| 12 \|/);
  } finally {
    fx.cleanup();
  }
});

test('mixed-status candidate groups are reported as skipped and left unchanged', () => {
  const candidate = id('c');
  const fx = fixture([
    trackerRow({ num: 20, role: 'First Fictional Role', status: 'Applied', notes: `Canonical candidate ID: ${candidate}` }),
    trackerRow({ num: 21, role: 'Second Fictional Role', status: 'Rejected', notes: `Canonical candidate ID: ${candidate}` }),
  ]);
  try {
    const before = readFileSync(fx.trackerPath, 'utf8');
    const result = run(fx, ['--by-candidate-id', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Skipped #20, #21: mixed_status/);
    assert.equal(readFileSync(fx.trackerPath, 'utf8'), before);
  } finally {
    fx.cleanup();
  }
});

test('conflict and unknown-status candidate groups are also skipped', () => {
  const conflictingId = id('e');
  const unknownId = id('f');
  const fx = fixture([
    trackerRow({ num: 22, company: 'Example Oy', role: 'First Fictional Role', status: 'Applied', notes: `Canonical candidate ID: ${conflictingId}` }),
    trackerRow({ num: 23, company: 'Acme GmbH', role: 'Second Fictional Role', status: 'Applied', notes: `Canonical candidate ID: ${conflictingId}` }),
    trackerRow({ num: 24, company: 'Example Oy', role: 'Third Fictional Role', status: 'Mystery State', notes: `Canonical candidate ID: ${unknownId}` }),
    trackerRow({ num: 25, company: 'Example Oy', role: 'Fourth Fictional Role', status: 'Evaluated', notes: `Canonical candidate ID: ${unknownId}` }),
  ]);
  try {
    const before = readFileSync(fx.trackerPath, 'utf8');
    const result = run(fx, ['--by-candidate-id', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Skipped #22, #23: conflict/);
    assert.match(result.stdout, /Skipped #24, #25: unknown_status/);
    assert.equal(readFileSync(fx.trackerPath, 'utf8'), before);
  } finally {
    fx.cleanup();
  }
});

test('follow-up table rows and pins referencing a removed row abort even in dry run', () => {
  const candidate = id('d');
  const fx = fixture([
    trackerRow({ num: 30, role: 'Original Fictional Role', status: 'Applied', notes: `Canonical candidate ID: ${candidate}` }),
    trackerRow({ num: 31, role: 'Updated Fictional Role', status: 'Evaluated', notes: `Canonical candidate ID: ${candidate}` }),
  ]);
  try {
    const followups = join(dirname(fx.trackerPath), 'follow-ups.md');
    writeFileSync(followups, [
      '| num | appNum | date | company | role | channel | contact | notes |',
      '|---|---|---|---|---|---|---|---|',
      '| 1 | 31 | 2026-10-02 | Example Oy | Updated Fictional Role | email | - | logged follow-up |',
      '- next #31 2026-10-10 (set 2026-10-02)',
    ].join('\n'));
    const before = readFileSync(fx.trackerPath, 'utf8');
    const result = run(fx, ['--by-candidate-id', '--dry-run']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Follow-up entries reference rows selected for removal/);
    assert.match(result.stderr, /app #31.*\| 1 \| 31 \|/);
    assert.match(result.stderr, /app #31.*next #31/);
    assert.match(result.stderr, /Aborting without writing/);
    assert.equal(readFileSync(fx.trackerPath, 'utf8'), before);
    assert.equal(existsSync(`${fx.trackerPath}.bak`), false);
  } finally {
    fx.cleanup();
  }
});

test('without --by-candidate-id, legacy output and tracker result stay unchanged', () => {
  const fx = fixture([
    trackerRow({ num: 1, role: 'Backend Engineer', score: '4/5', notes: 'kept note' }),
    trackerRow({ num: 2, role: 'Backend Engineer', score: '3/5', notes: 'removed note' }),
  ]);
  try {
    const original = readFileSync(fx.trackerPath, 'utf8');
    const result = run(fx);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout,
      '📊 2 entries loaded\n'
      + '🗑️  Remove #2 (Example Oy — Backend Engineer, 3/5) → kept #1 (4/5)\n'
      + '\n📊 1 duplicates removed\n'
      + '✅ Written to applications.md (backup: applications.md.bak)\n');
    assert.equal(readFileSync(fx.trackerPath, 'utf8'), [
      HEADER,
      '| 1 | 2026-10-01 | Example Oy | Backend Engineer | 4/5 | Evaluated | — | — | kept note; removed note |',
      '',
    ].join('\n'));
    assert.equal(readFileSync(`${fx.trackerPath}.bak`, 'utf8'), original);
  } finally {
    fx.cleanup();
  }
});

test('text-only lookalike rows remain untouched in candidate-ID mode', () => {
  const fx = fixture([
    trackerRow({ num: 40, role: 'Data Analyst' }),
    trackerRow({ num: 41, role: 'Data Analyst' }),
  ]);
  try {
    const before = readFileSync(fx.trackerPath, 'utf8');
    const result = run(fx, ['--by-candidate-id', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No candidate-ID duplicate groups found/);
    assert.equal(readFileSync(fx.trackerPath, 'utf8'), before);
  } finally {
    fx.cleanup();
  }
});
