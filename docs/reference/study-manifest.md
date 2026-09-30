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

## Design and validate in human terms

Start with the source material, what the person wants to learn, and whose
perspective would help. The [study-design skill](../../skills/study-design/SKILL.md)
teaches the agent to propose tasks and a cohort without asking the person to
author graph JSON. Get approval of that human-language study design, then
translate it to the manifest. Validate the manifest and cohort with
`poll_check`, and use `poll_preview` to show the complete generic journey,
including all branches, stimulus reveals, task wording, choices, destinations,
and shared continuations. Preview requires neither a cohort nor a provider and
makes no inference call.

## Check draft packet fit while authoring

`poll_measure_packets` estimates or measures individual task packets before a
complete study exists. Each dimension (`respondents`, `stimuli`, `tasks`, and
`trajectories`) is an array of `{ "id", "value" }` variants. `providers` uses
the same provider configuration shape as `poll_preflight`.

Use `paired` when each multi-valued dimension is deliberately matched by
position. For example, three profiles and three task drafts produce three
same-index cases, while one profile and 30 task drafts produce 30 cases because
the singleton profile is broadcast. If two multi-valued dimensions have
unequal lengths, validation fails before measurement. Use `cartesian` when all
combinations are intended; three profiles and two tasks produce six cases.
The tool returns per-case and per-provider fit, token estimate/measurement,
headroom, reasons, and each provider's largest case. It makes no inference
call, caps a batch at 1,000 cases and 16 MiB of compiled packet input, and
returns no partial batch as complete.

Supply the exact stimulus text in scope and the exact trajectory summary
expected at that decision. The packet contains the respondent's five profile
fields, in-scope stimulus, current task and choices, prior choice/exposure
history, and provider framing. See [packet budgeting](../../skills/study-design/references/packet-budgeting.md)
for current sequence/graph inclusion rules and provider assumptions. After the
design and frozen cohort are complete, use `poll_preflight` to walk every
respondent and every possible path. `poll_check` also reports deterministic
minimum and maximum decision-call bounds; its Jev spend figure is a configured
ceiling, not an expected charge. Only `poll_start` begins the respondent run,
after the human approves it.
