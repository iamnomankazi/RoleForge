import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import {
  configuredLocationPriority,
  mergeCanonicalCandidates,
  writeImmutableScanRun,
} from '../scan-candidate-contract.mjs';
import {
  confirmPreflight,
  createApplicationBatch,
  loadBatchState,
} from '../application-batch.mjs';
import { createDocumentPlan, prepareAndBindDocuments } from '../application-documents.mjs';
import { executeCandidate } from '../application-browser-executor.mjs';
import { hashFile } from '../application-integrity.mjs';
import { greenhouseFixture, listingFixture } from './fixtures/application-form-fixtures.mjs';

function write(root, path, value) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
  return target;
}

function profileFixture(root) {
  write(root, 'config/profile.yml', `candidate:\n  full_name: Alex Example\n  email: alex.example@example.test\n  phone: "+1 202-555-0142"\n  location: Example City, Finland\n  linkedin: https://linkedin.test/alex-example\n  github: https://github.test/alex-example\nlocation:\n  country: Finland\n  city: Example City\n  work_authorization:\n    finland: Authorized to work in Finland on a Finnish student residence permit.\n    outside_finland: Visa or work permit sponsorship is required outside Finland.\ncurrent_status:\n  summary: Graduate student at Example University\n  availability:\n    start: Available immediately\ncompensation:\n  target_range: EUR 50,000-55,000/year\neducation_details:\n  expected_graduation_date: 31/12/2030\nnarrative:\n  banned_phrases: [excited to leverage, cutting-edge, passionate]\ncv:\n  approved_system:\n    master_pdf: output/cv-approved/Alex Example Master CV.pdf\n    role_pdfs:\n      data_engineering: output/cv-approved/Alex Example Data Engineering CV.pdf\n      ai_ml: output/cv-approved/Alex Example AI ML CV.pdf\n      software_backend: output/cv-approved/Alex Example Software Backend CV.pdf\n`);
  write(root, 'cv.md', '# Alex Example\nPython SQL PostgreSQL 250K+ rows ETL Django PyTorch Hugging Face Git Linux');
  const profilePath = join(root, 'config', 'profile.yml');
  writeFileSync(profilePath, readFileSync(profilePath, 'utf8').replace('\ncv:', `
application_form:
  narrative_evidence:
    - id: fictional-cv-projects
      topics: [data_engineering, analytics, python_sql, ai_ml, software_backend, motivation_fit]
      provenance:
        - sourceType: cv
          locator: lines:2
cv:`));
  write(root, 'modes/_profile.md', '# Application truth rules\nUse only canonical evidence and never invent experience.');
  write(root, 'output/application-answer-bank.md', `# Application Answer Bank\n\n## Tell us about yourself\nI am a Computer Science master's student with practical work across Python, SQL, backend development, data pipelines, and machine learning.\n\n## Why this role?\nThis role fits the work I can defend best: practical Python, SQL, APIs, data handling, debugging, and learning quickly from real systems.\n\n## SQL/data experience\nI built a PostgreSQL data warehouse from about 250K+ synthetic inventory rows, covering cleaning, validation, dimensional modelling, indexes, and reporting.\n\n## Data warehouse project\nI used Python, pandas, PostgreSQL, fact and dimension tables, indexes, and validation on 250K+ synthetic inventory rows.\n\n## Python experience\nI have used Python for ETL, data cleaning, Django backend work, automation, and machine-learning experiments.\n`);
  for (const name of ['Master', 'Data Engineering', 'AI ML', 'Software Backend']) {
    write(root, `output/cv-approved/Alex Example ${name} CV.pdf`, `%PDF-1.4 ${name} acceptance fixture`);
  }
}

function rankedLocations(locations, locationPriority = []) {
  const rows = locations.map((location, index) => ({
    company: `Synthetic Company ${String(index).padStart(2, '0')}`,
    title: 'Synthetic Engineer',
    url: `https://fixture.invalid/location/${index}`,
    location,
    match_bucket: 'Strong Match',
    score: 4.5,
  }));
  return mergeCanonicalCandidates([{ name: 'location-ranking-fixture', rows }], { locationPriority })
    .candidates.map((row) => row.location);
}

test('configured location priorities preserve their declared order', () => {
  assert.deepEqual(
    rankedLocations(['Helsinki, Finland', 'Berlin, Germany', 'Amsterdam, Netherlands'], ['Netherlands', 'Germany', 'Finland']),
    ['Amsterdam, Netherlands', 'Berlin, Germany', 'Helsinki, Finland'],
  );
});

test('an ignored profile can supply a more explicit ordered location policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-explicit-location-policy-'));
  try {
    write(root, 'config/profile.yml', `location:\n  country: Finland\n  city: Example City\nscan:\n  location_priority:\n    - Netherlands\n    - Germany\n    - Finland\n`);
    assert.deepEqual(configuredLocationPriority(root), [
      ['Netherlands'], ['Germany'], ['Finland', 'Example City'],
    ]);
    const run = writeImmutableScanRun({
      root,
      runId: 'explicit-location-policy-fixture',
      sourceArchitecture: 'acceptance_fixture',
      inputs: [{
        name: 'fixture',
        rows: [
          { company: 'Finnish Example', title: 'Engineer', url: 'https://fixture.invalid/explicit/finland', location: 'Helsinki, Finland' },
          { company: 'German Example', title: 'Engineer', url: 'https://fixture.invalid/explicit/germany', location: 'Berlin, Germany' },
          { company: 'Dutch Example', title: 'Engineer', url: 'https://fixture.invalid/explicit/netherlands', location: 'Amsterdam, Netherlands' },
        ],
      }],
    });
    assert.deepEqual(run.candidates.map((row) => row.location), [
      'Amsterdam, Netherlands', 'Berlin, Germany', 'Helsinki, Finland',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('default target-country order is Finland, Germany, Denmark, then the Netherlands', () => {
  assert.deepEqual(
    rankedLocations(['Amsterdam, Netherlands', 'Copenhagen, Denmark', 'Berlin, Germany', 'Helsinki, Finland']),
    ['Helsinki, Finland', 'Berlin, Germany', 'Copenhagen, Denmark', 'Amsterdam, Netherlands'],
  );
});

test('correct Unicode city names München and Köln rank with Germany ahead of Denmark', () => {
  const ordered = rankedLocations(['Copenhagen, Denmark', 'München, Germany', 'Köln, Germany']);
  assert.deepEqual(ordered.slice(0, 2).sort(), ['Köln, Germany', 'München, Germany'].sort());
  assert.equal(ordered[2], 'Copenhagen, Denmark');
});

test('Remote Europe ranks below all configured target countries', () => {
  assert.deepEqual(
    rankedLocations(['Remote, Europe', 'Amsterdam, Netherlands', 'Copenhagen, Denmark', 'Berlin, Germany', 'Helsinki, Finland']),
    ['Helsinki, Finland', 'Berlin, Germany', 'Copenhagen, Denmark', 'Amsterdam, Netherlands', 'Remote, Europe'],
  );
});

test('otherwise equal candidates have deterministic ordering independent of input order', () => {
  const rows = [
    { company: 'Synthetic Company', title: 'Engineer', url: 'https://fixture.invalid/tie/b', location: 'Berlin, Germany', match_bucket: 'Strong Match', score: 4.5 },
    { company: 'Synthetic Company', title: 'Engineer', url: 'https://fixture.invalid/tie/a', location: 'Berlin, Germany', match_bucket: 'Strong Match', score: 4.5 },
  ];
  const rank = (input) => mergeCanonicalCandidates([{ name: 'deterministic-fixture', rows: input }], { locationPriority: ['Germany'] })
    .candidates.map((row) => row.candidate_id);
  assert.deepEqual(rank(rows), rank([...rows].reverse()));
});

test('scan location priority is derived from the ignored synthetic profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-location-policy-'));
  try {
    profileFixture(root);
    assert.deepEqual(configuredLocationPriority(root), [
      ['Finland', 'Example City'], ['Germany'], ['Denmark'], ['Netherlands'],
    ]);
    const run = writeImmutableScanRun({
      root,
      runId: 'location-policy-fixture',
      sourceArchitecture: 'acceptance_fixture',
      inputs: [{
        name: 'fixture',
        rows: [
          { company: 'Remote Example', title: 'Engineer', url: 'https://fixture.invalid/remote', location: 'Remote, Europe' },
          { company: 'Local Example', title: 'Engineer', url: 'https://fixture.invalid/local', location: 'Example City, Finland' },
        ],
      }],
    });
    assert.equal(run.candidates[0].location, 'Example City, Finland');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('controlled local Phase 4 scan-to-form acceptance stops safely at form_prepared', async () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-phase4-acceptance-'));
  try {
    profileFixture(root);
    const tracker = write(root, 'data/applications.md', '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-07-13 | Acme | Data Engineer | 4.5/5 | Evaluated | no | none | fixture |\n');
    const trackerBefore = hashFile(tracker);
    write(root, 'output/apply-queue.csv', 'rank,company,role,url\n1,Legacy Example A,Analytics Engineer,https://stale.example/danish\n2,Legacy Example B,Software Engineer,https://stale.example/persohap\n');
    const listingUrl = 'https://fixture.career-ops.invalid/jobs/123';
    const applyUrl = 'https://fixture.career-ops.invalid/apply/123';
    const description = 'Acme is hiring an early-career Data Engineer for Python and SQL ETL data pipelines, PostgreSQL dimensional modelling, data validation, analytics, reporting, Git, and Linux.';
    const run = writeImmutableScanRun({
      root, runId: 'phase4-acceptance-run', sourceArchitecture: 'acceptance_fixture',
      inputs: [{ name: 'fixture', rows: [{ company: 'Acme', title: 'Data Engineer', url: listingUrl, apply_url: applyUrl, description }] }],
    });
    assert.match(run.candidates[0].candidate_id, /^cand_v1_/);
    const candidateId = run.candidates[0].candidate_id;
    const batch = createApplicationBatch({
      root, sourceRunId: run.manifest.run_id, batchId: 'phase4-acceptance-batch', selectedCandidateIds: [candidateId],
      allowDuplicateReason: 'Prepare the fictional application already evaluated in the acceptance tracker.',
    });
    assert.deepEqual(batch.manifest.candidates.map((row) => row.candidate_id), [candidateId]);
    const plan = createDocumentPlan({ manifestPath: batch.manifestPath, candidateId, root });
    const preparedDocuments = await prepareAndBindDocuments({
      manifestPath: batch.manifestPath, candidateId, plan, confirmPlanHash: plan.planHash, root,
    });
    assert.equal(preparedDocuments.records.cv.sourceCvVariant, 'data_engineering');
    assert.equal(hashFile(preparedDocuments.records.coverLetter.resolvedPath).sha256, preparedDocuments.records.coverLetter.sha256);
    confirmPreflight(batch.manifestPath, batch.manifest.batchId, { root });

    const navigation = [];
    let sentinelUntouched = false;
    let sentinelPage;
    const result = await executeCandidate({
      manifest: batch.manifestPath,
      candidateId,
      headless: true,
      keepOpen: false,
      resumeLogin: false,
      prepareForm: true,
    }, {
      root,
      dependencies: {
        checkLivenessViaApi: async () => ({ result: 'active', reason: 'fixture active' }),
        checkUrlLiveness: async (page, url) => {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          return { result: 'active', reason: 'repository fixture active' };
        },
        launchBrowser: () => chromium.launch({ headless: true }),
        configureContext: async (context) => {
          await context.route('**/*', async (route) => {
            const url = route.request().url();
            navigation.push(url);
            if (url === listingUrl) return route.fulfill({ status: 200, contentType: 'text/html', body: listingFixture });
            if (url === applyUrl) return route.fulfill({ status: 200, contentType: 'text/html', body: greenhouseFixture });
            return route.fulfill({ status: 404, contentType: 'text/plain', body: 'fixture route not found' });
          });
          sentinelPage = await context.newPage();
          await sentinelPage.setContent('<h1 id="sentinel">Unrelated tab</h1>');
        },
        beforeBrowserClose: async () => {
          sentinelUntouched = await sentinelPage.locator('#sentinel').textContent() === 'Unrelated tab'
            && sentinelPage.url() === 'about:blank';
        },
      },
    });

    assert.equal(result.state, 'form_prepared');
    assert.equal(result.submissionAvailable, false);
    assert.equal(result.trackerUpdated, false);
    const loaded = loadBatchState(batch.manifestPath, { root });
    const state = loaded.state.candidates[0];
    assert.equal(state.state, 'form_prepared');
    assert.equal(state.formPreparation.reviewComplete, true);
    assert.equal(state.formPreparation.finalAction.activated, false);
    assert.equal(state.formPreparation.uploadedArtifacts.length, 2);
    assert.ok(state.formPreparation.committedSelections.some((row) => row.semantic === 'city'));
    assert.equal(sentinelUntouched, true);
    assert.deepEqual(hashFile(tracker), trackerBefore);
    const authorityText = `${readFileSync(batch.manifestPath, 'utf8')}\n${readFileSync(loaded.statePath, 'utf8')}\n${navigation.join('\n')}`;
    assert.doesNotMatch(authorityText, /Legacy Example A|Legacy Example B|stale\.example/i);
    assert.deepEqual([...new Set(navigation.filter((url) => url.startsWith('https://')))], [listingUrl, applyUrl]);
    assert.doesNotMatch(readFileSync(tracker, 'utf8'), /\| Applied \|/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
