# Prepare and trace a file-backed journey

This reference describes the multi-stage journey CLI, not the current MCP run
tools. For the direct MCP request, build an inline request and use
`run_inspect`.

Use this workflow to validate inputs, inspect stimulus and task boundaries, or debug a graph route without model inference.

1. Read the version `2.0` study manifest and version `3.0` respondent cohort, using their [machine-readable schemas](../assets/study-manifest.schema.json) and [cohort schema](../assets/respondent-cohort.schema.json). Check the cohort rationale and respondent fit to the study question. Do not silently edit or replace the cohort.
2. Inspect each arm's source, item order, tasks, response options, optional answer key, and presentation. Verify that task option IDs are stable, answer keys refer to offered options, and graph edges cover each offered option. Confirm that only intended material is presented before each task and that the graph has reachable terminals and a decision ceiling.
3. For matched arms, confirm that shared `comparisonKey` values refer to the same question construct and that reused option IDs keep the same meaning. Treat all other options as not directly comparable.
4. Call `sheg check` with the manifest, cohort, output directory, explicit provider, and budgets. This validates and fingerprints inputs without a provider call.
5. Use the CLI `trace` command with an arm ID, frozen respondent ID, and scripted option IDs to debug a route. A scripted trace is graph evidence, not respondent evidence.

Prefer `sequence` when the study presents all bounded items then asks its tasks. Use graph presentation only when conditional exposure or branching is itself part of the research design. Do not use CLI `start` as a validation shortcut. If the check or trace suggests simulated response evidence may help, read [run and recovery](run-and-recovery.md) before deciding whether to start a direct request.
# Provider context preflight

Run CLI `preflight` with the study manifest, frozen cohort, and every configured
provider you want to compare. For a provisional profile-size sample,
omit the cohort and select `maximum-profile`; it uses one synthetic profile
with 1,500 characters across the allowed prose fields. Its `basis` is
`synthetic-profile`: a `fit` means this sample fits, not that every valid
character mix will fit. A frozen-cohort result checks every path for the exact
provided respondents. The CLI equivalent is:

```sh
sheg preflight --manifest study.json --cohort cohort.json --providers providers.json
sheg preflight --manifest study.json --mode maximum-profile --providers providers.json
```

Preflight follows every valid response path for every respondent and arm. One
overflow means that provider does not fit the measured cohort or sample under
the configured limits. An incomplete walk or unavailable measurement is
reported as unverified, never as fit.
Results name the respondent, arm, path, and decision for each overflowing
packet. Preflight does not create a run or contact an inference endpoint.
`configuration` reports whether required settings or Jev credentials are
present; `availability` is unverified because no endpoint is contacted.
The result includes input and provider execution fingerprints so a saved fit
can be matched to its study, respondent basis, compiler, and provider settings.
Traversal stops as unverified at 100,000 packets or 16 MiB of serialized
packet data.

Laya uses the pinned tokenizer and configured 1,024-token limit. Jev's
`typesafe/jev-1.13` estimate is `ceil(UTF-8 request bytes / 3)` with a 20%
reserve from its 32K context. The Jev count is an estimate, not provider usage.
