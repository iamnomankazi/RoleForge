import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { createServer } from 'node:http';
import {
  DEFAULT_RETRY_POLICY,
  fetchJson,
  fetchJsonWithRetry,
  fetchText,
  fetchTextWithRetry,
  isRetryableError,
  makeHttpCtx,
  parseRetryAfterMs,
  sleep,
} from '../../providers/_http.mjs';
import { BLOCKED_ADDRESS_CODE, BlockedProviderAddressError } from '../../providers/_ip-guard.mjs';

function headers(values = {}) {
  return { get: (name) => values[name.toLowerCase()] ?? null };
}

async function withMockFetch(mock, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}

test('makeHttpCtx retains the existing transport contract', () => {
  const ctx = makeHttpCtx();
  assert.equal(ctx.transport, 'http');
  assert.equal(ctx.fetchJson, fetchJson);
  assert.equal(ctx.fetchText, fetchText);
});

test('fetchText and fetchJson consume successful bodies inside the request', async () => {
  await withMockFetch(async (_url, options) => ({
    ok: true,
    status: 200,
    headers: headers(),
    text: async () => `text:${options.headers['user-agent']}`,
    json: async () => ({ ok: true }),
  }), async () => {
    assert.match(await fetchText('https://public.example/text'), /^text:Mozilla\/5\.0/);
    assert.deepEqual(await fetchJson('https://public.example/json'), { ok: true });
  });
});

test('request timeout covers stalled successful and error response bodies', async () => {
  const never = () => new Promise(() => {});
  await withMockFetch(async (url) => url.endsWith('/error') ? {
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    headers: headers({ 'retry-after': '2' }),
    text: never,
  } : {
    ok: true,
    status: 200,
    headers: headers(),
    text: never,
    json: never,
  }, async () => {
    await assert.rejects(fetchText('https://public.example/stalled', { timeoutMs: 30 }), (error) => error.code === 'ETIMEDOUT');
    await assert.rejects(fetchJson('https://public.example/stalled-json', { timeoutMs: 30 }), (error) => error.code === 'ETIMEDOUT');
    await assert.rejects(fetchText('https://public.example/error', { timeoutMs: 30 }), (error) => (
      error.code === 'ETIMEDOUT' && error.status === 503 && error.body === '' && error.retryAfter === '2'
    ));
  });
});

test('HTTP errors retain status, body, retryAfter, location, and statusText message', async () => {
  await withMockFetch(async () => ({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    headers: headers({ 'retry-after': '3', location: 'https://public.example/other' }),
    text: async () => 'slow down',
  }), async () => {
    await assert.rejects(fetchText('https://public.example/rate-limited'), (error) => {
      assert.equal(error.message, 'HTTP 429 Too Many Requests');
      assert.equal(error.status, 429);
      assert.equal(error.body, 'slow down');
      assert.equal(error.retryAfter, '3');
      assert.equal(error.location, 'https://public.example/other');
      return true;
    });
  });
});

test('provider context remains active through body consumption and rejects lookup-time loopback', async () => {
  await withMockFetch(async () => ({
    ok: true,
    status: 200,
    headers: headers(),
    text: () => new Promise((resolve, reject) => dns.lookup('localhost', (error, address) => {
      if (error) reject(error);
      else resolve(address);
    })),
  }), async () => {
    await assert.rejects(fetchText('https://public.example/body-lookup'), { code: BLOCKED_ADDRESS_CODE });
  });
});

test('literal loopback is blocked only for provider HTTP while local infrastructure remains usable', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end('local-ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;
  try {
    assert.equal(await (await globalThis.fetch(url)).text(), 'local-ok');
    await assert.rejects(fetchText(url), { code: BLOCKED_ADDRESS_CODE });
    await assert.rejects(fetchText(`http://localhost:${port}/`), { code: BLOCKED_ADDRESS_CODE });
    assert.equal(requests, 1, 'blocked provider request must fail before a connection');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('parseRetryAfterMs handles delta-seconds, HTTP dates, and invalid values', () => {
  const now = Date.parse('2026-08-31T12:00:00Z');
  assert.equal(parseRetryAfterMs('2'), 2_000);
  assert.equal(parseRetryAfterMs('1.5'), 1_500);
  assert.equal(parseRetryAfterMs('Sun, 31 Aug 2026 12:00:05 GMT', now), 5_000);
  assert.equal(parseRetryAfterMs('Sun, 31 Aug 2026 11:59:00 GMT', now), 0);
  assert.equal(parseRetryAfterMs('nonsense', now), null);
  assert.equal(parseRetryAfterMs(null, now), null);
});

test('retry helpers retry 429, 5xx, and statusless transport failures with bounded delays', async () => {
  let attempts = 0;
  const delays = [];
  const ctx = {
    random: () => 0.5,
    sleep: async (ms) => delays.push(ms),
    fetchJson: async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('rate limited'), { status: 429, retryAfter: '99999' });
      if (attempts === 2) throw Object.assign(new Error('server failed'), { status: 503 });
      return { ok: true };
    },
  };
  assert.deepEqual(await fetchJsonWithRetry(ctx, 'https://public.example', {}, { maxRetryAfterMs: 8_000 }), { ok: true });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [8_000, 1_000]);

  let networkAttempts = 0;
  const networkDelays = [];
  const result = await fetchTextWithRetry({
    random: () => 0.5,
    sleep: async (ms) => networkDelays.push(ms),
    fetchText: async () => {
      networkAttempts++;
      if (networkAttempts < 3) throw new Error('network unavailable');
      return 'ok';
    },
  }, 'https://public.example');
  assert.equal(result, 'ok');
  assert.deepEqual(networkDelays, [500, 1_000]);
});

test('retry helpers do not retry normal 4xx, blocked addresses, or deterministic redirect refusal', async () => {
  for (const error of [
    Object.assign(new Error('not found'), { status: 404 }),
    new BlockedProviderAddressError('private.example', '127.0.0.1'),
    Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') }),
  ]) {
    let attempts = 0;
    await assert.rejects(fetchTextWithRetry({
      fetchText: async () => { attempts++; throw error; },
      sleep: async () => assert.fail('non-retryable error must not sleep'),
    }, 'https://public.example'), (actual) => actual === error);
    assert.equal(attempts, 1);
    assert.equal(isRetryableError(error), false);
  }
});

test('retry policy is bounded and sleep supports injection', async () => {
  assert.deepEqual(DEFAULT_RETRY_POLICY, {
    retries: 2,
    baseDelayMs: 500,
    maxDelayMs: 8_000,
    maxRetryAfterMs: 8_000,
    jitterRatio: 0.2,
  });
  let attempts = 0;
  const delays = [];
  const persistent = Object.assign(new Error('gateway'), { status: 502 });
  await assert.rejects(fetchJsonWithRetry({
    random: () => 0.5,
    sleep: async (ms) => delays.push(ms),
    fetchJson: async () => { attempts++; throw persistent; },
  }, 'https://public.example'), (error) => error === persistent);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1_000]);

  let injected;
  await sleep(17, { sleep: async (ms) => { injected = ms; } });
  assert.equal(injected, 17);
});

test('redirect:error failures are marked and treated as deterministic when identifiable', async () => {
  const redirectError = Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
  await withMockFetch(async () => { throw redirectError; }, async () => {
    await assert.rejects(fetchText('https://public.example/redirect', { redirect: 'error' }), (error) => (
      error === redirectError && error.redirectRefused === true && isRetryableError(error) === false
    ));
  });
});

test('follow-mode literal loopback redirect is blocked before the target fetch', async () => {
  let targetRequests = 0;
  const targetServer = createServer((_request, response) => {
    targetRequests++;
    response.end('private');
  });
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${targetServer.address().port}/private`;
  const calls = [];
  try {
    const realFetch = globalThis.fetch;
    await withMockFetch(async (url, options) => {
      calls.push({ url, options });
      if (url === 'https://public.example/start') return new Response('', { status: 302, headers: { location: target } });
      return realFetch(url, options);
    }, async () => {
      await assert.rejects(fetchText('https://public.example/start'), { code: 'ECAREEROPS_BLOCKED_ADDRESS' });
    });
    assert.deepEqual(calls.map((call) => call.url), ['https://public.example/start']);
    assert.equal(targetRequests, 0);
  } finally {
    await new Promise((resolve) => targetServer.close(resolve));
  }
});

test('follow-mode literal link-local metadata redirect is blocked before the target fetch', async () => {
  const calls = [];
  await withMockFetch(async (url) => {
    calls.push(url);
    return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
  }, async () => {
    await assert.rejects(fetchText('https://public.example/start'), { code: 'ECAREEROPS_BLOCKED_ADDRESS' });
  });
  assert.deepEqual(calls, ['https://public.example/start']);
});

test('follow-mode hostname redirect remains protected by lookup-time validation', async () => {
  let targetRequests = 0;
  const targetServer = createServer((_request, response) => {
    targetRequests++;
    response.end('private');
  });
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  const target = `http://localhost:${targetServer.address().port}/private`;
  const realFetch = globalThis.fetch;
  const calls = [];
  try {
    await withMockFetch(async (url, options) => {
      calls.push(url);
      if (url === 'https://public.example/start') return new Response('', { status: 302, headers: { location: target } });
      return realFetch(url, options);
    }, async () => {
      await assert.rejects(fetchText('https://public.example/start'), { code: 'ECAREEROPS_BLOCKED_ADDRESS' });
    });
    assert.deepEqual(calls, ['https://public.example/start', target]);
    assert.equal(targetRequests, 0);
  } finally {
    await new Promise((resolve) => targetServer.close(resolve));
  }
});

test('follow-mode public and relative redirects resolve successfully', async () => {
  const calls = [];
  await withMockFetch(async (url, options) => {
    calls.push({ url, redirect: options.redirect });
    if (url === 'https://public.example/start') return new Response('', { status: 302, headers: { location: '/next' } });
    if (url === 'https://public.example/next') return new Response('', { status: 301, headers: { location: 'https://cdn.example/final' } });
    return new Response('done', { status: 200 });
  }, async () => {
    assert.equal(await fetchText('https://public.example/start'), 'done');
  });
  assert.deepEqual(calls.map(({ url }) => url), [
    'https://public.example/start', 'https://public.example/next', 'https://cdn.example/final',
  ]);
  assert.deepEqual(calls.map(({ redirect }) => redirect), ['manual', 'manual', 'manual']);
});

test('redirect:error remains non-following and redirect:manual remains manual', async () => {
  const redirectError = Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
  let errorCalls = 0;
  await withMockFetch(async (_url, options) => {
    errorCalls++;
    assert.equal(options.redirect, 'error');
    throw redirectError;
  }, async () => {
    await assert.rejects(fetchTextWithRetry({ fetchText }, 'https://public.example/error', { redirect: 'error' }), (error) => (
      error === redirectError && error.redirectRefused === true
    ));
  });
  assert.equal(errorCalls, 1);

  let manualCalls = 0;
  await withMockFetch(async (_url, options) => {
    manualCalls++;
    assert.equal(options.redirect, 'manual');
    return new Response('manual-body', { status: 302, headers: { location: 'https://public.example/ignored' } });
  }, async () => {
    await assert.rejects(fetchText('https://public.example/manual', { redirect: 'manual' }), (error) => (
      error.status === 302 && error.body === 'manual-body'
    ));
  });
  assert.equal(manualCalls, 1);
});

test('follow-mode applies fetch method semantics for 303, 301/302 POST, and 307/308', async () => {
  for (const [status, expectedMethod, expectedBody] of [
    [303, 'GET', null],
    [301, 'GET', null],
    [302, 'GET', null],
    [307, 'POST', 'payload'],
    [308, 'POST', 'payload'],
  ]) {
    const requests = [];
    await withMockFetch(async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1
        ? new Response('', { status, headers: { location: 'https://public.example/next' } })
        : new Response('ok', { status: 200 });
    }, async () => {
      assert.equal(await fetchText('https://public.example/start', {
        method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' },
      }), 'ok');
    });
    assert.equal(requests.length, 2, `status ${status}`);
    assert.equal(requests[1].options.method, expectedMethod, `status ${status}`);
    assert.equal(requests[1].options.body, expectedBody, `status ${status}`);
    assert.equal('content-type' in requests[1].options.headers, expectedBody !== null, `status ${status}`);
  }
});

test('cross-origin and HTTPS downgrade redirects strip credential headers', async () => {
  const requests = [];
  await withMockFetch(async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1
      ? new Response('', { status: 307, headers: { location: 'http://other.example/final' } })
      : new Response('ok', { status: 200 });
  }, async () => {
    assert.equal(await fetchText('https://public.example/start', {
      headers: {
        Authorization: 'Bearer secret', Cookie: 'sid=secret', 'Proxy-Authorization': 'Basic secret',
        'X-Api-Key': 'api-secret', 'X-Auth-Token': 'token-secret', 'X-Forwarded-For': '10.0.0.1',
        'X-Trace': 'keep-me',
      },
    }), 'ok');
  });
  const redirectedHeaders = Object.fromEntries(Object.entries(requests[1].options.headers).map(([key, value]) => [key.toLowerCase(), value]));
  for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token', 'x-forwarded-for']) {
    assert.equal(name in redirectedHeaders, false, name);
  }
  assert.equal(redirectedHeaders['x-trace'], 'keep-me');
});

test('follow-mode redirect chains are bounded and loops fail deterministically', async () => {
  let calls = 0;
  await withMockFetch(async (url) => {
    calls++;
    const next = `https://public.example/hop-${calls}`;
    return new Response('', { status: 302, headers: { location: next } });
  }, async () => {
    await assert.rejects(fetchText('https://public.example/start'), { code: 'ECAREEROPS_REDIRECT_LIMIT' });
  });
  assert.equal(calls, 21);

  let loopCalls = 0;
  await withMockFetch(async (url) => {
    loopCalls++;
    return new Response('', { status: 302, headers: { location: url.endsWith('/a') ? '/b' : '/a' } });
  }, async () => {
    await assert.rejects(fetchText('https://public.example/a'), { code: 'ECAREEROPS_REDIRECT_LOOP' });
  });
  assert.equal(loopCalls, 2);
});

test('one timeout spans all redirect hops instead of resetting per hop', async () => {
  let calls = 0;
  const started = Date.now();
  await withMockFetch(async () => {
    calls++;
    if (calls === 1) return new Response('', { status: 302, headers: { location: 'https://public.example/slow' } });
    return new Promise(() => {});
  }, async () => {
    await assert.rejects(fetchText('https://public.example/start', { timeoutMs: 35 }), { code: 'ETIMEDOUT' });
  });
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 180, 'timeout should not be reset for the second hop');
});

test('missing or malformed follow-mode Location fails deterministically', async () => {
  for (const response of [
    new Response('', { status: 302 }),
    new Response('', { status: 302, headers: { location: 'http://[malformed' } }),
  ]) {
    await withMockFetch(async () => response, async () => {
      await assert.rejects(fetchText('https://public.example/start'), (error) => (
        error.code === 'ECAREEROPS_REDIRECT_LOCATION'
      ));
    });
  }
});
