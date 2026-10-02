# Independent Question Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent can ask a mixed set of independent Choice, Score, and Noul questions over each respondent's exact shared context, including selected recorded turns, and later query or continue from individual answers without sibling leakage or duplicate physical-call accounting.

**Architecture:** Keep each logical answer as its own evaluation and queryable result, while representing one same-context question set and each physical provider request as shared records linked to those evaluations. Jev uses its published multi-question request shape; provider-aware admission measures actual request groups and splits only where the configured provider or fit requires it. A successful or partial batch records shared execution evidence once, settles each question independently, and resumes only unanswered questions.

**Tech Stack:** TypeScript, Zod, SQLite (`node:sqlite`), MCP SDK, Node test runner, packaged Codex plugin.

**Spec:** `.agents/specs/2026-10-01-v0.3.0-epic-spec.md`, especially sections 5, 6, 8, 10, 11, and 12; Linear issue SHEG-6 and the linked v0.3.0 agreed design.

**Execution Strategy:** `executing-plans` - request resolution, group packing, provider calls, physical-attempt ownership, answer persistence, and recovery share contracts and transaction boundaries. The user directed inline execution; one integrated context avoids parallel contract drift.

## Global Constraints

- Preserve the same frozen pre-group state for every independent question. No question sees sibling answers, another respondent, future material, or an unreached branch.
- Preserve typed Choice, Score, and Noul meanings, distributions, and available confidence. Missing evidence stays missing.
- A physical provider request, including a retry or uncertain interrupted call, consumes one `maxCalls` unit regardless of the number of questions it serves.
- Inspect and admit the exact physical request payloads. Never trim context, rewrite a question, or switch providers to make a group fit.
- Jev BYOK is the primary hosted route. Keep local Laya's existing limits explicit; do not impose them on Jev.
- Keep the native TypeSafe context-admission block until its limit is supported by evidence. Published parallel-question behavior is accepted; do not build a model-determinism test programme.
- Do not turn journey routing into sibling-question dependency. A journey node remains one decision; dependent questions are later requests that explicitly select a completed answer.
- Pre-v1 request/database changes need no backward compatibility or migrations. Reject old stores with clear export/reset guidance.
- Automated verification uses local fixtures and injected providers. The user has authorized one optional paid Jev smoke: at most one OpenRouter physical call for one synthetic respondent, one short synthetic material item, and one mixed three-question group, with `maxCalls: 1`; use an isolated temporary datastore and keep the credential and full response out of files and chat.
- Preserve the pre-existing untracked design sketch.

**Ruling from implementation:** `evaluationId` identifies a selectable answer;
`contextId` identifies the shared model-visible respondent state. Several source
answers can therefore point at the same context. For recorded, fresh-material,
and omit-history follow-ons, preserve each evidence reference but compose one
question group per respondent/context pair. Continue adds the selected answer to
the next trajectory, so each selected evaluation creates its own distinct input
context. Each selected source reference links to every output question in its
derived group. Sibling answers are never sent into another question's state.

## Execution context

- Worktree: `Z:\_agent-worktrees\sheg\codex\v0.3.0-release-spec`
- Branch: `codex/v0.3.0-release-spec`, based on current `origin/develop` at `3c5b2f00037634e24b5a4766d37004a699c43d2c`; feature PR target is `develop`.
- Initial status: only the pre-existing untracked `.agents/specs/2026-10-01-v0.3.0-design-sketch.md`; preserve it.
- Completed plans 1-4 are present only in this unmerged feature branch and have not arrived through `origin/main`; do not retire them in this slice.

## Review Focus

- A response with one malformed or missing answer must preserve its valid siblings and mark only the affected evaluations failed; cover this at the Jev adapter and worker/store boundaries.
- A worker interrupted after dispatch must consume one physical attempt for the whole in-flight request and must not turn uncertain answers into results; prove explicit resume uses remaining budget.
- A resumed partial batch must not send already answered question IDs again; cover a valid sibling plus a failed sibling followed by resume.
- If a combined packet overflows while each question fits, inspection must return a stable split plan and physical-call minimum; if any individual packet does not fit, inspection must reject it.
- Several source turns for one respondent have distinct contexts; batching must never combine them. Verify the actual request bodies have identical context only within each group.

---

## Task 1: Accept and identify independent question sets

**Files:**
- Modify: `src/domain/run/request.ts`
- Modify: `scripts/generate-contracts.ts`
- Test: `test/run-request.test.ts`
- Regenerate: schemas through `npm run contracts:build`; regenerate `dist/` through `npm run build`

**Interfaces:**
- Consumes: the current strict `DecisionQuestion` schemas, one-question `inlineRunRequestSchema`, and one-question `followOnRunRequestSchema`.
- Produces: nonempty `questions: DecisionQuestion[]` for direct poll and follow-on requests; stable question IDs are unique within each set. `inlineJourneyRequestSchema` and authored journey tasks remain unchanged. Each resulting evaluation remains identified by its own `evaluationId`, `questionId`, and group `contextId`.

- [x] Write failing request-schema tests for one and several questions, mixed Choice/Score/Noul types, duplicate question IDs, empty sets, and follow-on requests with repeated source contexts. Assert that journey requests still accept one task per ask node and do not gain a sibling-answer field.
- [x] Run `node --import tsx --test test/run-request.test.ts`; verify the multi-question cases fail because the current schemas accept only one question.
- [x] Replace both one-element tuples with nonempty question arrays and add uniqueness validation. Remove the request-level check that equates `maxCalls` with respondent count; physical minimum belongs to provider-aware inspection in Task 3. Keep `maxCalls` a positive integer and retain the run fingerprint over the complete ordered question set.
- [x] Update inferred types and the generated request schema's validation rules to describe one or more independent typed questions. Do not add multiple legacy aliases or migration paths.
- [x] Run `node --import tsx --test test/run-request.test.ts`, `npm run contracts:build`, then `npm run build`; stage generated assets with their source.
- [x] Commit the request contract as `feat: accept independent typed question groups`.

## Task 2: Define shared provider request and answer contracts

**Files:**
- Modify: `src/domain/decision/decision.ts`, `src/domain/decision/provider.ts`, and `src/domain/decision/validate.ts`
- Test: `test/decision.test.ts`, `test/jev.test.ts`, `test/laya.test.ts`
- Regenerate: `dist/` through `npm run build`

**Interfaces:**
- Consumes: one frozen `state`, unique `DecisionQuestion` IDs, existing typed `DecisionValue` validation, and route/model identity.
- Produces: `DecisionBatchRequest = { state, questions }`; `DecisionBatchResult = { answers: Array<{ questionId, value: DecisionValue } | { questionId, failure: { code, message } }>, execution: ProviderExecutionEvidence }`. One `ProviderExecutionEvidence` object carries physical attempts, provider/model/checkpoint, latency, usage, and optional cost exactly once. Add optional `DecisionProvider.measureBatch` and `decideBatch`; providers without multi-question support continue through `measure`/`decide` one question at a time. A provider batch answer is validated against only its corresponding question; group-level transport/auth/envelope failures remain provider errors.

- [x] Add contract tests for complete mixed typed answers, unknown/duplicate answer IDs, result type mismatches, missing answers, and shared execution metadata kept outside per-question `DecisionValue`.
- [x] Run the focused decision tests and confirm the new group contracts fail before implementation.
- [x] Add strict request/result schemas and pure validation helpers. Invalid or absent response entries become question-scoped failures; a malformed shared response envelope remains a whole-request failure. Do not synthesize a missing answer, confidence, distribution, cost, or provider identity.
- [x] Run `node --import tsx --test test/decision.test.ts test/jev.test.ts test/laya.test.ts` and `npm run build`; commit as `feat: define independent provider batch contracts`.

## Task 3: Pack exact provider requests and inspect physical call requirements

**Files:**
- Modify: `src/application/run-inspection.ts`, `src/application/packet-sizing.ts` only where the request inspection projection is shared, and `src/domain/decision/provider.ts`
- Modify: `src/domain/run/lifecycle.ts`
- Test: `test/run-inspection.test.ts`, `test/run-service.test.ts`, `test/packet-sizing.test.ts`
- Regenerate: `dist/` through `npm run build`

**Interfaces:**
- Consumes: Task 1 ordered question sets, Task 2 provider batching/measurement capability, and the current inline/follow-on context resolver.
- Produces: a deterministic `QuestionGroup` for each respondent/context and a deterministic list of physical batches per group. One selected follow-on source turn creates one context group even when several turns have the same respondent ID. `Inspection.minimumCalls` equals the total planned physical requests; fits identify each group and its batch question IDs. A single-question overflow/unavailable measurement rejects admission; a larger Jev batch may split into smaller fitting batches without changing state or question content.

- [x] Test that questions in a group receive byte-identical state; different respondents and different source contexts produce separate groups. Verify source selection rationale and source-run identifiers never enter provider packets.
- [x] Test stable greedy partitioning in original question order: all questions fit one batch, overflow splits into the largest fitting prefixes, a singleton overflow rejects, and an unavailable group is not incorrectly treated as fit. Test `maxCalls` against planned physical batches, including multiple recorded turns per respondent.
- [x] Implement a pure stable batch planner. Providers advertising batch support measure the exact candidate request; providers without that capability produce singleton batches. The planner never changes the frozen state, typed question definitions, or selected provider.
- [x] Update inspection projections so the agent can see the selected question IDs per measured physical packet and the honest minimum physical-call count. Keep inspection keyless and inference-free.
- [ ] Run `node --import tsx --test test/run-inspection.test.ts test/run-service.test.ts test/packet-sizing.test.ts` and `npm run build`; commit as `feat: plan provider batches against frozen contexts`.

## Task 4: Add Jev multi-question transport and explicit local splitting

**Files:**
- Modify: `src/providers/jev.ts`, `src/providers/laya.ts`, `docs/providers/jev.md`
- Test: `test/jev.test.ts`, `test/laya.test.ts`, `test/jev-config.test.ts`
- Regenerate: `dist/` through `npm run build`

**Interfaces:**
- Consumes: Task 2 batch contracts and Task 3 exact batch measurement.
- Produces: Jev's configured route posts one `questions` map containing all IDs in the admitted batch and parses mixed typed answers plus one shared usage/model/cost record. The pinned OpenRouter `typesafe/jev-1.13` route may batch under its existing measured context limit. The native TypeSafe route uses the same published request shape but remains blocked when context fit is unverified. Laya advertises singleton execution unless its local request contract independently proves batch support; this plan does not broaden it.

- [x] Add an injected-fetch test for one OpenRouter Jev request containing mixed Choice, Score, and Noul questions over one state. Assert one request, exact question IDs/types, exact shared state, one physical attempt, typed answer separation, and shared usage/cost captured once.
- [x] Add provider tests where one requested answer is absent or malformed while siblings are valid; verify only that answer returns a question-scoped failure. Test malformed shared envelope, route-wide authorization failure, and no key leakage as whole-batch failures.
- [x] Add a Laya test showing a group is split into singleton requests without changing question or state. Preserve tokenizer/context fit on each actual singleton packet.
- [x] Implement Jev group wire serialization, exact multi-answer validation, execution evidence parsing, and per-route batch support. Dispatch with `maxAttempts: 1` so each worker reservation bounds one physical request; use explicit resume for another call. Do not add SDK dependencies or change route inference rules.
- [x] Document the published Jev parallel-question request shape and the local singleton boundary. Preserve the native context-limit admission restriction and existing OpenRouter fit evidence.
- [x] Run `node --import tsx --test test/jev.test.ts test/laya.test.ts test/jev-config.test.ts` and `npm run build`; commit as `feat: batch independent Jev questions`.

## Task 5: Persist shared call evidence and settle per-question evaluations

**Files:**
- Modify: `src/infrastructure/run-store.ts`, `src/domain/run/request.ts`, `src/domain/run/lifecycle.ts`
- Test: `test/run-store.test.ts`, `test/run-service.test.ts`

**Interfaces:**
- Consumes: accepted logical question groups, planned physical batches, and `DecisionBatchResult`.
- Produces: schema version 4 with a logical question-group record, one physical-attempt record per dispatched HTTP request (including retries), and a join from each physical attempt to exactly the evaluations it served. Persist the shared request packet fingerprint and provider execution evidence once per physical attempt; keep typed result/failure/status on each evaluation. `AnswerRow` and evidence queries join the shared provider evidence for the exact answer attempt. Older schema versions return the explicit pre-v1 export/reset error; no migrations are added.

- [x] Add store tests proving one grouped physical attempt linked to N question evaluations increments `usedCalls` by one, while every answer retains a distinct evaluation ID and typed result. Verify query pages filter and return per-question evidence with the shared context and provider provenance.
- [x] Add atomic settlement tests for mixed valid/invalid response entries, request-wide auth failure, cancellation, and attempt settlement. A valid sibling remains answered when another question fails. Request-wide failure records one call and marks all members with the same safe failure scope.
- [x] Add an integration test showing a run with mixed question types can be inspected, accepted, queried by question ID, and reused in a follow-on without changing existing journey routing semantics.
- [x] Implement the group/attempt association and schema-v4 storage contract. Preserve WAL, ownership fencing, foreign-key checks, deletion integrity, pagination, source snapshot semantics, and one shared context ID per question group.
- [x] Update `run_get`, `run_query`, delete previews, and storage counts where their projections describe evaluations versus physical attempts. Keep physical attempt counts distinct from answer counts.
- [x] Run `node --import tsx --test test/run-store.test.ts test/run-service.test.ts`; commit as `feat: persist grouped answers and shared call evidence`.

## Task 6: Execute, interrupt, and resume question groups safely

**Files:**
- Modify: `src/application/question-worker.ts`, `src/application/run-service.ts`, `src/entrypoints/worker.ts`
- Test: `test/question-worker.test.ts`, `test/run-service.test.ts`, `test/package.test.ts`

**Interfaces:**
- Consumes: Task 3 batches, Task 4 provider group execution, and Task 5 store reservations/settlement.
- Produces: a worker dispatches one physical request for an admitted batch and stores all returned answer rows independently. On explicit resume, it selects only unanswered evaluations and re-plans their remaining questions against the same frozen context; completed answers are never resent. An uncertain in-flight batch consumes one call and yields no invented answers.

- [x] Test a mixed three-question group where two answers succeed and one fails validation, then resume. Assert the next provider request contains only the failed question ID, preserves its original context, keeps both saved answers, and spends the original remaining `maxCalls`.
- [x] Test cancellation while a batch call is in flight: settle the call once, save all valid returned siblings, dispatch no later batch, and expose correct counts.
- [x] Test worker death with a reserved multi-question attempt: reconciliation marks one physical attempt uncertain, leaves all unsaved logical answers unresolved, and a read never starts work. Explicit resume uses only remaining allowance and does not repeat saved results.
- [x] Implement worker flow for poll and follow-on groups while leaving each journey turn as one question. Bound dispatch to the run-wide `maxCalls`, settle ownership transactionally, and stop on shared credential/service failures.
- [x] Run `node --import tsx --test test/question-worker.test.ts test/run-service.test.ts test/package.test.ts`; commit as `feat: execute and resume independent question groups` (`a4e9675`). The complete repository gate passed after the Task 7 integration as well.

## Task 7: Expose and teach grouped requests through the packaged MCP

**Files:**
- Modify: `src/entrypoints/mcp.ts`, `README.md`, `skills/stimulus-response-polling/SKILL.md`, `skills/stimulus-response-polling/references/run-and-recovery.md`, and `docs/decisions/README.md`
- Create: `docs/decisions/0021-independent-question-groups-and-batched-attempts.md`
- Test: `test/mcp.test.ts`, `test/package.test.ts`, `test/stimulus-response.test.ts`
- Regenerate: contracts and `dist/` from canonical sources through `npm run build`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: MCP request schemas for question arrays; machine-readable inspection of exact planned groups and physical call minimum; per-question answer/query IDs and shared attempt evidence; `run_start`/`run_inspect` follow-ons accepting several independent questions. The shipped skill distinguishes same-state independent questions from dependent later questions and tells agents to resume/query per-question evidence.

- [x] Add behavior tests for mixed question arrays at a new cohort and exact recorded turns; one query selects a specific question answer, and a later dependent follow-on includes only the explicitly selected completed answer.
- [x] Add a copied-package test using a local fixture and no paid calls: run a typed group through MCP, query two different question IDs, interrupt/resume with preserved results, and confirm the package needs no checkout or local dependency directory. Cover local singleton splitting separately from Jev batch adapter tests.
- [x] Update MCP descriptions, schemas, README and canonical skill text with the observed call semantics, physical-call `maxCalls`, source-context handling, incomplete/partial group reporting, and `run_resume` behavior. Do not add prose verdicts or claim multiple respondents share state.
- [x] Add ADR-0021 for the shared question-group and physical-attempt evidence boundary; index it. No ADR is needed for routine packing implementation details.
- [x] Run `npm run contracts:build`, `npm run build`, and `node --import tsx --test test/mcp.test.ts test/package.test.ts test/stimulus-response.test.ts`; inspect generated schemas and copied package contents. The focused run passed after fixture correction; final `npm run verify` passed all 299 tests and generated consistency.
- [ ] Hosted OpenRouter pilot not run: this turn has no explicit authorization for a live inference call. Offline verification used only the local fixture; the pilot remains a release acceptance item.
- [x] Commit MCP, skill, documentation, ADR, and generated outputs as `feat: expose independent question groups through MCP`.

## Task 8: Review Plan 5 against SHEG-6 and close its JIT record

**Files:**
- Modify: `.agents/plans/v0.3.0/05-independent-question-groups.md`, `.agents/plans/v0.3.0/roadmap.md`
- Inspect: `.agents/specs/2026-10-01-v0.3.0-epic-spec.md`, the full SHEG-6 issue and linked design, all changed files and generated package

- [ ] Run focused behavior tests for the provider, question-group persistence/recovery, MCP, and copied package; record exact commands and results in this plan.
- [ ] Review the final diff against SHEG-6 and epic sections 5, 6, 8, 10, 11, and 12. Resolve any defect and rerun affected checks. Confirm no model-determinism tests, cost cap, local-limit global restriction, sibling leakage, or stale answer replay.
- [ ] Run `git diff --check`. Stage intended source, tests, canonical guidance, ADR, roadmap and generated projections; commit through the tracked hook. The hook runs full `npm run verify`; do not bypass it or immediately repeat its successful full gate.
- [ ] Update the roadmap with the implementation commits, full gate evidence, SHEG-6 remaining status, and Plan 6 as the next JIT capability. Keep Plan 5 `completed-awaiting-retirement` through the eventual completing PR.
- [ ] Record any remaining release obligations explicitly. Do not change product versions, publish, tag, merge, or close SHEG-6 until its full acceptance exit is delivered.

## Plan 5 boundary

This slice does not add offered-material selection, alter journey graph semantics, remove the native TypeSafe admission guard, change provider routes, set cost/spend budgets, or complete the entire release workflow. Plan 6 owns agent-authored source-linked offered choices. Plan 7 owns the combined section-three release acceptance, final package/release review, and the later authorized release preparation.
