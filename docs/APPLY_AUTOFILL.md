# Batch-Native Application Preparation

<!-- APPLICATION_BATCH_AUTHORITY_V1 -->

Career-Ops prepares exactly one immutable-batch candidate per executor
invocation. The authority is the batch manifest plus one exact `candidate_id`.
An active tab, arbitrary URL, global queue, rank, first-N list, or hard-coded
target is never authority.

Career-Ops never submits. The semantic final action is detected, guarded, and
left untouched. The user reviews the completed form and performs the final
submission manually. `Applied` can be recorded only afterward through the
digest-bound `application-submission.mjs` confirmation flow.

## Safe workflow

```bash
node application-batch.mjs create --source-run <run-id> --batch-id <batch-id> --candidate-id <id> [--candidate-id <id> ...]
node application-documents.mjs plan --manifest <manifest> --candidate-id <id> [--jd-file <exact-local-JD>]
node application-documents.mjs prepare --manifest <manifest> --candidate-id <id> --plan <plan.json> --confirm-plan <plan-hash>
node application-batch.mjs preflight --manifest <manifest>
node application-batch.mjs preflight --manifest <manifest> --confirm-batch <batch-id>
node application-browser-executor.mjs --manifest <manifest> --candidate-id <id>
```

Artifact replacement invalidates preflight. Repeat the printed scope review and
explicit confirmation before browser execution.

For up to six already-confirmed one-candidate batches, one visible Chromium
process/context can keep one exact candidate per tab while filling sequentially:

```bash
node application-shared-browser.mjs --batch-id <batch-1> --batch-id <batch-2>
```

Every batch is independently verified before Chromium launches. One candidate
failure is recorded only for that candidate and does not close the browser or
prevent later tabs from running. All completed tabs stay open until the user
closes the task browser. Previously blocked/review-required candidates are
revalidated through the canonical preparation-resume contract without a
full-form restart. Interactive login resume remains an explicit standalone
single-candidate command.

## What the executor verifies

Before form work it revalidates source and artifact hashes, listing liveness,
company, role, destination compatibility, and actual-form field evidence. A
listing page or an Apply button alone is never treated as a prepared form.
While state is `listing_verified`, the executor may activate a visible,
non-submitting listing CTA such as `Apply`, `Apply now`, or `Apply for this job`
after checking its element, form association/method, candidate-field context,
and predicted destination. It revalidates the resulting URL and identity before
continuing. A second entry click is allowed only on a verified known-ATS
intermediate page, with a two-hop maximum and loop detection. Once candidate
fields establish the actual application form, every Apply/Submit/Send/Complete
action remains unreachable.

The executor supports grounded text fields, native selects, accessible
autocomplete controls, exact bound file uploads, conditional-field reinspection,
and text-only cover-letter fields. It reacquires each locator before use,
selects a real dropdown/autocomplete option, blurs the control, then verifies
that the committed value remains. A separate phone-country control selects
Finland and prevents a duplicate `+358` prefix.

Only exact manifest-bound files can reach upload controls. Separate CV and
cover-letter fields receive separate files. A one-document field requires an
explicit bound combined document; the executor never invents one or substitutes
an unrelated historical file. Uploaded filenames must be visibly confirmed by
the form.

## Whole-form review and states

The executor inspects the form before and after filling, rechecks newly visible
conditional controls, validation errors, required fields, committed options,
text areas, and uploads, then records evidence that the final action was not
activated.

Progress states are:

- `not_opened`
- `listing_verified`
- `actual_form_reached`
- `form_inspected`
- `fields_filled`
- `files_uploaded`
- `review_required`
- `login_required`
- `blocked`
- `closed`
- `form_prepared`

Only the locked executor can write progress states. There is no command that
lets an operator attest `form_prepared` manually.

## User gates and unsupported controls

The executor stops for login, CAPTCHA/reCAPTCHA, MFA, email verification,
account-creation consent, privacy or legal declarations, ambiguous personal
data, unsupported identity checks, and custom controls whose committed value
cannot be verified. It records the exact unresolved field and required user
action. It never guesses missing personal information.

Login resume is limited to the same manifest and candidate ID and repeats
source, artifact, liveness, identity, and URL validation. No browser page handle
or session is trusted across processes.

Current fail-closed limitations include inaccessible shadow/canvas controls,
native OS dialogs, demographic/legal declarations, and multi-step Next/Save
actions whose non-final semantics cannot be proven. These require manual review.

## ATS patterns

Repository-controlled fixtures cover Greenhouse-style, Lever-style,
Workday-style, and generic multipart forms, including separate uploads,
text-only cover letters, autocomplete, phone-country selection, conditional
fields, login, CAPTCHA, identity mismatch, expired listings, unsafe redirects,
missing required fields, duplicate popups, whole-form review, and final-submit
protection. Validation never uses a live company or ATS form.
### Abandoning safely

Use `npm run application:abandon -- --manifest <manifest.json> --candidate-id <exact-id> --reason "<human reason>"`.
For the entire exact batch, replace the candidate selector with `--batch`. This
does not update the tracker or erase artifacts and refuses an active executor.

### One combined document field

The executor generates `Company Role Application Documents.pdf` only after an
exact verified form exposes one field explicitly requesting combined application
documents and no separate CV/cover fields. Binding invalidates preflight. Confirm
the batch again, then use `--resume-preparation`; ambiguous upload fields stop at
`review_required` without uploading.
