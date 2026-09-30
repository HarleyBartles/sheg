# Typed Response Primitives and Deterministic Routing Implementation Plan

**Status:** completed-awaiting-retirement

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make Choice, Score, and Noul first-class typed tasks and results through Sheg's study contracts, provider calls, respondent journeys, durable runs, reports, and deterministic graph routing.

**Architecture:** Extend the existing one-study model with discriminated typed questions/results and typed journey evidence. Keep provider-specific wire codecs at the provider boundary, normalize and validate against the authored task before recording a response, and route Score/Noul only through explicit validated threshold rules. Carry every type through existing preview, preflight, packet measurement, trace, checkpoint, and report paths; do not create a separate panel runner.

**Tech Stack:** TypeScript 5.9, Node.js 24, Zod 4, Node test runner, JSON Schema contract generator, existing Jev Decisions API and Laya `/v1/systemone` adapters.

**Spec:** `.agents/specs/2026-09-30-smallest-executable-study-iteration.md`; roadmap: `.agents/plans/2026-09-30-smallest-executable-study-roadmap.md`.

**Execution Strategy:** `executing-plans` - use one continuous execution context because the schema, provider, journey, checkpoint, and report contracts are sequentially coupled. Fresh per-task handoffs would repeatedly reconstruct the same tagged-union and routing invariants; there are no independent tracks worth parallelizing.

## Global Constraints

- Choice, Score, and Noul are the only respondent output types; do not add open-text respondent output.
- Preserve authored stimulus and question wording; do not silently truncate, summarize, or rewrite content.
- Respondents execute independently; a respondent may see only their own earlier journey history.
- Each task controls response-history passthrough independently of routing: default to including prior response history for backward compatibility, and allow a task to omit it while keeping the same respondents and run.
- Score and Noul routing requires explicit deterministic thresholds; do not derive a route implicitly from an untyped or converted value.
- Keep cycles out of the current graph; every authored route remains finite and terminating.
- A provider type is enabled only after its exact configured wire contract and response behavior are verified; unsupported typed requests fail closed before inference where possible.
- Keep current Choice study manifests valid and preserve their observed outcomes and report meaning.
- Do not claim simulated outputs are human readership, statistical significance, causal lift, or publication outcomes.
- Retire SHEG-1 artifacts marked `completed-awaiting-retirement` in the first commit of the implementation slice after verifying their decisions are promoted; do not create a cleanup-only PR.
- Before implementation mutation, report the dedicated worktree path, branch, base commit, and initial `git status --short`.

## Review Focus

- Legacy Choice manifests and durable Choice checkpoints remain readable and report the same selected option and probability evidence; cover in Tasks 1 and 4.
- Score values may be fractional expected rubric levels, while routing domains are rubric-bounded; cover boundary, equality, gap, overlap, and endpoint cases in Tasks 1 and 3.
- Noul represents P(true) on the closed interval `[0, 1]`; cover exact threshold equality and both endpoints in Tasks 1 and 3.
- A provider can return a validly shaped answer for the wrong question type, option set, rubric, or checkpoint; reject before recording a decision and cover each provider in Task 2.
- A respondent who continues through several stages receives only their own prior typed responses as context when enabled, while exited respondents receive no later task; stage reach remains measured against the full frozen cohort. Also support the same respondents with response-history passthrough disabled. Cover in Tasks 1, 3 and 4.
- Incomplete, failed, decision-limited, and not-reached paths remain distinguishable in typed report denominators; cover in Task 4.
- Packet measurement, preflight, preview, trace, MCP schemas, and generated JSON Schema cannot continue to advertise Choice-only or accept ambiguous typed routes; cover in Task 5.

---

## Live code map from SHEG-1 base

- `src/domain/study/task.ts` owns the Choice-only task contract. `src/domain/decision/decision.ts` and `validate.ts` own the Choice-only provider request/result contract and validation.
- `src/domain/decision/prompt.ts` assembles current stimulus and a trajectory made of exposure and choice events. `src/domain/journey/run.ts` records Choice events and `src/domain/journey/trace.ts` scripts option IDs.
- `src/domain/study/presentation.ts` defines graph transitions by `optionId`; `src/domain/study/arm.ts` validates exact option coverage, reachability, acyclicity, and `maxDecisions`. `src/domain/journey/route-bounds.ts`, `packet-walker.ts`, `preview.ts`, and `trace.ts` enumerate or execute those paths.
- `src/providers/jev.ts` and `src/providers/laya.ts` each encode Choice requests and parse Choice answers at the wire boundary. `src/providers/laya/context-fit.ts` and `src/providers/laya/vendor/sequence.ts` reproduce Laya packet/token behavior; inspect these before changing request shapes.
- `src/infrastructure/checkpoint-store.ts` strictly stores format version 2, Choice journey events, and `DecisionResult`. `src/infrastructure/identity.ts` plus `src/domain/decision/prompt.ts::promptContractHash` protect replay/fingerprint integrity.
- `src/application/worker.ts` replays checkpointed decisions by task ID and request fingerprint. `src/application/reports.ts` emits Choice-only response rows and option counts; its comparison function is currently arm-within-run.
- `src/application/preflight.ts`, `packet-sizing.ts`, `study-preview.ts`, and MCP/CLI entrypoints consume the canonical contracts and must continue to use those contracts rather than parallel parsers.
- `scripts/generate-contracts.ts` generates `skills/stimulus-response-polling/assets/study-manifest.schema.json`; `scripts/check-generated.ts` verifies generated assets and `dist/`.

## Typed contract to implement

At the manifest boundary, preserve version `2.0` and accept existing untagged Choice tasks as Choice. New tasks carry a required `type` discriminator. Normalize all parsed tasks to one internal discriminated union before domain behavior consumes them. Each task also has a response-history policy. Omitted policy means include prior responses, preserving current behavior; an authored no-history policy removes prior response events from that task's prompt while retaining exposure/task context and the same respondent journey. Routing/eligibility is independent: a later task may target respondents selected by prior answers or the full cohort. The authored forms are:

- Choice: existing `options` map, optionally tagged `type: "choice"`; instructions plus stable option IDs and descriptions.
- Score: `type: "score"`, instructions, and an ordered `rubric` array of at least two descriptions. Preserve System One's expected score as a finite value from the first through last rubric level, its per-level probability distribution, and returned rubric legend/confidence where the provider supplies them.
- Noul: `type: "noul"`, proposition/instructions, and optional `criteria` with `true` and `false` descriptions. Preserve P(true) as a finite value in `[0, 1]`.

Use a matching request/result union that retains the discriminator and primitive evidence. Do not coerce Score/Noul into Choice. The provider adapter may normalize wire-field naming, but it must preserve the returned distribution/legend and configured model/checkpoint metadata. Jev's current verified wire shape uses `type`, `instructions`, and `criteria`, then returns the matching `type` plus typed evidence. Laya's current service documents the same System One primitives; confirm the configured service revision with fake-transport fixtures and fail closed when its response does not match. Do not infer support from a shared model family.

For graph routing, retain option-ID edges for Choice. A Score/Noul edge uses a `when` interval with `minimum`, `maximum`, `minimumInclusive`, and `maximumInclusive`. This lets the author declare which route owns an exact threshold value, including fractional Score values. Validate that each ask node's intervals are mutually exclusive and cover the full response domain: `[0, last rubric level]` for expected Score and `[0, 1]` for Noul. Reject gaps, overlaps, out-of-domain endpoints, and implicit defaults. Keep existing finite-graph and max-decision validation.

## Tasks

### Task 0: Retire completed SHEG-1 planning artifacts

**Files:**
- Delete: `.agents/plans/2026-09-30-agent-guided-study-design.md`
- Delete: `.agents/specs/2026-09-28-agent-guided-study-design.md`

- [x] Confirm the worktree base is current `main`, the two files are tracked in that base, and both carry the exact `completed-awaiting-retirement` marker.
- [x] Confirm their lasting study-model choices remain represented in ADR-0008 and the current study-design/polling skills; check for and remove no other artifact or source.
- [x] Remove only those two completion-marked files. Keep the new SHEG-2 spec, roadmap, and Plan 1 tracked.
- [x] Commit retirement, the approved spec, roadmap, and Plan 1 together as the first commit of this branch's eventual PR. This is not a cleanup-only PR; subsequent commits implement this roadmap.

### Task 1: Define typed task, request, result, event, and route contracts

**Files:**
- Modify: `src/domain/study/task.ts`
- Modify: `src/domain/decision/decision.ts`
- Modify: `src/domain/decision/validate.ts`
- Modify: `src/domain/decision/prompt.ts`
- Modify: `src/domain/study/presentation.ts`
- Modify: `src/domain/study/arm.ts`
- Modify: `src/domain/journey/run.ts`
- Modify: `src/domain/journey/trace.ts`
- Test: `test/stimulus-response.test.ts`
- Test: `test/decision.test.ts`
- Test: `test/prompts.test.ts`
- Test: `test/journey.test.ts`
- Test: `test/trace.test.ts`

**Interfaces:**
- Consumes: Current `StudyTask`, `DecisionRequest`, `DecisionResult`, `PromptHistoryEvent`, `JourneyResult`, and graph transition contracts.
- Produces: Discriminated Choice/Score/Noul task, request, response, and journey-event unions. `runJourney` accepts the matching typed result for a task and records it without discarding primitive evidence. `traceStudy` accepts typed scripted outcomes. Prompt trajectory serializes each prior typed answer with its meaning, while retaining exposure order.

- [x] Add contract tests proving Choice input remains unchanged and that Score supports fractional expected scores with probabilities keyed to every rubric level, while Noul supports exactly P(true) in `[0, 1]`.
- [x] Add validation tests for missing/extra distribution entries, invalid sums, out-of-range values, mismatched discriminators, malformed rubric/criteria, and wrong-task-type results.
- [x] Add graph-schema tests for explicit Choice edges and typed threshold predicates, including equality declaration, full-domain coverage, no overlap, no gaps, and no out-of-range threshold.
- [x] Add journey and prompt-history tests proving each typed response is retained in the respondent's own trajectory and later packets when enabled; a no-history task receives no prior responses, and existing Choice manifests keep established include-history semantics.
- [x] Prove history policy and eligibility are independent: a later task can ask only respondents routed onward with history, or ask all 100 members of the same frozen cohort with no prior response context.
- [x] Implement the task/result/event unions and single-source validation. Model Score routing against the authored rubric's actual last level; model Noul routing against `[0, 1]`.
- [x] Extend graph validation to require exhaustive, exclusive typed route coverage while preserving reachability, acyclicity, and `maxDecisions` checks.
- [x] Make `traceStudy` route from typed scripted outcomes and reject missing, extra, or wrong-type scripted results.
- [x] Run focused tests: `node --import tsx --test test/stimulus-response.test.ts test/decision.test.ts test/prompts.test.ts test/journey.test.ts test/trace.test.ts`.

### Task 2: Verify and implement typed Jev and Laya wire adapters

**Files:**
- Modify: `src/providers/jev.ts`
- Modify: `src/providers/laya.ts`
- Modify: `src/providers/laya/context-fit.ts` only if the typed request changes measured input construction
- Modify: `src/providers/laya/vendor/sequence.ts` only if request sequence semantics require it
- Modify: `docs/providers/jev.md`
- Modify: `docs/providers/laya.md`
- Test: `test/jev.test.ts`
- Test: `test/laya.test.ts`
- Test: `test/laya-context.test.ts`

**Interfaces:**
- Consumes: Typed request/result schemas from Task 1 and current `DecisionProvider` interface.
- Produces: Provider adapters that encode the exact System One request shape for the selected task type, parse the corresponding typed answer, retain model/checkpoint/usage/billing evidence, and invoke the shared type-aware validator.

- [x] Inspect current primary contracts for the configured Jev/OpenRouter Decisions endpoint, TypeSafe System One response types, and Laya `/v1/systemone`; record exact request/response fields, required evidence, and any provider/type limitations in `docs/providers/`.
- [x] Add fake-transport contract fixtures for Jev and Laya covering one Choice, one fractional Score with rubric probabilities/legend, and one Noul probability; include supported response metadata variations from the live contracts.
- [x] Add negative fixtures proving an unsupported or malformed typed answer fails closed, is not converted to another type, and preserves current billing/attempt classification.
- [x] Implement typed request encoding and response normalization without changing Choice wire behavior. Provider enablement is type-specific and evidence-backed; if an adapter endpoint/model cannot be verified, return the existing unsupported-input path before inference.
- [x] Verify Laya context measurement and packet sizing use the exact same typed request encoder as execution; never treat a Choice-shaped approximate packet as Score/Noul fit evidence.
- [x] Run focused tests: `node --import tsx --test test/jev.test.ts test/laya.test.ts test/laya-context.test.ts`.

### Task 3: Execute and preview typed threshold routes

**Files:**
- Modify: `src/domain/journey/route-bounds.ts`
- Modify: `src/domain/journey/packet-walker.ts`
- Modify: `src/domain/journey/preview.ts`
- Modify: `src/application/study-preview.ts`
- Modify: `src/application/run-manager.ts` if route-bound types change
- Test: `test/journey-preview.test.ts`
- Test: `test/packet-walker.test.ts`
- Test: `test/run-estimate.test.ts`
- Test: `test/study-loader.test.ts`

**Interfaces:**
- Consumes: Typed graph transitions and response values from Tasks 1-2.
- Produces: Runtime routing, deterministic pre-run traversal, run-call bounds, and human-readable preview that agree on each Choice/Score/Noul route.

- [x] Add a staged reading journey fixture for 100 respondents with five sections and typed continue/exit decisions; script 79 continuing after stage one and 67 after stage two. Assert later tasks are reached only by respondents routed onward, later packets carry each respondent's own history, and report reach counts stay over the full cohort denominator.
- [x] Add route fixtures exercising Choice option selection, Score threshold below/equal/above, and Noul threshold at 0, equal to threshold, and at 1.
- [x] Add preview and packet-walker tests that enumerate every valid threshold destination exactly once and preserve typed routing labels in output.
- [x] Update route selection, decision-call bounds, packet enumeration, and preview to consume the same validated route predicates; preserve complete-route bounds and reject partial previews.
- [x] Add loader tests proving invalid typed transition coverage is rejected before run creation/provider calls.
- [x] Run focused tests: `node --import tsx --test test/journey-preview.test.ts test/packet-walker.test.ts test/run-estimate.test.ts test/study-loader.test.ts`.

### Task 4: Persist typed evidence and report typed distributions

**Files:**
- Modify: `src/infrastructure/checkpoint-store.ts`
- Modify: `src/application/worker.ts`
- Modify: `src/application/reports.ts` (typed aggregation and within-run comparison)
- Modify: `src/infrastructure/identity.ts` and `src/domain/decision/prompt.ts` only where typed semantics must change a fingerprint
- Test: `test/jobs.test.ts`
- Test: `test/report.test.ts`
- Test: `test/identity.test.ts`

**Interfaces:**
- Consumes: Typed journey events/results from Tasks 1-3.
- Produces: Restart-safe typed checkpoints and reports containing per-respondent primitive evidence, task/occurrence typed distributions, and explicit reached/completed/incomplete/not-reached denominators.

- [x] Before changing `promptContractHash`, capture its exact current value in a legacy compatibility fixture. Bump newly written checkpoints to format version 3; make `CheckpointStore.read` accept version 2 and normalize legacy Choice results/events into typed Choice evidence. Preserve version-2 report reproducibility by validating its fingerprints with the captured legacy prompt hash; newly built reports use format version 3.
- [x] Add worker tests proving replay compares the typed request fingerprint and restores the same typed result without another provider call.
- [x] Add report fixtures for all three types, retaining Choice counts, Score value/rubric-level distributions, and Noul P(true) distributions with respondent-level evidence, per-stage reach/exits, and the full frozen-cohort denominator.
- [x] Extend within-run arm comparison to compare typed values only when task type and meanings align: Choice option IDs/descriptions, Score ordered rubric meanings, or the same Noul proposition/true-false meanings. Preserve raw typed values and expose non-comparable pairs without coercion.
- [x] Implement persistence and report aggregation without flattening primitive values into strings or treating distributions as free text.
- [x] Verify prompt/execution fingerprints change when the packet contract's typed meaning changes and stay deterministic for identical requests.
- [x] Run focused tests: `node --import tsx --test test/jobs.test.ts test/report.test.ts test/identity.test.ts`.

### Task 5: Carry typed contracts through preflight, MCP/CLI, generated schemas, and guidance

**Files:**
- Modify: `src/application/preflight.ts`
- Modify: `src/application/packet-sizing.ts`
- Modify: `src/entrypoints/mcp.ts`
- Modify: `src/entrypoints/cli.ts`
- Modify: `scripts/generate-contracts.ts`
- Regenerate: `skills/stimulus-response-polling/assets/study-manifest.schema.json`
- Modify: `skills/study-design/references/primitives-and-tools.md`
- Modify: `docs/reference/study-manifest.md`
- Create: `docs/decisions/0012-system-one-typed-responses-and-routing.md`
- Modify: `docs/decisions/README.md`
- Test: `test/application-preflight.test.ts`
- Test: `test/packet-sizing.test.ts`
- Test: `test/mcp.test.ts`
- Test: `test/cli.test.ts`
- Test: `test/package.test.ts`

**Interfaces:**
- Consumes: Final typed task/result/routing contracts and report shape from Tasks 1-4.
- Produces: Public Sheg tool/CLI schemas and generated contract documentation that accept the same typed design the runtime executes, plus precise supported-type/provider guidance.

- [x] Add preflight and draft packet tests for Choice, Score, and Noul tasks against each configured provider; unavailable wire support is reported as unavailable/unsupported, not as a fit claim.
- [x] Add MCP and CLI tests proving typed trace, preview, preflight, run, report, and current within-run compare paths expose the same contract and typed values.
- [x] Update `scripts/generate-contracts.ts` annotations for typed tasks, rubrics, and threshold transitions; regenerate with `npm run contracts:build`.
- [x] Update skill and reference tables with each primitive's meaning, output evidence, routing limits, provider support status, and concrete examples; keep graph syntax as an implementation detail for ordinary user-facing collaboration.
- [x] Preserve `trace --choices` and `poll_trace` `choices` for existing Choice-only traces. Add typed trace inputs (`--responses` and MCP `responses`) for Score/Noul outcomes; reject requests that supply both forms or neither.
- [x] Add ADR-0012 describing the durable typed-task/result and explicit-threshold-routing contract, and update `docs/decisions/README.md` in the same change.
- [x] Test MCP preview, preflight, packet measurement, typed trace, run, report, and within-run compare contracts; test CLI typed trace, run/check, report, and within-run compare while retaining the existing `--choices` behavior.
- [x] Run focused tests: `node --import tsx --test test/application-preflight.test.ts test/packet-sizing.test.ts test/mcp.test.ts test/cli.test.ts test/package.test.ts`.
- [x] Run `npm run verify` after source and generated outputs are finalized. The planning/retirement commit is already the first commit in the PR; confirm those deletions remain in branch history. Do not run the canonical gate immediately before or after a successful hooked commit.
- [x] Preserve version-2 prompt/stimulus/request fingerprints and legacy packets for report, resume, and replay after Choice normalization; detect any changed history semantics.
- [x] Count typed Score/Noul responses in all journey decision totals and accept typed trajectory summaries in packet measurement while retaining legacy Choice input.
- [x] Reject Laya Score rubrics above the documented service limit during measurement and before inference, with a provider-specific diagnostic.

## Exit criteria

- A Choice-only study remains valid and produces the same option-level result semantics.
- Each verified provider can execute every enabled Choice, Score, and Noul task with typed result evidence preserved from wire response through checkpoint and report.
- Existing within-run arm comparison preserves the typed outputs and reports when paired task meanings are not comparable.
- Unsupported provider/type combinations fail closed and are identified explicitly.
- Score and Noul graph routes are explicit, deterministic, exhaustive, non-overlapping, and finite; equality behavior is visible in the authored predicate.
- Within one run, a respondent-specific continuation receives only that respondent's typed prior journey context; respondents who exit do not see later tasks and stage denominators remain anchored to the frozen cohort.
- Journey execution, trace, route bounds, preview, preflight, packet measurement, checkpoint replay, report, MCP, CLI, and generated manifest schema agree on the same typed contract.
- Existing Choice checkpoint/report artifacts remain readable through an explicit compatibility/migration path.
- `npm run verify` passes; provider documentation states the sources and verification date used for each enabled wire type.
