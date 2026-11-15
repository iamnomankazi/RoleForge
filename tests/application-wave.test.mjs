import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDraftManifest } from '../cv-claims.mjs';
import { createApplicationBatch, loadBatchState } from '../application-batch.mjs';
import { createDocumentPlan } from '../application-documents.mjs';
import { approveCoverLetterV2, runCoverLetterV2 } from '../cover-letter-v2.mjs';
import { hashFile, sha256Canonical } from '../application-integrity.mjs';
import { writeImmutableScanRun } from '../scan-candidate-contract.mjs';
import { approveWave, parseApplicationWaveArgs, reviewWave } from '../application-wave.mjs';

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

function fixture({ rows = candidates } = {}) {
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
    inputs: [{ name: 'fixture', rows }],
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

async function makeCheckedLetter(f, index, {
  jdText = descriptions[index], preapprove = false, signature = 'Synthetic Candidate',
  company = candidates[index].company, role = candidates[index].title,
} = {}) {
  const letterDraft = { ...draft(company, role, jdText), signature };
  const result = await runCoverLetterV2(letterDraft, {
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

function replaceCheckedPair(checkPath, replacementPath) {
  const sidecar = JSON.parse(readFileSync(replacementPath, 'utf8'));
  for (const [key, extension] of [['text', '.txt'], ['pdf', '.pdf']]) {
    const target = checkPath.replace(/\.check\.json$/, extension);
    writeFileSync(target, readFileSync(sidecar.files[key]));
    sidecar.files[key] = target;
  }
  writeFileSync(checkPath, JSON.stringify(sidecar, null, 2));
}

function assertNothingBound(f, index = 0) {
  const loaded = loadBatchState(f.batches[index].manifestPath, { root: f.root });
  assert.equal(loaded.state.preflight.status, 'unconfirmed');
  for (const key of ['cv', 'coverLetter', 'coverLetterText']) {
    assert.ok(!loaded.state.candidates[0].artifacts[key]);
  }
  assert.equal(existsSync(join(dirname(f.batches[index].manifestPath), 'documents', f.candidateIds[index])), false);
}

function linkDirectory(t, target, path) {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) throw error;
    t.skip(`Directory links are unavailable: ${error.code}`);
    return false;
  }
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
    const legacyKeys = [
      'batchId', 'manifestPath', 'manifestScopeHash', 'candidateId', 'company', 'title', 'listingUrl',
      'checkPath', 'checkSidecarSha256', 'textPath', 'pdfPath', 'draftHash', 'jdHash', 'textHash',
      'pdfHash', 'cvFilename', 'cvSha256', 'liveness', 'problems',
    ];
    const legacyItems = first.items.map((item) => Object.fromEntries(legacyKeys.map((key) => [key, item[key]])));
    assert.equal(JSON.stringify(first.items), JSON.stringify(legacyItems));
    assert.equal(first.waveHash, sha256Canonical(legacyItems));
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

test('wave CLI attaches paired overrides only to selected batches and preserves legacy arguments', () => {
  const args = ['review', '--wave-id', 'override-wave', '--item', 'one=one.check.json', '--item', 'two=two.check.json'];
  assert.deepEqual(parseApplicationWaveArgs([...args]), {
    command: 'review', waveId: 'override-wave', items: [{ batchId: 'one', checkPath: 'one.check.json' }, { batchId: 'two', checkPath: 'two.check.json' }],
  });
  const parsed = parseApplicationWaveArgs([...args,
    '--cv-override', 'one=master', '--cv-reason', 'one=  Owner prefers the general CV.  ',
    '--cv-reason', 'two=Emphasize ML = reviewed.', '--cv-override', 'two=ai_ml',
  ]);
  assert.deepEqual(parsed.items.map((item) => item.cvOverride), [
    { variant: 'master', reason: 'Owner prefers the general CV.' },
    { variant: 'ai_ml', reason: 'Emphasize ML = reviewed.' },
  ]);
  for (const flags of [
    ['--cv-override', 'missing=master', '--cv-reason', 'missing=Reviewed.'],
    ['--cv-override', 'one=master'],
    ['--cv-reason', 'one=Reviewed.'],
    ['--cv-override', 'one=master', '--cv-override', 'one=ai_ml', '--cv-reason', 'one=Reviewed.'],
    ['--cv-override', 'one=master', '--cv-reason', 'one=Reviewed.', '--cv-reason', 'one=Again.'],
    ['--cv-override', 'one=master', '--cv-reason', 'one=  '],
    ['--cv-override', 'one=master', '--cv-reason', 'one=two\nlines'],
    ['--cv-override', 'one=master', '--cv-reason', `one=${'x'.repeat(501)}`],
  ]) {
    assert.throws(() => parseApplicationWaveArgs([...args, ...flags]), /--item|supplied together|Duplicate|CV override reason/);
  }
});

test('an owner override changes the reviewed CV and hash, binds the reason, and approves the overriding plan', async () => {
  const f = fixture();
  try {
    await makeCheckedLetter(f, 0);
    const legacy = await reviewWave({ waveId: 'default-cv-wave', items: entries(f, [0]) }, { root: f.root, liveness: livenessStub() });
    const cvOverride = { variant: 'ai_ml', reason: 'Owner reviewed the ML emphasis.' };
    const reviewItems = entries(f, [0]).map((item) => ({ ...item, cvOverride }));
    const wave = await reviewWave({ waveId: 'owner-cv-wave', items: reviewItems }, { root: f.root, liveness: livenessStub() });
    const item = wave.items[0];
    assert.deepEqual(item.problems, []);
    assert.deepEqual(item.cvOverride, cvOverride);
    assert.equal(item.cvFilename, 'Alex Example AI ML CV.pdf');
    assert.equal(item.cvSha256, hashFile(join(f.root, 'output', 'cv-approved', item.cvFilename)).sha256);
    assert.equal(item.cvAutomatic.variant, 'data_engineering');
    assert.notEqual(wave.waveHash, legacy.waveHash);
    assert.match(readFileSync(wave.reviewPath, 'utf8'), /CV: Alex Example AI ML CV\.pdf \(owner override: ai_ml; reason: Owner reviewed the ML emphasis\.; automatic: data_engineering\)/);
    const changedReason = await reviewWave({ waveId: 'reason-cv-wave', items: reviewItems.map((entry) => ({
      ...entry, cvOverride: { ...cvOverride, reason: 'A different owner reason.' },
    })) }, { root: f.root, liveness: livenessStub() });
    assert.notEqual(wave.waveHash, changedReason.waveHash);
    const result = await approveWave({ waveId: wave.waveId, confirm: wave.waveHash }, { root: f.root });
    assert.equal(result.items[0].outcome, 'prepared', result.items[0].error);
    const plan = JSON.parse(readFileSync(join(dirname(f.batches[0].manifestPath), 'documents', f.candidateIds[0], 'plan.json'), 'utf8'));
    assert.equal(plan.cv.variant, 'ai_ml');
    assert.equal(plan.cv.decision, 'owner_override');
    assert.equal(plan.cv.override.reason, cvOverride.reason);
    assert.deepEqual(plan.cv.override.automatic, item.cvAutomatic);
    assert.equal(loadBatchState(f.batches[0].manifestPath, { root: f.root }).state.candidates[0].artifacts.cv.sourceCvVariant, 'ai_ml');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('override review refuses unapproved variants and approval rechecks the overriding CV bytes', async () => {
  const f = fixture();
  try {
    await makeCheckedLetter(f, 0);
    const reviewItems = (variant) => entries(f, [0]).map((item) => ({ ...item, cvOverride: { variant, reason: 'Owner reviewed this CV.' } }));
    const unknown = await reviewWave({ waveId: 'unknown-cv-wave', items: reviewItems('unknown') }, { root: f.root, liveness: livenessStub() });
    assert.ok(unknown.items[0].problems.some((problem) => /approved CV variant/.test(problem)));
    const wave = await reviewWave({ waveId: 'changed-cv-wave', items: reviewItems('master') }, { root: f.root, liveness: livenessStub() });
    writeFileSync(join(f.root, 'output', 'cv-approved', wave.items[0].cvFilename), '%PDF-1.4 changed');
    const result = await approveWave({ waveId: wave.waveId, confirm: wave.waveHash }, { root: f.root });
    assert.equal(result.items[0].outcome, 'failed');
    assert.match(result.items[0].error, /Selected approved CV changed since review/);
    assertNothingBound(f);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('approval recomputes the automatic choice recorded for an override', async () => {
  const f = fixture();
  try {
    await makeCheckedLetter(f, 0);
    const wave = await reviewWave({ waveId: 'automatic-change-wave', items: entries(f, [0]).map((item) => ({
      ...item, cvOverride: { variant: 'master', reason: 'Owner reviewed the general CV.' },
    })) }, { root: f.root, liveness: livenessStub() });
    const profilePath = join(f.root, 'config', 'profile.yml');
    const oldPath = 'output/cv-approved/Alex Example Data Engineering CV.pdf';
    const newPath = 'output/cv-approved/Alex Example Other Data CV.pdf';
    write(f.root, newPath, readFileSync(join(f.root, oldPath)));
    writeFileSync(profilePath, readFileSync(profilePath, 'utf8').replace(oldPath, newPath));
    const result = await approveWave({ waveId: wave.waveId, confirm: wave.waveHash }, { root: f.root });
    assert.equal(result.items[0].outcome, 'failed');
    assert.match(result.items[0].error, /Automatic CV selection changed since review/);
    assertNothingBound(f);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('wave review displays an ambiguous automatic selection error and approves the owner choice', async () => {
  const role = 'Operations Specialist';
  const jdText = 'Acme seeks an Operations Specialist to coordinate customer requests, review routine records, arrange meetings, communicate clearly with colleagues, and support daily office responsibilities.';
  const f = fixture({ rows: [{ ...candidates[0], title: role, description: jdText }] });
  try {
    await makeCheckedLetter(f, 0, { role, jdText });
    const wave = await reviewWave({ waveId: 'ambiguous-override-wave', items: entries(f, [0]).map((item) => ({
      ...item, cvOverride: { variant: 'master', reason: 'Owner reviewed the general CV.' },
    })) }, { root: f.root, liveness: livenessStub() });
    assert.deepEqual(wave.items[0].problems, []);
    assert.match(wave.items[0].cvAutomatic.error, /CV role family is ambiguous/);
    assert.match(readFileSync(wave.reviewPath, 'utf8'), /automatic: CV role family is ambiguous/);
    const result = await approveWave({ waveId: wave.waveId, confirm: wave.waveHash }, { root: f.root });
    assert.equal(result.items[0].outcome, 'prepared', result.items[0].error);
    assert.equal(loadBatchState(f.batches[0].manifestPath, { root: f.root }).state.candidates[0].artifacts.cv.sourceCvVariant, 'master');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('approval rejects a plan that changes the reviewed CV, reason, or override decision', async () => {
  const f = fixture();
  try {
    await makeCheckedLetter(f, 0);
    const cvOverride = { variant: 'data_engineering', reason: 'Owner explicitly reviewed this CV.' };
    const cases = [
      { name: 'cv', override: { ...cvOverride, variant: 'master' }, error: /not the reviewed CV/ },
      { name: 'reason', override: { ...cvOverride, reason: 'Changed after owner review.' }, error: /override does not match/ },
      { name: 'decision', override: null, error: /override does not match/ },
    ];
    for (const entry of cases) {
      const wave = await reviewWave({ waveId: `plan-override-${entry.name}`, items: entries(f, [0]).map((item) => ({ ...item, cvOverride })) },
        { root: f.root, liveness: livenessStub() });
      const result = await approveWave({ waveId: wave.waveId, confirm: wave.waveHash }, {
        root: f.root,
        createPlan: (options) => createDocumentPlan({ ...options, cvOverride: entry.override }),
      });
      assert.equal(result.items[0].outcome, 'failed', entry.name);
      assert.match(result.items[0].error, entry.error);
      assertNothingBound(f);
    }
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

test('a valid replacement swapped after review checks fails before planning or binding', async () => {
  const f = fixture();
  try {
    const reviewedCheck = await makeCheckedLetter(f, 0);
    const replacementCheck = await makeCheckedLetter(f, 0, { signature: 'Another Synthetic Candidate' });
    f.checkPaths[0] = reviewedCheck;
    await makeCheckedLetter(f, 1);
    const wave = await reviewWave({ waveId: 'approval-race-wave', items: entries(f) }, { root: f.root, liveness: livenessStub() });
    const result = await approveWave({ waveId: wave.waveId, confirm: wave.waveHash }, {
      root: f.root,
      approveLetter: async (checkPath, options) => {
        if (checkPath === reviewedCheck) {
          replaceCheckedPair(checkPath, replacementCheck);
          return approveCoverLetterV2(checkPath, options);
        }
        return approveCoverLetterV2(checkPath, options);
      },
    });
    assert.equal(result.items[0].outcome, 'failed');
    assert.match(result.items[0].error, /differs from the reviewed letter; refusing approval/);
    assert.equal(existsSync(reviewedCheck.replace(/.check.json$/, '.approved.json')), false, 'no approval record for the unreviewed replacement');
    assertNothingBound(f);
    assert.equal(result.items[1].outcome, 'prepared');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('existing approval hashes must match the reviewed item, including an optional JD hash', async () => {
  const f = fixture();
  try {
    const checkPath = await makeCheckedLetter(f, 0, { preapprove: true });
    const approvalPath = checkPath.replace(/\.check\.json$/, '.approved.json');
    const original = JSON.parse(readFileSync(approvalPath, 'utf8'));
    for (const key of ['draftHash', 'textHash', 'pdfHash', 'jdHash']) {
      const wave = await reviewWave({ waveId: `mismatch-${key}`, items: entries(f, [0]) }, { root: f.root, liveness: livenessStub() });
      const changed = JSON.stringify({ ...original, [key]: '0'.repeat(64) });
      writeFileSync(approvalPath, changed);
      const result = await approveWave({ waveId: wave.waveId, confirm: wave.waveHash }, { root: f.root });
      assert.equal(result.items[0].outcome, 'failed', key);
      assert.match(result.items[0].error, /approval.*(?:does not match|changed since review)/i);
      assert.equal(readFileSync(approvalPath, 'utf8'), changed);
      assertNothingBound(f);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a plan for a valid replacement pair cannot bind under the reviewed wave hash', async () => {
  const f = fixture();
  try {
    const reviewedCheck = await makeCheckedLetter(f, 0, { preapprove: true });
    const replacementCheck = await makeCheckedLetter(f, 0, { signature: 'Another Synthetic Candidate', preapprove: true });
    f.checkPaths[0] = reviewedCheck;
    const wave = await reviewWave({ waveId: 'plan-race-wave', items: entries(f, [0]) }, { root: f.root, liveness: livenessStub() });
    let replacementPlan;
    const result = await approveWave({ waveId: wave.waveId, confirm: wave.waveHash }, {
      root: f.root,
      createPlan: (options) => {
        replacementPlan = createDocumentPlan({
          ...options, coverV2Approved: replacementCheck.replace(/\.check\.json$/, '.approved.json'),
        });
        return replacementPlan;
      },
    });
    assert.equal(replacementPlan.documentState, 'ready');
    assert.equal(result.items[0].outcome, 'failed');
    assert.match(result.items[0].error, /Document plan cover-letter draftHash does not match the reviewed letter/);
    assertNothingBound(f);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a plan must reference the exact approval record verified for the wave', async () => {
  const f = fixture();
  try {
    await makeCheckedLetter(f, 0, { preapprove: true });
    const wave = await reviewWave({ waveId: 'plan-record-wave', items: entries(f, [0]) }, { root: f.root, liveness: livenessStub() });
    const result = await approveWave({ waveId: wave.waveId, confirm: wave.waveHash }, {
      root: f.root,
      createPlan: (options) => {
        // Simulate replacing the record after wave verification while keeping the same letter hashes.
        const record = JSON.parse(readFileSync(options.coverV2Approved, 'utf8'));
        record.approvedAt = '2020-01-01T00:00:00.000Z';
        writeFileSync(options.coverV2Approved, JSON.stringify(record));
        return createDocumentPlan(options);
      },
    });
    assert.equal(result.items[0].outcome, 'failed');
    assert.match(result.items[0].error, /approval record changed after verification/);
    assertNothingBound(f);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('review rejects an external output link before creating application-waves', async (t) => {
  const container = mkdtempSync(join(tmpdir(), 'career-ops-wave-link-'));
  const root = join(container, 'root');
  const outside = join(container, 'outside');
  try {
    mkdirSync(root);
    mkdirSync(outside);
    if (!linkDirectory(t, outside, join(root, 'output'))) return;
    await assert.rejects(reviewWave({
      waveId: 'escape-wave', items: [{ batchId: 'missing-batch', checkPath: 'missing.check.json' }],
    }, { root, liveness: livenessStub() }), /Wave output directory escapes the project root/);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test('approval rejects an external documents link before creating the candidate directory', async (t) => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'career-ops-wave-outside-'));
  try {
    await makeCheckedLetter(f, 0, { preapprove: true });
    const wave = await reviewWave({ waveId: 'plan-link-wave', items: entries(f, [0]) }, { root: f.root, liveness: livenessStub() });
    if (!linkDirectory(t, outside, join(dirname(f.batches[0].manifestPath), 'documents'))) return;
    const result = await approveWave({ waveId: wave.waveId, confirm: wave.waveHash }, { root: f.root });
    assert.equal(result.items[0].outcome, 'failed');
    assert.match(result.items[0].error, /Document plan directory escapes the project root/);
    assertNothingBound(f);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
