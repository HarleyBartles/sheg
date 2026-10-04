# Respondent-local journey recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an author to explicitly resume a partial journey at a safely retryable respondent-local failed turn while preserving all successful work and the original call limit.

**Architecture:** Reuse the existing failed journey evaluation and frozen packet as the retry checkpoint. Keep the respondent's current turn identity and event/route history when a local failure settles, derive eligibility from persisted failed-turn and run safety state, then atomically reopen only that evaluation and restore its respondent as active. Preserve each failed physical attempt as history, and let the existing worker continue from the retried answer's valid route.

**Tech Stack:** TypeScript, SQLite, Node test runner, Sheg polling skill behavior fixtures.

**Spec:** `.agents/specs/2026-10-02-v0.3.0-dogfood-improvements.md`, especially sections 2 and 7.

**Execution Strategy:** `executing-plans` - lifecycle projection, transactional persistence, worker continuation, and their behavior tests depend on one shared state transition; executing inline keeps that state model coherent. Guidance and its source-owned scenario are part of the same behavior contract, with deterministic catalog tests in the repository gate and no live campaign in CI.

**Target version:** `0.3.0-dev.9` for the merge to `develop`.

## Global Constraints

- Keep the same run ID, frozen request, compiler identity, and original `maxCalls` on resume.
- Preserve answered evaluations, each respondent's events, route and reached-turn order, and every prior physical attempt.
- Retry only a known respondent-local failed evaluation whose respondent state still identifies that exact turn.
- Never retry an unresolved or uncertain attempt, resume after cancellation, exceed the original call allowance, or replay a completed respondent or successful turn.
- Reads and lifecycle inspection never launch work; only explicit `run_resume` launches the resumed worker.
- Report refusal reasons from the same durable facts enforced by the resume transaction.
- Keep skill campaign outputs and run databases outside the repository; never add a live behavior result or receipt.
- Do not add skill campaigns to CI or pre-commit; `npm run verify` runs deterministic tests only.
- Set `package.json` to `0.3.0-dev.9`; regenerate lockfile and plugin metadata through the build workflow.

## Review Focus

- A failed turn resumes with its original evaluation, packet fingerprint, compiler identity, respondent event history and route; cover in Task 1's store and worker tests.
- A successful respondent and successful earlier turns are never dispatched again; cover in Task 1's end-to-end worker test.
- Eligibility cannot overstate the actual transition for cancellation, unresolved attempts, exhausted allowance or a missing failed-turn checkpoint; cover in Task 1's lifecycle and resume tests.
- A failed retry remains a visible partial journey with both attempts retained; cover in Task 1's attempt-history test and Task 2's scenario expectations.

---

### Task 1: Resume a journey from its persisted failed turn

**Files:**
- Modify: `src/domain/run/lifecycle.ts`
- Modify: `src/domain/run/request.ts`
- Modify: `src/infrastructure/run-store.ts`
- Modify: `src/application/question-worker.ts`
- Test: `test/run-store.test.ts`
- Test: `test/run-service.test.ts`
- Test: `test/mcp.test.ts`
- Test: `test/question-worker.test.ts`
- Create: `docs/decisions/0026-resume-failed-journey-turns.md`
- Modify: `docs/decisions/README.md`

**Interfaces:**
- `RunLifecycleFacts` must receive sufficient durable facts to identify a partial journey with an eligible failed respondent turn, in addition to existing cancellation, reserved-call, allowance and retryable-work facts.
- The journey respondent's `currentNodeId`, `currentTurnId`, and `currentContextId` identify the failed turn when its status is `failed`; its `events` and `route` remain unchanged by failure and resume.
- `RunStore.resume(runId, nowMs)` remains the atomic enforcement point. For an eligible partial journey it reopens only the persisted failed evaluation for the respondent checkpoint, restores that respondent to `active`, retains its failed attempts, and leaves every other row and the original call limit intact.
- The worker reserves that same evaluation and uses its frozen packet. After a valid answer, the normal journey transition records the answer and route, then appends the next reached turn. A retry failure leaves the same checkpoint available only if the normal safety gates still hold.

- [ ] **Step 1: Add a failing lifecycle test for a partial journey checkpoint**

In `test/run-store.test.ts`, build an accepted durable journey, settle one respondent-local failure after recording a previous answered turn, then finish the run. Assert that `status` is `partial`, `lifecycle.state` is `stopped`, `lifecycle.resume` is eligible when allowance remains, and its refusal reasons remain accurate for cancellation, reserved calls, exhausted allowance and absent failed work. Run the focused test and confirm the intended failure is the existing `partial_journey` refusal.

- [ ] **Step 2: Add failing transactional resume assertions**

Extend the same store behavior test to capture the failed evaluation ID, context ID, packet fingerprint, respondent events and route, successful sibling state, and failed attempt page before resume. After `store.resume`, assert that the same run and maxCalls remain, only the failed evaluation becomes pending, the failed respondent becomes active at the exact prior turn/context/node with revision advanced, every answer/event/route and successful sibling is unchanged, and the original failed attempt remains visible. Also assert `reserveNext` returns only that original failed evaluation and its original frozen packet.

- [ ] **Step 3: Run the store tests and witness the expected failures**

Run: `node --import tsx --test --test-name-pattern="partial journey|journey.*resume" test/run-store.test.ts`
Expected: the new eligibility assertion fails on `partial_journey`; the transactional assertions fail because failed journey state currently discards the current turn and resume does not reactivate it.

- [ ] **Step 4: Implement the smallest durable checkpoint and eligibility change**

Update respondent-local settlement in `question-worker.ts` to preserve the failed evaluation's current turn, node and context IDs while marking the respondent failed. Extend lifecycle facts/projection and the schema union with a specific partial-journey refusal where needed, deriving eligibility only when the run has a respondent-local failed evaluation with a matching failed respondent checkpoint. In `run-store.ts`, atomically reopen only that exact failed evaluation and restore its respondent to active; retain evaluation identity, packet fields, event/route JSON, attempts and maxCalls. Refuse partial journeys whose failed row has no matching checkpoint. Keep run-scoped and interrupted recovery behavior unchanged.

- [ ] **Step 5: Run the focused store tests and verify they pass**

Run: `node --import tsx --test --test-name-pattern="partial journey|journey.*resume" test/run-store.test.ts`
Expected: PASS for exact failed-turn eligibility and reactivation, with refusal for cancellation, unresolved attempts, exhausted allowance and missing checkpoint.

- [ ] **Step 6: Add a failing durable worker continuation test**

- Extend `test/question-worker.test.ts` using the real run store and worker with a deterministic provider: respondent A answers an earlier node then fails at a reached node; respondent B completes its path; explicit service resume retries A's failed node successfully and follows the returned branch. Assert only A's failed node is dispatched on resume, B is never called again, earlier successful A nodes are not repeated, A's previous events/route remain in order, the resumed packet and compiler identity are unchanged, the new branch appears only after retry success, the run ID/maxCalls remain the originals, and both the failed and successful retry attempts remain readable. Add a second case where the retry fails and the run remains partial with both attempts exposed.

- [ ] **Step 7: Run the worker test and witness the expected failure**

Run: `node --import tsx --test --test-name-pattern="resumes only the failed journey turn|failed journey retry" test/question-worker.test.ts`
Expected: FAIL because the current worker cannot claim a failed respondent's preserved turn and partial journeys are refused.

- [ ] **Step 8: Complete lifecycle schema and MCP-visible resume behavior**

Adjust lifecycle reason schemas and MCP tests only as needed so status, query, and explicit `run_resume` expose a consistent eligible/refusal state. Verify readiness checks happen before the resume transition; simultaneous resume requests launch at most one worker; a rejected or unavailable credential does not mutate the checkpoint; and a resumed launch failure remains visible under the same run ID. Do not add automatic retry on reads.

- [ ] **Step 9: Run focused service, MCP, and worker tests**

Run: `node --import tsx --test test/run-store.test.ts test/run-service.test.ts test/mcp.test.ts test/question-worker.test.ts`
Expected: PASS with existing poll resume semantics unchanged and partial journey recovery covered through the public tool contract.

- [ ] **Step 10: Record the durable recovery contract**

Create ADR-0026 with status Accepted and date `2026-10-04`. Record the context, options (refuse partial journeys, restart the whole respondent, or resume the exact saved failed turn), decision to resume only the exact failed turn from its persisted packet/checkpoint, and consequences for attempts, allowance, lifecycle refusal and unchanged prior history. Add it to `docs/decisions/README.md` without editing ADR-0019 or ADR-0024 history.

- [ ] **Step 11: Commit Task 1**

Commit the tested lifecycle, storage, worker, MCP, tests and ADR together with message `feat: resume respondent-local journey failures`.

- [ ] **Step 12: Mark Task 1 done against its commit base**

Run: `bash scripts/task-done <plan-file> 1 <BASE_FROM_TASK_START> -- npm test -- test/run-store.test.ts test/run-service.test.ts test/mcp.test.ts test/journey-worker.test.ts`
Expected: ledger records Task 1 complete after the exact focused command passes.

### Task 2: Teach and pressure-test explicit partial-journey recovery

**Files:**
- Modify: `skills/stimulus-response-polling/references/run-and-recovery.md`
- Modify: `skills/stimulus-response-polling/references/interpret-results.md`
- Modify: `skills/stimulus-response-polling/tests/behavior/scenarios.json`
- Modify: `skills/stimulus-response-polling/tests/behavior/evaluators.json`
- Test: `test/skill-testing/campaign-suites.test.ts`
- Modify: `package.json`, `package-lock.json`, generated `plugin.json`/`dist/` only through the canonical build

**Interfaces:**
- Guidance describes partial journey eligibility and refusals from the returned lifecycle; an agent calls `run_resume` only after the user explicitly wants continuation and `resume.eligible` is true.
- The new source-owned behavior scenario requires inspection of journey progress and attempts, a clear explanation of the saved failed turn and preserved respondents, then an explicit user request before the actor calls `run_resume`.
- The evaluator's private tool checkpoint distinguishes explanation from mutation: no resume call before explicit authorization; exactly one `run_resume` after authorization when eligible; no extra `run_start`.

- [ ] **Step 1: Add the source-owned behavior scenario and evaluator**

Add one focused scenario under `tests/behavior/scenarios.json` using frozen evidence for a partial journey: one respondent completed, one has a prior answer and route plus a failed reached turn, original allowance remains, and no attempt is unresolved. Script a first user turn asking what happened and whether progress is safe; the expected tool trace is read-only inspection. A second user turn explicitly asks to continue; only then is `run_resume` expected. Add evaluator criteria for exact preserved progress, the failed turn to retry, original call allowance, safe retry boundaries, no replay of completed work, and no retry before the second turn. Keep the scenario generic rather than tied to Portfolio.

- [ ] **Step 2: Add a deterministic contract test for the scenario checkpoint**

Extend `test/skill-testing/campaign-suites.test.ts` to load the new scenario and assert the ordered turns and tool checkpoint expectations match: read/query tools on the explanatory turn and exactly one `run_resume` on the explicit continuation turn. The test validates fixture structure only; it must not dispatch an actor or judge.

- [ ] **Step 3: Run the focused harness test and witness RED**

Run: `npm test -- test/skill-testing/campaign-suites.test.ts`
Expected: FAIL because the suite does not yet contain the new scenario/checkpoint contract.

- [ ] **Step 4: Update current user-facing recovery guidance**

In `run-and-recovery.md`, remove the claim that every partial journey is refused and explain that only a known respondent-local failed reached turn is eligible under lifecycle conditions. State that explicit resume keeps the same run ID and allowance, preserves answers/routes/exposures and failed attempt history, retries only the failed turn, and can proceed down a newly valid branch only after success. Keep refusal guidance for cancellation, uncertain attempts, exhausted allowance and missing retryable work. In `interpret-results.md`, explain that a partial run may resume without converting failed, pending or unreached evaluations into negative answers; require explicit user intent before `run_resume`.

- [ ] **Step 5: Run the focused harness test and verify GREEN**

Run: `npm test -- test/skill-testing/campaign-suites.test.ts`
Expected: PASS with the new deterministic source-fixture contract.

- [ ] **Step 6: Set the deliberate development version and regenerate**

Set `package.json`'s sole authored version to `0.3.0-dev.9`, update `package-lock.json` through `npm version 0.3.0-dev.9 --no-git-tag-version`, then run `npm run build` to regenerate plugin metadata and packaged runtime. Do not tag or publish a release.

- [ ] **Step 7: Verify the final repository gate and generated version**

Run: `npm run build`
Expected: PASS; confirm package, lockfile root/package entries, MCP initialization identity, plugin metadata and built runtime all report `0.3.0-dev.9`. The Task 2 commit's tracked pre-commit hook runs `npm run verify` against the staged snapshot; no skill actor/judge runs.

- [ ] **Step 8: Commit Task 2**

Commit guidance, skill-owned scenario/evaluator, deterministic harness coverage, version source and generated build outputs with message `docs: teach safe partial journey recovery`.

- [ ] **Step 9: Mark Task 2 done against its commit base**

Run: `bash scripts/task-done <plan-file> 2 <BASE_FROM_TASK_START> -- node --import tsx --test test/skill-testing/campaign-suites.test.ts`
Expected: ledger records Task 2 complete after the focused deterministic fixture-contract test passes; the commit hook is the canonical full gate.
