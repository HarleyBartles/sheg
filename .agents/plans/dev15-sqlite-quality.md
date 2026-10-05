# SQLite responsibilities and read costs

**Goal:** Decompose the SQLite adapter by responsibility and reduce unnecessary dispatch, evidence-query, and connection-opening work without changing durable evidence semantics.

**Authority:** The user approved both the SQLite decomposition and read-cost work as a new slice into `develop`, assigned `0.3.0-dev.15`, and requested a fresh worktree from merged PR #25. Base: `3e8876153d278241012e13f4301a7738ff03e837`. Workspace: `Z:/_agent-worktrees/sheg/codex/dev15-sqlite-quality`, branch `codex/dev15-sqlite-quality`.

**Execution:** Sequential inline execution. Follow `.agents/runbooks/implementing.md`; publish a reviewable PR to `develop`. Keep this plan through its completing merge. Retire completed predecessor plans in the first commit. No inference, release tag, or stable publication is needed.

## Contracts

- Preserve schema compatibility, stored payload bytes, request and compiler identities, evidence pagination, accounting, cancellation, leases, explicit recovery, and original call allowance.
- The adapter facade owns transaction boundaries. Answer settlement, attempt settlement, respondent advancement, and next-turn creation stay atomic. Extracted modules do not commit independently inside that operation.
- Application storage capabilities belong to an application-owned port. SQLite schema, migration, row decoding, recovery, and evidence query implementation belong under `src/infrastructure/sqlite/`.
- Measure repeatable mock workloads before and after read changes. Keep run data and measurements in off-repository scratch; retain useful benchmark code only if it serves repeatable future diagnosis. Do not add elapsed-time assertions or benchmarks to CI.
- Full integrity and foreign-key checks remain mandatory around migrations and verified backups and in explicit storage health inspection. Any cheaper normal-opening policy must explain its limits and retain safe recovery behavior.
- Tests verify behavior and consistency, including historical decoding, current-turn ownership, cursor freshness, mapped/no-fit coverage, and concurrent read/write behavior. Do not assert filenames or implementation inventories.

## Task 1: Separate cohesive SQLite responsibilities

**Files:** `src/application/run-store.ts` for the consumer storage port and its types/errors; `src/infrastructure/sqlite/rows.ts` for strict SQL primitive decoding; `schema.ts` for schema identity, creation, migrations, backup verification and connection setup; `recovery.ts` for compatibility inspection and explicit reset; `evidence-query.ts` for criteria, cursor, coverage and page rendering. Keep `src/infrastructure/run-store.ts` as the adapter and compatibility export facade. Update application/runtime imports to the appropriate owner.

- [ ] Map dependencies and capture a repeatable baseline for accumulated journey reads, paginated evidence queries and repeated opens using real SQLite and mock responses.
- [ ] Extract the port, SQL decoding, schema/migration and recovery responsibilities without changing behavior. Avoid cycles between recovery and the adapter by sharing connection creation.
- [ ] Extract evidence-query preparation, coverage and rendering as one cohesive responsibility, retaining the adapter's transaction coordination.
- [ ] Run store, migration, recovery, service, worker and MCP behavior coverage; inspect the structural diff for responsibility ownership and commit.

## Task 2: Bound worker reads to the reserved journey turn

**Files:** application storage port, SQLite adapter/read helpers, `src/application/question-worker.ts`, worker/store behavior tests.

- [ ] Define a worker read returning the validated frozen journey/request identity, the reserved current evaluation, its respondent state/profile, and the counts needed for next ordinal and node occurrence. Read only that respondent's accumulated history, not every saved packet or respondent.
- [ ] Preserve turn/context ownership, packet fingerprint and compiler checks. Reuse decoding with full public journey recall, which continues to validate all recalled records.
- [ ] Prove sequential advancement, reconvergence/occurrences where supported, respondent-local recovery and earlier-answer preservation. Verify unrelated history is not materialized on each turn while invalid current-turn evidence fails safely.
- [ ] Replace per-turn `getJourneyRun` with the bounded read, compare the same mock workloads, run focused tests, and commit.

## Task 3: Keep evidence-page processing in a consistent read snapshot

**Files:** SQLite adapter and evidence query module, store/query behavior tests.

- [ ] Finish lease/launch reconciliation in a short write transaction, then establish one read snapshot for source status, lifecycle, cursor checks, denominators, matched coverage and page rows. A concurrent change before the snapshot is reflected or makes the cursor stale; a change after snapshot establishment cannot mix revisions within one page.
- [ ] Reduce full packet materialization in matched selected-material counting by projecting only the required stored fields while preserving both historical answer representations, material mapping/no-fit semantics, and safe failure behavior.
- [ ] Verify accurate pagination, forged/stale cursor rejection, partial-run coverage and read/write concurrency with deterministic synchronization. Keep atomic settlement separate from query processing.
- [ ] Compare page workloads and contention before/after; run focused query, follow-on, worker and MCP coverage and commit.

## Task 4: Measure and improve normal connection startup

**Files:** SQLite schema/connection module, migration/recovery tests, maintained operational documentation or an ADR if the integrity policy changes.

- [ ] Measure schema validation, full integrity, foreign-key checks and total repeated-open cost against representative populated stores. Consult SQLite's documented check and WAL snapshot guarantees.
- [ ] Choose and implement a cheaper normal-opening policy supported by those measurements. Keep full migration/backup/health checks and missing-schema, unreadable-store and safe-recovery handling. Explain which corruption classes are detected at opening versus explicit inspection.
- [ ] Verify the new policy's safety boundaries through real malformed/migrating stores, retain all migration rollback and backup coverage, repeat measurements, and commit.

## Task 5: Dev.15 package and PR closeout

- [ ] Set only root `package.json` to `0.3.0-dev.15`, regenerate canonical contracts/runtime/plugin package and ZIP.
- [ ] Review every changed document for accurate current guidance; promote consequential decisions to ADRs without retaining development receipts.
- [ ] Run focused checks and `npm run verify`; inspect canonical/generated parity and the full branch diff. Obtain fresh whole-branch review and resolve actionable findings.
- [ ] Push and open the PR into `develop`, verify its exact published head and hosted check, and keep the worktree for review. No human-owned merge task remains in the plan.
