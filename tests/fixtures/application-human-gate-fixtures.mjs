export const clearApplication = `<form id="application">
  <label>First name<input name="first_name" id="first"></label>
  <label>Email<input type="email" name="email" id="email"></label>
  <button id="final" type="submit">Submit application</button>
</form><script>final.addEventListener('click', () => window.finalClicks = (window.finalClicks || 0) + 1);</script>`;

export const humanGateFixtures = [
  ...['g-recaptcha', 'hcaptcha', 'cf-turnstile'].map((provider) => ({
    name: `blocking ${provider}`, cause: 'captcha',
    html: `${clearApplication}<div class="${provider}" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white">
      <button type="button">Human verification required</button>
    </div>`,
  })),
  ...['recaptcha', 'hcaptcha', 'turnstile'].map((provider) => ({
    name: `passive ${provider}`, cause: null,
    html: `${clearApplication}<div class="${provider}" style="display:none"></div>
      <script type="application/json">${provider} invisible widget</script>`,
  })),
  { name: 'login wall', cause: 'login', html: '<h1>Sign in to apply</h1><label>Email<input type="email"></label><label>Password<input type="password"></label>' },
  { name: 'account creation', cause: 'account_creation', html: '<h1>Create an account to apply</h1><label>Email<input type="email"></label><label>Password<input type="password" autocomplete="new-password"></label>' },
  { name: 'MFA code', cause: 'mfa', html: '<h1>Enter your one-time code</h1><label>Security code<input id="otp" autocomplete="one-time-code"></label>' },
  { name: 'email verification', cause: 'email_verification', html: '<h1>Check your inbox</h1><p>Verify your email using the verification link.</p>' },
  { name: 'cleared page', cause: null, html: clearApplication },
  { name: 'ambiguous page', cause: 'uncertain', html: '<h1>Verification required</h1><p>Verify your identity to continue.</p>' },
  { name: 'conflicting gates', cause: 'uncertain', html: '<h1>Sign in to apply</h1><p>Check your email for a verification link.</p>' },
];
