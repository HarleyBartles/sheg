# Prepare and trace a study

Use these steps when the user asks to validate inputs, inspect reader-facing material, or debug a graph route without running model inference.

1. Read the version `1.0` manifest and version `2.0` frozen cohort, using their [machine-readable schemas](../assets/study-manifest.schema.json) and [cohort schema](../assets/frozen-cohort.schema.json) for exact file shapes. Consult [archetypes and cohorts](archetypes-and-cohorts.md) if archetype selection or cohort authoring need review. Check the cohort rationale and profile fit to the study question. Do not silently edit or replace the cohort.
2. Inspect every reader-visible item, decision, offered label, reachable transition, terminal outcome, and decision ceiling. Check that optional content is only reachable through its intended graph edges. Only graph items are shown to readers; source files and hashes establish integrity.
3. Call `poll_check` with the manifest, cohort, output directory, explicit provider, and budgets. This validates and fingerprints inputs without a provider call.
4. Use `poll_trace` with a frozen reader ID and scripted choices to debug a route. A scripted trace is graph evidence, not reader evidence.

Do not use `poll_start` as a validation shortcut. If the check or trace suggests simulated-reader evidence may help, read [run and recovery](run-and-recovery.md) before deciding whether to start a poll.
