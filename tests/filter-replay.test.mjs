import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'filter-replay.mjs');

function readJsonLines(file) {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('filter replay reports exclusive stage counts and Finland recall examples', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'filter-replay-'));
  try {
    const input = path.join(temp, 'provider-rows.jsonl.gz');
    const portals = path.join(temp, 'portals.yml');
    const out = path.join(temp, 'out');
    const jobs = [
      { title: 'Software Engineer', company: 'Example One', url: 'https://jobs.example/1', location: 'Helsinki, Finland', country: 'US', description: 'Build services with Python.\nComfortable with services.' },
      { title: 'Data Analyst', company: 'Example Two', url: 'https://jobs.example/2', location: 'Finland', description: 'Build services with Python.' },
      { title: 'Software Engineer', company: 'Example Three', url: 'https://jobs.example/3', location: 'Manchester, United Kingdom', description: 'Build services with Python.' },
      { title: 'Software Engineer', company: 'Example Four', url: 'https://jobs.example/4', location: 'Finland', description: 'Build services with TypeScript.' },
      { title: 'Software Engineer', company: 'Example Five', url: 'https://jobs.example/5', location: 'Suomi', description: 'Build services with Python.' },
    ];
    const records = [
      { event: 'provider_fetch_error', provider: 'example' },
      { event: 'provider_rows', provider: 'example', entry_name: 'Example Co', entry_url: 'https://jobs.example', raw_jobs: jobs },
    ];
    const serialized = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
    const multiline = serialized.replace('Python.\\nComfortable', 'Python.\nComfortable');
    writeFileSync(input, gzipSync(multiline));
    writeFileSync(portals, [
      'title_filter:',
      '  positive: ["Software Engineer"]',
      '  negative: ["Senior"]',
      'location_filter:',
      '  allow: ["Finland", "Helsinki"]',
      'content_filter:',
      '  positive: ["python"]',
      '  negative: ["php"]',
      '',
    ].join('\n'));

    execFileSync(process.execPath, [SCRIPT, input, '--portals', portals, '--out', out], { cwd: ROOT });

    const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
    assert.deepEqual(summary.overall, {
      total: 5,
      title_rejected: 1,
      location_rejected: 2,
      content_rejected: 1,
      kept: 1,
    });
    assert.deepEqual(summary.by_provider.example, summary.overall);
    assert.deepEqual(summary.by_country.fi, {
      total: 4,
      title_rejected: 1,
      location_rejected: 1,
      content_rejected: 1,
      kept: 1,
    });
    assert.equal(summary.ignored_records, 1);
    assert.equal(summary.by_country_provider.fi.example.kept, 1);
    assert.equal(summary.by_country.gb.total, 1);
    assert.deepEqual(readJsonLines(path.join(out, 'kept.jsonl')).map(row => row.title), ['Software Engineer']);

    const rejected = readJsonLines(path.join(out, 'rejected-samples.jsonl'));
    assert.deepEqual(rejected.map(row => row.reason_code), [
      'title_rejected', 'location_rejected', 'content_rejected', 'location_rejected',
    ]);
    const finland = readJsonLines(path.join(out, 'finland-examples.jsonl'));
    assert.deepEqual(finland.map(row => row.title), jobs.filter(job => job.location !== 'Manchester, United Kingdom').map(job => job.title));
    assert.deepEqual(finland.map(row => row.stage), [
      'kept', 'title_rejected', 'content_rejected', 'location_rejected',
    ]);
    assert.deepEqual(readdirSync(out).sort(), [
      'finland-examples.jsonl', 'kept.jsonl', 'rejected-samples.jsonl', 'summary.json',
    ]);

    const limitedOut = path.join(temp, 'limited-out');
    execFileSync(process.execPath, [SCRIPT, input, '--portals', portals, '--country', 'FI', '--limit', '2', '--out', limitedOut], { cwd: ROOT });
    const limited = JSON.parse(readFileSync(path.join(limitedOut, 'summary.json'), 'utf8'));
    assert.deepEqual(limited.overall, {
      total: 2,
      title_rejected: 1,
      location_rejected: 0,
      content_rejected: 0,
      kept: 1,
    });
    assert.equal(limited.country_filter, 'fi');
    assert.equal(limited.limit, 2);
    assert.equal(limited.limit_reached, true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('filter replay supports help and rejects unknown flags', () => {
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node filter-replay\.mjs/);

  const unknown = spawnSync(process.execPath, [SCRIPT, 'input.jsonl.gz', '--wat'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown option: --wat/);
});
