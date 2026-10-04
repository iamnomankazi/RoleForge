# RoleForge

RoleForge is a local job-search workspace for evaluating roles, scanning job boards, preparing tailored documents, tracking applications, and assisting with application forms under explicit candidate authority.

Originally based on [Career Ops](https://github.com/santifer/career-ops) by Santiago Fernández de Valderrama and its contributors. RoleForge retains the upstream MIT license and attribution. See [UPSTREAM.md](UPSTREAM.md) for provenance and compatibility details.

## Start locally

Open this checkout in your terminal, then install the pinned dependencies:

```sh
npm ci
node doctor.mjs --json
codex
```

Ask your agent to run a mode, for example: “Run scan mode”, “Evaluate this job description”, or “Run tracker mode”. Existing `/career-ops` skill aliases remain supported for compatibility. The agent follows [AGENTS.md](AGENTS.md) and the modes under [modes/](modes/).

The setup check identifies missing personal configuration and guides onboarding. Your CV, profile, portal configuration, reports, tracker, and generated documents belong to the user layer and stay outside tracked project source. See [DATA_CONTRACT.md](DATA_CONTRACT.md) and [the setup guide](docs/SETUP.md).

## Workflow

- Discover roles with `npm run scan` or the scanner modes.
- Evaluate a supplied job description and prepare CV/cover-letter documents from verified candidate facts.
- Inspect the tracker with `npm run tracker` and validate it with `npm run verify`.
- Prepare application forms only through an immutable application-batch manifest and one exact candidate ID. Final submission is manual.
- Use the optional [web UI](web/README.md) or Go dashboard over the same local files.

See [docs/SCRIPTS.md](docs/SCRIPTS.md) for script contracts and [docs/SUPPORTED_JOB_BOARDS.md](docs/SUPPORTED_JOB_BOARDS.md) for discovery providers.

## Project identity and updates

RoleForge is maintained locally as a standalone project. No remote URL or published package is assumed. Automatic upstream application remains disabled; upstream changes require selective reviewed backports. The inherited scaffolder installs Career Ops, so use this checkout for RoleForge.

Legacy environment variables, cache names, skill aliases, and internal module namespaces remain compatible. Localized readmes and inherited community/governance documents retain upstream context; this README and the setup guide describe the current RoleForge entrypoint.

## License

[MIT](LICENSE). Copyright and credit for inherited upstream work are retained; the reconstructed history is not a claim that inherited code was authored from scratch.
