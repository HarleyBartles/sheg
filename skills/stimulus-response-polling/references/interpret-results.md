# Interpret study results

Confirm the run is completed before describing it as final. If it is running or interrupted, load [run and recovery](run-and-recovery.md) and report its current state.

Use `poll_report` to inspect each arm's intended, completed, and excluded respondent counts. Per task, inspect each `occurrences` entry separately. Its `reached`, `completed`, `incomplete`, and `notReached` values count respondents at that occurrence; repeated graph visits appear as occurrence 1, 2, and so on. Show option distributions and optional answer-key scoring separately. Provider attempts are retries, not additional responses.

Use `poll_compare` for two arms in one report. Use `poll_compare_runs` when comparing selected arms from separate reports; it requires an identical ordered cohort fingerprint and aligns responses by `comparisonKey` and occurrence. A response pair is comparable only when its type and authored task meaning match. Inspect its source, stimulus, task, provider, run-status, and completion differences beside the profile-group denominators and coverage. Groups reflect only declared archetypes and variations.

When reporting to the user, separate (1) what the run produced and who reached each task, (2) what that evidence suggests editorially about the artefact, and (3) the next useful question to ask. Offer a new task in the current journey or a clean-history rerun over the same frozen cohort when either fits. Do not imply cross-run history passthrough.

Distinct respondent profiles create modeled variation, but profiles can remain correlated and System One models may be highly repeatable. State provider identity, incomplete cells, failures, and unknown charges where relevant.
