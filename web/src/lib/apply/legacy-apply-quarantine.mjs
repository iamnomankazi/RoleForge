/**
 * Phase 1A: the legacy web Apply surface is intentionally unavailable.
 *
 * This module is deliberately dependency-free.  The quarantined route handlers
 * must import only this module so importing or calling a route cannot load the
 * old Playwright session, field-fill, upload, or AI-driver code.
 */

export const LEGACY_APPLY_QUARANTINE = Object.freeze({
  code: "legacy-web-apply-disabled",
  status: 410,
  authority: "private-root-application-engine",
  futureBridge: Object.freeze({
    status: "not-implemented",
    fields: Object.freeze({
      batch_id: "exact",
      candidate_id: "exact",
      manifest_scope_hash: "immutable",
      preflight: "successful",
      approved_artifact_hashes: "approved",
    }),
    required: Object.freeze([
      "exact batch_id",
      "exact candidate_id",
      "immutable manifest hash",
      "successful preflight",
      "approved artifact hashes",
    ]),
    handoff: "private-root-application-engine",
  }),
});

/**
 * Return the same terminal response for every legacy web Apply endpoint.
 * There is intentionally no request parsing, filesystem access, browser
 * access, subprocess, AI provider, form mutation, or final-action handling.
 */
export function legacyApplyQuarantineResponse(endpoint) {
  const safeEndpoint = typeof endpoint === "string" && endpoint.startsWith("/api/apply/") ? endpoint : "/api/apply";
  return Response.json(
    {
      ok: false,
      code: LEGACY_APPLY_QUARANTINE.code,
      endpoint: safeEndpoint,
      authority: LEGACY_APPLY_QUARANTINE.authority,
      error:
        "Legacy web Apply execution is disabled. This endpoint cannot open a browser, fill or upload application data, invoke an AI apply driver, or perform a final application action.",
      futureBridge: LEGACY_APPLY_QUARANTINE.futureBridge,
    },
    {
      status: LEGACY_APPLY_QUARANTINE.status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
