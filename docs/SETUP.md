# RoleForge setup

Use your local RoleForge checkout. The inherited npm scaffolder targets upstream Career Ops and does not install RoleForge.

## Prerequisites

Use Node.js 20+ and an AI coding CLI. The optional Go dashboard uses the version specified in `dashboard/go.mod`. See [SUPPORTED_CLIS.md](SUPPORTED_CLIS.md).

From the checkout root:

```sh
npm ci
node doctor.mjs --json
codex
```

The setup check identifies missing `cv.md`, `config/profile.yml`, `modes/_profile.md`, and `portals.yml`. Ask your agent to guide onboarding from the example/template files. Store your personal details only in the user layer described in [DATA_CONTRACT.md](../DATA_CONTRACT.md).

Ask the agent to “Run scan mode”, “Evaluate this job description”, “Run PDF mode”, or “Run tracker mode”. Legacy `/career-ops` skill aliases remain compatible; Codex can use the same modes by name. See [SCRIPTS.md](SCRIPTS.md) for CLI commands and immutable application-batch authority. Agents stop before final application submission.

For PDF rendering, install Chromium if the dependency install has not already done so:

```sh
npx playwright install chromium
```

The optional web interface has its own [setup instructions](../web/README.md). Automatic upstream application is disabled. Use selective reviewed backports, preserving local user data and RoleForge changes.
