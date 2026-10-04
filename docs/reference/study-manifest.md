# Historical study manifest and diagnostics

This manifest format remains supported for keyless CLI `trace` and `preflight` diagnostics, and for reading pre-release file-backed reports. Current CLI and MCP runs both use the same durable direct-request service; see the [study-design skill](../../skills/study-design/SKILL.md) for request shapes and tools.

The strict JSON manifest uses `version: "2.0"`. A study groups one or more arms under a title and purpose. Each arm is a stimulus variant and has its own sources, ordered stimulus items, typed tasks, and presentation mode. See the [article fixture](../../test/fixtures/article.json), [chapter fixture](../../test/fixtures/chapter.json), and [respondent cohort](../../test/fixtures/cohort.json).

## Arm fields

- `id` and `label`: stable identity and display name for the arm.
- `sources`: source paths and SHA-256 hashes, verified before a run.
- `items`: bounded stimulus segments in presentation order.
- `tasks`: typed response tasks. Choice uses stable option IDs and descriptions. Score uses an ordered rubric and returns an expected score, per-level probabilities, and rubric legend. Noul returns P(true) for a proposition, optionally with true/false criteria. `unanswerable` is an ordinary explicit Choice option when relevant. Optional `answerKeyOptionId` is Choice scoring metadata and is never sent to a provider.
- `tasks[].responseHistory`: optional per-task `include` or `omit` policy. Omitted means `include`. `omit` removes earlier response events from this task's packet while retaining stimulus exposures and the same respondent journey.
- `presentation`: `sequence` exposes every item in order and then asks each task; `graph` uses `expose`, `ask`, and `terminal` nodes with bounded decisions. Choice transitions match one option ID. Score/Noul transitions use explicit typed intervals that must cover the full response domain exactly once.

For matched arms, add a shared `comparisonKey` to semantically corresponding tasks and reuse Choice option IDs only when they retain the same meaning. Each frozen respondent is run once through every arm in the same run. Reports align task occurrence order within each respondent and compare typed values only when their task meanings align.

Pre-release file-backed reports can be compared with the read-only `legacy-compare` and `legacy-compare-runs` commands. Independent durable runs are queried through their stored evidence and can be continued with a follow-on request. Reports are descriptive evidence from simulated respondents, not a causal estimate.

## Example study design

To compare two explanations of the same passage, create `original` and `revised` arms with their own source hash and item text. Give both arms a comprehension task with the same `comparisonKey` and the same stable options such as `supported`, `contradicted`, and `unanswerable`. Reuse one frozen respondent cohort for both. The report then shows each arm's option counts and proportions, the source and stimulus changes, and each respondent's paired answer when both answers use shared option IDs.

The [study manifest schema](../../skills/stimulus-response-polling/assets/study-manifest.schema.json), [respondent cohort schema](../../skills/stimulus-response-polling/assets/respondent-cohort.schema.json), and [respondent profile schema](../../skills/stimulus-response-polling/assets/respondent-profile.schema.json) are the consumer contracts. The cohort uses `version: "3.0"` and an ordered `respondents` list. Its full snapshot and all arm contents contribute to the stimulus fingerprint. The [archetype and cohort guide](../../skills/stimulus-response-polling/references/archetypes-and-cohorts.md) explains authoring and expansion.

## Design and validate in human terms

Start with the source material, what the person wants to learn, and whose perspective would help. Use `trace` with scripted Choice IDs or typed responses to inspect a particular manifest path without inference. Use `preflight` to assess a manifest and frozen cohort across reachable paths. Current direct requests use `inspect` for packet fit and call bounds; it returns identifiers for measured packets rather than a complete topology or material preview.

## Check context fit

Run `node dist/cli.js preflight --manifest study.json --cohort cohort.json --providers providers.json` to assess the authored study across its reachable paths. Without a frozen cohort, use `--mode maximum-profile` for an explicitly synthetic profile-size sample. See [prepare and trace](../../skills/stimulus-response-polling/references/prepare-and-trace.md) for measurement limits and command shapes, and [packet budgeting](../../skills/study-design/references/packet-budgeting.md) for packet contents and provider rules.
