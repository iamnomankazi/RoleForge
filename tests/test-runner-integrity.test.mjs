import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDiscoveredTestSources,
  parseTapSummary,
  discoveredRunFailed,
} from '../test-runner-core.mjs';
import { run } from './helpers.mjs';

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

test('test helper requires executable-plus-argv commands and accepts git vectors', () => {
  assert.throws(() => run('git status --short'), /executable not in the test-helper allowlist/);
  assert.equal(typeof run('git', ['rev-parse', '--is-inside-work-tree']), 'string');
});
