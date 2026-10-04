# Expose Precise Failure and Lifecycle Evidence

**Goal:** Make run status and queried evidence explain what completed, what failed, what was represented by the query, and whether explicit recovery is currently possible.

**Target development version:** `0.3.0-dev.7`. Base: latest `develop` after Plan 4. This is a development candidate, not a stable release; no tag or publication is in scope.

**Authority:** `.agents/specs/2026-10-02-v0.3.0-dogfood-improvements.md`, sections 2 and 5; `.agents/plans/v0.3.0-dogfood-improvements/roadmap.md`; repository runbooks and playbooks.

## Current behavior

`run_query` returns `sourceStatus`, `sourceComplete`, and run-wide `coverage`, even when `questionId` narrows the returned items. `sourceComplete` is true only for `completed`; partial, failed, cancelled, and interrupted runs all report false without saying whether they are stopped, resumable, or require explicit resume. `RunService.resume` and `run-store.ts` maintain separate eligibility checks. Query items omit per-evaluation failure detail although `run_get` answers includes it. Validation retains generic failure codes/messages after `DecisionError` has already identified a safe typed-answer constraint. Query cursors freeze source status, completeness and whole-run coverage, so any revised public evidence must remain consistent across pages.

## Contract

- Preserve `sourceComplete` as the precise statement that the source run reached `completed`; add an explicit lifecycle/recovery projection instead of changing its meaning or adding contradictory booleans. It must distinguish active, stopped, complete, and whether a user may explicitly resume now, with a stable refusal reason when not.
- Compute resume eligibility once from the same persisted facts used by `run_resume`, including status, journey restrictions, cancellation, remaining allowance and reserved/uncertain attempts. Service preflight and store transition must agree; readiness failures remain provider readiness errors, not lifecycle eligibility.
- Add query-scoped coverage alongside existing run-wide coverage. For the exact filter criteria, report matched evaluations by status and represented respondent count, and enough selected-material counts to show which represented inputs were available. Preserve total run coverage. Keep call counts separate from respondent or input diversity.
- Make query items carry the same safe evaluation failure evidence as answers views. For typed-answer validation, preserve a bounded structured reason such as malformed shape, answer-type mismatch, unknown option, probability-key/sum error, score boundary, or score-legend mismatch, plus safe field/constraint detail where available. Keep that evidence available after explicit resume and in attempt history where it belongs. Never include credentials, raw provider responses, or unbounded untrusted content.
- Keep a page's lifecycle projection and query coverage tied to its captured source snapshot. Cursor validation, stale-run detection and subsequent pages must use that same snapshot; do not turn a cursor into a claim about current live state.
- Teach the polling skill how to distinguish stopped execution from incomplete selected evidence, how to interpret query-scoped and run-wide denominators, how to read safe failure reasons, and when an explicit resume can or cannot add evidence. Explain that repeated identical inputs do not create substantive coverage and that call totals are not input diversity.
- Do not change worker scheduling, silently resume on read, silently retry, alter existing answer meaning, or add a runtime duplicate detector. Skill campaigns remain explicit, transient, and outside CI/pre-commit. Ship source-owned behavior tests, not campaign results.

## Implementation sequence

1. Add or update focused tests first for a stopped partial run whose selected question is fully answered while an unrelated sibling failed; assert both run-wide and filtered coverage, explicit stopped state, and explicit recovery eligibility/refusal. Include an active/pending case and a paginated snapshot case so the contract is not only tested in the simplest completed run.
2. Define one typed lifecycle/recovery projection in the domain contract and derive it from the exact store state used by the resume transition. Refactor service and store to share the decision; preserve current resumable cases and refusal behavior. Tests must prove that reported eligibility matches an actual allowed/refused resume without launching a provider.
3. Preserve safe typed-answer validation reasons from decision validation through evaluation persistence, answers, query and attempt records as applicable. Add behavior tests for at least two distinct validation reasons and a successful sibling in the same provider group. Verify raw malformed provider payloads and secret-like values are not copied into public evidence.
4. Extend query evidence with filter-scoped evaluation status counts and represented respondents, retaining the current run-wide coverage. Freeze the added projection in cursor snapshots and validate that later pages remain tied to the original source version. Include selected-material representation only where exact saved linked material exists; do not infer content from an answer.
5. Update the stimulus-response-polling skill and its existing `partial-run-selected-question` and `typed-answer-failure` behavior scenarios. Make the agent explain what happened, which selected answers remain usable, whether explicit recovery is possible, and the relevant denominators. Keep scenario assertions about useful behavior and contract accuracy, not rewritten phrases.
6. Regenerate request/runtime/package outputs from source, update relevant MCP descriptions, and verify copied-package behavior. Bump `package.json`, both root `package-lock.json` version fields, `plugin.json`, and runtime identity to `0.3.0-dev.7` using the repository's version playbook.

## Likely files

- `src/domain/run/lifecycle.ts`, `src/domain/run/request.ts`, `src/domain/decision/decision.ts`, `src/domain/decision/validate.ts`
- `src/application/run-service.ts`, `src/infrastructure/run-store.ts`, `src/entrypoints/mcp.ts`
- `test/run-store.test.ts`, `test/run-service.test.ts`, `test/decision.test.ts`, `test/mcp.test.ts`, `test/package.test.ts`, plus the narrowest existing query/cursor tests
- `skills/stimulus-response-polling/SKILL.md`, relevant references and behavior scenario/evaluator fixtures under `skills/stimulus-response-polling/tests/`
- generated `dist/` and skill schema artifacts only through their canonical generators; package version files listed above

Confirm SQLite schema-version behavior before changing persisted evaluation fields. Preserve the repository's documented compatibility policy and avoid introducing migration machinery unless the current supported datastore contract requires it. Do not change provider dispatch, call reservation, or worker scheduling to improve the presentation of lifecycle evidence.

## Validation

Run focused decision, lifecycle, query/cursor, resume, MCP, and copied-package tests during implementation. Regenerate canonical outputs after source changes. The tracked pre-commit hook runs `npm run verify` against the staged snapshot and is the required full gate. Do not rerun a failed/flaky test to obtain a green result; diagnose and fix the cause. Do not add skill behavior campaigns to CI or pre-commit and do not store campaign outputs, reports, or trial receipts in the repository.

At completion, review the merged contract across status, `run_get` answers, `run_query`, pagination, explicit resume, generated schemas and installed skill guidance. Create a PR to `develop`; merge only after a fresh review and required checks pass. Retire this plan and update the live roadmap at the next successor ingress after confirming the merge is on `develop`.
