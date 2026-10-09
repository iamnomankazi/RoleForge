import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  prescreenJob, loadPrescreenProfile, derivePrescreenCountry,
  PRESCREEN_BLOCKER_CODES, PRESCREEN_FLAG_CODES,
} from '../prescreen.mjs';
import { classifyExperienceRequirements } from '../experience-policy.mjs';

const profile = {
  languages: { english: 'C1', german: 'basic' },
  home_country: 'fi', residence_country: 'fi', authorized_countries: ['fi'],
  outside_home_authorized: false, sponsorship_outside_home: true,
  citizenship_countries: ['in'], graduation_date: '2026-12-31',
};
const screen = (description, location = 'Berlin', candidate = profile, options) => prescreenJob({ description, location }, candidate, options);
const hasBlock = (result, code) => result.blockers.some(item => item.code === code);
const hasFlag = (result, code) => result.flags.some(item => item.code === code);

test('shared code vocabulary is exact and frozen', () => {
  assert.deepEqual(PRESCREEN_BLOCKER_CODES, ['language_required', 'work_auth_restricted', 'graduation_window', 'experience_outside']);
  assert.deepEqual(PRESCREEN_FLAG_CODES, ['sponsorship_unknown', 'language_preferred', 'experience_stretch']);
  assert.ok(Object.isFrozen(PRESCREEN_BLOCKER_CODES));
  assert.ok(Object.isFrozen(PRESCREEN_FLAG_CODES));
});

for (const [text, language, level] of [
  ['fließend Deutsch', 'german', 'C1'],
  ['verhandlungssicheres Deutsch', 'german', 'C1'],
  ['C1 German', 'german', 'C1'],
  ['Deutschkenntnisse auf C1-Niveau', 'german', 'C1'],
  ['Dutch at B2 level', 'dutch', 'B2'],
  ['fluent in Dutch', 'dutch', 'C1'],
  ['vloeiend Nederlands', 'dutch', 'C1'],
  ['sujuva suomen kielen taito', 'finnish', 'C1'],
  ['flytande svenska', 'swedish', 'C1'],
  ['flydende dansk', 'danish', 'C1'],
  ['Fluent French required', 'french', 'C1'],
  ['français courant', 'french', 'C1'],
  ['German B1 required', 'german', 'B1'],
]) {
  test(`explicit language: ${text}`, () => {
    const result = screen(text);
    assert.ok(hasBlock(result, 'language_required'));
    assert.equal(result.language_requirements[0].language, language);
    assert.equal(result.language_requirements[0].level, level);
    assert.equal(result.language_requirements[0].required, true);
    assert.equal(result.blockers[0].evidence, text);
  });
}

for (const text of [
  'Fluent German is a plus', 'C1 German nice to have', 'fließend Deutsch von Vorteil',
  'sujuva suomen kielen taito eduksi', 'flytande svenska meriterande',
  'German preferred', 'Fluent French preferred', 'Preferred qualifications:\nFluent German',
  '<h2>Nice to have</h2><ul><li>Fluent German</li></ul>',
]) {
  test(`language preference: ${text}`, () => {
    const result = screen(text);
    assert.ok(hasFlag(result, 'language_preferred'));
    assert.ok(!hasBlock(result, 'language_required'));
    assert.equal(result.language_requirements[0].required, false);
  });
}

test('English never blocks, including native requirements', () => {
  assert.ok(!hasBlock(screen('Native English required', 'Berlin', {}), 'language_required'));
  assert.equal(screen('Fluent English').language_requirements[0].language, 'english');
});
test('profile proficiency at or above the requirement is accepted', () => {
  assert.ok(!hasBlock(screen('German B2 required', 'Berlin', { ...profile, languages: { german: 'C1' } }), 'language_required'));
  assert.ok(!hasBlock(screen('Basic German required'), 'language_required'));
});
test('German prose, customers and negated requirements do not imply fluency', () => {
  for (const text of ['Unsere Software hilft Unternehmen beim Aufbau ihrer Datenplattform.',
    'We work with our German customers.', 'German is not required.', 'No German knowledge required.',
    'We need German engineers.', 'Our Dutch office requires Python experience.']) {
    assert.ok(!hasBlock(screen(text), 'language_required'), text);
  }
});
test('required language remains required after a preference section ends', () => {
  const result = screen('Nice to have:\nFluent German\nRequirements:\nFluent Dutch');
  assert.ok(hasFlag(result, 'language_preferred'));
  assert.ok(hasBlock(result, 'language_required'));
});
test('an English alternative satisfies the language condition', () => {
  assert.ok(!hasBlock(screen('Fluent German or English required'), 'language_required'));
});
test('required and preferred clauses are independent', () => {
  assert.ok(hasBlock(screen('Fluent German required; Dutch preferred'), 'language_required'));
  assert.ok(hasBlock(screen('Fluent Dutch required but German preferred'), 'language_required'));
});
test('compacted text keeps unrelated preferences separate from required fluency', () => {
  const text = 'You have excellent skills. Sehr gute Deutschkenntnisse (C1) in Wort und Schrift, sowie gute EnglischkenntnisseNice to have: Framework experience';
  const result = screen(text);
  assert.ok(hasBlock(result, 'language_required'));
  assert.equal(result.language_requirements.find(item => item.language === 'german').level, 'C1');
});
test('coordinated fluency and alternatives use the applicable profile level', () => {
  assert.ok(hasBlock(screen('Fluent English and German required'), 'language_required'));
  assert.ok(!hasBlock(screen('Fluent German or Dutch required', 'Berlin', { ...profile, languages: { dutch: 'C1' } }), 'language_required'));
  assert.ok(!hasBlock(screen(`${'Context '.repeat(40)}Fluent German or English required`), 'language_required'));
});
test('unrelated alternatives and learning resources do not change language eligibility', () => {
  const result = screen('Use Python or Java. Articulate communication skills in German (C1 level) and English (B2 level)');
  assert.ok(hasBlock(result, 'language_required'));
  assert.ok(hasBlock(screen('Use Python or Java and fluent German and English required'), 'language_required'));
  assert.deepEqual(screen('Learning German (B1 level exam)').language_requirements, []);
});

for (const text of [
  'No visa sponsorship', 'We are unable to sponsor visas', 'We cannot provide visa sponsorship',
  'We do not sponsor visas', 'Visa sponsorship is not available',
  'You must already have the right to work in Germany',
  'Must have existing right to work in Germany', 'Existing right to work in Germany is required',
  'You must be based in Germany', 'EU citizenship required', 'EU/EEA citizens only',
]) {
  test(`explicit authorization restriction: ${text}`, () => {
    const result = screen(text);
    assert.ok(hasBlock(result, 'work_auth_restricted'));
    assert.equal(result.work_authorization.status, 'restricted');
    assert.equal(result.blockers[0].evidence, text);
  });
}
test('UK and Dutch existing-work-right restrictions override an unknown location', () => {
  for (const text of ['You must already have the right to work in the UK', 'Must already have the right to work in the Netherlands']) {
    assert.ok(hasBlock(screen(text, 'Remote'), 'work_auth_restricted'));
  }
});
test('Finland authorization is met, and sponsorship exclusions there do not block', () => {
  for (const text of ['You must have the right to work in Finland', 'No visa sponsorship']) {
    const result = screen(text, 'Helsinki, Finland');
    assert.ok(!hasBlock(result, 'work_auth_restricted'));
    assert.equal(result.work_authorization.status, 'authorized');
    assert.equal(result.work_authorization.country, 'fi');
  }
});
test('sponsorship silence only produces a flag when sponsorship is needed', () => {
  for (const location of ['Berlin', 'Helsinki', 'Remote - EU']) {
    const result = screen('Build backend services with Python.', location);
    assert.deepEqual(result.blockers, []);
    assert.equal(hasFlag(result, 'sponsorship_unknown'), location === 'Berlin');
    if (location === 'Berlin') assert.equal(result.flags.find(item => item.code === 'sponsorship_unknown').evidence, '');
  }
});

test('finding 1: language negation governs only its own assertion', () => {
  assert.deepEqual(screen('We do not require fluent German').blockers, []);
  const result = screen('Fluent German required and French not required');
  assert.deepEqual(result.blockers.map(item => item.code), ['language_required']);
  assert.equal(result.language_requirements[0].language, 'german');
});
test('finding 2: negated authorization and residence assertions do not restrict', () => {
  for (const text of ['You do not need to have the right to work in Germany', 'You do not have to be based in Germany']) {
    assert.deepEqual(screen(text).blockers, [], text);
  }
});
test('finding 3: unrelated alternatives do not suppress authorization restrictions', () => {
  for (const text of ['We cannot sponsor visas or work permits', 'EU/EEA citizens only, Python or Java required']) {
    assert.deepEqual(screen(text).blockers.map(item => item.code), ['work_auth_restricted'], text);
  }
});
test('finding 4: preference governs the entire coordinated language list', () => {
  const result = screen('Fluent German and French are a plus');
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.language_requirements.map(({ language, required }) => ({ language, required })), [
    { language: 'german', required: false }, { language: 'french', required: false },
  ]);
});
test('finding 5: German hyphenated language alternatives share proficiency', () => {
  const result = screen('Fließende Deutsch- oder Englischkenntnisse');
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.language_requirements.map(item => item.language).sort(), ['english', 'german']);
});
test('finding 6: explicit German minimum CEFR is required', () => {
  const result = screen('Deutschkenntnisse auf mindestens B2-Niveau erforderlich');
  assert.deepEqual(result.blockers.map(item => item.code), ['language_required']);
  assert.equal(result.language_requirements[0].level, 'B2');
});
test('finding 7: excellent proficiency exceeds basic', () => {
  const result = screen('Excellent German required');
  assert.deepEqual(result.blockers.map(item => item.code), ['language_required']);
  assert.equal(result.language_requirements[0].level, 'C1');
});
test('finding 8: team language descriptions do not require candidate proficiency', () => {
  assert.deepEqual(screen('Our team speaks fluent German').blockers, []);
});
test('finding 9: all country names, codes and cities contribute to ambiguity', () => {
  const result = screen('No visa sponsorship', 'Helsinki, FI / Berlin, Germany');
  assert.equal(result.work_authorization.country, null);
  assert.deepEqual(result.blockers, []);
  assert.equal(derivePrescreenCountry('Helsinki, Finland / Berlin'), null);
});
test('finding 10: graduation windows accept seasons and months', () => {
  for (const text of ['You will graduate between fall 2027 and summer 2028 with a degree in Computer Science',
    'Applicants must graduate between June 2025 and June 2026']) {
    assert.deepEqual(screen(text).blockers.map(item => item.code), ['graduation_window'], text);
  }
});
test('finding 11: graduation preference, negation and alternatives have assertion scope', () => {
  assert.deepEqual(screen('Graduating between 2023 and 2025 required, Python preferred').blockers.map(item => item.code), ['graduation_window']);
  assert.deepEqual(screen('Graduating between 2023 and 2025 is not necessary').blockers, []);
  const alternative = screen('Applicants must have graduated between 2023 and 2025 or graduate during 2026');
  assert.deepEqual(alternative.blockers, []);
  assert.equal(alternative.graduation_window.eligible, true);
});
test('finding 12: decoded experience digits preserve verbatim source evidence', () => {
  for (const evidence of ['&#52; years', '4 years']) {
    const result = screen(`${evidence} of experience required`);
    assert.equal(result.experience.numeric_hard_blocker, true);
    assert.deepEqual(result.blockers.map(item => item.code), ['experience_outside']);
    assert.equal(result.blockers[0].evidence, evidence);
  }
});
test('finding 13: authorized Finland roles need no sponsorship uncertainty flag', () => {
  const result = screen('Build backend services.', 'Helsinki, Finland');
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.flags, []);
  assert.equal(result.work_authorization.status, 'authorized');
});
test('finding 14: US city/state locations do not interpret states as country codes', () => {
  assert.equal(derivePrescreenCountry('Wilmington, DE'), 'us');
  assert.equal(screen('Build backend services.', 'Wilmington, DE').work_authorization.country, 'us');
});
test('candidate language assertions survive compacted descriptive text', () => {
  const text = 'You possess excellent German and English skills (minimum C1 level)You can work in our office';
  assert.ok(hasBlock(screen(text), 'language_required'));
  assert.deepEqual(screen('Our customers speak fluent German and Python required').blockers, []);
  assert.ok(hasBlock(screen('Fluent German required and no need for French'), 'language_required'));
});
test('coordinated language preferences preserve independent assertions', () => {
  assert.deepEqual(screen('Fluent German, French are a plus').blockers, []);
  const result = screen('Fluent German preferred and Fluent French required');
  assert.equal(result.language_requirements.find(item => item.language === 'german').required, false);
  assert.equal(result.language_requirements.find(item => item.language === 'french').required, true);
  assert.ok(hasBlock(result, 'language_required'));
});
test('work restrictions accept satisfied country alternatives and direct preferences', () => {
  for (const text of ['Must be based in Germany or Finland', 'Must have the right to work in Germany or Finland',
    'EU citizenship preferred', 'EU/EEA citizens only preferred', 'Must be based in Germany preferred']) {
    assert.deepEqual(screen(text).blockers, [], text);
  }
  assert.ok(hasBlock(screen('Must be based in Germany or France'), 'work_auth_restricted'));
  assert.equal(derivePrescreenCountry('Berlin, DE'), 'de');
  assert.equal(derivePrescreenCountry('Wilmington, DE / Helsinki, Finland'), null);
});
test('graduation calendar boundaries are inclusive and experience hex digits retain evidence', () => {
  const text = 'Applicants must graduate between June 2025 and June 2026';
  const result = screen(text);
  assert.equal(result.graduation_window.start, '2025-06-01');
  assert.equal(result.graduation_window.end, '2026-06-30');
  assert.deepEqual(screen(text, 'Berlin', { ...profile, graduation_date: '2026-06-30' }).blockers, []);
  assert.ok(hasBlock(screen(text, 'Berlin', { ...profile, graduation_date: '2026-07-01' }), 'graduation_window'));
  assert.equal(screen('&#x34; years of experience required').blockers[0].evidence, '&#x34; years');
});
for (const text of ['We sponsor visas', 'Visa sponsorship available',
  'No sponsorship needed for EU citizens; we sponsor others',
  'No visa sponsorship for EU citizens, but we sponsor others',
  'Sponsorship is available if required']) {
  test(`sponsorship false-positive guard: ${text}`, () => {
    const result = screen(text);
    assert.ok(!hasBlock(result, 'work_auth_restricted'));
    assert.ok(!hasFlag(result, 'sponsorship_unknown'));
  });
}
test('negative sponsorship need and conditional citizenship are not restrictions', () => {
  for (const text of ['No visa sponsorship required', 'EU citizens only unless sponsorship is arranged',
    'Must have the right to work in Germany or be eligible for visa sponsorship']) {
    assert.ok(!hasBlock(screen(text), 'work_auth_restricted'), text);
  }
});
test('portal navigation does not establish sponsorship availability', () => {
  assert.ok(hasFlag(screen('Jobs with Visa Sponsorship\nBuild our backend services'), 'sponsorship_unknown'));
});
test('unknown profile facts do not establish an authorization or residency mismatch', () => {
  for (const text of ['No visa sponsorship', 'EU citizens only', 'Must be based in Germany', 'Must have the right to work in Germany']) {
    const result = screen(text, 'Berlin', {});
    assert.ok(!hasBlock(result, 'work_auth_restricted'));
  }
  assert.ok(!hasBlock(screen('No visa sponsorship', 'Remote'), 'work_auth_restricted'));
});
test('Finland residence meets EU residence but never implies EU citizenship', () => {
  assert.ok(!hasBlock(screen('Must be based in the EU', 'Remote - EU'), 'work_auth_restricted'));
  assert.ok(hasBlock(screen('EU citizenship required', 'Helsinki'), 'work_auth_restricted'));
  assert.ok(!hasBlock(screen('EU citizens only', 'Berlin', { ...profile, citizenship_countries: ['de'] }), 'work_auth_restricted'));
});

test('graduation cohorts use inclusive full years', () => {
  const result = screen('Applicants must have graduated between 2023 and 2025');
  assert.ok(hasBlock(result, 'graduation_window'));
  assert.deepEqual(result.graduation_window, {
    start: '2023-01-01', end: '2025-12-31', candidate_date: '2026-12-31', eligible: false,
    evidence: 'Applicants must have graduated between 2023 and 2025',
  });
  assert.ok(!hasBlock(screen('Graduating between 2026 and 2026'), 'graduation_window'));
  assert.ok(!hasBlock(screen('Graduated between 2023 and 2026'), 'graduation_window'));
});
test('unknown graduation, preferred cohorts and company history never block', () => {
  assert.equal(screen('Graduated between 2023 and 2025', 'Berlin', {}).graduation_window.eligible, null);
  for (const text of ['Graduated between 2023 and 2025 preferred', 'Our team graduated between 2023 and 2025', 'We launched between 2023 and 2025']) {
    assert.ok(!hasBlock(screen(text), 'graduation_window'));
  }
});
test('experience reuses the shared classifier and maps outside/stretch', () => {
  const text = 'You need at least 4 years of professional experience.';
  const result = screen(text);
  assert.deepEqual(result.experience, classifyExperienceRequirements(`\n${text}`, { normal_max_years: 2, outside_min_years: 4 }));
  assert.ok(hasBlock(result, 'experience_outside'));
  assert.equal(result.blockers[0].evidence, 'at least 4 years');
  assert.ok(hasFlag(screen('3+ years of experience required'), 'experience_stretch'));
  assert.ok(hasFlag(screen('2-5 years of professional experience'), 'experience_stretch'));
  for (const text of ['2+ years of experience', '5 years of experience preferred', 'Our company has operated for 10 years']) {
    assert.ok(!hasBlock(screen(text), 'experience_outside'));
  }
  assert.equal(screen('Build backend systems.').experience, null);
  assert.equal(screen(text, 'Berlin', profile, { experiencePolicy: { enabled: false } }).experience, null);
});
test('all evidence is bounded, verbatim and deterministic, including HTML', () => {
  const description = `${'Context '.repeat(40)}<b>Fluent</b> German required.\nNo visa sponsorship.\n4  years of experience required.`;
  const first = screen(description);
  assert.deepEqual(screen(description), first);
  assert.ok(hasBlock(first, 'language_required'));
  for (const item of [...first.blockers, ...first.flags, ...first.language_requirements]) {
    assert.ok(item.evidence.length <= 200);
    assert.ok(description.includes(item.evidence));
  }
});
test('experience evidence preserves HTML entities and formatting', () => {
  const description = 'You need at least <b>4</b>&nbsp;years of professional experience';
  const result = screen(description);
  assert.equal(result.experience.numeric_hard_blocker, true);
  assert.ok(hasBlock(result, 'experience_outside'));
  assert.ok(description.includes(result.blockers[0].evidence));
});
test('location mapping covers portal hubs, boundaries, ambiguity and explicit ISO override', () => {
  for (const [location, country] of [['Helsinki, Finland', 'fi'], ['Joensuu', 'fi'], ['Köln', 'de'],
    ['Berlin', 'de'], ['Nürnberg', 'de'], ['Amsterdam', 'nl'], ['Den Haag', 'nl'],
    ['Copenhagen', 'dk'], ['Hillerød', 'dk'], ['London, UK', 'gb']]) {
    assert.equal(derivePrescreenCountry(location), country, location);
  }
  for (const location of ['Remote - EU', 'Worldwide', 'Berlin or Helsinki', 'Helsinkish']) {
    assert.equal(derivePrescreenCountry(location), null, location);
  }
  assert.equal(derivePrescreenCountry('Berlin', 'FI'), 'fi');
  assert.equal(derivePrescreenCountry('Remote in Berlin'), 'de');
  assert.throws(() => derivePrescreenCountry('Berlin', 'Germany'), /ISO-2/);
});
test('profile loader uses verified YAML keys and retains no personal identity', t => {
  const directory = mkdtempSync(join(tmpdir(), 'prescreen-profile-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile.yml');
  writeFileSync(path, `candidate:
  full_name: Synthetic Candidate
  citizenship: India / Indian
location:
  country: Finland
education_details:
  expected_graduation_date: '31/12/2026'
application_form:
  work_authorization:
    home_country: Finland
    finland_authorized: 'Yes'
    outside_finland_local_authorized: 'No'
    outside_finland_sponsorship: 'Yes'
language:
  additional_proficiencies:
    german:
      level: Basic German only
      cefr: Not specified
`);
  const candidate = loadPrescreenProfile(path);
  assert.deepEqual(candidate, { ...profile, languages: { german: 'basic' } });
  assert.ok(!JSON.stringify(candidate).includes('Synthetic Candidate'));
  assert.ok(hasBlock(screen('C1 German', 'Berlin', candidate), 'language_required'));
  assert.equal(screen('', 'Helsinki', candidate).work_authorization.status, 'authorized');
});
test('CLI accepts JSON, help and inline values, and rejects unknown flags/missing values', t => {
  const directory = mkdtempSync(join(tmpdir(), 'prescreen-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const jd = join(directory, 'jd.txt');
  const profilePath = join(directory, 'profile.yml');
  writeFileSync(jd, 'C1 German required');
  writeFileSync(profilePath, 'languages:\n  german: basic\n');
  const run = args => spawnSync(process.execPath, ['prescreen.mjs', ...args], { encoding: 'utf8' });
  const json = run(['--file', jd, '--profile', profilePath, '--location=Berlin', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.ok(hasBlock(JSON.parse(json.stdout), 'language_required'));
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node prescreen/);
  for (const args of [['--wat'], ['--help', '--wat'], ['--file'], ['--file', jd, '--country', 'Germany']]) {
    assert.equal(run(args).status, 1, args.join(' '));
  }
});
