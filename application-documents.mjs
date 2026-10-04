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
import { mergeApplicationPdfs } from './application-pdf.mjs';

export const APPLICATION_DOCUMENT_PLAN_SCHEMA_VERSION = 1;

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

function answer(profile, heading) {
  const value = profile.answers.get(heading.toLowerCase());
  if (!value) throw new Error(`Canonical answer evidence is missing: ${heading}`);
  return value.replace(/\[tool\]|\[real project\]|\[related skill\]/g, '').trim();
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
  const evidenceByVariant = {
    data_engineering: ['SQL/data experience', 'Data warehouse project', 'Python experience'],
    ai_ml: ['ML experience', 'Deepfake thesis', 'Python experience'],
    software_backend: ['Backend/API experience', 'Saki project', 'Odin Store project'],
    master: ['Tell us about yourself', 'Python experience', 'SQL/data experience'],
  };
  const evidence = evidenceByVariant[cvSelection.variant].map((heading) => ({ heading, text: answer(profile, heading) }));
  const requirementText = requirements.length
    ? requirements.join(', ')
    : 'the practical responsibilities described in the job description';
  const paragraphs = [
    `I am applying for the ${candidate.title} role at ${candidate.company}. The position calls for ${requirementText}, which maps closely to the work I can demonstrate through my studies, internship, and technical projects. I am early in my career, and I am looking for a team where careful implementation and a willingness to learn matter as much as a long list of job titles.`,
    answer(profile, 'Tell us about yourself'),
    ...evidence.map((item) => item.text),
    `What I would bring to ${candidate.company} is a practical way of working: understand the requirement, make the data or feature reliable, validate edge cases, and explain the result clearly. When a tool in the role is new to me, I do not present adjacent experience as direct production use. I connect the underlying concepts to work I have already completed, then learn the specific tool with a concrete deliverable in view.`,
    `I would welcome an interview to discuss the ${candidate.title} role and show the projects behind these examples. I can contribute on grounded technical tasks from the start while continuing to build depth with feedback from the team. Thank you for considering my application.`,
  ].map((paragraph) => paragraph.replace(/—/g, ',')).filter(Boolean);
  const body = paragraphs.join('\n\n');
  const banned = profile.raw.narrative?.banned_phrases || [];
  for (const phrase of banned) {
    if (body.toLowerCase().includes(String(phrase).toLowerCase())) throw new Error(`Cover letter contains banned phrase: ${phrase}`);
  }
  if (body.includes('—')) throw new Error('Cover letter may not contain em dashes');
  const numericClaims = body.match(/\b\d[\d,.+%-]*\b/g) || [];
  const approvedEvidence = `${profile.cvText}\n${profile.articleDigestText}\n${profile.answerBankText}`;
  for (const claim of numericClaims) {
    if (!approvedEvidence.includes(claim)) throw new Error(`Cover letter numeric claim is not grounded: ${claim}`);
  }
  return {
    text: body,
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
        greeting: 'Dear Hiring Team,',
        opening: paragraphs[0],
        profile_intro: paragraphs[1],
        achievements: evidence.map((item) => ({ lead: item.heading, impact: item.text })),
        problems_section: paragraphs.at(-2),
        closing: paragraphs.at(-1),
      },
      audit: {
        schemaVersion: 1,
        candidateId: candidate.candidate_id,
        evidenceRefs: evidence.map((item) => `output/application-answer-bank.md#${item.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`),
        wordCount: body.split(/\s+/).filter(Boolean).length,
        requirements,
      },
    },
  };
}

export function createDocumentPlan({ manifestPath, candidateId, jdFile = null, root = ROOT, now = new Date() }) {
  const contract = loadPreparationContract(manifestPath, candidateId, { root });
  const profile = loadApplicationProfile(root);
  const jd = resolveJdEvidence(root, contract.sourceCandidate, jdFile);
  const cvSelection = selectApprovedCv(profile, contract.candidate, jd.text);
  const cover = buildGroundedCoverLetter(profile, contract.candidate, jd.text, cvSelection, now);
  const coverPdfFilename = coverLetterFilename(contract.candidate.company);
  const coverTextFilename = coverPdfFilename.replace(/\.pdf$/i, '.txt');
  const documentsDir = join(dirname(contract.manifestPath), 'documents', contract.candidate.candidate_id);
  const plan = {
    schemaVersion: APPLICATION_DOCUMENT_PLAN_SCHEMA_VERSION,
    batchId: contract.manifest.batchId,
    sourceRunId: contract.manifest.sourceRunId,
    candidateId: contract.candidate.candidate_id,
    createdAt: now.toISOString(),
    sourceCandidateSha256: contract.candidate.sourceCandidateSha256,
    jd: { kind: jd.kind, path: jd.path, sha256: jd.sha256, size: jd.size },
    sourceHashes: Object.fromEntries(Object.entries(profile.sourceFiles).map(([key, value]) => [key, {
      path: value.path, sha256: value.sha256, size: value.size,
    }])),
    cv: {
      variant: cvSelection.variant,
      decision: cvSelection.decision,
      scores: cvSelection.scores,
      path: cvSelection.path,
      ...hashFile(cvSelection.path),
    },
    coverLetter: {
      required: true,
      pdfPath: join(documentsDir, coverPdfFilename),
      textPath: join(documentsDir, coverTextFilename),
      payload: cover.payload,
      text: cover.text,
    },
  };
  plan.planHash = sha256Canonical(plan);
  return plan;
}

function validatePlanFresh(plan, manifestPath, root) {
  if (plan.schemaVersion !== APPLICATION_DOCUMENT_PLAN_SCHEMA_VERSION) throw new Error('Unsupported application document plan schema');
  if (plan.planHash !== sha256Canonical(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planHash')))) {
    throw new Error('Application document plan integrity mismatch');
  }
  const contract = loadPreparationContract(manifestPath, plan.candidateId, { root });
  if (contract.manifest.batchId !== plan.batchId || contract.manifest.sourceRunId !== plan.sourceRunId
      || contract.candidate.sourceCandidateSha256 !== plan.sourceCandidateSha256) {
    throw new Error('Application document plan no longer matches the exact batch candidate');
  }
  for (const source of Object.values(plan.sourceHashes)) {
    const current = hashFile(source.path);
    if (current.sha256 !== source.sha256 || current.size !== source.size) throw new Error(`Document source changed after planning: ${source.path}`);
  }
  const currentCv = hashFile(plan.cv.path);
  if (currentCv.sha256 !== plan.cv.sha256 || currentCv.size !== plan.cv.size) throw new Error('Selected CV changed after planning');
  if (plan.jd.path) {
    const currentJd = hashFile(plan.jd.path);
    if (currentJd.sha256 !== plan.jd.sha256 || currentJd.size !== plan.jd.size) throw new Error('JD changed after planning');
  }
  const profile = loadApplicationProfile(root);
  if (profile.approvedCvs[plan.cv.variant] !== realpathSync(plan.cv.path)) {
    throw new Error('Document plan CV is not the exact approved variant path');
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
  return contract;
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
  validatePlanFresh(plan, manifestPath, root);
  mkdirSync(dirname(plan.coverLetter.pdfPath), { recursive: true });
  const realDocumentsDir = realpathSync(dirname(plan.coverLetter.pdfPath));
  if (!inside(realpathSync(resolve(root, 'output')), realDocumentsDir)) {
    throw new Error('Batch document directory symlink escapes the approved output directory');
  }
  if ((existsSync(plan.coverLetter.pdfPath) || existsSync(plan.coverLetter.textPath)) && !replace) {
    throw new Error('Planned application documents already exist; use --replace explicitly');
  }
  writeFileSync(plan.coverLetter.textPath, `${plan.coverLetter.text}\n`, { flag: replace ? 'w' : 'wx' });
  const { renderHtmlToPdf } = await import('./generate-pdf.mjs');
  const html = buildHtml(plan.coverLetter.payload);
  const rendered = await renderHtmlToPdf(html, plan.coverLetter.pdfPath, {
    format: 'a4', baseDir: root, recordManifest: false,
  });
  if (rendered.pageCount !== 1) throw new Error(`Cover letter must render to exactly one page; rendered ${rendered.pageCount}`);
  const records = bindCandidateArtifacts(manifestPath, candidateId, [
    { artifactType: 'cv', filePath: plan.cv.path, sourceCvVariant: plan.cv.variant },
    { artifactType: 'cover_letter', filePath: plan.coverLetter.pdfPath },
    { artifactType: 'cover_letter_text', filePath: plan.coverLetter.textPath },
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
    console.log(JSON.stringify({ plan: planPath, planHash: plan.planHash, cv: basename(plan.cv.path) }, null, 2));
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
