import dns from 'node:dns';

export const RESOLVER_FAILURE_CODES = new Set(['ENOTIMP', 'EREFUSED', 'ESERVFAIL', 'EAI_AGAIN']);

export function isResolverFailure(error) {
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 5; current = current.cause, depth++) {
    if (RESOLVER_FAILURE_CODES.has(current.code)) return true;
  }
  return false;
}

export function createCachedLookup(realLookup, options = {}) {
  const ttlMs = options.ttlMs ?? 300_000;
  const negativeTtlMs = options.negativeTtlMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 512;
  const now = options.now ?? Date.now;
  const cache = new Map();
  const inflight = new Map();

  function lookup(hostname, rawOptions, rawCallback) {
    const callback = typeof rawOptions === 'function' ? rawOptions : rawCallback;
    const opts = typeof rawOptions === 'function' ? {} : (typeof rawOptions === 'number' ? { family: rawOptions } : (rawOptions ?? {}));
    const key = `${hostname}|${opts.family ?? 0}|${opts.all ? 1 : 0}|${opts.hints ?? 0}|${opts.verbatim ?? ''}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) {
      process.nextTick(callback, ...cached.args);
      return;
    }
    if (inflight.has(key)) {
      inflight.get(key).push(callback);
      return;
    }
    inflight.set(key, [callback]);
    realLookup(hostname, opts, (error, ...rest) => {
      const callbacks = inflight.get(key) || [];
      inflight.delete(key);
      const ttl = error ? (isResolverFailure(error) ? negativeTtlMs : 0) : ttlMs;
      if (ttl > 0) {
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
        cache.set(key, { expires: now() + ttl, args: error ? [error] : [null, ...rest] });
      }
      for (const waiting of callbacks) waiting(error, ...rest);
    });
  }
  for (const symbol of Object.getOwnPropertySymbols(realLookup)) lookup[symbol] = realLookup[symbol];
  return lookup;
}

if (process.env.CAREER_OPS_NO_DNS_CACHE !== '1') dns.lookup = createCachedLookup(dns.lookup);
