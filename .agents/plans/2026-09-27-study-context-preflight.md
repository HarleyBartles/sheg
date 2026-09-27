# Study Context Preflight Implementation Plan

**Goal:** Let study authors preflight every possible respondent journey against each configured provider before launching a run, using Laya's pinned tokenizer and Jev's reserved context estimate.

**Architecture:** Add deterministic study and profile validation, compile the exact compact decision packets used at runtime, exhaustively walk every branch for every frozen respondent and arm, and evaluate each packet through provider-specific measurement. Reuse the same packet compiler and provider measurement contracts for preflight and runtime admission. Laya measurement pins and follows the tokenizer and prompt assembly from the source revision validated by the spike. Jev uses a conservative estimator with explicit headroom below its configured 32K context limit.

**Tech Stack:** TypeScript, Zod, Node.js test runner, existing CLI/MCP boundaries, generated skill contracts.

**Spec:** `.agents/specs/2026-09-27-study-context-preflight-design.md`

**Execution Strategy:** `executing-plans`, sequential integrated implementation. Domain contracts and packet compilation are shared prerequisites for the walker, provider measurement, and user-facing preflight.

## Global Constraints

- Preserve the event history as the canonical record. The request packet contains a deterministic compact trajectory with prior task and choice identities and meanings, reading progress, and exposure metadata; it does not resend full prior stimulus text unless a graph explicitly exposes it again.
- For sequence studies, include every stimulus in scope for each decision request.
- Walk every possible branch for every respondent in the frozen cohort and every arm. No sampling, likelihood weighting, or “most paths” result.
- A provider is study-fit only when every reachable request fits. Any reachable overflow makes the whole study not fit for that provider. Incomplete traversal or unavailable measurement is unverified, never fit.
- Studies must be acyclic and every possible journey must terminate within `maxDecisions`.
- Keep the profile field maximums and enforce the agreed 1,500-character aggregate profile ceiling. Preserve generated contract ownership and regenerate through the repository command.
- Pin the supported Laya tokenizer and prompt assembly behavior to a source revision. The Sheg Laya measurement must count the same rendered packet with that tokenizer; runtime admission must fail closed if the supported tokenizer/configuration is unavailable or mismatched.
- Jev preflight estimates serialized request tokens at one token per three UTF-8 bytes, rounded up, then reserves 20% of the published 32K context window. A Jev fit means this conservative estimate plus reserve is within 32K; report the estimate and reserve, and do not describe the estimate as provider-reported usage or exact tokenization.
- Preflight must not make inference calls. Run configuration explicitly selects one provider; never silently switch providers.
- Do not truncate requests to force a fit. Keep preflight and runtime packet compilation identical.
- Preserve existing spend limits, run fingerprints, and provider credential checks.

## Review Focus

- Exact request packet parity between preflight and runtime, including graph re-exposure and compact history.
- Exhaustive branch coverage with respondent/profile identity preserved through reconverging paths.
- Correct distinction among fit, does-not-fit, and unverified outcomes.
- Laya tokenizer/prompt version pinning and Jev estimator headroom disclosure.
- Generated profile schema accurately enforcing the aggregate character limit.

---

## Task 1: Enforce bounded, terminating study and profile contracts

**Consumes:** Approved spec.

**Produces:** Domain validation and generated profile contract that reject oversized profiles and graph journeys that can cycle or fail to terminate within the decision bound.

**Files:** `src/domain/study/arm.ts`, `src/domain/respondents/profile.ts`, relevant study/profile tests under `test/`, generated contract sources under `skills/stimulus-response-polling/assets/`.

- [x] Add graph validation that rejects cycles and proves every reachable choice continuation reaches a terminal node within `maxDecisions`, including exposure-only cycles and branches that exceed the bound.
- [x] Add the 1,500-character aggregate profile validation while retaining existing per-field limits and field-specific error reporting.
- [x] Add behavioral tests for valid branching termination, cycles, nonterminating branches, decision-bound overflow, aggregate profile boundary, and aggregate overflow.
- [x] Update the generated contract validation rules for the aggregate profile limit and run `npm run contracts:build`; inspect the generated diff.
- [x] Run focused domain/profile tests and `node --import tsx scripts/check-generated.ts`.
- [x] Commit as `feat: enforce bounded study and profile contracts`.

**Verification:** Invalid cycles and any branch without an in-bound terminal are rejected at study load; a profile of exactly 1,500 characters is accepted and one character over is rejected; generated schema and runtime validation agree.

## Task 2: Compile one canonical compact decision packet

**Consumes:** Task 1 domain constraints.

**Produces:** A pure versioned packet compiler consumed by both journey execution and preflight.

**Files:** `src/domain/decision/prompt.ts`, `src/domain/journey/run.ts`, `test/prompts.test.ts`, `test/journey.test.ts`, and any affected fingerprint tests.

- [x] Define a typed compact trajectory representation that preserves prior task IDs, choice IDs and meanings, reading progress, and exposure metadata without copying prior full stimulus text.
- [x] Refactor prompt construction into a pure compiler that receives the current decision, profile, and canonical journey history and returns the complete provider-neutral packet.
- [x] For graph studies, include the stimuli exposed since the previous decision plus explicit re-exposures; for sequence studies, include all stimuli in scope at each decision.
- [x] Route normal journey execution through this compiler and update request-contract fingerprints for the changed packet semantics.
- [x] Add behavior tests proving prior choices remain distinguishable, old stimulus text is omitted unless re-exposed, sequence packets retain all in-scope stimuli, and packet output is deterministic.
- [x] Run focused prompt, journey, and fingerprint tests.
- [x] Commit as `feat: compile compact deterministic decision packets`.

**Verification:** Runtime requests are generated only by the shared compiler, and tests demonstrate the required history semantics without replaying prior stimulus text.

## Task 3: Exhaustively enumerate respondent journeys and decision packets

**Consumes:** Tasks 1 and 2.

**Produces:** A pure exhaustive walker yielding each unique journey path and each request packet at every decision.

**Files:** New `src/domain/journey/packet-walker.ts`, new `test/packet-walker.test.ts`, and narrowly scoped exports in `src/domain/journey/` if required.

- [x] Implement deterministic traversal for sequence and graph presentations, starting from every arm and respondent in the supplied frozen cohort.
- [x] At every choice, fork the journey state for every valid response and continue until terminal; preserve distinct path histories even where paths reconverge at the same node.
- [x] Emit stable respondent, arm, path, decision, and packet identities so reports can identify the exact failing journey.
- [x] Enforce finite traversal using the validated DAG and `maxDecisions`; return incomplete/unverified if an invariant is violated rather than dropping paths.
- [x] Add tests for all branches, multiple respondents and arms, reconverging graph nodes with distinct histories, deterministic ordering, terminal completion, and defensive incomplete traversal.
- [x] Run focused journey and preflight-walker tests.
- [x] Commit as `feat: enumerate all study preflight journeys`.

**Verification:** A small branching fixture yields every mathematically reachable packet exactly once per respondent/arm/path, and no early-stop or sampling behavior exists.

## Task 4: Add provider-specific context measurement and runtime admission

**Consumes:** Task 2 packet compiler and Task 3 packet identities.

**Produces:** A provider measurement interface with Laya-pinned token counting, conservative Jev estimation, and fail-closed runtime admission using the same measurement path.

**Files:** `src/domain/decision/provider.ts`, `src/providers/laya.ts`, `src/providers/jev.ts`, provider configuration/wiring in `src/application/run-manager.ts`, provider tests, and verified provider notes under `docs/`.

- [x] Define measurement results with method/version, measured amount, effective context limit, headroom, and a fit/overflow/unavailable outcome; keep measured values distinct from provider-reported usage.
- [x] Pin the `laya-ts` source revision validated by the spike. Vendor its minimal tokenizer and sequence/prompt helpers with source attribution and revision recorded in provider docs. Measure the same prompt construction and special-token behavior used by that revision; add fixtures derived from its source and a compatibility guard for checkpoint/configuration identity.
- [x] Replace optional “no measurer” behavior for supported Laya runs with explicit provider configuration. Reject startup or packet admission as unverified when tokenizer/configuration identity does not match the supported pin.
- [x] Implement Jev's conservative serialized-request estimate as `ceil(UTF-8 bytes / 3)` plus a 20% reserve of the 32K context window. Expose raw estimate, reserve, and effective threshold in results; never claim exact token counts. Refresh model metadata when configured model identity is a moving alias.
- [x] Wire runtime packet admission to the same provider measurer used by preflight, before any inference request. No truncation or provider fallback is allowed.
- [x] Add tests proving Laya measurement follows pinned tokenizer fixtures, mismatches fail closed, Jev reports estimate plus reserve and rejects beyond its effective threshold, and neither adapter makes an inference call during measurement.
- [x] Update `docs/` with the pinned Laya source/tokenizer details, Jev estimator, effective limits, and known measurement caveats.
- [x] Run focused Laya and Jev provider tests.
- [x] Commit as `feat: measure provider context before inference`.

**Verification:** Each runtime request is evaluated before inference through the same implementation used by preflight. Laya measurement is tokenizer-pinned; Jev reports an estimate with its explicit reserve.

## Task 5: Aggregate exhaustive fit results into an application preflight

**Consumes:** Tasks 1–4.

**Produces:** Application service that evaluates either a frozen cohort or the maximum valid profile envelope and reports each requested configured provider's complete fit result and first/all overflow evidence.

**Files:** New or existing application service under `src/application/`, `src/application/run-manager.ts` if it owns configuration loading, and application tests under `test/`.

- [x] Add a preflight service that loads and validates the study and either the frozen cohort or maximum valid profile envelope, invokes the exhaustive walker, evaluates every packet, and aggregates results per provider.
- [x] Mark maximum-profile results provisional. Return `fit`, `does-not-fit`, or `unverified`; report effective limit, measurement method, maximum measured/estimated packet, respondent/arm/path/decision for every overflow, and traversal completeness.
- [x] Do not call provider inference, require no run creation, and preserve run fingerprint semantics for subsequent launch.
- [x] Add service tests where one late branch overflows, every branch fits, one provider is unavailable, the traversal is incomplete, the maximum-profile result is provisional, and a frozen cohort/profile changes.
- [x] Run focused application tests.
- [x] Commit as `feat: aggregate provider study preflight results`.

**Verification:** A single reachable overflowing request makes that provider not-fit for the study; all green requires completed measurement of every reachable request for every cohort respondent and arm.

## Task 6: Expose preflight through CLI, MCP, and user-facing documentation

**Consumes:** Task 5 service.

**Produces:** CLI and MCP preflight entrypoints with stable, actionable output and provider availability guidance.

**Files:** `src/entrypoints/cli.ts`, `src/entrypoints/mcp.ts`, `test/cli.test.ts`, `test/mcp.test.ts`, user-facing skill/docs, and any generated skill contract outputs.

- [x] Add a CLI preflight command accepting a study, either a frozen cohort or provisional maximum-profile mode, and the configured providers to evaluate; ensure provider configuration and context limits are explicit in output.
- [x] Add a `poll_preflight` MCP tool that calls the same application service and returns structured results without inference calls.
- [x] Present overflow location and provider outcome so authors can shorten/bound a study for Laya or choose another configured provider for the complete study.
- [x] Document the deterministic all-path guarantee, profile limits, Laya 1,024-token limit, Jev 32K limit and the `ceil(UTF-8 bytes / 3)` estimate with 20% reserve, and the meaning of unverified.
- [x] Add CLI/MCP behavior tests for fit, not-fit, unverified, and malformed inputs; update generated contracts through `npm run contracts:build` if user-facing schemas changed.
- [x] Run focused entrypoint tests and `node --import tsx scripts/check-generated.ts`.
- [x] Commit as `feat: expose study context preflight`.

**Verification:** CLI and MCP report equivalent results from the same service; preflight is read-only with respect to inference and run creation.

## Task 7: Integrated verification and PR evidence

**Consumes:** Tasks 1–6.

**Produces:** Verified implementation against this plan and the approved spec.

**Files:** No new files unless verification reveals an implementation defect; update existing tests/docs at their owning boundaries.

- [x] Run behavior tests for domain contracts, packet compilation, exhaustive traversal, provider measurement, application aggregation, CLI, and MCP.
- [x] Inspect generated-contract status and verify no unrelated generated changes remain.
- [x] Run `npm run verify` before publication as required by repository doctrine; rely on the staged-snapshot pre-commit verification for the final commit and do not bypass hooks.
- [x] Review the complete diff against the approved spec, especially every branch, overflow/unverified outcomes, runtime/preflight packet parity, and no inference calls during preflight.
- [x] Commit any verification fixes with focused messages and attach the verification evidence to the PR.

**Verification:** `npm run verify` succeeds on the implementation, generated contracts are current, and the PR description includes verification and any remaining provider measurement caveats.
