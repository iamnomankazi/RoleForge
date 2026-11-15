import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationBatch } from '../application-batch.mjs';
import { loadIdentityMappings } from '../tracker-identity.mjs';
import { enrichRun, planEnrichment } from '../enrich-run.mjs';
import { writeImmutableScanRun } from '../scan-candidate-contract.mjs';

const CREATED_AT = '2026-11-15T10:00:00.000Z';
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

function fixture(rows = [{
  company: 'Example Oy', title: 'Synthetic Engineer', url: 'https://careers.example.test/jobs/one',
}]) {
  const root = mkdtempSync(join(tmpdir(), 'enrich-run-fixture-'));
  mkdirSync(join(root, 'liveness', 'descriptions'), { recursive: true });
  const source = writeImmutableScanRun({
    root,
    runId: 'source-run',
    createdAt: CREATED_AT,
    sourceArchitecture: 'standard_scan',
    inputs: [{ name: 'fixture.json', rows }],
  });
  const sourceRunDir = source.runDir;
  const sourceCandidates = JSON.parse(readFileSync(join(sourceRunDir, 'candidates.json'), 'utf8'));
  const livenessDir = join(root, 'liveness');
  const live = {};
  const putLive = (candidateId, {
    status = 'active', text = 'Verified synthetic description.', fileText = `${text}\n`,
    descriptionSha256 = hash(text), descriptionChars = text.length, reason = 'Synthetic liveness check',
  } = {}) => {
    live[candidateId] = {
      status, method: 'api', checked_at: '2026-11-14T12:00:00.000Z', final_url: null,
      description_chars: descriptionChars, description_sha256: descriptionSha256, reason,
    };
    writeFileSync(join(livenessDir, 'descriptions', `${candidateId}.txt`), fileText, 'utf8');
  };
  const writeLiveManifest = () => writeFileSync(join(livenessDir, 'liveness.json'), `${JSON.stringify(live, null, 2)}\n`);
  return {
    root, source, sourceRunDir, sourceCandidates, livenessDir, live, putLive, writeLiveManifest,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function enrich(f, outRunId, extras = {}) {
  return enrichRun({
    runDir: f.sourceRunDir,
    livenessDir: f.livenessDir,
    outRunId,
    root: f.root,
    createdAt: CREATED_AT,
    ...extras,
  });
}

function candidateAt(result, index = 0) {
  return result.candidates[index];
}

function treeHashes(dir) {
  const result = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    result[name] = hash(readFileSync(path));
  }
  return result;
}

test('fills only short descriptions from active hash-verified captures and preserves exact text', async () => {
  const f = fixture();
  try {
    const sourceId = f.sourceCandidates[0].candidate_id;
    const description = 'Single line with unicode — and punctuation.';
    f.putLive(sourceId, { text: description });
    f.writeLiveManifest();
    const result = await enrich(f, 'filled-run');
    assert.equal(candidateAt(result).description, description);
    assert.equal(result.enrichment[0].status, 'enriched');
    assert.ok(result.enrichment[0].changes.includes('description_filled'));
    assert.equal(result.enrichment[0].description_sha256, hash(description));
    assert.equal(result.enrichment[0].stored_description_sha256, undefined);
  } finally { f.cleanup(); }
});

test('contract whitespace changes are recorded with both description hashes', async () => {
  const f = fixture();
  try {
    const sourceId = f.sourceCandidates[0].candidate_id;
    const description = 'A   synthetic\nrole description.';
    f.putLive(sourceId, { text: description });
    f.writeLiveManifest();
    const result = await enrich(f, 'normalized-description');
    const stored = 'A synthetic role description.';
    assert.equal(candidateAt(result).description, stored);
    assert.equal(result.enrichment[0].description_sha256, hash(description));
    assert.equal(result.enrichment[0].stored_description_sha256, hash(stored));
  } finally { f.cleanup(); }
});

test('descriptions at least 120 characters are never replaced', async () => {
  const existing = 'x'.repeat(120);
  const f = fixture([{ company: 'Example Oy', title: 'Engineer', url: 'https://careers.example.test/jobs/one', description: existing }]);
  try {
    const sourceId = f.sourceCandidates[0].candidate_id;
    f.putLive(sourceId, { text: 'Captured description that should not replace the long stored one.' });
    f.writeLiveManifest();
    const result = await enrich(f, 'long-description');
    assert.equal(candidateAt(result).description, existing);
    assert.ok(!result.enrichment[0].changes.includes('description_filled'));
  } finally { f.cleanup(); }
});

const badDescriptionCases = [
  ['missing trailing newline', (text) => text, 'missing_trailing_newline'],
  ['two trailing newlines', (text) => `${text}\n\n`, 'description_sha256_mismatch'],
  ['CRLF terminator', (text) => `${text}\r\n`, 'description_sha256_mismatch'],
  ['wrong hash', (text) => `${text}\n`, 'description_sha256_mismatch', { descriptionSha256: 'wrong-hash' }],
  ['wrong character count', (text) => `${text}\n`, 'description_chars_mismatch', { descriptionChars: 999 }],
  ['non-active liveness status', (text) => `${text}\n`, 'liveness_status_expired', { status: 'expired' }],
];

for (const [label, fileText, expectedReason, overrides = {}] of badDescriptionCases) {
  test(`unverified description capture is not filled: ${label}`, async () => {
    const f = fixture();
    try {
      const sourceId = f.sourceCandidates[0].candidate_id;
      f.putLive(sourceId, { text: 'Do not store this unverified capture.', fileText: fileText('Do not store this unverified capture.'), ...overrides });
      f.writeLiveManifest();
      const result = await enrich(f, `unverified-${label.replace(/\W+/g, '-')}`);
      assert.equal(candidateAt(result).description, null);
      assert.equal(result.enrichment[0].status, 'description_unverified');
      assert.match(result.enrichment[0].reason, new RegExp(expectedReason));
    } finally { f.cleanup(); }
  });
}

test('missing liveness entry is mapped as no_liveness and candidate is otherwise carried over', async () => {
  const f = fixture();
  try {
    f.writeLiveManifest();
    const result = await enrich(f, 'no-liveness');
    assert.equal(result.enrichment[0].status, 'no_liveness');
    assert.deepEqual(result.enrichment[0].changes, []);
    assert.equal(candidateAt(result).liveness_status, f.sourceCandidates[0].liveness_status);
  } finally { f.cleanup(); }
});

test('copies liveness facts and updates company from a matching tracked-company tenant', async () => {
  const f = fixture([{ company: 'Old Display', title: 'Engineer', url: 'https://boards.greenhouse.io/example/jobs/123' }]);
  try {
    const sourceId = f.sourceCandidates[0].candidate_id;
    f.putLive(sourceId, { text: 'Verified short role description.' });
    f.writeLiveManifest();
    writeFileSync(join(f.root, 'portals.yml'), [
      'tracked_companies:', '  - name: New Display', '    provider: greenhouse', '    ats_tenant: example', '',
    ].join('\n'));
    const result = await enrich(f, 'portal-name');
    assert.equal(candidateAt(result).company, 'New Display');
    assert.equal(candidateAt(result).liveness_status, 'active');
    assert.equal(candidateAt(result).liveness_code, 'enrich:active');
    assert.equal(candidateAt(result).liveness_reason, 'Synthetic liveness check');
    assert.equal(result.enrichment[0].liveness_checked_at, '2026-11-14T12:00:00.000Z');
  } finally { f.cleanup(); }
});

test('apply_url override preserves listing URL, changes contract identity, and records the change', async () => {
  const f = fixture();
  try {
    f.writeLiveManifest();
    const source = f.sourceCandidates[0];
    const overrideUrl = 'https://boards.greenhouse.io/example/jobs/902';
    const result = await enrich(f, 'apply-override', {
      overrides: { [source.candidate_id]: { apply_url: overrideUrl, reason: 'Owner verified application endpoint' } },
    });
    const candidate = candidateAt(result);
    assert.equal(candidate.url, source.url);
    assert.equal(candidate.apply_url, overrideUrl);
    assert.notEqual(candidate.candidate_id, source.candidate_id);
    assert.ok(result.enrichment[0].changes.includes('candidate_id_changed'));
    assert.ok(result.enrichment[0].changes.includes('apply_url_override'));
    assert.equal(result.preview.id_changes.length, 1);
  } finally { f.cleanup(); }
});

test('apply_url must be https and identify a supported ATS', async () => {
  for (const [url, expression] of [
    ['http://boards.greenhouse.io/example/jobs/902', /must be an absolute https URL/],
    ['https://careers.example.test/apply', /must identify a supported ATS posting/],
  ]) {
    const f = fixture();
    try {
      f.writeLiveManifest();
      const sourceId = f.sourceCandidates[0].candidate_id;
      await assert.rejects(enrich(f, `bad-apply-${url.startsWith('http:') ? 'scheme' : 'ats'}`, {
        overrides: { [sourceId]: { apply_url: url, reason: 'Synthetic correction' } },
      }), expression);
      assert.equal(existsSync(join(f.root, 'output', 'scan-runs', `bad-apply-${url.startsWith('http:') ? 'scheme' : 'ats'}`)), false);
    } finally { f.cleanup(); }
  }
});

test('listing_url re-sourcing clears old aliases and liveness while preserving source provenance', async () => {
  const oldUrl = 'https://boards.greenhouse.io/example/jobs/100';
  const f = fixture([{
    company: 'Example Oy', title: 'Engineer', url: oldUrl, original_url: oldUrl,
    resolved_url: oldUrl, apply_url: oldUrl,
    url_aliases: [oldUrl, 'https://boards.greenhouse.io/example/jobs/100?source=alias'],
    ats_provider: 'greenhouse', ats_tenant: 'example', requisition_id: '100',
    source_url: 'https://board.example.test/listing/100', provenance: [{ input: 'synthetic-source', row: 1 }],
  }]);
  try {
    const source = f.sourceCandidates[0];
    f.putLive(source.candidate_id, { text: 'Old description should not be applied after re-sourcing.' });
    f.writeLiveManifest();
    const nextUrl = 'https://boards.greenhouse.io/example/jobs/200';
    const result = await enrich(f, 'resourced-run', {
      overrides: { [source.candidate_id]: { listing_url: nextUrl, reason: 'Owner found current posting' } },
    });
    const candidate = candidateAt(result);
    assert.equal(candidate.url, nextUrl);
    assert.equal(candidate.original_url, nextUrl);
    assert.equal(candidate.source_url, 'https://board.example.test/listing/100');
    assert.ok(!candidate.url_aliases.includes(oldUrl));
    assert.equal(candidate.liveness_status, 'unconfirmed');
    assert.match(candidate.liveness_reason, /re-sourced/i);
    assert.equal(candidate.description, source.description);
    assert.equal(result.enrichment[0].previous_listing_url, oldUrl);
    assert.equal(result.enrichment[0].previous_ats_identity.requisition_id, '100');
  } finally { f.cleanup(); }
});

test('re-sourcing to another Greenhouse requisition derives new identity without stale conflict', async () => {
  const oldUrl = 'https://boards.greenhouse.io/example/jobs/100';
  const f = fixture([{
    company: 'Example Oy', title: 'Engineer', url: oldUrl,
    ats_provider: 'greenhouse', ats_tenant: 'example', requisition_id: '100', provider: 'greenhouse',
  }]);
  try {
    f.writeLiveManifest();
    const source = f.sourceCandidates[0];
    const newUrl = 'https://boards.greenhouse.io/example/jobs/200';
    const result = await enrich(f, 'same-board-resourcing', {
      overrides: { [source.candidate_id]: { listing_url: newUrl, reason: 'New requisition confirmed' } },
    });
    assert.equal(candidateAt(result).ats_provider, 'greenhouse');
    assert.equal(candidateAt(result).ats_tenant, 'example');
    assert.equal(candidateAt(result).requisition_id, '200');
    assert.notEqual(candidateAt(result).candidate_id, source.candidate_id);
    assert.equal(result.enrichment[0].previous_ats_identity.requisition_id, '100');
  } finally { f.cleanup(); }
});

test('re-sourcing to an employer page drops all old ATS identity', async () => {
  const oldUrl = 'https://boards.greenhouse.io/example/jobs/100';
  const f = fixture([{
    company: 'Example Oy', title: 'Engineer', url: oldUrl,
    ats_provider: 'greenhouse', ats_tenant: 'example', requisition_id: '100', provider: 'greenhouse',
  }]);
  try {
    f.writeLiveManifest();
    const source = f.sourceCandidates[0];
    const newUrl = 'https://careers.example.test/roles/new-engineer';
    const result = await enrich(f, 'employer-page-resourcing', {
      overrides: { [source.candidate_id]: { listing_url: newUrl, reason: 'Employer careers page is current' } },
    });
    const candidate = candidateAt(result);
    assert.equal(candidate.ats_provider, null);
    assert.equal(candidate.ats_tenant, null);
    assert.equal(candidate.requisition_id, null);
    assert.notEqual(candidate.candidate_id, source.candidate_id);
    assert.equal(candidate.url, newUrl);
    assert.equal(result.enrichment[0].previous_ats_identity.requisition_id, '100');
  } finally { f.cleanup(); }
});

test('apply_url contradicting explicit ATS identity aborts before publication and names the source', async () => {
  const f = fixture([{
    company: 'Example Oy', title: 'Engineer', url: 'https://boards.greenhouse.io/example/jobs/100',
    ats_provider: 'greenhouse', ats_tenant: 'example', requisition_id: '100',
  }]);
  try {
    f.writeLiveManifest();
    const sourceId = f.sourceCandidates[0].candidate_id;
    await assert.rejects(enrich(f, 'contradictory-apply', {
      overrides: { [sourceId]: { apply_url: 'https://boards.greenhouse.io/example/jobs/200', reason: 'Synthetic conflicting endpoint' } },
    }), new RegExp(`Override for ${sourceId} conflicts`));
    assert.equal(existsSync(join(f.root, 'output', 'scan-runs', 'contradictory-apply')), false);
  } finally { f.cleanup(); }
});

test('two source candidates converging on one ATS identity are both marked converged', async () => {
  const f = fixture([
    { company: 'Example Oy', title: 'Engineer One', url: 'https://careers.example.test/jobs/one' },
    { company: 'Example Oy', title: 'Engineer Two', url: 'https://careers.example.test/jobs/two' },
  ]);
  try {
    f.writeLiveManifest();
    const convergingUrl = 'https://boards.greenhouse.io/example/jobs/999';
    const overrides = Object.fromEntries(f.sourceCandidates.map((candidate) => [candidate.candidate_id, {
      apply_url: convergingUrl, reason: 'Owner verified shared endpoint',
    }]));
    const result = await enrich(f, 'converged-run', { overrides });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.enrichment.length, 2);
    assert.ok(result.enrichment.every((entry) => entry.status === 'converged' && entry.converged === true));
    assert.equal(result.preview.convergences.length, 2);
    const mappings = loadIdentityMappings({
      scanRunsDir: join(f.root, 'output', 'scan-runs'),
      correctionsDir: join(f.root, 'output', 'identity-corrections'),
    });
    assert.equal(mappings.equivalent.size, 0);
  } finally { f.cleanup(); }
});

test('published enrichment is hash-bound, loaded by tracker identity, and consumed by application batches', async () => {
  const f = fixture();
  try {
    f.writeLiveManifest();
    const sourceId = f.sourceCandidates[0].candidate_id;
    const applyUrl = 'https://boards.greenhouse.io/example/jobs/902';
    const result = await enrich(f, 'published-enrichment', {
      overrides: { [sourceId]: { apply_url: applyUrl, reason: 'Owner verified application endpoint' } },
    });
    const content = readFileSync(join(result.runDir, 'enrichment.json'));
    const manifest = JSON.parse(readFileSync(join(result.runDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.artifact_authority, 'review_only');
    assert.equal(manifest.metadata.tool, 'enrich-run');
    assert.equal(manifest.metadata.enrichment_sha256, hash(content));
    const mappings = loadIdentityMappings({
      scanRunsDir: join(f.root, 'output', 'scan-runs'),
      correctionsDir: join(f.root, 'output', 'identity-corrections'),
    });
    assert.ok(mappings.equivalent.get(sourceId)?.has(candidateAt(result).candidate_id));
    assert.equal(mappings.discardedEdges.some((edge) => edge.source.endsWith('enrichment.json')), false);

    const batch = createApplicationBatch({
      root: f.root,
      sourceRunId: 'published-enrichment',
      batchId: 'synthetic-enrichment-batch',
      selectedCandidateIds: [candidateAt(result).candidate_id],
    });
    assert.equal(batch.manifest.candidates[0].listingUrl, candidateAt(result).url);
    assert.equal(batch.manifest.candidates[0].applyUrl, applyUrl);
  } finally { f.cleanup(); }
});

test('dry run reports fills, URL and ID changes without writing output', async () => {
  const f = fixture();
  try {
    const source = f.sourceCandidates[0];
    f.putLive(source.candidate_id, { text: 'A verified synthetic description.' });
    f.writeLiveManifest();
    const result = await enrich(f, 'preview-run', {
      dryRun: true,
      overrides: { [source.candidate_id]: { apply_url: 'https://boards.greenhouse.io/example/jobs/555', reason: 'Verified' } },
    });
    assert.equal(result.written, false);
    assert.equal(result.preview.description_fills.length, 1);
    assert.equal(result.preview.id_changes.length, 1);
    assert.equal(existsSync(join(f.root, 'output', 'scan-runs', 'preview-run')), false);
  } finally { f.cleanup(); }
});

test('invalid overrides and an existing output run fail without changing the source', async () => {
  const invalidCases = [
    [{ extra: 'x', reason: 'bad key' }, /Unknown override key/],
    [{ company: 'Display' }, /requires a non-empty reason/],
    [{ reason: 'unknown id' }, /unknown source candidate_id/],
    [{ apply_url: 'https://boards.greenhouse.io/example/jobs/1', listing_url: 'https://careers.example.test/new', reason: 'both' }, /cannot set both/],
  ];
  for (const [index, [override, expression]] of invalidCases.entries()) {
    const f = fixture();
    try {
      f.writeLiveManifest();
      const source = f.sourceCandidates[0];
      const before = treeHashes(f.sourceRunDir);
      const overrides = index === 2 ? { 'cand_v1_synthetic_unknown': override } : { [source.candidate_id]: override };
      await assert.rejects(enrich(f, `invalid-override-${index}`, { overrides }), expression);
      assert.deepEqual(treeHashes(f.sourceRunDir), before);
      assert.equal(existsSync(join(f.root, 'output', 'scan-runs', `invalid-override-${index}`)), false);
    } finally { f.cleanup(); }
  }

  const f = fixture();
  try {
    f.writeLiveManifest();
    mkdirSync(join(f.root, 'output', 'scan-runs', 'existing-run'), { recursive: true });
    await assert.rejects(enrich(f, 'existing-run'), /already exists/);
  } finally { f.cleanup(); }
});

test('leftover staging is reported and does not block publication; source bytes remain unchanged', async () => {
  const f = fixture();
  try {
    f.writeLiveManifest();
    const sourceBefore = treeHashes(f.sourceRunDir);
    const outputRoot = join(f.root, 'output', 'scan-runs');
    const leftover = join(outputRoot, '.rerun-id.orphan.staging');
    mkdirSync(leftover, { recursive: true });
    const result = await enrich(f, 'rerun-id');
    assert.ok(result.warnings.some((warning) => warning.includes(leftover)));
    assert.ok(existsSync(leftover));
    assert.ok(existsSync(result.runDir));
    assert.deepEqual(treeHashes(f.sourceRunDir), sourceBefore);
  } finally { f.cleanup(); }
});

test('source run requires both immutable input files', async () => {
  const f = fixture();
  try {
    f.writeLiveManifest();
    const broken = join(f.root, 'broken-source');
    mkdirSync(broken);
    writeFileSync(join(broken, 'manifest.json'), '{}\n');
    await assert.rejects(planEnrichment({
      runDir: broken, livenessDir: f.livenessDir, outRunId: 'broken-input', root: f.root,
    }), /manifest.json and candidates.json/);
  } finally { f.cleanup(); }
});
