import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LEGACY_APPLY_QUARANTINE, legacyApplyQuarantineResponse } from "../web/src/lib/apply/legacy-apply-quarantine.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(resolve(ROOT, relative), "utf8");

const ROUTES = {
  session: "web/src/app/api/apply/session/route.ts",
  prefill: "web/src/app/api/apply/prefill/route.ts",
  fill: "web/src/app/api/apply/fill/route.ts",
  drive: "web/src/app/api/apply/drive/route.ts",
};

const EXECUTION_IMPORTS = /node:child_process|playwright|@\/lib\/apply\/(?:session|drive|diagnose|agent-interpret|extract|cv)|(?:openSession|fillSession|driveSession|finalizeDrivenSession|handoffSession|setInputFiles|requestSubmit|submit\s*\()/i;

test("every legacy web Apply route is a dependency-light fail-closed boundary", async () => {
  for (const [name, relative] of Object.entries(ROUTES)) {
    const source = read(relative);
    assert.match(source, /legacyApplyQuarantineResponse/, name);
    assert.match(source, /export function POST\(\)/, name);
    assert.doesNotMatch(source, EXECUTION_IMPORTS, name);

    const response = legacyApplyQuarantineResponse(`/api/apply/${name}`);
    assert.equal(response.status, 410, name);
    assert.equal(response.headers.get("cache-control"), "no-store", name);
    const body = await response.json();
    assert.equal(body.ok, false, name);
    assert.equal(body.code, LEGACY_APPLY_QUARANTINE.code, name);
    assert.equal(body.endpoint, `/api/apply/${name}`, name);
    assert.match(body.error, /disabled/i, name);
    assert.match(body.error, /browser/i, name);
    assert.match(body.error, /fill|upload/i, name);
    assert.match(body.error, /AI/i, name);
    assert.match(body.error, /final application action/i, name);
  }
});

test("the quarantine response exposes a documented future authority seam without implementing it", () => {
  assert.equal(LEGACY_APPLY_QUARANTINE.authority, "private-root-application-engine");
  assert.equal(LEGACY_APPLY_QUARANTINE.futureBridge.status, "not-implemented");
  assert.deepEqual(LEGACY_APPLY_QUARANTINE.futureBridge.fields, {
    batch_id: "exact",
    candidate_id: "exact",
    manifest_scope_hash: "immutable",
    preflight: "successful",
    approved_artifact_hashes: "approved",
  });
  assert.deepEqual(LEGACY_APPLY_QUARANTINE.futureBridge.required, [
    "exact batch_id",
    "exact candidate_id",
    "immutable manifest hash",
    "successful preflight",
    "approved artifact hashes",
  ]);
  assert.equal(LEGACY_APPLY_QUARANTINE.futureBridge.handoff, "private-root-application-engine");
});

test("the Apply page is read-only and no longer mounts the legacy execution UI", () => {
  const page = read("web/src/app/apply/page.tsx");
  assert.doesNotMatch(page, /ApplyView|ApplyBackdropMount|useApply|fetch\s*\(/);
  assert.match(page, /Web Apply unavailable/);
  assert.match(page, /read-only/);
  assert.match(page, /cannot open a browser/);
  assert.match(page, /batch_id/);
  assert.match(page, /candidate_id/);

  const shell = read("web/src/components/app-shell.tsx");
  assert.doesNotMatch(shell, /ApplyProvider|ApplyView|ApplyBackdropMount/);

  const provider = read("web/src/components/apply/apply-provider.tsx");
  assert.doesNotMatch(provider, /fetch\s*\(|playwright|child_process|setInputFiles|fillSession|driveSession|spawn\s*\(/i);
  assert.match(provider, /action is a no-op/i);

  const compatibilityView = read("web/src/components/apply-view.tsx");
  assert.doesNotMatch(compatibilityView, /fetch\s*\(|onClick|setInputFiles|fillSession|driveSession|submit\s*\(/i);
  assert.match(compatibilityView, /Web Apply unavailable/);

  const registry = read("web/src/app/actions/registry.ts");
  assert.doesNotMatch(registry, /startApply|setApplyField|\bapply:\s*\{/);
  const assistant = read("web/src/components/assistant-console.tsx");
  assert.doesNotMatch(assistant, /useApply|startApply|setApplyField|applyRef|applyContext|\/api\/apply/);
  assert.match(assistant, /legacy web Apply executor is disabled/i);

  const assistantRoute = read("web/src/app/api/assistant/route.ts");
  assert.match(assistantRoute, /apply \/ setApplyField — unavailable/i);
  assert.match(assistantRoute, /do not emit apply or setApplyField actions/i);
  assert.doesNotMatch(assistantRoute, /apply form-proxy|open the apply form|write or revise an answer/i);
});

test("report Apply control is inert while read-only posting/report links remain available", () => {
  const button = read("web/src/components/apply-button.tsx");
  assert.match(button, /<button[\s\S]*disabled/);
  assert.match(button, /Apply unavailable/);
  assert.doesNotMatch(button, /onClick|fetch\s*\(|router|useApply|apply\.open|\/api\/apply/);
  assert.doesNotMatch(button, /setInputFiles|fillSession|driveSession|submit\s*\(/i);

  const report = read("web/src/components/report-view.tsx");
  assert.match(report, /href=\{url\}/);
  assert.match(report, /posting/);
});
