# System One Polling

An ambient Codex plugin and standalone Node.js 24 harness for bounded text stimulus and typed-response studies using Jev or an explicitly configured local System One endpoint.

## What it does

- Models a study as bounded text stimulus, typed tasks, a frozen cohort of distinct respondent profiles, and one or more arms.
- Runs simple item-then-task sequences or optional bounded graphs for conditional exposure and early exit.
- Runs every respondent once per arm in one matched A/B run, with shared provider settings, durable checkpoints, call and spend controls, resume, and cancellation.
- Reports option distributions, task reach/completion denominators, optional answer-key scoring, and same-run matched comparisons.
- Ships reusable reader archetypes as one respondent family. The skill guides archetype authoring, study-specific profile expansion, direct respondent authoring, task design, validation, execution, and interpretation.
- Exposes the shared workflow through a CLI and eight MCP tools.

The plugin ships [reader archetypes](dist/data/reader-archetypes.json), not ready-made profiles. A user can use shipped archetypes, add contract-compliant custom archetypes, mix both, or provide a frozen respondent cohort directly. Each unique respondent-profile, stimulus, and task presentation is the meaningful simulated unit. Repeating a deterministic call or retry does not add respondents. Reports describe simulated responses, not human readership, statistical significance, causal lift, or real-world accuracy. Read the [skill](skills/stimulus-response-polling/SKILL.md) and [study manifest reference](docs/reference/study-manifest.md) before using the harness.

## Development

Requires Node.js 24.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run contracts:build
npm run build
```

The build removes and recreates `dist/`, bundles runnable MCP and CLI JavaScript, and copies the domain-owned reader archetype catalogue from `src/domain/readers/` into `dist/data/`.

## CLI

```sh
node dist/cli.js --help
node dist/cli.js check --config study-run.json
node dist/cli.js trace --manifest study.json --cohort respondents.json --arm original --respondent respondent-id --choices supported,continue
node dist/cli.js start --config study-run.json
node dist/cli.js status --output ./runs --run-id <run-id>
node dist/cli.js report --output ./runs --run-id <run-id>
node dist/cli.js compare --output ./runs --run-id <run-id> --left-arm original --right-arm revised
```
