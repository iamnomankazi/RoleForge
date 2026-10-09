import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAtsPosting, resolveAtsApi } from '../liveness-api.mjs';
import { livenessHelp, parseArgs, runCandidateLiveness } from '../candidate-liveness.mjs';

function response(status, body, kind = 'json') {
  return {
    status,
    async json() {
      if (kind !== 'json') throw new Error('not JSON');
      return body;
    },
    async text() {
      if (kind !== 'text') throw new Error('not text');
      return body;
    },
  };
}

function fetchFixture(status, body, kind = 'json', calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    return response(status, body, kind);
  };
}

test('ATS posting URLs map to fixed public APIs, including the EU Lever host', () => {
  const mappings = [
    ['https://boards.greenhouse.io/acme/jobs/123', 'greenhouse', 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/123'],
    ['https://jobs.eu.lever.co/acme-eu/abc-123', 'lever', 'https://api.eu.lever.co/v0/postings/acme-eu/abc-123'],
    ['https://jobs.ashbyhq.com/acme/ashby-123', 'ashby', 'https://api.ashbyhq.com/posting-api/job-board/acme'],
    ['https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/Helsinki-FI/Backend_R123', 'workday', 'https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/Careers/job/Helsinki-FI/Backend_R123'],
    ['https://jobs.smartrecruiters.com/Acme/743999999999999-Backend-Engineer', 'smartrecruiters', 'https://api.smartrecruiters.com/v1/companies/Acme/postings/743999999999999'],
    ['https://acme.teamtailor.com/jobs/tt-123-backend-engineer', 'teamtailor', 'https://acme.teamtailor.com/jobs.rss'],
  ];
  for (const [url, ats, apiUrl] of mappings) {
    const resolved = resolveAtsApi(url);
    assert.equal(resolved?.ats, ats, url);
    assert.equal(resolved?.apiUrl, apiUrl, url);
  }
  assert.equal(resolveAtsApi('http://boards.greenhouse.io/acme/jobs/123'), null);
  assert.equal(resolveAtsApi('https://jobs.smartrecruiters.com/acme/../admin'), null);
});

test('ATS JSON fixtures classify and extract complete posting descriptions', async () => {
  const cases = [
    {
      ats: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/123',
      body: { id: 123, title: 'Engineer', content: '<p>Greenhouse full description</p>' },
      expected: 'Greenhouse full description',
    },
    {
      ats: 'lever', url: 'https://jobs.eu.lever.co/acme/abc-123',
      body: { text: 'Engineer', descriptionPlain: 'Lever full description' },
      expected: 'Lever full description',
    },
    {
      ats: 'ashby', url: 'https://jobs.ashbyhq.com/acme/ashby-123',
      body: { jobs: [{ id: 'ashby-123', title: 'Engineer', isListed: true, descriptionHtml: '<p>Ashby full description</p>' }] },
      expected: 'Ashby full description',
    },
    {
      ats: 'workday', url: 'https://acme.wd3.myworkdayjobs.com/Careers/job/Helsinki/Backend_R123',
      body: { jobPostingInfo: { title: 'Engineer', jobDescription: '<p>Workday full description</p>' } },
      expected: 'Workday full description',
    },
    {
      ats: 'smartrecruiters', url: 'https://jobs.smartrecruiters.com/Acme/743999999999999-Backend',
      body: {
        id: '743999999999999', name: 'Engineer',
        jobAd: { sectionsOrder: ['jobDescription', 'qualifications'], sections: {
          jobDescription: { title: 'Role', text: '<p>SmartRecruiters full description</p>' },
          qualifications: { title: 'Requirements', text: '<p>Every qualification</p>' },
        } },
      },
      expected: 'Role SmartRecruiters full description Requirements Every qualification',
    },
  ];
  for (const item of cases) {
    const calls = [];
    const result = await fetchAtsPosting(item.url, { fetchImpl: fetchFixture(200, item.body, 'json', calls) });
    assert.equal(result?.result, 'active', item.ats);
    assert.equal(result?.description, item.expected, item.ats);
    assert.equal(new URL(calls[0].url).host, new URL(resolveAtsApi(item.url).apiUrl).host);
    if (item.ats === 'greenhouse') assert.equal(new URL(calls[0].url).searchParams.get('content'), 'true');
    assert.equal(calls[0].options.redirect, 'error');
  }

  const calls = [];
  const xml = '<rss><channel><item><title>Engineer</title><link>https://acme.teamtailor.com/jobs/tt-123-backend-engineer</link><description><![CDATA[<p>Teamtailor full description</p>]]></description></item></channel></rss>';
  const teamtailor = await fetchAtsPosting('https://acme.teamtailor.com/jobs/tt-123-backend-engineer', {
    fetchImpl: fetchFixture(200, xml, 'text', calls),
  });
  assert.equal(teamtailor?.result, 'active');
  assert.equal(teamtailor?.description, 'Teamtailor full description');
  assert.equal(calls[0].options.redirect, 'error');
});

test('API gone responses expire; ambiguous or missing API evidence stays unconfirmed', async () => {
  const url = 'https://boards.greenhouse.io/acme/jobs/123';
  assert.equal((await fetchAtsPosting(url, { fetchImpl: fetchFixture(404, {}) }))?.result, 'expired');
  assert.equal(await fetchAtsPosting(url, { fetchImpl: fetchFixture(429, {}) }), null);
  assert.equal(await fetchAtsPosting('https://acme.wd3.myworkdayjobs.com/Careers/job/Helsinki/Backend_R123', {
    fetchImpl: fetchFixture(200, { error: 'temporarily unavailable' }),
  }), null);
  assert.equal(await fetchAtsPosting('https://acme.teamtailor.com/jobs/missing-role', {
    fetchImpl: fetchFixture(200, '<rss><channel><item><title>Other job</title><link>https://acme.teamtailor.com/jobs/other-role</link></item></channel></rss>', 'text'),
  }), null);
  assert.equal((await fetchAtsPosting('https://jobs.ashbyhq.com/acme/missing-job', {
    fetchImpl: fetchFixture(200, { jobs: [] }),
  }))?.result, 'expired');
});

test('long provider descriptions are not cut off at the shared 4,000-character provider cap', async () => {
  const content = `${'A complete sentence in the source description. '.repeat(140)}Final paragraph remains present.`;
  const result = await fetchAtsPosting('https://boards.greenhouse.io/acme/jobs/123', {
    fetchImpl: fetchFixture(200, { content }),
  });
  assert.equal(result?.description, content);
  assert.ok((result?.description.length || 0) > 4_000);
});

test('CLI argument parsing accepts supported options and rejects unknown flags', () => {
  const parsed = parseArgs(['--run', 'run-dir', '--out', 'result-dir', '--limit', '3', '--only', 'a,b', '--no-browser', '--concurrency', '2']);
  assert.equal(parsed.runDir, 'run-dir');
  assert.equal(parsed.limit, 3);
  assert.deepEqual([...parsed.only], ['a', 'b']);
  assert.equal(parsed.noBrowser, true);
  assert.equal(parsed.concurrency, 2);
  assert.throws(() => parseArgs(['--run', 'run-dir', '--unknown']), /Unknown flag/);
  assert.throws(() => parseArgs(['--run', 'run-dir', '--limit', '0']), /positive integer/);
  assert.match(livenessHelp(), /--no-browser/);
});

test('batch writes candidate-keyed liveness records and plain-text descriptions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-liveness-'));
  try {
    const runDir = join(root, 'scan-run-fixture');
    const outDir = join(root, 'liveness-output');
    await mkdir(runDir, { recursive: true });
    const candidates = [
      {
        candidate_id: 'cand_active', url: 'https://boards.greenhouse.io/acme/jobs/123',
        company: 'Acme', title: 'Engineer', ats_provider: 'greenhouse', description: null,
      },
      {
        candidate_id: 'cand_unknown', url: 'https://example.test/jobs/role',
        company: 'Example', title: 'Role', description: null,
      },
    ];
    await writeFile(join(runDir, 'candidates.json'), JSON.stringify(candidates));
    await assert.rejects(runCandidateLiveness({
      runDir,
      outDir: join(runDir, 'must-not-mutate-run'),
      noBrowser: true,
      log: () => {},
      fetchImpl: fetchFixture(200, {}),
    }), /outside the immutable scan run/);
    const result = await runCandidateLiveness({
      runDir,
      outDir,
      noBrowser: true,
      concurrency: 2,
      hostSpacingMs: 0,
      now: () => new Date('2026-10-09T10:00:00.000Z'),
      log: () => {},
      fetchImpl: fetchFixture(200, { title: 'Engineer', content: '<p>Actual full job description.</p>' }),
    });
    const manifest = JSON.parse(await readFile(join(outDir, 'liveness.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest).sort(), ['cand_active', 'cand_unknown']);
    assert.deepEqual(manifest.cand_active, {
      status: 'active', method: 'api', checked_at: '2026-10-09T10:00:00.000Z',
      final_url: candidates[0].url, description_chars: 'Actual full job description.'.length,
      description_sha256: manifest.cand_active.description_sha256,
      reason: 'ATS API returns the posting (live)',
    });
    assert.match(manifest.cand_active.description_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(manifest.cand_unknown, {
      status: 'unconfirmed', method: 'none', checked_at: '2026-10-09T10:00:00.000Z',
      final_url: candidates[1].url, description_chars: 0, description_sha256: null,
      reason: 'no supported ATS API; browser fallback disabled',
    });
    assert.equal(await readFile(join(outDir, 'descriptions', 'cand_active.txt'), 'utf8'), 'Actual full job description.\n');
    await assert.rejects(readFile(join(outDir, 'descriptions', 'cand_unknown.txt'), 'utf8'), { code: 'ENOENT' });
    assert.deepEqual(result.statusCounts, { active: 1, expired: 0, unconfirmed: 1 });
    assert.deepEqual(result.methodCounts, { api: 1, browser: 0, none: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
