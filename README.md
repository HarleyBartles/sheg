# System One Polling

An ambient Codex plugin and standalone Node.js 24 harness for bounded simulated-reader studies using Jev or an explicitly configured local System One endpoint.

## What it does

- Models articles, chapters, scans, and other reader experiences with one domain-neutral graph manifest.
- Ships reusable reader archetypes and guidance to expand them into poll-specific profiles or author profiles directly.
- Runs frozen simulated-reader cohorts with bounded decisions, durable checkpoints, call and spend controls, resume, reports, and matched comparisons.
- Exposes the same job core through a CLI and eight MCP tools.

The plugin ships a [reader archetype library](dist/data/reader-archetypes.json), not ready-made reader profiles. The skill teaches agents to author archetypes, expand them into study-specific profiles, or prepare profiles directly. Poll responses are simulated judgments, not observed readership, accuracy, calibration, or publication scores. Review the [skill](skills/simulated-reader-polling/SKILL.md) and [manifest reference](docs/reference/study-manifest.md) before using the harness.

## Development

Requires Node.js 24.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

The build removes and recreates `dist/`, bundles runnable MCP and CLI JavaScript, and copies the domain-owned reader archetype catalogue from `src/domain/readers/` into `dist/data/`. Keep generated runtime files committed with their sources.

## CLI

```sh
node dist/cli.js --help
node dist/cli.js check --config study-run.json
node dist/cli.js trace --manifest study.json --cohort cohort.json --reader reader-id --choices continue,leave
node dist/cli.js start --config study-run.json
node dist/cli.js status --output ./runs --run-id <run-id>
node dist/cli.js report --output ./runs --run-id <run-id>
```

See the [documentation index](docs/README.md) for the [Codex plugin installation guide](docs/guides/installing-codex-plugin.md) and provider references.
