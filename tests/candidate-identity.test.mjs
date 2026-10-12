import assert from 'node:assert/strict';
import test from 'node:test';
import {
  atsIdentityFromUrl,
  canonicalListingUrl,
  collectCandidateIdentityAliases,
  deriveCandidateId,
} from '../candidate-identity.mjs';
import { mergeCandidates } from '../merge-scan-results.mjs';

test('candidate IDs ignore tracking parameters, fragments, and retained-query order', () => {
  const left = 'https://Jobs.Example.test/roles/42/?utm_source=x&department=data&lang=en#top';
  const right = 'https://jobs.example.test/roles/42?lang=en&department=data&ref=mail';
  assert.equal(canonicalListingUrl(left), canonicalListingUrl(right));
  assert.equal(deriveCandidateId({ url: left }), deriveCandidateId({ url: right }));
});

test('same requisition produces the same ID across worker order changes', () => {
  const inputs = [
    { name: 'a.json', rows: [{ company: 'Acme', title: 'Engineer', location: 'Helsinki', url: 'https://job-boards.greenhouse.io/acme/jobs/99?utm_source=a' }] },
    { name: 'b.json', rows: [{ company: 'Acme', title: 'Engineer', location: 'Helsinki', url: 'https://job-boards.greenhouse.io/acme/jobs/99?gh_src=b' }] },
  ];
  const forward = mergeCandidates(inputs, { runId: 'run-a' }).candidates[0];
  const reverse = mergeCandidates([...inputs].reverse(), { runId: 'run-a' }).candidates[0];
  assert.equal(forward.candidate_id, reverse.candidate_id);
  assert.deepEqual([...forward.url_aliases].sort(), [...reverse.url_aliases].sort());
});

test('same company and title do not collapse distinct non-ATS listing URLs', () => {
  const result = mergeCandidates([{ name: 'worker.json', rows: [
    { company: 'Acme', title: 'Engineer', location: 'Helsinki', url: 'https://careers.acme.test/jobs/100' },
    { company: 'Acme', title: 'Engineer', location: 'Helsinki', url: 'https://careers.acme.test/jobs/101' },
  ] }]);
  assert.equal(result.candidates.length, 2);
  assert.notEqual(result.candidates[0].candidate_id, result.candidates[1].candidate_id);
});

test('different ATS requisitions remain distinct even with identical company and title', () => {
  const first = deriveCandidateId({ url: 'https://job-boards.greenhouse.io/acme/jobs/100' });
  const second = deriveCandidateId({ url: 'https://job-boards.greenhouse.io/acme/jobs/101' });
  assert.notEqual(first, second);
});

test('ATS tenant prevents numeric requisition collisions', () => {
  const first = 'https://alpha.wd3.myworkdayjobs.com/Alpha/job/Helsinki/Engineer_R-100';
  const second = 'https://beta.wd3.myworkdayjobs.com/Beta/job/Helsinki/Engineer_R-100';
  assert.notEqual(atsIdentityFromUrl(first), atsIdentityFromUrl(second));
  assert.notEqual(deriveCandidateId({ url: first }), deriveCandidateId({ url: second }));
});

test('Workday requisition comes from the job slug even when the site name contains underscores', () => {
  const bi = 'https://abb.wd3.myworkdayjobs.com/external_career_page/job/Bangalore-Karnataka-India/Business-Intelligence-Specialist_JR00044784';
  const twincat = 'https://abb.wd3.myworkdayjobs.com/external_career_page/job/Heidelberg-Baden-Wurttemberg-Germany/SOFTWARE-DEVELOPER--F-M-D----SPECIAL-PURPOSE-MACHINES_JR00042690';
  assert.equal(atsIdentityFromUrl(bi), 'ats:workday:abb.wd3.myworkdayjobs.com:external_career_page:jr00044784');
  assert.equal(atsIdentityFromUrl(twincat), 'ats:workday:abb.wd3.myworkdayjobs.com:external_career_page:jr00042690');
  assert.notEqual(deriveCandidateId({ url: bi }), deriveCandidateId({ url: twincat }));
  assert.equal(
    atsIdentityFromUrl('https://gehc.wd5.myworkdayjobs.com/GEHC_ExternalSite/job/FIN03-01-Helsinki-Kuortaneenkatu-2/Algorithm-Developer_R4047162-2'),
    'ats:workday:gehc.wd5.myworkdayjobs.com:gehc_externalsite:r4047162-2',
  );
});

test('Workday apply suffixes keep the same identity and sites without underscores keep their IDs', () => {
  const base = 'https://acme.wd3.myworkdayjobs.com/Careers/job/Helsinki/Backend-Engineer_R123';
  assert.equal(deriveCandidateId({ url: `${base}/apply` }), deriveCandidateId({ url: base }));
  assert.equal(deriveCandidateId({ url: `${base}/apply/applyManually` }), deriveCandidateId({ url: base }));
  // Unchanged identity string for the common case keeps historical candidate IDs stable.
  assert.equal(atsIdentityFromUrl('https://alpha.wd3.myworkdayjobs.com/Alpha/job/Helsinki/Engineer_R-100'), 'ats:workday:alpha.wd3.myworkdayjobs.com:alpha:r-100');
});

test('two openings on an underscore-named Workday site are never merged', () => {
  const result = mergeCandidates([{ name: 'reverse.json', rows: [
    { company: 'PwC', title: 'Medior Backend Developer | Python', location: 'Amsterdam',
      url: 'https://pwc.wd3.myworkdayjobs.com/crm_experienced_careers_site/job/Amsterdam/Medior-Backend-Developer---Python_741045WD-3' },
    { company: 'PwC', title: 'Forward Deployed AI Engineer', location: 'Amsterdam',
      url: 'https://pwc.wd3.myworkdayjobs.com/crm_experienced_careers_site/job/Amsterdam/Forward-Deployed-AI-Engineer_758239WD-4' },
  ] }]);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.duplicates, 0);
});

test('a stale worker requisition field conflicts loudly instead of re-identifying a Workday URL', () => {
  const url = 'https://abb.wd3.myworkdayjobs.com/external_career_page/job/Bangalore-Karnataka-India/Business-Intelligence-Specialist_JR00044784';
  assert.throws(
    () => deriveCandidateId({ url, provider: 'workday', ats_tenant: 'abb.wd3.myworkdayjobs.com:external_career_page', requisition_id: 'page' }),
    /Conflicting ATS identities/,
  );
});

test('original and resolved URLs are retained as aliases without changing ATS identity', () => {
  const original = 'https://careers.example.test/redirect/42?utm_campaign=x';
  const resolved = 'https://jobs.ashbyhq.com/acme/12345678-abcd-1234-abcd-1234567890ab';
  const aliases = collectCandidateIdentityAliases({ originalUrl: original, resolvedUrl: resolved });
  assert.deepEqual(aliases.aliases, [original, resolved]);
  const candidateId = deriveCandidateId({ originalUrl: original, resolvedUrl: resolved });
  assert.match(candidateId, /^cand_v1_[a-f0-9]{64}$/);
  assert.equal(candidateId, deriveCandidateId({ originalUrl: original, resolvedUrl: `${resolved}?utm_source=redirect` }));
  const mirrorOnly = deriveCandidateId({ originalUrl: original, resolvedUrl: 'https://mirror.test/jobs/42' });
  assert.equal(mirrorOnly, deriveCandidateId({ originalUrl: original, resolvedUrl: 'https://another-mirror.test/jobs/42' }));
});

test('conflicting ATS aliases fail instead of silently changing candidate identity', () => {
  assert.throws(
    () => deriveCandidateId({
      originalUrl: 'https://jobs.ashbyhq.com/acme/12345678-abcd-1234-abcd-1234567890ab',
      resolvedUrl: 'https://jobs.ashbyhq.com/acme/22345678-abcd-1234-abcd-1234567890ab',
    }),
    /Conflicting ATS identities/,
  );
});

test('worker-supplied identity fields cannot influence deterministic IDs', () => {
  const url = 'https://jobs.lever.co/acme/12345678-abcd-1234-abcd-1234567890ab';
  assert.equal(
    deriveCandidateId({ url, candidate_id: 'forged', run_id: 'other-run' }),
    deriveCandidateId({ url }),
  );
});
