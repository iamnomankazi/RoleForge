import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRITABLE_DIRS = ['data', 'batch', 'reports', 'output'];
const FLAGS = {
  'scan.mjs': ['--dry-run', '--company', '--since', '--run-id', '--verify', '--headed-fallback', '--throttle', '--rediscover-404'],
  'merge-tracker.mjs': ['--dry-run', '--verify', '--migrate', '--migrate-via'],
  'dedup-tracker.mjs': ['--dry-run'],
  'normalize-statuses.mjs': ['--dry-run'],
  'reserve-report-num.mjs': ['--count', '--release', '--gc'],
};

function sandbox() {
  // Keep the copy under tests/ so installed dependencies resolve from the repo.
  // Copy code only; every writable file below is a fictional fixture.
  const dir = mkdtempSync(join(ROOT, 'tests', '.operational-cli-'));
  for (const name of readdirSync(ROOT)) {
    if (name.endsWith('.mjs')) copyFileSync(join(ROOT, name), join(dir, name));
  }
  for (const name of ['lib', 'providers', 'plugins']) {
    cpSync(join(ROOT, name), join(dir, name), {
      recursive: true,
      filter: (file) => statSync(file).isDirectory() || file.endsWith('.mjs'),
    });
  }
  for (const name of WRITABLE_DIRS) mkdirSync(join(dir, name));
  mkdirSync(join(dir, 'batch', 'tracker-additions'));
  writeFileSync(join(dir, 'data', 'applications.md'), '# Alex Example applications\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-01-01 | Example Co | Engineer | 4/5 | Evaluada | | | Fictional fixture |\n');
  writeFileSync(join(dir, 'data', 'pipeline.md'), '# Fictional pipeline\n');
  writeFileSync(join(dir, 'batch', 'tracker-additions', 'example.tsv'), '2\t2026-01-02\tExample Labs\tEngineer\tEvaluated\t4/5\t\t\tFictional fixture\n');
  writeFileSync(join(dir, 'reports', '040-RESERVED.md'), '');
  const stale = new Date(Date.now() - 24 * 60 * 60 * 1000);
  utimesSync(join(dir, 'reports', '040-RESERVED.md'), stale, stale);
  writeFileSync(join(dir, 'output', 'example.txt'), 'Alex Example\n');
  return dir;
}

function snapshot(dir) {
  const entries = {};
  function visit(file) {
    const key = relative(dir, file);
    if (!existsSync(file)) {
      entries[key] = null;
      return;
    }
    const stat = statSync(file);
    entries[key] = { mtime: stat.mtimeMs, content: stat.isDirectory() ? null : readFileSync(file).toString('base64') };
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(join(file, name));
    }
  }
  for (const name of WRITABLE_DIRS) visit(join(dir, name));
  return entries;
}

function run(dir, script, args) {
  return spawnSync(process.execPath, [join(dir, script), ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      CAREER_OPS_TRACKER: join(dir, 'data', 'applications.md'),
      CAREER_OPS_ADDITIONS: join(dir, 'batch', 'tracker-additions'),
      CAREER_OPS_REPORTS_DIR: join(dir, 'reports'),
      CAREER_OPS_TRACKER_LOCK: join(dir, 'data', 'tracker.lock'),
      CAREER_OPS_SCAN_ROOT: dir,
      CAREER_OPS_PORTALS: join(dir, 'missing-portals.yml'),
      CAREER_OPS_PROFILE: join(dir, 'missing-profile.yml'),
      CAREER_OPS_PROVIDERS_DIR: join(dir, 'missing-providers'),
    },
  });
}

test('operational help and unknown flags exit before imports or data access', async (t) => {
  const dir = sandbox();
  try {
    // tracker-aliases.json is deliberately absent: loading tracker-parse would
    // fail, proving that the argument check precedes its module-scope read.
    for (const populated of [true, false]) {
      if (!populated) {
        for (const name of WRITABLE_DIRS) rmSync(join(dir, name), { recursive: true });
      }
      for (const [script, flags] of Object.entries(FLAGS)) {
        await t.test(`${script}: ${populated ? 'existing' : 'missing'} writable directories`, () => {
          const before = snapshot(dir);
          const help = run(dir, script, ['--help']);
          assert.ifError(help.error);
          assert.equal(help.status, 0, help.stderr);
          assert.match(help.stdout, new RegExp(`Usage: node ${script.replace('.', '\\.')}`));
          for (const flag of [...flags, '--help']) assert.ok(help.stdout.includes(flag), `Missing ${flag}`);
          assert.equal(help.stderr, '');
          assert.deepEqual(snapshot(dir), before);

          for (const unknown of ['--bogus', '--bogus=value', '-z']) {
            for (const args of [[unknown], ['--help', unknown], [flags[0], unknown]]) {
              const result = run(dir, script, args);
              assert.ifError(result.error);
              assert.notEqual(result.status, 0);
              assert.ok(result.stderr.includes(`Unknown flag: ${unknown}`), result.stderr);
              assert.deepEqual(snapshot(dir), before);
            }
          }
        });
      }
    }

    await t.test('existing flag forms remain accepted with help', () => {
      for (const args of [
        ['--company', 'Example Co', '--since', '7', '--run-id', 'example-run', '--verify', '--headed-fallback', '--throttle', '--rediscover-404'],
        ['--since=2.5', '--throttle=8000', '--dry-run'],
      ]) {
        const result = run(dir, 'scan.mjs', [...args, '--help']);
        assert.equal(result.status, 0, result.stderr);
      }
      for (const args of [['--count', '8'], ['--release', '042-049'], ['--release', '035'], ['--gc']]) {
        const result = run(dir, 'reserve-report-num.mjs', [...args, '--help']);
        assert.equal(result.status, 0, result.stderr);
      }
      const merge = run(dir, 'merge-tracker.mjs', ['--dry-run', '--verify', '--migrate', '--migrate-via', '--help']);
      assert.equal(merge.status, 0, merge.stderr);
      assert.deepEqual(snapshot(dir), Object.fromEntries(WRITABLE_DIRS.map((name) => [name, null])));
    });

    await t.test('report reservation, range release, and GC still execute', () => {
      const reserve = run(dir, 'reserve-report-num.mjs', ['--count', '8']);
      assert.equal(reserve.status, 0, reserve.stderr);
      assert.equal(reserve.stdout.trim(), '001-008');
      assert.equal(readdirSync(join(dir, 'reports')).length, 8);
      const release = run(dir, 'reserve-report-num.mjs', ['--release', '001-008']);
      assert.equal(release.status, 0, release.stderr);
      assert.deepEqual(readdirSync(join(dir, 'reports')), []);
      assert.equal(run(dir, 'reserve-report-num.mjs', []).stdout.trim(), '001');
      assert.equal(run(dir, 'reserve-report-num.mjs', ['--release', '001']).status, 0);
      assert.equal(run(dir, 'reserve-report-num.mjs', ['--gc']).status, 0);
    });
  } finally {
    assert.ok(relative(join(ROOT, 'tests'), dir).startsWith('.operational-cli-'));
    rmSync(dir, { recursive: true, force: true });
  }
});
