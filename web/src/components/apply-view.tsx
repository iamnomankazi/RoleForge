"use client";

import Link from "next/link";
import { ArrowLeft, Lock } from "lucide-react";

/** Compatibility-only replacement for the retired legacy Apply form proxy. */
export function ApplyView() {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-8">
      <div className="flex items-center gap-3">
        <Lock className="size-5 text-faint" />
        <h2 className="font-display text-xl tracking-tight text-landing">Web Apply unavailable</h2>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        The legacy web Apply form is disabled and cannot open a browser, fill or upload application data, invoke an AI
        apply driver, or perform a final action.
      </p>
      <Link href="/pipeline" className="mt-4 inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
        <ArrowLeft className="size-4" /> Back to pipeline
      </Link>
    </div>
  );
}
