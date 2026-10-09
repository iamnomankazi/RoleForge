# Mode: batch — Mass Processing of Jobs

<!-- APPLICATION_BATCH_AUTHORITY_V1 -->

Batch evaluation never grants application authority. Any later browser work
must use an immutable application-batch manifest and one exact candidate ID;
never promote by rank, first-N, global queue, or hard-coded targets.
Standard and worker-merge scans both produce the same immutable canonical run;
`output/apply-queue.csv` remains a non-authoritative review artifact.

## Architecture

Batch evaluation runs through the external **Hybrid Workflow** orchestrator:

```text
Opus session: collect offers → reserve report numbers → plan jobs
  ├─ Codex worker: one offer, isolated git worktree → report + PDF + tracker TSV
  ├─ Codex worker: one offer, isolated git worktree → report + PDF + tracker TSV
  └─ Opus session: integrate artifacts → merge tracker → verify + summary
```

The coordinator owns scheduling, retries, and recovery. Keep `batch/batch-prompt.md` as the worker evaluation prompt. Each job receives one offer URL, JD text or file, reserved report number, date, and offer ID.

## Procedure

1. **Collect offers** from already gathered URLs or portal discovery into `batch/batch-input.tsv`. If a JD is behind login, capture its text in an authorized browser session before handing it to the worker.
2. **Reserve N report numbers in the main workspace immediately before starting jobs:**

   ```bash
   node reserve-report-num.mjs --count N
   ```

   Hand each worker its own number. Never let parallel workers compute `max+1`; isolated worktrees do not share sentinels.
3. **Run Hybrid Workflow**, one job per offer in an isolated git worktree. Make the candidate inputs and `batch/batch-prompt.md` available in each worktree.
4. **Workers produce** a report in `reports/`, a PDF in `output/`, and one TSV in `batch/tracker-additions/{num}-{company-slug}.tsv`. Workers do not merge the shared tracker.
5. **Integrate outputs** into the main workspace. Reports, PDFs, and tracker additions are gitignored, so copy these artifacts explicitly from each worktree.
6. **Merge tracker additions once after integration:**

   ```bash
   node merge-tracker.mjs
   ```

7. **Release the reserved range after reports are integrated**, then verify integrity:

   ```bash
   node reserve-report-num.mjs --release {reserved-range}
   node verify-pipeline.mjs
   ```

   If the coordinator maintains compatible `batch/batch-state.tsv` entries, run `node reconcile-pipeline.mjs` after the merge to move completed/skipped offers from the pipeline inbox to processed entries.

## Reservation Rules

- **4-hour protection window.** Stale sentinels are garbage-collected. Reserve immediately before launching jobs; recheck unfilled reservations if a batch takes longer than four hours.
- **Gaps are normal.** Collision restarts can leave unused numbers. Report numbers are opaque IDs; a gap is not corruption.
- **Retries preserve assignments.** Inspect completed artifacts before retrying a job, and retain its reserved report number.

## Parallel Discovery Scans

For parallel discovery scans before evaluation, do not reserve report numbers
and do not let workers write to `data/pipeline.md` or the canonical apply queue.
Give every worker a separate JSON output path, then merge once with
`node merge-scan-results.mjs --run-id {unique-run-id} <worker-files...>`. Review
the merged candidates deterministically and verify liveness before promoting a
small set into evaluation. This keeps discovery parallel while all mutable
pipeline writes remain single-writer operations.

## Recovery

Hybrid Workflow owns worker state and logs. A failed job does not block other offers. For inaccessible URLs or login-protected JDs, obtain the missing input before retrying. If PDF generation fails, retain the report and mark the PDF pending. After interruption or rate limits, resume only unfinished jobs once the underlying problem is resolved.

See `batch/README.md` for input format and artifact layout.
