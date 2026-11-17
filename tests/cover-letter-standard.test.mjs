// Cover Letter Standard support in the gate: excluded topics with narrow per-draft exceptions, approval
// confirmation of exceptions, technical uses of banned words, em dashes, posting requests for excluded content,
// relocation claims from the profile, and plain CV-skill mentions. Synthetic candidate, employer and posting only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveCoverLetterV2, checkCoverLetterDraft, jdLetterRequests, loadBannedPhrases, runCoverLetterV2 } from '../cover-letter-v2.mjs';
import { createDraftManifest, validateClaims } from '../cv-claims.mjs';

const company = 'Northstar Labs';
const role = 'Data Engineer';
const filler = 'The posting describes ingestion work on event data, reporting tables for product teams, and checks that keep the numbers trustworthy.';
const jdBase = `${company} is hiring a ${role} in Example City. ${filler} You know Python, SQL and Java. Integrated with the Example API, our predictive maintenance models run nightly.`;
const passingValidator = async ({ claims }) => ({ ok: true, results: claims.map(claim => ({ claimId: claim.id, status: 'pass' })) });

// A letter of about 200 words: background filler repeated as JD-context sentences, plus the sentences under test.
function draft(testSentences = [], { overrides, greeting = `Dear ${company} hiring team,`, extraJd = '' } = {}) {
  const context = Array.from({ length: 8 }, () => filler).join(' ');
  return {
    company, role, language: 'en',
    jd: { text: `${jdBase} ${extraJd}`.trim() },
    greeting,
    paragraphs: [
      { text: `I am a computer science master's student, and I am applying for the ${role} position.`, claims: [{ id: 'intro', text: `I am a computer science master's student, and I am applying for the ${role} position.` }] },
      { text: context, claims: [] },
      ...(testSentences.length ? [{ text: testSentences.join(' '), claims: testSentences.map((text, index) => ({ id: `t${index}`, text })) }] : []),
    ],
    closing: 'I would welcome a conversation about the role.',
    signature: 'Alex Example',
    ...(overrides ? { exclusionOverrides: overrides } : {}),
  };
}

const check = (letter, options = {}) => checkCoverLetterDraft(letter, {
  jdText: letter.jd.text, jdCompany: company, jdRole: role, validateClaims: passingValidator, ...options,
});
const byId = (result, id) => result.checks.find(item => item.id === id);

test('excluded topics fail with the matched text; ordinary student and programme wording passes', async () => {
  const clean = await check(draft([
    "I am a Computer Science master's student at the University of Example.",
    'The graduate programme mentioned in the posting fits my background.',
  ]));
  assert.equal(byId(clean, 'excluded_topics').status, 'pass');
  for (const [sentence, topic] of [
    ['I hold a residence permit for studies in Finland.', 'permit'],
    ['My work permit allows full-time work.', 'permit'],
    ['I will need visa sponsorship for this role.', 'permit'],
    ['I do not need sponsorship.', 'authorization'],
    ['I am authorised to work in Finland.', 'authorization'],
    ['I have the right to work here.', 'authorization'],
    ['I expect to graduate in May 2031.', 'graduation'],
    ['My expected graduation is next spring.', 'graduation'],
    ['I am graduating in 2031.', 'graduation'],
    ['I am in the final year of my studies.', 'graduation'],
    ['I will finish my degree by the end of the year.', 'graduation'],
  ]) {
    const result = await check(draft([sentence]));
    const item = byId(result, 'excluded_topics');
    assert.equal(item.status, 'fail', sentence);
    assert.equal(item.reasonCode, 'excluded_topic', sentence);
    assert.ok(item.matches.some(match => match.topic === topic && match.sentence === sentence), sentence);
    assert.equal(result.ok, false);
  }
});

test('company and role names are not scanned: an employer called Visa passes', async () => {
  const letter = { ...draft(['I would like to work on payments at Visa.']), company: 'Visa' };
  letter.jd.text = letter.jd.text.replace(company, 'Visa');
  const result = await check(letter, { jdCompany: 'Visa' });
  assert.equal(byId(result, 'excluded_topics').status, 'pass');
  const header = await check({ ...draft(), role: 'Graduate Engineer 2031' }, { jdRole: 'Graduate Engineer 2031' });
  assert.equal(byId(header, 'excluded_topics').status, 'pass', 'the role line is metadata, not letter prose');
});

test('a per-draft exception covers only its quoted sentence and topic, and must be used', async () => {
  const sentence = 'I expect to graduate in May 2031.';
  const ok = await check(draft([sentence], { overrides: [{ topic: 'graduation', text: sentence, reason: 'Posting asks for the graduation date in the letter; owner approved in chat.' }] }));
  assert.equal(byId(ok, 'excluded_topics').status, 'pass');
  assert.deepEqual(byId(ok, 'excluded_topics').overrides.map(item => item.topic), ['graduation']);

  const other = await check(draft([sentence, 'I hold a work permit.'], { overrides: [{ topic: 'graduation', text: sentence, reason: 'approved' }] }));
  assert.equal(byId(other, 'excluded_topics').reasonCode, 'excluded_topic', 'the exception does not cover a different sentence');
  const wrongTopic = await check(draft([sentence], { overrides: [{ topic: 'permit', text: sentence, reason: 'approved' }] }));
  assert.equal(byId(wrongTopic, 'excluded_topics').status, 'fail');
  const unused = await check(draft([], { overrides: [{ topic: 'graduation', text: 'I would welcome a conversation about the role.', reason: 'approved' }] }));
  assert.equal(byId(unused, 'excluded_topics').reasonCode, 'unused_exclusion_override');
  for (const bad of [[{ topic: 'everything', text: sentence, reason: 'x' }], [{ topic: 'graduation', text: 'Not in the letter.', reason: 'x' }],
    [{ topic: 'graduation', text: sentence }], { topic: 'graduation' }]) {
    const result = await check(draft([sentence], { overrides: bad }));
    assert.equal(byId(result, 'excluded_topics').reasonCode, 'invalid_exclusion_override', JSON.stringify(bad));
  }
});

test('approval of a letter with an exception requires confirming exactly its topics', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'cover-standard-approve-'));
  try {
    const sentence = 'I expect to graduate in May 2031.';
    const letter = draft([sentence], { overrides: [{ topic: 'graduation', text: sentence, reason: 'Owner approved for this posting.' }] });
    const result = await runCoverLetterV2(letter, {
      jdText: letter.jd.text, jdCompany: company, jdRole: role, validateClaims: passingValidator, outputDirectory, profile: null,
    });
    assert.equal(result.status, 'pass');
    await assert.rejects(() => approveCoverLetterV2(result.files.check), /confirm exactly those topics/);
    await assert.rejects(() => approveCoverLetterV2(result.files.check, { confirmExclusionOverrides: ['permit'] }), /confirm exactly/);
    const approved = await approveCoverLetterV2(result.files.check, { confirmExclusionOverrides: ['graduation'] });
    const record = JSON.parse(await readFile(approved.approvedPath, 'utf8'));
    assert.deepEqual(record.exclusionOverrides.map(item => item.topic), ['graduation']);

    const plain = draft();
    const plainResult = await runCoverLetterV2(plain, {
      jdText: plain.jd.text, jdCompany: company, jdRole: role, validateClaims: passingValidator, outputDirectory, profile: null,
    });
    await assert.rejects(() => approveCoverLetterV2(plainResult.files.check, { confirmExclusionOverrides: ['graduation'] }), /nothing to confirm/);
    const plainApproved = await approveCoverLetterV2(plainResult.files.check);
    assert.equal(JSON.parse(await readFile(plainApproved.approvedPath, 'utf8')).exclusionOverrides, undefined);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('a dual-use technical word passes only as a term found in the CV or posting; filler still fails', async () => {
  const phrases = ['integrated', 'predictive', 'scalable', 'dynamic', 'robust'];
  const technical = await check(draft(['The service I studied was integrated with the Example API and fed predictive maintenance reports.']), { bannedPhrases: phrases });
  assert.equal(byId(technical, 'banned_phrases').status, 'pass');
  assert.deepEqual(byId(technical, 'banned_phrases').technicalUses.sort(), ['integrated', 'predictive']);
  const buzz = await check(draft(['I enjoy building scalable solutions in a dynamic team.']), { bannedPhrases: phrases });
  assert.deepEqual(byId(buzz, 'banned_phrases').matches.sort(), ['dynamic', 'scalable']);
  const notInSources = await check(draft(['I like predictive analytics.']), { bannedPhrases: phrases });
  assert.deepEqual(byId(notInSources, 'banned_phrases').matches, ['predictive']);
  const cvTerm = await check(draft(['I like predictive analytics.']), { bannedPhrases: phrases, cv: '## Projects\n- Built predictive analytics notebooks.' });
  assert.equal(byId(cvTerm, 'banned_phrases').status, 'pass');
  const mixed = await check(draft(['It was integrated with the Example API.', 'The design is integrated and seamless.']), { bannedPhrases: phrases });
  assert.deepEqual(byId(mixed, 'banned_phrases').matches, ['integrated'], 'every occurrence must be a technical term');
});

test('an "em dashes" avoid entry enforces the character; company names are not scanned for banned words', async () => {
  const { mkdtemp: mk, writeFile, mkdir } = await import('node:fs/promises');
  const root = await mk(join(tmpdir(), 'cover-standard-avoid-'));
  try {
    await mkdir(join(root, 'modes'));
    await writeFile(join(root, 'modes', '_profile.md'), '## Writing\n\nAvoid:\n- "dynamic"\n- em dashes\n');
    const phrases = await loadBannedPhrases({ root });
    assert.ok(phrases.includes('—'));
    const dash = await check(draft(['The warehouse — a personal project — holds the reporting tables.']), { bannedPhrases: phrases });
    assert.deepEqual(byId(dash, 'banned_phrases').matches, ['—']);
    const range = await check(draft(['The records cover 2017–2025.']), { bannedPhrases: phrases });
    assert.equal(byId(range, 'banned_phrases').status, 'pass', 'an en dash in a range is not an em dash');
    const named = { ...draft(), company: 'Dynamic Data Oy', greeting: 'Dear Dynamic Data Oy hiring team,' };
    named.jd.text = named.jd.text.replace(company, 'Dynamic Data Oy');
    const result = await check(named, { bannedPhrases: phrases, jdCompany: 'Dynamic Data Oy' });
    assert.equal(byId(result, 'banned_phrases').status, 'pass');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a posting that asks for salary, permit or graduation details in the letter is surfaced, not blocked', async () => {
  assert.deepEqual(jdLetterRequests('Please include your salary expectations in your cover letter. Apply by Friday.').map(item => item.topic), ['salary']);
  assert.deepEqual(jdLetterRequests('Liitä hakemukseen palkkatoiveesi.').map(item => item.topic), ['salary']);
  assert.deepEqual(jdLetterRequests('State your expected graduation date and work permit status in the motivation letter.').map(item => item.topic).sort(), ['graduation', 'permit']);
  assert.deepEqual(jdLetterRequests('We offer a competitive salary. Send your CV and cover letter.'), [], 'separate sentences do not combine');
  assert.deepEqual(jdLetterRequests('Salary expectations will be discussed in the interview.'), []);
  const result = await check(draft([], { extraJd: 'Please include your salary expectations in your cover letter.' }));
  assert.equal(byId(result, 'jd_letter_requests').status, 'pass');
  assert.equal(byId(result, 'jd_letter_requests').requests[0].topic, 'salary');
});

const cvText = `# Alex Example

Example City, Exampleland | alex@example.test

## Profile

Master's student in Computer Science at the University of Example with project work in data engineering.

## Technical Skills

- **Programming:** Python, SQL, Java, Bash

## Projects

### Ledger Warehouse - Personal Project

- Built a PostgreSQL warehouse from 900,000 public ledger records with a star schema.
`;
const manifest = createDraftManifest(cvText);
const skill = name => manifest.claims.find(claim => claim.type === 'technology' && claim.text === name).id;
const profile = { location: { relocation: { timeframe: 'Within one month of receiving a job offer', approved_wording: 'I am based in Example City and can relocate within one month of an offer.' } } };
const RELOCATION = ['profile:location.relocation'];
const validate = (text, evidence, jdText = jdBase, withProfile = profile) =>
  validateClaims({ claims: [{ id: 'c', text, evidence }], manifest, cv: cvText, jdText, profile: withProfile }).results[0];

test('a plain mention of a CV skill passes; claims of use, depth or experience still fail', () => {
  assert.equal(validate('I also know Java.', [skill('Java')]).status, 'pass');
  assert.equal(validate('I know Java and Bash as well.', [skill('Java'), skill('Bash')]).status, 'pass');
  assert.equal(validate('I know Java and Bash.', [skill('Java')]).status, 'fail', 'every named skill must be cited');
  assert.equal(validate('I also know Java.', [skill('Python')]).status, 'fail', 'the cited skill must be the named one');
  assert.equal(validate('I also know Kotlin.', [skill('Java')]).status, 'fail');
  for (const text of ['I have professional experience with Java.', 'I know Java well.', 'I am an expert in Java.',
    'I have built production services in Java.', 'I know Java from two years of work.']) {
    assert.equal(validate(text, [skill('Java')]).status, 'fail', text);
  }
  const project = manifest.claims.find(claim => claim.type === 'project' && /warehouse/.test(claim.text)).id;
  assert.equal(validate('I also know Java.', [project]).status, 'fail', 'only skills-section entries support a plain mention');
});

test('"I am" is accepted like "I\'m" in a cited paraphrase; it adds no fact', () => {
  const profileLine = manifest.claims.find(claim => claim.type === 'role' && /Master's student/.test(claim.text)).id;
  assert.equal(validate("I am a Computer Science master's student at the University of Example.", [profileLine]).status, 'pass');
  assert.equal(validate("I'm a Computer Science master's student at the University of Example.", [profileLine]).status, 'pass');
  assert.equal(validate('I am a senior data engineer at the University of Example.', [profileLine]).status, 'fail');
});

test('relocation claims cite the profile relocation record only, never with authorisation or start-date wording', () => {
  assert.equal(validate('I am based in Example City and can relocate within one month of an offer.', RELOCATION).status, 'pass');
  assert.equal(validate('I live in Example City and can relocate.', RELOCATION).status, 'pass', 'the timeframe is optional');
  const destination = validate('I can relocate to Tampere within one month of an offer.', RELOCATION, `${jdBase} The office is in Tampere.`);
  assert.equal(destination.status, 'pass', 'a destination named by the posting');
  assert.equal(validate('I can relocate to Tampere within one month of an offer.', RELOCATION).reasonCode, 'unknown_named_entity');
  assert.equal(validate('I can relocate within two weeks of an offer.', RELOCATION).status, 'fail');
  assert.equal(validate('I can relocate within one month and need no visa.', RELOCATION).reasonCode, 'relocation_with_authorization');
  assert.equal(validate('I can start within one month of an offer.', RELOCATION).status, 'fail', 'relocation is not a start date');
  assert.equal(validate('I am based in Example City and can relocate within one month of an offer.', RELOCATION, jdBase, null).reasonCode, 'profile_evidence_missing');
  assert.equal(validate('I can relocate within one month of an offer.', ['profile:work_authorization']).reasonCode, 'evidence_invalid');
  assert.equal(validate('I can relocate within one month of an offer.', [...RELOCATION, skill('Java')]).reasonCode, 'evidence_invalid');
});

test('the gate passes the profile to the real validator for a relocation sentence', async () => {
  const sentence = 'I am based in Example City and can relocate within one month of an offer.';
  const letter = draft([sentence]);
  letter.paragraphs[2].claims[0].evidence = RELOCATION;
  letter.paragraphs[0] = { text: `I am applying for the ${role} position.`, claims: [] };
  const options = { jdText: letter.jd.text, jdCompany: company, jdRole: role, validateClaims, manifest, cv: cvText };
  const withProfile = await checkCoverLetterDraft(letter, { ...options, profile });
  assert.equal(byId(withProfile, 'claim_validation').status, 'pass', JSON.stringify(byId(withProfile, 'claim_validation').failedResults));
  const without = await checkCoverLetterDraft(letter, { ...options, profile: null });
  assert.equal(byId(without, 'claim_validation').status, 'fail');
});

test('review regressions: employer-name masking, permit and degree-completion wording, overrides with names', async () => {
  const visa = { ...draft(['I hold a work visa for Finland.']), company: 'Visa' };
  visa.jd.text = visa.jd.text.replace(company, 'Visa');
  assert.equal(byId(await check(visa, { jdCompany: 'Visa' }), 'excluded_topics').status, 'fail', 'the candidate\'s visa is still found');
  for (const sentence of ['My permit allows full-time work.', 'I will complete my MSc in May 2031.']) {
    assert.equal(byId(await check(draft([sentence])), 'excluded_topics').status, 'fail', sentence);
  }
  assert.equal(byId(await check(draft(['Time and budget permit me to start soon.'])), 'excluded_topics').status, 'pass');
  const named = 'I hold a work permit for Northstar Labs.';
  const ok = await check(draft([named], { overrides: [{ topic: 'permit', text: named, reason: 'Owner approved.' }] }));
  assert.equal(byId(ok, 'excluded_topics').status, 'pass', 'an exception quoting the employer name matches');
});

test('review regressions: relocation evidence cannot place the candidate elsewhere or invent an offer', () => {
  const tampere = `${jdBase} The office is in Tampere.`;
  assert.equal(validate('I am based in Tampere.', RELOCATION, tampere).status, 'fail');
  assert.equal(validate('I am based in Tampere and can relocate.', RELOCATION, tampere).reasonCode, 'unknown_named_entity');
  assert.equal(validate('I have a job offer.', RELOCATION).status, 'fail');
  assert.equal(validate('I have received a job offer and can relocate.', RELOCATION).status, 'fail');
  assert.equal(validate('I can relocate to the Tampere area.', RELOCATION, tampere).status, 'pass');
});

test('second review: date-first completion wording and negated relocation records are caught', async () => {
  assert.equal(byId(await check(draft(['In May 2031, I will complete my MSc.'])), 'excluded_topics').status, 'fail');
  const refusing = { location: { relocation: { approved_wording: 'I cannot relocate.' } } };
  assert.equal(validate('I can relocate.', RELOCATION, jdBase, refusing).reasonCode, 'profile_evidence_negated');
  assert.equal(validate('I cannot relocate.', RELOCATION).status, 'fail');
});
