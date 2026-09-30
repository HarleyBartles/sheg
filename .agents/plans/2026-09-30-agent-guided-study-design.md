# Agent-Guided Study Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an operating agent shipped documentation of Sheg's capabilities, fast packet-fit checks for study drafts, and a collaborative study-design skill that takes the human from stimulus and question through a validated, runnable study.

**Architecture:** Keep the executed decision packet as the single source for both inference and measurement. Add bounded application services for packet measurement and a cohort-independent journey preview, expose them as MCP tools, and document Sheg's primitives, tools, design process, and provider limits in a shipped study-design skill and references. Preserve existing run, journey, and provider behavior; Score, Noul, and threshold routing are documented as target concepts but remain unavailable until implemented.

**Tech Stack:** TypeScript, Zod 4, Node.js 24, MCP SDK, existing Jev byte estimator, pinned Laya tokenizer and sequence builder, Node test runner.

**Spec:** `.agents/specs/2026-09-28-agent-guided-study-design.md`

**Execution Strategy:** `executing-plans` - packet assembly, measurement, MCP contracts, and the skill all share the same request semantics and should be implemented and reviewed in one continuous context. A fresh per-task subagent lane would add contract handoffs without creating useful parallelism.

## Global Constraints

- Preserve `engines.node: ">=24 <25"` and current dependency set unless implementation evidence proves a new dependency necessary.
- Static Sheg product knowledge is documented in the shipped skill references and requires no tool call or inference. No inference call may occur during journey preview, packet sizing, validation, trace, or preflight.
- Laya fit uses the pinned tokenizer and configured 1,024-token limit; Jev uses the existing 32,768 context estimate and 20% reserve.
- Current executable respondent tasks are finite Choice tasks. Document Score, Noul, and deterministic threshold routing as unavailable until their contracts and relevant providers exist; do not implement them in this slice.
- Preserve the two approval points: approve the human-language study design, then approve the respondent run. Do not add approval gates for graph authoring, validation, or preview.
- Preserve author-provided stimulus and question wording. Explain fit pressure and offer design choices; do not silently truncate or rewrite content.
- Before any implementation mutation, use a fresh dedicated worktree based on current `main`, and report worktree path, branch, base commit, and initial `git status --short`.
- Run `npm run verify` before publishing. Do not bypass the tracked pre-commit hook.

## Review Focus

- Laya reports a truncation/option-limit failure even when the raw token headroom is non-negative; sizing must report `fits: false` with the provider reason.
- A requested Cartesian product exceeds the packet or serialized-byte cap; reject it before measurement and return no partial result marked as complete.
- Different providers identify different largest cases, or cases tie; report provider-specific maxima and resolve ties deterministically by case ID.
- A later decision carries a distinct earlier choice or exposure history; measure each explicitly supplied packet context and do not collapse the histories.
- Jev credentials are absent or a provider cannot measure the request; report unconfigured/unverified separately from measured overflow.

---

## File Map

- `src/domain/decision/prompt.ts` remains the canonical owner of respondent-task packet assembly. Add a lower-level assembler for explicit packet parts and route the existing study compiler through it.
- `src/application/packet-sizing.ts` validates and expands bounded measurement cases, invokes provider `measure` methods, and returns deterministic per-case and per-provider summaries.
- `src/domain/journey/preview.ts` produces a deterministic branch-tree preview from validated study arms, showing each stimulus, task, choice, and destination while representing shared continuations once.
- `src/application/study-preview.ts` loads and validates a manifest without requiring a cohort and returns the domain preview in an MCP-ready shape.
- `src/entrypoints/mcp.ts` exposes `poll_preview` and `poll_measure_packets` with strict Zod contracts and structured JSON-safe results.
- `test/prompts.test.ts`, `test/packet-sizing.test.ts`, `test/journey-preview.test.ts`, and `test/mcp.test.ts` cover packet parity, sizing combinations, journey semantics, and tool contracts.
- `skills/study-design/SKILL.md` teaches the human-facing design conversation and harness workflow; `skills/study-design/references/primitives-and-tools.md` explains Sheg's study vocabulary and current tool contracts; `skills/study-design/references/packet-budgeting.md` explains packet composition and provider fit.
- `skills/stimulus-response-polling/SKILL.md` routes study-design work to the new skill and remains the detailed harness-operation guide.
- `skills/stimulus-response-polling/references/archetypes-and-cohorts.md` teaches concise, relevant profile writing using the existing caps as guardrails.
- `README.md` and `docs/reference/study-manifest.md` document capability discovery, journey preview, incremental sizing, and final whole-study preflight.
- `docs/decisions/0011-deterministic-study-preview-and-packet-sizing.md` records the durable MCP contract and architecture decision; update `docs/decisions/README.md` in the same change.

## Interfaces

### Canonical packet assembly

Add a packet-parts type in `src/domain/decision/prompt.ts` and an exported `compileDecisionRequest(parts)` function. The parts contain:

- respondent perspective fields;
- encountered stimulus items as `{ id, text }[]`;
- the existing `TrajectorySummary` shape;
- one Choice question as `{ id, instructions, options }`.

The function returns the validated `DecisionRequest` with its compiled state. Existing `compileDecisionPacket(arm, profile, taskId, history)` derives the same parts as today and delegates to `compileDecisionRequest`; its output and prompt contract hash remain unchanged for existing inputs.

### Packet measurement operation

Add `measurePacketBatch(input)` in `src/application/packet-sizing.ts`. The input has:

- `providers`: the same strict Jev/Laya configuration union used by `poll_preflight`;
- `combination`: `paired` or `cartesian`;
- `respondents`, `stimuli`, `tasks`, and `trajectories`: non-empty arrays of `{ id, value }` variants, with one-entry dimensions broadcast in paired mode;
- each task as the current Choice shape, each stimulus value as the exact encountered `{ id, text }[]`, and each trajectory value as the exact `TrajectorySummary` for that decision;
- stable, unique IDs within every variant dimension.

`paired` means positional pairing, not comparing packet contents: variant 0 from each multi-valued dimension is combined into case 0, variant 1 into case 1, and so on. A one-entry dimension is broadcast across all cases, so one respondent plus 30 tasks produces 30 checks. For example, 3 profiles and 3 task drafts produce `(profile-1, task-1)`, `(profile-2, task-2)`, and `(profile-3, task-3)`. If two or more dimensions contain multiple variants, their lengths must match; for example, 3 profiles and 2 task drafts return a validation error before provider measurement. This rule makes each intended pair explicit instead of silently dropping or reusing unmatched variants. `cartesian` expands every combination in input order, so those same dimensions produce 6 cases. Each case gets a deterministic ID derived from its dimension IDs. A maximum of 1,000 expanded cases and 16 MiB of serialized packet input applies per call; validate both bounds before invoking any provider measurer.

Return `{ complete: true, caseCount, providers, cases }`. Each case contains its ID, dimension IDs, and provider measurements. Each provider measurement includes provider/model identity, measured or estimated input tokens, context limit, effective limit, `headroomTokens = effectiveLimit - tokens`, fit status, method, and reason/details. Preserve `unavailable` distinctly from `overflow`; an unavailable measurement has no numeric fit claim. Each provider summary identifies its largest measured case and token count, resolving equal counts by lexicographically smallest case ID. Overall `fits` is based on the provider measurer's status, not headroom alone.

## Tasks

### Task 1: Share one canonical decision-packet assembler

**Files:**
- Modify: `src/domain/decision/prompt.ts`
- Test: `test/prompts.test.ts`

**Interfaces:**
- Consumes: current `PromptState`, `TrajectorySummary`, `DecisionRequest`, and `compileDecisionPacket` contracts.
- Produces: exported `DecisionPacketParts` and `compileDecisionRequest(parts)` as specified above; existing `compileDecisionPacket` delegates to it.

- [x] Add a test that constructs the same respondent/task/stimulus/history through the existing arm path and through explicit packet parts, then asserts the full `DecisionRequest` equality.
- [x] Add tests that stimulus encounter order, profile fields, trajectory choice meanings, and exact option IDs survive the shared assembler.
- [x] Add a compatibility assertion for `promptContractHash()` against the value captured from the unchanged contract before editing; do not alter the hash input for this refactor.
- [x] Run `node --import tsx --test test/prompts.test.ts` and confirm the new behavior fails before implementation.
- [x] Implement the parts type and assembler with `decisionRequestSchema.parse`; delegate existing compilation through it without changing sequence/graph selection behavior.
- [x] Run `node --import tsx --test test/prompts.test.ts`; confirm all old and new prompt behavior passes.

### Task 2: Implement bounded deterministic packet-batch measurement

**Files:**
- Create: `src/application/packet-sizing.ts`
- Modify: `src/domain/respondents/profile.ts` to expose the canonical prose-only perspective schema for packet input
- Modify: `src/domain/decision/prompt.ts` only if Task 1's exported types need a narrow adjustment
- Test: `test/packet-sizing.test.ts`
- Test: `test/respondents.test.ts` for the shared perspective schema
- Test: `test/laya-context.test.ts` only if a provider-fit defect is exposed by integration behavior
- Test: `test/jev.test.ts` only if a provider-fit defect is exposed by integration behavior

**Interfaces:**
- Consumes: `DecisionPacketParts`, `compileDecisionRequest`, canonical `respondentPerspectiveSchema`, provider configs, `JevProvider.measure`, and `LayaProvider.measure`.
- Produces: `packetSizingInputSchema`, `PacketSizingInput`, `measurePacketBatch(input)`, and the result shape specified above.

- [x] Test one profile against 30 task variants and assert 30 stable case results with one provider-specific largest case.
- [x] Test 30 profiles against one task and assert each profile appears once in paired mode.
- [x] Test two multi-valued dimensions in paired mode and assert same-index variants form each case, without any content-equality check; assert unequal multivalue lengths fail validation before provider measurement. Include a concrete 3-profile/2-task error example in the tool description and agent docs.
- [x] Test one singleton dimension paired with a 30-variant dimension and assert the singleton is broadcast into all 30 cases.
- [x] Test the same dimensions in Cartesian mode and assert the exact product count and stable input-order case identities.
- [x] Test multi-step contexts with distinct trajectory histories and assert each packet retains its own history and size.
- [x] Test a 1,001-case expansion and a serialized payload above 16 MiB; assert both reject before any provider `measure` call and return no partial-success result.
- [x] Test provider-specific maxima and deterministic tie-breaking, including different maxima for two providers.
- [x] Test that each profile field and aggregate prose caps in packet sizing use the same exported perspective schema as respondent-profile validation.
- [x] Test `unavailable`, missing Jev credentials, and Laya truncation failure separately from measured overflow; verify a positive arithmetic headroom never overrides provider status.
- [x] Test that provider `decide` and network `fetch` are never called by packet measurement.
- [x] Run `node --import tsx --test test/packet-sizing.test.ts` and confirm the cases fail before implementation.
- [x] Implement schema validation, expansion pre-counts, deterministic IDs, byte accounting, and provider measurement using the shared packet assembler. Reject over-cap requests before measuring.
- [x] Run `node --import tsx --test test/packet-sizing.test.ts`; confirm the full matrix and failure behavior passes.

### Task 3: Report reachable run-call bounds at study check

**Files:**
- Create: `src/domain/journey/route-bounds.ts`
- Modify: `src/application/run-manager.ts`
- Modify: `src/entrypoints/mcp.ts`
- Test: `test/run-estimate.test.ts`
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: validated arms and the frozen respondent count loaded by `checkStudy`.
- Produces: `runBounds: { minimumDecisionCalls, maximumDecisionCalls, maximumCallsConfigured, maximumCallsSufficient, spendCeilingUsd? }` in the `poll_check` result. For Jev, `spendCeilingUsd = min(maxUsd, maxPerCallUsd * min(maximumDecisionCalls, maxCalls))`. Label it as a configured ceiling, not a predicted charge.

- [x] Test route-count behavior for a sequence, a graph with short and long branches, two respondents across two arms, reconverged branches, and a branch that terminates before another task.
- [x] Test `poll_check` output for reachable minimum/maximum call bounds, whether configured `maxCalls` can cover the maximum, and the Jev spend ceiling; verify Laya has no paid spend value.
- [x] Run `node --import tsx --test test/run-estimate.test.ts` and confirm the new route-bound behavior fails before implementation.
- [x] Implement memoized minimum/maximum decision counts over each validated sequence or acyclic graph. Count each decision node once per route and handle shared continuations without enumerating every complete path; leave `walkStudyPackets` and exhaustive context preflight unchanged.
- [x] Aggregate each arm's minimum/maximum over every frozen respondent in `checkStudy`. Compare the maximum with configured `maxCalls` and compute the Jev spend ceiling as `min(maxUsd, maxPerCallUsd * min(maximumDecisionCalls, maxCalls))` without presenting it as expected spend.
- [x] Add the bounded fields to `poll_check` structured output and update its MCP description.
- [x] Run `node --import tsx --test test/run-estimate.test.ts test/mcp.test.ts` and confirm route bounds and provider-specific spend ceilings are correct.

### Task 4: Produce a generic all-branches journey preview

**Files:**
- Create: `src/domain/journey/preview.ts`
- Create: `src/application/study-preview.ts`
- Modify: `src/entrypoints/mcp.ts`
- Test: `test/journey-preview.test.ts`
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: validated study arms, existing sequence and graph presentation contracts, task schemas, and `loadStudy` with `allowMissingCohort: true`.
- Produces: `previewStudyJourney(arms)`, application operation `previewStudy(manifestPath)`, and MCP tool `poll_preview`.

- [x] Test sequence ordering, stimulus reveal placement, task wording/options, and terminal completion.
- [x] Test a graph with multiple branches, stimulus exposures, recalled-choice text, short and long routes, and a shared continuation; assert every branch appears and the shared continuation is represented once.
- [x] Test invalid graphs and unknown destinations return validation errors rather than partial previews.
- [x] Run focused journey-preview tests and confirm the behavior assertions fail before implementation.
- [x] Implement a deterministic, cohort-independent branch-tree/step representation. Include stable node and choice IDs, authored stimulus/task/option wording, each choice destination, and explicit references to shared continuation nodes. Do not collapse distinct routes or invent prose about respondent intent.
- [x] Add `previewStudy(manifestPath)` using the loader's no-cohort mode so preview requires no provider or frozen cohort while source/hash validation remains active.
- [x] Register `poll_preview`; its schema and description state that it makes no inference calls, needs no cohort, and returns every branch with shared continuations represented once.
- [x] Test structured and JSON text results through MCP, including invalid manifest input.
- [x] Run focused preview and MCP tests; confirm a representative branching design is fully represented.

### Task 5: Expose packet sizing over MCP

**Files:**
- Modify: `src/entrypoints/mcp.ts`
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `measurePacketBatch(input)` and its Zod schema.
- Produces: MCP tool `poll_measure_packets`, returning `structuredContent` and JSON text through the existing `jsonResult` helper.

- [x] Test that the MCP server registers `poll_measure_packets` and returns the application result in structured and JSON text forms.
- [x] Test that `poll_measure_packets` accepts one respondent with multiple task variants, returns per-case provider fit and provider maxima, and rejects malformed variant IDs and provider configs.
- [x] Test that sizing never invokes `decide` or an inference endpoint.
- [x] Run `node --import tsx --test test/mcp.test.ts` and confirm new tests fail before implementation.
- [x] Implement the strict schema and tool description, explaining no inference calls, paired versus Cartesian behavior with a short example, singleton broadcasting, unequal-length validation, and the result's fit/estimate semantics.
- [x] Run `node --import tsx --test test/mcp.test.ts` and confirm structured tool results and invalid-input handling pass.

### Task 6: Teach agents to design studies and budget complete task packets

**Files:**
- Create: `skills/study-design/SKILL.md`
- Create: `skills/study-design/references/primitives-and-tools.md`
- Create: `skills/study-design/references/packet-budgeting.md`
- Create: `docs/decisions/0011-deterministic-study-preview-and-packet-sizing.md`
- Modify: `docs/decisions/README.md`
- Modify: `skills/stimulus-response-polling/SKILL.md`
- Modify: `skills/stimulus-response-polling/references/archetypes-and-cohorts.md`
- Modify: `README.md`
- Modify: `docs/reference/study-manifest.md`

**Interfaces:**
- Consumes: the accepted product flow and the registered MCP tools `poll_preview`, `poll_check`, `poll_preflight`, `poll_trace`, `poll_start`, `poll_status`, `poll_cancel`, `poll_reconcile`, `poll_resume`, `poll_report`, `poll_compare`, and `poll_measure_packets`.
- Produces: an agent process that starts with the human's stimulus, question, and desired perspective; proposes/revises a human-language design; translates the accepted design into current Sheg contracts; previews every branch from the validated graph; builds and discusses archetype/profile cohorts; performs incremental packet sizing and final whole-study preflight; reports the reachable call range and configured spend ceiling; requires approval of the actual run; and supports the agent's interpretation against the original question.

- [x] Draft the study-design skill so it probes underspecified intent, directs the agent to Sheg's primitives-and-tools reference before proposing unsupported features, distinguishes current availability from target concepts, calls `poll_preview` after graph validation and presents its complete generic branching journey, and observes the two approved human gates.
- [x] Document Sheg's study, arm, stimulus, task, typed response, respondent, cohort, presentation, journey, history, and decision-packet primitives with examples of how they compose. State that Choice is currently executable and Score, Noul, and threshold routing are unavailable until implemented.
- [x] Document each registered MCP tool by name, purpose, accepted input, output, and provider behavior: `poll_preview` (manifest, no inference); `poll_check` (manifest/provider config, no inference); `poll_preflight` (manifest/cohort/provider config, measures packets without inference); `poll_trace` (manifest/cohort/arm/respondent/scripted choices, no inference); `poll_measure_packets` (packet variants/provider config, measures without inference); `poll_start` (run config, starts inference); `poll_status` (run ID/output directory, reads status); `poll_cancel` (run ID/output directory, requests cancellation and waits for in-flight decisions); `poll_reconcile` (run ID/output directory/verified charge, updates billing state); `poll_resume` (run ID/output directory, resumes inference); `poll_report` (run ID/output directory, builds report); and `poll_compare` (run/arm IDs, compares reports). Static product knowledge lives in these references; do not add a capability-list MCP tool.
- [x] Draft packet-budgeting guidance with the task input formula from the spec, current sequence/graph stimulus inclusion, trajectory history, provider framing, Laya's measured 1,024-token limit, Jev's estimated 32K context with 20% reserve, and an explanation that profile caps bound only one input component.
- [x] Explain how to batch variants over any packet dimension, choose paired cases or explicit Cartesian products, inspect each respondent/task fit and largest case, and then run exhaustive whole-study preflight when the design and cohort are complete. Give the 3-profile/3-task positional pairing example, the 3-profile/2-task validation error, singleton broadcasting, and the 3-by-2 Cartesian result so an agent can select the intended semantics without probing the tool.
- [x] Update cohort guidance to tell profile-producing agents to encode only perspective details that can affect responses, keep prose concise, and treat the five 500-character field limits and 1,500-character aggregate cap as safeguards rather than writing targets.
- [x] Add a behavioral walkthrough to README and study-manifest guidance that uses `poll_preview` after validation, then sizing and preflight; state that preview/sizing/preflight make no inference calls. Keep graph internals out of the human's starting flow.
- [x] Record the shared packet compiler, cohort-independent all-branches preview, bounded packet measurement, and deterministic run-call/spend bounds as a proposed ADR; add it to the decision index in the same change.
- [x] Manually walk the written example against registered tool schemas and the accepted spec; correct any instruction that implies unsupported Score, Noul, or threshold execution.

### Task 7: Verify the integrated plugin surface

**Files:**
- Modify: `README.md` tool list if Tasks 3-5 have not already updated it
- Modify: `test/package.test.ts` to include the new skill in the isolated packaged-plugin fixture
- Verify: `dist/` output through the existing build command; do not edit generated files directly

**Interfaces:**
- Consumes: the new MCP tools and application services from Tasks 1-5, the skill/docs and ADR from Task 6, and the existing build/test scripts in `package.json`.
- Produces: a buildable Sheg plugin with discoverable agent guidance and working deterministic measurement tools.

- [x] Run focused tests from Tasks 1-6 and inspect the MCP build output for the registered preview and sizing tools.
- [x] Run `npm run build` and confirm `dist/mcp.js` includes `poll_preview` and `poll_measure_packets`; confirm generated distribution files are outputs only.
- [x] Exercise the shipped skill examples through `test/mcp.test.ts` using the existing `StdioClientTransport`: preview a branching manifest without a cohort; size one profile against 30 task variants and 30 profiles against one task; compare paired and Cartesian variants; use Jev's offline estimator and Laya's pinned local tokenizer; assert structured results and confirm no inference endpoint is called. The MCP tests use the real registered server and deterministic local measurement implementations, so no network fake or inference provider is required.
- [x] Confirm Laya uses its pinned tokenizer measurement, Jev reports its estimated measurement method and reserve, and provider fit status remains distinct from configuration/availability.
- [x] Confirm the ADR index includes the new record.
- [x] Update `test/package.test.ts` to copy the new skill into its isolated plugin fixture and verify that links from both packaged skills resolve within the plugin root.
- [ ] Stage the intended source, tests, docs, skill, and generated build outputs only if the repository tracks them.
- [ ] Create the final implementation commit through the normal tracked pre-commit hook. The hook runs `npm run verify` against the staged snapshot; do not run that full command immediately before or after the hooked commit, and do not bypass the hook.
- [ ] Push the implementation branch and open a Draft PR containing the approved plan/spec and complete implementation. Verify the remote branch head, PR draft state, and required checks; keep the PR in Draft for human review.
- [ ] Record final changed files, focused evidence, successful staged-snapshot `npm run verify`, PR link/state, and any provider limits in the implementation handoff.

## Out of Scope

- Implementing Score, Noul, or threshold routing in task execution or provider adapters; this slice reports their current unavailability.
- The facilitator-driven panel mode tracked separately in SHEG-2.
- Model-driven study optimization, relevance-based pruning, or history compaction.
- Automated interpretation that replaces the operating agent's editorial judgement.
- Introducing a new approval gate for graph construction, validation, or journey preview.
