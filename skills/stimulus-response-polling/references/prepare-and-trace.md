# Prepare and trace a file-backed journey

This reference describes the file-backed journey CLI. MCP tools use inline requests; `run_inspect` validates their fit and call bounds without inference but does not return a complete journey preview.

Use this workflow to validate inputs, inspect stimulus and task boundaries, or debug a graph route without model inference.

1. Read the version `2.0` study manifest and version `3.0` respondent cohort, using their [machine-readable schemas](../assets/study-manifest.schema.json) and [cohort schema](../assets/respondent-cohort.schema.json). Check the cohort rationale and respondent fit to the study question. Do not silently edit or replace the cohort.
2. Inspect each arm's source, item order, tasks, response options, optional answer key, and presentation. Verify stable Choice IDs and valid answer keys. Graph edges must cover every Choice option, or every Score/Noul response through non-overlapping typed intervals. Confirm intended material exposure, reachable terminals, and a decision ceiling.
3. For matched arms, confirm that shared `comparisonKey` values refer to the same question construct and that reused option IDs keep the same meaning. Treat all other options as not directly comparable.
4. Run `node dist/cli.js check --config study-run.json`. The config supplies `manifestPath`, `cohortPath`, `outputDirectory`, `provider`, `maxCalls`, and optional `concurrency`. This validates and fingerprints inputs without inference.
5. Run `node dist/cli.js trace --manifest study.json --cohort cohort.json --arm <id> --respondent <id> --choices <a,b,...>`, or replace `--choices` with `--responses <json-array>` for typed responses. A scripted trace is route evidence, not respondent evidence.

Use `sequence` when all items precede all tasks. Use a graph to interleave material and questions, even on a straight route, or to branch by responses. CLI `start` runs inference; it is not a validation shortcut. The CLI exposes neither a `preview` command nor draft-variant batching.

## Provider context preflight

Run CLI `preflight` with the study manifest, frozen cohort, and every configured provider you want to compare. For a provisional profile-size sample, omit the cohort and select `maximum-profile`; it uses one synthetic profile with 1,500 characters across the allowed prose fields. Its `basis` is `synthetic-profile`: a `fit` means this sample fits, not that every valid character mix will fit. A frozen-cohort result checks every path for the exact provided respondents. The CLI equivalent is:

```sh
node dist/cli.js preflight --manifest study.json --cohort cohort.json --providers providers.json
node dist/cli.js preflight --manifest study.json --mode maximum-profile --providers providers.json
```

Preflight follows every valid response path for every respondent and arm. One overflow means that provider does not fit the measured cohort or sample under the configured limits. An incomplete walk or unavailable measurement is reported as unverified, never as fit. Results name the respondent, arm, path, and decision for each overflowing packet. Preflight does not create a run or contact an inference endpoint. `configuration` reports whether required settings or Jev credentials are present; `availability` is unverified because no endpoint is contacted. The result includes input and provider execution fingerprints so a saved fit can be matched to its study, respondent basis, compiler, and provider settings. Traversal stops as unverified at 100,000 packets or 16 MiB of serialized packet data.

See [packet budgeting](../../study-design/references/packet-budgeting.md) for packet contents, cumulative material and answer-history rules, and provider-specific measurement. When variable response history prevents a complete fit walk, preflight reports unverified; each actual packet still undergoes admission before inference.
