import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const scanMode = readFileSync(join(ROOT, 'modes', 'scan.md'), 'utf8');
const scripts = readFileSync(join(ROOT, 'docs', 'SCRIPTS.md'), 'utf8');

test('browser extraction modes use local CLI by default and fail closed without connected MCP', () => {
  for (const relative of ['modes/scan.md', 'modes/pipeline.md', 'modes/auto-pipeline.md', 'modes/oferta.md']) {
    const source = readFileSync(join(ROOT, relative), 'utf8');
    assert.match(source, /browser-extract\.mjs/);
    assert.match(source, /default/i);
    assert.match(source, /scan\.extractor: mcp/);
    assert.match(source, /(?:only if connected|only to connected MCP|MCP only if connected)/i);
    assert.match(source, /liveness unconfirmed/i);
    assert.match(source, /WebFetch\/search/);
    assert.doesNotMatch(source, /fall back silently/i);
  }
});

test('scan mode keeps transient and access failures uncertain rather than expired', () => {
  for (const phrase of ['timeout', 'DNS/TLS', 'generic WAF', 'HTTP 429', 'HTTP 5xx', 'skipped_expired']) {
    assert.match(scanMode, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), phrase);
  }
  assert.match(scanMode, /never convert this case to permanent `skipped_expired`/i);
  assert.match(scanMode, /Only the executable liveness model's definitive closure signals authorize `skipped_expired`/i);
});

test('scan mode defines one final review authority for viable and zero-addition handoffs', () => {
  for (const phrase of [
    'output/scan-shards/<structured-run-id>/agent-handoff.json',
    'company',
    'title',
    'valid absolute HTTP(S) listing `url`',
    'agent-handoff.json',
    'byte-for-byte',
    'new consolidated immutable run',
    'add zero viable candidates',
    'do not clone the structured run',
    'candidate IDs',
    'artifact_authority: review_only',
    'explicit application batch',
  ]) {
    assert.match(scanMode, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), phrase);
  }
  assert.match(scanMode, /node merge-scan-results\.mjs/i);
});

test('specialized discovery entrypoints are documented as non-authoritative', () => {
  assert.match(scripts, /`or:scan` and `scan:full` are specialized discovery entrypoints/i);
  assert.match(scripts, /does not imply full standard complete-scan policy parity/i);
  assert.match(scripts, /final-review-authority handoff workflow/i);
});
