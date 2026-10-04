# Mode: apply — Live Application Assistant

> Apply `voice-dna.md` (if present) to free-text answers and cover-letter fields — full guardrail, conversational voice included (Tier 1 + Tier 2). See `_shared.md` → Voice DNA.

Interactive drafting mode for a candidate already selected in an immutable
application batch. Browser navigation belongs only to the batch executor's
task-created browser; otherwise the user may paste questions or screenshots for
draft-only help.

## Requirements

- **Best with Playwright in visible mode**: In visible mode, the candidate sees the browser and the agent can interact with the page.
- **Without Playwright**: the candidate shares a screenshot or pastes the questions manually.

<!-- APPLICATION_BATCH_AUTHORITY_V1 -->
## Run-scoped application batches (Phase 4 authority)

When the user ties application work to an immutable scan run, the run-scoped
batch manifest is the only application authority. Never resolve phrases such as
"the remaining roles" against `output/apply-queue.csv`, a hard-coded packet
list, an old browser session, or another scan run.

1. Create the batch from the explicit source run and exact candidate IDs. IDs
   are preferred; exact run URLs remain a backward-compatible selector:
   `node application-batch.mjs create --source-run <run-id> --batch-id <batch-id> --candidate-id <id> [--candidate-id <id> ...]`
2. Create an exact document plan from the immutable candidate JD (or one exact
   local JD file), review its digest, then generate and atomically bind the
   approved CV plus the separate PDF/text cover letter:
   `node application-documents.mjs plan --manifest <manifest> --candidate-id <id> [--jd-file <exact-local-JD>]`
   `node application-documents.mjs prepare --manifest <manifest> --candidate-id <id> --plan <plan.json> --confirm-plan <plan-hash>`
3. Preview the complete scope without opening a browser:
   `node application-batch.mjs preflight --manifest output/application-batches/<batch-id>/manifest.json`
4. Stop for explicit user confirmation. Only after confirmation, bind it to the
   exact batch by repeating its ID:
   `node application-batch.mjs preflight --manifest <manifest> --confirm-batch <batch-id>`
5. Execute exactly one manifest candidate per invocation:
   `node application-browser-executor.mjs --manifest <manifest> --candidate-id <exact-id>`
   Or prepare up to six already-confirmed one-candidate batches in one shared
   visible browser, in the exact repeated-argument order:
   `node application-shared-browser.mjs --batch-id <batch-1> [--batch-id <batch-2> ...]`

If login is required, resume only that same candidate and revalidate it:
`node application-browser-executor.mjs --manifest <manifest> --candidate-id <exact-id> --resume-login`.
If a grounded answer or supported control required review, resume only the same
candidate after resolving it with `--resume-preparation`; the executor repeats
all source, artifact, liveness, identity, and form checks from scratch.

Historical queues are not application authority. Import explicitly selected
legacy rows only with `node legacy-queue-importer.mjs --queue-file <exact.csv>
--source-run <run-id> --batch-id <id> --row <csv-row> [...]`. Imported rows
remain `legacy_unverified` until fresh liveness and identity verification.

The executor fails closed if the manifest, source run, preflight confirmation,
or exact candidate membership is missing, or if any source/manifest/document
hash changes. Rebinding an artifact invalidates confirmation and requires a new
preflight approval. It never falls back to the global
queue. The single-candidate command never opens the next candidate. The shared
coordinator preallocates one isolated tab for each exact one-candidate batch,
executes those tabs sequentially, and leaves all task tabs and the task-created
browser open for review. It may revalidate and resume the exact same candidate
from `blocked`, `review_required`, or `actual_form_reached`; interactive login
resume remains a standalone single-candidate operation. Neither
entrypoint touches pre-existing user tabs,
and never clicks a final Submit, Send, or Apply control. The locked Phase 4
executor alone records progress states. There is no generic state-attestation
command and neither an agent nor a user can declare `form_prepared` without the
stored whole-form review evidence. It fills supported grounded fields, commits
real dropdown/autocomplete options, verifies exact uploads, re-inspects
conditional fields, and stops at `review_required`, `login_required`, or
`form_prepared`. This batch state is separate from the tracker. Screenshots and pasted questions without a batch are draft-only;
they never authorize browser interaction, artifact attachment, submission
state, or tracker updates.

A listing-page `Apply` control is an entry action, not automatically a final
submission. The executor may click it only from `listing_verified`, before
candidate fields are present, when DOM/form method and destination checks prove
it cannot submit candidate data. It may traverse one verified known-ATS
intermediate page. Once the actual form is reached, Apply/Submit/Send/Complete
controls remain prohibited regardless of their visible label.

## Workflow

```text
1. DETECT      → Read the selected candidate's task-created page, or accept pasted content for draft-only help
2. IDENTIFY    → Extract company + role from the page
3. SEARCH      → Match against existing reports in reports/
4. LOAD        → Read full report + Section H / Application Answers (if they exist)
5. PREFLIGHT   → Confirm posting liveness + company/role match before drafting
5b. PRE-SCAN   → Scan page for knock-out questions (degree, experience, work authorization/visa, sponsorship, salary floors)
6. ANALYZE     → Identify ALL visible form questions
7. GENERATE    → For each question, generate a personalized response
8. PRESENT     → Show formatted responses for copy-paste
9. PERSIST     → Save the final filled/submitted answers into the report
```

## Step 5 — Preflight gate

Before generating any application answers, verify that the form still points to the intended active job. This gate runs after the page has been detected, the company/role has been identified, and the matching report has been loaded.

**Cross-channel check (#1596):** before drafting — and ALWAYS before the user authorizes an agency to submit on their behalf — check `data/applications.md` for an existing row with the same company+role under a different Via (agency vs direct, or two agencies). A double submission burns the candidate with both the agency and the employer. If found, stop and ask the user which channel owns the candidacy. If the end employer is still unknown (Company `?`), the check still runs in degraded form — it is never silently skipped:

1. Ask the user (or the recruiter, via the user) for the client company name first — the reveal is the cheapest fix and unlocks the full check.
2. If the name is not available, check the tracker for `?` rows with the same Via + a similar role (the same agency re-blasting one listing) and for similar-role rows at plausible-match companies; surface anything close.
3. Then STOP and require explicit user acknowledgment before the agency is authorized: "The end employer is unknown, so I cannot verify you haven't already applied to this company directly. Authorize anyway?" Never proceed on silence — the reveal-time check only catches damage after the fact.

1. Read the visible URL, page title, company, role, and any closed/expired signals.
2. If a URL is available, verify liveness with Playwright:
   - active posting evidence: title/role + job description or form fields + submit/apply path
   - closed posting evidence: expired/closed/no longer accepting applications, missing JD with only nav/footer, hard redirect to generic careers/search, or 404/410
3. Compare the visible company and role against the matched report.
4. If company or title changed materially, stop before drafting and ask:
   "The form appears to be for [visible company] — [visible role], but the matched report is [report company] — [report role]. Do you want me to re-evaluate, adapt with this mismatch, or stop?"
5. If the posting appears closed, refuse to generate final copy unless the candidate explicitly overrides with a known reason.
6. If liveness cannot be verified because the candidate only pasted questions or a screenshot, state that limitation and ask the candidate to confirm the company, role, and active posting before drafting.

Do not continue to Step 6 until this preflight is resolved.

## Step 5b — Pre-scan for knock-out questions

Read the entire page/form to scan for knock-out questions BEFORE generating full responses. These are questions designed to automatically disqualify candidates who do not meet critical criteria.

1. Common knock-out question areas to target:
   - **Minimum years of experience** (e.g., "Do you have at least 5 years of professional software engineering experience?")
   - **Degree requirements** (e.g., "Do you have a Bachelor's degree in Computer Science or a related field?")
   - **Work authorization/Visa sponsorship** (e.g., "Will you now or in the future require visa sponsorship to work in the United States?")
   - **Salary floors/expectations** (e.g., "What is your target salary / expectation?")
2. Check these questions against the candidate's `config/profile.yml` or `cv.md` parameters.
3. If a knock-out question is detected where the candidate's profile represents a potential mismatch (e.g., candidate needs sponsorship and the form automatically filters out sponsorship-needy applicants, or candidate's salary expectations mismatch the visible JD/form floors):
   - Highlight the specific knock-out question to the candidate immediately.
   - Present a clear warning block:
     `⚠️ KNOCK-OUT WARNING: The form asks "[question text]". Based on your profile/CV, answering "[profile answer]" may trigger immediate automatic rejection by the ATS. How would you like to answer this, or do you want to skip applying?`
   - Stop and wait for the candidate's confirmation before drafting any further answers.
4. If no knock-out questions are found, or the candidate resolves the warning, proceed to Step 6.

**Applying to several roles in one sitting?** This preflight verifies the single form in front of you. Before a multi-role session — especially against scanner entries marked `**Verification:** unconfirmed (batch mode)` — run the `pipeline` mode **Liveness sweep** first (`node check-liveness.mjs --file <urls>`). It drops the dead postings from `data/pipeline.md` in one batch so you never open a tab on an expired role.

## Step 1 — Detect the job

**With the batch executor:** Use only the task-created page for the exact
manifest candidate. Never inspect or reuse a pre-existing user tab.

**Without Playwright:** Ask the candidate to:
- Share a screenshot of the form (Read tool can read images)
- Or paste the form questions as text
- Or say company + role so we can search for it

## Step 2 — Identify and search for context

1. Extract company name and role title from the page
2. Search in `reports/` by company name (case-insensitive grep)
3. If there is a match → load the full report
4. If there is a Section H or `## Application Answers` → load previous answers as a base
5. If there is NO match → notify and offer to run a quick auto-pipeline

## Step 3 — Detect changes in the role

If the role on screen differs from the one evaluated:
- **Notify the candidate**: "The role has changed from [X] to [Y]. Do you want me to re-evaluate or adapt the responses to the new title?"
- **If adapt**: Adjust responses to the new role without re-evaluating, only after the candidate explicitly accepts the mismatch
- **If re-evaluate**: Execute full A-F evaluation, update report, regenerate Section H
- **Update tracker**: Change role title in applications.md if applicable

## Step 6 — Analyze form questions

Identify ALL visible questions:
- Free text fields (cover letter, why this role, etc.)
- Dropdowns (how did you hear, work authorization, etc.)
- Yes/No (relocation, visa, etc.)
- Salary fields (range, expectation)
- Upload fields (resume, cover letter PDF)

Classify each question:
- **Already answered in Section H or `## Application Answers`** → adapt the existing response
- **New question** → generate response from the report + cv.md

For each field, preserve the application form contract:
- `field_type`: `text`, `textarea`, `select`, `radio`, `checkbox`, `number`, `file`, or `unknown`
- `required`: `yes`, `no`, or `unknown`
- `limit`: exact character/word limit if visible; otherwise `unknown`
- `options`: visible options for select/radio/checkbox fields
- `needs_candidate_confirmation`: `yes` for legal, demographic, work authorization, visa, relocation, salary, disability, veteran, sponsorship, background-check, or self-identification questions unless the answer is explicitly present in `config/profile.yml`

Never invent answers for legal, demographic, work-authorization, visa/sponsorship, salary, disability, veteran, background-check, relocation, or self-identification fields. If the answer is not present in `config/profile.yml` or visible context, mark it as needing candidate confirmation and provide the safest question to ask the candidate.


## Step 7 — Generate responses

For each question, generate the response following:

1. **Report context**: Use proof points from block B, STAR stories from block F
2. **Previous Section H / Application Answers**: If a draft or final response exists, use it as a base and refine
3. **"I'm choosing you" tone**: Same auto-pipeline framework
4. **Specificity**: Reference something specific from the JD visible on screen
5. **career-ops proof point**: Include in "Additional info" if there is a field for it
6. **Recruiter-side risk map**: Use `modes/heuristics/recruiter-side.md` to identify what doubt the question is trying to resolve (motivation, stack fit, logistics, comp, work-auth, availability, seniority) and answer that doubt directly.
7. **Disclosure discipline**: Answer logistics questions truthfully when asked, but do not volunteer sensitive or HR-only details in unrelated motivation/fit answers.

**Output format:**

```text
## Responses for [Company] — [Role]

Based on: Report #NNN | Score: X.X/5 | Archetype: [type]

---

### 1. [Exact form question]
> [Response ready for copy-paste, or "Ask candidate: ..." if the field needs confirmation]

### 2. [Next question]
> [Response]

...

---

Notes:
- [Any observations about the role, changes, etc.]
- [Personalization suggestions the candidate should review]
```

## Step 8 — Persist application snapshot

After the final answers are filled into the form or handed to the candidate for copy-paste, update the matched report with an additive `## Application Answers` section. Keep direct report writes at `filled`; authoritative submission proof is batch-scoped.

The section must include:
- `**Date:** YYYY-MM-DD`
- `**State:** filled` (`submitted` is historical display data only and cannot be written directly)
- Free-text answers exactly as submitted
- Dropdown/radio/checkbox selections made
- Number or short-answer fields such as compensation, availability, start date, and work authorization
- Files used, including CV, cover letter, portfolio, or other uploads with version/path when known

Write the section at the end of the report, or replace only the existing `## Application Answers` section if it already exists. Do not rename, reorder, or edit the existing A-H report blocks or `## Keywords extracted`.

Use `application-answers.mjs` when possible to format/upsert the section:

```bash
node application-answers.mjs --report reports/NNN-company-role-date.md --input answers.json --state filled
```

## Step 9 — Post-apply (optional)

If the candidate confirms that they submitted the application:
1. For a form prepared through the automated application workflow, preview the exact confirmation: `node application-submission.mjs preview --manifest <manifest> --candidate-id <id> --tracker data/applications.md --tracker-row <#> --evidence "<what the user observed after manually submitting>"`. Show the preview, stop for confirmation, then re-run with `confirm` and the exact `--confirm-digest`.
2. If the user instead explicitly reports an independent manual application, use the tracker-only `manual-application-confirmation.mjs --user-confirmed --company <company> --role <role> [--date YYYY-MM-DD]` path. Do not require automated-form evidence for that statement.
3. After either path succeeds, seed follow-ups only after tracker readback: `node followup-seed.mjs {num} --json`.
4. Keep the report answer snapshot at `filled`; automated submission proof lives in batch state and the tracker event note.
5. Suggest next step: run the `contacto` mode (`/career-ops contacto` where available) for LinkedIn outreach.

## Scroll handling

If the form has more questions than the visible ones:
- Ask the candidate to scroll and share another screenshot
- Or paste the remaining questions
- Process in iterations until the entire form is covered

## Known ATS Quirks

Field-tested across ~12 Playwright-driven applications (Ashby, Greenhouse, Lever, Workable). These quirks silently break an apply run if not accounted for.

### Ashby — email-based candidate dedup

- **Symptom:** Submitting a second application at the same company silently fails or merges into the existing candidate record. Ashby deduplicates by email per company.
- **Agent:** Before filling the email field, check whether an earlier report for the same company already exists in `reports/`. If it does, warn the candidate and pre-fill a `+tag` alias (e.g., `user+teamname@domain.com`) as the suggested value.
- **Candidate:** Confirms or changes the email before the form is submitted.

### Lever — hCaptcha intercepts checkbox/radio clicks

- **Symptom:** Programmatic `click()` on checkboxes or radio buttons triggers an hCaptcha challenge mid-form, blocking the rest of the fill.
- **Agent:** Fill `<input type="text">`, `<textarea>`, and `<select>` fields only. Skip all checkboxes, radio buttons, and the captcha widget. List the skipped fields with their recommended values so the candidate can tick them.
- **Candidate:** Completes the checkboxes, solves the captcha, and clicks Submit.

### Workable — SPA re-renders break form refs

- **Symptom:** Workable's SPA re-renders form components between fills, invalidating element references. Sequential `fill()` calls hit stale-element errors.
- **Agent:** Copy each answer to the clipboard and present a numbered paste list. If Playwright is active, dispatch `Ctrl+V` per field with a fresh element query before each paste — do not cache refs across fields.
- **Candidate:** Pastes remaining answers manually if clipboard dispatch fails, then submits.

### React-select autocomplete widgets

- **Symptom:** `react-select` (common in Greenhouse, Ashby, Lever for location/department fields) destroys and recreates its internal DOM on every keystroke. Cached refs go stale instantly.
- **Agent:** Type character-by-character with short delays (~100 ms). Re-snapshot after every selection to pick up the new DOM state. Never cache element references across interactions.
- **Candidate:** Verifies each selected value is correct before moving on; corrects any mis-selection inline.

### Huge native `<select>` elements (1 000+ options)

- **Symptom:** Country, university, or field-of-study dropdowns contain thousands of `<option>` entries. Snapshotting them floods context and stalls the agent.
- **Agent:** Use `select_option` directly by value or visible label. Never snapshot the full option list. If the exact label is unknown, ask the candidate for the value instead of dumping options into context.
- **Candidate:** Provides the correct label when the agent cannot infer it from `config/profile.yml`.

### Job-board host ≠ application host — re-check the URL after "Apply"

- **Symptom:** The posting is discovered on one ATS, but clicking **Apply** hands off to a *different* ATS for the actual form. Enterprise career sites (commonly Phenom-, iCIMS-, or Radancy-hosted) frequently redirect into a Workday, Greenhouse, or SmartRecruiters application flow. Choosing fill tactics from the *board* URL applies the wrong quirks.
- **Agent:** After the Step 5 preflight, follow the Apply button/redirect and read the URL of the page that actually renders the form fields. Match your fill tactics to *that* host — not the board the job was discovered on. A `myworkdayjobs.com` handoff in particular means the Workday quirk below applies.
- **Candidate:** Confirms the destination page looks like the right company/role before the agent starts filling.

### Workday — set-value doesn't register on React fields

- **Symptom:** Setting a Workday text field's value programmatically (without real keystrokes) leaves it visually filled but empty to Workday's validation — the React `onChange` never fires, so Save throws "required" on a visibly-filled field. Yes/No dropdowns also vary their option order per question, so a positional click can select the wrong answer (e.g. "No" on *are you authorized to work?*).
- **Agent:** For required text fields, **type** real keystrokes (focus → select-all → type), or verify each value registered before Save. Survey the whole step top-to-bottom first (the address block is often below the fold) and fill from the candidate's saved profile (`config/profile.yml` / `cv.md`) proactively, rather than discovering fields via validation errors. For dropdowns, use **type-ahead** (open → type the option text → confirm the highlight) instead of positional clicks, and verify each selection.
- **Candidate:** Reviews the filled step — especially work-authorization/sponsorship dropdowns and any EEO/legal attestations — before Save/Submit.
Administrative cancellation must use `application-abandon.mjs` with the exact
batch manifest, exact candidate ID (or explicit whole-batch flag), and a human
reason. Never release claims from a queue, URL, company, title, rank, or tab.

When one verified field explicitly requests combined application documents and
separate CV/cover fields are absent, the executor may losslessly merge and bind
the exact standalone PDFs. Stop for renewed preflight confirmation before
uploading it. Ambiguous file inputs require review and no upload.
