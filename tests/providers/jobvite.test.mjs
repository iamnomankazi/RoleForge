import test from 'node:test';
import assert from 'node:assert/strict';

import provider, {
  extractEidFromBoard,
  parseJobviteXml,
  resolveConfiguredEid,
  resolveSlug,
} from '../../providers/jobvite.mjs';

const XML = `<?xml version="1.0"?><result>
  <job><id>q6NaVfwI</id><title><![CDATA[Senior AI Engineer]]></title>
    <location>Helsinki &amp; Remote</location><date>9/1/2026</date>
    <detail-url><![CDATA[http://jobs.example.test/role/42?c=acme&amp;j=42]]></detail-url>
    <apply-url><![CDATA[https://apply.example.test/role/42]]></apply-url>
  </job>
  <job><id>apply-only</id><title>Second role</title><location>Berlin</location>
    <date>invalid</date><detail-url>http://[broken</detail-url>
    <apply-url>http://apply.example.test/role/2</apply-url></job>
</result>`;

test('detect and explicit identifiers use only the current XML Jobvite contract', () => {
  assert.equal(provider.id, 'jobvite');
  assert.equal(resolveSlug({ careers_url: 'https://jobs.jobvite.com/acme' }), 'acme');
  assert.equal(resolveSlug({ careers_url: 'http://jobs.jobvite.com/acme' }), null);
  assert.equal(resolveSlug({ careers_url: 'https://jobs.jobvite.com/api/acme' }), null);
  assert.equal(resolveConfiguredEid({ company_eid: 'q6NaVfwI', api: 'https://app.jobvite.com/CompanyJobs/Xml.aspx?c=other' }), 'q6NaVfwI');
  assert.equal(resolveConfiguredEid({ api: 'https://app.jobvite.com/CompanyJobs/Xml.aspx?c=apiEid42' }), 'apiEid42');
  assert.equal(resolveConfiguredEid({ api: 'https://app.jobvite.com/api/company/acme/jobs' }), null);
  assert.deepEqual(provider.detect({ company_eid: 'q6NaVfwI' }), { url: 'https://app.jobvite.com/CompanyJobs/Xml.aspx?c=q6NaVfwI' });
  assert.deepEqual(provider.detect({ careers_url: 'https://jobs.jobvite.com/acme' }), { url: 'https://jobs.jobvite.com/acme' });
  assert.equal(provider.detect({ careers_url: 'https://example.com/acme' }), null);
});

test('normalization prefers detail links, upgrades display HTTP URLs, and records feed provenance', () => {
  assert.deepEqual(parseJobviteXml(XML, 'Acme', 'https://app.jobvite.com/CompanyJobs/Xml.aspx?c=q6NaVfwI'), [
    {
      title: 'Senior AI Engineer', url: 'https://jobs.example.test/role/42?c=acme&j=42',
      company: 'Acme', location: 'Helsinki & Remote', sourceId: 'q6NaVfwI',
      sourceUrl: 'https://app.jobvite.com/CompanyJobs/Xml.aspx?c=q6NaVfwI',
      postedAt: Date.UTC(2026, 8, 1),
    },
    {
      title: 'Second role', url: 'https://apply.example.test/role/2', company: 'Acme',
      location: 'Berlin', sourceId: 'apply-only', sourceUrl: 'https://app.jobvite.com/CompanyJobs/Xml.aspx?c=q6NaVfwI',
    },
  ]);
  assert.deepEqual(parseJobviteXml(null, 'Acme'), []);
  assert.deepEqual(parseJobviteXml('<result/>', 'Acme'), []);
  assert.deepEqual(parseJobviteXml('<result><job><title>missing link</title></job></result>', 'Acme'), []);
});

test('board discovery uses fr=true and nl=1, then fetches the current XML feed with safe options', async () => {
  const calls = [];
  const jobs = await provider.fetch({ name: 'Acme', careers_url: 'https://jobs.jobvite.com/acme' }, {
    fetchText: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return `<script>var config = { companyEId: 'q6NaVfwI' };</script>`;
      return '<result/>';
    },
  });
  assert.deepEqual(jobs, []);
  assert.equal(calls.length, 2);
  const board = new URL(calls[0].url);
  assert.equal(board.hostname, 'jobs.jobvite.com');
  assert.equal(board.searchParams.get('fr'), 'true');
  assert.equal(board.searchParams.get('nl'), '1');
  assert.equal(calls[0].options.redirect, 'error');
  const feed = new URL(calls[1].url);
  assert.equal(feed.hostname, 'app.jobvite.com');
  assert.equal(feed.pathname, '/CompanyJobs/Xml.aspx');
  assert.equal(feed.searchParams.get('c'), 'q6NaVfwI');
  assert.equal(calls[1].options.redirect, 'manual');
  assert.equal(calls[1].options.timeoutMs, 45_000);
});

test('explicit company_eid wins over api, and api c= avoids discovery', async () => {
  const urls = [];
  await provider.fetch({ company_eid: 'firstEid', api: 'https://app.jobvite.com/CompanyJobs/Xml.aspx?c=secondEid' }, {
    fetchText: async (url) => { urls.push(url); return '<result/>'; },
  });
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).searchParams.get('c'), 'firstEid');

  urls.length = 0;
  await provider.fetch({ api: 'https://app.jobvite.com/CompanyJobs/Xml.aspx?c=secondEid', careers_url: 'https://jobs.jobvite.com/acme' }, {
    fetchText: async (url) => { urls.push(url); return '<result/>'; },
  });
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).searchParams.get('c'), 'secondEid');
});

test('malformed fetched XML and non-empty wholly unusable feeds fail closed', async () => {
  await assert.rejects(() => provider.fetch({ company_eid: 'q6NaVfwI' }, {
    fetchText: async () => '<html>challenge</html>',
  }), /expected result root/);
  await assert.rejects(() => provider.fetch({ company_eid: 'q6NaVfwI' }, {
    fetchText: async () => '<result><job><title>Broken</title></job></result>',
  }), /none structurally usable/);
  await assert.rejects(() => provider.fetch({ company_eid: 'q6NaVfwI' }, {
    fetchText: async () => '<result><job><title>Bad &#0; char</title></job></result>',
  }), /XML 1.0-invalid/);
  await assert.rejects(() => provider.fetch({ company_eid: 'q6NaVfwI' }, {
    fetchText: async () => '<result><job><title>Open record</result>',
  }), /unterminated job record/);
});

test('a valid empty XML feed is healthy and only the trusted HTTPS NoJobs target means empty', async () => {
  assert.deepEqual(await provider.fetch({ company_eid: 'q6NaVfwI' }, {
    fetchText: async () => '<result></result>',
  }), []);
  const redirect = (location) => Object.assign(new Error('redirect response'), { status: 302, location });
  assert.deepEqual(await provider.fetch({ company_eid: 'q6NaVfwI' }, {
    fetchText: async () => { throw redirect('NoJobs.htm'); },
  }), []);
  for (const location of [
    'https://app.jobvite.com:443/CompanyJobs/NoJobs.htm',
    'https://app.jobvite.com/CompanyJobs/NOJOBS.htm',
  ]) {
    assert.deepEqual(await provider.fetch({ company_eid: 'q6NaVfwI' }, {
      fetchText: async () => { throw redirect(location); },
    }), []);
  }
  for (const location of [
    'https://evil.example/NoJobs.htm',
    'http://app.jobvite.com/CompanyJobs/NoJobs.htm',
    'https://app.jobvite.com/retired/NoJobs.htm',
    'https://app.jobvite.com:8443/CompanyJobs/NoJobs.htm',
    'https://user:pass@app.jobvite.com/CompanyJobs/NoJobs.htm',
  ]) {
    await assert.rejects(() => provider.fetch({ company_eid: 'q6NaVfwI' }, {
      fetchText: async () => { throw redirect(location); },
    }), /redirect response/);
  }
});

test('Retry-After: 30 is honored up to 60 seconds; redirects are not retried', async () => {
  const attempts = [];
  const delays = [];
  const jobs = await provider.fetch({ company_eid: 'q6NaVfwI' }, {
    sleep: async (ms) => delays.push(ms),
    fetchText: async (url) => {
      attempts.push(url);
      if (attempts.length === 1) throw Object.assign(new Error('rate limited'), { status: 429, retryAfter: '30' });
      return '<result/>';
    },
  });
  assert.deepEqual(jobs, []);
  assert.equal(attempts.length, 2);
  assert.deepEqual(delays, [30_000]);

  let redirectAttempts = 0;
  await assert.rejects(() => provider.fetch({ company_eid: 'q6NaVfwI' }, {
    fetchText: async () => { redirectAttempts++; throw Object.assign(new Error('retired'), { status: 302, location: 'https://search.jobvite.com/?invalid=1' }); },
  }), /retired/);
  assert.equal(redirectAttempts, 1);
});

test('entity decoder retains valid Unicode references and refuses XML-invalid numeric references', () => {
  assert.equal(extractEidFromBoard(`<script>companyEId = "q6NaVfwI"</script>`), 'q6NaVfwI');
  assert.equal(parseJobviteXml('<result><job><title>Director&#8217;s Office</title><detail-url>https://jobs.example/one</detail-url></job></result>')[0].title,
    'Director’s Office');
  assert.throws(() => parseJobviteXml('<result><job><title>Bad &#x1F; char</title><detail-url>https://jobs.example/one</detail-url></job></result>'), /XML 1.0-invalid/);
});

test('cursor parsing ignores job-like markup inside CDATA fields', () => {
  const xml = '<result><job><title>Real role</title><detail-url>https://jobs.example/real</detail-url>'
    + '<description><![CDATA[example </job><job><title>fake</title>]]></description></job></result>';
  const jobs = parseJobviteXml(xml, 'Acme');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Real role');
});
