# Durable question runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent submits one typed question over inline material and respondents, closes its MCP connection, and discovers the completed run and answers from another connection.

**Architecture:** Freeze accepted input and compiled respondent packets in a local SQLite store before launching a detached worker. The worker owns execution through fenced database claims and records individual answers and physical attempts. MCP operations inspect, submit, discover, read and cancel without requiring authored study files or starting interrupted work on reads.

**Tech Stack:** TypeScript, Node.js 24 (`>=24 <25`), built-in `node:sqlite`, existing MCP SDK and Zod, Node test runner, existing Jev and Laya adapters.

**Spec:** [approved epic](../../specs/2026-10-01-v0.3.0-epic-spec.md); [release roadmap](roadmap.md); [SHEG-5](https://linear.app/harleys-workspace/issue/SHEG-5/run-and-recall-durable-requests-across-chats).

**Execution Strategy:** `executing-plans`. Contract compilation, persistence, worker ownership and the MCP share one sequential acceptance path. Inline implementation preserves that context; a fresh whole-branch review checks the combined lifecycle. Separate implementers per task would repeatedly reconstruct the same state machine and transaction invariants.

## Global Constraints

- No backward compatibility is offered while Sheg is below v1. Do not build migrations, importers or shims for old runs or tool names.
- Machine-readable MCP output, agent-owned interpretation, no provider determinism proof workstream.
- Jev is the primary BYOK provider. Local inference limitations do not define the product ceiling. Preserve honest native-route fit rejection until supported admission exists.
- No silent trimming, provider fallback or paid inference without explicit authorization. Tests use injected adapters and an owned local HTTP fixture.
- Request acceptance is durable before returning a run identity. Harness startup and reads do not launch or resume work.
- Exact respondent/model inputs remain separate from selection rationale and orchestration metadata.
- Keep current-format retained data intact. Cancellation preserves recorded results and accounts for already dispatched work.
- Work on a canonical isolated feature worktree from current `origin/develop`; inspect the full Linear issue and linked documents before editing implementation.
- Use ordinary hooked commits. The staged-snapshot hook runs `npm run verify`; include necessary generated outputs and do not duplicate the full gate immediately around a passing hook.
- No emojis or em dashes in authored copy. Consequential choices get individual ADRs and an updated decision index during implementation.

## Review Focus

1. Same submission retried across connections must return one run and dispatch once, including when the first response was lost. Task 2 tests the unique transaction; Task 4 tests the MCP retry.
2. Closing the originating MCP must leave actual packaged execution alive. Task 4 uses a real detached worker and a gated local provider, not a launcher mock.
3. Worker death or stale ownership must never invent an answer, refund an uncertain attempt, or restart on discovery. Tasks 2 and 3 cover fencing and interruption.
4. Cancellation while a call is in flight preserves its eventual answer and prevents the next respondent dispatch. Task 3 tests the boundary with two respondents.
5. Inspection and rejection must cost zero inference calls; recorded requests must preserve exact text despite later caller mutation. Tasks 1 and 2 test both.

---

## Scope and delivery boundary

This plan delivers a flat poll with one Choice, Score or Noul question and one or more inline respondents. It provides `run_inspect`, `run_start`, `run_list`, `run_get` and `run_cancel` for that request shape. No prerequisite create/register/upload operation or file path is required.

Plan 2 supplies explicit resume, deletion/dry run and storage maintenance. Plans 3 and 4 add authored journeys, query criteria and reusable references. Plans 5 and 6 add independent question groups and exact source-linked choices. A singleton question list is a temporary implemented capability, not a permanent schema ceiling. Unsupported request variants reject explicitly. Do not close SHEG-5 after this slice.

Existing journey CLI behavior can remain until Plan 3 integrates it with this store. It is not a compatibility commitment or a second durable MCP run API. Replace the file-based MCP acceptance/preflight surface with this implemented path; update callers and guidance honestly. Preserve distinct diagnostic packet tools only where they still serve a documented supported workflow. Do not route the new run tools through the old file checkpoint manager.

## File and responsibility map

| File | Action and responsibility |
| --- | --- |
| `src/domain/run/request.ts` | Create direct request schema, normalized input and frozen evaluation types |
| `src/domain/run/lifecycle.ts` | Create statuses, attempt states and public projections |
| `src/domain/decision/decision.ts` | Export the shared question schema/type rather than duplicate typed questions |
| `src/domain/decision/prompt.ts` | Factor an empty trajectory constructor through the existing serialization rules |
| `src/application/run-inspection.ts` | Create parsing, packet compilation, fit admission and projected inspection |
| `src/providers/config.ts` | Create a shared strict provider union used by direct requests and remaining existing callers |
| `src/application/run-manager.ts` | Replace duplicated provider schema with shared import; leave remaining journey CLI responsibility here for now |
| `src/infrastructure/identity.ts` | Export the existing canonical fingerprint helper |
| `src/infrastructure/data-root.ts` | Create explicit data directory resolution |
| `src/infrastructure/run-store.ts` | Create SQLite schema, transactions, fenced execution and paginated projections |
| `src/application/run-service.ts` | Create durable submission, read and cancel orchestration |
| `src/application/question-worker.ts` | Create flat execution using frozen packets and existing adapters |
| `src/infrastructure/worker-launcher.ts` | Create detached process launch with no inherited stdio |
| `src/providers/jev.ts` | Expose structured run-wide authentication failure where needed |
| `src/entrypoints/worker.ts` | Replace CLI-style resume bootstrap with explicit database/run bootstrap |
| `src/entrypoints/mcp.ts` | Expose direct request and run projection operations |
| `scripts/generate-contracts.ts` | Add canonical request schema generation alongside existing owned schemas |
| `skills/stimulus-response-polling/SKILL.md` | Explain the delivered direct request, inspection, discovery, partial results and interruption boundary |
| `skills/stimulus-response-polling/assets/` and `dist/` | Regenerate using repository scripts, never hand-edit |
| `docs/decisions/README.md`, `0018-store-durable-runs-in-sqlite.md`, `0019-own-execution-in-detached-workers.md` | Index separate storage and worker lifetime/ownership decisions |
| `test/run-request.test.ts`, `test/run-inspection.test.ts` | Create genuine direct-input and admission behavior tests |
| `test/data-root.test.ts`, `test/run-store.test.ts` | Create environment and transactional persistence behavior tests |
| `test/question-worker.test.ts`, `test/run-service.test.ts` | Create execution, budget, cancellation and launch behavior tests |
| `test/mcp.test.ts`, `test/package.test.ts` | Update superseded MCP assertions and add real packaged cross-process acceptance |
| `test/fixtures/run-provider-server.ts` | Create an owned, gated local HTTP provider helper for process-level tests |

Do not reorganize unrelated domain/provider code. The existing Jev adapter is `src/providers/jev.ts`; the new files above are selected ownership boundaries. Refresh facts at execution start without broadening scope. If another change has occupied ADR numbers 0018/0019, take the next free numbers and update the index.

## Shared contracts and state machine

### Direct request and frozen packets (Task 1)

Reuse `RespondentProfile`, `DecisionRequest`, `DecisionResult`, `ProviderContextFit` and normalized provider configurations from the current source. Export `DecisionQuestion = DecisionRequest['question']`. The public parser is strict at every object boundary.

```ts
interface InlineRunRequest {
  kind: 'poll';
  label?: string;
  respondents: RespondentProfile[];
  material: Array<{ id: string; text: string }>;
  questions: [DecisionQuestion];
  provider: ProviderConfig;
  maxCalls: number;
}
interface FrozenEvaluation {
  evaluationId: string;
  contextId: string;
  respondentId: string;
  questionId: string;
  packet: DecisionRequest;
  packetFingerprint: string;
}
interface Inspection {
  valid: boolean;
  respondentCount: number;
  minimumCalls: number;
  problems: Array<{ code: string; respondentId?: string; message: string }>;
  fits: Array<{ respondentId: string; fit: ProviderContextFit }>;
}
interface PreparedRun {
  request: InlineRunRequest;
  requestFingerprint: string;
  compilerFingerprint: string;
  evaluations: FrozenEvaluation[];
}
```

`prepareRun(input: unknown, provider: DecisionProvider): Promise<{ inspection: Inspection; prepared?: PreparedRun }>` parses, compiles and measures; it never calls `decide`. Invalid syntax is a typed validation failure, valid syntax with unavailable/overflow fit returns `valid: false`. Required measurement that is absent/unavailable rejects. Credentials/configuration checks use existing provider readiness logic and report structured problems. All respondents must fit before acceptance. Require unique respondent/material identifiers, nonempty material, exactly one question and an integer `maxCalls >= respondents.length`. No concurrency control exposed yet: the worker is sequential.

Compile one packet per respondent with `compileDecisionRequest`, their perspective, exact encountered material and an exported `emptyTrajectory(): TrajectorySummary`. Do not create a fake StudyArm. IDs, label, submission key, selection rationale and provider config are outside packet state. Generate immutable evaluation/context IDs during preparation and persist them on acceptance. Canonical fingerprints include the normalized request and existing compiler contract hash; preserve exact material text and authored array order.

### Store contract (Task 2)

```ts
type RunStatus = 'prepared' | 'running' | 'completed' | 'partial' |
  'failed' | 'cancelled' | 'interrupted';
interface RunStatusView {
  runId: string; status: RunStatus; createdAt: string;
  completedEvaluations: number; failedEvaluations: number;
  totalEvaluations: number; usedCalls: number; reservedCalls: number;
  maxCalls: number; cancelRequested: boolean;
  failure?: { code: string; message: string };
}
interface AnswerRow {
  evaluationId: string; contextId: string; respondentId: string;
  questionId: string; status: 'pending' | 'answered' | 'failed';
  result?: DecisionResult;
  failure?: { code: string; message: string };
}
interface Page<T> { items: T[]; nextCursor?: string }
interface WorkerClaim { runId: string; ownerToken: string }
interface AttemptReservation { attemptId: string; evaluation: FrozenEvaluation }
type AttemptOutcome =
  | { kind: 'answered'; result: DecisionResult }
  | { kind: 'failed'; code: string; message: string; scope: 'evaluation' | 'run' };
interface RunListQuery {
  status?: RunStatus; label?: string; cursor?: string; limit?: number;
}
interface RunStore {
  findSubmission(submissionId: string, requestFingerprint: string): RunStatusView | null;
  accept(submissionId: string, prepared: PreparedRun): { created: boolean; run: RunStatusView };
  getStatus(runId: string): RunStatusView;
  getRequest(runId: string): PreparedRun;
  list(query: RunListQuery): Page<RunStatusView>;
  answers(runId: string, cursor?: string, limit?: number): Page<AnswerRow>;
  requestCancel(runId: string): RunStatusView;
  claim(runId: string, nowMs: number, workerPid: number): WorkerClaim | null;
  heartbeat(claim: WorkerClaim, nowMs: number): boolean;
  reserveNext(claim: WorkerClaim, nowMs: number): AttemptReservation | null;
  settle(claim: WorkerClaim, attemptId: string, outcome: AttemptOutcome): void;
  finish(claim: WorkerClaim): RunStatusView;
  failLaunch(runId: string, code: string): void;
  reconcile(runId: string, nowMs: number): RunStatusView;
  close(): void;
}
```

Use `runs`, `evaluations`, `attempts` tables with foreign keys and unique submission ID. JSON stores validated frozen inputs and complete typed result metadata. `BEGIN IMMEDIATE` protects acceptance, claims, reservations and settlements. The unique submission conflict compares canonical input fingerprints: identical retry returns the existing run; changed input returns `submission_conflict`. No second worker launch on identical retry, regardless of existing run status.

Persist `schema_version` for recognizing supported current format, not migration machinery. Open an unsupported database with a structured version error and explicit reset/setup guidance. `DatabaseSync` enables foreign keys, WAL, `synchronous=FULL` and a 5000ms busy timeout. Close connections on service/worker termination. No extra SQLite driver dependency. Export `openRunStore(dataRoot: string, options?: { now?: () => number }): RunStore`; the default clock is `Date.now`, tests supply a controlled clock. Derive the database path as `<dataRoot>/runs.sqlite`. All public lifecycle reads call reconciliation through the same clock before returning.

Claim transitions only `prepared -> running`, generates an owner token and a 30-second lease, and records the worker PID as internal operational metadata. The PID alone never authorizes a claim or write. Heartbeat every two seconds while awaiting provider calls. Every reservation/settlement requires the current owner token and live lease. A stale owner cannot publish answers. Reads reconcile expired prepared/running work to interrupted with transactional fencing; prepared gets the same 30-second launch grace from creation. No reads claim work. Expired reserved attempts consume one call each as uncertain, exactly once, retaining their attempt records. No assumed provider success.

Before every dispatch reserve one physical attempt, enforcing `usedCalls + reservedCalls < maxCalls`. The worker calls `decide(packet, 1)` and never retries in this slice. Settlement consumes the reservation and saves either a validated result or failure atomically. Budget exhaustion with unfinished evaluations yields partial. All answered yields completed; mixed recorded successes/failures yields partial; run-wide failure yields failed. Cancel requests stop new reservations; an already reserved call may settle before cancelled. An unclaimed prepared run can become cancelled immediately.

Pagination defaults to 50, maximum 200, with stable createdAt/runId ordering for runs and persisted evaluation ordinal for answers. Cursors carry their filter identity and reject mismatched/malformed cursors. Include pending rows so missing answers are distinguishable from negative answers. Read operations return explicit not_found and current completion counters.

### Service and worker contract (Task 3)

```ts
interface WorkerLauncher { launch(dataRoot: string, runId: string): Promise<void> }
interface RunService {
  inspect(input: unknown): Promise<Inspection>;
  start(submissionId: string, input: unknown): Promise<RunStatusView>;
  list(query: RunListQuery): Page<RunStatusView>;
  getStatus(runId: string): RunStatusView;
  getRequest(runId: string): PreparedRun;
  answers(runId: string, cursor?: string, limit?: number): Page<AnswerRow>;
  cancel(runId: string): RunStatusView;
}
// Provider factory reconstructs an adapter from the frozen normalized configuration.
type ProviderFactory = (config: ProviderConfig) => DecisionProvider;
function executeQuestionRun(store: RunStore, runId: string,
  providerFactory: ProviderFactory): Promise<void>;
```

Export `createRunService(store: RunStore, dataRoot: string, providerFactory: ProviderFactory, launcher: WorkerLauncher): RunService`. `start` first parses/fingerprints and checks an existing submission, returning it before repeating credential/admission checks. New submissions prepare, atomically accept, then launch only when `created`. Persist launch failure as failed; report its identity and failure. No rollback/delete of an accepted run and no automatic relaunch.

Data root precedence: absolute `SHEG_DATA_DIR`, absolute `PLUGIN_DATA`, then platform application data (`LOCALAPPDATA/Sheg` on Windows, or `~/AppData/Local/Sheg` when LOCALAPPDATA is absent, `~/Library/Application Support/Sheg` on macOS, `XDG_DATA_HOME/sheg` or `~/.local/share/sheg` on Linux). Empty/relative supplied overrides are errors, not cwd fallbacks. Create the database under this resolved root. Never put it inside the plugin installation or the caller's project by default. Only promise local-disk operation; existing platform/provider credential limitations remain explicit.

Launch the packaged worker with Node, root and run ID only. Resolve its file from the module/package location. Do not serialize requests or secrets in argv. Wait for the spawn/error event; after successful spawn unref the child.

```ts
const child = spawn(process.execPath, [workerPath, dataRoot, runId], {
  detached: true, windowsHide: true, stdio: 'ignore', shell: false,
});
// Await spawn/error, then child.unref(). No parent-bound IPC channel.
```

The worker opens only the named store/run, claims once, starts heartbeat, reserves, dispatches, validates with `validateDecision`, settles, then finishes. `finally` clears heartbeat and closes the connection. Do not scan or resume other runs on worker/MCP startup. Isolated timeout/malformed answer marks that evaluation failed and continues other respondents. Structured HTTP 401/403 and unusable shared configuration stop the run; expose adapter error scope rather than parsing message text. Unexpected worker exceptions are run failures; process death is reconciled as interruption. Provider secrets use existing credential storage and must not appear in recorded failure text.

## Task 1: Compile and inspect a direct one-question request

**Files:** Create request and inspection modules and their tests; export shared question and empty trajectory from decision modules; create shared provider config and update its current manager import; export canonical fingerprint helper. Modify `scripts/generate-contracts.ts` and regenerate owned schema assets/dist required by the gate.

**Interfaces:** Consumes existing `DecisionProvider`, `compileDecisionRequest`, respondent perspective schema and provider schemas. Produces `InlineRunRequest`, `FrozenEvaluation`, `PreparedRun`, `Inspection`, `prepareRun`, `emptyTrajectory` and shared `ProviderConfig` exactly as defined above.

- [ ] Write tests for exact text preservation, metadata exclusion, different respondent perspectives, Choice/Score/Noul compilation, duplicate IDs and a question list of zero/two items. Use an injected provider whose `decide` increments a counter and throws, with controlled measurement results. Assert overflow/unavailable/invalid budget rejects with zero decide calls.

```ts
assert.equal(inspection.valid, false);
assert.equal(decideCalls, 0);
assert.equal(prepared, undefined);
```

- [ ] Run `node --import tsx --test test/run-request.test.ts test/run-inspection.test.ts`; observe meaningful RED on missing direct acceptance/inspection behavior.
- [ ] Implement shared parsing and compilation without duplicating the decision union or creating a synthetic journey. Export empty trajectory through the existing payload-byte calculation. Generate IDs outside packets, measure every real compiled packet and return structured problems.

```ts
const packet = compileDecisionRequest({
  respondentProfile: perspective,
  encounteredItems: request.material,
  trajectory: emptyTrajectory(),
  question: request.questions[0],
});
```

- [ ] Run the focused tests plus `npm run typecheck`. Regenerate with `npm run contracts:build` and `npm run build`; inspect generated diffs and stage only source-owned consequences.
- [ ] Commit `feat: compile and inspect direct question requests` through the tracked hook. Exit: direct input admits only supported, fitting frozen packets and causes no inference.

## Task 2: Persist and recall accepted runs transactionally

**Files:** Create lifecycle, data-root and SQLite store modules and their tests. Add `docs/decisions/0018-store-durable-runs-in-sqlite.md` and its index entry, superseding the relevant file-checkpoint ownership portions of earlier decisions if applicable.

**Interfaces:** Consumes Task 1 `PreparedRun` and canonical fingerprints. Produces `RunStore`, lifecycle/projection types and `resolveDataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string` with the rules above.

- [ ] Write two-connection database tests: identical acceptance returns one identity; changed request under the same key conflicts; mutations of original arrays after acceptance do not change saved JSON; foreign-key errors roll back; stable paginated answers include pending entries. Test all data-root precedence/error/platform cases without modifying the user's actual data.
- [ ] Add claim/reservation tests with injected timestamps: only one claimant; maxCalls cannot overspend; result and settlement are atomic; stale owner writes fail; repeated reconciliation consumes an uncertain reservation once and never creates an answer. Close/reopen the database to prove persistence rather than relying on live objects.

```ts
const first = store.accept(submissionId, prepared);
const repeated = secondConnection.accept(submissionId, prepared);
assert.equal(repeated.created, false);
assert.equal(repeated.run.runId, first.run.runId);
```

- [ ] Run `node --import tsx --test test/data-root.test.ts test/run-store.test.ts`; confirm RED on the new transactional behavior.
- [ ] Implement the stated schema and transactions with parameterized statements. Distinguish domain errors from SQLite busy/internal errors, sanitize public failures, and inject time for lifecycle tests rather than sleeping 30 seconds. Record the storage ADR and current-format reset boundary.

```sql
BEGIN IMMEDIATE;
-- Unique submission acceptance and fingerprint comparison in one transaction.
-- Reservations and settlement each have their own owner-fenced transaction.
COMMIT;
```

- [ ] Run the focused tests and `npm run typecheck`. Commit `feat: persist durable run inputs attempts and answers` through the hook. Exit: restart-safe recall and concurrency/budget/ownership invariants hold without a worker process.

## Task 3: Execute independently and stop at explicit boundaries

**Files:** Create run service, question worker and launcher; replace worker entrypoint bootstrap; add service/worker tests; expose structured shared-failure classification in `src/providers/jev.ts` where needed; add `docs/decisions/0019-own-execution-in-detached-workers.md` and its index entry. Regenerate dist for entrypoint changes.

**Interfaces:** Consumes Task 1 preparation and Task 2 store methods. Produces `RunService`, `WorkerLauncher`, `ProviderFactory`, `executeQuestionRun`, and a worker invoked as `node dist/worker.js <absolute-data-root> <run-id>`.

- [ ] Write service tests for admission failure before persistence, exact retry despite later missing credentials, one launch after a two-submission race and visible launch failure retaining its run ID. Inject launcher failure without starting actual processes.
- [ ] Write worker tests with gated promises: first call cancelled while in flight, its answer retained, second respondent never dispatched; malformed answer followed by another respondent success; structured authentication failure stops remaining work; uncertain provider exception consumes reservation; stale ownership cannot settle. Assert every provider call receives `maxAttempts = 1`.
- [ ] Test interrupted status/discovery using a reopened store and advanced clock; assert no launcher or provider factory invocation on reads. Test duplicate worker invocation only one dispatches. No unsupported resume action is exposed.
- [ ] Run `node --import tsx --test test/run-service.test.ts test/question-worker.test.ts`; confirm behavior RED.
- [ ] Implement durable accept-before-launch, detached process arguments/lifetime, sequential fenced execution and heartbeat cleanup. Preserve Jev fit admission and existing credentials; make no live external calls. Save cancellation/failure counters honestly and close every owned database connection.

```ts
const reservation = store.reserveNext(claim, Date.now());
if (reservation) {
  const result = await provider.decide(reservation.evaluation.packet, 1);
  validateDecision(reservation.evaluation.packet, result, { maxAttempts: 1 });
  store.settle(claim, reservation.attemptId, { kind: 'answered', result });
}
```

- [ ] Run focused tests, regenerate `npm run build`, and run `npm run typecheck`. Commit `feat: execute accepted runs in an independent local worker` through the hook. Exit: isolated service/worker lifecycle is correct; real packaged lifetime is checked in Task 4.

## Task 4: Deliver the MCP path and prove packaged cross-chat recall

**Files:** Modify MCP entrypoint, MCP/package tests and canonical skill; create gated local provider fixture. Update generated request schema/package outputs and `README.md` tool examples that currently prescribe the superseded file-based MCP flow. Keep generated paths under their actual generator ownership.

**Interfaces:** Consumes `RunService`; exposes strict schemas and structured outputs:

```ts
run_inspect({ request: InlineRunRequest }): Inspection
run_start({ submissionId: string /* UUID */, request: InlineRunRequest }): RunStatusView
run_list(query: RunListQuery): Page<RunStatusView>
run_get({ runId: string, view: 'status' }): RunStatusView
run_get({ runId: string, view: 'request' }): PreparedRun
run_get({ runId: string, view: 'answers', cursor?: string, limit?: number }): Page<AnswerRow>
run_cancel({ runId: string }): RunStatusView
```

Use discriminated `run_get` input variants, not ignored pagination fields on status/request. All runs are bounded by this local data root. Domain failures return stable codes; internal errors do not dump SQL, secrets or host paths. No model-facing prose summaries.

- [ ] Replace obsolete file-based MCP expectations with operation tests for inspect/start/list/get/cancel, strict schema rejection and error shapes. Keep useful domain/CLI tests; do not replace behavioral coverage with tool-name snapshots.
- [ ] Add a real packaged test: copy/build the distributable using the repository package test pattern, supply isolated absolute `SHEG_DATA_DIR`, start an owned local Laya-compatible HTTP fixture with pinned test tokenizer, connect MCP A and accept a run. Hold the first response after the request arrives; terminate A, release the response, then connect MCP B to the same root and retrieve completed typed answers. Assert the submission retry returns the same ID and fixture call count stays one.
- [ ] Add process-level interruption evidence: read its recorded PID from the isolated test database, verify the live owner token, and terminate that test-owned worker while a request is held, expire its lease using the store test clock/reconciliation seam, discover interrupted from another connection and observe no second HTTP request. Never substitute a mocked launcher for the lifetime proof. Cleanup owns fixture sockets, MCP clients and child workers; settle/cancel or terminate children before removing test directories.
- [ ] Run `node --import tsx --test test/mcp.test.ts test/package.test.ts`; confirm RED on absent tools/actual process lifetime before implementing the MCP wiring.
- [ ] Wire service initialization to resolved persistent storage. Teach the skill to design the simplest supported request, inspect before dispatch, retain submission/run IDs, discover and query machine-readable evidence, interpret partial counts and state, and report the current explicit-resume boundary. Do not promise journey reuse or multi-question capability before later plans deliver them.
- [ ] Generate schemas and dist, run the focused tests, and inspect changes. Confirm the actual installed Codex launch environment permits detached worker lifetime using the same local fixture; if harness process containment kills it, stop and report that release requirement as unmet instead of claiming success from unit tests.
- [ ] Commit `feat: expose durable request and recall tools through MCP` through the hook. Run a fresh whole-branch review using the review skill, fix substantiated defects, and rerun affected checks. Exit: another connection recalls durable answers after the originating MCP exits, using the distributable package and no paid model calls.

## Completion evidence and custody

Before marking Plan 1 delivered, record in the roadmap: implementation commit/PR identity when one exists, focused package/process evidence, full staged-snapshot gate result, review outcome and remaining Plan 2 lifecycle obligations. SHEG-5 remains open. Use `completing-planning-artifacts` to promote enduring decisions and mark this plan completed-awaiting-retirement through its completing PR. Publication or a draft PR requires the scope authorized at execution handoff; do not infer release/merge authority from this planning request. Later human approvals belong in handoff state, not unfinished implementation checkboxes.

## Verified implementation references

The existing build bundles CLI, MCP and worker entrypoints. The current in-process RunManager/file checkpoints do not satisfy independent worker lifetime or cross-chat discovery. Reuse its provider/domain logic without inheriting its storage shape. Node's official [SQLite reference](https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/sqlite.md) supports the selected DatabaseSync APIs on Node 24; use APIs present at the repository's supported floor. Its [child process reference](https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/child_process.md) documents detached/unref lifetime and independent stdio. These engineering contracts are not proof of the user's harness containment behavior, which Task 4 verifies.
