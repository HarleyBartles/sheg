# System One Polling

System One Polling is a Codex plugin and Node.js harness for running bounded, text-based stimulus and typed-response studies with Jev or a configured local System One provider.

## What it does

A study combines a bounded text stimulus, one or more questions with explicit response options, a frozen cohort of distinct respondent profiles, and one or more arms. Arms let you compare versions of a stimulus or study design with the same cohort in one run.

The harness runs each respondent once per arm, checkpoints progress, and reports response counts, task reach and completion, optional answer-key scoring, and matched comparisons. Use a sequence for straightforward item-then-question studies, or a bounded graph when conditional exposure or branching is part of the study.

The skill helps an agent prepare the study, author or expand respondent profiles, validate inputs, trace routes, run polls, and interpret results. The plugin ships reusable [respondent archetypes](dist/data/respondent-archetypes/), not ready-made profiles. You can use the shipped archetypes, add custom ones, mix them, or provide a frozen profile cohort directly.

These are simulated responses. Repeating the same respondent, stimulus, and task does not create a more meaningful sample. Reports do not establish human readership, real-world accuracy, statistical significance, or causal lift.

## Install the Codex plugin

You need Node.js 24 to run the bundled MCP server. You do not need TypeScript, `npm install`, or a local build to use the packaged plugin.

1. Add the repository marketplace:

   ```sh
   codex plugin marketplace add HarleyBartles/system-one-polling
   ```

2. Restart the Codex desktop app, open the Plugins Directory, select the **System One Polling** marketplace, and install the plugin.
3. Confirm the `poll_check`, `poll_trace`, `poll_start`, `poll_status`, `poll_cancel`, `poll_resume`, `poll_report`, and `poll_compare` tools are available.

See the [plugin installation guide](docs/guides/installing-codex-plugin.md) for local development and refresh instructions. Marketplace setup and installation behavior are also covered in the [official Codex plugin guide](https://developers.openai.com/plugins/build/plugins).

## Prepare and run a study

1. Create a [study manifest](docs/reference/study-manifest.md) and a frozen respondent cohort. Use the [machine-readable contracts](docs/reference/data-contracts.md) and the [polling skill](skills/stimulus-response-polling/SKILL.md) for the exact shapes and authoring workflow.
2. Configure one provider. Jev runs require an API key available to the Codex process and explicit `maxUsd` and `maxPerCallUsd` limits. See the [Jev setup and wire contract](docs/providers/jev.md).
3. Call `poll_check` with the exact manifest, cohort, provider, and budgets. It validates and fingerprints inputs without making a provider inference call. Use `poll_trace` to check a scripted route without inference.
4. Review the proposed respondent-arm cell count and spend limits, then start an authorized run with `poll_start`. Use `poll_status` and `poll_report` to follow and inspect it. Compare arms with `poll_compare` within that same run.

In Codex, you can start with a request such as: “Compare these two versions with a distinct respondent cohort. Help me prepare the study and cohort, run `poll_check`, and show me the provider, cell count, and spend caps before any inference.” The skill guides the agent through preparation and keeps the paid run behind your explicit authorization.

Jev is a hosted, paid provider. Keep its key in the environment, never in a manifest or chat, and set conservative call and spend caps before starting. `poll_check` and `poll_trace` do not make inference calls.

The local Laya adapter is not ready for inference yet. It requires a checkpoint-matched context-fit measurer, and none is currently bundled. It therefore refuses to send a request when that fit cannot be verified. See the [Laya capability notes](docs/providers/laya.md).

## Run the CLI from source

The CLI is useful for scripted checks and local runs without Codex. From a clone, build the packaged runtime first:

```sh
npm ci
npm run build
node dist/cli.js --help
```

Create a config such as `study-run.json` using your study and cohort paths:

```json
{
  "manifestPath": "./study.json",
  "cohortPath": "./cohort.json",
  "provider": {
    "kind": "jev",
    "model": "<Jev model ID>",
    "keyEnv": "OPENROUTER_API_KEY",
    "endpoint": "https://openrouter.ai/api/alpha/decisions",
    "timeoutMs": 30000
  },
  "outputDirectory": "./.polling-runs",
  "maxCalls": 10,
  "maxUsd": 0.10,
  "maxPerCallUsd": 0.02,
  "concurrency": 1
}
```

Make the environment variable named by `keyEnv` available to the process. Replace the model ID and set limits appropriate for the study. Check first, inspect the result, then start:

```sh
node dist/cli.js check --config study-run.json
node dist/cli.js start --config study-run.json
node dist/cli.js report --output ./.polling-runs --run-id <run-id>
node dist/cli.js compare --output ./.polling-runs --run-id <run-id> --left-arm original --right-arm revised
```

The CLI also supports `trace`, `status`, `cancel`, and `resume`. See `node dist/cli.js --help` for the full syntax.

The build recreates `dist/` from the current source, bundles the MCP server and CLI, and copies the domain-owned archetype groups into the plugin package.

## Contribute

Use Node.js 24. Install dependencies with `npm ci`, then run the checks before submitting changes:

```sh
npm run contracts:build
npm run build
npm run lint
npm run typecheck
npm test
```

When changing contracts, update the TypeScript source of truth and regenerate the JSON Schemas. Include generated schemas and `dist/` changes with their source changes. Read [AGENTS.md](AGENTS.md) for repository surfaces and verification guidance, and [the decision log](docs/decisions/README.md) before changing an accepted architectural decision.

## Project links

- [Codex polling skill](skills/stimulus-response-polling/SKILL.md)
- [Study manifest guide](docs/reference/study-manifest.md)
- [Data contracts](docs/reference/data-contracts.md)
- [Provider setup: Jev](docs/providers/jev.md) and [Laya](docs/providers/laya.md)
- [Architecture decisions](docs/decisions/README.md)
