import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftManifest, validateClaims } from '../cv-claims.mjs';

const CV = `# Synthetic Candidate

## Education

### Example University

**Master of Computer Science** | 2023 - Present (graduation expected December 2026)

## Experience

### Developer Intern | Example Web Ltd

**Feb 2022 - Apr 2022**

- Added Django features and REST endpoints to an internal web application, including request validation and error handling.
- Participated in debugging, code reviews, and implementation work across backend and UI tasks.

## Projects

### Alpha - Job Search Platform

- Built a full-stack Next.js, TypeScript and PostgreSQL application with a database-backed authenticated dashboard, search and saved jobs.
- Implemented loading, failure and retry handling for API-driven features and debugged behavior across frontend, backend and persistence layers.
- Stack: Next.js, TypeScript, PostgreSQL, Git.

### Beta - Desktop Tray

- Built a Windows tray application with a React/TypeScript interface and a Rust/Tauri 2 backend.

## Languages

- English: Fluent
`;
const JD = 'Join Acme’s Launchpad 2027 cohort. Our tech stack includes TypeScript, React, Node.js and Kafka. Work alongside experienced mentors.';

function setup() {
  const manifest = createDraftManifest(CV);
  for (const entry of manifest.claims) entry.state = 'asserted';
  const id = (pattern) => manifest.claims.find((entry) => pattern.test(entry.text)).id;
  return { manifest, id };
}

function check(text, evidence) {
  const { manifest } = setup();
  return validateClaims({ claims: [{ id: 'c', text, evidence }], manifest, cv: CV, jdText: JD }).results[0];
}

test('natural paraphrases citing one CV item pass', () => {
  const { id } = setup();
  const education = [id(/^Example University$/), id(/^Master of Computer Science/)];
  assert.equal(check("I'm completing a Master's in Computer Science at Example University, with graduation expected in December 2026.", education).status, 'pass');
  const alpha = [id(/^Built a full-stack/)];
  assert.equal(check('I built its Next.js and TypeScript interface, with PostgreSQL-backed features for an authenticated dashboard, search and saved jobs.', alpha).status, 'pass');
  assert.equal(check("I've been putting my skills to work on Alpha, my job-search platform.", [id(/^Alpha - Job Search Platform$/)]).status, 'pass');
  assert.equal(check('My strongest example is Alpha, a Next.js application I built from 2.5 hours of PostgreSQL work with saved jobs.', alpha).status, 'fail',
    'numbers absent from the evidence still fail');
  assert.equal(check('Alpha is the full-stack Next.js application I built with an authenticated dashboard.', alpha).status, 'pass');
  assert.equal(check('Making the frontend, APIs and database work together reliably through loading failures and retries has been a practical challenge.',
    [id(/^Implemented loading/), id(/^Built a full-stack/)]).status, 'pass');
  assert.equal(check('During my internship I worked on Django features and REST endpoints, debugging and code reviews.',
    [id(/^Added Django/), id(/^Participated in debugging/)]).status, 'pass');
});

test('employer context citing the job description passes but cannot carry candidate experience', () => {
  assert.equal(check("I'm applying for Acme's Launchpad 2027 because I want to learn alongside experienced engineers, especially with React and TypeScript in the stack.", ['jd']).status, 'pass');
  assert.equal(check('I have built Kafka pipelines.', ['jd']).reasonCode, 'jd_context_candidate_claim');
  assert.equal(check('I am applying for Acme’s Launchpad 2028 cohort.', ['jd']).reasonCode, 'unsupported_jd_context');
  assert.equal(check('Experience with Kotlin and Kafka matters to Acme.', ['jd']).reasonCode, 'unsupported_jd_context');
});

test('cited paraphrases still reject unsupported facts, recombination and invented authority', () => {
  const { id } = setup();
  const alpha = [id(/^Built a full-stack/)];
  assert.equal(check('I built its Next.js and React interface.', alpha).reasonCode, 'unsupported_technology');
  // Kotlin is not in the technology dictionary; the proper-noun guard still rejects it.
  assert.equal(check('I built its Next.js and Kotlin interface.', alpha).reasonCode, 'unknown_named_entity');
  assert.equal(check('I built its interface at Google.', alpha).reasonCode, 'unknown_named_entity');
  assert.equal(check('I built its Next.js interface for 900 users.', alpha).reasonCode, 'unsupported_metric');
  assert.equal(check('I led the team that built its Next.js interface.', alpha).reasonCode, 'unsupported_action');
  assert.equal(check('I have five years of Next.js experience.', alpha).reasonCode, 'unsupported_risk_word');
  assert.equal(check('I am fluent in Finnish.', [id(/^English/)]).status, 'fail');
  assert.equal(check('I am a native speaker.', [id(/^English/)]).reasonCode, 'unsupported_risk_word');
  assert.equal(check('I built Git.', [id(/^Stack: /)]).status, 'fail');
  // The evidence contains both "Built" and PostgreSQL, but using a technology is not building it.
  assert.equal(check('I built PostgreSQL.', alpha).reasonCode, 'unsupported_relationship');
  assert.equal(check('I built a React and Next.js platform.', [id(/^Built a full-stack/), id(/^Built a Windows tray/)]).reasonCode, 'evidence_spans_items');
  assert.equal(check('I completed a Master of Computer Science in December 2025.', [id(/^Master of Computer Science/)]).reasonCode, 'unsupported_date');
  assert.equal(check('I worked on Alpha.', ['claim-does-not-exist']).reasonCode, 'evidence_not_allowed');
  assert.equal(check('I worked on Alpha.', []).reasonCode, 'evidence_invalid');
});

test('cited paraphrases cannot add responsibilities the evidence does not mention', () => {
  // Reviewer case: only "Built a full-stack Next.js and PostgreSQL application with saved jobs." is evidence.
  const cv = '# X\n\n## Projects\n\n### Alpha - Job Search Platform\n\n- Built a full-stack Next.js and PostgreSQL application with saved jobs.\n';
  const manifest = createDraftManifest(cv);
  for (const entry of manifest.claims) entry.state = 'asserted';
  const evidence = [manifest.claims.find((entry) => /^Built/.test(entry.text)).id];
  const run = (text) => validateClaims({ claims: [{ id: 'c', text, evidence }], manifest, cv }).results[0];
  assert.equal(run('I conducted customer interviews for Alpha.').reasonCode, 'unsupported_wording');
  assert.equal(run('I negotiated contracts for Alpha.').reasonCode, 'unsupported_wording');
  assert.equal(run('I handled the budget for Alpha.').reasonCode, 'unsupported_wording');
  assert.equal(run('I mentored new developers on Alpha.').reasonCode, 'unsupported_wording');
  for (const claim of ['I delivered Alpha.', 'I improved Alpha.', 'I was responsible for Alpha.',
    'I built a team for Alpha.', 'I built a software engineering team for Alpha.', 'I built Alpha as a team project.']) {
    assert.equal(run(claim).reasonCode, 'unsupported_wording', claim);
  }
  // Legitimate rewording of the same evidence, including other word forms, still passes.
  assert.equal(run('I built Alpha, a full-stack Next.js and PostgreSQL platform where users save jobs.').reasonCode, 'unsupported_wording',
    '"users" is new information, not a word form');
  assert.equal(run('I built Alpha, a full-stack Next.js and PostgreSQL platform for saving jobs.').status, 'pass');
  assert.equal(run('Alpha is the full-stack application I built with Next.js and PostgreSQL, including saved jobs.').status, 'pass');
});

test('job-description context cannot describe things the candidate did', () => {
  assert.equal(check('I negotiated contracts.', ['jd']).reasonCode, 'jd_context_candidate_claim');
  assert.equal(check('I conducted customer interviews at Acme.', ['jd']).reasonCode, 'jd_context_candidate_claim');
  assert.equal(check('I am responsible for Kafka at Acme.', ['jd']).reasonCode, 'jd_context_candidate_claim');
  assert.equal(check("I'd welcome the chance to join Acme's Launchpad 2027 cohort.", ['jd']).status, 'pass');
  assert.equal(check('I am applying because I want to work alongside experienced mentors.', ['jd']).status, 'pass');
});

test('uncited claims keep the strict exact-evidence behaviour', () => {
  const { manifest } = setup();
  const [result] = validateClaims({ claims: [{ id: 'c', text: "I'm completing a Master's in Computer Science at Example University." }], manifest, cv: CV }).results;
  assert.equal(result.status, 'fail');
});

test('team claims pass only when the cited evidence mentions a team', () => {
  const cv = '# X\n\n## Experience\n\n### Volunteer | Example Festival\n\n- Worked in small teams and kept public spaces clean.\n';
  const manifest = createDraftManifest(cv);
  for (const entry of manifest.claims) entry.state = 'asserted';
  const evidence = [manifest.claims.find((entry) => /^Worked in small teams/.test(entry.text)).id];
  const [result] = validateClaims({ claims: [{ id: 'c', text: 'I worked in a small team and kept public spaces clean.', evidence }], manifest, cv }).results;
  assert.equal(result.status, 'pass');
});
