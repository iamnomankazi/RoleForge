import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRIVATE_FORK_UPDATE_POLICY,
  assertAutomaticUpstreamApplyAllowed,
} from '../update-system.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fingerprint(path) {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return { bytes: readFileSync(path), mtimeMs: stat.mtimeMs };
}

test('private fork update policy is explicit and fail-closed', () => {
  assert.equal(Object.isFrozen(PRIVATE_FORK_UPDATE_POLICY), true);
  assert.deepEqual(PRIVATE_FORK_UPDATE_POLICY, {
    customizedPrivateFork: true,
    automaticUpstreamApply: false,
    remediation: 'selective reviewed backports',
  });
  assert.throws(
    () => assertAutomaticUpstreamApplyAllowed(),
    /customized private fork.*automatic upstream application is disabled.*selective reviewed backports/is,
  );
});

test('apply CLI refuses before updater side effects', () => {
  const lockPath = join(ROOT, '.update-lock');
  const before = fingerprint(lockPath);
  const result = spawnSync(process.execPath, ['update-system.mjs', 'apply'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;

  assert.equal(result.status, 1);
  assert.match(output, /customized private fork/i);
  assert.match(output, /automatic upstream application is disabled/i);
  assert.match(output, /selective reviewed backports/i);
  assert.doesNotMatch(output, /backup branch created|fetching latest from upstream/i);

  const after = fingerprint(lockPath);
  assert.equal(after?.mtimeMs ?? null, before?.mtimeMs ?? null);
  assert.deepEqual(after?.bytes ?? null, before?.bytes ?? null);
});
