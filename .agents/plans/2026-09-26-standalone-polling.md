# Standalone System One Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one ambient Codex plugin whose TypeScript harness runs bounded, reproducible simulated-reader studies against explicitly selected Jev or local Laya.

**Architecture:** A standalone versioned manifest built from domain-neutral stimulus items, decision points, and explicit transitions, plus a frozen cohort, feeds one bounded journey engine and one provider-neutral decision contract. The CLI and bundled MCP server call the same durable job controller; provider adapters handle Jev and Laya wire formats. Build runnable JavaScript into the plugin package, with no Python runtime in the installed plugin.

**Tech Stack:** Node.js 24 LTS, TypeScript strict mode, npm with committed `package-lock.json`, Zod for runtime validation, Node's test runner with `tsx` for TypeScript tests, `esbuild` for bundled Node entry points, official MCP TypeScript SDK, and OpenRouter TypeScript SDK only if its Decisions API attempt and usage behavior can be verified. Pin exact direct dependency versions when installing them. No Python core.

**Spec:** `.agents/specs/2026-09-26-system-one-polling-design.md`

**Execution Strategy:** `executing-plans`, as previously selected by the user. Contracts and jobs are tightly coupled; one inline owner can keep the types, budget semantics, and package launch aligned. A fresh whole-branch review follows implementation.

## Global constraints and transition

- Work in `Z:\_agent-worktrees\system-one-polling\port-simulated-reader-polling`, the existing linked worktree. Inspect branch, status, and current remote before any further source edits. The user explicitly chose this worktree, so do not switch its in-flight branch to main. Do not edit Portfolio or installed plugins.
- Portfolio main commit `9d0864d0f4d3da4e451168cfd14ec080636ad25c` is a trial to learn from, not a runtime dependency or exact-route oracle. The standalone `1.0` manifest is the sole input; old `0.0.5` manifests need explicit conversion and are not silently accepted.
- Keep domain-neutral stimuli, future-blind prompts, frozen cohorts, explicit choice transitions, bounded traversal, ordered exposure history, and honest denominators. Article, scan, optional-content, and chapter patterns belong in study graphs, not engine-specific invariants.
- Jev requires a call and local spend cap. Laya requires a call cap and a verified fit mechanism. Reserve a conservative declared `maxPerCallUsd` for each Jev attempt before dispatch; reject a run with no defensible allowance. A provider bill above the allowance may overshoot the local cap: record it, stop new calls, and never present the local cap as a provider-side hard limit. Never change provider mid-run, start local weights, trim inputs, invent a cost or model revision, or issue a paid call in routine tests.
- Require explicit output directory for runs. Keep stimulus and execution fingerprints distinct. No credentials or source text in checkpoints or reports. An interrupted run requires explicit resume; completed journeys are not repeated.
- The owner can maintain TypeScript directly. Prefer focused modules, explicit public types, runtime validation at external boundaries, and readable domain names over generated abstraction layers.
- The committed article/scan manifest prototype is superseded by the generic graph contract below. Keep its source-hash and cohort evidence behavior where applicable; replace beats/asides/scanCards and their hard-coded route semantics. Portfolio articles and novel chapters must both be expressible without domain-specific engine branches.
- `npm test` recursively discovers `test/**/*.test.ts` with `node --import tsx --test`; `npm run lint` runs the pinned ESLint/typescript-eslint recommended rules over `src/` and `test/`; `npm run typecheck` means `tsc --noEmit`. The tracked hook runs lint, then tests when any test file exists. `npm run build` bundles the thin `src/entrypoints/cli.ts`, `src/entrypoints/mcp.ts`, and `src/entrypoints/worker.ts` for `node24` into `dist/cli.js`, `dist/mcp.js`, and `dist/worker.js`. Keep runtime imports bundle-safe. `dist/` is tracked so the plugin installed from this repo runs without a build at install time; regenerate and stage it with source changes. The lockfile is tracked.
- The initial prototype and its Python runtime were removed during the TypeScript pivot. The final cleanup removed ignored pytest cache and compiled bytecode; there are no Python project artifacts in the repo. Two Python RED drafts remain in external scratch at `Z:\_agent-scratch\system-one-polling\python-red-drafts-2026-09-26` as reference only; do not copy Python implementation into this repo.
- The repo has no `.agents/runbooks/planning.md` at plan revision time. This plan and the spec are the local planning guides; if a runbook appears during execution, read it then. The tracked pre-commit hook must run the current test command once tests exist, including from a staged commit, without bypassing the hook.

## File map and interfaces

All paths below are relative to this linked worktree. Private helpers may change, but public seams must stay coherent.

| Path | Ownership and public seam |
| --- | --- |
| `src/domain/study/`, `src/domain/readers/` | `manifest.ts` owns graph schemas and `StudyManifest`; `load-study.ts` owns `Study` and source verification; `profile.ts` owns `ReaderProfile` and cohort validation. |
| `src/domain/decision/` | `contract.ts` owns shared decision request/result schemas and types; `validate.ts` owns response policy checks; `prompt.ts` owns future-blind rendering and stable `promptContractHash`. |
| `src/domain/journey/` | `runJourney(study, profile, ask): Promise<JourneyResult>`; bounded generic graph walker and chronological exposure/choice events. |
| `src/application/` | `checkStudy`, `traceStudy`, run lifecycle, reports; use cases coordinate domain contracts without owning transport or persistence details. |
| `src/providers/jev.ts`, `src/providers/laya.ts` | Explicit Jev and Laya adapters; `checkLayaFit` returns measured fit or unsupported-input. |
| `src/infrastructure/` | Stimulus/execution identity, checkpoint store, serialized budget ledger, and process lock implementations. |
| `src/entrypoints/cli.ts`, `src/entrypoints/mcp.ts`, `src/entrypoints/worker.ts` | Thin executable adapters over application use cases; no duplicate decision or journey logic. |
| `plugin.json`, `mcp.json`, `skills/simulated-reader-polling/`, `dist/` | Portable plugin metadata, skill, and runnable built JavaScript. The distribution must start when copied away from the source checkout. |

This is a responsibility-based modular monolith. Keep module boundaries shallow and ownership obvious; do not add workspace packages, framework boilerplate, or catch-all `shared`/`utils` folders. Place Zod schemas beside the domain/input boundary they validate. Keep tests in a separate `test/` tree, grouped by major responsibility as it grows, rather than interleaving them with runtime files.

Use `test/*.test.ts` and `test/fixtures/` for focused behavior and fake transports. Keep generated run evidence in temporary test directories. No test should merely mirror an implementation branch or detect arbitrary source changes.

The standalone `1.0` manifest uses domain-neutral graph primitives: `version`, `study: { title, purpose }`, `sources: [{ path, sha256 }]`, `items: [{ id, text }]`, `decisions: [{ id, instructions, criteria }]`, `nodes`, `transitions`, `entryNodeId`, and `maxDecisions`. A node is an `expose` node referencing one item, a `decide` node referencing one decision, or a `terminal` node with an authored outcome label. A transition links a source node to a target node; expose nodes have one unconditional edge, while decide nodes have one edge for each offered criterion label. Resolve source paths from the manifest directory unless explicitly absolute. Reader-visible content is drawn only from items exposed by traversed nodes; source paths and hashes are evidence only. A frozen cohort input remains `version`, ordered `readers: [{ id, archetypeId, profileText }]`, and `admission: { rationale, frozenAt }`. Runtime schemas reject unknown keys, dangling references, duplicate IDs, missing or extra edges, and unreachable nodes. An article, scan entry, optional aside, or book chapter is encoded in items and graph edges, not special engine logic. Replace the Task 1 example fixture with an article example and add a chapter-shaped fixture demonstrating the same primitives.

Every traversal is bounded by `maxDecisions`, including cyclic graphs. Exposure and choice events retain stable IDs and chronological order, not prompt/source text. The generic reducer records authored terminal outcomes and never invents article-specific outcomes or assumes optional material has a special status.

## Review focus

1. A source changes between `check` and `start`: start rehashes and refuses dispatch (Tasks 1A and 7).
2. The local response advertises a generic model but routes to another checkpoint: refuse its choice (Task 6).
3. Cancel arrives with a request in flight: record its outcome and usage, dispatch nothing further (Task 8).
4. Worker dies while checkpoint says running: report partial and resume only incomplete journeys (Task 8).
5. Reports have the same manifest but a different cohort order or prompt contract: refuse comparison (Task 9).

---

### Task 1: Replace the prototype with the standalone study contract

**Files:** Initial prototype created the TypeScript package, `src/study.ts`, `src/profiles.ts`, tests, and article/scan fixtures while removing Python-only runtime files. This committed article-shaped prototype is superseded by Task 2 before downstream implementation continues.

**Interfaces:** Initial prototype produced `Study`, `ReaderProfile`, and `loadStudy(manifestPath, cohortPath)` with article/scan-shaped fields. Task 2 replaces the study contract before dependent tasks proceed. Cohort and source-integrity behavior remain in scope.

- [x] Inspect `git status`, the modified ignore file, and the preserved Python RED drafts in the named scratch directory. Carry their useful behavioral assertions into Tasks 1 and 2. Bootstrap the exact npm scripts above with pinned `typescript`, `tsx`, `esbuild`, `zod`, and `@types/node` so a RED test can run.
- [x] Write initial `test/study.test.ts` for an article and scan manifest, frozen ordered cohort, relative and explicitly absolute source references, changed source hash, invalid route/aside references, old `0.0.5` rejection, and decision-ceiling rejection. Run `npm test` and see behavioral RED; do not use a name pattern that can skip the designed cases. This article-shaped contract was superseded by Task 2.
- [x] Implement runtime schemas and `loadStudy`. Reject unknown or malformed input before model calls; resolve relative paths from the manifest directory, hash referenced files, and reject source drift. Choose a documented standalone `1.0` example rather than mechanically translating all trial fields.
- [x] Run `npm test` and `npm run typecheck`; inspect `loadStudy` through a TypeScript import against both fixtures. Change the hook to invoke `npm test` when `test/*.test.ts` exists; test a normal commit path. Commit the green TypeScript slice and accounted removal of obsolete Python material. A Node-specific `.gitignore` excludes `node_modules/`, caches, local env, and run output, while tracking the lockfile and `dist/`.

### Task 2: Replace article-shaped manifest with the domain-neutral graph contract

**Files:** Create `src/domain/study/manifest.ts`, `src/domain/study/load-study.ts`; update study fixtures/tests and add `test/fixtures/chapter.json` with a matching source fixture; move cohort validation to `src/domain/readers/profile.ts`. Co-locate `Study` with `load-study.ts`; do not add a types-only study module.

**Interfaces:** Produces a versioned `Study` with metadata, source references, stimulus items, decision definitions, graph nodes, transitions, an entry node, and a maximum decision count. Nodes are `expose` (one item), `decide` (one decision), or `terminal` (authored outcome); expose nodes have one unconditional transition and decision nodes have one transition for each offered label. Keep frozen cohort validation independent and preserve source hashing.

- [x] Write RED tests for the generic graph contract, including an article-shaped flow and a book-chapter-shaped flow using the same item/decision/transition primitives. Cover unknown fields, duplicate/dangling IDs, mismatched choice edges, unreachable nodes, cycles bounded by the decision ceiling, and source drift.
- [x] Replace old article/scan-specific schemas and fixtures. Keep domain-specific examples in fixtures only; no article special cases in `loadStudy`. Run study tests and typecheck; commit.

### Task 3: Typed decision and future-blind prompt contract

**Files:** Create `src/domain/decision/contract.ts`, `src/domain/decision/validate.ts`, `src/domain/decision/prompt.ts`, `test/decision.test.ts`, `test/prompts.test.ts`. The shared contract module also owns runtime Zod schemas; do not split out an otherwise type-only file.

**Interfaces:** Consumes domain-neutral `Study` graph definitions, the current decision node, encountered item IDs, chronological choice history, and `ReaderProfile`; produces a future-blind `DecisionRequest`, `DecisionResult { choice, probabilities, attempts, provider, model, latencyMs, usage, chargeStatus, chargeUsd? }`, `DecisionProvider.decide(request, maxAttempts)`, `validateDecision`, `renderQuestion`, and a stable `promptContractHash`.

- [x] Write RED tests showing that unexposed item text never appears, history remains chronological, and study purpose never enters reader state. Cover unknown labels, missing probability entries, nonfinite or negative values, wrong identity, and absent required billing evidence with one accepted result fixture.
- [x] Run the focused Node tests; implement the smallest renderer and validator satisfying them. Hash a declared prompt-contract version plus renderer-controlled decision semantics, rather than an arbitrary source-file checksum. Add pinned ESLint/typescript-eslint flat configuration and a `lint` script; update the tracked pre-commit hook to run lint and then recursive tests. Run lint, focused tests, typecheck, and a normal commit through the hook; commit.

### Task 4: Bounded generic graph journeys

**Files:** Create `src/domain/journey/run.ts`, `src/domain/journey/trace.ts`, `test/journey.test.ts`, `test/trace.test.ts`.

**Interfaces:** Consumes Task 3's `DecisionRequest` and async `ask`; produces `JourneyResult` with ordered exposure and choice events, authored terminal outcome, completion status, and decision count. `runJourney` is provider independent. `traceStudy` later injects scripted choices through the same engine.

- [x] Write RED scenarios for sequential reading, early terminal exit, branching/scan-like entry, conditional optional-item exposure, deferred then re-offered content, and a bounded cycle. Check that every scenario terminates at its authored decision ceiling and an invalid scripted label fails before recording a valid choice.
- [x] Implement one generic graph walker with explicit decision-ceiling enforcement; avoid duplicate sync/async route engines. Keep journey event/result contracts with the runner and scripted tracing in a focused module that feeds the same async engine. Record only items actually exposed. Run focused tests and typecheck; commit. Portfolio articles and novel chapters must both use this same walker. Verified with 25 passing Node tests, ESLint, and TypeScript typecheck.

### Task 5: Hosted Jev adapter and observed attempts

**Files:** Create `src/providers/jev.ts`, `test/jev.test.ts`; update package dependencies and lockfile.

**Interfaces:** Produces `JevConfig { kind: "jev", model, keyEnv, endpoint, timeoutMs }` and `JevProvider` implementing Task 3's provider contract. On failure, return a typed error with actual attempted wire calls and `chargeStatus: "unknown"` when billing cannot be established.

- [ ] Verify the current OpenRouter Decisions API request/response, SDK retry hooks, and usage evidence in official docs or installed SDK source before selecting SDK versus direct HTTP. Record the chosen wire contract in `docs/jev-wire.md`. Do not inherit the trial's Python SDK assumptions.
- [ ] Write fake-transport RED tests for typed choice payload, full distribution, selected model, successful billed cost, token/latency evidence when supplied, retryable status and connection errors, non-retryable auth failure, hard attempt cap, and no leaked key. Implement retries in an observable wrapper if the SDK cannot expose physical attempts. Run focused tests and typecheck; commit. Routine checks use no hosted key.

### Task 6: Local Laya adapter and measured context fit

**Files:** Create `src/providers/laya.ts`, `test/laya.test.ts`, `docs/local-laya.md`.

**Interfaces:** Produces `LayaConfig { kind: "laya", baseUrl, checkpoint, contextLimit, precision?, timeoutMs }`, `checkLayaFit(request, config): Promise<FitResult>`, and `LayaProvider`. Fit is measured by a checkpoint-valid tokenizer or service method, otherwise returns explicit unsupported-input.

- [ ] Verify `/v1/systemone` request, response, checkpoint routing metadata, and available context measurement against the actual Laya version. Record observed fields and unavailable provenance in `docs/local-laya.md` before coding the adapter.
- [ ] Write fake-service RED tests for matching routing checkpoint despite generic top-level model, mismatch/missing checkpoint, malformed probabilities, unavailable service, over-limit and unmeasurable input with zero dispatch, and local charge as `not_billed` or `unknown`. Implement the adapter without provider fallback or GPU startup. Run focused tests and typecheck; commit. Keep a separate opt-in live local smoke check for later handoff.

### Task 7: Identity and concurrent budget reservations

**Files:** Create `src/infrastructure/identity.ts`, `src/infrastructure/budget-ledger.ts`, `test/identity.test.ts`, `test/budget.test.ts`.

**Interfaces:** `stimulusFingerprint(study, promptContractHash): string` includes ordered cohort and source hashes. `executionFingerprint(stimulus, providerConfig): string` includes decision-affecting settings without credentials. `BudgetLedger.reserve(maxAttempts, maxPerCallUsd)`, `settle(reservation, resultOrError)`, and `reconcile(unpricedUsd)` serialize shared limits.

- [ ] Write RED tests that provider changes preserve stimulus identity but change execution identity; cohort order, source, prompt contract, checkpoint, or precision changes have the expected effect. Concurrent controlled reservations must not oversubscribe calls or hosted spend allowance; unknown possibly billed failures stop later dispatch until reconciliation. A billed amount above its reservation records the overshoot and prevents further dispatch.
- [ ] Implement canonical JSON identity and one serialized budget ledger. Reject nonfinite or negative limits/usage; local provider needs no hosted spend cap. Run focused tests with actual overlap and typecheck; commit.

### Task 8: Durable jobs and process recovery

**Files:** Create `src/infrastructure/checkpoint-store.ts`, `src/infrastructure/process-lock.ts`, `src/application/jobs.ts`, `src/application/worker.ts`, `test/jobs.test.ts`.

**Interfaces:** `RunConfig` has manifest/cohort paths, explicit provider, output directory for runs, `maxCalls`, hosted `maxUsd` and `maxPerCallUsd`, and concurrency. `checkStudy` and `traceStudy` perform no provider call. `startRun` registers a durable run and starts a managed worker; `runStatus`, `cancelRun`, `resumeRun`, and `readCheckpoint` reconstruct state from disk. States: prepared, running, completed, partial, failed, cancelled.

- [ ] Write RED tests for check and trace without network; source rehash at start; concurrent journeys with sequential within-journey calls; cancellation in flight; stale running checkpoint after process kill; completed-journey skip; execution-fingerprint mismatch; two-process resume lock; and no credential/source-text persistence. Use a controlled child process for kill/restart evidence, not an in-memory simulation.
- [ ] Implement atomic versioned checkpoints, explicit process ownership/locking, reserved attempts before each dispatch, stable output order, and child-worker lifetime independent of an MCP request. Resume restarts an incomplete journey from its beginning, never repeats a completed one. Verify focused tests and typecheck; commit.

### Task 9: Reports and matched comparison

**Files:** Create `src/application/reports.ts`, `test/report.test.ts`.

**Interfaces:** `buildReport(checkpoint)`, `getReport(outputDir, runId)` via Task 8's checkpoint store, and `compareReports(left, right)` return JSON-safe evidence. Comparison requires equal stimulus fingerprint and aligns only common completed `(readerId, journeyId)` keys.

- [ ] Write RED tests for completed versus intended denominators, terminal outcome and archetype breakdowns, generic per-item exposure, ordered events, attempts, latency, tokens, billed/unknown charge, unknown Laya revision, failed/unsupported journey counts, and mismatch on cohort order or prompt contract.
- [ ] Implement summaries from completed records while keeping exclusions visible. Label Jev/Laya comparison as agreement or divergence, never accuracy, calibration, readership, or publication score. Run focused tests and typecheck; inspect one example JSON report; commit.

### Task 10: CLI and MCP over the shared job core

**Files:** Create `src/entrypoints/cli.ts`, `src/entrypoints/mcp.ts`, `src/entrypoints/worker.ts`, `test/cli.test.ts`, `test/mcp.test.ts`; update `package.json` and lockfile for the official MCP TypeScript SDK.

**Interfaces:** CLI `check`, `trace`, `start`, `status`, `cancel`, `resume`, `report`, `compare`; MCP `poll_check`, `poll_trace`, `poll_start`, `poll_status`, `poll_cancel`, `poll_resume`, `poll_report`, `poll_compare`. Both call Task 8/8 APIs and produce the same evidence.

- [ ] Write RED tests for command/tool availability, provider-specific caps, manifest-only inputs, keyless check/trace, restart-safe status, CLI/MCP report parity, and safe error payloads. `poll_check` must reject a malformed manifest without starting a run.
- [ ] Implement thin entry points around the job and report APIs. Run focused tests, typecheck, and `npm run build`; invoke `node dist/cli.js --help`, then connect an MCP test client to `node dist/mcp.js`, list tools and call `poll_check` on a fixture. Commit after the tracked hook passes.

### Task 11: Ambient plugin package and installation proof

**Files:** Create `test/package.test.ts`, `plugin.json`, `mcp.json`, `skills/simulated-reader-polling/SKILL.md`, focused `skills/simulated-reader-polling/references/`, `README.md`, and `docs/install-codex.md`; modify `package.json` and tracked `dist/` as needed for a self-contained distribution.

**Interfaces:** Consumes Task 10's built Node CLI and MCP server. Produces one installable plugin root whose MCP command runs `node` with plugin-relative `dist/mcp.js`, plus user-level installation instructions. No duplicate editable plugin source.

- [ ] Verify current portable Codex plugin and MCP schemas from official docs. Write a RED package test that copies the plugin to an unrelated temporary directory, excludes its checkout and dev dependencies, launches MCP, lists tools, and calls `poll_check`; also check skill references and documented commands against the shipped artifact.
- [ ] Author the root manifests and skill. Keep cohort audit, rendered-stimulus inspection, paid-run authorization, and cautious interpretation in the skill. Use only references still applicable to the standalone `1.0` contract. Keep `dist/` tracked; document `npm ci && npm run build`, installed Node 24 requirement, plugin update/build procedure, Jev key, and separately configured local Laya endpoint. Do not mutate the global Codex installation in routine tests.
- [ ] Run `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and package-copy MCP smoke. Inspect `git diff --check` and shipping files for stale Python runtime, Portfolio, extractor, checkout, or credential dependencies. If user-level installation can safely be exercised, verify fresh-chat discovery and MCP startup; otherwise report that evidence limit. Use `/verification-before-completion`, `/requesting-code-review`, and `/completing-planning-artifacts` at their proper stage. Commit through the tracked hook. Publish only under execution-stage authorization and repository policy.

## Acceptance evidence

- Focused Node tests and typecheck pass with fake Jev/Laya transports; no hosted call is required.
- `check` and scripted `trace` work without a key or network. A changed source is rejected at `start`, even after a previous successful `check`.
- A bounded local or fake-provider run yields durable checkpoint, report, identity, usage evidence, and restart-safe status/resume/cancel. Live GPU smoke is opt-in and records observed routing identity.
- A copied plugin launches from an unrelated directory using shipped JavaScript and runtime dependencies, without Portfolio, source checkout, Python, TypeScript compiler, or development dependencies. Fresh Codex discovery is verified or explicitly marked unverified.
- No Portfolio source, marketplace source, article content, or currently installed skill is changed by this project.
