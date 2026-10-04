import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { getBash, bashSource, run, lastRunFailure } from './helpers.mjs';

const SOURCES = ['posix', 'git-bash', 'wsl', 'path', 'unresolved'];

test('bash source is explicit and stable after discovery', () => {
  assert.equal(bashSource(), null);
  const first = getBash();
  assert.ok(SOURCES.includes(bashSource()), `unexpected source: ${bashSource()}`);
  assert.equal(getBash(), first);
});

test('literal Windows bash paths are existing Git Bash installations', () => {
  const bash = getBash();
  if (bash === 'bash') {
    assert.notEqual(bashSource(), 'git-bash');
    return;
  }
  assert.equal(bashSource(), 'git-bash');
  assert.ok(existsSync(bash), `getBash() returned a missing path: ${bash}`);
});

test('platform source classification is honest', () => {
  getBash();
  if (process.platform === 'win32') assert.notEqual(bashSource(), 'posix');
  else assert.equal(bashSource(), 'posix');
});

test('failed commands retain their actual exit diagnostics', () => {
  assert.equal(run(getBash(), ['-c', 'exit 7']), null);
  assert.equal(lastRunFailure()?.status, 7);
  assert.equal(run(getBash(), ['-c', 'echo ok']), 'ok');
  assert.equal(lastRunFailure(), null);
});
