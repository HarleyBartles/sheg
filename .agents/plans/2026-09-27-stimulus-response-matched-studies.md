# Stimulus-response matched studies implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` for this tightly coupled plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unreleased reader-only study contract with typed stimulus-task-response studies and matched A/B arms, then ship one complete comprehension-choice slice through the existing plugin.

**Architecture:** Each study contains one or more arms with bounded text, typed choice tasks, and either a simple ordered presentation or an optional bounded journey graph. A frozen respondent cohort is shared across arms. The job runner records one result per respondent-task-presentation cell, treating provider retries only as attempts. Reports compare arm distributions and matched profile responses when stable comparison keys and option IDs align.

**Tech Stack:** Node.js 24, TypeScript, Zod 4, JSON Schema, Node test runner, ESLint, esbuild, MCP TypeScript SDK.

**Spec:** `.agents/specs/2026-09-27-stimulus-response-matched-studies.md`

**Execution Strategy:** `executing-plans` - the contract, worker, checkpoint, report, and tool changes are sequential and share state invariants; native inline execution is explicitly requested.

## Global Constraints

- Node.js requirement remains `>=24 <25`.
- The first response contract is typed choice only; do not advertise free text, span, ranking, or pairwise outputs.
- A frozen respondent profile is the unit counted as a respondent. A respondent-task-presentation-arm cell is the response unit. A retry is an attempt on that cell.
- Matched arms use the same ordered frozen profile IDs. Full decision-affecting provider settings must match for a comparison, including hosted model or local checkpoint and precision.
- Provider prompts exclude study purpose, answer keys, unexposed text, and other arms.
- An answer key is optional, identifies exactly one option, and is never sent to the provider. Without one, reports make no correctness claim.
- Comparison joins tasks by explicit comparison key and options by stable option ID. It must expose incomplete and unmatched results.
- Do not claim synthetic results represent humans, statistical significance, real-world lift, or model calibration.
- Preserve explicit provider selection, no silent fallback, spend/call limits, context-fit checks, durable recovery, CLI/MCP shared behavior, and self-contained plugin packaging.
- Change unreleased study manifest `1.0` to `2.0`, reader cohort `2.0` to respondent cohort `3.0`, checkpoint format `1` to `2`, and report format `1` to `2`. Add no compatibility shims for PR #1's unmerged formats.
- Preserve the existing same-branch Draft PR workflow. Do not merge or mark the PR ready.

## Review Focus

- Answer-key leakage or scoring mistakes: provider prompt tests prove the key never enters the request; report tests cover correct, incorrect, unscored, and `unanswerable`-is-correct cases.
- Pseudoreplication: checkpoint and report tests prove retries do not add respondent or response-cell counts and one profile is matched across arms.
- False paired equivalence: comparison tests cover different comparison keys, shared option IDs, arm-only options, and incomplete task presentations.
- Graph recovery: journey/checkpoint tests cover early exit, repeated task presentations after changed history, resume without replaying completed cells, and unfinished arm accounting.
- Distribution drift: build/package tests prove generated schemas and `dist/` contain current study/respondent contracts, preserve the shipped reader-archetype assets, and omit stale reader cohort/profile formats.

---

### Task 1: Replace reader-only study and cohort contracts

**Files:**
- Modify: `src/domain/study/manifest.ts`
- Create: `src/domain/respondents/profile.ts` by moving and generalizing profile/cohort contracts from `src/domain/readers/profile.ts`
- Create: `src/domain/readers/archetype.ts` to own the reusable reader-archetype contracts moved out of the profile module
- Remove: `src/domain/readers/profile.ts` after imports migrate
- Modify: `src/domain/study/load-study.ts`
- Modify: `src/domain/readers/reader-archetypes.json` only if the profile vocabulary migration requires it; preserve substantive archetype content
- Modify: `test/fixtures/article.json`, `test/fixtures/chapter.json`, `test/fixtures/cohort.json`
- Modify: `test/study.test.ts`, `test/readers.test.ts`
- Modify generated: `skills/simulated-reader-polling/assets/*.schema.json`

**Interfaces:** Replace `StudyManifest.items/decisions` with version `2.0` study metadata plus ordered `arms`. Each arm owns source references, text items, choice tasks, and a `presentation` discriminated union. `sequence` implicitly exposes ordered items then asks ordered tasks; `graph` owns graph nodes, transitions, entry node, and decision ceiling. A choice task has instructions, options keyed by stable IDs with descriptions, optional `comparisonKey`, and optional single `answerKeyOptionId`. Reusing a comparison key maps the same measured question across arms; reusing an option ID asserts semantic equivalence. Replace frozen cohort `2.0` (`readers`) with respondent cohort `3.0` (`respondents`), preserving ordered distinct profiles and optional reusable reader-archetype lineage. Export inferred types from the owning Zod modules.

- [ ] Add RED contract tests for graph-free one-arm comprehension, two arms with the same external frozen respondent cohort, required unique option IDs, comparison keys, optional answer-key membership, explicit `unanswerable`, bounded text, unique IDs within their owner, and malformed/unreachable graph references.
- [ ] Run `npm test -- --test-name-pattern="study|cohort|respondent"`; confirm failures are due to missing v2 fields/validation.
- [ ] Implement strict Zod contracts and source validation for per-arm items. Preserve source hashing and graph termination invariants. Do not accept legacy v1 manifests or cohort v2.
- [ ] Migrate fixtures to the new contract; include an answerable and an unanswerable fixture, plus a matched pair whose response option IDs preserve semantic meaning across variants.
- [ ] Regenerate skill JSON Schema assets with `npm run contracts:build`; verify assets are named for respondent cohort/profile, retain reader-archetype schemas for the shipped reader family, and remove stale unreleased contract copies.
- [ ] Run focused tests, `npm run typecheck`, and `npm run lint`.

### Task 2: Render typed respondent tasks and execute arm journeys

**Files:**
- Modify or replace: `src/domain/decision/contract.ts`, `src/domain/decision/prompt.ts`, `src/domain/decision/validate.ts`
- Modify or replace: `src/domain/journey/run.ts`, `src/domain/journey/trace.ts`
- Modify: `src/providers/jev.ts`, `src/providers/laya.ts`
- Modify: `test/decision.test.ts`, `test/prompts.test.ts`, `test/journey.test.ts`, `test/trace.test.ts`, `test/jev.test.ts`, `test/laya.test.ts`

**Interfaces:** `DecisionRequest` carries respondent-visible profile, encountered arm items, prior responses, and one current typed-choice task. `DecisionResult` returns one allowed option ID plus a complete finite probability distribution and existing provider evidence. Journey execution is parameterized by `armId` and respondent; each task presentation yields one response record with an occurrence key and rendered request fingerprint. Reaching the same graph task later after exposure or history changes is a new presentation; transport retries replay the same request and cell.

- [ ] Add RED tests proving the prompt excludes purpose, answer key, future items, and all other arm content; includes the exact option IDs/descriptions; and only includes the current arm's exposed text and response history.
- [ ] Add RED journey tests for graph-free sequence presentation, optional `unanswerable`, early exit in graph mode, interleaved text/tasks, and revisiting the same task after new exposure/history as a distinct presentation.
- [ ] Add provider RED tests showing Jev and Laya encode the same typed-choice contract, reject unknown IDs or malformed distributions, and count physical retries on one response cell.
- [ ] Implement shared rendering/validation and update both adapters without fallback or unsupported response types. Keep answer-key scoring outside provider code.
- [ ] Run focused provider, prompt, and journey tests plus typecheck.

### Task 3: Model multi-arm runs, identity, budgets, and recovery

**Files:**
- Modify: `src/infrastructure/identity.ts`, `src/infrastructure/budget-ledger.ts`, `src/infrastructure/checkpoint-store.ts`, `src/infrastructure/process-lock.ts`
- Modify: `src/application/jobs.ts`, `src/application/worker.ts`
- Modify: `test/identity.test.ts`, `test/budget.test.ts`, `test/jobs.test.ts`

**Interfaces:** Check/run accepts one study path and one frozen respondent cohort shared by all arms. Checkpoint format stores arm fingerprints and journeys indexed by arm and respondent. Cell identity includes respondent ID, arm ID, task presentation occurrence, and rendered request fingerprint. Study identity includes all arms and cohort; execution identity additionally includes full decision-affecting provider settings. Run worker processes each required respondent-arm journey once, with sequential decisions inside a journey and bounded concurrency across journeys. Repeated runs are not pooled into a larger respondent denominator.

- [ ] Add RED identity tests that cohort order/profile changes, arm content, task options, key, or prompt-contract version alter study identity; provider/model changes alter execution identity but not study identity; secrets and output paths never enter fingerprints.
- [ ] Add RED job tests for exactly one journey per distinct profile per arm; same profile IDs/order across arms; incomplete cells and retries do not inflate counts; early exits leave later tasks unobserved; start rehashes all arm sources.
- [ ] Add RED recovery tests for cancellation in flight, stale process ownership, resume skipping completed cells/arm journeys, and rejecting changed study/cohort/provider on resume.
- [ ] Implement versioned checkpoints, shared budget reservations, arm-level execution, occurrence-aware response persistence, cancellation and resume. Preserve atomic writes and no credential/source text in checkpoints.
- [ ] Run focused budget, identity, and durable-job tests plus typecheck.

### Task 4: Produce response reports and matched A/B comparisons

**Files:**
- Modify: `src/application/reports.ts`
- Modify: `test/report.test.ts`

**Interfaces:** `buildReport` emits arm cohort/started/completed/excluded counts and per-task-presentation reached/completed/reached-without-response/not-reached counts, option counts/proportions, optional answer-key scoring, retry/provider evidence, unique respondent counts, and detailed response cells. `compareArms(report, leftArmId, rightArmId)` compares arms from the same run, matches completed cells by respondent plus comparison key and task-presentation occurrence order, computes stable-option transitions, and retains arm-specific/unpaired choices and unmatched denominators. Provider/model identity is inherited from the single run and cannot vary by arm. Cross-run comparison is unsupported.

- [ ] Add RED tests proving cohort, started, completed, excluded, task-reached, task-completed, task-incomplete, not-reached, response-cell, attempt, and retry counts remain distinct; retries never add samples and early exits are not missing task answers.
- [ ] Add RED tests for answer-key correct/incorrect/unscored outputs and an unanswerable correct answer; without a key, no accuracy field or correctness language is emitted.
- [ ] Add RED comparison tests for shared comparison keys and option IDs, arm-only options, repeated task-presentation pairing, task incompletion, early exit, profile-level choice changes, unknown arm IDs, and rejection of cross-run comparisons.
- [ ] Implement arm summaries and descriptive matched transitions only. Include changed arm/source/task fingerprints and never emit significance or lift claims.
- [ ] Run report tests and inspect a generated single-arm and A/B JSON report.

### Task 5: Update CLI and MCP operations for study arms

**Files:**
- Modify: `src/entrypoints/cli.ts`, `src/entrypoints/mcp.ts`, `src/entrypoints/worker.ts`
- Modify: `test/cli.test.ts`, `test/mcp.test.ts`

**Interfaces:** Preserve shared `check`, scripted `trace`, `start`, `status`, `cancel`, `resume`, `report`, and `compare` workflows. Check/trace operate over all arms without inference; start dispatches each cohort profile across each arm under aggregate call/spend caps; `compare` takes one run ID and two arm IDs, then calls Task 4's `compareArms`. MCP schemas describe respondent/task/arm terminology. No tool compares or pools separate runs.

- [ ] Add RED CLI/MCP tests for single-arm check/trace, multi-arm check/trace, shared profile cohorts, answer-key omission in traces, multi-arm start/status/report, same-run arm selection in compare, rejection of unknown arms/cross-run inputs, and consistent safe error payloads.
- [ ] Update entry points as thin wrappers over the revised job/report core; keep output directory, hosted caps, and authorization boundary behavior.
- [ ] Run CLI/MCP tests, typecheck, and lint.

### Task 6: Reframe plugin guidance and documentation

**Files:**
- Modify: `README.md`, `AGENTS.md`, `plugin.json`, `package.json`, `docs/README.md`, `docs/reference/study-manifest.md`, `docs/reference/data-contracts.md`, `docs/providers/jev.md`, `docs/providers/laya.md`
- Rename: `skills/simulated-reader-polling/` to `skills/stimulus-response-polling/`, updating its `SKILL.md` and workflow references
- Modify: `docs/decisions/0003-use-domain-neutral-polling-primitives.md`, `docs/decisions/0007-guide-archetypes-and-freeze-reader-cohorts.md`; add a superseding ADR for stimulus-task-response and matched-arm semantics

**Interfaces:** The skill routes users by task: build stimulus and respondent cohort; author a typed-choice task; define one or more arms; validate/trace; run; report/compare. It teaches answer-key privacy, distinct-profile interpretation, response-cell versus retry denominators, matched option IDs, and descriptive-only results. Reader journeys and reader archetypes remain available as a use case.

- [ ] Add documentation acceptance checks or focused assertions for required skill routing terms, v2 schema links, and absence of old input filenames/format references.
- [ ] Rewrite user-facing language to make respondent stimulus-response the product center, without suggesting one repeated profile call increases sample size.
- [ ] Document one worked comprehension example and a matched stimulus A/B example; label the same-cohort comparisons descriptive and provider-conditional.
- [ ] Supersede conflicting ADRs rather than rewriting accepted history; ensure every ADR status and supersession link is accurate.
- [ ] Run docs/link checks and relevant skill/package tests.

### Task 7: Regenerate, package, and prove the release candidate

**Files:**
- Modify: `scripts/generate-contracts.ts`, `scripts/build.ts`, `package.json` only as required
- Regenerate: `skills/stimulus-response-polling/assets/`, `dist/`
- Modify: `test/build.test.ts`, `test/package.test.ts`

**Interfaces:** Clean build generates only v2 respondent/study contracts, bundled archetype data, and runnable CLI/MCP assets. Package-copy MCP smoke operates outside the checkout and supports v2 check/trace without credentials or network.

- [ ] Add RED packaging checks for v2 contracts in the plugin asset directory, no obsolete schemas/data copies, clean `dist/` replacement, local skill-link containment, and successful copied-package MCP `poll_check` on the comprehension fixture.
- [ ] Run `npm run contracts:build`; then `npm run build` to cleanly regenerate the distribution, followed by `npm run typecheck`.
- [ ] Commit through the tracked hook, which runs `npm run lint` and `npm test`; invoke CLI help/check/trace and MCP smoke tests with no live Jev request or GPU inference. Use hosted PR checks as post-push full-gate evidence.
- [ ] Run `git diff --check`, inspect all generated paths and public reports for reader-only claims, duplicate-count ambiguity, hidden answer-key leakage, stale schema versions, and unsupported response types.
- [ ] Commit each completed task through the tracked pre-commit hook. Update the PR #1 body to describe the approved stimulus-response and matched-arm scope, push this same branch, and verify the PR head, checks, draft status, and changed-file list.

## Acceptance evidence

- A local comprehension study returns typed answers across distinct respondent profiles, supports `unanswerable`, and optionally scores against a hidden answer key.
- A matched A/B study runs the same ordered profiles once per arm and produces arm distributions plus correctly aligned paired responses.
- Counts distinguish unique profiles, completed response cells, attempts/retries, exclusions, and unmatched arm outcomes.
- Existing durable-run, safety, provider, MCP, and self-contained plugin behavior passes the full gate.
- PR #1 remains a Draft and contains the complete implementation on its existing branch; no merge occurs.
