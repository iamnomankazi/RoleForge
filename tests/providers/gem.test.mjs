import assert from 'node:assert/strict';
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

console.log('\nProvider - gem');

try {
  const { default: provider } = await import(pathToFileURL(join(ROOT, 'providers/gem.mjs')).href);
  const entry = { name: 'Retool', careers_url: 'https://jobs.gem.com/retool' };

  assert.equal(provider.id, 'gem');
  assert.ok(provider.detect(entry));
  assert.equal(provider.detect({ careers_url: 'https://jobs.gem.com/retool/extra' }), null);
  assert.equal(provider.detect({ careers_url: 'https://evil.example/retool' }), null);
  assert.equal(provider.detect({ careers_url: 'http://jobs.gem.com/retool' }), null);
  pass('id and exact HTTPS Gem-board routing reject off-host/ambiguous paths');

  const calls = [];
  const jobs = await provider.fetch(entry, {
    fetchJson: async (url, opts) => {
      calls.push({ url, opts });
      assert.equal(url, 'https://jobs.gem.com/api/public/graphql/batch');
      assert.equal(opts.redirect, 'error');
      const body = JSON.parse(opts.body);
      if (body[0].operationName === 'JobBoardList') {
        return [{ data: { oatsExternalJobPostings: { jobPostings: [{
          extId: 'role-1', title: 'Data Engineer',
          locations: [{ name: 'Helsinki', isRemote: true }],
        }] } } }];
      }
      return [{ data: { oatsExternalJobPosting: {
        extId: 'role-1', firstPublishedTsSec: 1782864000,
        jobPostSectionHtml: { introHtml: '<p>Intro</p>', outroHtml: '<p>Outro</p>' },
        descriptionHtml: '<p>Build &amp; ship</p>', compensationHtml: '<b>EUR 60k</b>',
      } } }];
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(jobs, [{
    title: 'Data Engineer', url: 'https://jobs.gem.com/retool/role-1', company: 'Retool',
    location: 'Helsinki - Remote', description: 'Intro\n\nBuild & ship\n\nOutro\n\nCompensation: EUR 60k',
    postedAt: 1782864000 * 1000,
  }]);
  pass('listing and batched detail payloads normalize location, description, date, and safe URLs');

  assert.deepEqual(await provider.fetch(entry, {
    fetchJson: async () => [{ data: { oatsExternalJobPostings: { jobPostings: [] } } }],
  }), []);
  pass('valid empty Gem board is a healthy empty result without a detail request');

  await assert.rejects(
    () => provider.fetch(entry, { fetchJson: async () => ({}) }),
    /malformed JobBoardList/,
  );
  await assert.rejects(
    () => provider.fetch(entry, { fetchJson: async () => [{ data: { oatsExternalJobPostings: { jobPostings: [{ title: 'No id' }] } } }] }),
    /none structurally usable/,
  );
  await assert.rejects(
    () => provider.fetch({ name: 'Bad', careers_url: 'https://evil.example/acme' }, { fetchJson: async () => [] }),
    /safe board id/,
  );
  pass('malformed, unusable, and off-host board inputs fail closed');

  let detailCall = 0;
  const degraded = await provider.fetch(entry, {
    fetchJson: async () => {
      detailCall += 1;
      if (detailCall === 1) {
        return [{ data: { oatsExternalJobPostings: { jobPostings: [{ extId: 'role-2', title: 'Backend Engineer' }] } } }];
      }
      throw new Error('resolver unavailable');
    },
  });
  assert.equal(degraded.length, 1);
  assert.equal(degraded.providerDegraded, true);
  assert.match(degraded.providerDegradedReason, /resolver unavailable/);
  pass('detail outage preserves listings and explicitly marks the provider result degraded');

  let malformedDetailCall = 0;
  const malformedDetail = await provider.fetch(entry, {
    fetchJson: async () => {
      malformedDetailCall += 1;
      return malformedDetailCall === 1
        ? [{ data: { oatsExternalJobPostings: { jobPostings: [{ extId: 'role-3', title: 'ML Engineer' }] } } }]
        : [];
    },
  });
  assert.equal(malformedDetail.providerDegraded, true);
  assert.match(malformedDetail.providerDegradedReason, /covered 0 of 1/);
  pass('malformed or incomplete Gem detail payload is reported as degraded, never clean completion');
} catch (error) {
  fail(`gem provider tests crashed: ${error.stack || error.message}`);
}
