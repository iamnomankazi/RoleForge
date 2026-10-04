import Link from "next/link";
import { Lock, ArrowLeft } from "lucide-react";

export const dynamic = "force-dynamic";

export default function ApplyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
        <ArrowLeft className="size-4" /> Pipeline
      </Link>
      <div className="mt-6 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-8">
        <div className="flex items-center gap-3">
          <Lock className="size-6 text-faint" />
          <h1 className="font-display text-2xl tracking-tight text-landing">Web Apply unavailable</h1>
        </div>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
          The legacy web Apply execution path is disabled. This page is read-only: it cannot open a browser, read or fill
          an application form, upload files, invoke an AI apply driver, or perform a final application action.
        </p>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
          Use the private root application engine for any future execution. A future web bridge must prove an exact
          <code className="mx-1 text-foreground">batch_id</code>, exact <code className="mx-1 text-foreground">candidate_id</code>, immutable
          <code className="mx-1 text-foreground">manifest_scope_hash</code>, successful preflight, and approved artifact hashes before handoff.
        </p>
      </div>
    </div>
  );
}
