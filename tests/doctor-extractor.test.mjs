import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');

test('doctor warns about MCP only when explicitly active and reports missing CLI helpers', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'roleforge-doctor-extractor-'));
  const run = () => {
    const result = spawnSync(process.execPath, [resolve(ROOT, 'doctor.mjs'), '--json', '--target', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    mkdirSync(resolve(root, 'config'));
    writeFileSync(resolve(root, 'browser-extract.mjs'), '// fixture helper');
    assert.equal(run().extractor, 'cli');
    assert.deepEqual(run().warnings, []);
    writeFileSync(resolve(root, 'config/profile.yml'), 'scan:\n  extractor: cli\n');
    assert.deepEqual(run().warnings, []);
    writeFileSync(resolve(root, 'config/profile.yml'), 'scan:\n  extractor: mcp\n');
    assert.deepEqual(run().warnings, ['Playwright MCP tools not detected']);
    writeFileSync(resolve(root, '.mcp.json'), JSON.stringify({ mcpServers: { browser: { command: 'playwright' } } }));
    assert.deepEqual(run().warnings, []);
    writeFileSync(resolve(root, 'config/profile.yml'), 'scan:\n  extractor: invalid\n');
    assert.equal(run().extractor, 'cli');
    rmSync(resolve(root, 'browser-extract.mjs'));
    assert.match(run().warnings.join('\n'), /cli helper missing/);
    assert.doesNotMatch(run().warnings.join('\n'), /MCP tools not detected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
