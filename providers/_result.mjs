// Structured, backward-compatible metadata for provider fetch results.
// Providers still return arrays; metadata is non-enumerable so existing loops,
// serializers, and Array.isArray() checks continue to behave exactly as before.

const PROVIDER_COVERAGE = Symbol.for('career-ops.provider-coverage');

export function markProviderCoverage(jobs, coverage) {
  if (!Array.isArray(jobs)) throw new TypeError('provider coverage can only be attached to a jobs array');
  if (!coverage || coverage.status !== 'partial') {
    throw new TypeError('provider coverage status must be "partial"');
  }
  const normalized = Object.freeze({
    status: 'partial',
    code: String(coverage.code || 'partial'),
    reason: String(coverage.reason || 'Provider returned partial coverage'),
    ...(Number.isInteger(coverage.pagesFetched) ? { pagesFetched: coverage.pagesFetched } : {}),
    ...(Number.isInteger(coverage.maxPages) ? { maxPages: coverage.maxPages } : {}),
    ...(Number.isInteger(coverage.totalPages) ? { totalPages: coverage.totalPages } : {}),
  });
  Object.defineProperty(jobs, PROVIDER_COVERAGE, { value: normalized, enumerable: false });
  return jobs;
}

export function providerCoverage(jobs) {
  if (!Array.isArray(jobs)) return null;
  const structured = jobs[PROVIDER_COVERAGE];
  if (structured?.status === 'partial') return structured;
  // Compatibility with providers that predate the typed coverage contract.
  if (jobs.providerDegraded) {
    return {
      status: 'partial',
      code: 'provider_degraded',
      reason: String(jobs.providerDegradedReason || 'Provider returned a partial result'),
    };
  }
  return null;
}
