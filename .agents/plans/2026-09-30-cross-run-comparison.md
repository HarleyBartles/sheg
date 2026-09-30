# Compatible Cross-Run Comparison Plan

**Status:** completed-awaiting-retirement

**Goal:** Compare two independently executed runs over the exact same frozen respondent cohort, preserving typed outcomes and refusing to align tasks whose authored meanings differ.

**Current code inspected:** `src/application/reports.ts` has typed per-respondent answers and within-run arm comparison, while report identity currently lacks a standalone cohort fingerprint. `src/entrypoints/cli.ts` and `src/entrypoints/mcp.ts` expose only within-run `compare`. The implementation will load existing durable reports and add a distinct cross-run comparison operation.

## Invariants

- Require an exact ordered cohort snapshot match, not merely equal cohort size or matching respondent IDs.
- Compare one explicitly selected arm from each report.
- Align task responses only by shared `comparisonKey` plus occurrence.
- A pair is comparable only when its typed task meaning matches: Choice option IDs/descriptions, ordered Score rubric, or Noul proposition/instructions and true/false criteria.
- Preserve paired, left-only, right-only, and non-comparable counts. Never coerce one primitive to another.
- Expose results by declared archetype and variation groups, with each subgroup's denominator and response coverage; do not infer demographics.
- Report stimulus/source/task, provider, run-status, and completion-denominator differences beside response comparisons.
- Cross-run comparison is descriptive and must not claim causal lift or statistical significance.
- Keep existing within-run comparison behavior and command/tool stable.

## Tasks

- [x] Add a deterministic report cohort fingerprint from the full frozen respondent snapshot and validate it in the report schema.
- [x] Add `compareRunReports(leftReport, leftArmId, rightReport, rightArmId)` with explicit arm selection, exact cohort check, typed meaning checks, and paired outcome summaries.
- [x] Expose `compare-runs` in CLI and `poll_compare_runs` in MCP, each accepting both output/run identities and both arm IDs.
- [x] Add tests for identical cohort acceptance, changed profile/order rejection, changed task meaning remaining unpooled, typed paired Score/Noul summaries, and declared profile-group denominators; verify old within-run compare remains unchanged.
- [x] Include source/stimulus/task changes, provider identity, run status, and arm completion denominators in cross-run output; test that these differences remain visible.
- [x] Update user guidance and ADR-0012 consequences, then run focused tests and `npm run verify`.

## Exit criteria

- Independent reports from an identical frozen cohort can be compared without creating A/B arms.
- Reports from a changed cohort are rejected before outcomes are aligned.
- Choice, Score, and Noul values remain typed and only equivalent meanings are compared.
- MCP, CLI, report schema, and consumer guidance expose the same behavior.
