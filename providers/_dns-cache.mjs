import dns from 'node:dns';
import { getProviderIpGuardContext, validateLookupResult } from './_ip-guard.mjs';

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

  function deliver(waiter, args) {
    const [error, ...rest] = args;
    if (!error && waiter.guardContext) {
      try {
        validateLookupResult(waiter.hostname, rest, waiter.guardContext);
      } catch (guardError) {
        waiter.callback(guardError);
        return;
      }
    }
    waiter.callback(error, ...rest);
  }

  function lookup(hostname, rawOptions, rawCallback) {
    const callback = typeof rawOptions === 'function' ? rawOptions : rawCallback;
    const opts = typeof rawOptions === 'function' ? {} : (typeof rawOptions === 'number' ? { family: rawOptions } : (rawOptions ?? {}));
    const key = `${hostname}|${opts.family ?? 0}|${opts.all ? 1 : 0}|${opts.hints ?? 0}|${opts.verbatim ?? ''}`;
    const waiter = { callback, guardContext: getProviderIpGuardContext(), hostname };
    const cached = cache.get(key);
    if (cached && cached.expires > now()) {
      process.nextTick(() => deliver(waiter, cached.args));
      return;
    }
    if (inflight.has(key)) {
      inflight.get(key).push(waiter);
      return;
    }
    inflight.set(key, [waiter]);
    realLookup(hostname, opts, (error, ...rest) => {
      const waiters = inflight.get(key) || [];
      inflight.delete(key);
      let guardPassed = true;
      if (!error) {
        const guardedWaiter = waiters.find((entry) => entry.guardContext);
        if (guardedWaiter) {
          try {
            validateLookupResult(hostname, rest, guardedWaiter.guardContext);
          } catch {
            guardPassed = false;
          }
        }
      }
      const ttl = error
        ? (isResolverFailure(error) ? negativeTtlMs : 0)
        : (guardPassed ? ttlMs : 0);
      if (ttl > 0) {
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
        cache.set(key, { expires: now() + ttl, args: error ? [error] : [null, ...rest] });
      }
      const args = error ? [error] : [null, ...rest];
      for (const waiting of waiters) deliver(waiting, args);
    });
  }
  for (const symbol of Object.getOwnPropertySymbols(realLookup)) lookup[symbol] = realLookup[symbol];
  return lookup;
}

if (process.env.CAREER_OPS_NO_DNS_CACHE !== '1') dns.lookup = createCachedLookup(dns.lookup);
