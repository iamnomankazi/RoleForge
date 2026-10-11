# RoleForge

RoleForge is a local-first job-search engineering workspace for discovering roles, evaluating fit, preparing tailored application material, assisting with application forms, and tracking the application lifecycle.

It is designed around a simple principle: automate repetitive job-search work without giving automation authority to make the final application decision.

> **Human-in-the-loop by design:** RoleForge may discover roles, prepare documents, navigate application flows, and fill supported form fields. It does **not** click the final Submit, Send, or Apply action.

RoleForge is a standalone project originally based on [Career Ops](https://github.com/santifer/career-ops) by Santiago Fernández de Valderrama and its contributors. Inherited code remains under the MIT license with upstream attribution. See [UPSTREAM.md](UPSTREAM.md) for reconstruction and provenance details.

## RoleForge-specific improvements

This project extends the upstream job-search workflow with additional engineering work, including:

- Improved multi-ATS discovery, location/title/content matching, and deduplication, with filter changes replayed against 468,916 historical ATS records.
- Added API-first posting liveness and job-description retrieval, explicit-requirement eligibility checks, and evidence-backed assessment decisions and ranked shortlists.
- Strengthened application preparation with exact-candidate validation, persistent browser sessions, and human handoff for login/CAPTCHA; final submission remains manual.
- Added CV claim checks and user-approved cover-letter handling to prevent unsupported candidate statements from entering new application documents.

## What RoleForge does

RoleForge brings the main parts of a technical job-search workflow into one repository:

- discovers openings from configured portals and ATS providers;
- merges, deduplicates, and tracks scan results;
- evaluates jobs against candidate-controlled source material;
- prepares tailored CV and cover-letter artifacts;
- checks whether listings are still live;
- creates immutable application batches for exact candidates;
- traverses listing pages and supported ATS flows toward the real application form;
- prepares application forms while preserving evidence and candidate identity;
- records application state without allowing automated final submission;
- exposes the same local data through CLI tooling, a Go dashboard, and an optional web UI.

The repository also contains integrity checks, acceptance tests, deterministic identifiers, provenance records, recovery paths, and explicit boundaries between system source and personal career data.

## Core workflow

```text
Discover
   ↓
Merge + deduplicate
   ↓
Rank / evaluate
   ↓
Generate application documents
   ↓
Create exact-candidate application batch
   ↓
Preflight + bind artifacts
   ↓
Navigate listing → ATS → application form
   ↓
Prepare form + capture review evidence
   ↓
Human reviews and submits manually
   ↓
Track outcome and follow-up
```

RoleForge treats these transitions as stateful work rather than a loose collection of browser tabs. Scan runs, candidate identities, application batches, artifacts, and tracker state remain explicitly connected so later automation can verify what it is acting on.

## Key capabilities

| Area | RoleForge capability |
| --- | --- |
| Discovery | Direct scanning plus configured company and portal sources |
| ATS coverage | Discovery and traversal support for systems including Greenhouse, Ashby, and Lever |
| Scan integrity | Versioned scan-run data, merge tooling, deduplication, and provenance |
| Candidate identity | Stable candidate IDs and exact-candidate application authority |
| Evaluation | Structured job evaluation from candidate-controlled source material |
| Documents | Tailored CV/PDF and cover-letter generation with artifact binding |
| Liveness | Checks whether a job posting is still active before downstream work |
| Application batches | Immutable manifests that define exactly which candidate may be processed |
| Preflight | Validates candidate, artifacts, destination, and application state before browser execution |
| Browser traversal | Controlled listing → ATS → form navigation with destination and form revalidation |
| Shared browser | Sequential exact-candidate preparation in one visible browser context |
| Recovery | Resume and revalidation paths for interrupted or review-required application preparation |
| Abandonment | Explicit audited cancellation without silently changing tracker state |
| Evidence | Stored form, reasoning, and provenance evidence for review and integrity checks |
| Submission boundary | Final submission remains manual and outside agent authority |
| Tracking | Pipeline/application tracker tooling, normalization, deduplication, and reconciliation |
| Interfaces | CLI scripts, optional Go dashboard, and optional local-first web UI |

URL reading defaults to the local Playwright/Chromium CLI extractor (`node browser-extract.mjs <url>`). Run `node doctor.mjs` to check the runtime. A connected browser MCP remains available through explicit `scan.extractor: mcp`. If CLI extraction fails, use MCP only when connected; otherwise leave liveness unconfirmed and request pasted JD text or repair the local runtime. WebFetch/search can supply text, never verify an active posting.

## Discovery and scanning

The scanner is built to reduce expensive model work before it begins. RoleForge can query configured portals, perform ATS-oriented discovery, merge worker outputs, and maintain scan history for deduplication.

Useful entry points include:

```sh
npm run scan
npm run scan:full
npm run discover:ats
npm run scan:merge
npm run validate:portals
npm run verify:portals
```

See [docs/SUPPORTED_JOB_BOARDS.md](docs/SUPPORTED_JOB_BOARDS.md) for documented discovery providers and [docs/SCRIPTS.md](docs/SCRIPTS.md) for script-level contracts.

## Evaluation and documents

RoleForge generates candidate-facing material from approved candidate sources and statements supplied directly by the user. The source-of-truth boundary is documented in [DATA_CONTRACT.md](DATA_CONTRACT.md).

The workflow can prepare:

- structured job evaluations;
- tailored CV output and PDFs;
- cover letters;
- application document bundles;
- interview and application support material governed by configured modes.

Claims are meant to be reframed from verified candidate facts, not invented. Personal career data belongs to the user layer and stays separate from tracked system source.

## Application safety model

Application automation uses an explicit authority chain.

### Immutable batch authority

Browser application work begins from an immutable application-batch manifest and one exact `candidate_id`. A queue row, open browser tab, arbitrary URL, or “first N” selection is not enough authority.

```sh
npm run application:batch
npm run application:artifact
npm run application:preflight
```

### Exact-candidate execution

The executor verifies candidate identity, liveness, destination, artifacts, and current state before it can prepare a form.

```sh
npm run application:execute
```

For bounded multi-candidate preparation, RoleForge also includes a shared-browser path:

```sh
npm run application:shared-browser
```

### Controlled traversal

RoleForge can move from a verified listing through an application-entry action and supported ATS intermediate pages. Once candidate fields establish that the actual application form has been reached, final-action controls are treated as unreachable automation targets.

### Review before submission

A prepared form retains review evidence and the detected final action. The user performs the final submission independently.

RoleForge can record submission evidence and state through the controlled workflow, but it does not perform the final click itself.

### Recovery and abandonment

Interrupted preparation is not assumed safe to resume blindly. Recovery paths revalidate the candidate, destination, form, and relevant evidence.

Intentional cancellation uses the explicit abandonment workflow:

```sh
npm run application:abandon
```

This safety model is described in more detail in [AGENTS.md](AGENTS.md) and [docs/SCRIPTS.md](docs/SCRIPTS.md).

## Quick start

RoleForge currently runs from a local checkout; the inherited Career Ops scaffolder is not a RoleForge installer.

### Requirements

- Node.js 20+ is recommended for the current tooling;
- Git;
- an AI coding CLI such as Codex;
- Chromium/Playwright for browser and PDF workflows;
- Go only for the optional dashboard.

Install the pinned JavaScript dependencies:

```sh
npm ci
```

Run the setup check:

```sh
node doctor.mjs --json
```

Then open your agent from the repository root, for example:

```sh
codex
```

Ask it to run a mode in plain language, such as:

```text
Run scan mode.
Evaluate this job description.
Run tracker mode.
Prepare the exact candidate in this application batch.
```

Existing `/career-ops` skill aliases and internal compatibility identifiers remain available where the inherited workflow still depends on them.

Codex reads the shared project guidance through the root [CODEX.md](CODEX.md) wrapper. Native `/career-ops` slash commands are not guaranteed, so ask for the mode by name in a plain-language prompt. For a one-shot run, use `codex exec "Run career-ops scan mode and summarize new matches."` See the [Codex guide](docs/CODEX.md) for interactive and headless examples.

For fuller onboarding instructions, see [docs/SETUP.md](docs/SETUP.md).

## Common commands

| Command | Purpose |
| --- | --- |
| `npm run doctor` | Check local setup and onboarding prerequisites |
| `npm run scan` | Run the standard scanner |
| `npm run scan:full` | Run the full ATS-oriented scan |
| `npm run discover:ats` | Discover ATS-backed role sources |
| `npm run scan:merge` | Merge and deduplicate scan-worker results |
| `npm run tracker` | Inspect application tracker state |
| `npm run verify` | Verify pipeline integrity |
| `npm run normalize` | Normalize tracker statuses |
| `npm run dedup` | Deduplicate tracker data |
| `npm run reconcile` | Reconcile pipeline and tracker state |
| `npm run liveness` | Check posting liveness |
| `npm run pdf` | Generate a PDF from prepared CV content |
| `npm run cover-letter` | Generate a cover-letter artifact from a payload |
| `npm run application:batch` | Create an immutable application batch |
| `npm run application:artifact` | Bind an artifact to an exact batch candidate |
| `npm run application:documents` | Prepare application documents |
| `npm run application:preflight` | Validate application authority and readiness |
| `npm run application:execute` | Run the locked exact-candidate browser executor |
| `npm run application:shared-browser` | Prepare bounded candidates through one visible browser |
| `npm run application:abandon` | Auditably abandon a candidate or batch |
| `npm run serve:dashboard` | Run the optional Go dashboard |
| `npm run build:dashboard` | Build the Go dashboard |

Additional provider-specific evaluation, analysis, migration, and testing scripts are listed in [package.json](package.json).

## Project architecture

RoleForge separates personal career data from system code.

### User layer

The user layer contains candidate-specific material and generated state. Examples include:

- `cv.md`;
- `config/profile.yml`;
- `modes/_profile.md`;
- `portals.yml`;
- pipeline and application data;
- reports and generated output;
- interview-preparation material.

These files are governed by [DATA_CONTRACT.md](DATA_CONTRACT.md). Personal facts and application artifacts should not be migrated into system source merely for convenience.

### System layer

The system layer contains reusable workflow logic such as:

- `*.mjs` scripts;
- shared and default modes;
- templates;
- dashboard and web source;
- application batch and executor logic;
- test suites;
- agent instructions and compatibility wrappers.

The distinction lets system changes be reviewed independently of personal career data.

## Important paths

| Path | Purpose |
| --- | --- |
| `modes/` | Workflow modes and shared agent behavior |
| `templates/` | CV, cover-letter, state, and workflow templates |
| `tests/` | Application, discovery, identity, integrity, and acceptance tests |
| `dashboard/` | Optional Go terminal dashboard |
| `web/` | Optional local-first web interface |
| `docs/` | Setup, script contracts, job-board support, and operational documentation |
| `DATA_CONTRACT.md` | User/system source-of-truth boundary |
| `AGENTS.md` | Operational instructions and safety constraints |
| `UPSTREAM.md` | Standalone-history and upstream provenance record |

Runtime user data and generated artifacts follow the repository's data contract and ignore rules rather than being treated as publishable source.

## Interfaces

### CLI and agent workflow

The primary interface is the repository plus an AI coding agent. Modes and scripts provide deterministic operations; the agent supplies reasoning and orchestration around those operations.

### Go dashboard

The dashboard is a local terminal interface over the same RoleForge workspace:

```sh
npm run serve:dashboard
```

### Web UI

The optional web interface is a local-first view over the same underlying workspace rather than a separate hosted service or independent database.

See [web/README.md](web/README.md).

## Testing and integrity

RoleForge includes focused test suites around areas where automation mistakes would be costly, including:

- candidate identity and scan contracts;
- immutable application batches;
- browser execution and shared-browser behavior;
- application form reasoning and hardening;
- time limits and recovery behavior;
- application artifact and document handling;
- evidence provenance;
- submission-state protections;
- legacy queue guards;
- ATS discovery;
- application acceptance behavior.

Examples:

```sh
npm run test:application-reasoning
npm run test:application-batch
npm run test:application-integrity
npm run test:application-acceptance
npm run test:discover-ats
npm run verify
```

Test counts are intentionally not hard-coded here because the suite evolves with the project.

## Current scope

RoleForge is an actively developed local workflow, not a hosted recruiting service and not a mass-application bot.

Its current emphasis is:

- high-volume discovery before expensive evaluation;
- narrowing discovered roles to worthwhile candidates;
- evidence-backed candidate/job evaluation;
- deterministic state and provenance;
- document preparation;
- browser-assisted application preparation with manual final submission;
- reducing repetitive work without weakening review gates.

Compatibility names inherited from Career Ops remain where changing them would create unnecessary migration risk. Their presence does not change the standalone RoleForge project identity.

Automatic upstream application is disabled. Upstream changes should be selectively reviewed and backported rather than blindly merged.

## Upstream provenance

RoleForge was originally based on [Career Ops](https://github.com/santifer/career-ops).

The standalone repository preserves the upstream MIT license and attribution while maintaining explicit migration provenance. It does **not** claim that inherited Career Ops implementation was authored from scratch.

For the detailed reconstruction record and compatibility notes, see [UPSTREAM.md](UPSTREAM.md).

## Citation

GitHub's **Cite this repository** feature reads [CITATION.cff](CITATION.cff). The primary citation describes RoleForge; the citation metadata also retains an explicit reference to the upstream Career Ops software.

## License

RoleForge is distributed under the [MIT License](LICENSE).

Copyright and attribution for inherited upstream work are retained as documented in the repository.
