import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vdab, {
  buildVdabSearchBody,
  normalizeVdabConfig,
  normalizeVdabId,
  normalizeVdabJob,
} from '../../providers/vdab.mjs';
import { providerCoverage } from '../../providers/_result.mjs';

const SEARCH_URL = 'https://www.vdab.be/rest/vindeenjob/v4/vacatureLight/zoek';
const BOARD_URL = 'https://www.vdab.be/vindeenjob/vacatures';
const INITIAL_KEY = 'b277002f-e1fa-4fc5-868a-fdab633c3851';
const FRESH_KEY = '44e8c4fc-216d-4fd1-8424-6a4ad11c2309';

function vacancy(id, overrides = {}) {
  return {
    id: { id },
    vacaturefunctie: { naam: `Role ${id}` },
    vacatureBedrijfsnaam: 'Example BV',
    tewerkstellingsLocatieRegioOfAdres: 'Antwerp',
    eerstePublicatieDatum: '2026-09-20T12:00:00Z',
    ...overrides,
  };
}

function page(resultaten) {
  return { resultaten };
}

function httpError(status, message = `HTTP ${status}`) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseRequest(options) {
  return JSON.parse(options.body);
}

function searchEntry(vdabOptions = {}) {
  return { name: 'VDAB board', provider: 'vdab', vdab: { keywords: ['AI'], ...vdabOptions } };
}

test('config normalization trims and deduplicates explicit keywords and bounds options', () => {
  assert.deepEqual(normalizeVdabConfig({
    vdab: {
      keywords: ['  Data Engineer ', '', 'Data Engineer', null, ' ML '],
      days: 5000,
      size: 0,
      fetchDetails: true,
      detailLimit: 500,
    },
  }, ['ignored profile role']), {
    keywords: ['Data Engineer', 'ML'],
    days: 1000,
    size: 1,
    fetchDetails: true,
    detailLimit: 100,
  });
  assert.deepEqual(normalizeVdabConfig({}, [' Engineer ', 'Engineer', '']), {
    keywords: ['Engineer'],
    days: 30,
    size: 100,
    fetchDetails: false,
    detailLimit: 25,
  });
  assert.deepEqual(normalizeVdabConfig({ vdab: { keywords: [] } }, ['Fallback']), {
    keywords: [], days: 30, size: 100, fetchDetails: false, detailLimit: 25,
  });
  assert.equal(normalizeVdabConfig({ vdab: { fetchDetails: 'true' } }).fetchDetails, false);
});

test('search body uses the VDAB criteria contract and zero-based page', () => {
  assert.deepEqual(buildVdabSearchBody('AI Engineer', { days: 21, size: 50, page: 3 }), {
    criteria: {
      trefwoord: 'AI Engineer',
      diplomaCodes: [],
      arbeidsduurCodes: [],
      arbeidsregimeCodes: [],
      contractTypeCodes: [],
      jobdomeinCodes: [],
      internationaalCodes: [],
      beroepCodes: [],
      ervaringCodes: [],
      rijbewijsCodes: [],
      attestCodes: [],
      taalCriteria: { taalSelecties: [] },
      onlineSindsCode: '21',
      sorteerVeld: 'STANDAARD',
    },
    pagina: 3,
    zoekmodus: 'C2',
    paginaGrootte: 50,
  });
});

test('id and row normalization reject malformed ids and preserve canonical source fields', () => {
  for (const invalid of [undefined, null, {}, true, '', '  ', '.', '..', '\u0001', '\ud800', '\udc00']) {
    assert.equal(normalizeVdabId(invalid), null, `expected ${String(invalid)} to be rejected`);
  }
  assert.equal(normalizeVdabId(123), '123');
  assert.equal(normalizeVdabId('  job/a  '), 'job/a');

  const encoded = normalizeVdabJob(vacancy('job/a'), 'AI Engineer', 'Fallback BV');
  assert.deepEqual(encoded, {
    title: 'Role job/a',
    url: 'https://www.vdab.be/vindeenjob/vacatures/job%2Fa',
    company: 'Example BV',
    location: 'Antwerp',
    sourceId: 'job/a',
    sourceUrl: 'https://www.vdab.be/vindeenjob/vacatures/job%2Fa',
    sourceQuery: 'AI Engineer',
    sourceQueries: ['AI Engineer'],
    postedAt: Date.parse('2026-09-20T12:00:00Z'),
  });
  assert.equal(normalizeVdabJob(vacancy('\ud800'), 'AI'), null);
  assert.equal(normalizeVdabJob(vacancy('ok', { vacaturefunctie: { naam: '  ' } }), 'AI'), null);
});

test('profile fallback reads the selected profile at fetch time without using an implicit global', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'career-ops-vdab-'));
  const profilePath = path.join(directory, 'profile.yml');
  const oldProfile = process.env.CAREER_OPS_PROFILE;
  try {
    await writeFile(profilePath, 'target_roles:\n  primary:\n    - "Data Engineer"\n    - " ML Engineer "\n    - "Data Engineer"\n', 'utf8');
    process.env.CAREER_OPS_PROFILE = profilePath;
    const requested = [];
    const jobs = await vdab.fetch({ provider: 'vdab', vdab: { size: 10 } }, {
      fetchJson: async (url, options) => {
        requested.push({ url, body: parseRequest(options) });
        return page([]);
      },
    });
    assert.equal(jobs.length, 0);
    assert.deepEqual(requested.map(item => item.body.criteria.trefwoord), ['Data Engineer', 'ML Engineer']);
    assert.ok(requested.every(item => item.url === SEARCH_URL));
  } finally {
    if (oldProfile === undefined) delete process.env.CAREER_OPS_PROFILE;
    else process.env.CAREER_OPS_PROFILE = oldProfile;
    const contents = await readFile(profilePath, 'utf8');
    assert.match(contents, /target_roles/);
    await rm(directory, { recursive: true, force: true });
  }
});

test('keyword pagination uses zero-based pages and merges query provenance by id', async () => {
  const requests = [];
  const jobs = await vdab.fetch({ name: 'VDAB', vdab: { keywords: ['AI', 'ML'], size: 2 } }, {
    fetchJson: async (url, options) => {
      requests.push({ url, options, body: parseRequest(options) });
      const { trefwoord } = requests.at(-1).body.criteria;
      const pageNumber = requests.at(-1).body.pagina;
      if (trefwoord === 'AI' && pageNumber === 0) return page([vacancy('a'), vacancy('b')]);
      if (trefwoord === 'AI' && pageNumber === 1) return page([vacancy('c')]);
      if (trefwoord === 'ML') return page([vacancy('a')]);
      throw new Error('unexpected request');
    },
  });

  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(item => [item.body.criteria.trefwoord, item.body.pagina]), [['AI', 0], ['AI', 1], ['ML', 0]]);
  assert.ok(requests.every(({ url, options }) => url === SEARCH_URL
    && options.method === 'POST' && options.redirect === 'error'
    && options.headers['vej-key-monitor'] === INITIAL_KEY));
  assert.deepEqual(jobs.map(job => job.sourceId), ['a', 'b', 'c']);
  assert.equal(jobs[0].sourceQuery, 'AI');
  assert.deepEqual(jobs[0].sourceQueries, ['AI', 'ML']);
  assert.equal(providerCoverage(jobs), null);
});

test('an answered empty keyword is healthy while malformed and all-unusable result pages fail closed', async () => {
  const empty = await vdab.fetch(searchEntry(), { fetchJson: async () => page([]) });
  assert.deepEqual(empty, []);
  assert.equal(providerCoverage(empty), null);

  for (const payload of [{}, { resultaten: null }, page([null, { id: { id: 'x' } }])]) {
    await assert.rejects(vdab.fetch(searchEntry(), { fetchJson: async () => payload }), (error) => {
      assert.equal(error.code, 'EVDAB_MALFORMED_RESPONSE');
      return true;
    });
  }

  const mixed = await vdab.fetch(searchEntry(), {
    fetchJson: async () => page([null, vacancy('\ud800'), vacancy('valid')]),
  });
  assert.deepEqual(mixed.map(job => job.sourceId), ['valid']);
});

test('partial keyword outages preserve good and empty answers; all failed keywords throw the original error', async () => {
  const outage = new Error('keyword endpoint unavailable');
  const partial = await vdab.fetch({ vdab: { keywords: ['Good', 'Unavailable'] } }, {
    fetchJson: async (_url, options) => {
      if (parseRequest(options).criteria.trefwoord === 'Good') return page([]);
      throw outage;
    },
  });
  assert.deepEqual(partial, []);
  assert.equal(providerCoverage(partial)?.status, 'partial');
  assert.match(providerCoverage(partial)?.reason || '', /fetch_error/);

  await assert.rejects(vdab.fetch({ vdab: { keywords: ['First', 'Second'] } }, {
    fetchJson: async () => { throw outage; },
  }), error => error === outage);
});

test('later page failures keep earlier vacancies and attach partial coverage', async () => {
  const laterFailure = new Error('page two is down');
  const calls = [];
  const jobs = await vdab.fetch(searchEntry({ size: 1 }), {
    fetchJson: async (_url, options) => {
      const request = parseRequest(options);
      calls.push(request.pagina);
      if (request.pagina === 0) return page([vacancy('first')]);
      throw laterFailure;
    },
  });
  assert.deepEqual(calls, [0, 1]);
  assert.deepEqual(jobs.map(job => job.sourceId), ['first']);
  assert.equal(providerCoverage(jobs)?.status, 'partial');
});

test('pagination stops at 50 pages and reports the provider cap', async () => {
  const pages = [];
  const jobs = await vdab.fetch(searchEntry({ size: 1 }), {
    fetchJson: async (_url, options) => {
      const current = parseRequest(options).pagina;
      pages.push(current);
      return page([vacancy(`p${current}`)]);
    },
  });
  assert.equal(pages.length, 50);
  assert.deepEqual([pages[0], pages.at(-1)], [0, 49]);
  assert.equal(jobs.length, 50);
  assert.equal(providerCoverage(jobs)?.code, 'max_pages');
  assert.equal(providerCoverage(jobs)?.pagesFetched, 50);
  assert.equal(providerCoverage(jobs)?.maxPages, 50);
});

test('health probes honor ctx.maxPages and skip all detail enrichment', async () => {
  const calls = [];
  const jobs = await vdab.fetch(searchEntry({ size: 1, fetchDetails: true }), {
    maxPages: 1,
    fetchJson: async (url, options) => {
      calls.push(url);
      if (url !== SEARCH_URL) throw new Error('detail request should be skipped');
      return page([vacancy('probe')]);
    },
  });
  assert.deepEqual(calls, [SEARCH_URL]);
  assert.equal(jobs.length, 1);
  assert.equal(providerCoverage(jobs)?.code, 'max_pages');
});

test('detail enrichment is opt-in, globally limited, and runs in batches of at most five', async () => {
  const listing = Array.from({ length: 7 }, (_, index) => vacancy(`d${index}`));
  let detailCalls = 0;
  let active = 0;
  let peak = 0;
  const jobs = await vdab.fetch(searchEntry({ fetchDetails: true, detailLimit: 6 }), {
    fetchJson: async (url) => {
      if (url === SEARCH_URL) return page(listing);
      detailCalls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return { functie: { omschrijving: { markdown: '## Overview\n\nWe build **things** and [teams](https://example.test).' } } };
    },
  });
  assert.equal(detailCalls, 6);
  assert.equal(peak, 5);
  assert.equal(jobs[0].description, 'Overview We build things and teams.');
  assert.equal(jobs[5].description, 'Overview We build things and teams.');
  assert.equal('description' in jobs[6], false);
});

test('detail failures retain listing jobs and mark coverage partial', async () => {
  const jobs = await vdab.fetch(searchEntry({ fetchDetails: true }), {
    fetchJson: async (url) => {
      if (url === SEARCH_URL) return page([vacancy('one')]);
      throw new Error('detail is unavailable');
    },
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, 'https://www.vdab.be/vindeenjob/vacatures/one');
  assert.equal(providerCoverage(jobs)?.code, 'detail_failed');
});

test('403 recovery probes only the board page and safe bundle, then reuses the fresh key', async () => {
  const requests = [];
  const probes = [];
  const jobs = await vdab.fetch({ vdab: { keywords: ['AI', 'ML'] } }, {
    fetchJson: async (url, options) => {
      requests.push({ url, options, body: url === SEARCH_URL ? parseRequest(options) : null });
      if (requests.length === 1) throw httpError(403);
      return page([]);
    },
    fetchText: async (url, options) => {
      probes.push({ url, options });
      if (url === BOARD_URL) return '<script src="/webapps/vindeenjob/main-runtime-7a_1.js"></script>';
      return 'var config = ["vej-key-monitor","44e8c4fc-216d-4fd1-8424-6a4ad11c2309"];';
    },
  });
  assert.deepEqual(jobs, []);
  assert.deepEqual(probes.map(item => item.url), [
    BOARD_URL,
    'https://www.vdab.be/webapps/vindeenjob/main-runtime-7a_1.js',
  ]);
  assert.deepEqual(probes.map(item => [item.options.timeoutMs, item.options.redirect]), [[12_000, 'error'], [15_000, 'error']]);
  assert.deepEqual(requests.map(item => item.options.headers['vej-key-monitor']), [INITIAL_KEY, FRESH_KEY, FRESH_KEY]);
  assert.deepEqual(requests.map(item => item.body?.criteria.trefwoord), ['AI', 'AI', 'ML']);
});

test('403 recovery rejects bundle userinfo and nondefault ports before fetching the bundle', async () => {
  const invalidSources = [
    'https://user:pass@www.vdab.be/webapps/vindeenjob/main-credentials.js',
    'https://www.vdab.be:8443/webapps/vindeenjob/main-port.js',
    'https://user:pass@www.vdab.be:8443/webapps/vindeenjob/main-combined.js',
    'https://evil.example@www.vdab.be/webapps/vindeenjob/main-userinfo-vdab.js',
    'https://www.vdab.be@evil.example/webapps/vindeenjob/main-userinfo-host.js',
  ];

  for (const source of invalidSources) {
    const original403 = httpError(403, 'initial forbidden');
    const textRequests = [];
    let searchCalls = 0;
    await assert.rejects(vdab.fetch(searchEntry(), {
      fetchJson: async () => { searchCalls++; throw original403; },
      fetchText: async (url) => {
        textRequests.push(url);
        return url === BOARD_URL ? `<script src="${source}"></script>` : `"vej-key-monitor","${FRESH_KEY}"`;
      },
    }), error => {
      assert.equal(error, original403);
      assert.equal(error.status, 403);
      assert.equal(error.vdabProbeError.code, 'EVDAB_KEY_BUNDLE_NOT_FOUND');
      return true;
    });
    assert.deepEqual(textRequests, [BOARD_URL], `must reject before fetching ${source}`);
    assert.equal(searchCalls, 1, `must not retry after rejecting ${source}`);
  }
});

test('bundle URL normalization accepts the default HTTPS port as the VDAB origin', async () => {
  const textRequests = [];
  let searchCalls = 0;
  const jobs = await vdab.fetch(searchEntry(), {
    fetchJson: async () => {
      searchCalls++;
      if (searchCalls === 1) throw httpError(403);
      return page([]);
    },
    fetchText: async (url) => {
      textRequests.push(url);
      return url === BOARD_URL
        ? '<script src="https://www.vdab.be:443/webapps/vindeenjob/main-default-port.js"></script>'
        : `"vej-key-monitor","${FRESH_KEY}"`;
    },
  });
  assert.deepEqual(jobs, []);
  assert.equal(searchCalls, 2);
  assert.deepEqual(textRequests, [
    BOARD_URL,
    'https://www.vdab.be/webapps/vindeenjob/main-default-port.js',
  ]);
});

test('a failed 403 key derivation rethrows the original response error with its typed probe cause', async () => {
  const original403 = httpError(403, 'blocked');
  const networkProbeError = new Error('probe network reset');
  let probes = 0;
  await assert.rejects(vdab.fetch(searchEntry(), {
    fetchJson: async () => { throw original403; },
    fetchText: async () => { probes++; throw networkProbeError; },
  }), error => {
    assert.equal(error, original403);
    assert.equal(error.status, 403);
    assert.equal(error.vdabProbeError.code, 'EVDAB_KEY_PROBE_FAILED');
    assert.equal(error.vdabProbeError.cause, networkProbeError);
    return true;
  });
  assert.equal(probes, 1);
});

test('403 recovery happens once, and a retry 403 is returned without another probe', async () => {
  const retried403 = httpError(403, 'still blocked');
  let requests = 0;
  let probes = 0;
  await assert.rejects(vdab.fetch(searchEntry(), {
    fetchJson: async () => {
      requests++;
      throw requests === 1 ? httpError(403, 'initial') : retried403;
    },
    fetchText: async (url) => {
      probes++;
      return url === BOARD_URL
        ? '<script src="/webapps/vindeenjob/main-a1.js"></script>'
        : '"vej-key-monitor","44e8c4fc-216d-4fd1-8424-6a4ad11c2309"';
    },
  }), error => error === retried403);
  assert.equal(requests, 2);
  assert.equal(probes, 2);
});

test('non-403 failures do not trigger the key recovery flow', async () => {
  const serverError = httpError(503, 'unavailable');
  let probes = 0;
  await assert.rejects(vdab.fetch(searchEntry(), {
    fetchJson: async () => { throw serverError; },
    fetchText: async () => { probes++; return ''; },
  }), error => error === serverError);
  assert.equal(probes, 0);
});
