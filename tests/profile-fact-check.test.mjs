import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGraduationConsistency, findGraduationDates } from '../profile-fact-check.mjs';

test('findGraduationDates recognizes month names, abbreviations, and supported numeric forms', () => {
  const text = [
    'Expected graduation: May 2027.',
    'Graduating in Dec 2026.',
    'Degree completion date: 31/05/2027.',
    'Graduation date: 31.05.2027.',
    'Graduation date: 2027-05-31.',
    'Graduation: 05/2027.',
  ].join('\n');
  assert.deepEqual(findGraduationDates(text), [
    { month: 5, year: 2027, raw: 'May 2027', line: 1 },
    { month: 12, year: 2026, raw: 'Dec 2026', line: 2 },
    { month: 5, year: 2027, raw: '31/05/2027', line: 3 },
    { month: 5, year: 2027, raw: '31.05.2027', line: 4 },
    { month: 5, year: 2027, raw: '2027-05-31', line: 5 },
    { month: 5, year: 2027, raw: '05/2027', line: 6 },
  ]);
});

test('consistency compares month and year, ignores unrelated dates, and compares year-only statements by year', () => {
  const profile = { education_details: { expected_graduation_date: '31/05/2027' } };
  const result = checkGraduationConsistency({ profile, files: [
    { path: 'cv.md', text: 'Graduation expected in May 2027.\nProject started in December 2026.' },
    { path: 'modes/_profile.md', text: 'Graduated in 2026.\nGraduation date: June 2027.' },
  ] });
  assert.deepEqual(result.profileDate, { month: 5, year: 2027 });
  assert.deepEqual(result.mismatches, [
    { path: 'modes/_profile.md', line: 1, raw: '2026', month: null, year: 2026 },
    { path: 'modes/_profile.md', line: 2, raw: 'June 2027', month: 6, year: 2027 },
  ]);
  assert.deepEqual(checkGraduationConsistency({
    profile: { expected_graduation_date: '2027-05-31' },
    files: [{ path: 'cv.md', text: 'Expected graduation: 15/05/2027.' }],
  }).mismatches, []);
  assert.deepEqual(checkGraduationConsistency({
    profile: { graduation_date: '31/05/2027' },
    files: [{ path: 'cv.md', text: 'Degree completion in 2028.' }],
  }).mismatches.map(({ year }) => year), [2028]);
});
