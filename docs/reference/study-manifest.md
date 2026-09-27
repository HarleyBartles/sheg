# Study manifest

The strict JSON manifest uses `version: "2.0"`. A study groups one or more arms under a title and purpose. Each arm is a stimulus variant and has its own sources, ordered stimulus items, typed tasks, and presentation mode. See the [article fixture](../../test/fixtures/article.json), [chapter fixture](../../test/fixtures/chapter.json), and [respondent cohort](../../test/fixtures/cohort.json).

## Arm fields

- `id` and `label`: stable identity and display name for the arm.
- `sources`: source paths and SHA-256 hashes, verified before a run.
- `items`: bounded stimulus segments in presentation order.
- `tasks`: typed response tasks. The initial response type is finite choice, with stable option IDs and descriptions. `unanswerable` is an ordinary explicit option when relevant. Optional `answerKeyOptionId` is scoring metadata and is never sent to a provider.
- `presentation`: `sequence` exposes every item in order and then asks each task; `graph` uses `expose`, `ask`, and `terminal` nodes with bounded decisions and one transition per offered option.

For matched arms, add a shared `comparisonKey` to semantically corresponding tasks and reuse option IDs only when they retain the same meaning. Each frozen respondent is run once through every arm in the same run. Reports align task occurrence order within each respondent. They do not pool across runs.

## Example study design

To compare two explanations of the same passage, create `original` and `revised` arms with their own source hash and item text. Give both arms a comprehension task with the same `comparisonKey` and the same stable options such as `supported`, `contradicted`, and `unanswerable`. Reuse one frozen respondent cohort for both. The report then shows each arm's option counts and proportions, the source and stimulus changes, and each respondent's paired answer when both answers use shared option IDs. This is a descriptive comparison of profile-conditioned responses, not evidence of human comprehension or an isolated causal effect.

The [study manifest schema](../../skills/stimulus-response-polling/assets/study-manifest.schema.json), [respondent cohort schema](../../skills/stimulus-response-polling/assets/respondent-cohort.schema.json), and [respondent profile schema](../../skills/stimulus-response-polling/assets/respondent-profile.schema.json) are the consumer contracts. The cohort uses `version: "3.0"` and an ordered `respondents` list. Its full snapshot and all arm contents contribute to the stimulus fingerprint. The [archetype and cohort guide](../../skills/stimulus-response-polling/references/archetypes-and-cohorts.md) explains authoring and expansion.
