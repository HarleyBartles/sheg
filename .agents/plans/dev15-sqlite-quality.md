# Typed SQLite repositories and read costs implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/executing-plans` to implement this plan task by task.

**Goal:** Establish typed read and command repositories over Drizzle, a sound v0.3.0 SQLite baseline, safe forward migrations, and bounded read costs, then publish the complete dev.15 change as a draft PR into `develop`.

**Architecture:** Application services consume separate read and command ports over one SQLite persistence owner. Infrastructure owns named projections, validated payloads, Drizzle schema/query/write implementation, transaction boundaries, migration safeguards, and recovery. Schema 9 becomes the first supported release baseline; prior development stores require explicit recovery.

**Tech stack:** Node 24, TypeScript, `node:sqlite`, exactly pinned `drizzle-orm@1.0.0-rc.4`, development-only `drizzle-kit@1.0.0-rc.4`, existing Zod and esbuild.

**Spec:** [Typed repositories and the v0.3.0 SQLite baseline](../specs/2026-10-05-typed-sqlite-repositories.md).

**Authority:** The user approved both the SQLite decomposition and read-cost work as a new slice into `develop`, assigned `0.3.0-dev.15`, and requested a fresh worktree from merged PR #25. Base: `3e8876153d278241012e13f4301a7738ff03e837`. Workspace: `Z:/_agent-worktrees/sheg/codex/dev15-sqlite-quality`, branch `codex/dev15-sqlite-quality`.

**Execution strategy:** `/executing-plans`, sequential inline work. The schema, codecs, repositories, application cutover, and migration safety share transaction contracts and fixtures. Follow `.agents/runbooks/implementing.md` and the required review/verification workflows. No inference, release tag, or stable publication is needed.

**Execution:** The user approved execution. Preserve completed Task 1 and keep this plan/spec through the completing PR.

**Delivery order:** Tasks 2-4 establish schema ownership and the application-facing repository ports over the shared SQLite owner while the existing runtime remains buildable. Task 5 routes services and entrypoints through those ports after behavior parity is proved.

## Contracts

- Preserve CLI/MCP behavior, submission/request/compiler identity, frozen model-visible evidence, selected-material isolation, cancellation, leases, respondent-local recovery, and original call allowance.
- Schema 9 is the first supported release baseline. Never auto-reset an older development database. Keep maintenance inspection and explicit verified-backup/quarantine recovery available.
- From v0.3.0 onward, use sequential forward migrations or explicit in-memory payload upcasters. Unknown future schema/payload versions fail safely without alteration.
- Drizzle table declarations own the relational schema and storage types. Reviewed generated migration SQL and snapshots live outside `src/`; Kit is development-only. Do not retain a second latest-schema DDL or handwritten column inventory.
- Application-owned read and command ports return declared domain shapes. Drizzle objects, SQLite rows, and unchecked generic result assertions stay in infrastructure. Read methods do not mutate; services explicitly reconcile before current-state reads.
- Commands validate live preconditions and mutate under the same immediate transaction. Related reads use one deferred snapshot. Attempt settlement, accounting, winning links, respondent revision, and next-turn creation commit atomically.
- Tests exercise behavior, consistency, and safe failure, not file inventories or implementation repetition. No paid inference is needed. Keep performance measurements and spike code off-repo; do not add timing assertions or results to CI or source.
- Stage working task boundaries through the tracked hook. Use focused checks while editing and regenerate before staging. The hook runs the full staged `npm run verify`; do not repeat that gate around a successful hooked commit without a concrete reason.
- Preserve the completed Task 1. Retain this live plan/spec through the completing PR, then retire them under planning custody. They do not enter `main`. The handoff is a verified draft PR, not a human-owned merge.

## Review focus

- A table rebuild can pass integrity checks while losing cascaded children: Task 2 verifies populated evidence and rollback.
- Backup freshness, live worker leases, and concurrent openers can race: Task 2 verifies locked rechecks, deferral, and schema fencing.
- ORM row types do not validate a corrupted datastore: Task 3 verifies runtime decoding and safe failure; empty evidence pages retain full coverage.
- Zero-dispatch failure, partial batches, and uncertain calls can drift from the physical-call ledger: Task 4 verifies accounting and winning links together.
- A runtime can accidentally depend on the checkout: Task 8 verifies a copied package without dependencies, including migrations and mock worker execution.

## Task 1: Separate cohesive SQLite responsibilities

**Files:** `src/application/run-store.ts` for the consumer storage port and its types/errors; `src/infrastructure/sqlite/rows.ts` for strict SQL primitive decoding; `schema.ts` for schema identity, creation, migrations, backup verification and connection setup; `recovery.ts` for compatibility inspection and explicit reset; `evidence-query.ts` for criteria, cursor, coverage and page rendering. Keep `src/infrastructure/run-store.ts` as the adapter and compatibility export facade. Update application/runtime imports to the appropriate owner.

- [x] Map dependencies and capture a repeatable baseline for accumulated journey reads, paginated evidence queries and repeated opens using real SQLite and mock responses.
- [x] Extract the port, SQL decoding, schema/migration and recovery responsibilities without changing behavior. Avoid cycles between recovery and the adapter by sharing connection creation.
- [x] Extract evidence-query preparation, coverage and rendering as one cohesive responsibility, retaining the adapter's transaction coordination.
- [x] Run store, migration, recovery, service, worker and MCP behavior coverage; inspect the structural diff for responsibility ownership.

## Task 2: Author the release-baseline schema, codecs, and migration runner

**Files:** Add `src/infrastructure/sqlite/tables.ts`, `payload-codecs.ts`, and `connection.ts`; keep the Sheg-owned migration runner in `schema.ts`; generate reviewed SQL and snapshots in `migrations/`; add `drizzle.config.ts` and the migration generation command; update `package.json`, lockfile, recovery modules, and SQLite schema/migration tests.

**Interface:** The tables module exports Drizzle declarations and inferred storage types. The connection module opens a version-fenced SQLite owner. The schema module exposes fresh initialization and sequential upgrade through a verified backup and ledger. Payload codecs encode versioned values and decode unknown storage into domain contracts.

- [x] Pin `drizzle-orm` and development-only `drizzle-kit` to `1.0.0-rc.4`. Define schema 9 from the actual durable entities, with non-null identities, scoped foreign keys, status/count constraints, relevant unique keys and measured indexes. Generate the baseline migration, inspect its SQL, and verify fresh initialization produces exactly that schema.
- [x] Define versioned stored representations for answer and failure payloads. Persist poll and journey answers as `DecisionValue`, retain execution evidence on the physical attempt, and decode composed public results through shared runtime codecs. Reject unknown payload versions and invalid values safely; relational status, range, link, and fingerprint validation is covered by constraints and runtime checks. Requests, packets, and checkpoints remain validated identity-bound snapshots.
- [x] Implement a Sheg-owned migration runner with sequential checksummed history, verified SQLite-consistent backup, writer-locked backup freshness recheck, bounded retry, live lease/launch deferral, old-connection fencing, and transactional rollback. For table rebuilds, set foreign-key mode before the transaction, validate foreign keys and integrity before commit, and restore enforcement on every exit.
- [x] Exercise real SQLite constraints, JSON/version failures, atomic rollback, populated linked-evidence preservation, injected failure, concurrent migration, live-work deferral, and old-connection refusal. Use a test-only successor migration to prove the forward contract; do not ship an unused product migration or a second latest-schema DDL. Run focused tests.

## Task 3: Build side-effect-free read repositories

**Files:** Replace the combined port in `src/application/run-store.ts` with `RunReadRepository` and declared result shapes; add focused read modules under `src/infrastructure/sqlite/` for run identity/discovery, journey, evidence/context, and attempts; update `test/run-store.test.ts` and worker read coverage.

**Interface:** `RunReadRepository` supplies named operations for submission lookup, run discovery/status, accepted request, full journey, reserved worker turn, evidence page, context, follow-on source, answers, attempts, deletion preview, and storage inspection. Each method returns a validated application/domain shape and performs no reconciliation or mutation.

- [ ] Write behavior tests around malformed persisted data and snapshot-consistent reads, then implement explicit Drizzle projections and runtime decoding. Keep Drizzle/SQLite types and unchecked raw SQL out of application code. If a complex query needs Drizzle SQL fragments, parse its unknown projection before returning it.
- [x] Read a worker's frozen identity, reserved evaluation, respondent checkpoint/profile and ordinal/occurrence facts without materializing unrelated respondents or every earlier packet. Preserve current-turn ownership, compiler/fingerprint checks, reconvergence, and full validation during public recall.
- [x] Make evidence queries use one deferred snapshot. Reuse a lightweight materialized match set for coverage and page selection, hydrate full payloads only for the bounded page, and retain correct selected-material/no-fit counts, empty-page coverage, cursor rejection and partial-run semantics.
- [x] Batch discovery status, attempt identity/failure, and acceptance-time source-selection lookups so result counts and selected handles do not introduce per-row queries. Resolve follow-on source records in one bounded projection.
- [ ] Verify a concurrent writer cannot mix revisions within one evidence page and inspect query plans; add focused behavior coverage only if those checks reveal a contract gap.

## Task 4: Build transactional command repositories

**Files:** Add `RunCommandRepository` to `src/application/run-store.ts`; add focused command modules under `src/infrastructure/sqlite/` for acceptance, worker, and lifecycle mutations; update existing SQLite store/worker/recovery behavior tests and add `test/run-command-repository.test.ts` where a distinct contract gap exists.

**Interface:** `RunCommandRepository` owns acceptance, claims/heartbeats, attempt reservation and settlement, journey advancement, finish/failure, cancellation, resume, reconciliation, deletion and optimization. Batch reconciliation accepts the relevant run set; commands validate live preconditions and write under one immediate transaction.

- [ ] Use typed Drizzle writes under one connection owner. Verify expected schema and command preconditions within the immediate transaction; keep provider I/O outside it. Account for zero, one, and uncertain physical calls in the attempt ledger and run projection together.
- [x] Atomically settle attempt outcome, winning answers/links, respondent revision and next-turn creation. Preserve original call allowance, respondent-local retry, partial-batch success, cancellation, idempotency, and stale lease rejection.
- [ ] Implement explicit batch reconciliation for service use without hidden mutations in reads. Verify failed reconciliation is surfaced, and prove settlement rollback and cross-run/group identity rejection with real SQLite behavior tests. Run focused checks and commit.

## Task 5: Cut application and entrypoints over to the repository owner

**Files:** Update `src/application/run-service.ts`, `src/application/question-worker.ts`, runtime wiring, CLI/MCP composition, and the shared SQLite owner in `src/infrastructure/run-store.ts`; add the connection and focused query/command modules under `src/infrastructure/sqlite/`; update affected service, CLI, MCP and worker tests; add superseding ADRs and update `docs/decisions/README.md`.

**Interface:** `openRunPersistence` returns one `RunPersistence` owner with `{ reads: RunReadRepository, commands: RunCommandRepository, close(): void }`. Services explicitly invoke commands to reconcile before current-state reads, then call named read methods. CLI and MCP use the same services.

- [x] Route application and entrypoints through the new ports. Preserve external request/response schemas, failure reporting, frozen evidence, deletion preview, and stored credential path. Keep the shared SQLite owner behind separate read and command interfaces.
- [x] Inspect the prior in-flight worker-read edits before carrying them forward; retain useful tests and DTOs, but remove any speculative handwritten query wrapper made redundant by Drizzle. Remove legacy pre-release answer-format heuristics once schema 9 decoding owns the single representation.
- [x] Record the consequential ORM/schema-source, read/command boundary, and schema-baseline decisions as one ADR each, superseding ADR-0027 where appropriate. Update the index without preserving development results. Verify CLI/MCP/service/worker behavior with focused tests.

## Task 6: Prove bounded reads and workload costs

**Files:** Read repository queries, `src/application/question-worker.ts`, existing worker/query tests, and justified SQLite indexes.

- [ ] Run representative mock-provider journeys at 4x12, 8x24 and 12x36 respondent/turn scales, plus evidence pages over 640 and 10,000 evaluations. Compare database query count, rows decoded, checkpoint/payload materialization, and memory growth with the Task 1 baseline; keep results off-repo.
- [ ] Fix any remaining per-turn full-run materialization, per-row follow-on/status/attempt lookups, or repeated coverage/page scans revealed by the comparison. Use the same materialized data twice when it serves both summary and page, and justify hot prepared statements/indexes from query plans.
- [ ] Verify unrelated history is not decoded on each turn and that malformed current-turn evidence fails safely. Add behavior tests only for actual contract gaps; avoid timing thresholds and query-text snapshots. Run focused checks and commit.

## Task 7: Set a measured normal-open integrity policy

**Files:** `src/infrastructure/sqlite/connection.ts`, migrations/recovery modules, targeted opening/recovery tests, and operational documentation.

- [ ] Measure schema/history metadata checks, full integrity, foreign-key checks and total open time on representative populated stores. Use the measurements to keep cheap version/ledger/structural validation on normal open while reserving full scans for migration, verified backup and explicit health inspection.
- [x] Ensure missing schema, malformed/future version, damaged payload, old open connection and unsupported pre-release store report safe bounded maintenance outcomes without mutation. Document what normal open detects and what requires explicit inspection or record access.
- [x] Exercise malformed stores, current baseline initialization, test-only forward upgrade, backup recoverability and deliberate corruption in real SQLite.

## Task 8: Generate dev.15 distributions and open the review PR

**Files:** Root `package.json`, lockfile, build/packaging scripts, generated `dist/` and `plugins/sheg/`, package/ZIP parity tests, license notices, and changed user-facing documentation.

- [x] Set only the root authored version to `0.3.0-dev.15`. Generate all identity-bearing manifests and bundles from it. Include runtime migration SQL/manifest and Drizzle license notices, while keeping Kit, source, test fixtures, plans, scripts and snapshots out of the installed plugin.
- [x] Copy the generated plugin outside the checkout and without `node_modules`; prove fresh initialization, named reads/writes, mock worker execution and migration from a schema-9 fixture. Verify required assets and runtime identity match in Git marketplace and ZIP contents.
- [ ] Review all changed documentation for current truth and concise guidance. Run `npm run contracts:build`, `npm run build`, and `npm run plugin:package`; use `npm run verify` for uncommitted diagnosis when needed, then stage through the tracked hook and confirm its staged-snapshot `npm run verify` passes. Review the entire branch against `develop`, fix actionable findings, and publish a draft PR targeting `develop`.
- [ ] Verify the published PR head and hosted check, attach the PR to the task, and leave the worktree available for review. The release tag and merge to `main` are outside this slice.
