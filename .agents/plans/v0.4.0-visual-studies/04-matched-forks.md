# Matched Forks Within Mixed-Provider Journeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one durable journey settle a reached cohort at an authored fork, copy each eligible pre-treatment context into every declared condition, run each isolated branch under one study-wide attempt allowance, and preserve matched provider, failure, recovery, and onward-history evidence.

**Architecture:** Extend the existing typed journey graph with deterministic `fork` control nodes whose named conditions point to branch entry nodes. A persisted barrier waits until the fork's upstream electorate has either arrived or become ineligible, then atomically snapshots each arrived context into stable branch identities and creates branch-local journey states; graph control may later converge, but respondent state and history remain separate by branch identity. Resolve each comparison lock against all ready condition packets before dispatch and reuse Plan 3's provider selector, accepted selection snapshot, attempt ledger, packet compiler, and study-wide `maxCalls`.

**Tech Stack:** TypeScript, Zod, Drizzle SQLite schema/migrations, Node test runner, current Jev/Laya/Clef adapters, generated MCP/CLI contracts, copied self-contained plugin validation.

**Spec:** `.agents/specs/2026-10-04-v0.4.0-visual-studies.md`, especially sections 2, 5-10, 12-13; dependency roadmap `.agents/plans/v0.4.0-visual-studies/roadmap.md`.

**Execution Strategy:** `executing-plans` with Native inline execution because graph semantics, fork barriers, provider locks, persistence, and recovery share one accepted-state model and transaction lifecycle.

## Global Constraints

- Preserve the released v0.3.0 text-only contract and schema-9 read/migration path; Plan 4 appends schema migration 14 and never edits migration 0000 or rewrites an already released migration.
- The agent authors fork boundaries, eligible branch conditions, comparison keys, material exposures, continuation rules, and provider overrides; Sheg never infers them from article text or silently assigns cohort members.
- A fork copies only contexts that actually reached the boundary after upstream selection is settled; respondents that failed, ended, or never reached it remain outside that fork's comparison basis.
- Prefix evaluations execute once; every branch has a stable branch identity, its own copied state and history, and no sibling treatment or answer can enter its packet.
- A shared graph node or later control convergence may reuse authored task definitions, but branch contexts, evaluations, histories, provider evidence, and outcomes remain distinct and never merge.
- Every authored equivalent question uses an explicit `comparisonKey`; matching is condition-local and must not depend on similar wording, ordinal coincidence, or runtime inference.
- Automatic provider choice uses the frozen Plan 3 catalogue and policy; each declared matched comparison resolves one common provider/model against all ready condition packets before any member dispatches, including pixel and no-pixel packets.
- Outside a declared equality lock, reached journey units remain eligible for independent provider resolution under the accepted catalogue and constraints; a branch boundary does not force a provider change.
- One run-wide physical-call allowance includes prefix calls, all reached branches, fitting batch splits, and retries; the system cannot solve a budget shortfall by changing the comparison or provider.
- Preserve exact packet/compiler fingerprints, pre-dispatch refusal with no attempt, dispatched-call uncertainty, successful counterparts, and respondent/branch-local recovery without replaying successful work.
- Topology call bounds are finite and conservative, include fork fan-out, and do not enumerate hypothetical response histories; arithmetic overflow is an admission failure.
- Keep provider I/O outside SQLite transactions, and keep all snapshot, fork-barrier, branch-state, turn, and evaluation writes atomic within their persistence owner.
- Generate runtime, MCP/CLI contracts, copied-plugin contents, and schemas only from canonical source and build scripts.
- Propose `0.4.0-dev.6` for this integration PR only after checking uniqueness on refreshed `origin/develop`; rebuild every derived version identity.

## Review Focus

- A respondent still upstream when another respondent reaches a fork is included only if that respondent later reaches the same boundary before the barrier closes; prove with two respondents completing the prefix in opposite worker orders and inspect the immutable member set.
- Two conditions with the same `comparisonKey` preserve equal question/rubric semantics while receiving different declared treatments; prove a mismatched typed question is refused before acceptance and a valid pair is reported as one declared comparison.
- The same respondent's branch evaluations can share respondentId and node/task definition but cannot share `branchId`, `contextId`, history, or packet fingerprint; prove by querying persisted packets after both answers differ.
- A comparison provider that fits one condition but not its sibling makes the entire comparison fail before the first dispatch; prove zero attempts and no provider unlock or fallback.
- A dispatched failure in one condition preserves successful counterparts and eligible recovery resumes only that branch under the saved provider and packet; prove attempt and result rows after process reopen.

---

## Current Code Seams

`src/domain/study/presentation.ts` owns graph node and transition schemas; `src/domain/study/arm.ts` validates IDs, materials, tasks, and graph reachability; `src/domain/study/task.ts` owns question meaning and `comparisonKey`.

`src/domain/journey/topology.ts`, `src/domain/journey/run.ts`, `src/domain/journey/packet-walker.ts`, and `src/domain/journey/route-bounds.ts` own graph normalization, reached traversal, packet readiness, and finite topology call bounds.

`src/domain/decision/prompt.ts` owns exposure/answer history compilation; `src/domain/run/request.ts` owns accepted provider lock member identity, including optional `branchId`; `src/domain/run/lifecycle.ts` owns durable run, state, evaluation, route, and attempt evidence shapes.

`src/application/run-inspection.ts` owns initial packet readiness, provider fit, call bounds, and accepted journey state; `src/application/question-worker.ts` owns turn claims, late provider selection, dispatch, and transitions; the accepted selection service and `src/application/run-service.ts` own snapshot persistence and resume.

`src/infrastructure/sqlite/tables.ts`, `src/infrastructure/sqlite/schema.ts`, `src/infrastructure/sqlite/commands/acceptance.ts`, `src/infrastructure/sqlite/commands/journey-transition.ts`, `src/infrastructure/sqlite/reads/journeys.ts`, and `src/infrastructure/sqlite/commands/` own schema 13, accepted initialization, atomic turn settlement, durable read validation, attempts, and run-wide call reservation.

`test/journey.test.ts`, `test/run-inspection.test.ts`, `test/question-worker.test.ts`, `test/run-store.test.ts`, `test/sqlite-schema.test.ts`, `test/schema-migration-path.test.ts`, `test/provider-selection.test.ts`, `test/automatic-provider-selection.test.ts`, `test/cli.test.ts`, `test/mcp.test.ts`, `test/package.test.ts`, and `test/skill-testing/` are the current behavior owners to extend only where the new contract is not already proved.

## Task 1: Add the Explicit Fork Graph Contract

**Files:** Modify `src/domain/study/presentation.ts`, `src/domain/study/arm.ts`, `src/domain/study/task.ts`, `src/domain/journey/run.ts`, `src/domain/journey/packet-walker.ts`, and `src/application/run-inspection.ts`; extend `test/journey.test.ts` and `test/run-inspection.test.ts` for fail-closed initial admission; regenerate the contract JSON Schemas and bundled `dist/` outputs from canonical source.

**Consumes:** Existing graph `expose`, `ask`, and `terminal` nodes, deterministic response transitions, globally unique task IDs, authored `comparisonKey`, and journey validation.

**Produces:** A strict graph node `{ id, kind: 'fork', conditions: [{ id, label, entryNodeId }] }`; at least two conditions are required, condition IDs are unique within the fork, and every entry target resolves to an existing node. Fork nodes have no ordinary transitions; graph reachability and cycle/max-decision validation traverse their condition entry targets as control successors. For each condition, validation computes reachable ask tasks up to terminals; a `comparisonKey` may occur at most once in that condition and may be shared with another condition only when instructions, response-history policy, decision type, ordered choice option IDs/text, answer-key option, Score rubric, or Noul criteria match. Task IDs, condition exposures, pixel/description bindings, and `materialOptions` may differ because they identify the declared treatment. Existing task IDs and node IDs remain globally unique within the journey. Fork nodes are control operations, not respondent decisions and not provider calls.

```json
{
  "id": "image-condition-fork",
  "kind": "fork",
  "conditions": [
    { "id": "image-present", "label": "Section four with image", "entryNodeId": "show-section-four-image" },
    { "id": "image-absent", "label": "Section four without image", "entryNodeId": "show-section-four-text" }
  ]
}
```

- [x] **Step 1: Add behavior tests that fail on the current graph contract.** In `test/journey.test.ts`, prove that a fork with two valid distinct condition targets parses, an empty or single-condition fork fails, duplicate condition IDs fail, a missing target fails, outgoing ordinary transitions from a fork fail, and duplicate `comparisonKey` tasks are rejected when instructions, response-history policy, or typed interpretation differ. Include a positive case where equivalent tasks with one shared key are reachable from two conditions and have distinct visual/material bindings. Also prove `runJourney` rejects a fork before invoking `ask`, `walkStudyPackets` returns `incompleteReason === 'Matched forks require durable runtime execution.'` with no emitted packets, and initial run inspection refuses the unsupported fork before accepting an initial evaluation.
- [x] **Step 2: Run the focused test and capture its RED.** Run `node --import tsx --test --test-name-pattern="matched fork|comparisonKey across fork" test/journey.test.ts` and the corresponding fork-matching test in `test/run-inspection.test.ts`; expected: failure because `presentationSchema` has no fork discriminator, `arm.ts` rejects all duplicate keys, and initial inspection treats the fork as an exposure.
- [x] **Step 3: Implement the smallest domain-owned fork and comparison validation.** Define and export the fork node schema/type in `presentation.ts`; validate condition targets, node reachability, cycle/decision traversal, no ordinary outgoing edges, and comparison-key membership/equivalence in `arm.ts`; keep task meaning comparison in one helper next to the task/domain contract rather than repeating it in entrypoints or persistence. Add explicit fork rejection in `run.ts` and an incomplete/no-sibling traversal result in `packet-walker.ts`; make `initialJourneyPath` in `run-inspection.ts` refuse a fork before compiling, selecting, or accepting a packet. These paths cannot call a provider or invent a cohort before Task 5 adds durable execution. Run `npm run contracts:build` and `npm run build` to refresh the checked-in contract schemas and bundled runtime from canonical source.
- [x] **Step 4: Run the focused tests and confirm GREEN.** Run the targeted journey and initial-inspection test commands; expected: all new positive and negative cases pass and prior graph validation cases remain green.
- [x] **Step 5: Commit the graph contract.** Commit the domain/application source, focused tests, regenerated JSON Schemas, and bundled runtime as `feat: add explicit matched fork graph nodes`.

## Task 2: Traverse Fork Fan-Out and Bound the Full Topology

**Files:** Modify `src/domain/journey/topology.ts`, `src/domain/journey/route-bounds.ts`, and `src/domain/study/arm.ts` to enumerate, bound, and validate fork fan-out; retain `packet-walker.ts`'s fail-closed behavior until Task 5; extend `test/journey.test.ts` and add focused bounds tests in `test/run-inspection.test.ts`; regenerate bundled `dist/` outputs.

**Consumes:** Task 1's parsed fork graph, existing `journeyTopology`, cycle/reachability validation, and accepted `maxCalls`.

**Produces:** Deterministic fork traversal exposing each condition and entry target without interpreting fork membership as a response edge; graph min/max values count logical decision evaluations, use min/max across response alternatives, and sum every declared condition's bounded branch cost at a fork. `maxDecisions` uses the same fan-out accounting. Physical-call minima remain the responsibility of provider-aware packet batching. Overflow or cycles fail with a path-specific topology diagnostic. The existing sequence shorthand compiles exactly as before.

```ts
const branchRanges = node.conditions.map(({ entryNodeId }) => visit(entryNodeId));
const forkMinimum = branchRanges.reduce((total, branch) => total + branch.minimum, 0);
const forkMaximum = branchRanges.reduce((total, branch) => total + branch.maximum, 0);
```

- [x] **Step 1: Add distinguishable topology and bound tests.** Define one prefix ask followed by a fork with two conditions containing one ask each; assert the minimum and maximum logical decision evaluations each include the prefix once and both branch asks once per respondent, while an ordinary response choice remains min/max route selection. Add a nested reachable fork case, a cycle case, and an overflow case that fails safely instead of returning an unsafe integer.
- [x] **Step 2: Run the focused tests to prove RED.** Run `node --import tsx --test --test-name-pattern="fork call bounds|fork fan-out topology|topology overflow" test/run-inspection.test.ts`; expected: current call bounds stop at a fork with no ordinary edge, and cycle/overflow diagnostics do not identify the responsible node.
- [x] **Step 3: Extend the topology walkers at the domain owner.** Add a typed control-successor projection that distinguishes authored fork conditions from response transitions; in the call-bound recurrence and graph `maxDecisions` validation, sum all condition ranges for a reached fork and retain min/max across response alternatives. Reject unsafe intermediate totals with the fork/node ID and include the cycle node in cycle diagnostics. Preserve memoization and the active recursion set; never enumerate response values or synthetic respondent histories.
- [x] **Step 4: Run the focused tests and confirm GREEN.** Run `node --import tsx --test test/journey.test.ts test/run-inspection.test.ts`; run `npm run build` and `node --import tsx scripts/check-generated.ts`; expected: exact bounds match the authored graph, legacy sequences/graphs remain unchanged, and generated runtime projections match source.
- [x] **Step 5: Commit topology and bounds.** Commit the topology owners, graph max-decision validation, focused tests, and regenerated bundled runtime as `feat: include matched fork fan-out in journey bounds`.

## Task 3: Append SQLite Schema 14 for Branch Identity and Fork Barriers

**Files:** Add `src/infrastructure/sqlite/migrations/0005_matched_forks/migration.sql` and generated `migrations/0005_matched_forks/migration.sql`; modify `src/infrastructure/sqlite/schema.ts`, `src/infrastructure/sqlite/tables.ts`, and migration tests/fixtures in `test/sqlite-schema.test.ts`, `test/schema-migration-path.test.ts`, and `test/run-store-upgrade.test.ts`.

**Consumes:** Schema 13 and the new `branchId`/fork identity requirements from Tasks 1-2.

**Produces:** Sequential migration 13 to 14 that assigns legacy journey rows to root branch `root`, rebuilds the respondent primary key as `(run_id, respondent_id, branch_id)`, scopes the journey evaluation uniqueness key to `(run_id, respondent_id, branch_id, node_id, occurrence)`, expands respondent status constraints with `waiting-fork|branched`, and rebuilds the checkpoint constraint so `active` has node/turn/context, `waiting-fork` has node/context but no turn, and every terminal/branched state has no current pointers. Add `journey_forks(run_id, fork_node_id, parent_branch_id, status, cohort_count, opened_ms, closed_ms, revision)` plus `journey_fork_members(run_id, fork_node_id, parent_branch_id, respondent_id, condition_ordinal, condition_id, child_branch_id, source_context_id, child_context_id, child_turn_id, child_evaluation_id)`. The fork primary key is `(run_id, fork_node_id, parent_branch_id)` with status `open|closed`; member primary key is `(run_id, fork_node_id, parent_branch_id, respondent_id, condition_id)`, condition ordinal preserves authored order, child context/turn/evaluation IDs are unique, and `(run_id, fork_node_id, parent_branch_id, respondent_id, child_branch_id)` is unique while the same branch ID is shared across respondents. Add foreign keys to the run and branch-scoped evaluations. Preserve answers, turn IDs, context IDs, evaluations, attempts, route evidence, and indexes. Register schema version 14 and its packaged migration asset through the existing exact resolver.

```sql
ALTER TABLE journey_respondents ADD COLUMN branch_id TEXT NOT NULL DEFAULT 'root';
-- Rebuild primary/unique constraints to include branch_id while retaining all existing journey evidence.
```

- [x] **Step 1: Add a schema-13 migration fixture and failing migration assertions.** Create a minimal real schema-13 datastore containing a text journey respondent, an evaluation, one answer, and one attempt; after open/migration, assert all original evidence is byte-for-byte equivalent at the decoded API and its respondent now has `branchId: 'root'`. Assert the new composite keys permit two branches for one respondent but reject duplicate branch-local node occurrences.
- [x] **Step 2: Run the migration tests and prove RED.** Run `npm test -- --test-name-pattern="schema 13.*branch|migration 14.*journey"`; expected: migration registration is missing, current schema remains 13, and branch-scoped constraints are absent.
- [x] **Step 3: Implement migration 14 and the Drizzle owner.** Add the append-only SQL migration, recreate dependent indexes/constraints explicitly, backfill root IDs, add fork barrier and ordered member tables with foreign keys to run/respondent/state identities, update table declarations and registered migration metadata, then run `npm run sqlite:schema:generate` and compare generated SQL to the authored migration. Keep schema-9 baseline and migration files 0000-0004 unchanged.
- [x] **Step 4: Run migration tests and prove GREEN.** Run `npm test -- --test-name-pattern="schema 13.*branch|migration 14.*journey|schema 9|schema 13"`; expected: schema-13 evidence migrates intact, branch uniqueness is enforced, and schema-9 still reaches schema 14 through the complete chain.
- [x] **Step 5: Commit the schema boundary.** Commit only migration source/generated migration, schema registry/tables, fixtures, and tests as `feat: persist matched fork branch identities`.

## Task 4: Make Journey State, Evaluation, and Read Contracts Branch-Aware

**Files:** Modify `src/domain/run/lifecycle.ts`, `src/domain/run/request.ts`, `src/infrastructure/sqlite/reads/journeys.ts`, `src/infrastructure/sqlite/commands/acceptance.ts`, journey command repositories, and `test/run-store.test.ts`/`test/run-request.test.ts`.

**Consumes:** Schema 14, Plan 3 comparison-lock member `branchId`, existing route/path identity, frozen evaluation packets, and root compatibility backfill.

**Produces:** `branchId: string` on journey state, turn/evaluation identities, route/member evidence, and fork snapshots; every pre-existing accepted root journey has branch ID `root`. Derive each child ID as `${parentBranchId}/${forkNodeId}=${conditionId}`; identifiers exclude `/` and `=`, so nested fork paths remain unambiguous and author-inspectable. Add exactly two journey state statuses: `waiting-fork` has `currentNodeId` at a fork, null turn, non-null current context, and no pending evaluation; `branched` retains the completed parent history with all three current pointers null. `active` still has one matching pending/failed evaluation; existing completed/failed/unreached statuses keep null pointers. Storage reads validate state/evaluation correspondence using `(respondentId, branchId, contextId, turnId, nodeId)` and accept multiple rows per respondent only when branch IDs differ. Provider-lock lookup uses exact branch scope when a member specifies `branchId`, and legacy members without it retain their pre-fork semantics.

```ts
type JourneyBranchState = {
  respondentId: string;
  branchId: string;
  status: 'active' | 'waiting-fork' | 'branched' | 'completed' | 'failed' | 'unreached';
  currentNodeId: string | null;
  currentTurnId: string | null;
  currentContextId: string | null;
};
```

- [x] **Step 1: Add storage-contract tests that fail before production changes.** Extend store acceptance/reopen tests with two states for one respondent, distinct branch IDs and context IDs, identical current task/node IDs, and verify readback returns both without treating one as corrupt; add a corrupt cross-branch context reference case that must be rejected.
- [x] **Step 2: Run the focused lifecycle/store tests and prove RED.** Run `npm test -- --test-name-pattern="journey branch state|branch-local evaluation identity|corrupt branch context"`; expected: current domain types, SQL decoders, and uniqueness assumptions reject or collapse duplicate respondent state.
- [x] **Step 3: Implement branch-scoped lifecycle and persistence mapping.** Add branch IDs to the single lifecycle schemas and command/read owners; update acceptance's initial root records and transaction row mappings; preserve independent `pathId` for response-route history rather than overloading it as branch identity. Reuse already loaded run/evaluation/state rows in each command transaction.
- [x] **Step 4: Run focused tests and confirm GREEN.** Run `npm test -- --test-name-pattern="journey branch state|branch-local evaluation identity|corrupt branch context|run store"`; expected: parallel branches for one respondent are valid and cross-branch integrity corruption fails at the storage boundary.
- [x] **Step 5: Commit branch-aware lifecycle contracts.** Commit lifecycle, request, command/read owners, and behavior tests as `feat: scope journey state and evaluations by branch`.

## Task 5: Snapshot the Settled Cohort and Fan Out Atomically

**Files:** Modify `src/domain/journey/run.ts`, `src/domain/journey/packet-walker.ts`, `src/application/run-inspection.ts`, `src/application/run-service.ts`, `src/application/question-worker.ts`, and the fork/barrier command/read owners under `src/infrastructure/sqlite/`; extend `test/journey.test.ts`, `test/run-inspection.test.ts`, and `test/run-store.test.ts`.

**Consumes:** Tasks 1-4 graph, finite bounds, schema 14, immutable accepted respondent profiles, current context compiler/fingerprint, and the existing journey turn-claim and transaction APIs.

**Produces:** A persisted fork barrier keyed by `(runId, forkNodeId, parentBranchId)`; a transactionally frozen ordered member set containing only respondents whose durable pre-treatment state is `waiting-fork` at this node; and one child branch state per member per condition, with `branchId = parentBranchId + '/' + forkNodeId + '=' + conditionId`, distinct `contextId` and `turnId`, copied profile/projection/history, condition-local entry node and treatment, and a compiled packet under the accepted compiler. A barrier row is created as `open` on first arrival and changes once to `closed` only when every active state in the same parent branch that can still reach this fork has either arrived at it or ceased to be active; the transaction sets exact `cohortCount` and timestamps, changes arrived parents to `branched`, inserts ordered member rows, and creates all child states/evaluations. Concurrent workers cannot enlarge a closed membership. Branch definitions may later converge in the graph, but packet compilation always reads only the selected branch state.

```ts
const childBranchId = `${parentBranchId}/${forkNodeId}=${conditionId}`;
const closeBarrier = eligibleUpstreamStates.every((state) => state.status !== 'active' || state.currentNodeId === forkNodeId);
```

- [ ] **Step 1: Add failing lifecycle tests for the settled barrier.** Use two respondents whose prefix evaluations complete in opposite orders; assert the first arrival remains waiting and creates no child calls, and the last possible arrival closes one stable cohort containing exactly reached members. Include one respondent that terminates before the fork, one that fails upstream, two conditions that receive distinct copied contexts, and a repeated barrier-advance attempt that creates no duplicate children.
- [ ] **Step 2: Run barrier tests and prove RED.** Run `npm test -- --test-name-pattern="settled fork cohort|fork barrier idempotence|branch history isolation"`; expected: current worker immediately advances one linear state and cannot persist a barrier or multiple branch states.
- [ ] **Step 3: Implement domain fork transitions and the SQLite transaction command.** Add domain operations that describe arrival, eligibility, and deterministic branch identities; implement one transaction command that verifies barrier/state revisions, freezes ordered membership once, persists parent fork status, clones each accepted pre-treatment state, appends only condition exposures, and creates all first branch evaluations atomically. The command must not call providers, select providers, or mutate accepted source histories.
- [ ] **Step 4: Integrate inspection and worker scheduling.** Initial inspection continues to compile only the actual root packet; reached fork admission compiles all newly ready condition packets using the same packet/compiler path; workers claim only generated pending branch evaluations. If the barrier is incomplete, the worker records/wakes on the pending control state without reserving a physical call or marking a respondent choice.
- [ ] **Step 5: Run focused tests and confirm GREEN.** Run `npm test -- --test-name-pattern="settled fork cohort|fork barrier idempotence|branch history isolation|journey admission"`; expected: exact cohort membership is frozen, copied histories are independent, and no branch call exists before barrier close.
- [ ] **Step 6: Commit the transactional barrier.** Commit domain, application, persistence, and tests as `feat: snapshot settled journey cohorts into matched branches`.

## Task 6: Resolve Matched Provider Choices Across Ready Conditions Before Dispatch

**Files:** Modify `src/application/question-worker.ts`, provider-selection application owners and `src/application/run-inspection.ts`; extend `test/provider-selection.test.ts`, `test/automatic-provider-selection.test.ts`, and `test/question-worker.test.ts`.

**Consumes:** Plan 3 frozen catalogue/settings, complete provider fit and price metadata, Task 5 ready branch packets, `providerSelection.comparisonLocks`, and the accepted branch-local evaluations.

**Produces:** A `ForkComparisonMember` view `{ forkNodeId, comparisonKey, respondentId, branchId, questionId, packet, packetFingerprint }` compiled from the frozen barrier members and branch evaluations. For each fork instance and authored `comparisonKey` shared by multiple conditions, all reached respondent-condition evaluation units carrying that key form one declared comparison set. Resolve one provider/model against every ready packet in that set across the frozen cohort before any member dispatches, then persist it on every member. This keeps treatment, respondent, and branch variables from accidentally changing provider within an authored comparison; an explicit provider/model-variation design can relax that equality. An image/no-image comparison uses one admitting vision-capable provider for both conditions. An incompatible packet produces a typed zero-call comparison failure and leaves no member unlocked. Unmatched tasks and unlocked later branch turns remain normally eligible for provider selection; explicit Plan 3 locks may still bind additional respondent or branch members.

```ts
const matchedMembers = readyPackets
  .filter((packet) => packet.forkNodeId === forkNodeId && packet.comparisonKey === comparisonKey)
  .map(({ respondentId, questionId, branchId }) => ({ respondentId, questionId, branchId }));
const equality = { provider: 'same', model: 'same' } as const;
```

- [ ] **Step 1: Add a provider-capture regression test with distinguishable branches.** Configure one enabled text-only local provider and one enabled Clef provider; create a matched pixel/no-pixel pair whose complete packet set fits only Clef; assert both branch evaluations persist Clef before either dispatch. Add the inverse packet set that fits no shared provider and assert no calls and no lock mutation. Ensure the test fails if resolver matching ignores `branchId`.
- [ ] **Step 2: Run provider-selection tests and prove RED.** Run `npm test -- --test-name-pattern="comparison lock across fork branches|no common comparison provider|branch-specific comparison member"`; expected: current resolver searches only respondent/question and resolves the first member without all fork conditions.
- [ ] **Step 3: Implement lock readiness and atomic choice persistence.** Add a branch-aware selection operation at the provider-selection owner; pass exact actual ready packets and preserve Plan 3 economy/preferences/equality semantics. Resolve and persist the selected identity and evidence for all lock members before worker claim can reserve any attempt; preserve explicit provider bindings and provider/model variation controls.
- [ ] **Step 4: Run focused tests and confirm GREEN.** Run `npm test -- --test-name-pattern="comparison lock across fork branches|no common comparison provider|branch-specific comparison member|provider selection"`; expected: a common eligible configuration is frozen for all members, failure uses zero attempts, and non-members remain selectable.
- [ ] **Step 5: Commit matched selection.** Commit selection and worker behavior/tests as `feat: lock matched fork members to one eligible provider`.

## Task 7: Execute, Recover, Cancel, and Report Branch Work Independently

**Files:** Modify `src/application/question-worker.ts`, `src/application/run-service.ts`, run inspection/status/report services, journey settlement/resume/cancel repositories, and their owners in `src/domain/run/lifecycle.ts`; extend `test/question-worker.test.ts`, `test/run-store.test.ts`, and `test/run-inspection.test.ts`.

**Consumes:** Ready branch evaluation identities, exact accepted packet/compiler fingerprints, resolved provider selection, shared run reservation/attempt ledger, and current failure-scope rules.

**Produces:** Each branch advances from its own history and route; sibling answers do not influence one another. Prefix work is never replayed. One branch can fail or become uncertain while other branches and respondents continue. Status and inspection expose per-condition pending/answered/failed/unreached members, complete and incomplete pair membership, branch outcomes, branch-specific provider/model/packet evidence, shared minimum/maximum call bounds, and remaining calls. Resume retries only eligible failed/pending work using the saved packet/provider and shared remaining allowance; success/uncertainty/failed-run scope follows existing attempt rules. Cancellation remains run-wide and leaves a recoverable, inspectable branch ledger.

```ts
const executionIdentity = { runId, respondentId, branchId, contextId, turnId, nodeId, evaluationId };
```

- [ ] **Step 1: Add failure-scope, call-ledger, and reopen tests that fail on linear-state behavior.** Use a matched two-condition fork with a successful prefix; make condition A answer, make condition B fail after dispatch, and let a second respondent continue. Reopen the store, assert prefix has one attempt, A remains answered, B has its own failed attempt and packet identity, and the second respondent is unaffected. Resume and assert only B is retried with the exact same provider and packet; include a shared run-scoped failure/cancel case that stops claims without erasing branch results.
- [ ] **Step 2: Run lifecycle tests and prove RED.** Run `npm test -- --test-name-pattern="branch failure preserves pair|branch-only recovery|prefix is not replayed|fork cancellation"`; expected: current state/transition lookup assumes one respondent state and one pending evaluation per respondent.
- [ ] **Step 3: Implement branch-local claim/transition/recovery.** Scope turn claim, stale revision, persistence transition, pending selection, retry, and result matching by `(runId, respondentId, branchId, contextId, turnId, nodeId)`; retain one run-level physical-call counter and existing reservation semantics. Never infer an answer from provider/transport failure.
- [ ] **Step 4: Implement branch comparison evidence.** Build complete pairs only from the explicit fork identity, respondent, comparisonKey, and matching occurrence; retain failed and absent counterparts with reasons and denominator; do not impute ties, merge confidence scales, or mark branches independent observations.
- [ ] **Step 5: Run focused tests and confirm GREEN.** Run `npm test -- --test-name-pattern="branch failure preserves pair|branch-only recovery|prefix is not replayed|fork cancellation|journey report"`; expected: only eligible work resumes and complete/incomplete pairs remain distinguishable after reopen.
- [ ] **Step 6: Commit execution and reporting.** Commit worker, application, lifecycle, persistence, and behavior tests as `feat: recover matched journey branches without replay`.

## Task 8: Expose Fork Semantics Through Shared CLI/MCP Contracts and Guidance

**Files:** Modify canonical schemas/types in `src/domain/study/presentation.ts`, `src/domain/run/request.ts`, and report/inspection schemas; modify `src/entrypoints/cli.ts`, `src/entrypoints/mcp.ts`, `scripts/generate-contracts.ts`, generated `skills/stimulus-response-polling/assets/`, canonical `skills/stimulus-response-polling/references/`, and existing CLI/MCP/skill behavior tests.

**Consumes:** Shared graph validation, inspection, status, comparison evidence, branch-specific identities, frozen provider defaults, and the existing common application service used by CLI and MCP.

**Produces:** One identical author contract on both entrypoints: explicit fork node and named conditions, task comparison keys, optional per-member branch lock identity, inspection of bounds/readiness and currently settled members, run/status evidence for branch membership and incomplete pairs, branch-aware evaluation/context references for later selection. Agent guidance tells authors what Sheg selects automatically and the controls for provider pins, provider/model variation, and batching, without requiring routing internals. The installed recipe demonstrates the article section-3 reached fork with image/no-image section-4 branches and compact described history onward.

```json
{
  "id": "end-of-section-three",
  "kind": "fork",
  "conditions": [
    { "id": "with-image", "label": "With the image", "entryNodeId": "expose-section-four-image" },
    { "id": "without-image", "label": "Without the image", "entryNodeId": "expose-section-four-text" }
  ]
}
```

- [ ] **Step 1: Add shared entrypoint and skill behavior tests that fail on missing fork support.** Assert both CLI and MCP accept the same valid fork request, reject an unknown branch/evaluation reference with the same structured validation semantics, expose equal per-condition statuses and complete-pair denominators, and teach a fictional agent to declare a fork and comparison key instead of composing separate runs.
- [ ] **Step 2: Run public-contract tests and prove RED.** Run `npm test -- --test-name-pattern="CLI matched fork|MCP matched fork|skill.*fork|branch evidence"`; expected: current graph schemas, serializers, and guidance do not expose branch identities.
- [ ] **Step 3: Implement shared application exposure and regenerate contracts.** Add no fork-specific business rules in entrypoints; use existing application services, generate contract assets with `npm run contracts:build`, and update only canonical skill source before generating package output.
- [ ] **Step 4: Run focused entrypoint and skill behavior tests.** Run the named focused suite and `npm run guidance:check`; expected: both entrypoints describe the same frozen cohort/branch results, and old text journey instructions remain valid.
- [ ] **Step 5: Commit public author surface.** Commit source contracts, generated schemas, canonical skill guidance, and behavior tests as `feat: expose matched forks in study design tools`.

## Task 9: Qualify the Copied Runtime, Complete the Gate, and Prepare the Integration PR

**Files:** Extend `test/package.test.ts` and packaged-runtime test fixtures only for a genuine copied-install fork gap; update `.agents/plans/v0.4.0-visual-studies/roadmap.md`; update package identity only after uniqueness recheck; regenerate derived schemas/runtime/package output from canonical owners.

**Consumes:** Tasks 1-8, latest `origin/develop`, schema 14 and migration assets, current provider setup behavior, canonical skill sources, and all task commits.

**Produces:** An installed copied-plugin test exercising a text prefix, settled two-branch pixel/no-pixel comparison, same-provider lock, branch-local onward text stage, injected branch failure, process close/reopen/recovery without prefix replay, and compatibility of existing text request/store evidence. The current roadmap baseline is updated from the Plan 3 `.dev.3` note to the actual merged `.dev.5` commit `fa6ea8f`, Plan 4 links to this file and changes to in-progress, and future plan ordering remains just-in-time. The PR targets `develop` and proposes the next still-unique v0.4.0 development identity.

- [ ] **Step 1: Add the copied-plugin scenario and prove RED for the missing behavior.** Run the new package test against a disposable copied package, not the checkout import graph; it must fail at its first missing fork contract, and a deliberately broken branch resume path must fail at the exact branch-recovery assertion before restoring production code.
- [ ] **Step 2: Run the copied-package test and inspect custody.** Run `npm test -- --test-name-pattern="copied plugin.*matched fork"`; expected: the copy contains all generated runtime, schema-14 migration, credential/visual contract, and shipped guidance required without reading `src/`, `test/`, the checkout, or `node_modules` outside the copy.
- [ ] **Step 3: Refresh and align release identity.** Fetch and fast-forward the working branch onto latest `origin/develop` if needed; confirm `0.4.0-dev.6` is unused on the intended line, set the unique identity in root `package.json`, run `npm run contracts:build`, `npm run build`, `npm run sqlite:schema:generate`, and `npm run plugin:package -- --validate-only`, then verify every derived version/schema/plugin identity and roadmap baseline.
- [ ] **Step 4: Run focused and generated-package validation.** Run the fork graph/topology/store/worker/provider/entrypoint/package tests, `npm run build`, and `npm run plugin:package -- --validate-only`; expected: focused behavior, generated parity, schema package parity, and copied runtime pass with only justified environment skips.
- [ ] **Step 5: Review the final branch against source owners and review focus.** Verify graph validation is domain-owned; selection and dispatch boundaries remain shared; provider wire formats remain separate; migration/backfill preserves schema-13 and schema-9 evidence; transaction code contains no provider I/O; all branch reads are explicitly ordered and branch-scoped; package tests are checkout-independent; and no response/asset bytes leak into bounded diagnostics. Record any technical ruling in the external execution ledger before applying it.
- [ ] **Step 6: Commit qualification and roadmap through the tracked staged-snapshot hook.** Commit package qualification, generated output, version identity, and roadmap cursor as `feat: qualify matched forks in the installed runtime`; the hook runs `npm run verify` against the exact staged candidate and must pass before the commit is created.
- [ ] **Step 7: Publish and merge through the normal Sheg PR route.** Open the PR against `develop`; refresh head/version/review threads and required check at merge time; merge only after `npm run verify`, copied-package validation, and hosted `sheg-verify` pass; fast-forward canonical `develop`, verify exact merged tree/package identity, and archive/delete this plan's worktree/branch only after merged tree equivalence and repository cleanup-policy checks.

## Slice Exit

An author can submit one explicit study containing a prefix journey, a settled reached cohort, matched branch conditions that share a provider/model lock where declared, independent histories for each respondent-condition, and later branch-specific stages. Sheg counts and reserves calls across the whole study, preserves completed and failed counterparts, exposes complete/incomplete matched evidence, and recovers only eligible work without replay. Existing v0.3.0 text journeys, explicit provider runs, schema-9 stores, package assets, and ordinary route behavior continue to work. Plan 5 owns durable visual follow-ons and broader pair/evidence projections; Plan 6 owns the live perceptual recipes and Clef comparison investigation.
