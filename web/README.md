# RoleForge web (alpha)

An **experimental, opt-in web UI** for RoleForge. It is a local-first *view* over
the exact same files the CLI reads and writes (`data/pipeline.md`,
`data/applications.md`, `reports/`, `config/`): no parallel engine, no separate
database, no server. If you never run it, nothing about your CLI workflow changes.

> **Inherited upstream context:** the following discussions describe Career Ops development. RoleForge has no configured remote support endpoint.
> **Status: alpha.** Expect rough edges. Upstream feedback →
> [Discussion #1142](https://github.com/santifer/career-ops/discussions/1142) ·
> roadmap context → [Discussion #156](https://github.com/santifer/career-ops/discussions/156).

## Quick start

Requires Node 20+.

```bash
cd web
npm ci
npm run dev
```

Open http://localhost:3000. The app reads the RoleForge checkout it lives in
(the parent directory) — your existing CV, pipeline and reports appear as-is.

## What works today

- **Pipeline** — your tracker as a sortable, filterable table; status changes
  write back through the core's own scripts.
- **Explore** — the free reverse-ATS scan with an honest partial-dataset
  indicator, plus AI-assisted discovery (bring your own CLI/keys).
- **Apply** — the legacy web Apply executor is retired in Phase 1A. The route is
  read-only and reports still expose their original posting links.
- **Today / Analytics / CV / Config** — action queue, funnel, CV editing with
  preview, settings.

## Safety

- **Local-first:** the local web app runs entirely on your machine — no cloud,
  no account needed. Your CV and data stay in your own files.
- **Legacy Apply is fail-closed:** `/api/apply/session`, `/api/apply/prefill`,
  `/api/apply/fill`, and `/api/apply/drive` return a terminal disabled response
  and cannot launch a browser,
  mutate a form, upload files, invoke an AI driver, or perform a final action.
- **Future authority seam:** any later web bridge must provide the exact
  `batch_id`, exact `candidate_id`, immutable `manifest_scope_hash`, successful
  preflight, and approved artifact hashes before handing off to the private root
  application engine. That bridge is not implemented here.
- **Additive:** the web is isolated from the core's packaging, CI and release
  automation. The CLI works exactly the same without it.

## Development

```bash
npm run dev          # dev server (Turbopack)
npx tsc --noEmit     # typecheck
npm run build        # production build
```

Set `CAREER_OPS_ROOT=/path/to/checkout` in `web/.env.local` to point the app at
a different RoleForge directory (useful for testing against sample data).
