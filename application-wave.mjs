#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  confirmPreflight,
  loadBatchState,
  loadPreparationContract,
  ROOT,
} from './application-batch.mjs';
import {
  createDocumentPlan,
  immutableCandidateJdHash,
  prepareAndBindDocuments,
} from './application-documents.mjs';
import { hashFile, sha256Canonical } from './application-integrity.mjs';
import { loadApplicationProfile, selectApprovedCv } from './application-profile.mjs';
import { checkLivenessViaApi } from './liveness-api.mjs';
import { MAX_SHARED_BROWSER_CANDIDATES, manifestPathForBatch } from './application-shared-browser.mjs';
import { approveCoverLetterV2 } from './cover-letter-v2.mjs';

const WAVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const HASH_PREFIX = 'sha256:';

function within(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function rootFile(root, path, label) {
  const rootReal = realpathSync(resolve(root));
  const lexical = resolve(rootReal, path);
  if (!within(rootReal, lexical)) throw new Error(`${label} must stay inside the project root`);
  if (!existsSync(lexical) || !statSync(lexical).isFile()) throw new Error(`${label} is missing or not a regular file: ${path}`);
  const actual = realpathSync(lexical);
  if (!within(rootReal, actual)) throw new Error(`${label} symlink escapes the project root`);
  return actual;
}

function rootRelative(root, path) {
  return relative(realpathSync(resolve(root)), resolve(path)).split(sep).join('/');
}

function fromRoot(root, path) {
  const fullPath = resolve(root, path);
  if (!within(resolve(root), fullPath)) throw new Error(`Stored path escapes the project root: ${path}`);
  return fullPath;
}

function addProblem(item, message) {
  if (message && !item.problems.includes(message)) item.problems.push(message);
}

function normalizedIdentity(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function validSidecarHash(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}

function hashHex(path) {
  return hashFile(path).sha256.slice(HASH_PREFIX.length);
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inspectLetter(root, checkPath, company, title) {
  const fullCheckPath = rootFile(root, checkPath, 'Cover-letter check sidecar');
  if (!fullCheckPath.endsWith('.check.json')) throw new Error('Letter review requires a .check.json sidecar');
  const sidecar = JSON.parse(readFileSync(fullCheckPath, 'utf8').replace(/^\uFEFF/, ''));
  const stem = basename(fullCheckPath, '.check.json');
  const textPath = join(dirname(fullCheckPath), `${stem}.txt`);
  const pdfPath = join(dirname(fullCheckPath), `${stem}.pdf`);
  const sidecarFilePath = (key, expected) => {
    const supplied = sidecar.files?.[key];
    if (typeof supplied !== 'string' || !supplied.trim()) throw new Error(`Check sidecar is missing files.${key}`);
    const resolved = resolve(dirname(fullCheckPath), supplied);
    if (!samePath(resolved, expected) || !samePath(dirname(resolved), dirname(fullCheckPath))) {
      throw new Error(`Check sidecar does not reference its matching ${key === 'text' ? 'text' : 'PDF'} file`);
    }
    return rootFile(root, resolved, `Cover-letter ${key}`);
  };
  const actualTextPath = sidecarFilePath('text', textPath);
  const actualPdfPath = sidecarFilePath('pdf', pdfPath);
  const text = readFileSync(actualTextPath, 'utf8');
  const item = {
    sidecar,
    text,
    checkPath: fullCheckPath,
    textPath: actualTextPath,
    pdfPath: actualPdfPath,
    checkSidecarSha256: hashFile(fullCheckPath).sha256,
    problems: [],
  };
  if (sidecar.status !== 'pass' || !Array.isArray(sidecar.checks) || !sidecar.checks.length
      || sidecar.checks.some((check) => check?.status !== 'pass')) {
    addProblem(item, 'The cover-letter check sidecar is not fully passing.');
  }
  for (const key of ['draftHash', 'jdHash', 'textHash', 'pdfHash']) {
    if (!validSidecarHash(sidecar[key])) addProblem(item, `The check sidecar has an invalid ${key}.`);
  }
  if (validSidecarHash(sidecar.textHash) && hashHex(actualTextPath) !== sidecar.textHash) {
    addProblem(item, 'The cover-letter text hash does not match its check sidecar.');
  }
  if (validSidecarHash(sidecar.pdfHash) && hashHex(actualPdfPath) !== sidecar.pdfHash) {
    addProblem(item, 'The cover-letter PDF hash does not match its check sidecar.');
  }
  const [letterCompany, letterRole] = text.replace(/^\uFEFF/, '').split(/\r?\n/, 3);
  if (normalizedIdentity(letterCompany) !== normalizedIdentity(company)) {
    addProblem(item, 'The checked letter company does not match the batch candidate.');
  }
  if (normalizedIdentity(letterRole) !== normalizedIdentity(title)) {
    addProblem(item, 'The checked letter role does not match the batch candidate.');
  }
  if (sidecar.company != null && normalizedIdentity(sidecar.company) !== normalizedIdentity(company)) {
    addProblem(item, 'The check sidecar company does not match the batch candidate.');
  }
  if (sidecar.role != null && normalizedIdentity(sidecar.role) !== normalizedIdentity(title)) {
    addProblem(item, 'The check sidecar role does not match the batch candidate.');
  }
  return item;
}

function selectDocumentCv(root, contract) {
  const sourceRow = contract.sourceCandidate.sourceRow || {};
  const jdValue = sourceRow.description ?? sourceRow.jobDescription;
  if (typeof jdValue !== 'string') throw new Error('Exact JD evidence is unavailable for CV selection');
  const jdText = jdValue.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (jdText.length < 120) throw new Error('Exact JD evidence is too short for document preparation');
  const profile = loadApplicationProfile(root);
  return selectApprovedCv(profile, contract.candidate, jdText);
}

function validateWaveId(value) {
  if (!WAVE_ID_RE.test(String(value || ''))) throw new Error('Wave ID must match [A-Za-z0-9][A-Za-z0-9._-]{0,79}');
  return value;
}

export function parseApplicationWaveArgs(argv) {
  const command = argv.shift();
  if (!['review', 'approve'].includes(command)) throw new Error('Expected review or approve');
  const options = { command, items: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--wave-id' && options.waveId == null) options.waveId = value;
    else if (command === 'review' && flag === '--item') options.items.push(value);
    else if (command === 'approve' && flag === '--confirm' && options.confirm == null) options.confirm = value;
    else if (command === 'approve' && flag === '--claims-manifest' && options.claimManifestPath == null) options.claimManifestPath = value;
    else throw new Error(`Unknown or duplicate option: ${flag}`);
    index += 1;
  }
  validateWaveId(options.waveId);
  if (command === 'review') {
    if (options.items.length < 1 || options.items.length > MAX_SHARED_BROWSER_CANDIDATES) {
      throw new Error(`Review requires 1-${MAX_SHARED_BROWSER_CANDIDATES} --item values`);
    }
    const pairs = options.items.map((value) => {
      const separator = value.indexOf('=');
      if (separator < 1 || separator === value.length - 1) throw new Error(`Invalid --item value: ${value}`);
      return { batchId: value.slice(0, separator), checkPath: value.slice(separator + 1) };
    });
    if (new Set(pairs.map(({ batchId }) => batchId)).size !== pairs.length) throw new Error('Duplicate batch IDs are not allowed');
    options.items = pairs;
  } else if (!options.confirm) throw new Error('Approve requires --confirm <waveHash>');
  return options;
}

async function reviewOne(root, { batchId, checkPath }, liveness) {
  let manifestPath = null;
  const item = {
    batchId,
    manifestPath: null,
    manifestScopeHash: null,
    candidateId: null,
    company: null,
    title: null,
    listingUrl: null,
    checkPath: null,
    checkSidecarSha256: null,
    textPath: null,
    pdfPath: null,
    draftHash: null,
    jdHash: null,
    textHash: null,
    pdfHash: null,
    cvFilename: null,
    cvSha256: null,
    liveness: null,
    problems: [],
  };
  let loaded = null;
  let contract = null;
  let letter = null;
  try {
    manifestPath = rootFile(root, manifestPathForBatch(root, batchId), 'Application-batch manifest');
    item.manifestPath = rootRelative(root, manifestPath);
    loaded = loadBatchState(manifestPath, { root });
    if (loaded.manifest.batchId !== batchId) throw new Error('Batch directory and manifest IDs do not match.');
    item.manifestScopeHash = loaded.manifest.scopeHash;
    if (loaded.manifest.expectedCandidateCount !== 1 || loaded.manifest.candidates.length !== 1
        || loaded.state.candidates.length !== 1) {
      addProblem(item, 'Wave items must be exact one-candidate batches.');
    } else {
      const candidate = loaded.manifest.candidates[0];
      const state = loaded.state.candidates[0];
      item.candidateId = candidate.candidate_id;
      item.company = candidate.company;
      item.title = candidate.title;
      item.listingUrl = candidate.listingUrl;
      if (state.state === 'abandoned') addProblem(item, 'The application batch candidate is abandoned.');
      else if (state.state !== 'not_opened') addProblem(item, `Candidate state ${state.state} is not available for document preparation.`);
      if (state.state === 'not_opened') {
        try {
          contract = loadPreparationContract(manifestPath, candidate.candidate_id, { root });
        } catch (error) {
          addProblem(item, `Cannot load the document preparation contract: ${error.message}`);
        }
      }
    }
  } catch (error) {
    addProblem(item, `Cannot load application batch: ${error.message}`);
  }
  try {
    const fullCheckPath = rootFile(root, checkPath, 'Cover-letter check sidecar');
    item.checkPath = rootRelative(root, fullCheckPath);
    letter = inspectLetter(root, fullCheckPath, item.company, item.title);
    item.checkSidecarSha256 = letter.checkSidecarSha256;
    item.textPath = rootRelative(root, letter.textPath);
    item.pdfPath = rootRelative(root, letter.pdfPath);
    for (const problem of letter.problems) addProblem(item, problem);
    for (const key of ['draftHash', 'jdHash', 'textHash', 'pdfHash']) item[key] = letter.sidecar[key] ?? null;
  } catch (error) {
    addProblem(item, `Cannot inspect checked letter: ${error.message}`);
  }
  if (contract && letter) {
    const jdHash = immutableCandidateJdHash(contract.sourceCandidate);
    if (!jdHash) addProblem(item, 'The batch has no immutable stored JD hash.');
    else if (letter.sidecar.jdHash !== jdHash) addProblem(item, 'The letter was checked against a different JD than the immutable batch candidate.');
    try {
      const cv = selectDocumentCv(root, contract);
      const cvPath = rootFile(root, cv.path, 'Selected approved CV');
      item.cvFilename = basename(cvPath);
      item.cvSha256 = hashFile(cvPath).sha256;
    } catch (error) {
      addProblem(item, `Cannot resolve the approved CV selected for this document plan: ${error.message}`);
    }
  }
  if (item.listingUrl) {
    try {
      const result = await liveness(item.listingUrl);
      item.liveness = { result: result?.result || 'unknown', reason: result?.reason || '' };
      if (result?.result === 'expired') addProblem(item, `Listing liveness is expired${result.reason ? `: ${result.reason}` : '.'}`);
    } catch (error) {
      item.liveness = { result: 'error', reason: error.message || String(error) };
    }
  }
  return { item, letterText: letter?.text || '' };
}

function letterFence(text) {
  const runs = [...String(text).matchAll(/`+/g)].map((match) => match[0].length);
  return '`'.repeat(Math.max(3, ...runs.map((length) => length + 1)));
}

function buildReviewMarkdown(waveId, items, waveHash) {
  const lines = [`# Application wave ${waveId}`, ''];
  for (const { item, letterText } of items) {
    lines.push(`## ${item.company || item.batchId} — ${item.title || 'Candidate unavailable'}`, '');
    lines.push(`- Batch: ${item.batchId}`, `- Candidate: ${item.candidateId || '(unavailable)'}`,
      `- Listing: ${item.listingUrl || '(unavailable)'}`, `- CV: ${item.cvFilename || '(unavailable)'}`,
      `- Liveness: ${item.liveness ? `${item.liveness.result}${item.liveness.reason ? ` — ${item.liveness.reason}` : ''}` : '(not checked)'}`,
      `- Approval: ${item.problems.length ? '**NOT APPROVABLE**' : '**Ready for approval**'}`,
      `- Problems: ${item.problems.length ? item.problems.map((problem) => `\`${problem.replace(/`/g, "'")}\``).join('; ') : 'None.'}`,
      '', '### Full checked letter', '');
    const fence = letterFence(letterText);
    lines.push(fence + 'text', letterText, fence, '');
  }
  lines.push('## Approve this wave', '', `Run exactly: \`node application-wave.mjs approve --wave-id ${waveId} --confirm ${waveHash}\``,
    '', `Wave hash: \`${waveHash}\``, '');
  return lines.join('\n');
}

function makeWaveDirectory(root, waveId) {
  const wavesParent = join(resolve(root), 'output', 'application-waves');
  mkdirSync(wavesParent, { recursive: true });
  if (!within(realpathSync(resolve(root)), realpathSync(wavesParent))) throw new Error('Wave output directory escapes the project root');
  const waveDir = join(wavesParent, waveId);
  mkdirSync(waveDir);
  if (!within(realpathSync(resolve(root)), realpathSync(waveDir))) throw new Error('Wave directory escapes the project root');
  return waveDir;
}

export async function reviewWave({ waveId, items }, { root = ROOT, liveness = checkLivenessViaApi } = {}) {
  validateWaveId(waveId);
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_SHARED_BROWSER_CANDIDATES) {
    throw new Error(`Review requires 1-${MAX_SHARED_BROWSER_CANDIDATES} items`);
  }
  if (new Set(items.map(({ batchId }) => batchId)).size !== items.length) throw new Error('Duplicate batch IDs are not allowed');
  const reviewed = [];
  for (const entry of items) reviewed.push(await reviewOne(root, entry, liveness));
  const waveItems = reviewed.map(({ item }) => item);
  const waveHash = sha256Canonical(waveItems);
  const wave = { schemaVersion: 1, waveId, items: waveItems, waveHash };
  const waveDir = makeWaveDirectory(root, waveId);
  writeFileSync(join(waveDir, 'wave.json'), `${JSON.stringify(wave, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  writeFileSync(join(waveDir, 'review.md'), buildReviewMarkdown(waveId, reviewed, waveHash), { encoding: 'utf8', flag: 'wx' });
  return { ...wave, reviewPath: join(waveDir, 'review.md') };
}

function checkCurrentWave(root, waveId, confirm) {
  const waveDir = rootFile(root, join('output', 'application-waves', waveId, 'wave.json'), 'Reviewed wave');
  const wave = JSON.parse(readFileSync(waveDir, 'utf8').replace(/^\uFEFF/, ''));
  if (wave.waveId !== waveId || !Array.isArray(wave.items)
      || wave.waveHash !== sha256Canonical(wave.items)) throw new Error('Stored wave integrity check failed');
  if (confirm !== wave.waveHash) throw new Error(`Confirmation hash mismatch; expected ${wave.waveHash}`);
  return wave;
}

function assertNoReviewChanges(root, item) {
  const manifestPath = rootFile(root, fromRoot(root, item.manifestPath), 'Application-batch manifest');
  if (!samePath(manifestPath, manifestPathForBatch(root, item.batchId))) throw new Error('Stored manifest path does not match the exact batch ID');
  const loaded = loadBatchState(manifestPath, { root });
  if (loaded.manifest.batchId !== item.batchId || loaded.manifest.scopeHash !== item.manifestScopeHash) {
    throw new Error('Application-batch manifest changed since review');
  }
  if (loaded.manifest.expectedCandidateCount !== 1 || loaded.manifest.candidates.length !== 1
      || loaded.state.candidates.length !== 1) throw new Error('Batch is no longer an exact one-candidate batch');
  const candidate = loaded.manifest.candidates[0];
  if (candidate.candidate_id !== item.candidateId || candidate.company !== item.company
      || candidate.title !== item.title || candidate.listingUrl !== item.listingUrl) {
    throw new Error('Exact batch candidate changed since review');
  }
  const contract = loadPreparationContract(manifestPath, item.candidateId, { root });
  const checkPath = rootFile(root, fromRoot(root, item.checkPath), 'Cover-letter check sidecar');
  const letter = inspectLetter(root, checkPath, candidate.company, candidate.title);
  if (letter.problems.length) throw new Error(letter.problems.join(' '));
  if (letter.checkSidecarSha256 !== item.checkSidecarSha256) throw new Error('Cover-letter check sidecar changed since review');
  for (const key of ['draftHash', 'jdHash', 'textHash', 'pdfHash']) {
    if (letter.sidecar[key] !== item[key]) throw new Error(`Cover-letter ${key} changed since review`);
  }
  if (rootRelative(root, letter.textPath) !== item.textPath || rootRelative(root, letter.pdfPath) !== item.pdfPath) {
    throw new Error('Cover-letter file paths changed since review');
  }
  const jdHash = immutableCandidateJdHash(contract.sourceCandidate);
  if (!jdHash || letter.sidecar.jdHash !== jdHash || item.jdHash !== jdHash) {
    throw new Error('Letter JD hash no longer matches the immutable batch candidate JD evidence');
  }
  const cv = selectDocumentCv(root, contract);
  const cvPath = rootFile(root, cv.path, 'Selected approved CV');
  if (basename(cvPath) !== item.cvFilename || hashFile(cvPath).sha256 !== item.cvSha256) {
    throw new Error('Selected approved CV changed since review');
  }
  return { manifestPath, candidate, checkPath, letter };
}

function matchingApproval(root, checkPath, sidecar) {
  const approvalPath = rootFile(root, join(dirname(checkPath), `${basename(checkPath, '.check.json')}.approved.json`), 'Cover-letter approval record');
  const approval = JSON.parse(readFileSync(approvalPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!Number.isFinite(Date.parse(approval.approvedAt || ''))
      || !['draftHash', 'textHash', 'pdfHash'].every((key) => approval[key] === sidecar[key])) {
    throw new Error('Existing cover-letter approval record does not match its check sidecar');
  }
  return approvalPath;
}

function writeOrReusePlan(root, manifestPath, candidateId, plan) {
  const planPath = join(dirname(manifestPath), 'documents', candidateId, 'plan.json');
  const planDir = dirname(planPath);
  mkdirSync(planDir, { recursive: true });
  if (!within(realpathSync(resolve(root)), realpathSync(planDir))) throw new Error('Document plan directory escapes the project root');
  if (existsSync(planPath)) {
    if (!statSync(planPath).isFile()) throw new Error('Existing plan path is not a regular file');
    const existingPath = rootFile(root, planPath, 'Existing document plan');
    const existing = JSON.parse(readFileSync(existingPath, 'utf8').replace(/^\uFEFF/, ''));
    if (existing.planHash !== plan.planHash) throw new Error('A different document plan already exists; refusing to overwrite it');
    return { plan: existing, planPath };
  }
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { plan, planPath };
}

async function approveOne(root, item, claimManifestPath) {
  const current = assertNoReviewChanges(root, item);
  const approvedPath = join(dirname(current.checkPath), `${basename(current.checkPath, '.check.json')}.approved.json`);
  const approval = existsSync(approvedPath)
    ? matchingApproval(root, current.checkPath, current.letter.sidecar)
    : (await approveCoverLetterV2(current.checkPath)).approvedPath;
  const plan = createDocumentPlan({
    manifestPath: current.manifestPath,
    candidateId: item.candidateId,
    coverV2Approved: approval,
    claimManifestPath,
    root,
  });
  // The reviewed CV preview must be the CV the document plan actually binds.
  if (basename(plan.cv.path) !== item.cvFilename || plan.cv.sha256 !== item.cvSha256) {
    throw new Error(`Document plan selected ${basename(plan.cv.path)}, not the reviewed CV ${item.cvFilename}`);
  }
  const saved = writeOrReusePlan(root, current.manifestPath, item.candidateId, plan);
  const prepared = await prepareAndBindDocuments({
    manifestPath: current.manifestPath,
    candidateId: item.candidateId,
    plan: saved.plan,
    confirmPlanHash: saved.plan.planHash,
    root,
  });
  const preflight = confirmPreflight(current.manifestPath, item.batchId, { root });
  return { outcome: 'prepared', error: null, planHash: prepared.planHash, preflight: preflight.status };
}

function resolveClaimManifest(root, claimManifestPath) {
  if (claimManifestPath) return rootFile(root, claimManifestPath, 'Claim manifest');
  const defaultPath = join(resolve(root), 'data', 'cv-claim-anchors.json');
  return existsSync(defaultPath) ? rootFile(root, defaultPath, 'Claim manifest') : null;
}

export async function approveWave({ waveId, confirm, claimManifestPath = null }, { root = ROOT } = {}) {
  validateWaveId(waveId);
  const wave = checkCurrentWave(root, waveId, confirm);
  const waveDir = join(resolve(root), 'output', 'application-waves', waveId);
  if (!within(realpathSync(resolve(root)), realpathSync(waveDir))) throw new Error('Wave directory escapes the project root');
  const approvalPath = join(waveDir, 'approval.json');
  if (existsSync(approvalPath)) throw new Error(`Wave approval already exists: ${rootRelative(root, approvalPath)}`);
  const claims = resolveClaimManifest(root, claimManifestPath);
  const outcomes = [];
  for (const item of wave.items) {
    if (item.problems?.length) {
      outcomes.push({ batchId: item.batchId, candidateId: item.candidateId, outcome: 'not_approvable', error: item.problems.join(' ') });
      continue;
    }
    try {
      outcomes.push({ batchId: item.batchId, candidateId: item.candidateId, ...await approveOne(root, item, claims) });
    } catch (error) {
      outcomes.push({ batchId: item.batchId, candidateId: item.candidateId, outcome: 'failed', error: error.message || String(error) });
    }
  }
  const report = { schemaVersion: 1, waveId, waveHash: wave.waveHash, approvedAt: new Date().toISOString(), items: outcomes };
  writeFileSync(approvalPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const ready = outcomes.filter((item) => item.outcome === 'prepared').map((item) => item.batchId);
  return {
    ...report,
    approvalPath,
    sharedBrowserCommand: ready.length
      ? `node application-shared-browser.mjs ${ready.map((batchId) => `--batch-id ${batchId}`).join(' ')}`
      : null,
  };
}

async function main() {
  const options = parseApplicationWaveArgs(process.argv.slice(2));
  if (options.command === 'review') {
    const wave = await reviewWave(options);
    console.log(`Wave hash: ${wave.waveHash}`);
    console.log(`Review: ${rootRelative(ROOT, wave.reviewPath)}`);
    return;
  }
  const result = await approveWave(options);
  for (const item of result.items) {
    console.log(`${item.batchId}: ${item.outcome}${item.error ? ` — ${item.error}` : ''}`);
  }
  if (result.sharedBrowserCommand) console.log(result.sharedBrowserCommand);
  else console.log('No fully prepared batches; no shared-browser command is available.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
