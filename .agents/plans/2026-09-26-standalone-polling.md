# Standalone System One Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one ambient Codex plugin whose TypeScript harness runs bounded, reproducible simulated-reader studies against explicitly selected Jev or local Laya.

**Architecture:** A standalone versioned manifest and frozen cohort feed one finite journey engine and one provider-neutral decision contract. The CLI and bundled MCP server call the same durable job controller; provider adapters handle Jev and Laya wire formats. Build runnable JavaScript into the plugin package, with no Python runtime in the installed plugin.

**Tech Stack:** Node.js 24 LTS, TypeScript strict mode, npm with committed `package-lock.json`, Zod for runtime validation, Node's test runner with `tsx` for TypeScript tests, `esbuild` for bundled Node entry points, official MCP TypeScript SDK, and OpenRouter TypeScript SDK only if its Decisions API attempt and usage behavior can be verified. Pin exact direct dependency versions when installing them. No Python core.

**Spec:** `.agents/specs/2026-09-26-system-one-polling-design.md`

**Execution Strategy:** `executing-plans`, as previously selected by the user. Contracts and jobs are tightly coupled; one inline owner can keep the types, budget semantics, and package launch aligned. A fresh whole-branch review follows implementation.

## Global constraints and transition

- Work in `Z:\_agent-worktrees\system-one-polling\port-simulated-reader-polling`, the existing linked worktree. Inspect branch, status, and current remote before any further source edits. The user explicitly chose this worktree, so do not switch its in-flight branch to main. Do not edit Portfolio or installed plugins.
- Portfolio main commit `9d0864d0f4d3da4e451168cfd14ec080636ad25c` is a trial to learn from, not a runtime dependency or exact-route oracle. The standalone `1.0` manifest is the sole input; old `0.0.5` manifests need explicit conversion and are not silently accepted.
- Keep article and scan entry, future-blind prompts, frozen cohorts, optional-aside visibility and offer origin, core outcome before optional satisfaction, finite exits, ordered exposure history, and honest denominators. Route names and branches may be redesigned within those invariants.
- Jev requires a call and local spend cap. Laya requires a call cap and a verified fit mechanism. Reserve a conservative declared `maxPerCallUsd` for each Jev attempt before dispatch; reject a run with no defensible allowance. A provider bill above the allowance may overshoot the local cap: record it, stop new calls, and never present the local cap as a provider-side hard limit. Never change provider mid-run, start local weights, trim inputs, invent a cost or model revision, or issue a paid call in routine tests.
- Require explicit output directory for runs. Keep stimulus and execution fingerprints distinct. No credentials or source text in checkpoints or reports. An interrupted run requires explicit resume; completed journeys are not repeated.
- The owner can maintain TypeScript directly. Prefer focused modules, explicit public types, runtime validation at external boundaries, and readable domain names over generated abstraction layers.
- `npm test` means `node --import tsx --test test/*.test.ts`; `npm run typecheck` means `tsc --noEmit`; `npm run build` bundles `src/cli.ts`, `src/mcp.ts`, and `src/worker.ts` for `node24` into `dist/`. Keep runtime imports bundle-safe. `dist/` is tracked so the plugin installed from this repo runs without a build at install time; regenerate and stage it with source changes. The lockfile is tracked.
- The worktree currently has committed Python prototype files and hook plus uncommitted `.gitignore` edits. Two unfinished Python RED test drafts are preserved at `Z:\_agent-scratch\system-one-polling\python-red-drafts-2026-09-26`; inspect their behavioral cases during Tasks 1 and 2. Replace the prototype in the first committed TypeScript slice and remove obsolete Python-only files only after equivalent standalone manifest/cohort behavior is green. Do not delete or overwrite unrelated user work.
- The repo has no `.agents/runbooks/planning.md` at plan revision time. This plan and the spec are the local planning guides; if a runbook appears during execution, read it then. The tracked pre-commit hook must run the current test command once tests exist, including from a staged commit, without bypassing the hook.

## File map and interfaces

All paths below are relative to this linked worktree. Private helpers may change, but public seams must stay coherent.

| Path | Ownership and public seam |
| --- | --- |
| `src/study.ts`, `src/profiles.ts`, `src/schema.ts` | `loadStudy(manifestPath, cohortPath): Promise<Study>`; `Study` contains validated standalone `1.0` manifest, ordered frozen profiles, resolved source hashes and directory. |
| `src/decision.ts`, `src/prompts.ts` | `DecisionRequest`, `DecisionResult`, `DecisionProvider.decide(request, maxAttempts)`, `validateDecision`; `renderQuestion(study, profile, stage, visibleText, criteria, history)` and `promptContractHash()`. |
| `src/journey.ts` | `runJourney(study, profile, condition, ask): Promise<JourneyResult>`; one finite article/scan graph and chronological exposure/choice events. |
| `src/providers/jev.ts`, `src/providers/laya.ts` | `JevConfig`, `LayaConfig`, explicit provider implementations; `checkLayaFit` returns measured fit or unsupported-input. |
| `src/identity.ts`, `src/budget.ts` | `stimulusFingerprint`, `executionFingerprint`, and serialized attempt/spend reservations shared across concurrent journeys. |
| `src/jobs.ts`, `src/checkpoint.ts` | `checkStudy`, `traceStudy`, `startRun`, `runStatus`, `cancelRun`, `resumeRun`, `readCheckpoint`; checkpoint version and durable worker ownership. Task 8 adds `getReport`. |
| `src/report.ts` | `buildReport`, `compareReports`; comparisons only for equal stimulus fingerprint and matched completed journey keys. |
| `src/cli.ts`, `src/mcp.ts` | Thin CLI and MCP entry points over jobs and reports, with no second polling engine. |
| `plugin.json`, `mcp.json`, `skills/simulated-reader-polling/`, `dist/` | Portable plugin metadata, skill, and runnable built JavaScript. The distribution must start when copied away from the source checkout. |

Use `test/*.test.ts` and `test/fixtures/` for focused behavior and fake transports. Keep generated run evidence in temporary test directories. No test should merely mirror an implementation branch or detect arbitrary source changes.

The first `1.0` manifest contract uses `version`, `entry`, `source: { path, sha256 }`, `title`, `promise`, `beats: [{ id, text }]`, `scanCards: [{ id, title, beatId }]` for scan entry, `asides: [{ id, title, text, offerAfterBeatId }]`, `conditions: [{ id, beatIds, asideIds }]`, and `maxDecisions`. `source.path` is relative to the manifest directory unless explicitly absolute. `title`, `promise`, beat text, card titles, and opened aside text are reader-visible; source path and hashes are evidence only. A frozen cohort input uses `version`, ordered `readers: [{ id, archetypeId, profileText }]`, and `admission: { rationale, frozenAt }`. Runtime schemas reject unknown keys and dangling references. The exact JSON fixture in Task 1 is the canonical example for authors.

The route reducer offers `continue`, `skim_next`, `stop_satisfied`, and `leave` after each visible beat. At the last beat, `continue` exits as `finished_attentive` unless any earlier `skim_next` occurred, when it exits as `finished_skimming`. A scan journey first chooses one visible card ID and begins at that card's `beatId` within the selected condition. An aside offered after an authored beat accepts `open` or `defer`; the exit offer accepts `open` or `decline`, with `origin: unseen | deferred`. Only `open` reveals the body. The `maxDecisions` ceiling and strictly forward beat cursor prevent cycles. Exposure events persist IDs and order, not prompt or source text.

## Review focus

1. A source changes between `check` and `start`: start rehashes and refuses dispatch (Tasks 1 and 7).
2. The local response advertises a generic model but routes to another checkpoint: refuse its choice (Task 5).
3. Cancel arrives with a request in flight: record its outcome and usage, dispatch nothing further (Task 7).
4. Worker dies while checkpoint says running: report partial and resume only incomplete journeys (Task 7).
5. Reports have the same manifest but a different cohort order or prompt contract: refuse comparison (Task 8).

---

### Task 1: Replace the prototype with the standalone study contract

**Files:** Create `package.json`, `package-lock.json`, `tsconfig.json`, `src/schema.ts`, `src/study.ts`, `src/profiles.ts`, `test/study.test.ts`, `test/fixtures/{article,scan,cohort,source}*`; modify `.gitignore`, `.githooks/pre-commit`; remove Python-only `pyproject.toml`, `src/system_one_polling/`, old Python tests and fixtures after accounting for uncommitted files. Retain a useful archetype asset under `skills/simulated-reader-polling/assets/` in standalone format.

**Interfaces:** Produces `Study`, `ReaderProfile`, `loadStudy(manifestPath: string, cohortPath: string): Promise<Study>` for every later task. The manifest declares `version: "1.0"`, entry (`article` or `scan`), ordered beats, visible scan cards, optional asides, conditions, source references with SHA-256, and an explicit decision ceiling. A cohort contains ordered profiles plus an admission record.

- [x] Inspect `git status`, the modified ignore file, and the preserved Python RED drafts in the named scratch directory. Carry their useful behavioral assertions into Tasks 1 and 2. Bootstrap the exact npm scripts above with pinned `typescript`, `tsx`, `esbuild`, `zod`, and `@types/node` so a RED test can run.
- [x] Write `test/study.test.ts` for an article and scan manifest, frozen ordered cohort, relative and explicitly absolute source references, changed source hash, invalid route/aside references, old `0.0.5` rejection, and decision-ceiling rejection. Run `npm test` and see behavioral RED; do not use a name pattern that can skip the designed cases.
- [x] Implement runtime schemas and `loadStudy`. Reject unknown or malformed input before model calls; resolve relative paths from the manifest directory, hash referenced files, and reject source drift. Choose a documented standalone `1.0` example rather than mechanically translating all trial fields.
- [x] Run `npm test` and `npm run typecheck`; inspect `loadStudy` through a TypeScript import against both fixtures. Change the hook to invoke `npm test` when `test/*.test.ts` exists; test a normal commit path. Commit the green TypeScript slice and accounted removal of obsolete Python material. A Node-specific `.gitignore` excludes `node_modules/`, caches, local env, and run output, while tracking the lockfile and `dist/`.

### Task 2: Typed decision and future-blind prompt contract

**Files:** Create `src/decision.ts`, `src/prompts.ts`, `test/decision.test.ts`, `test/prompts.test.ts`.

**Interfaces:** Consumes `Study`/`ReaderProfile`; produces `DecisionRequest { state, question, labels }`, `DecisionResult { choice, probabilities, attempts, provider, model, latencyMs, usage, chargeStatus, chargeUsd? }`, `DecisionProvider.decide(request, maxAttempts)`, `validateDecision`, `renderQuestion`, and a stable `promptContractHash`.

- [ ] Write RED tests showing that hidden future beats and unopened aside bodies never appear, history remains chronological, and charter/hypothesis never enter reader state. Cover unknown labels, missing probability entries, nonfinite or negative values, wrong identity, and absent required billing evidence with one accepted result fixture.
- [ ] Run the focused Node tests; implement the smallest renderer and validator satisfying them. Hash a declared prompt-contract version plus renderer-controlled decision semantics, rather than an arbitrary source-file checksum. Run focused tests and typecheck; commit.

### Task 3: Finite article and scan journeys

**Files:** Create `src/journey.ts`, `test/journey.test.ts`, `test/trace.test.ts`.

**Interfaces:** Consumes Task 2's `DecisionRequest` and async `ask`; produces `JourneyResult` with ordered exposure and choice events, core outcome, optional-read outcome, completion status, and decision count. `runJourney` is provider independent. `traceStudy` later injects scripted choices through the same engine.

- [ ] Write RED scenarios for an attentive completion, skim, satisfied early stop, lost-interest exit, scan-card entry, aside opened immediately, deferred then reopened, and never-seen aside offered at the end. Check that every scenario terminates within its authored decision ceiling and an invalid scripted label fails before recording a valid choice.
- [ ] Implement a single transition table or explicit reducer with finite exits; avoid duplicate sync/async route engines. Record core outcome before optional satisfaction. Run focused tests and typecheck; commit. The trial route fixtures may inform cases, but no exact graph parity assertion is required.

### Task 4: Hosted Jev adapter and observed attempts

**Files:** Create `src/providers/jev.ts`, `test/jev.test.ts`; update package dependencies and lockfile.

**Interfaces:** Produces `JevConfig { kind: "jev", model, keyEnv, endpoint, timeoutMs }` and `JevProvider` implementing Task 2's provider contract. On failure, return a typed error with actual attempted wire calls and `chargeStatus: "unknown"` when billing cannot be established.

- [ ] Verify the current OpenRouter Decisions API request/response, SDK retry hooks, and usage evidence in official docs or installed SDK source before selecting SDK versus direct HTTP. Record the chosen wire contract in `docs/jev-wire.md`. Do not inherit the trial's Python SDK assumptions.
- [ ] Write fake-transport RED tests for typed choice payload, full distribution, selected model, successful billed cost, token/latency evidence when supplied, retryable status and connection errors, non-retryable auth failure, hard attempt cap, and no leaked key. Implement retries in an observable wrapper if the SDK cannot expose physical attempts. Run focused tests and typecheck; commit. Routine checks use no hosted key.

### Task 5: Local Laya adapter and measured context fit

**Files:** Create `src/providers/laya.ts`, `test/laya.test.ts`, `docs/local-laya.md`.

**Interfaces:** Produces `LayaConfig { kind: "laya", baseUrl, checkpoint, contextLimit, precision?, timeoutMs }`, `checkLayaFit(request, config): Promise<FitResult>`, and `LayaProvider`. Fit is measured by a checkpoint-valid tokenizer or service method, otherwise returns explicit unsupported-input.

- [ ] Verify `/v1/systemone` request, response, checkpoint routing metadata, and available context measurement against the actual Laya version. Record observed fields and unavailable provenance in `docs/local-laya.md` before coding the adapter.
- [ ] Write fake-service RED tests for matching routing checkpoint despite generic top-level model, mismatch/missing checkpoint, malformed probabilities, unavailable service, over-limit and unmeasurable input with zero dispatch, and local charge as `not_billed` or `unknown`. Implement the adapter without provider fallback or GPU startup. Run focused tests and typecheck; commit. Keep a separate opt-in live local smoke check for later handoff.

### Task 6: Identity and concurrent budget reservations

**Files:** Create `src/identity.ts`, `src/budget.ts`, `test/identity.test.ts`, `test/budget.test.ts`.

**Interfaces:** `stimulusFingerprint(study, promptContractHash): string` includes ordered cohort and source hashes. `executionFingerprint(stimulus, providerConfig): string` includes decision-affecting settings without credentials. `BudgetLedger.reserve(maxAttempts, maxPerCallUsd)`, `settle(reservation, resultOrError)`, and `reconcile(unpricedUsd)` serialize shared limits.

- [ ] Write RED tests that provider changes preserve stimulus identity but change execution identity; cohort order, source, prompt contract, checkpoint, or precision changes have the expected effect. Concurrent controlled reservations must not oversubscribe calls or hosted spend allowance; unknown possibly billed failures stop later dispatch until reconciliation. A billed amount above its reservation records the overshoot and prevents further dispatch.
- [ ] Implement canonical JSON identity and one serialized budget ledger. Reject nonfinite or negative limits/usage; local provider needs no hosted spend cap. Run focused tests with actual overlap and typecheck; commit.

### Task 7: Durable jobs and process recovery

**Files:** Create `src/checkpoint.ts`, `src/jobs.ts`, `src/worker.ts`, `test/jobs.test.ts`.

**Interfaces:** `RunConfig` has manifest/cohort paths, explicit provider, output directory for runs, `maxCalls`, hosted `maxUsd` and `maxPerCallUsd`, and concurrency. `checkStudy` and `traceStudy` perform no provider call. `startRun` registers a durable run and starts a managed worker; `runStatus`, `cancelRun`, `resumeRun`, and `readCheckpoint` reconstruct state from disk. States: prepared, running, completed, partial, failed, cancelled.

- [ ] Write RED tests for check and trace without network; source rehash at start; concurrent journeys with sequential within-journey calls; cancellation in flight; stale running checkpoint after process kill; completed-journey skip; execution-fingerprint mismatch; two-process resume lock; and no credential/source-text persistence. Use a controlled child process for kill/restart evidence, not an in-memory simulation.
- [ ] Implement atomic versioned checkpoints, explicit process ownership/locking, reserved attempts before each dispatch, stable output order, and child-worker lifetime independent of an MCP request. Resume restarts an incomplete journey from its beginning, never repeats a completed one. Verify focused tests and typecheck; commit.

### Task 8: Reports and matched comparison

**Files:** Create `src/report.ts`, `test/report.test.ts`.

**Interfaces:** `buildReport(checkpoint)`, `getReport(outputDir, runId)` via Task 7's `readCheckpoint`, and `compareReports(left, right)` return JSON-safe evidence. Comparison requires equal stimulus fingerprint and aligns only common completed `(readerId, conditionId)` keys.

- [ ] Write RED tests for completed versus intended denominators, condition/archetype/optional/scan breakdowns, ordered exposure events, attempts, latency, tokens, billed/unknown charge, unknown Laya revision, failed/unsupported journey counts, and mismatch on cohort order or prompt contract.
- [ ] Implement summaries from completed records while keeping exclusions visible. Label Jev/Laya comparison as agreement or divergence, never accuracy, calibration, readership, or publication score. Run focused tests and typecheck; inspect one example JSON report; commit.

### Task 9: CLI and MCP over the shared job core

**Files:** Create `src/cli.ts`, `src/mcp.ts`, `test/cli.test.ts`, `test/mcp.test.ts`; update `package.json` and lockfile for the official MCP TypeScript SDK.

**Interfaces:** CLI `check`, `trace`, `start`, `status`, `cancel`, `resume`, `report`, `compare`; MCP `poll_check`, `poll_trace`, `poll_start`, `poll_status`, `poll_cancel`, `poll_resume`, `poll_report`, `poll_compare`. Both call Task 7/8 APIs and produce the same evidence.

- [ ] Write RED tests for command/tool availability, provider-specific caps, manifest-only inputs, keyless check/trace, restart-safe status, CLI/MCP report parity, and safe error payloads. `poll_check` must reject a malformed manifest without starting a run.
- [ ] Implement thin entry points around the job and report APIs. Run focused tests, typecheck, and `npm run build`; invoke `node dist/cli.js --help`, then connect an MCP test client to `node dist/mcp.js`, list tools and call `poll_check` on a fixture. Commit after the tracked hook passes.

### Task 10: Ambient plugin package and installation proof

**Files:** Create `test/package.test.ts`, `plugin.json`, `mcp.json`, `skills/simulated-reader-polling/SKILL.md`, focused `skills/simulated-reader-polling/references/`, `README.md`, and `docs/install-codex.md`; modify `package.json` and tracked `dist/` as needed for a self-contained distribution.

**Interfaces:** Consumes Task 9's built Node CLI and MCP server. Produces one installable plugin root whose MCP command runs `node` with plugin-relative `dist/mcp.js`, plus user-level installation instructions. No duplicate editable plugin source.

- [ ] Verify current portable Codex plugin and MCP schemas from official docs. Write a RED package test that copies the plugin to an unrelated temporary directory, excludes its checkout and dev dependencies, launches MCP, lists tools, and calls `poll_check`; also check skill references and documented commands against the shipped artifact.
- [ ] Author the root manifests and skill. Keep cohort audit, rendered-stimulus inspection, paid-run authorization, and cautious interpretation in the skill. Use only references still applicable to the standalone `1.0` contract. Keep `dist/` tracked; document `npm ci && npm run build`, installed Node 24 requirement, plugin update/build procedure, Jev key, and separately configured local Laya endpoint. Do not mutate the global Codex installation in routine tests.
- [ ] Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and package-copy MCP smoke. Inspect `git diff --check` and shipping files for stale Python runtime, Portfolio, extractor, checkout, or credential dependencies. If user-level installation can safely be exercised, verify fresh-chat discovery and MCP startup; otherwise report that evidence limit. Use `/verification-before-completion`, `/requesting-code-review`, and `/completing-planning-artifacts` at their proper stage. Commit through the tracked hook. Publish only under execution-stage authorization and repository policy.

## Acceptance evidence

- Focused Node tests and typecheck pass with fake Jev/Laya transports; no hosted call is required.
- `check` and scripted `trace` work without a key or network. A changed source is rejected at `start`, even after a previous successful `check`.
- A bounded local or fake-provider run yields durable checkpoint, report, identity, usage evidence, and restart-safe status/resume/cancel. Live GPU smoke is opt-in and records observed routing identity.
- A copied plugin launches from an unrelated directory using shipped JavaScript and runtime dependencies, without Portfolio, source checkout, Python, TypeScript compiler, or development dependencies. Fresh Codex discovery is verified or explicitly marked unverified.
- No Portfolio source, marketplace source, article content, or currently installed skill is changed by this project.
