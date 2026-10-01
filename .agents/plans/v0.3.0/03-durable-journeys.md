# Durable authored journeys

Status: in progress.

> **For agentic workers:** Use `executing-plans` to implement this plan inline, task by task.

**Goal:** An agent can run a finite authored journey through the same durable run lifecycle as a direct question. Sheg records each respondent's reached turns, exact pre-question contexts, typed responses, exposures, and route outcomes so a later request can refer to the original state without replaying the journey.

**Issue:** [SHEG-7: Query recorded evidence and reuse respondents and turn contexts](https://linear.app/harleys-workspace/issue/SHEG-7/query-recorded-evidence-and-reuse-respondents-and-turn-contexts). The issue spans this journey foundation and the later query/follow-on plan. Its full description and the linked [agreed design](https://linear.app/harleys-workspace/document/v030-agreed-design-and-delivery-sequence-97646e0c367f) were refreshed before drafting.

**Current branch:** `codex/v0.3.0-release-spec`, based on `origin/develop` `3c5b2f00037634e24b5a4766d37004a699c43d2c`. Continue on this approved release branch after this plan is reviewed. Preserve the pre-existing untracked design sketch.

## User-visible exit

An agent supplies inline respondents and a finite authored sequence or graph. Sheg validates and accepts the request as a durable run, then executes reached decisions in a detached worker. The same run records which material was exposed, each respondent's typed response and stable turn/context identity, the route taken, and whether work completed, failed, or was not reached. A later query plan will expose selectors and input-compatible reuse; this plan makes the evidence durable and identifiable without adding a study registry or requiring manifest/cohort files.

The single-question request remains supported. It shares the same provider, durable run identity, attempt ceiling, cancellation, explicit resume, and datastore. Journeys do not auto-resume, replay completed provider calls, or increase the original physical-call allowance.

## Proposed contract and design boundaries

- Add a direct inline journey request using existing `StudyArm`, `StudyPresentation`, `StudyTask`, `StimulusItem`, and respondent profile semantics. The request owns its provider and `maxCalls`. No create-study, register-primitive, clone-study, or filesystem manifest prerequisite.
- Preserve finite graph validation and typed Choice, Score, and Noul meanings. Each ask node currently runs one authored question. Independent question groups belong to SHEG-6 and a later plan.
- Freeze authored inputs and identities at run acceptance. Persist actual respondent-visible context per reached ask occurrence, including exposure and intentionally supplied response history. Keep selection rationale and lineage outside provider packets.
- Persist graph progress so recovery resumes from saved state. Model calls remain outside SQLite transactions. Persist an answer, its attempt accounting, and the resulting journey transition so a crash cannot lose a completed answer or route twice.
- Materialize only reached evaluations. Do not execute alternate branches or create every possible path as paid work. Report completed, failed, pending, and unreached work honestly; never count a departure as a lost-interest response unless the journey asked and recorded that typed answer.
- Use the existing durable worker, lease fencing, cancellation, `run_resume`, and attempt-limit rules. A respondent whose answer is needed to choose a route cannot continue past a failed decision; unaffected respondents may proceed.
- Reuse the pure journey/packet compilation behavior where it fits, but do not preserve a second authoritative MCP execution manager. The existing file-backed CLI's supported behavior must be accounted for; do not remove it until an equivalent accepted path exists or the plan demonstrates it is superseded.
- Since the current SQLite format is pre-v1 and this plan changes durable state, select a new current schema version and return explicit export/reset guidance for an unsupported existing format. Add no migrations or compatibility shims.
- No query criteria, follow-on request resolution, source-run deletion dependencies, independent question groups, offered material choices, provider batching, or paid-provider smoke calls in this plan.

## Readiness findings

- [x] Full SHEG-7 and linked design retrieved from Linear before planning.
- [x] Existing request shape is a one-question `poll`; existing SQLite store persists a fixed list of evaluations and attempt rows.
- [x] `src/domain/journey/run.ts`, `src/domain/journey/packet-walker.ts`, and `src/domain/journey/trace.ts` already define validated finite journeys and prompt-state compilation for the file-backed runner.
- [x] The current detached question worker and SQLite run store own one accepted request across MCP connections. ADR-0018 and ADR-0019 make SQLite and detached workers the accepted boundaries.
- [x] Review the proposed dynamic reached-turn persistence and result semantics with the user before implementation. Approved in the active release-roadmap instruction on 2026-10-01.

## Execution tasks

### Task 1: Define direct journey request and shared admission

- [x] **Files:** `src/domain/run/request.ts`, `src/application/run-inspection.ts`, shared journey packet/boundary types, and relevant journey/inspection tests. **Produces:** strict inline run-request variants for direct questions and finite journeys, with one shared validation/admission boundary. MCP `run_start` wiring remains in Task 4 so no journey request is exposed before durable execution exists.
- [x] Add behavior tests first for inline sequence and branching graph requests, duplicate identities, invalid destinations, typed route semantics, per-respondent reachable packet-fit inspection, finite logical decision bounds, and original physical `maxCalls` validation.
- [x] Preserve the existing direct-question request path. Inspection remains optional and inference-free; the shared admission result is ready for `run_start` wiring in Task 4.
- [x] Decide and test the exact request discriminator and composition from existing domain types. Keep JSON direct and agent-authored; do not introduce a second study/session identity.

### Task 2: Persist reached turn state and stable references

- [x] **Files:** `src/domain/run/lifecycle.ts`, `src/infrastructure/run-store.ts`, `test/run-store.test.ts`. **Produces:** durable respondent journey state, ordered exposure/response evidence, per-turn context references, and dynamically reached evaluation rows.
- [x] Add tests first for exact frozen packet/context contents, stable turn/context IDs, repeated task identity at separate ask nodes, route state surviving reopen, per-respondent isolation, explicit terminal/unreached states, and rollback of an answer/transition update on storage failure.
- [x] Persist reached turns and retain exact original typed answers, distributions, available confidence, attempt rows, material identity, and route outcome. Keep different respondents' histories separate.
- [x] Keep provider calls outside storage transactions. The atomic journey settlement records its answer, typed route, revision, next reached evaluation, and attempt accounting exactly once.
- [x] Bump the pre-v1 schema to version 2. Unsupported older datastores return export/reset guidance; no migration path is added.

### Task 3: Execute and recover journeys in the detached worker

- [x] **Files:** `src/application/question-worker.ts`, `src/infrastructure/run-store.ts`, `src/domain/journey/run.ts`, and worker/store behavior tests. **Produces:** finite sequence/graph execution over the durable store with run-wide physical attempt accounting.
- [x] Add tests first for exposure order, exact question context, Choice/Score/Noul routing, reconvergent paths, respondent-local failures, run-wide provider failures, cancellation during a call, no answer replay after explicit resume, and saved graph-state continuation.
- [x] Reuse a stable occurrence identity per reached ask node/respondent; retain route and context evidence needed to distinguish the same authored task at distinct nodes.
- [x] Keep calls serial under the current physical attempt contract. Do not introduce parallel-question batching, sibling-answer visibility, automatic retries, or startup recovery.
- [x] Verify both the original simple poll and new journey execution use the same ownership, cancellation, credential, attempt and explicit-resume rules. Packaged killed-worker resume remains in Task 4.

### Task 4: Expose journey requests and durable turn answers through MCP

- [ ] **Files:** `src/application/run-service.ts`, `src/entrypoints/mcp.ts`, MCP/service tests, copied-package tests, README, and the shipped polling/run-recovery skill. **Produces:** strict request inspection/start for journeys and machine-readable turn/route answer details with reusable identifiers.
- [ ] Add MCP tests for invalid request errors, accepted durable identity, answer pagination, explicit resume, status/answer recall across connections, and the absence of automatic replay.
- [ ] Extend a copied-distributable test to execute a branching journey against a local fixture endpoint, close the requesting MCP, and retrieve the reached path and turn IDs from a second MCP. Include a killed-worker resume path without paid provider calls.
- [ ] Teach agents how to distinguish departure, lost interest, unanswered/failed, and unreached stages. Explain that a turn/context reference can be used by a later request only when a later query/composition tool exposes it; do not claim that selector queries are delivered here.
- [ ] Build packaged `dist/`; update contracts if affected. Keep source canonical.

### Task 5: Review and close out this slice

- [ ] Review the complete diff against SHEG-7, this plan, ADR-0018/0019, and the epic. Fix substantiated Critical/Important findings inline; no delegation under the issue contract.
- [ ] Run focused domain/store/worker/MCP/package behavior tests, then the tracked staged-snapshot `npm run verify` hook. Confirm generated consistency and intended staged changes.
- [ ] Update the roadmap with the committed head, copied-package evidence, verification, review outcome, and remaining SHEG-7 query/follow-on obligations.
- [ ] Keep SHEG-7 open; its query, reusable reference selection, and following-plan scope remains for Plan 4.

## Handoff and review request

The issue itself authorized planning only until this plan was reviewed. The user has now approved the roadmap execution and this plan through the active goal. Implement inline on `codex/v0.3.0-release-spec`; feature PRs target `develop`. Do not change the release version, tag, publish, merge, or make paid calls under this plan.
