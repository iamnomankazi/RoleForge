import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  validateDiscoveredTestSources,
  parseTapSummary,
  discoveredRunFailed,
  collectChildOutput,
} from '../test-runner-core.mjs';
import { run, ROOT } from './helpers.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('discovered source validation rejects child-terminating helpers', () => {
  const sources = new Map([
    ['exit.test.mjs', `process.${'exit'}(0)`],
    ['finish.test.mjs', `${'finish'}()`],
    ['safe.test.mjs', 'test("safe", () => assert.ok(true))'],
  ]);
  assert.deepEqual(validateDiscoveredTestSources([...sources.keys()], (file) => sources.get(file)), [
    { file: 'exit.test.mjs', mechanism: `process.${'exit'}()` },
    { file: 'finish.test.mjs', mechanism: `${'finish'}()` },
  ]);
});

test('complete successful TAP is accepted', () => {
  const tap = ['# tests 3', '# suites 0', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 1', '# todo 0'].join('\n');
  const parsed = parseTapSummary(tap, { files: 2, exitCode: 0 });
  assert.equal(parsed.complete, true);
  assert.equal(discoveredRunFailed(parsed), false);
});

test('missing verdict, failed child, and cancellation all fail closed', () => {
  const truncated = parseTapSummary('# tests 1\n# pass 1\n', { files: 1, exitCode: 0 });
  assert.equal(truncated.complete, false);
  assert.equal(discoveredRunFailed(truncated), true);

  const failedExit = parseTapSummary(
    ['# tests 1', '# pass 1', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'].join('\n'),
    { files: 1, exitCode: 7 },
  );
  assert.equal(discoveredRunFailed(failedExit), true);

  const cancelled = parseTapSummary(
    ['# tests 1', '# pass 0', '# fail 0', '# cancelled 1', '# skipped 0', '# todo 0'].join('\n'),
    { files: 1, exitCode: 0 },
  );
  assert.equal(discoveredRunFailed(cancelled), true);
});

test('runner waits for TAP bytes written during child stream shutdown', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/tap-shutdown-fixture.mjs', import.meta.url));
  const child = spawn(process.execPath, [fixture], { stdio: ['ignore', 'pipe', 'pipe'] });
  const result = await collectChildOutput(child);
  const parsed = parseTapSummary(result.stdout + result.stderr, { files: 1, exitCode: result.exitCode });
  assert.equal(parsed.complete, true);
  assert.equal(discoveredRunFailed(parsed), false);
});

test('a discovered legacy test that calls fail() exits nonzero', () => {
  const testsDir = dirname(fileURLToPath(import.meta.url));
  const tempDir = mkdtempSync(join(testsDir, 'legacy-discovered-failure-'));
  const fixture = join(tempDir, 'legacy-failure.test.mjs');
  const helperUrl = new URL('./helpers.mjs', import.meta.url).href;
  try {
    writeFileSync(fixture, `import { fail } from ${JSON.stringify(helperUrl)};\nfail('legacy fixture failure');\n`);
    const env = { ...process.env, CAREER_OPS_DISCOVERED_TEST_RUN: '1' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['test-all.mjs', '--only', basename(tempDir)], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 1, `${child.stdout}\n${child.stderr}`);
    assert.match(`${child.stdout}\n${child.stderr}`, /legacy fixture failure/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('test helper requires executable-plus-argv commands and accepts git vectors', () => {
  assert.throws(() => run('git status --short'), /executable not in the test-helper allowlist/);
  assert.equal(typeof run('git', ['rev-parse', '--is-inside-work-tree']), 'string');
});
