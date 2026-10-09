# Mode: cover — Cover Letter v2 quality gate

This mode drafts a cover letter in chat, then runs deterministic checks and creates a text/PDF review pair. The CLI does not write prose and does not call an LLM. The candidate approves the exact checked draft before using it.

## 1. Read the posting and candidate evidence

- Require the full job description (JD), either pasted or available as a local file. Stop if it is missing.
- Record the company and role exactly as named by the JD. Include the exact JD text or a path to it in the draft JSON. The CLI computes and checks the JD hash.
- Read the candidate's current CV and relevant profile sources. Do not use prior generated letters as factual evidence.
- Read `voice-dna.md` and `modes/_profile.md` when present. The CLI also loads their phrase lists at runtime.
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

`jd` must contain exactly one of `path` or `text`. It may also include `hash` with the SHA-256 of the JD text. Every paragraph must include a `claims` array. Put each candidate-fact sentence in that paragraph's claims; JD and company context does not need a candidate claim. Do not invent, merge, or strengthen candidate facts. Give each claim a unique ID. Keep the greeting, paragraphs, and closing between 180 and 260 words in total; the signature is not counted.

Save the JSON under the user's ignored `output/` tree, for example `output/cover-letters/drafts/<slug>_<unique-id>.json`. For claim checking, use the candidate's manifest and CV required by the validator.

## 3. Run the quality gate

```bash
node cover-letter-v2.mjs \
  --draft output/cover-letters/drafts/<draft>.json \
  --manifest <path-to-claim-manifest.json> \
  --cv cv.md
```

The CLI dynamically loads `./cv-claims.mjs` by default. If it is stored elsewhere, pass `--claims-validator <module>`. The module must export `validateClaims({ claims, manifest, cv })`. Missing validators, thrown errors, missing claim results, or any rejected claim block output.

The gate reports every check and creates files only when all checks pass and the rendered PDF has exactly one page:

- `output/cover-letters/<company-slug>_<role-slug>_cover-v2_<shortHash>.txt`
- matching `.pdf`
- matching `.check.json` containing all checks and the draft, JD, text, and PDF hashes

It refuses existing filenames and never writes under `output/cv-approved/`. A failed check produces no letter artifacts. Fix the draft yourself; the CLI never rewrites or repairs it.

## 4. Show the review and request approval

After a successful run, show the complete text file and every check result in chat. Make the PDF available beside the text. Ask the candidate for explicit approval of this exact draft hash before treating it as approved or using it in an application. A successful quality check is not approval.

If the candidate asks for any edit, update the JSON as a new draft, run the CLI again, and show the new full text and results. Do not reuse the previous pair or approval. The candidate remains responsible for final application submission.
