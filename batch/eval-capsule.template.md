# Evaluation capsule template

Reusable instructions for one evaluation worker (any agent CLI, or a Hybrid Workflow job). The
deterministic selection of what to evaluate is done first by `eval-queue.mjs`; this template only covers
the LLM evaluation of candidates the queue put in `include`. It contains no personal data: candidate
facts are read at run time from the user-layer files named below.

Fill the placeholders before use:

| Placeholder | Meaning |
|---|---|
| `{{ROLEFORGE_ROOT}}` | Absolute path of the RoleForge checkout that holds the user-layer files |
| `{{INPUT_FILE}}` | JSON array of the offers for this job, built from `eval-queue.mjs` `include` entries only. Never add `needs_liveness` entries: re-check their liveness (`candidate-liveness.mjs`) and rebuild the queue first |
| `{{REPORT_NUMBERS}}` | Report numbers reserved with `node reserve-report-num.mjs --count N`, one per offer, in input order |
| `{{DATE}}` | Date written into report file names and headers (YYYY-MM-DD) |
| `{{OUT_DIR}}` | Output folder inside the worker's own workspace (for example `eval-out`) |

Each input offer carries: `report_num`, `candidate_id`, `company`, `title`, `location`, `url`, `run_dir`,
`description_sha256`, `liveness` (the queue's evidence record: `status`, `source`, `checked_at`),
`prescreen` (flags and experience metadata from `prescreenJob`), and `possible_duplicates` (weak duplicate
evidence; mention it in the report, never treat it as a blocker). The job description is the
`description` field of the record with that `candidate_id` in `{{run_dir}}/candidates.json`; its SHA-256
must equal `description_sha256`.

---

## Goal
Write one evidence-based evaluation report and one tracker TSV line for each offer in `{{INPUT_FILE}}`,
following `batch/batch-prompt.md` with the overrides below. This is assessment only: the candidate decides
later which roles to apply for.

## Context
- Candidate sources live in the user layer and are read-only for this job:
  `{{ROLEFORGE_ROOT}}/cv.md` (canonical claims), `{{ROLEFORGE_ROOT}}/config/profile.yml` (identity, work
  authorisation, location and experience policy, graduation date), `{{ROLEFORGE_ROOT}}/modes/_profile.md`
  (archetypes, framing, scoring), `{{ROLEFORGE_ROOT}}/article-digest.md` if present (proof points),
  `{{ROLEFORGE_ROOT}}/voice-dna.md` if present (style only, never facts).
- System files: `modes/_shared.md`, `batch/batch-prompt.md`, `assessment-contract.mjs`.
- The deterministic pre-screen found no hard blocker for these offers. It is a floor, not a guarantee:
  judge the full description.

## Overrides to batch/batch-prompt.md (binding)
1. Description: use only the stored description identified above. Verify its SHA-256 first. No web
   fetch, no web search, no network. If it is missing, does not match the hash or is unusable, still write
   the report with `confidence: "Low"` and a review reason saying the description could not be read.
2. No PDF and no other documents. Header `**PDF:** not generated`; tracker PDF column `❌`.
3. Compensation and demand: the description's own figures only; `advertised_comp` verbatim or null.
4. Liveness gate (check first, for every offer): evaluate only offers whose input `liveness.status` is
   `active`, and write `confirmed` for them. For any other status, write no report and no TSV for that
   offer and list it in the final report as `not evaluated: liveness not confirmed`.
5. Merge pre-screen flags (for example `sponsorship_unknown`, `language_preferred`, `experience_stretch`)
   into `flags` with their evidence. Add blockers found in the description with quoted evidence, using only
   the allowed codes. Silence about sponsorship is never a blocker; reject on work authorisation only on an
   explicit restriction, using the work-authorisation facts in `profile.yml`.
6. Candidate facts come only from the user-layer files above. Never invent experience, metrics, seniority
   or authorship; using a tool is not authorship. State gaps honestly. `fit_score` is technical and profile
   fit only and is never lowered for blockers.
7. Prose in English; keep the header field names and section headings exactly as in the prompt template.
   `**URL:**` is the input `url`; add `**Candidate ID:** {candidate_id}` right after `**URL:**`. Name any
   `possible_duplicates` in the report body with their tracker row or report number.
8. Output paths, inside the worker's workspace only:
   - `{{OUT_DIR}}/reports/{report_num}-{company-slug}-{{DATE}}.md`
   - `{{OUT_DIR}}/tracker-additions/{report_num}-{company-slug}.tsv` - status `Evaluated`,
     `{report_num}` as number, report link root-relative:
     `[{report_num}](reports/{report_num}-{company-slug}-{{DATE}}.md)`.
9. Validate every report: parse it with `parseReportMachineSummary` and check it with
   `validateMachineSummary` from `assessment-contract.mjs` (a one-off script, deleted afterwards); copy the
   derived action into `**Action:**`. Fix and re-validate until valid.

## Acceptance criteria
- Exactly one valid report and one TSV per input offer with `active` liveness, with the given report numbers;
  every other offer listed as not evaluated.
- Every blocker and flag has quoted evidence; every `review` action has a one-line review reason.
- Nothing written outside `{{OUT_DIR}}`; nothing written to `{{ROLEFORGE_ROOT}}`.

## Offers for this job
Input file (read-only): `{{INPUT_FILE}}`
Report numbers: {{REPORT_NUMBERS}}

## Final report
Concise: per offer `report_num | company | role | fit_score | derived action | blocker codes`, plus any
offer whose description was unusable.

---

After the job: copy the reports and TSV files into `reports/` and `batch/tracker-additions/`, run
`node merge-tracker.mjs`, then `node verify-pipeline.mjs`. Release unused report numbers (including those of offers not evaluated) with
`node reserve-report-num.mjs --release <range>`.
