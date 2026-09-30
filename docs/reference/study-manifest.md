# Study manifest

The strict JSON manifest uses `version: "2.0"`. A study groups one or more arms under a title and purpose. Each arm is a stimulus variant and has its own sources, ordered stimulus items, typed tasks, and presentation mode. See the [article fixture](../../test/fixtures/article.json), [chapter fixture](../../test/fixtures/chapter.json), and [respondent cohort](../../test/fixtures/cohort.json).

## Arm fields

- `id` and `label`: stable identity and display name for the arm.
- `sources`: source paths and SHA-256 hashes, verified before a run.
- `items`: bounded stimulus segments in presentation order.
- `tasks`: typed response tasks. Choice uses stable option IDs and descriptions. Score uses an ordered rubric and returns an expected score, per-level probabilities, and rubric legend. Noul returns P(true) for a proposition, optionally with true/false criteria. `unanswerable` is an ordinary explicit Choice option when relevant. Optional `answerKeyOptionId` is Choice scoring metadata and is never sent to a provider.
- `responseHistory`: optional per-task `include` or `omit` policy. Omitted means `include`. `omit` removes earlier response events from this task's packet while retaining stimulus exposures and the same respondent journey.
- `presentation`: `sequence` exposes every item in order and then asks each task; `graph` uses `expose`, `ask`, and `terminal` nodes with bounded decisions. Choice transitions match one option ID. Score/Noul transitions use explicit typed intervals that must cover the full response domain exactly once.

For matched arms, add a shared `comparisonKey` to semantically corresponding tasks and reuse Choice option IDs only when they retain the same meaning. Each frozen respondent is run once through every arm in the same run. Reports align task occurrence order within each respondent and compare typed values only when their task meanings align.

Independent runs can also be compared with `poll_compare_runs` or the CLI
`compare-runs` command. The reports must identify the exact same ordered frozen
respondent profiles. Select one arm from each run; only responses with matching
`comparisonKey`, occurrence, type, and authored task meaning are comparable.
This makes a rerun with a changed stimulus comparable without requiring A/B
arms in one execution. The report is descriptive evidence from simulated
respondents, not a causal estimate. It keeps source, stimulus, task, provider,
run-status, and completion-denominator differences visible and includes
declared archetype/variation subgroup denominators.

## Example study design

To compare two explanations of the same passage, create `original` and `revised` arms with their own source hash and item text. Give both arms a comprehension task with the same `comparisonKey` and the same stable options such as `supported`, `contradicted`, and `unanswerable`. Reuse one frozen respondent cohort for both. The report then shows each arm's option counts and proportions, the source and stimulus changes, and each respondent's paired answer when both answers use shared option IDs.

The [study manifest schema](../../skills/stimulus-response-polling/assets/study-manifest.schema.json), [respondent cohort schema](../../skills/stimulus-response-polling/assets/respondent-cohort.schema.json), and [respondent profile schema](../../skills/stimulus-response-polling/assets/respondent-profile.schema.json) are the consumer contracts. The cohort uses `version: "3.0"` and an ordered `respondents` list. Its full snapshot and all arm contents contribute to the stimulus fingerprint. The [archetype and cohort guide](../../skills/stimulus-response-polling/references/archetypes-and-cohorts.md) explains authoring and expansion.

## Design and validate in human terms

Start with the source material, what the person wants to learn, and whose
perspective would help. The [study-design skill](../../skills/study-design/SKILL.md)
teaches the agent to propose tasks and a cohort without asking the person to
author graph JSON. Get approval of that human-language study design, then
translate it to the manifest. Validate the manifest, then use `poll_preview`
before creating the cohort to show the complete generic journey, including all
branches, stimulus reveals, task wording, choices, destinations, and shared
continuations. Each question includes route-specific prior choice meanings and
the stimulus IDs in scope; those IDs resolve to stimulus text in the preview.
A shared question is shown once with a context for each route that reaches it.
Preview requires neither a cohort nor a provider and makes no inference call.
It rejects previews above 10,000 route contexts rather than returning partial
output. After the cohort and exact run configuration exist, use `poll_check` to
validate them.

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
