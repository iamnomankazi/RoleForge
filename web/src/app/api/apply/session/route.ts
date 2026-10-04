import { legacyApplyQuarantineResponse } from "@/lib/apply/legacy-apply-quarantine.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Legacy URL-driven browser/session authority: permanently fail closed. */
export function POST() {
  return legacyApplyQuarantineResponse("/api/apply/session");
}
