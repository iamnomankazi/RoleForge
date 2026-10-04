"use client";

import { Lock } from "lucide-react";

// The legacy web Apply CTA remains visible in report action slots only as an
// inert, disabled marker. Posting/report/listing links remain read-only.
export function ApplyButton({ n, url, company, pdfReady }: { n: string; url?: string; company: string; pdfReady: boolean }) {
  // Keep the report action slot visible for discoverability, but make it a
  // genuinely inert control. Posting/report/listing links remain available.
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      className="inline-flex cursor-not-allowed items-center justify-center gap-1.5 rounded-full border border-border bg-surface/40 px-3.5 py-1 text-xs font-medium text-faint max-sm:min-h-[44px]"
      title="Web Apply is disabled; use the private root application engine"
    >
      <Lock className="size-3.5" /> Apply unavailable
    </button>
  );
}
