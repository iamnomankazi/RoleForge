const shell = (body, title = 'Acme Data Engineer') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

export const listingFixture = shell(`
  <h1>Data Engineer</h1><h2>Acme</h2><p>Build reliable Python and SQL data pipelines.</p>
  <a href="https://fixture.career-ops.invalid/apply/123">Apply Now</a>
`);

export const duplicatePopupFixture = shell(`
  <h1>Data Engineer</h1><h2>Acme</h2>
  <a href="https://fixture.career-ops.invalid/apply/123"
     onclick="window.open('https://fixture.career-ops.invalid/irrelevant','_blank')">Apply Now</a>
`);

const uploadScript = `
  for (const input of document.querySelectorAll('input[type=file]')) {
    input.addEventListener('change', () => {
      document.getElementById(input.id + '-name').textContent = input.files[0]?.name || '';
    });
  }
  document.getElementById('country').addEventListener('change', (event) => {
    document.getElementById('city-wrap').hidden = event.target.value !== 'Finland';
  });
  document.getElementById('city').addEventListener('input', (event) => {
    const option = document.getElementById('city-option');
    option.hidden = event.target.value.toLowerCase() !== 'joensuu';
  });
  document.getElementById('city-option').addEventListener('click', () => {
    document.getElementById('city').value = 'Joensuu';
    document.getElementById('city-option').hidden = true;
  });
  document.getElementById('application').addEventListener('submit', (event) => {
    window.fixtureSubmitCount = (window.fixtureSubmitCount || 0) + 1;
    event.preventDefault();
  });
`;

export const greenhouseFixture = shell(`
  <h1>Data Engineer</h1><h2>Acme</h2>
  <form id="application">
    <label>First name <input name="first_name" required></label>
    <label>Last name <input name="last_name" required></label>
    <label>Email <input type="email" name="email" required></label>
    <label>Phone country <select name="phone_country" required><option value="">Choose</option><option>Finland</option></select></label>
    <label>Phone number <input name="phone" required></label>
    <label>Country <select id="country" name="country" required><option value="">Choose</option><option>Finland</option></select></label>
    <div id="city-wrap" hidden><label>City <input id="city" role="combobox" aria-autocomplete="list" required></label><div role="option" id="city-option" hidden>Joensuu</div></div>
    <label>LinkedIn <input name="linkedin" required></label>
    <label>Why this role? <textarea name="why_role" required></textarea></label>
    <label>Resume / CV <input id="cv" type="file" required></label><span id="cv-name"></span>
    <label>Cover letter <input id="cover" type="file" required></label><span id="cover-name"></span>
    <button type="submit">Submit Application</button>
  </form><script>${uploadScript}</script>
`);

export const leverFixture = shell(`
  <h1>Software Engineer</h1><h2>Lever Fixture</h2><form>
  <label>Full name<input required></label><label>Email<input type="email" required></label>
  <label>Resume<input type="file" required></label><button type="submit">Submit application</button></form>
`, 'Lever Fixture Software Engineer');

export const workdayFixture = shell(`
  <h1>ML Engineer</h1><h2>Workday Fixture</h2><form>
  <label>First Name<input required></label><label>Last Name<input required></label><label>Email<input type="email" required></label>
  <label>Country<select required><option>Finland</option></select></label><label>CV<input type="file" required></label>
  <button type="submit">Complete Application</button></form>
`, 'Workday Fixture ML Engineer');

export const genericMultipartFixture = shell(`
  <h1>Backend Developer</h1><h2>Generic Fixture</h2><form>
  <fieldset><legend>Profile</legend><label>Full name<input required></label><label>Email<input type="email" required></label></fieldset>
  <fieldset><legend>Documents</legend><label>Resume<input type="file" required></label><label>Supporting statement<textarea required></textarea></label></fieldset>
  <button type="submit">Finish</button></form>
`, 'Generic Fixture Backend Developer');

export const textCoverLetterFixture = shell(`<h1>Data Engineer</h1><h2>Acme</h2><form><label>Email<input type="email" required></label><label>CV<input type="file" required></label><label>Motivation letter<textarea required></textarea></label><button type="submit">Send</button></form>`);
export const singleDocumentFixture = shell(`<h1>Data Engineer</h1><h2>Acme</h2><form><label>Email<input type="email" required></label><label>Application documents<input id="combined" type="file" required></label><span id="combined-name"></span><button type="submit">Apply</button></form><script>document.getElementById('combined').addEventListener('change',e=>document.getElementById('combined-name').textContent=e.target.files[0]?.name||'');</script>`);
export const loginFixture = shell(`<h1>Data Engineer</h1><h2>Acme</h2><p>Sign in to apply</p><label>Email<input type="email"></label><label>Password<input type="password"></label>`);
export const captchaFixture = shell(`<h1>Data Engineer</h1><h2>Acme</h2><form><label>Email<input type="email"></label><div class="hcaptcha">Are you human? CAPTCHA</div><button type="submit">Submit</button></form>`);
const captchaUploadScript = `
  for (const input of document.querySelectorAll('input[type=file]')) {
    input.addEventListener('change', () => {
      document.getElementById(input.id + '-name').textContent = input.files[0]?.name || '';
    });
  }
  document.querySelector('form').addEventListener('submit', event => {
    window.fixtureSubmitCount = (window.fixtureSubmitCount || 0) + 1;
    event.preventDefault();
  });
`;
const accessibleCaptchaForm = (captchaMarkup, provider = 'Generic ATS') => shell(`
  <h1>Software Engineer</h1><h2>${provider}</h2>
  <form>
    <label>First name <input id="first_name" name="first_name" required></label>
    <label>Last name <input id="last_name" name="last_name" required></label>
    <label>Email <input id="email" type="email" name="email" required></label>
    <label>LinkedIn <input id="linkedin" name="linkedin" required></label>
    <label>Resume / CV <input id="resume" name="resume" type="file" required></label><span id="resume-name"></span>
    <label>Cover letter <input id="cover_letter" name="cover_letter" type="file" required></label><span id="cover_letter-name"></span>
    ${captchaMarkup}
    <button type="submit">Submit application</button>
  </form>
  <script>${captchaUploadScript}</script>
`, `${provider} Software Engineer`);

export const invisibleCaptchaFixture = accessibleCaptchaForm(`
  <script data-captcha-provider="recaptcha">/* recaptcha passive loader */</script>
  <div class="g-recaptcha" style="display:none" data-sitekey="fixture"></div>
  <textarea name="g-recaptcha-response" style="display:none"></textarea>
`);

export const passiveCaptchaFixture = accessibleCaptchaForm(`
  <script data-captcha-provider="hcaptcha">/* hcaptcha passive loader */</script>
  <div id="hcaptcha-container" style="display:none" data-sitekey="fixture"></div>
  <textarea name="h-captcha-response" style="display:none"></textarea>
`);

export const visibleNonBlockingCaptchaFixture = accessibleCaptchaForm(`
  <div class="hcaptcha" data-sitekey="fixture"><button type="button" role="checkbox">I am human</button></div>
  <textarea name="h-captcha-response" style="display:none"></textarea>
`);

export const blockingCaptchaOverlayFixture = accessibleCaptchaForm(`
  <div class="captcha-overlay" role="dialog" aria-modal="true"
       style="position:fixed;inset:0;width:100vw;height:100vh;background:white;z-index:9999">
    <p>Human verification challenge</p><button type="button">Verify</button>
  </div>
`);

export const disabledPendingCaptchaFixture = shell(`
  <h1>Software Engineer</h1><h2>Generic ATS</h2>
  <form>
    <label>First name <input name="first_name" required disabled></label>
    <label>Email <input type="email" name="email" required disabled></label>
    <label>Resume / CV <input id="resume" name="resume" type="file" required disabled></label>
    <div class="hcaptcha" data-sitekey="fixture"><button type="button" role="checkbox">Complete CAPTCHA to continue</button></div>
    <button type="submit">Submit application</button>
  </form>
`);

export const uncertainCaptchaFixture = accessibleCaptchaForm(`
  <p>This application is CAPTCHA protected.</p>
`);

export const atsStyleCaptchaFixtures = [
  'Greenhouse', 'Lever', 'Workday', 'Personio', 'SmartRecruiters', 'Future ATS',
].map((provider) => ({
  provider,
  html: accessibleCaptchaForm(`
    <script data-captcha-provider="recaptcha">/* recaptcha passive loader */</script>
    <div class="g-recaptcha" style="display:none" data-sitekey="fixture"></div>
    <textarea name="g-recaptcha-response" style="display:none"></textarea>
  `, provider),
}));
export const identityMismatchFixture = shell(`<h1>Senior Sales Director</h1><h2>Other Corp</h2><form><label>Email<input type="email"></label><label>Resume<input type="file"></label></form>`, 'Other Corp Senior Sales Director');
export const expiredFixture = shell(`<h1>Data Engineer</h1><h2>Acme</h2><p>This job is no longer available.</p>`);
export const unsafeRedirectFixture = shell(`<h1>Data Engineer</h1><h2>Acme</h2><a href="http://127.0.0.1/private">Apply Now</a>`);
export const consentFixture = shell(`<h1>Data Engineer</h1><h2>Acme</h2><form><label>Email<input type="email" required></label><label><input type="checkbox" required>I certify that this application is accurate</label><button type="submit">Submit</button></form>`);
