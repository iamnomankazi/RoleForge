import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
  checkCoverLetterDraft,
  approveCoverLetterV2,
  draftHash,
  loadBannedPhrases,
  runCoverLetterV2,
} from '../cover-letter-v2.mjs';
import { buildHtml } from '../generate-cover-letter.mjs';
import { createDraftManifest, validateClaims as realValidator } from '../cv-claims.mjs';

const company = 'Northstar Labs';
const role = 'Backend Engineer';
const englishSentence = 'I build small software tools with clear interfaces, careful tests, and readable documentation for teams that need dependable results.';

function makeDraft({ language = 'en', sentence = englishSentence, sentences = 10, companyName = company,
  roleName = role, extra = '', greeting = 'Dear Hiring Team,', closing = 'I would welcome a conversation about the role and the work described in the posting.',
} = {}) {
  if (language === 'fi' && greeting === 'Dear Hiring Team,') greeting = 'Hyvä rekrytointitiimi,';
  if (language === 'fi' && closing.startsWith('I would welcome')) closing = 'Keskustelen mielelläni tehtävästä ja työnkuvauksessa esitetyistä tehtävistä.';
  if (language === 'de' && greeting === 'Dear Hiring Team,') greeting = 'Sehr geehrtes Recruiting-Team,';
  if (language === 'de' && closing.startsWith('I would welcome')) closing = 'Gern bespreche ich die Stelle und die im Posting beschriebenen Aufgaben.';
  const allSentences = Array.from({ length: sentences }, () => `${sentence}${extra ? ` ${extra}` : ''}`);
  const first = allSentences.slice(0, Math.ceil(allSentences.length / 2));
  const second = allSentences.slice(Math.ceil(allSentences.length / 2));
  const paragraphs = [first, second].filter(items => items.length).map((items, index) => ({
    text: items.join(' '),
    claims: items.map((text, claimIndex) => ({
      id: `p${index + 1}-claim${claimIndex + 1}`,
      text,
    })),
  }));
  return {
    company: companyName,
    role: roleName,
    language,
    jd: { text: `Company: ${company}. Role: ${role}. ${language === 'en' ? 'We welcome applications.' : ''}` },
    greeting,
    paragraphs,
    closing,
    signature: 'Alex Example',
  };
}

const passingValidator = async ({ claims }) => ({
  ok: true,
  results: claims.map(claim => ({ claimId: claim.id, status: 'pass' })),
});

async function checkDraft(draft, options = {}) {
  return checkCoverLetterDraft(draft, {
    jdText: draft.jd.text,
    jdCompany: company,
    jdRole: role,
    validateClaims: passingValidator,
    ...options,
  });
}

function claimCheck(result) {
  return result.checks.find(item => item.id === 'claim_validation');
}

test('English is the default even when the JD is written in German without a language requirement', async () => {
  const draft = makeDraft();
  draft.jd.text = `Wir suchen eine Person für Northstar Labs als Backend Engineer. Die Aufgaben umfassen Entwicklung, Tests und Zusammenarbeit mit dem Team.`;
  const result = await checkDraft(draft);
  assert.equal(result.status, 'pass');
  assert.equal(result.checks.find(item => item.id === 'language').detected, 'en');
  assert.equal(result.checks.find(item => item.id === 'language').requiredByJd, 'en');
});

test('explicit Finnish and German requirements allow the matching output language', async () => {
  const finnishSentence = 'Olen rakentanut ohjelmistoja, joissa selkeät rajapinnat, huolelliset testit ja ymmärrettävä dokumentaatio auttavat tiimejä tekemään työnsä hyvin.';
  const finnish = makeDraft({ language: 'fi', sentence: finnishSentence, sentences: 11 });
  finnish.jd.text = 'Northstar Labs etsii Backend Engineer -rooliin henkilöä. Sujuva suomen kielen taito on pakollinen.';
  const finnishResult = await checkDraft(finnish);
  assert.equal(finnishResult.status, 'pass', JSON.stringify(finnishResult.checks));
  assert.equal(finnishResult.checks.find(item => item.id === 'language').requiredByJd, 'fi');
  assert.equal(finnishResult.checks.find(item => item.id === 'language').detected, 'fi');

  const germanSentence = 'Ich entwickle Software mit klaren Schnittstellen, sorgfältigen Tests und verständlicher Dokumentation für Teams, die verlässliche Ergebnisse benötigen.';
  const german = makeDraft({ language: 'de', sentence: germanSentence, sentences: 11 });
  german.jd.text = 'Northstar Labs sucht für die Stelle Backend Engineer. Sehr gute Deutschkenntnisse sind erforderlich.';
  const germanResult = await checkDraft(german);
  assert.equal(germanResult.status, 'pass', JSON.stringify(germanResult.checks));
  assert.equal(germanResult.checks.find(item => item.id === 'language').requiredByJd, 'de');
  assert.equal(germanResult.checks.find(item => item.id === 'language').detected, 'de');
});

test('ambiguous body language requires human review', async () => {
  const draft = makeDraft({ sentence: 'Qzxv qwrp blent frask zqv narp glint vesk dron flerp.', sentences: 25, greeting: '', closing: '' });
  const result = await checkDraft(draft);
  assert.equal(result.status, 'review_required');
  assert.equal(result.checks.find(item => item.id === 'language').status, 'review_required');
});

test('company and role must match the JD', async () => {
  const companyResult = await checkDraft(makeDraft({ companyName: 'Other Company' }));
  assert.equal(companyResult.checks.find(item => item.id === 'company_matches_jd').status, 'fail');
  const roleResult = await checkDraft(makeDraft({ roleName: 'Data Scientist' }));
  assert.equal(roleResult.checks.find(item => item.id === 'role_matches_jd').status, 'fail');
});

test('claim validator failures, missing results, missing validator, and throws fail closed', async () => {
  const draft = makeDraft();
  const rejected = await checkDraft(draft, { validateClaims: async ({ claims }) => ({
    ok: false,
    results: claims.map(claim => ({ claimId: claim.id, status: 'fail', reasonCode: 'unsupported' })),
  }) });
  assert.equal(rejected.status, 'fail');
  assert.equal(claimCheck(rejected).failedResults.length, 10);

  const missingResult = await checkDraft(draft, { validateClaims: async () => ({ ok: true, results: [] }) });
  assert.equal(claimCheck(missingResult).reasonCode, 'claim_result_missing');

  const missingValidator = await checkCoverLetterDraft(draft, { jdText: draft.jd.text });
  assert.equal(missingValidator.status, 'blocked');
  assert.equal(claimCheck(missingValidator).reasonCode, 'claims_validator_missing');

  const thrown = await checkDraft(draft, { validateClaims: async () => { throw new Error('validator unavailable'); } });
  assert.equal(thrown.status, 'blocked');
  assert.equal(claimCheck(thrown).reasonCode, 'claims_validator_threw');
});

test('fact sentences need complete claims even when they also appear in the JD', async () => {
  const draft = makeDraft({ sentences: 10 });
  draft.paragraphs[0].claims = [];
  draft.paragraphs[0].text = 'I built tools for 42 users.';
  const result = await checkDraft(draft);
  assert.equal(result.checks.find(item => item.id === 'claim_coverage').status, 'fail');
  assert.equal(result.checks.find(item => item.id === 'claim_coverage').reasonCode, 'candidate_sentence_without_claim');

  const contextDraft = makeDraft({ sentences: 10 });
  contextDraft.paragraphs[0].text += ' Northstar Labs has a distributed team.';
  contextDraft.jd.text += ' Northstar Labs has a distributed team.';
  // Non-candidate context is authorized by the independent JD.
  const resultWithContext = await checkDraft(contextDraft, { validateClaims: async ({ claims }) => ({
    ok: true, results: claims.map(claim => ({ claimId: claim.id, status: 'pass' })),
  }) });
  assert.equal(resultWithContext.checks.find(item => item.id === 'claim_coverage').status, 'pass');
});

test('banned phrases and placeholders are rejected', async () => {
  const banned = await checkDraft(makeDraft({ extra: 'This is a data-driven approach.' }));
  assert.equal(banned.checks.find(item => item.id === 'banned_phrases').status, 'fail');
  assert.ok(banned.checks.find(item => item.id === 'banned_phrases').matches.includes('data-driven'));

  const placeholder = await checkDraft(makeDraft({ extra: 'I would contribute at [Company] after joining.' }));
  assert.equal(placeholder.checks.find(item => item.id === 'placeholders').status, 'fail');
});

test('body word count rejects letters shorter than 180 or longer than 260 words', async () => {
  const short = await checkDraft(makeDraft({ sentences: 2 }));
  assert.equal(short.checks.find(item => item.id === 'body_word_count').status, 'fail');
  assert.ok(short.bodyWordCount < 180);

  const long = await checkDraft(makeDraft({ sentences: 20 }));
  assert.equal(long.checks.find(item => item.id === 'body_word_count').status, 'fail');
  assert.ok(long.bodyWordCount > 260);
});

test('success writes a matching text and exactly one-page PDF with a hash sidecar', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'cover-letter-v2-'));
  try {
    const draft = makeDraft();
    const result = await runCoverLetterV2(draft, {
      jdText: draft.jd.text,
      jdCompany: company, jdRole: role,
      validateClaims: passingValidator,
      outputDirectory,
    });
    assert.equal(result.status, 'pass');
    assert.equal(result.pageCount, 1);
    assert.deepEqual(Object.keys(result.files).sort(), ['check', 'pdf', 'text']);
    const [text, pdfBytes, sidecarText] = await Promise.all([
      readFile(result.files.text, 'utf8'),
      readFile(result.files.pdf),
      readFile(result.files.check, 'utf8'),
    ]);
    const sidecar = JSON.parse(sidecarText);
    const pdf = await PDFDocument.load(pdfBytes);
    assert.equal(pdf.getPageCount(), 1);
    assert.equal(text, result.text);
    assert.equal(sidecar.draftHash, draftHash(draft));
    assert.equal(sidecar.draftHash, result.draftHash);
    assert.equal(sidecar.pageCount, 1);
    assert.equal(sidecar.textHash, result.textHash);
    assert.equal(sidecar.pdfHash, result.pdfHash);
    assert.equal(sidecar.checks.find(item => item.id === 'pdf_one_page').status, 'pass');
    assert.match(text, /Northstar Labs\nBackend Engineer/);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('colliding artifact names are refused without changing the existing pair', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'cover-letter-v2-collision-'));
  try {
    const draft = makeDraft();
    const first = await runCoverLetterV2(draft, {
      jdText: draft.jd.text, jdCompany: company, jdRole: role, validateClaims: passingValidator, outputDirectory,
    });
    const originalText = await readFile(first.files.text, 'utf8');
    const second = await runCoverLetterV2(draft, {
      jdText: draft.jd.text, jdCompany: company, jdRole: role, validateClaims: passingValidator, outputDirectory,
    });
    assert.equal(second.status, 'blocked');
    assert.equal(second.checks.find(item => item.id === 'output_collision').reasonCode, 'output_exists');
    assert.equal(await readFile(first.files.text, 'utf8'), originalText);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('explicit approval rechecks both pair hashes, creates one record, and refuses double approval', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'cover-letter-v2-approval-'));
  try {
    const draft = makeDraft();
    const result = await runCoverLetterV2(draft, {
      jdText: draft.jd.text,
      jdCompany: company, jdRole: role,
      validateClaims: passingValidator,
      outputDirectory,
    });
    const approved = await approveCoverLetterV2(result.files.check, { now: new Date('2031-01-02T03:04:05.000Z') });
    const record = JSON.parse(await readFile(approved.approvedPath, 'utf8'));
    assert.deepEqual(record, {
      approvedAt: '2031-01-02T03:04:05.000Z',
      draftHash: result.draftHash,
      textHash: result.textHash,
      pdfHash: result.pdfHash,
    });
    await assert.rejects(() => approveCoverLetterV2(result.files.check), /EEXIST|already exists/i);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('v2 approval refuses a PDF that changed after its check sidecar was written', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'cover-letter-v2-tamper-'));
  try {
    const draft = makeDraft();
    const result = await runCoverLetterV2(draft, {
      jdText: draft.jd.text,
      jdCompany: company, jdRole: role,
      validateClaims: passingValidator,
      outputDirectory,
    });
    await writeFile(result.files.pdf, 'tampered PDF');
    await assert.rejects(() => approveCoverLetterV2(result.files.check), /pair hash mismatch/i);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('user phrase lists are read at runtime and the legacy HTML template accepts language', async () => {
  const userLayerDir = await mkdtemp(join(tmpdir(), 'cover-letter-user-phrases-'));
  try {
    await mkdir(join(userLayerDir, 'modes'));
    await writeFile(join(userLayerDir, 'voice-dna.md'), '## 3. BANNED LIST\n\ncustom jargon, avoid this wording\n\n## 4. More rules\n');
    await writeFile(join(userLayerDir, 'modes', '_profile.md'), '## Writing Style\nAvoid:\n- "user-specific sample phrase"\n');
    const phrases = await loadBannedPhrases({ userLayerDir });
    assert.ok(phrases.includes('custom jargon'));
    assert.ok(phrases.includes('user-specific sample phrase'));
    const html = buildHtml({ candidate: { name: 'Synthetic Candidate' }, letter: {
      role_title: 'Engineer', opening: 'Hello', profile_intro: 'Work', language: 'fi',
    } });
    assert.match(html, /<html lang="fi">/);
  } finally {
    await rm(userLayerDir, { recursive: true, force: true });
  }
});

test('voice banned list skips instruction prose and the words it recommends instead', async () => {
  const userLayerDir = await mkdtemp(join(tmpdir(), 'cover-letter-voice-list-'));
  try {
    await writeFile(join(userLayerDir, 'voice-dna.md'), [
      '## 3. BANNED LIST', '', 'If even ONE of these appears, the output fails.', '', '### 3A. Words', '',
      'delve, landscape (abstract), intricate/intricacies, leverage, synergy', '',
      'Also banned: "serves as," "stands as," when used to avoid "is" or "has." Just say "is."', '', '## 4. Next', '',
    ].join('\n'));
    const phrases = await loadBannedPhrases({ userLayerDir });
    for (const phrase of ['delve', 'landscape', 'intricate', 'intricacies', 'leverage', 'serves as', 'stands as']) {
      assert.ok(phrases.includes(phrase), phrase);
    }
    for (const phrase of ['is', 'has', 'has.', 'is.', 'If even ONE of these appears', 'the output fails.']) {
      assert.ok(!phrases.includes(phrase), phrase);
    }
  } finally {
    await rm(userLayerDir, { recursive: true, force: true });
  }
});

test('cited paraphrases and job-description context pass through the gate; JD-backed experience claims fail', async () => {
  const cv = '# Projects\n## Alpha - Job Platform\n- Built a Next.js and PostgreSQL application with saved jobs.\n';
  const manifest = createDraftManifest(cv);
  const bullet = manifest.claims.find(claim => claim.text.startsWith('Built a Next.js')).id;
  const jdText = `Company: ${company}. Role: ${role}. We build with React and TypeScript and welcome applications.`;
  const motivation = "I'm applying because React and TypeScript work with a product team is the start I want.";
  const project = 'I built Alpha, my own Next.js and PostgreSQL application with saved jobs.';
  const draft = { ...makeDraft(), jd: { text: jdText }, paragraphs: [{ text: `${motivation} ${project}`, claims: [
    { id: 'm', evidence: ['jd'], text: motivation },
    { id: 'p', evidence: [bullet], text: project },
  ] }] };
  const options = { jdText, cv, manifest, validateClaims: realValidator };
  const passing = await checkDraft(draft, options);
  assert.equal(passing.checks.find(item => item.id === 'claim_coverage').status, 'pass');
  assert.equal(passing.checks.find(item => item.id === 'claim_validation').status, 'pass');

  const fabricated = 'I have built React dashboards for customers.';
  draft.paragraphs = [{ text: fabricated, claims: [{ id: 'f', evidence: ['jd'], text: fabricated }] }];
  const failing = await checkDraft(draft, options);
  const validation = failing.checks.find(item => item.id === 'claim_validation');
  assert.equal(validation.status, 'fail');
  assert.equal(validation.failedResults[0].reasonCode, 'jd_context_candidate_claim');
});

function factualDraft() {
  const sentence = 'I built API services for 30 users.';
  const draft = makeDraft({ sentence, sentences: 26, closing: 'Thank you for considering my application.' });
  const cv = '# Projects\n## Alpha\n- Built API services for 30 users.\n';
  return { draft, options: { cv, manifest: createDraftManifest(cv), validateClaims: realValidator } };
}

test('a supported substring cannot authorize unsupported additions to a sentence', async () => {
  const { draft, options } = factualDraft();
  assert.equal((await checkDraft(draft, options)).status, 'pass');
  draft.paragraphs[0].text = draft.paragraphs[0].text.replace('I built API services for 30 users.', 'I built API services for 30 users and invented TypeScript.');
  draft.paragraphs[0].claims[0].text = 'I built API services for 30 users';
  const result = await checkDraft(draft, options);
  const coverage = result.checks.find(item => item.id === 'claim_coverage');
  assert.equal(result.status, 'fail');
  assert.equal(coverage.status, 'fail');
  assert.ok(coverage.missingSentences.some(item => item.sentence.includes('invented TypeScript')));
  draft.paragraphs[0].claims[0].text = 'I built API services for 30 users and invented TypeScript.';
  assert.equal(claimCheck(await checkDraft(draft, options)).status, 'fail');
});

test('all first-person references require claims outside the explicit intent and courtesy patterns', async () => {
  for (const sentence of ['My expertise includes pandas.', 'My expertise includes COBOL.', "I'm adept at pandas.",
    "I've mastered pandas.", 'Ask me about pandas.', 'I taught myself pandas.']) {
    const { draft, options } = factualDraft();
    draft.paragraphs[0].text += ` ${sentence}`;
    const result = await checkDraft(draft, options);
    const coverage = result.checks.find(item => item.id === 'claim_coverage');
    assert.equal(coverage.status, 'fail', sentence);
    assert.ok(coverage.missingSentences.some(item => item.sentence === sentence));
  }
});

test('verbatim non-first-person JD context passes the real validator with and without a claim', async () => {
  for (const includeClaim of [false, true]) {
    const { draft, options } = factualDraft();
    const sentence = 'Northstar Labs builds API services.';
    draft.jd.text += ` ${sentence}`;
    draft.paragraphs[0].text += ` ${sentence}`;
    if (includeClaim) draft.paragraphs[0].claims.push({ id: 'jd-context', text: sentence });
    assert.equal((await checkDraft(draft, options)).status, 'pass');
    draft.paragraphs[0].text = draft.paragraphs[0].text.replace(sentence, 'Northstar Labs builds ML services.');
    assert.equal((await checkDraft(draft, options)).status, 'fail');
  }
  const { draft, options } = factualDraft();
  draft.jd.text += ' My expertise includes pandas.';
  draft.paragraphs[0].text += ' My expertise includes pandas.';
  assert.equal((await checkDraft(draft, options)).status, 'fail');
});

test('JD authorization preserves claim shape and duplicate-ID checks', async () => {
  const { draft, options } = factualDraft();
  const sentence = 'Northstar Labs builds API services.';
  draft.jd.text += ` ${sentence}`;
  draft.claims = [{ id: draft.paragraphs[0].claims[0].id, text: sentence }];
  let checked = await checkDraft(draft, options);
  assert.equal(checked.checks.find(item => item.id === 'claim_coverage').reasonCode, 'duplicate_claim_id');
  draft.claims = [{ text: sentence }];
  checked = await checkDraft(draft, options);
  assert.equal(checked.checks.find(item => item.id === 'claim_coverage').reasonCode, 'invalid_claim');
});

test('mandatory language scope survives coordinated verbs separated by commas', async () => {
  const draft = makeDraft();
  draft.jd.text += ' You must speak, read and write German.';
  const result = await checkDraft(draft);
  const language = result.checks.find(item => item.id === 'language');
  assert.equal(language.requiredByJd, 'de');
  assert.equal(language.status, 'fail');
});

test('greeting, closing and factual signatures require complete validated claims', async () => {
  for (const field of ['greeting', 'closing', 'signature']) {
    const { draft, options } = factualDraft();
    draft[field] = 'I authored TypeScript and Next.js and led 500 engineers.';
    const unchecked = await checkDraft(draft, options);
    assert.equal(unchecked.status, 'fail', field);
    assert.ok(unchecked.checks.find(item => item.id === 'claim_coverage').missingSentences.some(item => item.field === field));
    draft.claims = [{ id: `${field}-claim`, text: draft[field] }];
    const checked = await checkDraft(draft, options);
    assert.equal(checked.checks.find(item => item.id === 'claim_coverage').status, 'pass');
    assert.equal(claimCheck(checked).status, 'fail');
  }
  const { draft, options } = factualDraft();
  draft.closing = 'I built API services for 30 users.';
  assert.equal((await checkDraft(draft, options)).status, 'pass');
  draft.claims = [{ id: 'unrendered', text: 'I authored TypeScript.' }];
  assert.equal(claimCheck(await checkDraft(draft, options)).status, 'fail');
});

test('company and role equal independently supplied complete names bound to JD phrases', async () => {
  const draft = makeDraft({ companyName: 'Northstar', roleName: 'Engineer' });
  draft.jd.text = 'Northstar Labs is hiring a Backend Engineer';
  const partial = await checkDraft(draft);
  assert.equal(partial.checks.find(item => item.id === 'company_matches_jd').status, 'fail');
  assert.equal(partial.checks.find(item => item.id === 'role_matches_jd').status, 'fail');
  draft.company = 'Fictional Corp'; draft.role = 'Chief Executive Officer';
  draft.jd.company = draft.company; draft.jd.role = draft.role;
  const forged = await checkDraft(draft);
  assert.equal(forged.checks.find(item => item.id === 'company_matches_jd').status, 'fail');
  assert.equal(forged.checks.find(item => item.id === 'role_matches_jd').status, 'fail');
  const unbound = await checkDraft(draft, { jdCompany: draft.company, jdRole: draft.role });
  assert.equal(unbound.checks.find(item => item.id === 'company_matches_jd').status, 'fail');
  assert.equal(unbound.checks.find(item => item.id === 'role_matches_jd').status, 'fail');
  const noCanonical = await checkDraft(makeDraft(), { jdCompany: undefined, jdRole: undefined });
  assert.equal(noCanonical.checks.find(item => item.id === 'company_matches_jd').status, 'fail');
  const boundary = await checkDraft(makeDraft(), { jdText: 'Northstar LabsX hires Backend Engineers.' });
  assert.equal(boundary.checks.find(item => item.id === 'company_matches_jd').status, 'fail');
  assert.equal(boundary.checks.find(item => item.id === 'role_matches_jd').status, 'fail');
  const gluedSuffix = await checkDraft(makeDraft(), { jdText: 'Northstar Labs hires a Backend EngineerX now.' });
  assert.equal(gluedSuffix.checks.find(item => item.id === 'role_matches_jd').status, 'fail');
});

test('a role glued to neighbouring words by a scraped page still matches its exact title', async () => {
  const glued = await checkDraft(makeDraft(), { jdText: `Back to jobs${role}Helsinki, Finland. Join ${company} today.` });
  assert.equal(glued.checks.find(item => item.id === 'role_matches_jd').status, 'pass');
  const bracketRole = `${role} (Platform)`;
  const bracketDraft = makeDraft({ roleName: bracketRole });
  const bracket = await checkDraft(bracketDraft, { jdText: `Back to jobs${bracketRole}Helsinki. Join ${company} today.`, jdRole: bracketRole });
  assert.equal(bracket.checks.find(item => item.id === 'role_matches_jd').status, 'pass');
  const wrongRole = await checkDraft(makeDraft(), { jdText: `Back to jobsSenior ${role}Helsinki. Join ${company} today.`, jdRole: `Staff ${role}` });
  assert.equal(wrongRole.checks.find(item => item.id === 'role_matches_jd').status, 'fail');
});

test('optional and negated language skills do not impose a language requirement', async () => {
  for (const text of [
    'Fluent in German is a plus, not a requirement',
    'You must have Python skills; German is optional',
    'German is nice to have.', 'German is not required.', 'German is not mandatory.',
    'German proficiency is optional but Python is required.', 'You do not have to speak German.',
    'Fluent in German.', 'Required: Python skills; Finnish is a plus.',
  ]) {
    const draft = makeDraft();
    draft.jd.text += ` ${text}`;
    const result = await checkDraft(draft);
    assert.equal(result.status, 'pass', text);
    assert.equal(result.checks.find(item => item.id === 'language').requiredByJd, 'en', text);
  }
  for (const text of ['German is required.', 'You must speak German.', 'German is mandatory; Python is optional.',
    'German is required and Python is optional.', 'German is required and Python is a plus.', 'German fluency is required.']) {
    const draft = makeDraft(); draft.jd.text += ` ${text}`;
    const result = await checkDraft(draft);
    assert.equal(result.checks.find(item => item.id === 'language').requiredByJd, 'de', text);
    assert.equal(result.checks.find(item => item.id === 'language').status, 'fail', text);
  }
});

test('validator must return exactly one result per claim, including earlier rejections', async () => {
  const draft = makeDraft();
  for (const statuses of [['fail', 'pass'], ['pass', 'fail'], ['pass', 'pass']]) {
    const result = await checkDraft(draft, { validateClaims: async ({ claims }) => ({ ok: true, results: [
      ...claims.slice(1).map(claim => ({ claimId: claim.id, status: 'pass' })),
      ...statuses.map(status => ({ claimId: claims[0].id, status })),
    ] }) });
    assert.equal(result.status, 'fail');
    assert.equal(claimCheck(result).reasonCode, 'duplicate_claim_result');
    assert.equal(claimCheck(result).duplicateResults.length, 1);
  }
  const missing = await checkDraft(draft, { validateClaims: async ({ claims }) => ({ ok: true,
    results: claims.slice(1).map(claim => ({ claimId: claim.id, status: 'pass' })) }) });
  assert.equal(claimCheck(missing).reasonCode, 'claim_result_missing');
});
