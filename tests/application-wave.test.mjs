import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDraftManifest } from '../cv-claims.mjs';
import { createApplicationBatch, loadBatchState } from '../application-batch.mjs';
import { approveCoverLetterV2, runCoverLetterV2 } from '../cover-letter-v2.mjs';
import { sha256Canonical } from '../application-integrity.mjs';
import { writeImmutableScanRun } from '../scan-candidate-contract.mjs';
import { approveWave, reviewWave } from '../application-wave.mjs';

const descriptions = [
  'Acme is seeking a Data Engineer to build Python and SQL ETL pipelines, PostgreSQL data models, validation, analytics, reporting, and maintain reliable services with Git on Linux in a collaborative engineering team.',
  'Brightside is seeking a Backend Engineer to design Python APIs, SQL data stores, REST services, careful testing, maintainable software, and reliable integrations with Git on Linux in a collaborative engineering team.',
];
const candidates = [
  { company: 'Acme', title: 'Data Engineer', url: 'https://jobs.example.test/acme/1', description: descriptions[0] },
  { company: 'Brightside', title: 'Backend Engineer', url: 'https://jobs.example.test/brightside/2', description: descriptions[1] },
];

function write(root, path, value) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
  return target;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-wave-'));
  write(root, 'config/profile.yml', `candidate:\n  full_name: Alex Example\n  email: alex.example@example.test\n  phone: "+1 202-555-0142"\n  location: Example City, Finland\n  linkedin: https://linkedin.test/alex-example\n  github: https://github.test/alex-example\nlocation:\n  country: Finland\n  city: Example City\ncurrent_status:\n  summary: Graduate student at Example University\n  availability:\n    start: Available immediately\ncompensation:\n  target_range: EUR 50000-55000/year\neducation_details:\n  expected_graduation_date: 31/12/2030\nnarrative:\n  banned_phrases: [excited to leverage, cutting-edge, passionate]\napplication_form:\n  narrative_evidence:\n    - id: fictional-cv-projects\n      topics: [data_engineering, analytics, python_sql, ai_ml, software_backend, motivation_fit]\n      provenance:\n        - sourceType: cv\n          locator: lines:2\ncv:\n  approved_system:\n    master_pdf: output/cv-approved/Alex Example Master CV.pdf\n    role_pdfs:\n      data_engineering: output/cv-approved/Alex Example Data Engineering CV.pdf\n      ai_ml: output/cv-approved/Alex Example AI ML CV.pdf\n      software_backend: output/cv-approved/Alex Example Software Backend CV.pdf\n`);
  const cvText = '## Projects\nIn the fictional Warehouse project, I used Python and SQL for data validation.';
  write(root, 'cv.md', cvText);
  const claimManifest = createDraftManifest(cvText);
  claimManifest.claims.forEach((claim) => { claim.state = 'asserted'; });
  write(root, 'data/cv-claim-anchors.json', JSON.stringify(claimManifest, null, 2));
  write(root, 'modes/_profile.md', '# Rules\nUse only truthful approved evidence.');
  write(root, 'output/application-answer-bank.md', '# Answer Bank\n\n## Python experience\nI have used Python and SQL in careful, documented projects.\n');
  for (const name of ['Master', 'Data Engineering', 'AI ML', 'Software Backend']) {
    write(root, `output/cv-approved/Alex Example ${name} CV.pdf`, `%PDF-1.4 ${name}`);
  }
  const scan = writeImmutableScanRun({
    root,
    runId: 'wave-run',
    sourceArchitecture: 'test',
    inputs: [{ name: 'fixture', rows: candidates }],
  });
  const batches = scan.candidates.map((candidate, index) => createApplicationBatch({
    root,
    sourceRunId: 'wave-run',
    batchId: `wave-batch-${index + 1}`,
    selectedCandidateIds: [candidate.candidate_id],
  }));
  return {
    root,
    batches,
    candidateIds: scan.candidates.map((candidate) => candidate.candidate_id),
    checkPaths: [],
  };
}

const passingValidator = async ({ claims }) => ({
  ok: true,
  results: claims.map((claim) => ({ claimId: claim.id, status: 'pass' })),
});

function draft(company, role, jdText) {
  const sentence = 'I built reliable software tools with Python and SQL, validated structured data, documented interfaces, and tested changes carefully with teammates.';
  const sentences = Array.from({ length: 10 }, () => sentence);
  return {
    company,
    role,
    language: 'en',
    jd: { text: jdText },
    greeting: 'Dear Hiring Team,',
    paragraphs: [{ text: sentences.join(' '), claims: sentences.map((text, index) => ({ id: `claim-${index + 1}`, text })) }],
    closing: 'I would welcome a conversation about the role and its practical responsibilities.',
    signature: 'Synthetic Candidate',
  };
}

async function makeCheckedLetter(f, index, { jdText = descriptions[index], preapprove = false } = {}) {
  const company = candidates[index].company;
  const role = candidates[index].title;
  const result = await runCoverLetterV2(draft(company, role, jdText), {
    jdText,
    jdCompany: company,
    jdRole: role,
    validateClaims: passingValidator,
    outputDirectory: join(f.root, 'output', 'cover-letters'),
  });
  assert.equal(result.status, 'pass', JSON.stringify(result.checks));
  if (preapprove) await approveCoverLetterV2(result.files.check);
  f.checkPaths[index] = result.files.check;
  return result.files.check;
}

function entries(f, indexes = [0, 1]) {
  return indexes.map((index) => ({ batchId: `wave-batch-${index + 1}`, checkPath: f.checkPaths[index] }));
}

function livenessStub(calls = []) {
  return async (url) => {
    calls.push(url);
    return { result: 'active', reason: 'fixture listing is active' };
  };
}

test('review writes the full review and a stable canonical wave hash', async () => {
  const f = fixture();
  try {
    const firstCheck = await makeCheckedLetter(f, 0);
    const secondCheck = await makeCheckedLetter(f, 1);
    const calls = [];
    const first = await reviewWave({ waveId: 'stable-wave', items: entries(f) }, { root: f.root, liveness: livenessStub(calls) });
    const second = await reviewWave({ waveId: 'stable-wave-copy', items: entries(f) }, { root: f.root, liveness: livenessStub() });
    assert.equal(first.waveHash, sha256Canonical(first.items));
    assert.equal(first.waveHash, second.waveHash);
    assert.equal(calls.length, 2);
    const review = readFileSync(first.reviewPath, 'utf8');
    assert.ok(review.includes(readFileSync(firstCheck.replace(/\.check\.json$/, '.txt'), 'utf8')));
    assert.ok(review.includes(readFileSync(secondCheck.replace(/\.check\.json$/, '.txt'), 'utf8')));
    assert.match(review, /Alex Example Data Engineering CV\.pdf/);
    assert.match(review, /fixture listing is active/);
    assert.ok(review.includes(`node application-wave.mjs approve --wave-id stable-wave --confirm ${first.waveHash}`));
    assert.ok(existsSync(join(f.root, 'output', 'application-waves', 'stable-wave', 'wave.json')));
    const expired = await reviewWave({ waveId: 'expired-wave', items: entries(f, [0]) }, {
      root: f.root,
      liveness: async () => ({ result: 'expired', reason: 'fixture listing closed' }),
    });
    assert.equal(expired.items[0].liveness.result, 'expired');
    assert.ok(expired.items[0].problems.some((problem) => /expired/.test(problem)));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('approve rejects a wrong hash before approving letters or writing plans', async () => {
  const f = fixture();
  try {
    await makeCheckedLetter(f, 0);
    await makeCheckedLetter(f, 1);
    const wave = await reviewWave({ waveId: 'wrong-hash-wave', items: entries(f) }, { root: f.root, liveness: livenessStub() });
    await assert.rejects(approveWave({ waveId: wave.waveId, confirm: 'sha256:' + '0'.repeat(64) }, { root: f.root }), /Confirmation hash mismatch/);
    assert.equal(existsSync(f.checkPaths[0].replace(/\.check\.json$/, '.approved.json')), false);
    assert.equal(existsSync(join(dirname(f.batches[0].manifestPath), 'documents', f.candidateIds[0], 'plan.json')), false);
    assert.equal(existsSync(join(f.root, 'output', 'application-waves', wave.waveId, 'approval.json')), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('approve reuses an existing approval, prepares both batches, binds artifacts, and confirms preflight', async () => {
  const f = fixture();
  try {
    const first = await makeCheckedLetter(f, 0, { preapprove: true });
    await makeCheckedLetter(f, 1);
    const approvalPath = first.replace(/\.check\.json$/, '.approved.json');
    const approvalBefore = readFileSync(approvalPath, 'utf8');
    const wave = await reviewWave({ waveId: 'approve-wave', items: entries(f) }, { root: f.root, liveness: livenessStub() });
    const result = await approveWave({ waveId: wave.waveId, confirm: wave.waveHash }, { root: f.root });
    assert.deepEqual(result.items.map((item) => item.outcome), ['prepared', 'prepared']);
    assert.equal(readFileSync(approvalPath, 'utf8'), approvalBefore);
    assert.equal(result.sharedBrowserCommand,
      'node application-shared-browser.mjs --batch-id wave-batch-1 --batch-id wave-batch-2');
    for (const batch of f.batches) {
      const loaded = loadBatchState(batch.manifestPath, { root: f.root });
      assert.equal(loaded.state.preflight.status, 'confirmed');
      assert.ok(loaded.state.candidates[0].artifacts.cv);
      assert.ok(loaded.state.candidates[0].artifacts.coverLetter);
      assert.ok(loaded.state.candidates[0].artifacts.coverLetterText);
      assert.ok(existsSync(join(dirname(batch.manifestPath), 'documents', loaded.manifest.candidates[0].candidate_id, 'plan.json')));
    }
    assert.equal(existsSync(join(f.root, 'output', 'application-waves', wave.waveId, 'approval.json')), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a letter changed after review fails alone while the other wave item completes', async () => {
  const f = fixture();
  try {
    const changedCheck = await makeCheckedLetter(f, 0);
    await makeCheckedLetter(f, 1);
    const wave = await reviewWave({ waveId: 'tampered-wave', items: entries(f) }, { root: f.root, liveness: livenessStub() });
    const textPath = changedCheck.replace(/\.check\.json$/, '.txt');
    writeFileSync(textPath, `${readFileSync(textPath, 'utf8')}Changed after review.\n`);
    const result = await approveWave({ waveId: wave.waveId, confirm: wave.waveHash }, { root: f.root });
    assert.equal(result.items[0].outcome, 'failed');
    assert.match(result.items[0].error, /text hash|textHash/i);
    assert.equal(result.items[1].outcome, 'prepared');
    assert.equal(existsSync(changedCheck.replace(/\.check\.json$/, '.approved.json')), false);
    assert.equal(loadBatchState(f.batches[0].manifestPath, { root: f.root }).state.preflight.status, 'unconfirmed');
    assert.equal(loadBatchState(f.batches[1].manifestPath, { root: f.root }).state.preflight.status, 'confirmed');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('review flags a letter checked against a different immutable candidate JD', async () => {
  const f = fixture();
  try {
    const mismatchedJd = `${descriptions[0]} The team also uses a different reporting platform.`;
    await makeCheckedLetter(f, 0, { jdText: mismatchedJd });
    const wave = await reviewWave({ waveId: 'jd-mismatch-wave', items: entries(f, [0]) }, { root: f.root, liveness: livenessStub() });
    assert.ok(wave.items[0].problems.some((problem) => /different JD/.test(problem)));
    assert.match(readFileSync(join(f.root, 'output', 'application-waves', wave.waveId, 'review.md'), 'utf8'), /NOT APPROVABLE/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
