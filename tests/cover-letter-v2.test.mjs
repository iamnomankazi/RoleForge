import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
  checkCoverLetterDraft,
  draftHash,
  loadBannedPhrases,
  runCoverLetterV2,
} from '../cover-letter-v2.mjs';
import { buildHtml } from '../generate-cover-letter.mjs';

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

test('candidate-fact sentences need claims; JD context sentences can be unclaimed', async () => {
  const draft = makeDraft({ sentences: 10 });
  draft.paragraphs[0].claims = [];
  const result = await checkDraft(draft);
  assert.equal(result.checks.find(item => item.id === 'claim_coverage').status, 'fail');
  assert.equal(result.checks.find(item => item.id === 'claim_coverage').reasonCode, 'candidate_sentence_without_claim');

  const contextDraft = makeDraft({ sentences: 10 });
  contextDraft.paragraphs[0].text += ' Northstar Labs has a distributed team.';
  contextDraft.jd.text += ' Northstar Labs has a distributed team.';
  // The only omitted sentence is the explicitly supplied JD/company context.
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
      jdText: draft.jd.text, validateClaims: passingValidator, outputDirectory,
    });
    const originalText = await readFile(first.files.text, 'utf8');
    const second = await runCoverLetterV2(draft, {
      jdText: draft.jd.text, validateClaims: passingValidator, outputDirectory,
    });
    assert.equal(second.status, 'blocked');
    assert.equal(second.checks.find(item => item.id === 'output_collision').reasonCode, 'output_exists');
    assert.equal(await readFile(first.files.text, 'utf8'), originalText);
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
