# Resume, delete and manage durable run storage

Status: ready for execution.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent can explicitly resume unfinished work under the original attempt limit, intentionally delete selected runs without breaking storage, and inspect or optimize Sheg's local datastore through controlled MCP operations.

**Architecture:** Extend the existing SQLite run store and `RunService`; do not introduce another manager or background process. Resume atomically returns an eligible run to a launchable state and preserves its run ID, frozen request, completed answers, attempt history, and original `maxCalls`. Deletion revalidates explicit run IDs inside one transaction, relies on the existing foreign-key cascades, and refuses active work. Storage inspection and optimization stay inside Sheg and do not expose the database path or raw SQL.

**Execution Strategy:** `executing-plans`. Resume, worker claims, attempt accounting, cancellation, deletion, and storage operations share state transitions and transactions. Keep the work inline so each transition and invariant has one owner, as required by the issue's no-delegation contract; finish with a direct whole-diff review against the acceptance criteria and behavior evidence.

**Specification:** [approved v0.3.0 epic](../../specs/2026-10-01-v0.3.0-epic-spec.md); [roadmap](roadmap.md); [SHEG-5](https://linear.app/harleys-workspace/issue/SHEG-5/run-and-recall-durable-requests-across-chats); [agreed design](https://linear.app/harleys-workspace/document/v030-agreed-design-and-delivery-sequence-97646e0c367f).

## Global constraints

- Preserve the exact saved request, provider route, typed results, attempt history and original physical-call ceiling.
- Keep model calls outside database transactions. Use SQLite transactions for state changes and existing fenced worker ownership for execution.
- No harness startup or read operation resumes work. Do not manipulate SQLite or backing files from agent-facing inputs.
- Never include tokens, SQL, credentials or host paths in returned errors or storage reports.
- No migrations or backward compatibility below v1. Keep version/setup errors explicit if the current pre-v1 format must be reset.
- Use local fixtures for behavior tests. Do not read the user's credential or call paid providers.
- Keep the MCP machine-readable and the agent responsible for deciding when to resume or delete.

## Review focus

- A run older than the initial launch grace must still be claimable after explicit resume, while a lost resumed launch becomes interrupted without auto-start. Task 1 covers both.
- A shared credential/access failure must retry only its own unanswered evaluation, retain its prior failed attempt, and spend from the original budget. Tasks 1 and 2 cover this.
- A stale preview or active worker must not permit partial or active-run deletion. Task 3 revalidates inside the delete transaction.
- A corrupt datastore must not be described as healthy or silently optimized. Task 4 tests failed integrity output and safe error reporting.
- Concurrent resume/delete/worker operations must leave one valid state and no orphan rows. Tasks 1 and 3 cover transaction contention and foreign-key integrity.

## Scope and exits

- Add `run_resume`, retaining the existing run ID and request. Only an interrupted run or a run-wide failed run with unfinished work can resume. A resumed run may retry only the evaluation failed by the run-wide failure; it retains that failure in its attempt history. Previously answered or evaluation-failed respondents are not dispatched again. A run-wide retry consumes the original remaining physical-attempt budget.
- A cancelled, completed, partial, or currently running run cannot be resumed. A live worker is never duplicated. Resuming does not automatically happen during MCP startup or reads.
- Add `run_delete` for an explicit nonempty set of run IDs, with optional `dryRun` defaulting to `false`. Preview returns exact selected IDs, statuses, evaluation/attempt counts, and active-run blockers without deleting records. Actual deletion validates the full selection again in one transaction and either deletes all selected terminal runs or none. Missing IDs, duplicates, and active work are structured errors. The caller cancels active work and waits for a terminal state before deleting it.
- Add Sheg-owned storage inspection and optimization via one `run_storage` tool with `operation: 'inspect' | 'optimize'`. Inspection reports integrity status, database byte size and row counts without host paths or SQL. Optimization invokes SQLite's supported optimization operation; it does not rewrite user-visible run evidence. Sheg may run optimization after a successful deletion.
- Retain partial evidence and attempt history until the run itself is deleted. Current v0.3 records have no cross-run references or external artifacts; later follow-on plans own dependency-aware deletion and retained snapshots.
- Preserve the user's original `maxCalls`. Unknown provider completion remains a consumed uncertain attempt. Malformed/missing credentials reject resume before changing run state.
- No automatic resume, resume loop, new provider retry policy, force deletion of active work, migration layer, free-form SQL, filesystem cleanup surface, cross-run dependency mechanism, spend accounting, or cross-host store.
- Current-format data may require reset if the schema must change before v1. Give a precise unsupported-format/setup error; do not add compatibility machinery.

## Repository surfaces

| File | Responsibility |
| --- | --- |
| `src/domain/run/lifecycle.ts` | Resume/delete/storage input and result projections where shared by application and store |
| `src/infrastructure/run-store.ts` | Atomic eligibility/transition logic, deletion preview and execution, row-count/integrity/optimization operations |
| `src/application/run-service.ts` | Readiness-before-resume, launch only after atomic resume acceptance, preserve structured errors |
| `src/application/question-worker.ts` | Reuse existing fenced sequential worker without startup scanning or automatic retry |
| `src/entrypoints/mcp.ts` | Strict schemas and direct `run_resume`, `run_delete`, and `run_storage` registration |
| `src/infrastructure/worker-launcher.ts`, `src/entrypoints/worker.ts` | Existing detached process boundary; change only if the resume invocation needs a distinct explicit mode |
| `test/run-store.test.ts`, `test/run-service.test.ts`, `test/question-worker.test.ts`, `test/mcp.test.ts` | State transitions, immutable budget/evidence, deletion atomicity, structured tool behavior |
| `test/package.test.ts` | Cross-process explicit recovery and data deletion using the copied distributable |
| `skills/stimulus-response-polling/SKILL.md`, `skills/stimulus-response-polling/references/run-and-recovery.md`, `README.md` | Agent guidance for explicit resume, safe delete preview, active work, and managed storage |
| `dist/`, generated contracts if affected | Regenerated package/schema output only; never hand-edited |

Keep these operation contracts stable across tasks:

```ts
RunStore.resume(runId: string, nowMs: number): { started: boolean; run: RunStatusView }
RunService.resume(runId: string): Promise<RunStatusView>
RunStore.previewDelete(runIds: string[]): DeletePreview
RunStore.deleteRuns(runIds: string[]): DeleteResult
RunStore.storageInfo(): StorageInfo
RunStore.optimizeStorage(): void
```

`started` is true only for the caller that atomically transitioned an eligible
run to `prepared`; only that caller launches a worker. Delete inputs contain 1
to 200 unique run UUIDs. `DeletePreview` returns one entry per requested run,
status, evaluation count, attempt count, and `blockedByActiveWork`; `DeleteResult`
returns the deleted run IDs and aggregate removed row counts. `StorageInfo`
returns `integrity`, `databaseBytes`, run/evaluation/attempt counts, and active
run count. Keep result definitions local to the owning layer unless the MCP
contract shares them across application and infrastructure.

Read `docs/decisions/README.md` before implementation. Add one ADR and update its index only if the settled implementation changes a durable architecture or lifecycle contract beyond the approved epic and existing SQLite/worker decisions.

## Task 1: Define and persist safe resume transitions

- [ ] **Files:** `src/infrastructure/run-store.ts`, `test/run-store.test.ts`. **Consumes:** existing status, reconciliation, claim/reservation and `AttemptOutcome` contracts. **Produces:** `resume(runId: string, nowMs: number): { started: boolean; run: RunStatusView }`.
- [ ] Add store tests first. Verify resumed work keeps its UUID/request/answers/maxCalls; an expired reservation remains `uncertain` and increments `usedCalls`; a run-wide failed attempt remains recorded while only its evaluation resets to pending; used plus reserved never exceeds maxCalls; cancelled/completed/partial/live-running states reject without mutation; an old run resumes with a fresh 30-second claim window; an unclaimed resume becomes interrupted again without launch on read. Tests assert persisted rows and returned states, not method call counts.
- [ ] Run `node --import tsx --test test/run-store.test.ts`. Expected RED: unsupported resume API or an invariant assertion fails for the specified transition.
- [ ] In one `BEGIN IMMEDIATE` transaction, reconcile expired ownership, verify eligibility and unfinished work, account for reserved attempts once, reopen only the latest run-scoped failed evaluation (clear its result/failure fields while retaining the attempt row), clear the current run failure, set `status='prepared'`, and set `lease_expires_ms = nowMs + LEASE_MS`. Leave `created_at`, `created_ms`, request/fingerprints and `max_calls` unchanged. Return `started: true` only for the transaction that changes state.
- [ ] Make `claim` and `reconcileInside` use `lease_expires_ms` for resumed prepared rows and `created_ms + LEASE_MS` for initial prepared rows. Keep all claim, heartbeat, reserve and settle ownership checks fenced by the existing owner token. If new schema state is required, update the current pre-v1 schema version and test the explicit reset/setup error; add no migration code.
- [ ] Rerun `node --import tsx --test test/run-store.test.ts`. Expected GREEN: resume preserves evidence and budget and rejects every prohibited state. Commit `feat: resume durable runs` through the tracked hook.

## Task 2: Expose explicit resume through service and MCP

- [ ] **Files:** `src/application/run-service.ts`, `src/entrypoints/mcp.ts`, `test/run-service.test.ts`, `test/mcp.test.ts`, `test/package.test.ts`. **Consumes:** Task 1 `RunStore.resume`, current readiness check, launcher and structured errors. **Produces:** `RunService.resume(runId: string): Promise<RunStatusView>` and strict MCP `{runId: UUID}`.
- [ ] Add service tests first: explicit resume returns same ID and launches once; simultaneous calls launch at most one worker; readiness failure returns a structured credential code and leaves the run unchanged; prepared/running state does not launch again; terminal state is an explicit error; launch failure stays visible on the run.
- [ ] Run `node --import tsx --test test/run-service.test.ts test/mcp.test.ts`. Expected RED: missing operation or a state/launch assertion fails.
- [ ] Implement service flow: read the frozen request, check the selected provider's readiness, call store resume, launch only when `started` is true. If launch fails, use the existing launch-failure transition and return the retained run status. Register `run_resume` beside `run_cancel`; accept no new request, budget, provider override or free-form instruction.
- [ ] Extend the package test: copy the distributable, kill its owned worker with a fixture response held, expire/reconcile its lease through the test seam, call `run_resume` from a second MCP, release the fixture, then retrieve the same run ID. Assert saved answers remain, the uncertain attempt is charged, no new call exceeds original `maxCalls`, and startup/read never launch. No paid provider calls.
- [ ] Run `node --import tsx --test test/run-service.test.ts test/mcp.test.ts test/package.test.ts`. Expected GREEN: one resume launch, same run identity, and no automatic resume. Commit `feat: expose explicit run resume` through the tracked hook.

## Task 3: Add dry-run and transactional run deletion

- [ ] **Files:** `src/infrastructure/run-store.ts`, `src/application/run-service.ts`, `src/entrypoints/mcp.ts`, `test/run-store.test.ts`, `test/mcp.test.ts`. **Consumes:** existing cascade relationships and `run_cancel`; **produces:** `previewDelete(runIds)`, `deleteRuns(runIds)`, and `run_delete({runIds, dryRun?})` as typed above.
- [ ] Add tests first for exact preview counts with no selected-row deletion; empty/duplicate/missing selections; active `prepared` and `running` rows blocking deletion; all-or-none behavior when one target is invalid; FK cascade of evaluations and attempts; and state change between preview and deletion being revalidated.
- [ ] Run `node --import tsx --test test/run-store.test.ts test/mcp.test.ts`. Expected RED: absent API or deletion safety assertion fails.
- [ ] Implement preview by reconciling stale ownership through normal store behavior, then return each selected run's status and exact cascade counts. Preview never cancels a live worker or deletes evidence.
- [ ] Implement deletion in one `BEGIN IMMEDIATE` transaction. Validate all 1-200 IDs are unique, exist and terminal before deleting any. Run `PRAGMA foreign_key_check` and an integrity check before commit; roll back the entire request if validation fails. After commit run `PRAGMA optimize`; return per-run and aggregate removed counts. Never delete SQLite/WAL files manually.
- [ ] Register strict MCP input with `runIds` as 1-200 unique UUIDs; `dryRun` defaults false so preview is optional. Dry run returns preview and active blockers. Actual deletion returns an actionable structured active-work error instructing the agent to cancel, poll to terminal, then submit the explicit selection again.
- [ ] Rerun focused store/MCP tests. Expected GREEN: preview leaves records intact; actual delete is atomic and active work cannot be orphaned. Commit `feat: add controlled run deletion` through the tracked hook.

## Task 4: Manage and expose datastore health

- [ ] **Files:** `src/infrastructure/run-store.ts`, `src/application/run-service.ts`, `src/entrypoints/mcp.ts`, `test/run-store.test.ts`, `test/mcp.test.ts`, `README.md`, `skills/stimulus-response-polling/SKILL.md`, and `skills/stimulus-response-polling/references/run-and-recovery.md`. **Consumes:** Task 3 delete operation and existing resolved data root; **produces:** `storageInfo(): StorageInfo`, `optimizeStorage(): void`, and `run_storage({operation:'inspect'|'optimize'})`.
- [ ] Add tests first: isolated empty/populated databases return `integrity:'ok'`, byte size and exact row counts; after deletion counts decrease while surviving records are unchanged; optimization succeeds without changing requests/answers; database/native failures become safe structured errors without path or SQL.
- [ ] Run `node --import tsx --test test/run-store.test.ts test/mcp.test.ts`. Expected RED: missing API or a storage output/error assertion fails.
- [ ] Implement `storageInfo` with SQLite integrity check and counts plus the resolved database file size. Report `ok` only if integrity result is exactly `ok`; otherwise report `failed`. Return only the defined `StorageInfo` values.
- [ ] Implement `optimizeStorage` with `PRAGMA optimize`, expose strict `run_storage` inspection/optimization operations, and call optimize only after successful deletion commits. Do not invoke VACUUM, run maintenance at server startup, or start a maintenance process.
- [ ] Update README and shipped skill/reference with examples and instructions for same-ID resume, remaining attempt budget, retained uncertain/failed attempt history, nonresumable terminal states, optional deletion preview, cancel-and-wait before active deletion, storage health, and the rule that startup/read never resume. Keep output machine-readable and the agent's decisions with the agent.
- [ ] Build `dist/` and contracts if changed; run focused store/MCP/package tests. The final staged commit hook runs `npm run verify` and checks generated consistency. Expected GREEN: the agent can recover/remove/inspect runs without direct SQLite or filesystem access. Commit `feat: manage durable run recovery and storage` through the tracked hook.

## Task 5: Review and close out this slice

- [ ] Review the complete Plan 2 diff against SHEG-5, the epic, and the release roadmap in this inline execution. Fix substantiated Critical/Important findings and rerun affected checks; do not delegate because SHEG-5's delivery contract explicitly says no subagent delegation.
- [ ] Run the tracked staged-snapshot hook and confirm full verification, generated consistency, and a clean intended index. Commit each completed task through the hook.
- [ ] Update the roadmap with final commit/head, package/process evidence, gate result, review outcome, and remaining Plan 3 obligations. Keep SHEG-5 open until the run journey/query slices deliver its remaining accepted scope.
- [ ] Mark this plan `completed-awaiting-retirement` when preparing its completing PR; keep it tracked through that PR and retire it in the first commit of the next substantive slice after it is present on main.

## Handoff

The implementation branch is `codex/v0.3.0-release-spec`, based on `origin/develop` at `3c5b2f00037634e24b5a4766d37004a699c43d2c`. It already contains Plan 1 through `3d683e4` and its completed plan record. Continue inline on that same authorized v0.3.0 feature branch. The feature PR target is `develop`; no release version, tag, publication, or merge is authorized by this plan. Do not access the user's live provider keys or make paid calls for behavior tests.
