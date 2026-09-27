# Interpret study results

Confirm the run is completed before describing it as final. If it is running or interrupted, load [run and recovery](run-and-recovery.md) and report its current state.

Use `poll_report` to inspect each arm's intended, completed, and excluded respondent counts. Per task, distinguish reached, completed, reached-but-incomplete, and not-reached respondents. Show option distributions and optional answer-key scoring separately. Provider attempts are retries, not additional respondents.

Use `poll_compare` only with two arm IDs in the same report. The comparison pairs the same frozen respondents and aligns tasks by shared `comparisonKey` and occurrence order. It marks choices comparable only when both option IDs exist in both corresponding tasks. Do not compare reports across runs or claim causal lift when multiple treatment elements differ.

These are simulated profile-conditioned typed responses, not human research observations. Distinct respondent profiles create modeled variation, but profiles can remain correlated and System One models may be highly repeatable. Do not describe counts as independent votes, infer statistical significance, or present optional answer-key scores as human accuracy, calibration, readership, or publication readiness. State provider identity, incomplete cells, failures, and unknown charges where relevant.
