# Datastore Upgrade Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make the final v0.3.0 SQLite schema the first supported datastore baseline, migrate every later schema change safely, and keep an actionable MCP recovery surface available when startup cannot use the database.

**Architecture:** Make schema version 8 the v0.3.0 baseline by adding a small applied-migration ledger, and migrate the current development schema 7 to it through a sequential runner. Take and verify a SQLite-consistent backup before each migration, validate integrity before commit, and roll back without changing the source on failure. Separate MCP startup from successful store opening so compatibility inspection and explicitly confirmed reset remain available while ordinary study operations are blocked; reject unknown future schemas read-only.

**Tech Stack:** TypeScript, Node.js 24 `node:sqlite`, SQLite transactions and integrity checks, MCP tools, Node test runner.

**Spec:** `.agents/plans/v0.3.0-dogfood-improvements/roadmap.md`, Plan 9, and `.agents/specs/2026-10-02-v0.3.0-dogfood-improvements.md`.

**Execution Strategy:** `executing-plans` inline; migration and startup recovery share one datastore boundary and require one integrated implementation and whole-branch review.

**Base:** `develop` after PR #20, commit `027b3b983bbe95870eb8450bfc14ec1b0009f61a`.

**Feature target:** `develop`, product version `0.3.0-dev.11` from root `package.json`; use the supported version generator and keep generated package output reproducible.

**Scope:** Establish schema version 8 as the first supported v0.3.0 baseline; add the real schema 7-to-8 migration and a sequential per-version migration contract for later releases; create and verify a recoverable backup before changing a supported datastore; preserve all relational records, JSON payloads, lineage, answers, and physical-attempt accounting; keep startup and bounded maintenance tools available on unsupported, corrupt, or failed-migration stores; support explicit confirmed reset only after preserving a verified recoverable copy; supersede ADR-0018; retire the merged Plan 8 document and correct the roadmap's stale duplicate Plan 8/Plan 9 text.

**Invariants:** Pre-v1 development datastores older than schema 7 are disposable and receive no compatibility promise; the 7-to-8 migration is the final development transition, and the formal post-v0.3.0 support range begins at schema 8. Never auto-reset, silently reinterpret historical payloads, downgrade, mutate an unknown future schema during inspection, expose credentials or raw SQL, lose the original database on migration failure, increase a saved run's allowance, or enable normal study writes while recovery is required. JSON payload upcasters have explicit format versions separate from SQLite schema version and preserve historical evidence.

## Task 1: Lock the v7-to-v8 migration contract with source fixtures

- [ ] Add source-owned synthetic v7 and v8 schema fixtures with linked runs, evaluations, attempts, follow-on lineage, frozen request/packet JSON, and typed answers. Add failing tests for exact data and call-accounting preservation, unknown future schema byte-for-byte non-mutation, and refusal of non-empty unversioned or corrupt stores without implicit reset. Expected command: `node --import tsx --test test/run-store-upgrade.test.ts`.

## Task 2: Add the sequential migration and backup boundary

- [ ] Implement an explicit schema compatibility result and sequential migration runner around `src/infrastructure/run-store.ts`; inspect the schema before any mutating pragma; take and verify a SQLite-consistent backup before each applicable step; migrate schema 7 to 8 by adding the applied-migration ledger; run each migration transactionally; check `integrity_check` and `foreign_key_check`; advance `user_version` only on commit; and leave the original intact on any failure. Exercise migration failure and verify backup recovery. Expected command: `node --import tsx --test test/run-store-upgrade.test.ts`.

## Task 3: Keep bounded MCP recovery available during store failures

- [ ] Reshape default MCP startup so server registration completes even if datastore opening fails; make `run_storage.inspect` available in recovery mode; gate all study and destructive run tools with a safe `datastore_recovery_required` response; and add `run_storage.reset` requiring explicit confirmation after a verified backup is secured. Test through an in-memory MCP client for supported, future-schema, corrupt, and migration-failure states. Expected command: `node --import tsx --test test/mcp-storage-recovery.test.ts`.

## Task 4: Preserve independently versioned JSON payloads

- [ ] Preserve the existing checkpoint `formatVersion` and its v2/v3 upcasters independently from SQLite migration; test that database migration does not reinterpret checkpoint, request, or packet evidence; and add explicit payload upcasters only when a persisted payload contract evolves separately from the schema. Keep source-owned payload fixtures for every supported format and reject unknown formats without rewriting evidence. Expected command: `node --import tsx --test test/jobs.test.ts test/run-store-upgrade.test.ts`.

## Task 5: Record the durable compatibility contract

- [ ] Add ADR-0027 superseding ADR-0018 with the v0.3.0 baseline, supported-schema and upcaster policy, backup/rollback requirements, and recovery behavior; update `docs/decisions/README.md` and `docs/guides/releases.md` so every post-v0.3.0 schema-changing release carries tested forward migrations from each supported predecessor. Keep fixtures synthetic and source-owned; do not retain dogfood or migration-run receipts.

## Task 6: Reconcile the roadmap, retire completed plan, and align candidate version

- [ ] Update the dogfood roadmap to mark Plans 1-8 merged, correct the Plan 9 title and acceptance text, point at this active plan, and leave Plan 10 JIT; retire the completed Plan 8 package plan in this successor change. Align all version surfaces to `0.3.0-dev.11` through the supported package identity workflow.

## Task 7: Run final verification

- [ ] Run focused migration and MCP recovery tests, `npm run build`, `npm run verify`, and `git diff --check`; inspect the v0.3 package baseline and generated plugin copy, and verify no real user datastore or credential is included in fixtures. Do not repeat the full gate without a new change or unresolved concern.

**Key files:** `src/infrastructure/run-store.ts`, `src/entrypoints/mcp.ts`, `src/application/run-service.ts`, `src/infrastructure/checkpoint-store.ts`, `test/run-store-upgrade.test.ts`, `test/mcp-storage-recovery.test.ts`, `test/jobs.test.ts`, source-owned datastore fixtures, `docs/decisions/0018-store-durable-runs-in-sqlite.md`, new ADR-0027, `docs/guides/releases.md`, `.agents/plans/v0.3.0-dogfood-improvements/roadmap.md`, and generated `plugins/sheg/`.

**Non-goals:** Migrate v0.3.0-dev.10 or older prerelease databases; add network or cross-host storage; expose filesystem paths, credentials, or SQL through ordinary study tools; publish a release tag or GitHub Release; implement unrelated study behavior or UI.

**Review Focus:** Inspect startup ordering and ensure tools initialize even with unreadable or unsupported databases; prove read-only inspection leaves unsupported files unchanged; verify the real 7-to-8 migration and its backup, transaction rollback on step/integrity failure, preservation of synthetic run/answer/attempt history and exact allowances, existing versioned upcasters, and blocking of study operations until recovery succeeds. Assess whether a later release can add a real schema migration without changing the schema-8 baseline fixture or bypassing tests.
