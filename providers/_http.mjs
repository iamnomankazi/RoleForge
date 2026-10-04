// HTTP transport helpers shared across providers.
// Files prefixed with _ are never loaded as providers by scan.mjs.
import './_dns-cache.mjs';
import { intInRange } from './_config-utils.mjs';
import {
  BLOCKED_ADDRESS_CODE,
  assertProviderUrlIpLiteral,
  withProviderIpGuard,
} from './_ip-guard.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; career-ops/1.3)';
export const BROWSER_LIKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
export const DEFAULT_RETRY_POLICY = Object.freeze({
  retries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 8_000,
  jitterRatio: 0.2,
});
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 20;
const REDIRECT_ERROR_CODES = new Set([
  'ECAREEROPS_REDIRECT_REFUSED',
  'ECAREEROPS_REDIRECT_LIMIT',
  'ECAREEROPS_REDIRECT_LOOP',
  'ECAREEROPS_REDIRECT_LOCATION',
  'ECAREEROPS_REDIRECT_SCHEME',
]);

const TRANSPORT_ERROR_CODES = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'EPIPE',
  'ETIMEDOUT', 'ENETDOWN', 'ENETRESET', 'ENETUNREACH', 'ENOTFOUND',
  'EAI_AGAIN', 'ENOTIMP', 'EREFUSED', 'ESERVFAIL',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function errorChain(error) {
  const chain = [];
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 6; current = current.cause, depth++) {
    chain.push(current);
  }
  return chain;
}

function isRedirectRefusal(error) {
  return errorChain(error).some((current) => current.redirectRefused === true
    || REDIRECT_ERROR_CODES.has(current.code)
    || /redirect mode is set to error|unexpected redirect|redirect.*not allowed/i.test(String(current.message || '')));
}

function markRedirectRefusal(error, redirect) {
  if (redirect !== 'error' || !isRedirectRefusal(error)) return;
  try { error.redirectRefused = true; } catch {}
  if (!error.code) {
    try { error.code = 'ECAREEROPS_REDIRECT_REFUSED'; } catch {}
  }
}

function headerValue(response, name) {
  return typeof response?.headers?.get === 'function' ? response.headers.get(name) : null;
}

function responseMetadata(response) {
  return {
    status: response.status,
    retryAfter: headerValue(response, 'retry-after'),
    location: headerValue(response, 'location'),
  };
}

function attachResponseMetadata(error, metadata, body = '') {
  error.status = metadata.status;
  error.body = body;
  error.retryAfter = metadata.retryAfter;
  if (metadata.location != null) error.location = metadata.location;
  return error;
}

function makeTimeoutError(timeoutMs, metadata) {
  const error = new Error(`Request timed out after ${timeoutMs}ms`);
  error.name = 'AbortError';
  error.code = 'ETIMEDOUT';
  return metadata ? attachResponseMetadata(error, metadata) : error;
}

function makeRedirectError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.redirectRefused = true;
  return error;
}

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function isSensitiveRedirectHeader(name) {
  const lower = name.toLowerCase();
  return lower === 'authorization'
    || lower === 'cookie'
    || lower === 'set-cookie'
    || lower === 'proxy-authorization'
    || lower === 'proxy-authenticate'
    || lower === 'forwarded'
    || lower === 'via'
    || lower === 'x-api-key'
    || lower === 'x-auth-token'
    || lower === 'x-access-token'
    || lower === 'x-session-token'
    || lower === 'x-client-token'
    || lower === 'x-client-secret'
    || lower === 'x-credential'
    || lower === 'x-csrf-token'
    || lower === 'x-xsrf-token'
    || lower.startsWith('proxy-')
    || lower.startsWith('x-forwarded-');
}

function stripRedirectCredentials(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => {
    const lower = name.toLowerCase();
    return !isSensitiveRedirectHeader(name)
      && !['host', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection'].includes(lower);
  }));
}

function stripBodyHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => ![
    'content-length', 'content-type', 'transfer-encoding', 'content-encoding',
  ].includes(name.toLowerCase())));
}

function redirectedMethodAndBody(status, method, body) {
  const upperMethod = String(method || 'GET').toUpperCase();
  if (status === 303 && upperMethod !== 'HEAD') return { method: 'GET', body: null, bodyChanged: true };
  if ((status === 301 || status === 302) && upperMethod === 'POST') return { method: 'GET', body: null, bodyChanged: true };
  return { method, body, bodyChanged: false };
}

async function fetchAndConsume(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body = null, redirect = 'follow' } = {}, consume) {
  const controller = new AbortController();
  let pendingErrorMetadata = null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = makeTimeoutError(timeoutMs, pendingErrorMetadata);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  const request = withProviderIpGuard(async () => {
    const followRedirects = redirect === 'follow';
    let currentUrl = String(url);
    let currentMethod = method;
    let currentBody = body;
    let currentHeaders = { 'user-agent': DEFAULT_USER_AGENT, ...normalizeHeaders(headers) };
    const visited = new Set();
    let redirectHops = 0;

    while (true) {
      assertProviderUrlIpLiteral(currentUrl);
      if (followRedirects) {
        let canonical;
        try { canonical = new URL(currentUrl).href; } catch { canonical = currentUrl; }
        if (visited.has(canonical)) throw makeRedirectError('ECAREEROPS_REDIRECT_LOOP', `Redirect loop detected at ${currentUrl}`);
        visited.add(canonical);
      }

      let res;
      try {
        res = await fetch(currentUrl, {
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody,
          redirect: followRedirects ? 'manual' : redirect,
          signal: controller.signal,
        });
      } catch (error) {
        const blockedAddress = errorChain(error).find((current) => current.code === BLOCKED_ADDRESS_CODE);
        if (blockedAddress) throw blockedAddress;
        markRedirectRefusal(error, redirect);
        throw error;
      }

      if (followRedirects && REDIRECT_STATUSES.has(res.status)) {
        if (redirectHops >= MAX_REDIRECT_HOPS) {
          throw makeRedirectError('ECAREEROPS_REDIRECT_LIMIT', `Too many redirects (maximum ${MAX_REDIRECT_HOPS})`);
        }
        const location = headerValue(res, 'location');
        if (typeof location !== 'string' || !location.trim()) {
          throw makeRedirectError('ECAREEROPS_REDIRECT_LOCATION', `Redirect response ${res.status} has no usable Location header`);
        }
        let nextUrl;
        try {
          nextUrl = new URL(location.trim(), currentUrl);
        } catch {
          throw makeRedirectError('ECAREEROPS_REDIRECT_LOCATION', `Redirect response ${res.status} has an invalid Location header`);
        }
        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
          throw makeRedirectError('ECAREEROPS_REDIRECT_SCHEME', `Redirect target uses unsupported scheme ${nextUrl.protocol}`);
        }

        const nextUrlString = nextUrl.href;
        if (visited.has(nextUrlString)) {
          throw makeRedirectError('ECAREEROPS_REDIRECT_LOOP', `Redirect loop detected at ${nextUrlString}`);
        }
        const currentOrigin = (() => { try { return new URL(currentUrl).origin; } catch { return ''; } })();
        const crossOrigin = currentOrigin !== nextUrl.origin;
        const downgrade = new URL(currentUrl).protocol === 'https:' && nextUrl.protocol === 'http:';
        const redirected = redirectedMethodAndBody(res.status, currentMethod, currentBody);
        let nextHeaders = currentHeaders;
        if (crossOrigin || downgrade) nextHeaders = stripRedirectCredentials(nextHeaders);
        if (redirected.bodyChanged) nextHeaders = stripBodyHeaders(nextHeaders);
        if (typeof res.body?.cancel === 'function') {
          try { await res.body.cancel(); } catch {}
        }
        currentUrl = nextUrlString;
        currentMethod = redirected.method;
        currentBody = redirected.body;
        currentHeaders = nextHeaders;
        redirectHops++;
        continue;
      }

      if (!res.ok) {
        pendingErrorMetadata = responseMetadata(res);
        let responseText;
        try {
          responseText = await res.text();
        } catch (error) {
          throw attachResponseMetadata(error, pendingErrorMetadata);
        }
        // WAF/CDN challenge pages (seen live: Workday 429s) carry no actionable
        // text — HTML markup or a generic interstitial message, not worth
        // parsing or displaying. The raw body remains available to callers.
        const error = new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
        throw attachResponseMetadata(error, pendingErrorMetadata, responseText);
      }
      return await consume(res);
    }
  }, { requestUrl: String(url) });

  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts = {}) {
  return await fetchAndConsume(url, opts, (response) => response.json());
}

export async function fetchText(url, opts = {}) {
  return await fetchAndConsume(url, opts, (response) => response.text());
}

export function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRetryAfterMs(value, now = Date.now()) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const milliseconds = Number(normalized) * 1_000;
    return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : null;
  }
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

export function isRetryableError(error) {
  const chain = errorChain(error);
  if (chain.length === 0) return false;
  if (chain.some((current) => current.code === BLOCKED_ADDRESS_CODE) || isRedirectRefusal(error)) return false;

  const status = chain.find((current) => Number.isFinite(Number(current.status)))?.status;
  if (status != null) {
    const numericStatus = Number(status);
    return numericStatus === 429 || (numericStatus >= 500 && numericStatus <= 599);
  }

  if (chain.some((current) => current.name === 'AbortError' || TRANSPORT_ERROR_CODES.has(current.code)
    || (typeof current.code === 'string' && current.code.startsWith('UND_ERR_')))) return true;
  if (error instanceof SyntaxError || error instanceof RangeError || error instanceof URIError) return false;

  // fetch implementations and provider mocks commonly expose statusless
  // transport failures as a plain Error or TypeError with no stable code.
  return error instanceof Error;
}

function normalizeRetryPolicy(policy = {}) {
  const retries = intInRange(policy.retries ?? policy.maxRetries, DEFAULT_RETRY_POLICY.retries, 0, 10);
  const baseDelayMs = intInRange(policy.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs, 0, 60_000);
  const maxDelayMs = intInRange(policy.maxDelayMs, DEFAULT_RETRY_POLICY.maxDelayMs, 0, 60_000);
  const maxRetryAfterMs = intInRange(policy.maxRetryAfterMs, DEFAULT_RETRY_POLICY.maxRetryAfterMs, 0, 60_000);
  const jitter = Number(policy.jitterRatio);
  const jitterRatio = Number.isFinite(jitter) ? Math.min(1, Math.max(0, jitter)) : DEFAULT_RETRY_POLICY.jitterRatio;
  return { retries, baseDelayMs, maxDelayMs, maxRetryAfterMs, jitterRatio };
}

function retryDelayMs(error, retryIndex, ctx, policy) {
  const retryAfter = parseRetryAfterMs(error?.retryAfter);
  if (retryAfter != null) return Math.min(retryAfter, policy.maxRetryAfterMs);
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** retryIndex));
  const random = typeof ctx?.random === 'function' ? ctx.random() : Math.random();
  const factor = 1 + (((Number.isFinite(random) ? random : 0.5) * 2) - 1) * policy.jitterRatio;
  return Math.max(0, Math.min(policy.maxDelayMs, Math.round(exponential * factor)));
}

async function fetchWithRetry(kind, ctx, url, opts, rawPolicy) {
  const request = typeof ctx?.[kind] === 'function' ? ctx[kind].bind(ctx) : (kind === 'fetchJson' ? fetchJson : fetchText);
  const policy = normalizeRetryPolicy(rawPolicy);
  for (let attempt = 0; ; attempt++) {
    try {
      return await request(url, opts);
    } catch (error) {
      if (attempt >= policy.retries || !isRetryableError(error)) throw error;
      await sleep(retryDelayMs(error, attempt, ctx, policy), ctx);
    }
  }
}

export function fetchJsonWithRetry(ctx, url, opts = {}, policy = {}) {
  return fetchWithRetry('fetchJson', ctx, url, opts, policy);
}

export function fetchTextWithRetry(ctx, url, opts = {}, policy = {}) {
  return fetchWithRetry('fetchText', ctx, url, opts, policy);
}

export function makeHttpCtx() {
  return {
    transport: 'http',
    fetchJson,
    fetchText,
  };
}
