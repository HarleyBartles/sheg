# Release Integration and Draft PR Plan

> **For agentic workers:** Use `executing-plans` task-by-task. The current user authorized inline execution of the v0.3.0 roadmap and a Draft PR. Keep the work on the existing canonical `codex/v0.3.0-release-spec` branch based on `origin/develop`; do not delegate.

**Goal:** A copied packaged MCP can query a section-three departure, select exact authored source material, and ask an independent group of follow-on questions at that respondent's intended altered context, while keeping retained evidence usable after source-run deletion.

**Architecture:** Reuse durable run, query, follow-on and typed question-set contracts. Extend the existing package-level section-three behavior test so one local fixture execution proves the combined workflow; do not add another product primitive or change route semantics. Keep authored source lineage out of provider-visible state. The agent still owns criteria, candidate boundaries, question wording and interpretation.

**Spec:** `.agents/specs/2026-10-01-v0.3.0-epic-spec.md`, especially sections 4-7 and 11-12; full Linear issues SHEG-5, SHEG-6, SHEG-7, SHEG-8 and the linked agreed design. **Status:** completed-awaiting-retirement. Draft PR [#11](https://github.com/HarleyBartles/sheg/pull/11) is open against `develop` and attached to this Codex task. The authenticated `gh` route created it after the GitHub app connector returned 403. Its verified initial head is `7323b3a06fef13e52943e408c64905a335871626`; this plan/roadmap handoff commit will advance that head and will be verified before return.

**Branch boundary:** This is the last feature plan on the approved roadmap. It prepares the requested Draft PR targeting `develop`. It does not change package versions, create `release/0.3.0`, tag, publish, merge, or close active Linear issues before merge. Release preparation is a later authorized Gitflow step.

## User-visible exit

An agent can identify respondents who left at section three after selecting the exact section material, use the query's reusable respondent/context/material references to ask several independent questions, deliberately omit earlier history, and still retrieve the follow-on evidence after deleting the source run. The copied MCP package, generated contracts, skills and README all describe the same interface.

## Scope and exclusions

- Extend the existing copied-package section-three test to cover a mixed typed follow-on question set, respondent-local exact context, deliberate history omission, and retained lineage after source deletion.
- Check that query/inspection/result references and canonical skill instructions let an agent compose the follow-on without hand-authored study files or SQL.
- Remove only the two trailing EOF blank lines found by the whole-branch `git diff --check` review, if still present.
- Regenerate package outputs from canonical source when touched, run `npm run verify` and `npm run build`, and inspect the final package/diff.
- Reconcile the active Linear issues and project with the branch and Draft PR evidence. Keep canceled SHEG-9 and SHEG-10 canceled and SHEG-7 Done.
- Do not add paid provider calls; existing bounded pilots have established the relevant Jev integration, and this plan's integration test uses a local fixture.
- Do not add automatic material decomposition, relevance judgments, narrative summaries in MCP output, new response primitives, migrations, version bumps, or model-determinism research.

## Task 1: Prove the complete packaged follow-on question workflow

**Files:**
- Modify: `test/package.test.ts`

**Behavior:** Starting from the existing synthetic three-section journey, query the exact section-three departure and its linked source material. Compose an `omit-history` follow-on that uses the returned evaluation/context/material handles and includes five independent typed questions (Choice, Score and Noul). Use the local fixture provider and within the explicit physical-attempt budget. Verify each question receives the same respondent-local context, exact selected material and no earlier trajectory answers; verify sibling answers remain independent. Delete the source run and retrieve all follow-on answers plus frozen material lineage afterward.

- [x] First extend the behavior test so the five-question follow-on and shared-context assertions fail for the missing packaged end-to-end behavior.
- [x] Configure the fixture's responses by question ID and assert typed answer IDs/values, physical calls, exact material state, omitted-history state and denominator/status evidence.
- [x] Run `node --import tsx --test test/package.test.ts` and inspect that the copied `dist/mcp.js` runtime serves every MCP call.

## Task 2: Reconcile user guidance, generated package and branch review

**Files:**
- If needed modify: canonical `skills/study-design/`, `skills/stimulus-response-polling/`, `README.md`, and `test/package.test.ts`
- Regenerate only canonical projections affected by source changes.
- Remove the two EOF blank lines identified in `src/application/question-worker.ts` and `src/application/run-service.ts` if they remain in the branch diff.

- [x] Confirm skill guidance explains the agent's sequence: query explicit evidence, decide relevant respondents and candidate boundaries, compose independent questions at selected contexts, and interpret typed results. Do not prescribe an answer or imply Sheg chooses relevance.
- [x] Confirm the copied package loads its own `dist/` files and the generated request contracts/package contain `materialOptions` and `selectedMaterial` with no source metadata in provider state.
- [x] Run `npm run verify`, `npm run build`, and `git diff --check`. Inspect generated consistency and the copied package behavior after the final source changes.
- [x] Review the complete branch against the accepted spec, plans 1-7, repo doctrine, source-custody boundaries, provider notes, generated assets and verification evidence. Record Critical/Important/Minor findings; resolve Critical and Important findings before PR preparation.

## Task 3: Record final evidence and prepare the Draft PR

**Files:**
- Modify: this plan and `.agents/plans/v0.3.0/roadmap.md`
- External: open one Draft PR from `codex/v0.3.0-release-spec` to `develop`, then attach its URL to this Codex task.

- [x] Record implementation commit SHAs (`fce1524`, `faabf39`, `e484226`, `7c31b2e`, `83d1c8a`, `b9824f8`), `npm run verify`, `npm run build`, copied-package result, `git diff --check`, base SHA, and environment exception. The final docs handoff commit and remote head are checked in GitHub before return.
- [x] Re-read the active Linear issues and project. Record implementation evidence and Draft PR #11 on SHEG-5, SHEG-6 and SHEG-8; retain SHEG-7 as Done and SHEG-9/10 as Canceled. Do not mark the project completed or close active issues before merge; record the exact post-merge reconciliation boundary.
- [x] Confirm the working tree contains only intentional changes plus the pre-existing untracked design sketch. Stage intended files only and commit through the tracked hook.
- [x] Push the feature branch and create Draft PR #11 targeting `develop`. Use a reviewable title/body that explains the user-visible end-to-end capability and validation. Link relevant issues without auto-closing them before merge.
- [x] Attach the PR artifact, verify the PR remains draft and targets `develop`, and keep this plan `completed-awaiting-retirement` through the handoff. Merge and release publication remain separate.

**Validation and handoff evidence:** `npm run verify` passed 310 tests, lint, typecheck, and generated consistency; `npm run build`, `git diff --check`, and `node --import tsx --test test/package.test.ts` (6 tests) passed. The tracked hook passed 310 tests for commits `b9824f8`, `aca8733`, and `7323b3a`. The branch starts at `origin/develop` SHA `3c5b2f00037634e24b5a4766d37004a699c43d2c`. `gh pr view 11` confirmed title, OPEN state, `isDraft: true`, base `develop`, branch `codex/v0.3.0-release-spec`, and initial head `7323b3a06fef13e52943e408c64905a335871626`. PR #11 is attached to the Codex task. The zero-run pilot SQLite file remains in the OS temporary directory after the local safety layer blocked cleanup; Sheg-level deletion and integrity were verified. The original design sketch remains the only untracked worktree file.

## Plan boundary

This plan demonstrates and hands off the approved v0.3.0 feature branch. It does not perform release preparation, merge, version alignment, tagging, plugin ZIP publication or release/develop reconciliation. Those operations belong to a separately authorized release step after review.

## Post-handoff fresh review follow-up

A user-requested independent whole-branch review of head `2a6838f` found two actionable issues: post-commit storage optimization failure made a completed `run_delete` appear to fail, and `run_list` material filtering omitted source-linked catalog items retained only in follow-on lineage snapshots. Both behaviors now have regression tests that failed before the implementation change. Deletion results report optimization status separately from committed deletion, and discovery includes retained lineage material. The request-store tests pass; the repository gate and generated build were rerun before publication.

The next fresh whole-branch review of head `57bb747` found three more issues. Context provenance used the question-sensitive packet fingerprint, so sibling independent questions over one frozen state appeared to have different contexts; evidence now hashes the frozen respondent-visible state together with compiler identity, and tests prove siblings match while distinct respondent states differ. Confirmed pre-dispatch Jev failures consumed the reserved physical-call allowance; failed settlement now releases that reservation and charges only provider attempts reported by the typed adapter, while unknown failures and uncertain in-flight calls remain conservatively charged. A behavior test proves the same run resumes within its original one-call limit after a zero-attempt credential failure. Shipped guidance now describes `run_inspect` and deletion dry-runs as optional previews because execution and deletion validate their own requests. Local build and verification passed with 319 tests; full-head review found the remaining issues recorded below.

A subsequent whole-branch review of `4448f806d4af00d8a9b9735aa6f32c83a27dd5e2` found two additional Important gaps and one remaining Minor wording issue. `run_get` now offers a bounded `context` view keyed by a query's exact `{evaluationId, contextId}` handles and returns only that frozen packet with its provenance. Answered evaluations now link to the exact successful attempt through a constrained `evaluation_answer_attempts` relation; `run_get answers`, `run_query`, and follow-on source resolution read execution evidence through that relation rather than choosing an attempt by timestamp. The database schema version advances to 5; unsupported pre-v1 stores already receive explicit reset guidance. MCP and README instructions now make inspection and deletion previews optional. Tests cover exact context selection, handle mismatch, and retry evidence with tied settlement timestamps. Final repository validation, fresh whole-branch review and hosted CI are pending.

The review fixes passed focused MCP, worker and store tests, `npm run build`, `npm run verify` (321 tests), and `git diff --check` at head `6f5deed`. A fresh whole-branch review found that resume selected the latest run-scoped failure by timestamp and UUID, so tied timestamps could select an older failure and strand a newer one. Attempts now receive a monotonic datastore sequence used for resume selection and attempt-history pagination; the schema advances to version 6, consistent with the pre-v1 reset policy. The review also found stale skill guidance about resumable terminal statuses and direct one-question requests; both references now describe supported recovery and request shapes. A regression test reproduces the tied-timestamp failure with inverted UUID ordering, and a separate regression proves follow-on source resolution reconciles an expired worker lease before freezing source status and counters. A second fresh whole-branch review found stale follow-on source status when an expired worker lease had not yet been reconciled; `resolveFollowOnSources` now reconciles expired leases transactionally. Fresh whole-branch review at `6f5deed9396cc3be1dc6f1f670e531f445f5bd73` found no actionable issues. A final exact-head review at `8cc9f11991a53785abfdf17d6d72f33242bd27dd` found Minor documentation inconsistencies about multiple questions, packet counts, read-side reconciliation, and optional inspection, plus example Noul prompts that lacked true/false propositions and a PR description that mislabeled internal status lookup as paginated. The study-design and data-contract guidance now matches the MCP request and side-effect behavior, and Noul fixture questions now make explicit propositions. Local `npm run verify` passes all 321 tests, lint, typecheck and generated consistency, and `git diff --check` passes. Updating the PR description to remove the pagination claim, fresh tracked-hook validation, hosted CI, and another fresh whole-branch review at the corrected head remain pending.

The review of `0feeead09acc79e6a9bbe3f5c53ff778e27112c4` found an Important duplicate-journey-identity validation gap and Minor issues where terminal-entry journeys passed inspection without an initial ask and packet-budget guidance still described one packet per respondent. Journey validation now checks original item, task and graph-node identifiers before collection construction, admission rejects respondents without a root ask, and the guidance counts respondent/question evaluation packets. The whole-branch review of `aa93dc222839dba068cf59d3451730a6769cd4f3` found no Critical or Important findings and one Minor mismatch: the generated direct-request schema allowed empty Choice options. The generator now applies the existing nonempty Choice constraint to run-request and study-manifest schemas, and a shipped-contract test covers it. The tracked hook passed with 323 tests at `826614762191a6b78de4b472aa46eecbd14f02a8`. Hosted CI passed on `a0edbba7f34eb16b4096307cff4b0c253f027055` in run `37035828560`. The final whole-branch review of that exact head found no Critical, Important, or Minor findings; package/plugin/server version alignment remains deferred to release preparation.
