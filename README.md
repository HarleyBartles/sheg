# Sheg

Sheg runs structured stimulus-task-response polls against simulated respondent cohorts using System One models. It is a Codex plugin and Node.js harness for bounded text studies. It supports Jev and a separately operated local Laya service, subject to provider context fit.

## What it does

A study combines a bounded text stimulus, one or more questions with explicit response options, a frozen cohort of distinct respondent profiles, and one or more arms. Arms let you compare versions of a stimulus or study design with the same cohort in one run.

The harness runs each respondent once per arm, checkpoints progress, and reports response counts, task reach and completion, optional answer-key scoring, and matched comparisons. Use a sequence for straightforward item-then-question studies, or a bounded graph when conditional exposure or branching is part of the study.

The MCP run tools accept a direct inline request with one typed question, a finite sequence/graph journey, or a follow-on that selects exact recorded respondent contexts. Each durable run ID supports later recall of frozen inputs, typed answers, exposures, routes, query evidence, and lineage. The [study-design skill](skills/study-design/SKILL.md) helps an agent shape the simplest request, and the [polling skill](skills/stimulus-response-polling/SKILL.md) covers querying and reusing recorded contexts. The repository also retains [respondent archetypes](dist/data/respondent-archetypes/) for file-backed cohort authoring.

These are simulated responses. Repeating the same respondent, stimulus, and task does not create a more meaningful sample. Reports do not establish human readership, real-world accuracy, statistical significance, or causal lift.

## Supported harness

Sheg currently supports the Codex plugin harness. Other agent harnesses are not
included in this compatibility contract. Future harness adapters require their
own compatibility statement, packaging, and validation.

## Install the Codex plugin

You need Node.js 24 to run the bundled MCP server. You do not need TypeScript, `npm install`, or a local build to use the packaged plugin.

1. Add the repository marketplace:

   ```sh
   codex plugin marketplace add HarleyBartles/sheg
   ```

2. Restart the Codex desktop app, open the Plugins Directory, select the **Sheg** marketplace, and install the plugin.
3. Confirm the `run_inspect`, `run_start`, `run_list`, `run_query`, `run_get`, `run_cancel`, `run_resume`, `run_delete`, and `run_storage` tools are available.

See the [plugin installation guide](docs/guides/installing-codex-plugin.md) for local development and refresh instructions. Marketplace setup and installation behavior are also covered in the [official Codex plugin guide](https://developers.openai.com/plugins/build/plugins).

For the versioned GitHub Release, download the `sheg-v<version>.zip` asset and
follow [the release and installation guide](docs/guides/releases.md). The
existing Git-based marketplace route remains available.

## Prepare and run a study

1. Start with the text and what you want to learn. The [study-design skill](skills/study-design/SKILL.md) helps an agent identify the question, choose the simplest useful material unit and respondent perspectives, and build a direct request without asking the user to author a study file.
2. Configure one provider. Jev runs require a key in the selected Windows Credential Manager target and a `maxCalls` limit. Local Laya runs require a running service and the matching checkpoint tokenizer JSON and SHA-256 digest. See the [Jev setup and wire contract](docs/providers/jev.md) and [Laya capability notes](docs/providers/laya.md).
3. Call `run_inspect` with the exact direct request, finite journey, or follow-on selection, provider, and call limit. It validates the request and measures the exact packet fit without inference or run creation. Resolve any fit problem before proceeding.
4. For an authorized hosted run, call `run_start` with a UUID submission ID and the inspected request. Retain the returned run ID. Use `run_get` with status, request, journey, or answers views and `run_list` to discover runs. Call `run_query` to filter typed answers and journey outcomes; it returns exact evaluation/context IDs, provenance, denominators, and whether the source is complete. The agent chooses which evidence answers the user's question, then can submit those references or criteria in a follow-on request with an explicit context mode. Answers are machine-readable; the agent explains what they mean and reports incomplete or failed evaluations. `run_cancel` preserves any answer already in flight. An interrupted run can be resumed explicitly with `run_resume`; it keeps its original ID and call ceiling, and uncertain calls remain charged. Before deleting, call `run_delete` with `dryRun: true`; the preview identifies follow-on runs retained if a source is deleted. Active runs must be cancelled and polled to a terminal state. `run_storage` lets Sheg inspect datastore integrity/counts or run SQLite optimization. Discovery never starts or resumes work.

In Codex, you can start with a request such as: “I have this article and want to know where readers lose interest. Help me decide what to ask and whose perspectives to include, then show me the proposed study journey.” The agent uses Sheg's design guidance to shape the human-language design, translates it into the harness, and checks fit before asking for approval to run.

Jev is a hosted provider. Connect its key through the bundled Windows Credential Manager helper, never in a request or chat. The call limit bounds physical provider attempts. `run_inspect` does not make inference calls or require a key; `run_start` checks the selected credential before accepting a new request. See [run and recovery](skills/stimulus-response-polling/references/run-and-recovery.md).

The local Laya adapter bundles a pinned tokenizer and sequence builder for a pre-inference context-fit check. It sends a request only when the configured tokenizer matches its digest and the complete request fits; otherwise it rejects the request before inference. The service and checkpoint must be configured separately, and the integration still needs an operator smoke test against that service. See the [Laya capability notes](docs/providers/laya.md).

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
    "route": "openrouter"
  },
  "outputDirectory": "./.polling-runs",
  "maxCalls": 10,
  "concurrency": 1
}
```

Connect the route's key to Windows Credential Manager with the helper in [Jev provider routes](docs/providers/jev.md). Choose `openrouter` or `typesafe` explicitly. Check first, inspect the result, then start:

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

Work from `develop` and target feature pull requests at `develop`. See the
[runbook and playbook policy](.agents/doctrine/repo-runbook-policy.md) for
release and urgent-fix routing.

## Project links

- [Study-design skill](skills/study-design/SKILL.md)
- [Codex polling skill](skills/stimulus-response-polling/SKILL.md)
- [Study manifest guide](docs/reference/study-manifest.md)
- [Data contracts](docs/reference/data-contracts.md)
- [Provider setup: Jev](docs/providers/jev.md) and [Laya](docs/providers/laya.md)
- [Architecture decisions](docs/decisions/README.md)

Sheg is licensed under the [MIT License](LICENSE).
