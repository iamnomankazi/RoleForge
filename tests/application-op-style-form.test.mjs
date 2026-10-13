// Regression tests for the OP Pohjola (SuccessFactors) run: upload tiles that open a dialog or hide their file
// input, "How did you hear" from discovery provenance, trainee salary, and yes/no skills questions.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { prepareOperationalApplicationForm } from '../application-form-engine.mjs';
import {
  applicationSourceFromDiscovery,
  canonicalFieldValue,
  skillExperienceAnswer,
  skillsAskedIn,
} from '../application-form-policy.mjs';

const dir = mkdtempSync(join(tmpdir(), 'roleforge-op-style-'));
function artifact(name, body) {
  const resolvedPath = join(dir, name);
  writeFileSync(resolvedPath, body);
  return { resolvedPath, intendedFilename: name, sha256: `sha256:${createHash('sha256').update(readFileSync(resolvedPath)).digest('hex')}` };
}
const artifacts = {
  cv: artifact('Example_Data_CV_2026.pdf', '%PDF-1.4 cv fixture'),
  coverLetter: artifact('example_cover_letter.pdf', '%PDF-1.4 cover fixture'),
};

const profile = {
  candidate: { full_name: 'Alex Example', email: 'alex.example@example.test', phone: '+358 40 0000000', location: 'Example City, Finland' },
  location: { country: 'Finland', city: 'Example City' },
  currentStatus: { availability: { start: 'January 2027' } },
  compensation: { target_range: 'EUR 55,000-60,000/year' },
  education: {},
  formRules: {
    current_location: { city: 'Example City', country: 'Finland', combined: 'Example City, Finland' },
    work_authorization: { home_country: 'Finland' },
    current_employment: { employer: 'Example Labs', role: 'Python Developer Intern' },
    source: { value: 'LinkedIn' },
  },
  answers: new Map(),
  priorApprovedAnswers: [],
  cvText: [
    '# Alex Example', '## Technical Skills',
    '- **Programming:** Python, SQL, JavaScript',
    '- **Analytics:** Power BI, Excel; familiarity with Airflow and dbt',
    '## Experience', '### Python Developer Intern | Example Labs',
  ].join('\n'),
  articleDigestText: '',
  answerBankText: '',
  profileModeText: '',
};
const context = {
  batchId: 'fixture-op',
  candidate: { candidate_id: `cand_v1_${'b'.repeat(64)}`, company: 'Example Bank', title: 'Data Analyst Trainee, Risk Management' },
  jobCountry: 'Finland',
  jdText: 'Data analyst trainee working with Python and SQL.',
  discovery: { source: 'websearch-handoff', urls: ['https://duunitori.fi/tyopaikat/tyo/data-analyst-trainee-123'] },
};

// SuccessFactors-like page: in-form account creation, CV tile that opens an upload dialog whose Browse button
// creates a file input on the fly, and a cover-letter tile backed by a hidden, unlabelled file input.
function opStylePage({ cvTile = 'dialog' } = {}) {
  const cvButton = cvTile === 'dead'
    ? '<button type="button" id="cv-btn" aria-label="Upload a CV">+</button>'
    : '<button type="button" id="cv-btn" aria-label="Upload a CV" onclick="openDialog(\'cv-tile\')">+</button>';
  return `
    <p>Career Opportunities: Data Analyst Trainee (79647). Already a registered user? Please sign in</p>
    <form id="application">
      <label for="email">Email Address: *</label><input id="email" type="email" required>
      <label for="email2">Retype Email Address: *</label><input id="email2" type="email" required>
      <label for="pw">Choose Password: *</label><input id="pw" type="password" required>
      <label for="pw2">Retype Password: *</label><input id="pw2" type="password" required>
      <label for="fn">First Name: *</label><input id="fn" required>
      <label for="ln">Last Name: *</label><input id="ln" required>
      <label for="phone">Cell Phone: *</label><input id="phone" type="tel" required>
      <label for="employer">Current or Latest Employer*</label><input id="employer" required>
      <label for="role">Current or Latest Role*</label><input id="role" required>
      <label for="salary">Salary expectation</label><input id="salary">
      <label for="source">How did you hear about this position? *</label>
      <select id="source" required><option value="">Select</option><option>LinkedIn</option><option>Duunitori</option><option>Other</option></select>
      <fieldset><legend>Do you have experience with Python and SQL programming?</legend>
        <label><input type="radio" name="python" value="yes" required>Yes</label><label><input type="radio" name="python" value="no">No</label></fieldset>
      <fieldset><legend>I am available to work full-time from 1st March to 31st August 2027</legend>
        <label><input type="radio" name="avail" value="yes" required>Yes</label><label><input type="radio" name="avail" value="no">No</label></fieldset>
      <div>Accepted file types: DOCX, PDF
        <div id="cv-tile"><span>CV</span> <span>Upload a CV</span> ${cvButton} <span>Opens a dialogue</span> <span class="fname"></span></div>
        <div id="cl-tile"><span>Cover Letter</span> <span>Upload a Cover Letter</span>
          <button type="button" aria-label="Upload a Cover Letter" onclick="document.getElementById('clfile').click()">+</button>
          <input type="file" id="clfile" hidden onchange="this.parentElement.querySelector('.fname').textContent = this.files[0].name">
          <span class="fname"></span></div>
      </div>
      <button type="submit">Apply</button>
    </form>
    <div role="dialog" id="dialog" hidden><h2>Upload Attachment</h2>
      <button type="button" id="browse">Browse...</button> <button type="button" id="dialog-upload">Upload</button> <button type="button">Cancel</button></div>
    <script>
      let target = null, pending = null;
      window.submits = 0;
      document.getElementById('application').addEventListener('submit', (event) => { event.preventDefault(); window.submits += 1; });
      function openDialog(id) { target = id; document.getElementById('dialog').hidden = false; }
      document.getElementById('browse').onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.style.display = 'none';
        input.onchange = () => { pending = input.files[0].name; };
        document.body.appendChild(input);
        input.click();
      };
      document.getElementById('dialog-upload').onclick = () => {
        if (!pending) return;
        document.querySelector('#' + target + ' .fname').textContent = pending;
        pending = null;
        document.getElementById('dialog').hidden = true;
      };
    </script>`;
}

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => {
  await browser?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('OP-style form: grounded fields filled, both documents attached and verified, manual fields identified, no submit', async () => {
  const page = await browser.newPage();
  await page.setContent(opStylePage());
  const result = await prepareOperationalApplicationForm(page, profile, artifacts, { context });
  const evidence = result.evidence;

  assert.equal(await page.inputValue('#fn'), 'Alex');
  assert.equal(await page.inputValue('#email2'), 'alex.example@example.test');
  assert.equal(await page.inputValue('#employer'), 'Example Labs');
  assert.equal(await page.inputValue('#role'), 'Python Developer Intern');
  assert.equal(await page.locator('#source option:checked').textContent(), 'Duunitori');
  assert.equal(await page.isChecked('input[name="python"][value="yes"]'), true);
  assert.equal(await page.inputValue('#salary'), '', 'trainee role never receives the general salary target');
  assert.equal(await page.inputValue('#pw'), '');

  assert.equal(await page.textContent('#cv-tile .fname'), 'Example_Data_CV_2026.pdf');
  assert.equal(await page.textContent('#cl-tile .fname'), 'example_cover_letter.pdf');
  assert.deepEqual(evidence.uploadedArtifacts.map((row) => row.sha256).sort(),
    [artifacts.cv.sha256, artifacts.coverLetter.sha256].sort());

  const manual = new Set(evidence.unresolvedFields.map((row) => row.semantic));
  for (const semantic of ['password', 'salary', 'schedule_availability']) assert.ok(manual.has(semantic), semantic);
  for (const semantic of ['cv_upload', 'cover_letter_upload', 'skill_experience', 'application_source']) {
    assert.ok(!manual.has(semantic), `${semantic} should not need manual handling`);
  }
  assert.match(evidence.unresolvedFields.find((row) => row.semantic === 'salary').missingInformation, /Trainee/);

  assert.equal(evidence.finalAction.activated, false);
  assert.equal(await page.evaluate(() => window.submits), 0);
  assert.equal(result.gate?.state, 'review_required');
  await page.close();
});

test('an upload control that does nothing yields an explicit handoff with the exact file path', async () => {
  const page = await browser.newPage();
  await page.setContent(opStylePage({ cvTile: 'dead' }));
  const { evidence } = await prepareOperationalApplicationForm(page, profile, artifacts, { context });
  const row = evidence.unresolvedFields.find((item) => item.semantic === 'cv_upload');
  assert.equal(row.manualUploadPath, artifacts.cv.resolvedPath);
  assert.ok(row.reason.includes(artifacts.cv.resolvedPath));
  assert.ok(evidence.uploadedArtifacts.some((item) => item.sha256 === artifacts.coverLetter.sha256), 'other document still attached');
  assert.equal(evidence.reviewComplete, false);
  await page.close();
});

test('a form without any upload control never skips the bound documents silently', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form><label for="fn">First name</label><input id="fn" required>
    <label for="ln">Last name</label><input id="ln" required><label for="em">Email</label><input id="em" type="email" required>
    <button type="submit">Submit application</button></form>`);
  const result = await prepareOperationalApplicationForm(page, profile, artifacts, { context });
  const rows = result.evidence.unresolvedFields.filter((item) => item.category === 'file_upload');
  assert.deepEqual(rows.map((item) => item.manualUploadPath).sort(), [artifacts.cv.resolvedPath, artifacts.coverLetter.resolvedPath].sort());
  assert.equal(result.evidence.reviewComplete, false);
  assert.equal(result.gate?.state, 'review_required');
  await page.close();
});

test('skills questions: Yes only for CV-listed skills; years, familiarity-only and legal wording stay manual', () => {
  assert.deepEqual(skillsAskedIn('Do you have experience with Python and SQL programming?').skills, ['python', 'sql']);
  assert.equal(skillExperienceAnswer(profile, 'Do you have experience with Python and SQL programming?'), 'Yes');
  assert.equal(skillExperienceAnswer(profile, 'Are you familiar with Power BI?'), 'Yes');
  assert.equal(skillExperienceAnswer(profile, 'Do you have experience with Airflow?'), null);
  assert.equal(skillExperienceAnswer(profile, 'Do you have experience with Python and Scala?'), null);
  assert.equal(skillExperienceAnswer(profile, 'Do you have experience with Scala or Python?'), 'Yes');
  assert.equal(skillsAskedIn('Do you have 3+ years of experience with Python?'), null);
  assert.equal(skillsAskedIn('Do you have professional experience with SQL?'), null);
  assert.equal(skillsAskedIn('Do you have a valid work permit?'), null);
});

test('"How did you hear" uses discovery provenance and salary respects trainee roles', () => {
  assert.equal(applicationSourceFromDiscovery(context), 'Duunitori');
  assert.equal(applicationSourceFromDiscovery({ discovery: { source: 'greenhouse-api', urls: ['https://boards.greenhouse.io/x/jobs/1'] } }), 'Company website');
  assert.equal(applicationSourceFromDiscovery({ discovery: { source: 'websearch-handoff', urls: ['https://op-careers.fi/job/1'] } }), null);
  assert.equal(applicationSourceFromDiscovery({ discovery: { source: 'websearch-handoff',
    urls: ['https://op-careers.fi/job/1', 'https://duunitori.fi/tyopaikat/tyo/x-1'] } }), 'Duunitori', 'lead source_url counts');
  assert.equal(applicationSourceFromDiscovery({}), null, 'no universal LinkedIn default');

  const salary = { category: 'salary', semantic: 'salary' };
  assert.equal(canonicalFieldValue(profile, salary, { context }), null);
  assert.equal(canonicalFieldValue({ ...profile, compensation: { ...profile.compensation, trainee_answer: 'Per the trainee programme salary' } }, salary, { context }),
    'Per the trainee programme salary');
  assert.equal(canonicalFieldValue(profile, salary, { context: { candidate: { title: 'Data Engineer' } } }), 'EUR 55,000-60,000/year');
});
