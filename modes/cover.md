# Mode: cover — Cover Letter v2 quality gate

This mode drafts a cover letter in chat, then runs deterministic checks and creates a text/PDF review pair. The CLI does not write prose and does not call an LLM. The candidate approves the exact checked draft before using it.

## 1. Read the posting and candidate evidence

- Require the full job description (JD), either pasted or available as a local file. Stop if it is missing.
- Record the company and role exactly as named by the JD. Include the exact JD text or a path to it in the draft JSON. The CLI computes and checks the JD hash.
- Read the candidate's current CV and relevant profile sources. Do not use prior generated letters as factual evidence.
- Read `voice-dna.md`, `modes/_profile.md` and `modes/_custom.md` when present. The CLI also loads the phrase lists of the first two at runtime. A cover-letter standard in `modes/_custom.md` is the editorial authority for structure, evidence choice and wording; the rules below are what the gate enforces.
- If the JD asks for salary, a permit or visa, work authorisation, or a graduation date inside the letter, stop and ask the candidate before drafting. The gate repeats such sentences under `jd_letter_requests` so they cannot be missed.
- Use English by default. Draft in Finnish or German only when the JD explicitly requires that language. If that requirement is unclear or conflicting, stop and ask the candidate which language to use.

## 2. Draft in chat with claim references

Write the letter yourself in chat, then save the exact draft as JSON with this shape:

```json
{
  "company": "Exact company name from the JD",
  "role": "Exact role title from the JD",
  "language": "en",
  "jd": { "path": "path/to/job-description.txt" },
  "greeting": "Dear Hiring Team,",
  "paragraphs": [
    {
      "text": "Paragraph text. Every candidate-fact sentence must have a matching claim below.",
      "claims": [
        { "id": "claim-1", "text": "Exact candidate fact stated in the paragraph." }
      ]
    }
  ],
  "closing": "Closing sentence.",
  "signature": "Candidate name"
}
```

`jd` must contain exactly one of `path` or `text`. It may also include `hash` with the SHA-256 of the JD text. Every paragraph must include a `claims` array. Each rendered fact-bearing sentence and every first-person sentence must equal a complete listed claim after case and whitespace normalization, except explicit intent/courtesy patterns (applying, interested, excited, look forward, would welcome, thank you, available). This includes the greeting and closing; use an optional top-level `claims` array for facts there. A plain candidate-name signature is exempt; factual signature text requires a claim. A non-first-person sentence repeated verbatim from the authoritative JD is authorized as JD context and excluded from CV claim validation. All other listed claims are validated, including ones not rendered. Do not invent, merge, or strengthen candidate facts. Give each claim a unique ID. Keep the greeting, paragraphs, and closing between 180 and 260 words in total; the signature is not counted.

Save the JSON under the user's ignored `output/` tree, for example `output/cover-letters/drafts/<slug>_<unique-id>.json`. For claim checking, use the candidate's manifest and CV required by the validator.

### Claim evidence

A claim may name its evidence with `evidence`, which takes one of these forms:

- manifest claim IDs from one CV item (one project, role or skills line). A paraphrase may only use words, facts and actions that item contains.
- `["jd"]` for posting context. "I" may only apply, want, hope or welcome. To tie the posting to the candidate's work, write two sentences: one citing `["jd"]` ("Your posting describes ...", "I am applying for the X position because ...") and one CV-backed sentence about the work. One sentence cannot mix posting content with candidate facts.
- `["profile:location.relocation"]` for the relocation preference in `config/profile.yml`. Its recorded wording is an example, not text to copy. A destination city may come from the JD. The claim fails if it mentions permits, visas, sponsorship or authorisation, or if it turns relocation into a start date.
- skills-line IDs for a plain mention: "I also know Java." or "I know Java and SQL." Every skill named must be cited, and nothing else may be added. Wording about use, depth, experience or results needs a project or role item.

`article-digest.md` and the interview story bank can corroborate a CV claim in the manifest. They are not cited directly in letters. Earlier letters are never evidence.

### Excluded topics

The gate checks the greeting, paragraphs and closing (never the company/role header or a company name such as "Visa"). It fails residence or work permits and visas, sponsorship and work authorisation, and graduation dates or timelines. "Master's student at ..." and programme names with "graduate" pass. If the candidate approves an employer-requested disclosure in chat for this posting, record the exception in the draft:

```json
"exclusionOverrides": [{ "topic": "graduation", "text": "<exact sentence in the letter>", "reason": "<the posting's request and the candidate's approval>" }]
```

Topics: `permit`, `authorization`, `graduation`. An exception covers only its quoted sentence and topic, and an unused one fails. Never add one without the candidate's approval in chat. The check sidecar records the exceptions. Approval then needs `--confirm-exclusion-override <topic>` for exactly those topics, and the approval record keeps them.

### Wording checks

Banned phrases are checked in the letter prose. A banned word that is also a technical term (`integrated`, `scalable`, `predictive`, `adaptive`, `optimize`) passes only when the same two-word term appears in the CV or the JD, and the second word is not filler such as "solutions" or "team". An "em dashes" avoid entry is enforced as the character itself.

## 3. Run the quality gate

```bash
node cover-letter-v2.mjs \
  --draft output/cover-letters/drafts/<draft>.json \
  --company "<complete company name stated by the user/assistant>" \
  --role "<complete role title stated by the user/assistant>" \
  --manifest <path-to-claim-manifest.json> \
  --cv cv.md
```

The canonical company and role are supplied independently with `--company` and `--role`; library callers pass `jdCompany` and `jdRole` in the options. Draft names must equal those complete names, and each canonical name must appear as a whole phrase in the JD. Draft `jd.company` and `jd.role` fields cannot override them. Optional language skills, including "a plus", "nice to have", and negated requirements, do not change the default English policy; mandatory language wording must apply in the same clause.

The CLI reads `config/profile.yml` for `profile:` evidence. Without that file, those claims fail. The CLI dynamically loads `./cv-claims.mjs` by default. If it is stored elsewhere, pass `--claims-validator <module>`. The module must export `validateClaims({ claims, manifest, cv })`. Missing validators, thrown errors, missing or duplicate claim results, or any rejected claim block output. Exactly one result is required per requested claim ID.

The gate reports every check and creates files only when all checks pass and the rendered PDF has exactly one page:

- `output/cover-letters/<company-slug>_<role-slug>_cover-v2_<shortHash>.txt`
- matching `.pdf`
- matching `.check.json` containing all checks and the draft, JD, text, and PDF hashes

It refuses existing filenames and never writes under `output/cv-approved/`. A failed check produces no letter artifacts. Fix the draft yourself; the CLI never rewrites or repairs it.

## 4. Show the review and request approval

After a successful run, show the complete text file and every check result in chat. Make the PDF available beside the text. Ask the candidate for explicit approval of this exact draft hash before treating it as approved or using it in an application. A successful quality check is not approval.

Only after the candidate explicitly approves the exact draft hash in chat, record that approval with:

```bash
node cover-letter-v2.mjs --approve output/cover-letters/<matching-basename>.check.json
```

This rechecks the text and PDF hashes and writes the matching `.approved.json` record. Do not run it before explicit approval. A letter with an excluded-topic exception also needs `--confirm-exclusion-override <topic>` for each recorded topic. Use it only when the candidate approved that disclosure for this posting.

If the candidate asks for any edit, update the JSON as a new draft, run the CLI again, and show the new full text and results. Do not reuse the previous pair or approval. The candidate remains responsible for final application submission.
