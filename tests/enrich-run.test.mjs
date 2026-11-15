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

function convergenceFixture(urlOnlyFirst) {
  const f = fixture([
    { company: 'Example Oy', title: 'URL-only Engineer', url: 'https://careers.example.test/roles/other' },
    {
      company: 'Acme GmbH', title: 'ATS Engineer', url: 'https://careers.example.test/roles/shared',
      ats_provider: 'greenhouse', ats_tenant: 'example', requisition_id: '999',
    },
  ]);
  f.sourceCandidates.sort((left, right) => urlOnlyFirst
    ? Number(Boolean(left.ats_provider)) - Number(Boolean(right.ats_provider))
    : Number(Boolean(right.ats_provider)) - Number(Boolean(left.ats_provider)));
  writeFileSync(join(f.sourceRunDir, 'candidates.json'), `${JSON.stringify(f.sourceCandidates, null, 2)}\n`);
  return f;
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

test('apply_url rejects lookalike hosts and gh_jid outside Greenhouse without writing', async () => {
  const urls = [
    'https://fake.personio.example.test/job/123',
    'https://ordinary.example.test/unrelated?gh_jid=123',
    'https://jobs.lever.co/example/123?gh_jid=123',
    'https://boards-api.greenhouse.io/v1/boards/example/jobs/123',
    'https://support.greenhouse.io/example/jobs/123',
    'https://greenhouse.io/example/jobs/123',
    'https://api.personio.de/job/123',
    'https://fakepersonio.com/job/123',
    'https://personio.com/job/123',
    'https://personio.de/job/123',
    ...[
      ['boards.greenhouse.io', '/example/jobs/123'],
      ['jobs.lever.co', '/example/123'],
      ['jobs.ashbyhq.com', '/example/123'],
      ['example.myworkdayjobs.com', '/External/job/Example/Engineer_REQ123'],
      ['jobs.smartrecruiters.com', '/Example/123'],
      ['example.personio.de', '/job/123'],
      ['example.personio.com', '/job/123'],
      ['apply.workable.com', '/example/j/123'],
    ].map(([host, path]) => `https://${host}.example.test${path}`),
  ];
  const f = fixture();
  try {
    f.writeLiveManifest();
    const before = treeHashes(f.sourceRunDir);
    for (const [index, url] of urls.entries()) {
      const outRunId = `unsupported-host-${index}`;
      await assert.rejects(enrich(f, outRunId, {
        overrides: { [f.sourceCandidates[0].candidate_id]: { apply_url: url, reason: 'Synthetic endpoint check' } },
      }), /must identify a supported ATS posting/, url);
      assert.equal(existsSync(join(f.root, 'output', 'scan-runs', outRunId)), false);
    }
    assert.deepEqual(treeHashes(f.sourceRunDir), before);
    assert.deepEqual(readdirSync(join(f.root, 'output', 'scan-runs')), ['source-run']);
  } finally { f.cleanup(); }
});

test('apply_url accepts the supported ATS posting hosts', async () => {
  const urls = [
    'https://boards.greenhouse.io/example/jobs/123',
    'https://job-boards.greenhouse.io/example/jobs/123',
    'https://job-boards.eu.greenhouse.io/example/jobs/123',
    'https://boards.greenhouse.io/embed/job_app?gh_jid=123',
    'https://jobs.lever.co/example/123',
    'https://jobs.eu.lever.co/example/123/application',
    'https://jobs.ashbyhq.com/example/123',
    'https://example.wd3.myworkdayjobs.com/External/job/Example/Engineer_REQ123',
    'https://jobs.smartrecruiters.com/Example/123',
    'https://example.jobs.personio.de/job/123',
    'https://example.jobs.personio.com/job/123',
    'https://apply.workable.com/example/j/123',
  ];
  const f = fixture();
  try {
    f.writeLiveManifest();
    for (const [index, url] of urls.entries()) {
      const result = await enrich(f, `supported-host-${index}`, {
        overrides: { [f.sourceCandidates[0].candidate_id]: { apply_url: url, reason: 'Synthetic endpoint check' } },
      });
      assert.equal(candidateAt(result).apply_url, url);
    }
  } finally { f.cleanup(); }
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
    assert.deepEqual(candidate.provenance.filter((entry) => entry.input === 'synthetic-source'), [{ input: 'synthetic-source', row: 1 }]);
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
    // No prior source_url: the previous listing becomes the attribution.
    assert.equal(candidateAt(result).source_url, oldUrl);
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

test('re-sourcing clears every contract and identity URL input independently', async () => {
  const oldUrl = 'https://boards.greenhouse.io/example/jobs/100';
  const urlFields = [
    'url', 'original_url', 'originalUrl', 'listing_url', 'listingUrl', 'job_url', 'jobUrl',
    'resolved_url', 'resolvedUrl', 'final_url', 'finalUrl', 'apply_url', 'applyUrl',
    'canonical_url', 'canonicalUrl', 'url_aliases', 'urlAliases',
  ];
  for (const [index, field] of urlFields.entries()) {
    const f = fixture([{ company: 'Example Oy', title: 'Engineer', url: 'https://careers.example.test/roles/source' }]);
    try {
      const source = f.sourceCandidates[0];
      const sourcePath = join(f.sourceRunDir, 'candidates.json');
      const rows = JSON.parse(readFileSync(sourcePath, 'utf8'));
      rows[0][field] = field === 'url_aliases' || field === 'urlAliases' ? [oldUrl] : oldUrl;
      writeFileSync(sourcePath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
      f.writeLiveManifest();
      const nextUrl = 'https://careers.example.test/roles/current';
      const result = await enrich(f, `url-resourced-${index}`, {
        overrides: { [source.candidate_id]: { listing_url: nextUrl, reason: 'Owner confirmed current listing' } },
      });
      const candidate = candidateAt(result);
      assert.equal(candidate.url, nextUrl, field);
      assert.equal(candidate.ats_provider, null, field);
      assert.equal(candidate.ats_tenant, null, field);
      assert.equal(candidate.requisition_id, null, field);
      assert.equal(candidate.provider, candidate.source, field); // no ATS identity: provider falls back to discovery attribution
      assert.ok(!candidate.url_aliases.some((url) => url.includes('boards.greenhouse.io')), field);
      assert.equal(result.enrichment[0].previous_urls[field] != null, true, field);
    } finally { f.cleanup(); }
  }
});

test('re-sourcing clears every explicit identity source, including source as a provider fallback', async () => {
  const identityCases = [
    ['ats_provider', 'greenhouse'], ['atsProvider', 'greenhouse'],
    ['ats_tenant', 'example'], ['atsTenant', 'example'], ['tenant', 'example'],
    ['boardToken', 'example'], ['board_token', 'example'],
    ['companyIdentifier', 'example'], ['company_identifier', 'example'],
    ['companySlug', 'example'], ['company_slug', 'example'],
    ['requisition_id', '100'], ['requisitionId', '100'], ['jobId', '100'], ['job_id', '100'],
    ['requisition', '100'], ['provider', 'greenhouse'], ['source', 'greenhouse'],
  ];
  for (const [index, [field, value]] of identityCases.entries()) {
    const f = fixture([{
      company: 'Example Oy', title: 'Engineer', url: 'https://careers.example.test/roles/source',
      provider: 'greenhouse', ats_tenant: 'example', requisition_id: '100',
    }]);
    try {
      const source = f.sourceCandidates[0];
      const sourcePath = join(f.sourceRunDir, 'candidates.json');
      const rows = JSON.parse(readFileSync(sourcePath, 'utf8'));
      rows[0][field] = value;
      writeFileSync(sourcePath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
      f.writeLiveManifest();
      const result = await enrich(f, `identity-resourced-${index}`, {
        overrides: { [source.candidate_id]: { listing_url: 'https://careers.example.test/roles/current', reason: 'Owner confirmed current listing' } },
      });
      const candidate = candidateAt(result);
      assert.equal(candidate.ats_provider, null, field);
      assert.equal(candidate.ats_tenant, null, field);
      assert.equal(candidate.requisition_id, null, field);
      assert.equal(candidate.provider, candidate.source, field); // no ATS identity: provider falls back to discovery attribution
    } finally { f.cleanup(); }
  }
});

test('a URL-only re-sourced row maps to the final ATS identity of a merged source row', async () => {
  const sharedUrl = 'https://careers.example.test/roles/shared';
  const f = fixture([
    {
      company: 'Example Oy', title: 'Engineer One', url: sharedUrl,
      ats_provider: 'greenhouse', ats_tenant: 'example', requisition_id: '999',
    },
    { company: 'Example Oy', title: 'Engineer Two', url: 'https://careers.example.test/roles/other' },
  ]);
  try {
    f.writeLiveManifest();
    const [sourceA, sourceB] = f.sourceCandidates;
    const result = await enrich(f, 'url-merge-mapping', {
      overrides: {
        [sourceB.candidate_id]: { listing_url: sharedUrl, reason: 'Owner confirmed shared listing' },
      },
    });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.enrichment.length, 2);
    assert.ok(result.enrichment.every((entry) => entry.candidate_id === result.candidates[0].candidate_id));
    assert.equal(result.enrichment.find((entry) => entry.source_candidate_id === sourceA.candidate_id).candidate_id,
      result.candidates[0].candidate_id);
    const mappedB = result.enrichment.find((entry) => entry.source_candidate_id === sourceB.candidate_id);
    assert.equal(mappedB.candidate_id, result.candidates[0].candidate_id);
    assert.equal(mappedB.status, 'converged');
    assert.equal(mappedB.converged, true);
    assert.ok(mappedB.changes.includes('candidate_id_changed'));
  } finally { f.cleanup(); }
});

for (const urlOnlyFirst of [true, false]) {
  const order = urlOnlyFirst ? 'URL-only first' : 'explicit ATS first';
  for (const companySource of [null, 'owner', 'portals', 'owner over portals', 'matching owners']) {
    test(`convergence resolves final IDs and company (${order}, ${companySource || 'original company'})`, async () => {
      const f = convergenceFixture(urlOnlyFirst);
      try {
        f.writeLiveManifest();
        const before = treeHashes(f.sourceRunDir);
        const urlOnly = f.sourceCandidates.find((candidate) => !candidate.ats_provider);
        const ats = f.sourceCandidates.find((candidate) => candidate.ats_provider);
        const overrides = {
          [urlOnly.candidate_id]: { listing_url: ats.url, reason: 'Owner confirmed shared listing' },
        };
        if (companySource?.includes('portals')) {
          writeFileSync(join(f.root, 'portals.yml'), [
            'tracked_companies:', '  - name: Portal Example Oy', '    provider: greenhouse', '    ats_tenant: example', '',
          ].join('\n'));
        }
        if (companySource?.includes('owner')) {
          // Put the override on the later row so the merge's first company cannot win.
          const ownerIds = companySource === 'matching owners'
            ? f.sourceCandidates.map((candidate) => candidate.candidate_id)
            : [f.sourceCandidates[1].candidate_id];
          for (const id of ownerIds) {
            overrides[id] = { ...overrides[id], company: '  Owner Example Oy  ', reason: 'Owner confirmed company name' };
          }
        }
        const result = await enrich(f, 'convergence-company', { overrides });
        assert.equal(result.candidates.length, 1);
        const candidate = candidateAt(result);
        assert.equal(candidate.candidate_id, ats.candidate_id);
        assert.ok(result.enrichment.every((entry) => entry.candidate_id === candidate.candidate_id && entry.converged));
        const expectedCompany = companySource?.includes('owner') ? 'Owner Example Oy'
          : companySource === 'portals' ? 'Portal Example Oy' : f.sourceCandidates[0].company;
        assert.equal(candidate.company, expectedCompany);
        for (const entry of result.enrichment) {
          assert.equal(entry.changes.includes('company_override'), Boolean(companySource?.includes('owner')));
          assert.equal(entry.changes.includes('company_from_portals'), companySource === 'portals');
        }
        const published = JSON.parse(readFileSync(join(result.runDir, 'candidates.json'), 'utf8'));
        assert.deepEqual(published, result.candidates);
        const content = readFileSync(join(result.runDir, 'enrichment.json'));
        const manifest = JSON.parse(readFileSync(join(result.runDir, 'manifest.json'), 'utf8'));
        assert.equal(manifest.metadata.enrichment_sha256, hash(content));
        assert.deepEqual(JSON.parse(content), result.enrichment);
        assert.deepEqual(treeHashes(f.sourceRunDir), before);
      } finally { f.cleanup(); }
    });
  }

  test(`conflicting company overrides on a convergence group abort without writing (${order})`, async () => {
    const f = convergenceFixture(urlOnlyFirst);
    try {
      f.writeLiveManifest();
      const before = treeHashes(f.sourceRunDir);
      const urlOnly = f.sourceCandidates.find((candidate) => !candidate.ats_provider);
      const ats = f.sourceCandidates.find((candidate) => candidate.ats_provider);
      await assert.rejects(enrich(f, 'conflicting-companies', {
        overrides: {
          [urlOnly.candidate_id]: { listing_url: ats.url, company: 'Owner Example Oy', reason: 'Synthetic owner name' },
          [ats.candidate_id]: { company: 'Other Example Oy', reason: 'Conflicting synthetic owner name' },
        },
      }), /Conflicting company overrides/);
      assert.deepEqual(treeHashes(f.sourceRunDir), before);
      assert.deepEqual(readdirSync(join(f.root, 'output', 'scan-runs')), ['source-run']);
    } finally { f.cleanup(); }
  });
}

test('ambiguous URL aliases cannot silently select a final candidate', async () => {
  const sharedUrl = 'https://careers.example.test/roles/shared';
  const f = fixture([
    {
      company: 'Example Oy', title: 'First ATS Engineer', url: 'https://careers.example.test/roles/one',
      ats_provider: 'greenhouse', ats_tenant: 'example', requisition_id: '101', url_aliases: [sharedUrl],
    },
    {
      company: 'Acme GmbH', title: 'Second ATS Engineer', url: 'https://careers.example.test/roles/two',
      ats_provider: 'greenhouse', ats_tenant: 'example', requisition_id: '202', url_aliases: [sharedUrl],
    },
    { company: 'Example Oy', title: 'URL-only Engineer', url: sharedUrl },
  ]);
  try {
    f.writeLiveManifest();
    const before = treeHashes(f.sourceRunDir);
    const source = f.sourceCandidates.find((candidate) => !candidate.ats_provider);
    await assert.rejects(enrich(f, 'ambiguous-mapping'),
      new RegExp(`Enrichment mapping for ${source.candidate_id} resolved to 3 built candidates`));
    assert.deepEqual(treeHashes(f.sourceRunDir), before);
    assert.deepEqual(readdirSync(join(f.root, 'output', 'scan-runs')), ['source-run']);
  } finally { f.cleanup(); }
});

test('an unchanged owner company suppresses portal changes for the whole group', async () => {
  const f = convergenceFixture(true);
  try {
    f.writeLiveManifest();
    const [urlOnly, ats] = f.sourceCandidates;
    writeFileSync(join(f.root, 'portals.yml'), [
      'tracked_companies:', '  - name: Portal Example Oy', '    provider: greenhouse', '    ats_tenant: example', '',
    ].join('\n'));
    const result = await enrich(f, 'unchanged-owner-company', {
      overrides: {
        [urlOnly.candidate_id]: { listing_url: ats.url, company: urlOnly.company, reason: 'Owner confirmed existing name' },
      },
    });
    assert.equal(candidateAt(result).company, urlOnly.company);
    const urlEntry = result.enrichment.find((entry) => entry.source_candidate_id === urlOnly.candidate_id);
    const atsEntry = result.enrichment.find((entry) => entry.source_candidate_id === ats.candidate_id);
    assert.equal(urlEntry.changes.includes('company_override'), false);
    assert.equal(atsEntry.changes.includes('company_override'), true);
    assert.ok(result.enrichment.every((entry) => !entry.changes.includes('company_from_portals')));
  } finally { f.cleanup(); }
});

test('portal company lookup uses the final apply URL identity and explicit company wins', async () => {
  const f = fixture([{ company: 'Original Display', title: 'Engineer', url: 'https://careers.example.test/roles/one' }]);
  try {
    f.writeLiveManifest();
    writeFileSync(join(f.root, 'portals.yml'), [
      'tracked_companies:', '  - name: Portal Display', '    provider: greenhouse', '    ats_tenant: example', '',
    ].join('\n'));
    const sourceId = f.sourceCandidates[0].candidate_id;
    const applied = await enrich(f, 'portal-final-apply', {
      overrides: { [sourceId]: {
        apply_url: 'https://boards.greenhouse.io/example/jobs/321', reason: 'Owner verified application endpoint',
      } },
    });
    assert.equal(candidateAt(applied).company, 'Portal Display');
    assert.ok(applied.enrichment[0].changes.includes('company_from_portals'));

    const resourced = await enrich(f, 'portal-final-resourced', {
      overrides: { [sourceId]: {
        listing_url: 'https://boards.greenhouse.io/example/jobs/654', reason: 'Owner confirmed current posting',
      } },
    });
    assert.equal(candidateAt(resourced).company, 'Portal Display');
    assert.ok(resourced.enrichment[0].changes.includes('company_from_portals'));

    const explicit = await enrich(f, 'portal-company-override', {
      overrides: { [sourceId]: {
        apply_url: 'https://boards.greenhouse.io/example/jobs/321', company: 'Owner Display',
        reason: 'Owner verified company display name',
      } },
    });
    assert.equal(candidateAt(explicit).company, 'Owner Display');
    assert.ok(explicit.enrichment[0].changes.includes('company_override'));
  } finally { f.cleanup(); }
});

test('portal lookup derives Greenhouse tenant from a board URL or API configuration', async () => {
  for (const [index, configField, configUrl] of [
    [0, 'careers_url', 'https://boards.greenhouse.io/example'],
    [1, 'api', 'https://boards-api.greenhouse.io/v1/boards/example/jobs'],
  ]) {
    const f = fixture([{
      company: 'Original Display', title: 'Engineer', url: 'https://boards.greenhouse.io/example/jobs/321',
    }]);
    try {
      f.writeLiveManifest();
      writeFileSync(join(f.root, 'portals.yml'), [
        'tracked_companies:', '  - name: Portal Display', '    provider: greenhouse', `    ${configField}: ${configUrl}`, '',
      ].join('\n'));
      const result = await enrich(f, `portal-config-tenant-${index}`);
      assert.equal(candidateAt(result).company, 'Portal Display');
    } finally { f.cleanup(); }
  }
});

test('enrichment preserves configured location ordering for planning and publication', async () => {
  const f = fixture([
    { company: 'Example Oy', title: 'Finland Role', url: 'https://careers.example.test/roles/finland', location: 'Finland' },
    { company: 'Example Oy', title: 'Germany Role', url: 'https://careers.example.test/roles/germany', location: 'Germany' },
    { company: 'Example Oy', title: 'Netherlands Role', url: 'https://careers.example.test/roles/netherlands', location: 'Netherlands' },
  ]);
  try {
    f.writeLiveManifest();
    mkdirSync(join(f.root, 'config'), { recursive: true });
    writeFileSync(join(f.root, 'config', 'profile.yml'), 'scan:\n  location_priority:\n    - Netherlands\n    - Finland\n    - Germany\n', 'utf8');
    const planned = await enrich(f, 'configured-location-plan', { dryRun: true });
    assert.deepEqual(planned.candidates.map((candidate) => candidate.title), [
      'Netherlands Role', 'Finland Role', 'Germany Role',
    ]);
    const published = await enrich(f, 'configured-location-published');
    assert.deepEqual(published.candidates.map((candidate) => candidate.title), [
      'Netherlands Role', 'Finland Role', 'Germany Role',
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(published.runDir, 'candidates.json'), 'utf8'))
      .map((candidate) => candidate.title), ['Netherlands Role', 'Finland Role', 'Germany Role']);
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
