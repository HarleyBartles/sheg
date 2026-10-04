# Shared entrypoints implementation plan

> **For agentic workers:** Use executing-plans sequentially. Obtain fresh whole-branch review after the roadmap is complete.

**Goal:** CLI and MCP enter one durable Sheg application system.

**Architecture:** Extract runtime composition and datastore recovery from the MCP entrypoint into a common infrastructure composition module. CLI translates explicit arguments and file input into current RunService calls, while retaining keyless manifest trace/preflight diagnostics. Retire RunManager and its separate execution worker. Keep historical file-backed evidence decoding/reporting as an explicitly read-only compatibility surface; it cannot accept, mutate, cancel or resume runs.

**Tech Stack:** Node 24, TypeScript, SQLite, Zod, node:test.

**Spec:** [roadmap.md](roadmap.md). The user explicitly approved one set of services with multiple entrypoints.

**Execution Strategy:** executing-plans, Native inline execution.

## Global constraints

CLI and MCP resolve the same default data root, use the same worker launcher and secure provider factory, and preserve SQLite identity and migration guarantees. No paid calls. File-backed pre-release records are read-only historical input, never silently imported or resumed. Preserve deterministic diagnostic behavior. Supporting tests must verify real service interactions and cross-entrypoint recall rather than assert a particular source layout.

## Review focus

- A CLI-started request is visible through MCP using the same RunService and datastore; repeated submission retains identity.
- CLI cancellation/resume preserves earlier evidence and original call allowance through existing service behavior.
- CLI errors are structured and bounded; raw provider/JSON/file errors cannot leak payloads.
- Recovery remains available when datastore startup fails; both entrypoints use one schema version and recovery coordinator.
- Historical reporting is read-only and clearly distinct from current durable runs.

### Task 1: Shared runtime composition and CLI services

**Files:** Create `src/infrastructure/run-runtime.ts`; keep shared operation schemas with the existing run request contracts in `src/domain/run/request.ts`. Modify `src/entrypoints/cli.ts` and `mcp.ts`. Supporting tests include `test/cli.test.ts`, `test/prelaunch.test.ts`, MCP storage recovery, and release-package coverage.

**Interfaces:** `createRunRuntime(dataRoot?, service?)` returns the service, storage operations, and `close()`. Runtime owns startup compatibility/recovery and optional store lifetime; an injected service is not closed by the runtime. CLI `runCli(args, io, service?)` delegates to the runtime service. `inspect` and `start` accept `--request` JSON; `start` also requires a `--submission-id` UUID. `get`, `list`, `query`, `cancel`, `resume`, `delete`, and `storage` expose durable service operations. `--data-root` optionally selects an explicit store. Preserve keyless `trace`/`preflight`. Require known unique flags and current schema validation before dispatch.

- [x] Replace obsolete CLI check/start contract tests with current direct-request admission tests. Add a real temporary RunService fixture with injected mock provider and worker launcher; start through CLI, recall/query through MCP service, retry same submission and cancel through CLI. Add safe malformed-input and unknown/duplicate flag behavior. Witness failures before implementing.
- [x] Extract runtime composition/recovery and shared operation schemas; replace CLI execution commands with service adapters. Confirm start returns promptly and the copied bundled CLI can access the copied worker. Keep invalid arguments/help from opening a datastore.
- [x] Run focused CLI, report, historical decoding, prelaunch, journey and credential boundary tests. Regenerate affected artifacts and add a shared-runtime ADR.

### Task 2: Retire the second lifecycle and separate historical reports

**Files:** Remove src/application/run-manager.ts and worker.ts. Replace writable checkpoint-store.ts with a read-only historical decoder under infrastructure/legacy; move legacy report loading/building under application/legacy and keep comparisons in a cohesive shared module. Remove obsolete execution tests only when their supported behavior has coverage through the shared durable system. Retain/move meaningful historical decoding tests. Update README, CLI reference and shipped references.

**Interfaces:** legacy-report --output --run-id reads existing pre-release checkpoint files without writing them or launching work. Report comparison accepts report JSON inputs and uses one shared typed task difference function. New durable evidence is recalled through get/query; no new file checkpoints are created. Historical evidence remains intact. There is no compatibility promise for resuming pre-release file runs.

- [x] Add report comparison behavior cases for changed Score rubric, Noul criteria and response-history policy; share task differences for same-run and cross-run comparisons. Add a historical report check proving source checkpoint bytes are unchanged after reading.
- [x] Remove lifecycle-only classes/methods and their caller-only tests; move the immutable historical schemas/decoder and report building together. Preserve ordinary domain journey execution for trace. Correct documentation advertising unsupported preview/variant CLI commands.
- [x] Run focused CLI, report, historical decoding, prelaunch, journey and credential boundary tests. Regenerate affected artifacts and add a shared-runtime ADR.

### Task 3: Lock publication and architectural decision

**Files:** src/infrastructure/process-lock.ts, its focused behavior tests, docs/decisions index and a superseding shared-runtime ADR.

**Interfaces:** ProcessLock remains needed by datastore reset even after file execution retires. Ownership publication must avoid empty-lock crash traps while preserving exclusivity and live-owner safety. Choose a complete-record publication protocol with atomic link/rename semantics verified on supported Node/Windows rather than deleting ambiguous partial owners.

- [x] Prove recovery from incomplete publication and concurrent contenders with real file operations; preserve stale-owner and release ownership checks.
- [x] Implement complete ownership publication, narrowly document its invariant, and run focused lock and storage-recovery checks.
- [x] Record the durable shared-runtime decision and write follow-on plans against the new application seams.
