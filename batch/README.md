# Batch Processing

Batch evaluation runs through the external **Hybrid Workflow** orchestrator. An Opus session plans and integrates the batch; Codex workers each evaluate one offer in an isolated git worktree. The worker prompt remains in `batch/batch-prompt.md`.

## Quick Start

1. **Collect offers** in `batch/batch-input.tsv` (tab-separated: `id`, `url`, `source`, `notes`).
2. **Reserve report numbers in the main workspace before starting N jobs:**

   ```bash
   node reserve-report-num.mjs --count N
   ```

   Assign each worker one reserved number. Never let workers compute `max+1` independently: isolated worktrees do not share reservation sentinels.
3. **Run Hybrid Workflow**, one job per offer. Supply the URL, JD text or file, reserved report number, date, and offer ID using `batch/batch-prompt.md`.
4. **Integrate worker artifacts** into the main workspace: reports in `reports/`, PDFs in `output/`, and one tracker TSV per offer in `batch/tracker-additions/{num}-{company-slug}.tsv`. These outputs are gitignored, so transfer them explicitly from each worktree.
5. **Merge and verify** in the main workspace:

   ```bash
   node merge-tracker.mjs
   node reserve-report-num.mjs --release {reserved-range}
   node verify-pipeline.mjs
   ```

   Release reservations after reports have been integrated. If the coordinator maintains `batch-state.tsv`, run `node reconcile-pipeline.mjs` after the tracker merge to reconcile completed/skipped offers out of the pipeline inbox.

## Directory Layout

```text
batch/
  batch-prompt.md          # Worker evaluation prompt
  batch-input.tsv          # Input offers (you create this)
  batch-state.tsv          # Optional coordinator-maintained progress
  logs/                    # Per-offer worker logs
  tracker-additions/       # TSV lines produced by workers
    merged/                # TSVs already merged into applications.md
```

## Tracker Merge

Workers write one TSV per offer to `batch/tracker-additions/`. After integration, `node merge-tracker.mjs` handles:

- Deduplication by company + role fuzzy match and report number
- Column order conversion (TSV has status before score; applications.md has score before status)
- In-place updates when a re-evaluation scores higher than the existing entry
- Moving processed TSVs to `tracker-additions/merged/`

## Recovery

Hybrid Workflow owns scheduling, worker logs, retries, and resume. Review completed artifacts before retrying a failed or interrupted job; preserve its assigned report number and avoid re-evaluating completed offers. Reconciliation is available when the coordinator records the compatible `batch-state.tsv` format; it is not automatic.

## Prerequisites

- External Hybrid Workflow orchestrator with Opus planning/integration and Codex workers
- Node.js >= 18 and Playwright Chromium for PDF generation
- Candidate inputs available in each worker worktree
- One offer and one reserved report number per worker
