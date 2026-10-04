import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import yaml from 'js-yaml';
import {
  buildCandidateUrls,
  buildWorkdayCandidates,
  dedupeAgainstPortals,
  insertIntoTrackedCompanies,
  parseArgs,
  parseCompanyInput,
  parseWorkdayHint,
  renderPortalEntry,
  runDiscoverAts,
  runDiscovery,
} from '../discover-ats.mjs';

const MODULE_PATH = fileURLToPath(new URL('../discover-ats.mjs', import.meta.url));
const ROOT = dirname(MODULE_PATH);
const input = 'companies:\n  - name: Acme\n    slug: acme\n';
const match = {
  name: 'Acme', vendor: 'greenhouse', slug: 'acme',
  careers_url: 'https://job-boards.greenhouse.io/acme',
  api: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', jobCount: 2,
};

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'discover-ats-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function fakeDiscover(resolved = [match], unresolved = []) {
  return async () => ({ resolved, unresolved });
}

test('imports safely; help with --write exits without touching portals', () => withTempDir((dir) => {
  const portalsPath = join(dir, 'portals.yml');
  const original = 'tracked_companies: []\n';
  writeFileSync(portalsPath, original);
  const child = spawnSync(process.execPath, [MODULE_PATH, '--help', '--write'], {
    encoding: 'utf8', env: { ...process.env, CAREER_OPS_PORTALS: portalsPath },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /preview; writes nothing/);
  assert.equal(readFileSync(portalsPath, 'utf8'), original);
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(MODULE_PATH).href)})`], {
    encoding: 'utf8', env: { ...process.env, CAREER_OPS_PORTALS: portalsPath },
  }).status, 0);
  assert.equal(readFileSync(portalsPath, 'utf8'), original);
}));

test('CLI parsing rejects unknown flags and missing option values', () => {
  assert.throws(() => parseArgs(['node', 'discover-ats.mjs', '--surprise', 'Acme']), /unrecognized flag/);
  assert.throws(() => parseArgs(['node', 'discover-ats.mjs', '--in']), /--in requires a value/);
  assert.throws(() => parseArgs(['node', 'discover-ats.mjs', '--vendors', '--write', 'Acme']), /--vendors requires a value/);
  assert.throws(() => parseArgs(['node', 'discover-ats.mjs', '--write', '--dry-run', 'Acme']), /cannot be combined/);
});

test('input YAML and explicit slugs reject malformed or ambiguous values', () => {
  assert.throws(() => parseCompanyInput('companies: [', []), /malformed/);
  assert.throws(() => parseCompanyInput('something_else: []', []), /companies list/);
  assert.throws(() => parseCompanyInput('companies:\n  - name: Acme\n    slgu: acme\n', []), /unknown field/);
  for (const slug of ['..', '.', 'acme/https://evil.example', 'acme?next=evil']) {
    assert.throws(() => parseCompanyInput(`companies:\n  - name: Acme\n    slug: "${slug}"\n`, []), /slug/);
  }
});

test('input deduplication preserves non-Latin names and resolves their explicit slugs separately', async () => {
  const companies = parseCompanyInput(
    'companies:\n  - name: "\\u516c\\u53f8\\u4e00"\n    slug: alpha-board\n  - name: "\\u4f1a\\u793e\\u4e8c"\n    slug: beta-board\n',
  );
  assert.deepEqual(companies.map(({ name, slug }) => [name, slug]), [
    ['公司一', 'alpha-board'],
    ['会社二', 'beta-board'],
  ]);

  const calls = [];
  const result = await runDiscovery(companies, {
    vendors: ['gh'], includeWorkday: false, concurrency: 1,
    ctx: { fetchJson: async (url) => {
      calls.push(url);
      return url.includes('/alpha-board/')
        ? { jobs: [{ title: 'Engineer', absolute_url: 'https://boards.greenhouse.io/alpha-board/jobs/1' }] }
        : { jobs: [] };
    } },
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /alpha-board/);
  assert.match(calls[1], /beta-board/);
  assert.deepEqual(result.resolved.map(({ name }) => name), ['公司一']);
  assert.deepEqual(result.unresolved.map(({ name }) => name), ['会社二']);
});

test('positional CLI names resolve in preview and leave portals unchanged', async () => withTempDir(async (dir) => {
  const portalsPath = join(dir, 'portals.yml');
  const original = 'tracked_companies: [] # preserve me\n';
  writeFileSync(portalsPath, original);
  const options = parseArgs(['node', 'discover-ats.mjs', 'Acme', '--vendors', 'gh']);
  let receivedCompanies;
  let providerCalls = 0;
  const result = await runDiscoverAts({
    cliNames: options.names,
    vendors: options.vendors,
    includeWorkday: options.includeWorkday,
    portalsPath,
    discover: async (companies, discoveryOptions) => {
      receivedCompanies = companies;
      return runDiscovery(companies, {
        ...discoveryOptions,
        ctx: { fetchJson: async () => {
          providerCalls += 1;
          return { jobs: [{ title: 'Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' }] };
        } },
      });
    },
  });
  assert.deepEqual(receivedCompanies.map((company) => company.name), ['Acme']);
  assert.equal(providerCalls, 1);
  assert.equal(result.metadata.previewOnly, true);
  assert.equal(result.metadata.written, false);
  assert.match(result.pendingEntries, /name: Acme/);
  assert.equal(readFileSync(portalsPath, 'utf8'), original);

  const cli = spawnSync(process.execPath, [MODULE_PATH, '東京'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CAREER_OPS_PORTALS: portalsPath },
  });
  assert.equal(cli.status, 0, cli.stderr);
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.unresolved[0].name, '東京');
  assert.equal(cliResult.metadata.written, false);
  assert.equal(readFileSync(portalsPath, 'utf8'), original);
}));

test('candidate URLs use ordered providers and provider detect preflight; unsafe slugs produce no candidates', () => {
  const result = buildCandidateUrls({ name: 'Acme', slug: 'acme' });
  assert.deepEqual(result.candidates.slice(0, 3).map((candidate) => candidate.vendor), ['gh', 'ashby', 'lever']);
  assert.ok(result.candidates.length >= 3);
  assert.equal(buildCandidateUrls({ name: 'Acme', slug: '..' }, ['gh']).candidates.length, 0);
  assert.equal(buildCandidateUrls({ name: 'Acme', slug: 'acme/evil' }, ['gh']).candidates.length, 0);
});

test('provider probing stops once the first ordered provider returns a nonempty board', async () => {
  const companies = parseCompanyInput(input);
  const calls = [];
  const result = await runDiscovery(companies, {
    vendors: ['gh', 'ashby', 'lever'], includeWorkday: false, concurrency: 1,
    ctx: { fetchJson: async (url) => {
      calls.push(url);
      return { jobs: [{ title: 'Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' }] };
    } },
  });
  assert.equal(result.resolved[0].vendor, 'greenhouse');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/boards-api\.greenhouse\.io\//);
});

test('Workday accepts only strict URLs or coordinates, rejects injection, and caps automatic instances at eight', () => {
  assert.deepEqual(parseWorkdayHint({ workday: 'https://acme.wd5.myworkdayjobs.com/Careers' }), {
    tenant: 'acme', instance: 'wd5', site: 'Careers',
  });
  const coordinates = parseWorkdayHint({ workday: { tenant: 'acme', site: 'External_Career_Site' } });
  assert.deepEqual(coordinates, { tenant: 'acme', instance: null, site: 'External_Career_Site' });
  assert.equal(buildWorkdayCandidates(coordinates).length, 8);
  for (const workday of [
    { tenant: 'acme', site: 'Careers', instance: 'evil' },
    { tenant: 'acme', site: 'Careers', instance: null },
    'http://acme.wd5.myworkdayjobs.com/Careers',
    'https://user@acme.wd5.myworkdayjobs.com/Careers',
    'https://acme.wd5.myworkdayjobs.com:8443/Careers',
    'https://acme.wd5.myworkdayjobs.com/../Careers',
    'https://evil.example/?next=https://acme.wd5.myworkdayjobs.com/Careers',
    'https://acme.wd5.myworkdayjobs.com/Careers?next=https://evil.example',
  ]) {
    assert.throws(() => parseWorkdayHint({ workday }), /Workday/);
  }
});

test('runtime Workday probing is bounded, stops at the first match, and honors an explicit instance', async () => {
  const automatic = parseCompanyInput('companies:\n  - name: Acme\n    workday:\n      tenant: acme\n      site: Careers\n');
  const emptyCalls = [];
  await runDiscovery(automatic, {
    vendors: [], includeWorkday: true, concurrency: 1,
    ctx: { fetchJson: async (url) => { emptyCalls.push(url); return { total: 0, jobPostings: [] }; } },
  });
  assert.ok(emptyCalls.length > 0 && emptyCalls.length <= 8);
  assert.ok(emptyCalls.every((url) => /^https:\/\/acme\.wd\d+(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.myworkdayjobs\.com\/wday\/cxs\/acme\/Careers\/jobs$/i.test(url)));

  const firstMatchCalls = [];
  const firstMatch = await runDiscovery(automatic, {
    vendors: [], includeWorkday: true, concurrency: 1,
    ctx: { fetchJson: async (url) => {
      firstMatchCalls.push(url);
      if (firstMatchCalls.length === 1) return { total: 0, jobPostings: [] };
      return { total: 1, jobPostings: [{ title: 'Engineer', externalPath: '/job/acme/1', locationsText: 'London' }] };
    } },
  });
  assert.equal(firstMatchCalls.length, 2);
  assert.equal(firstMatch.resolved.length, 1);
  assert.equal(
    firstMatch.resolved[0].careers_url,
    `https://${new URL(firstMatchCalls[1]).hostname}/Careers`,
  );

  const explicit = parseCompanyInput('companies:\n  - name: Acme\n    workday:\n      tenant: acme\n      site: Careers\n      instance: wd5\n');
  const explicitCalls = [];
  await runDiscovery(explicit, {
    vendors: [], includeWorkday: true, concurrency: 1,
    ctx: { fetchJson: async (url) => { explicitCalls.push(url); return { total: 0, jobPostings: [] }; } },
  });
  assert.equal(explicitCalls.length, 1);
  assert.equal(new URL(explicitCalls[0]).hostname, 'acme.wd5.myworkdayjobs.com');
});

test('automatic Workday probing keeps earlier redirect-refusal evidence when later instances fail', async () => {
  const companies = parseCompanyInput('companies:\n  - name: Acme\n    workday:\n      tenant: acme\n      site: Careers\n');
  let calls = 0;
  const result = await runDiscovery(companies, {
    vendors: [], includeWorkday: true, concurrency: 1,
    ctx: { fetchJson: async () => {
      calls += 1;
      const error = new Error(calls === 1 ? 'redirect refused at wd1' : `network unavailable at probe ${calls}`);
      if (calls === 1) error.redirectRefused = true;
      throw error;
    } },
  });
  const unresolved = result.unresolved[0];
  assert.equal(calls, 8);
  assert.match(unresolved.reason, /redirect/i);
  assert.ok(unresolved.errors.some((error) => error.refusedRedirect === true));
  assert.ok(unresolved.errors.some((error) => /network unavailable/.test(error.error)));
});

test('a preview reports pending entries and never writes the user configuration', async () => withTempDir(async (dir) => {
  const portalsPath = join(dir, 'portals.yml');
  const original = 'tracked_companies:\n  - name: Existing\n    careers_url: https://jobs.lever.co/existing\n';
  writeFileSync(portalsPath, original);
  const result = await runDiscoverAts({ rawInput: input, portalsPath, discover: fakeDiscover() });
  assert.equal(result.metadata.previewOnly, true);
  assert.equal(result.metadata.fresh, 1);
  assert.match(result.pendingEntries, /careers_url: https:\/\/job-boards\.greenhouse\.io\/acme/);
  assert.equal(readFileSync(portalsPath, 'utf8'), original);
}));

test('explicit write handles inline empty lists, keeps CRLF/comments, and repeats idempotently', async () => withTempDir(async (dir) => {
  const portalsPath = join(dir, 'portals.yml');
  const original = 'title_filter:\r\n  positive: [AI]\r\ntracked_companies: [] # keep this comment\r\njob_boards:\r\n  - name: Existing\r\n    careers_url: https://jobs.lever.co/existing\r\n';
  writeFileSync(portalsPath, original);
  let writes = 0;
  const atomicWrite = (path, content) => { writes += 1; writeFileSync(path, content); };
  const first = await runDiscoverAts({ rawInput: input, portalsPath, write: true, discover: fakeDiscover(), atomicWrite });
  const written = readFileSync(portalsPath, 'utf8');
  assert.equal(first.metadata.written, true);
  assert.equal(writes, 1);
  assert.ok(written.startsWith('title_filter:\r\n  positive: [AI]\r\n'));
  assert.ok(written.includes('tracked_companies:  # keep this comment\r\n'));
  assert.ok(written.includes('job_boards:\r\n  - name: Existing\r\n'));
  assert.equal(written.includes('\r\r\n'), false);
  assert.equal(yaml.load(written).tracked_companies.length, 1);

  const second = await runDiscoverAts({ rawInput: input, portalsPath, write: true, discover: fakeDiscover(), atomicWrite });
  assert.equal(second.metadata.written, false);
  assert.equal(second.metadata.duplicatesSkipped, 1);
  assert.equal(writes, 1);
  assert.equal(readFileSync(portalsPath, 'utf8'), written);
}));

test('dedupe checks configured job boards, URL aliases, and provider canonical board identity', () => {
  const byName = dedupeAgainstPortals([match], [{ name: 'ACME' }]);
  assert.equal(byName.duplicates.length, 1);
  const byAlias = dedupeAgainstPortals([match], [{ name: 'Acme Careers', careers_url: 'https://boards.greenhouse.io/acme' }]);
  assert.equal(byAlias.duplicates.length, 1);
  const byApi = dedupeAgainstPortals([match], [{ name: 'Legacy entry', api: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true' }]);
  assert.equal(byApi.duplicates.length, 1);
});

test('portal dedupe recognizes the same non-Latin name without colliding distinct names', () => {
  const existing = [{ name: '公司一', careers_url: 'https://jobs.lever.co/alpha-board' }];
  const sameCompany = dedupeAgainstPortals([{ name: '公司一', careers_url: 'https://jobs.lever.co/new-alpha-board' }], existing);
  assert.equal(sameCompany.duplicates.length, 1);

  const differentCompany = dedupeAgainstPortals([{ name: '会社二', careers_url: 'https://jobs.lever.co/beta-board' }], existing);
  assert.equal(differentCompany.fresh.length, 1);
  assert.equal(differentCompany.duplicates.length, 0);
});

test('writes re-read the current file after discovery and preserve concurrent edits', async () => withTempDir(async (dir) => {
  const portalsPath = join(dir, 'portals.yml');
  writeFileSync(portalsPath, 'tracked_companies: []\n');
  let writes = 0;
  const result = await runDiscoverAts({
    rawInput: input, portalsPath, write: true, atomicWrite: (path, content) => { writes += 1; writeFileSync(path, content); },
    discover: async () => {
      writeFileSync(portalsPath, 'tracked_companies: []\n# concurrent edit retained\n');
      return { resolved: [match], unresolved: [] };
    },
  });
  assert.equal(result.metadata.written, true);
  assert.equal(writes, 1);
  assert.match(readFileSync(portalsPath, 'utf8'), /# concurrent edit retained/);
  assert.equal(yaml.load(readFileSync(portalsPath, 'utf8')).tracked_companies.length, 1);
}));

test('malformed input or portals schema fails before discovery and leaves the file unchanged', async () => withTempDir(async (dir) => {
  const portalsPath = join(dir, 'portals.yml');
  const original = 'tracked_companies: nope\n';
  writeFileSync(portalsPath, original);
  let discoveries = 0;
  const discover = async () => { discoveries += 1; return { resolved: [match], unresolved: [] }; };
  await assert.rejects(runDiscoverAts({ rawInput: 'companies: [', portalsPath, write: true, discover }), /malformed/);
  await assert.rejects(runDiscoverAts({ rawInput: input, portalsPath, write: true, discover }), /tracked_companies must be a list/);
  assert.equal(discoveries, 0);
  assert.equal(readFileSync(portalsPath, 'utf8'), original);
}));

test('failed atomic write leaves the original file intact', async () => withTempDir(async (dir) => {
  const portalsPath = join(dir, 'portals.yml');
  const original = 'tracked_companies: []\n';
  writeFileSync(portalsPath, original);
  await assert.rejects(runDiscoverAts({
    rawInput: input, portalsPath, write: true, discover: fakeDiscover(),
    atomicWrite: () => { throw new Error('injected atomic failure'); },
  }), /injected atomic failure/);
  assert.equal(readFileSync(portalsPath, 'utf8'), original);
}));

test('the real provider fetch path resolves only valid nonempty job lists; generic redirect text is not a refusal', async () => {
  const companies = parseCompanyInput(input);
  const validCtx = { fetchJson: async () => ({ jobs: [{ title: 'Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' }] }) };
  const valid = await runDiscovery(companies, { vendors: ['gh'], includeWorkday: false, concurrency: 1, ctx: validCtx });
  assert.equal(valid.resolved.length, 1);
  assert.equal(valid.resolved[0].jobCount, 1);

  const empty = await runDiscovery(companies, { vendors: ['gh'], includeWorkday: false, concurrency: 1, ctx: { fetchJson: async () => ({ jobs: [] }) } });
  assert.equal(empty.resolved.length, 0);
  assert.equal(empty.unresolved[0].emptyBoards[0].vendor, 'gh');

  const badRows = await runDiscovery(companies, { vendors: ['gh'], includeWorkday: false, concurrency: 1, ctx: { fetchJson: async () => ({ jobs: [{ title: 'Broken', absolute_url: 'javascript:alert(1)' }] }) } });
  assert.equal(badRows.resolved.length, 0);
  assert.match(badRows.unresolved[0].errors[0].error, /valid job records/);

  const falsePositive = await runDiscovery(companies, {
    vendors: ['gh'], includeWorkday: false, concurrency: 1,
    ctx: { fetchJson: async () => { const error = new TypeError('fetch failed'); error.cause = new Error('redirect mode is set to error'); throw error; } },
  });
  assert.equal(falsePositive.unresolved[0].errors[0].refusedRedirect, undefined);

  const markedRefusal = await runDiscovery(companies, {
    vendors: ['gh'], includeWorkday: false, concurrency: 1,
    ctx: { fetchJson: async () => { const error = new TypeError('fetch failed'); error.redirectRefused = true; throw error; } },
  });
  assert.equal(markedRefusal.unresolved[0].errors[0].refusedRedirect, true);
});

test('text insertion preserves unrelated bytes for an ordinary tracked list', () => {
  const original = '# keep\ntracked_companies:\n  - name: Existing\n    careers_url: https://jobs.lever.co/existing\n\njob_boards:\n  - name: Other\n';
  const inserted = insertIntoTrackedCompanies(original, [renderPortalEntry(match)]);
  assert.ok(inserted.startsWith('# keep\ntracked_companies:\n'));
  assert.ok(inserted.includes('job_boards:\n  - name: Other\n'));
  assert.equal(yaml.load(inserted).tracked_companies.length, 2);
});
