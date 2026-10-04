// Pure configuration helpers shared by providers.

/**
 * Coerce a provider configuration value to a bounded integer.
 *
 * Finite values are truncated toward zero before clamping. Non-finite values
 * fall back to `def` unchanged so callers retain control of their default.
 */
export function intInRange(value, def, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return def;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}
