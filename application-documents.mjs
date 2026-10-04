#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHtml, coverLetterFilename } from './generate-cover-letter.mjs';
import { hashFile, sha256Canonical } from './application-integrity.mjs';
import {
  bindCandidateArtifacts,
  bindVerifiedCombinedArtifact,
  acquireBatchExecutionLock,
  loadBatchState,
  loadPreparationContract,
  ROOT,
} from './application-batch.mjs';
import { loadApplicationProfile, selectApprovedCv } from './application-profile.mjs';
import { generateCustomNarrativeAnswer, normalizeFormQuestion } from './application-form-policy.mjs';
import {
  createNarrativeProvenanceRecord,
  NarrativeEvidenceUnavailableError,
  revalidateFactualEvidence,
  validateNarrativeProvenanceRecord,
} from './application-evidence.mjs';
import { mergeApplicationPdfs } from './application-pdf.mjs';

export const APPLICATION_DOCUMENT_PLAN_SCHEMA_VERSION = 3;
export const COVER_LETTER_TEMPLATE_ID = 'cover-letter-v1';

function clean(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function safeReadableStem(company, title) {
  const value = `${company} ${title}`
    .replace(/[_%]/g, ' ')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!value) throw new Error('Cannot derive a readable document filename');
  return value.slice(0, 150).trim();
}

function resolveJdEvidence(root, sourceCandidate, jdFile) {
  const embedded = clean(sourceCandidate.sourceRow?.description ?? sourceCandidate.sourceRow?.jobDescription);
  if (!jdFile && embedded.length >= 120) {
    return {
      kind: 'source_candidate',
      path: null,
      text: embedded,
      sha256: sha256Canonical({ description: embedded }),
      size: Buffer.byteLength(embedded),
    };
  }
  if (!jdFile) throw new Error('Exact JD evidence is required: source candidate has no complete description; provide --jd-file');
  const lexical = resolve(root, jdFile);
  if (!inside(resolve(root), lexical)) throw new Error('JD file must stay inside the Career-Ops project');
  if (!existsSync(lexical) || !statSync(lexical).isFile()) throw new Error(`JD file is missing or not a regular file: ${jdFile}`);
  const real = realpathSync(lexical);
  if (!inside(realpathSync(resolve(root)), real)) throw new Error('JD file symlink escapes the Career-Ops project');
  const text = readFileSync(real, 'utf8').replace(/^\uFEFF/, '').trim();
  if (text.length < 120) throw new Error('JD evidence is too short to ground document preparation');
  return { kind: 'jd_file', path: real, text, ...hashFile(real) };
}

function jdRequirements(jdText, limit = 4) {
  const known = [
    'Python', 'SQL', 'PostgreSQL', 'ETL', 'data pipelines', 'Django', 'REST APIs', 'React', 'Next.js',
    'TypeScript', 'PyTorch', 'Hugging Face', 'machine learning', 'computer vision', 'Linux', 'Git',
    'data validation', 'dimensional modeling', 'analytics', 'backend development',
  ];
  return known.filter((term) => jdText.toLowerCase().includes(term.toLowerCase())).slice(0, limit);
}

export function buildGroundedCoverLetter(profile, candidate, jdText, cvSelection, now = new Date()) {
  const requirements = jdRequirements(jdText);
  const requirementText = requirements.length
    ? requirements.join(', ')
    : 'the practical responsibilities described in the job description';
  const narrative = generateCustomNarrativeAnswer(profile, {
    question: `Why are you a good fit for this ${candidate.title} role?`,
    candidate,
    jdText,
  });
  const factualEvidence = revalidateFactualEvidence(profile, narrative.factualSources);
  const paragraphs = [
    'Dear Hiring Team,',
    `I am applying for the ${candidate.title} role at ${candidate.company}.`,
    narrative.answer,
    `The job description emphasizes ${requirementText}. I would welcome an interview to discuss the role and the factual examples above.`,
    'Thank you for considering my application.',
  ].map((paragraph) => paragraph.replace(/—/g, ',')).filter(Boolean);
  const body = paragraphs.join('\n\n');
  const banned = profile.raw.narrative?.banned_phrases || [];
  for (const phrase of banned) {
    if (body.toLowerCase().includes(String(phrase).toLowerCase())) throw new Error(`Cover letter contains banned phrase: ${phrase}`);
  }
  if (body.includes('—')) throw new Error('Cover letter may not contain em dashes');
  const provenance = createNarrativeProvenanceRecord({
    candidateId: candidate.candidate_id,
    normalizedQuestion: normalizeFormQuestion('cover letter document'),
    answer: body,
    wording: 'generated',
    templateId: COVER_LETTER_TEMPLATE_ID,
    factualEvidence,
  });
  return {
    text: body,
    provenance,
    payload: {
      candidate: {
        name: profile.candidate.full_name,
        location: profile.candidate.location,
        email: profile.candidate.email,
        phone: profile.candidate.phone,
        linkedin: profile.candidate.linkedin,
        github: profile.candidate.github,
      },
      letter: {
        role_title: candidate.title,
        company: candidate.company,
        date: now.toISOString().slice(0, 10),
        greeting: paragraphs[0],
        opening: paragraphs[1],
        profile_intro: paragraphs[2],
        achievements: [],
        problems_section: paragraphs[3],
        closing: paragraphs[4],
      },
      audit: {
        schemaVersion: 2,
        narrativeProvenance: provenance,
        wordCount: body.split(/\s+/).filter(Boolean).length,
        requirements,
        selectedCvVariant: cvSelection.variant,
      },
    },
  };
}

function documentSourceHashes(profile) {
  return Object.fromEntries(['profile', 'cv'].map((key) => {
    const value = profile.sourceFiles[key];
    if (!value) throw new Error(`Required document source is unavailable: ${key}`);
    return [key, { path: value.path, sha256: value.sha256, size: value.size }];
  }));
}

function reviewRequiredFor(error) {
  return {
    state: 'review_required',
    code: 'narrative_evidence_migration_required',
    reason: `Automatic cover-letter generation is unavailable: ${error.message}`,
    action: 'Review the narrative field and migrate application_form.narrative_evidence to stable factual CV/profile provenance.',
  };
}

export function createDocumentPlan({ manifestPath, candidateId, jdFile = null, root = ROOT, now = new Date() }) {
  const contract = loadPreparationContract(manifestPath, candidateId, { root });
  const profile = loadApplicationProfile(root);
  const jd = resolveJdEvidence(root, contract.sourceCandidate, jdFile);
  const cvSelection = selectApprovedCv(profile, contract.candidate, jd.text);
  const documentsDir = join(dirname(contract.manifestPath), 'documents', contract.candidate.candidate_id);
  const basePlan = {
    schemaVersion: APPLICATION_DOCUMENT_PLAN_SCHEMA_VERSION,
    batchId: contract.manifest.batchId,
    sourceRunId: contract.manifest.sourceRunId,
    candidateId: contract.candidate.candidate_id,
    createdAt: now.toISOString(),
    sourceCandidateSha256: contract.candidate.sourceCandidateSha256,
    jd: { kind: jd.kind, path: jd.path, sha256: jd.sha256, size: jd.size },
    sourceHashes: documentSourceHashes(profile),
    cv: {
      variant: cvSelection.variant,
      decision: cvSelection.decision,
      scores: cvSelection.scores,
      path: cvSelection.path,
      ...hashFile(cvSelection.path),
    },
  };
  let plan;
  try {
    const cover = buildGroundedCoverLetter(profile, contract.candidate, jd.text, cvSelection, now);
    const coverPdfFilename = coverLetterFilename(contract.candidate.company);
    plan = {
      ...basePlan,
      documentState: 'ready',
      reviewRequired: null,
      coverLetter: {
        required: true,
        available: true,
        pdfPath: join(documentsDir, coverPdfFilename),
        textPath: join(documentsDir, coverPdfFilename.replace(/\.pdf$/i, '.txt')),
        payload: cover.payload,
        text: cover.text,
        provenance: cover.provenance,
      },
    };
  } catch (error) {
    if (!(error instanceof NarrativeEvidenceUnavailableError)) throw error;
    plan = {
      ...basePlan,
      documentState: 'review_required',
      reviewRequired: reviewRequiredFor(error),
      coverLetter: {
        required: true,
        available: false,
        pdfPath: null,
        textPath: null,
        payload: null,
        text: null,
        provenance: null,
      },
    };
  }
  plan.planHash = sha256Canonical(plan);
  return plan;
}

export function validateDocumentPlan(plan, manifestPath, root = ROOT) {
  if (plan.schemaVersion !== APPLICATION_DOCUMENT_PLAN_SCHEMA_VERSION) throw new Error('Unsupported application document plan schema');
  if (plan.planHash !== sha256Canonical(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planHash')))) {
    throw new Error('Application document plan integrity mismatch');
  }
  const contract = loadPreparationContract(manifestPath, plan.candidateId, { root });
  if (contract.manifest.batchId !== plan.batchId || contract.manifest.sourceRunId !== plan.sourceRunId
      || contract.candidate.sourceCandidateSha256 !== plan.sourceCandidateSha256) {
    throw new Error('Application document plan no longer matches the exact batch candidate');
  }
  const profile = loadApplicationProfile(root);
  const expectedSources = documentSourceHashes(profile);
  if (sha256Canonical(plan.sourceHashes) !== sha256Canonical(expectedSources)) throw new Error('Document source dependencies are stale or over-broad');
  const jd = resolveJdEvidence(root, contract.sourceCandidate, plan.jd?.path || null);
  if (sha256Canonical(plan.jd) !== sha256Canonical({ kind: jd.kind, path: jd.path, sha256: jd.sha256, size: jd.size })) {
    throw new Error('JD changed after planning');
  }
  const cvSelection = selectApprovedCv(profile, contract.candidate, jd.text);
  const expectedCv = {
    variant: cvSelection.variant,
    decision: cvSelection.decision,
    scores: cvSelection.scores,
    path: cvSelection.path,
    ...hashFile(cvSelection.path),
  };
  if (sha256Canonical(plan.cv) !== sha256Canonical(expectedCv)) throw new Error('Selected CV changed after planning');
  if (!['ready', 'review_required'].includes(plan.documentState)) throw new Error('Document plan state is invalid');
  if (plan.documentState === 'review_required') {
    let unavailable;
    try {
      buildGroundedCoverLetter(profile, contract.candidate, jd.text, cvSelection, new Date(plan.createdAt));
    } catch (error) {
      if (error instanceof NarrativeEvidenceUnavailableError) unavailable = error;
      else throw error;
    }
    if (!unavailable) throw new Error('Document review state is stale because grounded cover-letter evidence is now available');
    const expectedReview = reviewRequiredFor(unavailable);
    const expectedCover = { required: true, available: false, pdfPath: null, textPath: null, payload: null, text: null, provenance: null };
    if (sha256Canonical(plan.reviewRequired) !== sha256Canonical(expectedReview)
        || sha256Canonical(plan.coverLetter) !== sha256Canonical(expectedCover)) {
      throw new Error('Document review-required state does not match current narrative evidence');
    }
    return { contract, profile, jd, cvSelection, expectedCover: null };
  }
  if (plan.reviewRequired !== null || plan.coverLetter?.available !== true) throw new Error('Ready document plan has an inconsistent review state');
  if (plan.coverLetter?.provenance?.templateId !== COVER_LETTER_TEMPLATE_ID) {
    throw new Error(`Unsupported cover-letter template ID: ${plan.coverLetter?.provenance?.templateId || '(missing)'}`);
  }
  const expectedCover = buildGroundedCoverLetter(profile, contract.candidate, jd.text, cvSelection, new Date(plan.createdAt));
  validateNarrativeProvenanceRecord(profile, plan.coverLetter.provenance, {
    candidateId: contract.candidate.candidate_id,
    normalizedQuestion: normalizeFormQuestion('cover letter document'),
    answer: plan.coverLetter.text,
  });
  for (const [label, actual, expected] of [
    ['text', plan.coverLetter.text, expectedCover.text],
    ['payload', plan.coverLetter.payload, expectedCover.payload],
    ['provenance', plan.coverLetter.provenance, expectedCover.provenance],
  ]) {
    if (sha256Canonical(actual) !== sha256Canonical(expected)) throw new Error(`Document ${label} does not match deterministic ${COVER_LETTER_TEMPLATE_ID} output`);
  }
  const expectedDocumentsDir = resolve(dirname(contract.manifestPath), 'documents', plan.candidateId);
  for (const path of [plan.coverLetter.pdfPath, plan.coverLetter.textPath]) {
    if (!inside(expectedDocumentsDir, resolve(path))) throw new Error('Planned application document path escapes the exact batch candidate directory');
  }
  const expectedCoverPdf = coverLetterFilename(contract.candidate.company);
  const expectedCoverText = expectedCoverPdf.replace(/\.pdf$/i, '.txt');
  if (basename(plan.coverLetter.pdfPath) !== expectedCoverPdf
      || basename(plan.coverLetter.textPath) !== expectedCoverText
      || /%20/i.test(`${plan.coverLetter.pdfPath}${plan.coverLetter.textPath}`)) {
    throw new Error(`Planned cover letter must use ${expectedCoverPdf} and its matching text filename`);
  }
  return { contract, profile, jd, cvSelection, expectedCover };
}

export async function prepareAndBindDocuments({
  manifestPath,
  candidateId,
  plan,
  confirmPlanHash,
  root = ROOT,
  replace = false,
}) {
  if (candidateId !== plan.candidateId) throw new Error('Document plan candidate does not match the exact requested candidate ID');
  if (confirmPlanHash !== plan.planHash) throw new Error(`Explicit document-plan confirmation must equal ${plan.planHash}`);
  let validation = validateDocumentPlan(plan, manifestPath, root);
  if (plan.documentState !== 'ready') {
    throw new Error(`${plan.reviewRequired.code}: ${plan.reviewRequired.reason}`);
  }
  mkdirSync(dirname(plan.coverLetter.pdfPath), { recursive: true });
  const realDocumentsDir = realpathSync(dirname(plan.coverLetter.pdfPath));
  if (!inside(realpathSync(resolve(root, 'output')), realDocumentsDir)) {
    throw new Error('Batch document directory symlink escapes the approved output directory');
  }
  if ((existsSync(plan.coverLetter.pdfPath) || existsSync(plan.coverLetter.textPath)) && !replace) {
    throw new Error('Planned application documents already exist; use --replace explicitly');
  }
  const { renderHtmlToPdf } = await import('./generate-pdf.mjs');
  validation = validateDocumentPlan(plan, manifestPath, root);
  const html = buildHtml(validation.expectedCover.payload);
  writeFileSync(plan.coverLetter.textPath, `${validation.expectedCover.text}\n`, { flag: replace ? 'w' : 'wx' });
  const rendered = await renderHtmlToPdf(html, plan.coverLetter.pdfPath, {
    format: 'a4', baseDir: root, recordManifest: false,
  });
  if (rendered.pageCount !== 1) throw new Error(`Cover letter must render to exactly one page; rendered ${rendered.pageCount}`);
  validation = validateDocumentPlan(plan, manifestPath, root);
  const records = bindCandidateArtifacts(manifestPath, candidateId, [
    { artifactType: 'cv', filePath: plan.cv.path, sourceCvVariant: plan.cv.variant },
    { artifactType: 'cover_letter', filePath: plan.coverLetter.pdfPath, narrativeProvenance: validation.expectedCover.provenance },
    { artifactType: 'cover_letter_text', filePath: plan.coverLetter.textPath, narrativeProvenance: validation.expectedCover.provenance },
  ], { root, replace });
  return { planHash: plan.planHash, records };
}

export async function prepareAndBindCombinedDocument({
  manifestPath,
  candidateId,
  confirmFormEvidenceHash,
  root = ROOT,
  replace = false,
  lockToken = null,
}) {
  const ownedLock = lockToken ? null : acquireBatchExecutionLock(manifestPath, { root, candidateId, operation: 'bind_artifacts' });
  try {
    const loaded = loadBatchState(manifestPath, { root });
    const index = loaded.manifest.candidates.findIndex((row) => row.candidate_id === candidateId);
    if (index < 0) throw new Error(`Candidate is not in the application batch: ${candidateId}`);
    const candidate = loaded.manifest.candidates[index];
    const state = loaded.state.candidates[index];
    const evidence = state.formPreparation;
    if (state.state !== 'review_required' || evidence?.evidenceHash !== confirmFormEvidenceHash
        || evidence?.uploadTopology?.mode !== 'single_combined') {
      throw new Error('Exact verified single-document form evidence must be confirmed before combining documents');
    }
    const cv = state.artifacts.cv;
    const cover = state.artifacts.coverLetter;
    if (!cv || !cover) throw new Error('Exact bound standalone CV and cover-letter PDFs are required');
    const fieldText = evidence.uploadTopology.fields.map((row) => row.label).join(' ').toLowerCase();
    const order = /cover(?: letter)?\s*(?:and|\+)\s*(?:cv|resume)/.test(fieldText) ? 'cover_then_cv' : 'cv_then_cover';
    const documentsDir = join(dirname(loaded.manifestPath), 'documents', candidateId);
    mkdirSync(documentsDir, { recursive: true });
    const outputPath = join(documentsDir, `${safeReadableStem(candidate.company, candidate.title)} Application Documents.pdf`);
    if (existsSync(outputPath) && !replace) throw new Error('Combined application document already exists; use --replace explicitly');
    const sourceArtifacts = [cv, cover].map((row) => ({ artifactType: row.artifactType, sha256: row.sha256, size: row.size }));
    try {
      const pdf = await mergeApplicationPdfs({ cvPath: cv.resolvedPath, coverLetterPath: cover.resolvedPath, outputPath, order });
      const record = bindVerifiedCombinedArtifact(manifestPath, candidateId, {
        root, filePath: outputPath, formEvidenceHash: confirmFormEvidenceHash,
        sourceArtifacts, replace, lockToken: lockToken || ownedLock.token,
      });
      return { record, pdf, formEvidenceHash: confirmFormEvidenceHash };
    } catch (error) {
      if (existsSync(outputPath) && !state.artifacts.combinedDocument) rmSync(outputPath, { force: true });
      throw error;
    }
  } finally { ownedLock?.release(); }
}

function parseArgs(argv) {
  const result = { replace: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--replace') result.replace = true;
    else if (arg.startsWith('--')) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      result[arg.slice(2)] = value;
    } else throw new Error(`Unexpected argument: ${arg}`);
  }
  return result;
}

function usage() {
  return [
    'Usage:',
    '  node application-documents.mjs plan --manifest <manifest.json> --candidate-id <id> [--jd-file <exact-local-file>]',
    '  node application-documents.mjs prepare --manifest <manifest.json> --candidate-id <id> --plan <plan.json> --confirm-plan <sha256> [--replace]',
    '  node application-documents.mjs combine --manifest <manifest.json> --candidate-id <id> --confirm-form-evidence <sha256> [--replace]',
  ].join('\n');
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') return console.log(usage());
  const options = parseArgs(argv);
  if (command === 'plan') {
    const plan = createDocumentPlan({
      manifestPath: options.manifest,
      candidateId: options['candidate-id'],
      jdFile: options['jd-file'] || null,
    });
    const planPath = join(dirname(resolve(options.manifest)), 'documents', plan.candidateId, 'plan.json');
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({
      plan: planPath,
      planHash: plan.planHash,
      documentState: plan.documentState,
      reviewRequired: plan.reviewRequired,
      cv: basename(plan.cv.path),
    }, null, 2));
    return;
  }
  if (command === 'prepare') {
    const plan = JSON.parse(readFileSync(resolve(options.plan), 'utf8'));
    const result = await prepareAndBindDocuments({
      manifestPath: options.manifest,
      candidateId: options['candidate-id'],
      plan,
      confirmPlanHash: options['confirm-plan'],
      replace: options.replace,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'combine') {
    const result = await prepareAndBindCombinedDocument({
      manifestPath: options.manifest,
      candidateId: options['candidate-id'],
      confirmFormEvidenceHash: options['confirm-form-evidence'],
      replace: options.replace,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
