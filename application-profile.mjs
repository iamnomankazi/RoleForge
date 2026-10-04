import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { hashFile } from './application-integrity.mjs';

function readRequired(path, label) {
  if (!existsSync(path)) throw new Error(`Missing canonical ${label}: ${path}`);
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
}

function parseAnswerBank(markdown) {
  const answers = new Map();
  const pattern = /^## (.+)\r?\n([\s\S]*?)(?=^## |\s*$)/gm;
  for (const match of markdown.matchAll(pattern)) {
    const body = match[2].trim();
    if (body && !body.startsWith('- ')) answers.set(match[1].trim().toLowerCase(), body);
  }
  return answers;
}

export function loadApplicationProfile(root) {
  const projectRoot = resolve(root);
  const paths = {
    profile: resolve(projectRoot, 'config', 'profile.yml'),
    cv: resolve(projectRoot, 'cv.md'),
    profileMode: resolve(projectRoot, 'modes', '_profile.md'),
    articleDigest: resolve(projectRoot, 'article-digest.md'),
    voice: resolve(projectRoot, 'voice-dna.md'),
    answerBank: resolve(projectRoot, 'output', 'application-answer-bank.md'),
  };
  const profileText = readRequired(paths.profile, 'profile');
  const cvText = readRequired(paths.cv, 'CV');
  const profileModeText = readRequired(paths.profileMode, 'profile rules');
  const profile = yaml.load(profileText) || {};
  const answerText = existsSync(paths.answerBank) ? readFileSync(paths.answerBank, 'utf8') : '';
  const candidate = profile.candidate || {};
  const location = profile.location || {};
  const cv = profile.cv?.approved_system || {};
  const approvedCvs = {
    data_engineering: resolve(projectRoot, cv.role_pdfs?.data_engineering || ''),
    ai_ml: resolve(projectRoot, cv.role_pdfs?.ai_ml || ''),
    software_backend: resolve(projectRoot, cv.role_pdfs?.software_backend || ''),
    master: resolve(projectRoot, cv.master_pdf || ''),
  };
  for (const [variant, path] of Object.entries(approvedCvs)) {
    if (!existsSync(path)) throw new Error(`Approved ${variant} CV is missing: ${path}`);
    approvedCvs[variant] = realpathSync(path);
  }
  const sourceFiles = Object.fromEntries(Object.entries(paths)
    .filter(([, path]) => existsSync(path))
    .map(([key, path]) => [key, { path: realpathSync(path), ...hashFile(path) }]));
  return {
    projectRoot,
    raw: profile,
    candidate,
    location,
    currentStatus: profile.current_status || {},
    compensation: profile.compensation || {},
    education: profile.education_details || {},
    formRules: profile.application_form || {},
    approvedCvs,
    cvText,
    profileModeText,
    articleDigestText: existsSync(paths.articleDigest) ? readFileSync(paths.articleDigest, 'utf8') : '',
    voiceText: existsSync(paths.voice) ? readFileSync(paths.voice, 'utf8') : '',
    answerBankText: answerText,
    answers: parseAnswerBank(answerText),
    sourceFiles,
  };
}

const ROLE_TERMS = Object.freeze({
  data_engineering: [
    'data engineer', 'analytics engineer', 'etl', 'elt', 'warehouse', 'dimensional', 'pipeline',
    'postgresql', 'sql', 'business intelligence', 'bi developer', 'data analyst',
  ],
  ai_ml: [
    'machine learning', 'ml engineer', 'artificial intelligence', 'computer vision', 'pytorch',
    'hugging face', 'transformer', 'model training', 'data scientist', 'deep learning',
  ],
  software_backend: [
    'software engineer', 'software developer', 'backend', 'python developer', 'django', 'api',
    'full stack', 'full-stack', 'react', 'next.js', 'typescript',
  ],
});

function normalizeVariant(value) {
  const text = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  if (/data|analytics|etl|warehouse|bi/.test(text)) return 'data_engineering';
  if (/ai|ml|machine|data scientist|vision/.test(text)) return 'ai_ml';
  if (/software|backend|full stack|python|django/.test(text)) return 'software_backend';
  if (/master|general/.test(text)) return 'master';
  return null;
}

export function selectApprovedCv(profile, candidate, jdText) {
  const text = `${candidate.title || ''}\n${jdText || ''}`.toLowerCase();
  const scores = Object.fromEntries(Object.entries(ROLE_TERMS).map(([variant, terms]) => [
    variant,
    terms.reduce((score, term) => score + (text.includes(term) ? (candidate.title?.toLowerCase().includes(term) ? 4 : 1) : 0), 0),
  ]));
  const advisory = normalizeVariant(candidate.recommendedCvVariant);
  if (advisory && advisory !== 'master') scores[advisory] += 2;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const broadGraduate = /graduate|trainee|intern|early career|early-career/.test(text)
    && ranked[0][1] - ranked[1][1] <= 1;
  const variant = broadGraduate ? 'master' : ranked[0][0];
  if (!ranked[0][1] && !broadGraduate && advisory !== 'master') {
    throw new Error(`CV role family is ambiguous for ${candidate.title}; explicit review is required`);
  }
  return {
    variant,
    path: profile.approvedCvs[variant],
    scores,
    advisory,
    decision: 'reuse_approved',
  };
}

export function groundedFieldValue(profile, semantic, { country = null } = {}) {
  const candidate = profile.candidate;
  const currentCountry = country || profile.location.country || 'Finland';
  const fullName = String(candidate.full_name || '').trim();
  const parts = fullName.split(/\s+/);
  const values = {
    first_name: parts[0] || null,
    last_name: parts.length > 1 ? parts.slice(1).join(' ') : null,
    full_name: fullName || null,
    email: candidate.email || null,
    phone: candidate.phone || null,
    city: profile.location.city || null,
    country: profile.location.country || null,
    current_location: candidate.location || null,
    linkedin: candidate.linkedin || null,
    github: candidate.github || null,
    website: candidate.portfolio_url || null,
    university: /University of Eastern Finland/i.test(profile.currentStatus.summary || '') ? 'University of Eastern Finland' : null,
    graduation: profile.education.expected_graduation_date || null,
    availability: profile.currentStatus.availability?.start || null,
    salary: profile.compensation.target_range || null,
    work_authorization: currentCountry.toLowerCase() === 'finland'
      ? profile.location.work_authorization?.finland || null
      : profile.location.work_authorization?.outside_finland || null,
    sponsorship: currentCountry.toLowerCase() === 'finland' ? 'No' : 'Yes',
    relocation: profile.answers.get('relocation') || null,
  };
  return values[semantic] ?? null;
}

function exactAnswerHeadingMatch(question, heading) {
  const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normalizedQuestion = normalize(question);
  const normalizedHeading = normalize(heading);
  if (normalizedQuestion === normalizedHeading) return true;
  const machineAlias = normalizedHeading.replace(/\b(?:this|the|a|an|us|your)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return Boolean(machineAlias && normalizedQuestion === `${normalizedHeading} ${machineAlias}`);
}

export function answerBankMatch(profile, question) {
  for (const [key, value] of profile.answers.entries()) {
    if (exactAnswerHeadingMatch(question, key)) return value;
  }
  return null;
}
