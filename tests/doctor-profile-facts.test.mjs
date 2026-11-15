import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');

test('doctor reports graduation-date mismatches as non-blocking JSON warnings', () => {
  const root = resolve(tmpdir(), `roleforge-doctor-profile-${process.pid}-${Date.now()}`);
  const run = () => spawnSync(process.execPath, [resolve(ROOT, 'doctor.mjs'), '--json', '--target', root], { encoding: 'utf8' });
  try {
    mkdirSync(resolve(root, 'config'), { recursive: true });
    mkdirSync(resolve(root, 'modes'), { recursive: true });
    writeFileSync(resolve(root, 'config/profile.yml'), 'education_details:\n  expected_graduation_date: 31/05/2027\n');
    writeFileSync(resolve(root, 'browser-extract.mjs'), '// fixture helper');
    writeFileSync(resolve(root, 'modes/_profile.md'), 'Profile note.\nExpected graduation: December 2026.\n');
    const mismatch = run();
    assert.equal(mismatch.status, 0, mismatch.stderr);
    assert.ok(JSON.parse(mismatch.stdout).warnings.some((warning) => (
      warning === 'Graduation date in modes/_profile.md line 2 (December 2026) differs from config/profile.yml (31/05/2027)'
    )));

    writeFileSync(resolve(root, 'modes/_profile.md'), 'Expected graduation: May 2027.\n');
    const matching = run();
    assert.equal(matching.status, 0, matching.stderr);
    assert.deepEqual(JSON.parse(matching.stdout).warnings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
