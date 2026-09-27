# Prepare and trace a study

Use this workflow to validate inputs, inspect stimulus and task boundaries, or debug a graph route without model inference.

1. Read the version `2.0` study manifest and version `3.0` respondent cohort, using their [machine-readable schemas](../assets/study-manifest.schema.json) and [cohort schema](../assets/respondent-cohort.schema.json). Check the cohort rationale and respondent fit to the study question. Do not silently edit or replace the cohort.
2. Inspect each arm's source, item order, tasks, response options, optional answer key, and presentation. Verify that task option IDs are stable, answer keys refer to offered options, and graph edges cover each offered option. Confirm that only intended material is presented before each task and that the graph has reachable terminals and a decision ceiling.
3. For matched arms, confirm that shared `comparisonKey` values refer to the same question construct and that reused option IDs keep the same meaning. Treat all other options as not directly comparable.
4. Call `poll_check` with the manifest, cohort, output directory, explicit provider, and budgets. This validates and fingerprints inputs without a provider call.
5. Use `poll_trace` with an arm ID, frozen respondent ID, and scripted option IDs to debug a route. A scripted trace is graph evidence, not respondent evidence.

Prefer `sequence` when the study presents all bounded items then asks its tasks. Use graph presentation only when conditional exposure or branching is itself part of the research design. Do not use `poll_start` as a validation shortcut. If the check or trace suggests simulated response evidence may help, read [run and recovery](run-and-recovery.md) before deciding whether to start a poll.
# Provider context preflight

Run `poll_preflight` with the study manifest, frozen cohort, and every configured
provider you want to compare. The CLI equivalent is:

```sh
sheg preflight --manifest study.json --cohort cohort.json --providers providers.json
```

Preflight follows every valid response path for every respondent and arm. One
overflow means that provider does not fit the complete study. An incomplete
walk or unavailable measurement is reported as unverified, never as fit.
Results name the respondent, arm, path, and decision for each overflowing
packet. Preflight does not create a run or contact an inference endpoint.

Laya uses the pinned tokenizer and configured 1,024-token limit. Jev's
`typesafe/jev-1.13` estimate is `ceil(UTF-8 request bytes / 3)` with a 20%
reserve from its 32K context. The Jev count is an estimate, not provider usage.
