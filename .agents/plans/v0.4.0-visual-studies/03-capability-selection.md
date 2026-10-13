# Capability Selection and Experiment Locks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Sheg select and freeze an eligible provider configuration per reached evaluation unit, subject to agent/user controls, declared experiment equality, fit, physical-call allowance, and defensible economy evidence.

**Architecture:** Keep experiment authoring and provider choice as separate inputs. Store the secret-free enabled provider catalogue and user preferences in Sheg's local SQLite data root, freeze a revisioned snapshot and policy into the accepted run, resolve actual units immediately before their first dispatch, persist each choice and its evidence before reserving a call, and route retries through that saved identity. Reuse provider measurement and current batching contracts; no model inference participates in selection.

**Tech Stack:** TypeScript, Zod, SQLite migrations, existing Jev/Laya/Clef adapters, Node test runner, generated MCP/CLI schemas, packaged Sheg skills.

**Spec:** `.agents/specs/2026-10-04-v0.4.0-visual-studies.md`, sections 2, 5-10, 12-13; dependency roadmap `.agents/plans/v0.4.0-visual-studies/roadmap.md`.

**Execution Strategy:** `executing-plans` - selection policy, accepted snapshots, per-unit persistence, and worker resolution are sequentially coupled through shared run contracts and one migration; inline execution preserves one coherent implementation model, while subagent-per-task handoffs would repeatedly reconstruct that state and offer little independent progress.

## Global Constraints

- Preserve existing explicit-provider requests and their pinned provider behavior.
- Only explicitly enabled, frozen configurations can be selected automatically; setup never enables a provider implicitly.
- Apply capability, question/group support, complete-packet fit, declared equality, and remaining physical-call allowance before preferences or economy.
- A binding pin or comparison lock never falls back; no post-dispatch provider substitution is permitted.
- Freeze the secret-free catalogue, settings, preferences, constraints, estimate metadata, and policy version at acceptance; credentials remain outside snapshots.
- Resolve a provider before dispatch and persist the selected configuration and admission evidence before creating the physical attempt.
- Retries, process restarts, and resume preserve the recorded provider/model and exact accepted packet.
- A run-wide physical-call allowance counts provider batches, splits, and retries; no inference call may be added to choose a provider.
- No fabricated price, quality, or latency ranking; unknown or incomparable costs must be disclosed.
- Continue supporting text-only Jev/Laya runs, explicit Clef image delivery, schema-9 through current datastore migration, installed CLI/MCP, and self-contained packages.
- Implement matched fork topology in Plan 4; Plan 3 may define reusable comparison identities and locks but must not infer or execute forks.
- Propose `0.4.0-dev.3` for this ordinary integration PR only if still unique when the execution PR is prepared; rebuild all derived version identities.

## Review Focus

- An accepted automatic study keeps its original settings after the local catalogue changes; prove from a separate process/reopened database.
- A reached packet that invalidates an already locked comparison fails with zero calls and identifies the member; it never unlocks or switches the provider.
- An interrupted dispatched unit retries only with its saved provider and packet after configuration changes; prove using attempt and dispatch evidence.
- Singleton execution prevents joint scoring while retaining shared-state identities and complete call bounds; prove with provider request capture and actual attempt count.
- An unknown-cost candidate is not reported as cheapest; prove the inspection output preserves the unknown basis while following the documented deterministic order.

---

## Current Code Seams

`src/providers/config.ts` owns the provider configuration union; `src/domain/run/request.ts` owns accepted request shapes; `src/application/run-inspection.ts` compiles packets and plans question batches; `src/application/run-service.ts` owns inspect/accept/resume; `src/application/question-worker.ts` dispatches the frozen current evaluation; journey state and request contracts live in `src/domain/run/lifecycle.ts` and `src/domain/run/request.ts`; SQLite migration and commands are under `src/infrastructure/sqlite/`; `src/domain/decision/provider.ts` defines the provider protocol; public contracts and plugin assets are generated through `scripts/build.ts`; canonical agent guidance lives under `skills/stimulus-response-polling/`.

### Task 1: Define Catalogue, Preference, and Selection Contracts

**Files:** Modify `src/providers/config.ts`, `src/domain/run/request.ts`, and `src/domain/run/lifecycle.ts`; add focused domain/application tests in `test/provider-selection-contract.test.ts`. The canonical run-request JSON Schema is generated at `skills/stimulus-response-polling/assets/run-request.schema.json` and is updated in Task 7 through `scripts/generate-contracts.ts`.

**Consumes:** Existing Jev/Laya/Clef configuration schemas, typed decision questions, explicit-provider `RunRequest`, context capabilities in decision packets.

**Produces:** Strict secret-free catalogue-entry and user-preference schemas; request-level automatic, whole-run pin, per-unit pin, preferred-order, required-capability, batching, declared-comparison, and optional `expectedSelectionFingerprint` fields; a versioned accepted selection-policy snapshot type. Preserve an explicit provider object as the compatibility form. Automatic requests reference catalogue identities rather than embedding configuration credentials or unenabled provider settings. The local catalogue and preferences are Sheg-owned settings in the same data root as durable runs, not a second ambient config file; enabled state is always an explicit user action.

- [ ] **Step 1: Add failing contract tests** for a valid enabled catalogue containing Jev, Laya, and Clef, reject duplicate identities, secret/token fields, unknown capability names, invalid cost metadata, and a request that embeds a disabled provider as if that enabled it; prove an alias cannot evade disabling the same canonical config, old explicit requests still parse unchanged, and `expectedSelectionFingerprint` is optional, bounded, and validated.
- [ ] **Step 2: Run the focused contract tests** with `node --import tsx --test test/provider-selection-contract.test.ts`; expected: failures because the automatic selection and catalogue schemas do not exist.
- [ ] **Step 3: Implement the schemas and normalized policy types** with strict object parsing, stable configuration identity derived from non-secret route/model/settings, explicit provider capability/question support, and supported price metadata with source, date, unit and currency; keep secret availability out of serializable contracts. Define `expectedSelectionFingerprint` for stale-inspection rejection.
- [ ] **Step 4: Re-run focused tests** and `npm run typecheck`; expected: all contract cases pass and existing request types remain valid.
- [ ] **Step 5: Commit** the domain/config contract and focused tests.

### Task 2: Freeze the Inspected Catalogue and Policy at Acceptance

**Files:** Modify `src/application/run-service.ts`, `src/application/run-inspection.ts`, `src/domain/run/request.ts`, `src/domain/run/lifecycle.ts`, `src/application/run-store.ts`, `src/infrastructure/sqlite/schema.ts`, `src/infrastructure/sqlite/tables.ts`, `src/infrastructure/sqlite/command-repository.ts`, and `src/infrastructure/sqlite/read-repository.ts`; create `migrations/0003_provider_selection/migration.sql`; add `test/provider-selection-snapshot.test.ts` and extend `test/sqlite-migrations.test.ts`, `test/run-service.test.ts`, and `test/run-store.test.ts`.

**Consumes:** Task 1 catalogue/request contracts, current inspection fingerprint path, transactional `accept` and `acceptJourney`, schema version 11.

**Produces:** Transactional local catalogue/preference read and mutation operations plus a frozen accepted provider-policy snapshot for automatic requests; inspect output includes catalogue revision/policy fingerprint and the frozen inputs needed for later selection explanation; stale pinned revisions/fingerprints reject acceptance; idempotent submissions retain the original snapshot. Existing explicit-provider requests continue using their original normalized request path when no matching configuration is explicitly disabled; an exact disabled entry cannot be bypassed by embedding its provider config.

- [ ] **Step 1: Add failing settings/acceptance tests** proving catalogue and preference CRUD persists across store reopen, an empty default catalogue enables nothing, and acceptance captures the inspected enabled revision atomically; add a stale-revision/fingerprint test that changes settings between inspect and accept and expects rejection before run creation.
- [ ] **Step 2: Run the focused persistence tests** with `node --import tsx --test test/provider-selection-snapshot.test.ts`; expected: failure because accepted runs have no frozen catalogue/policy or inspection pin.
- [ ] **Step 3: Add the next sequential SQLite migration** for versioned catalogue entries, explicit enablement, user preference order, and catalogue revision; persist the frozen non-secret selection snapshot with the accepted one-off or journey request in the existing acceptance transaction; store no API key, credential status, or ambient environment values.
- [ ] **Step 4: Add a catalogue repository/application contract** that validates full configuration before writes, changes its revision transactionally, and snapshots one revision inside acceptance; update credentials only through their independent existing store.
- [ ] **Step 5: Extend inspection and acceptance** to build the base canonical fingerprint over normalized study inputs, catalogue revision and configuration, user preferences, request constraints, and policy version; return it from inspection and compare `expectedSelectionFingerprint` inside the acceptance transaction before writing. Normalize the fingerprint input by omitting the optional expected fingerprint itself so submitting the inspected value does not change the fingerprint. Task 5 adds initial-choice explanations to this fingerprint after the selection and batch assessors exist.
- [ ] **Step 6: Re-run focused settings, migration, acceptance, idempotency, and existing schema-9 compatibility tests**; expected: settings and snapshots survive reopen, duplicates return original state, stale revisions do not create runs or reserve calls, and old fixtures migrate without rewriting their provider behavior.
- [ ] **Step 7: Commit** the accepted snapshot and migration boundary.

### Task 3: Implement Deterministic Eligibility and Economic Selection

**Files:** Create `src/application/provider-selection.ts`; modify `src/application/run-inspection.ts` and provider fit adapters only where the shared fit/economy contract needs an existing measurement; add `test/provider-selection.test.ts` and `test/provider-selection-inspection.test.ts`.

**Consumes:** Frozen catalogue and policy from Task 2, `DecisionProvider.measure`, provider configurations, question/group identity and batching control.

**Produces:** A deterministic selector that returns either a resolved configuration with criterion evidence or actionable exclusions for each candidate; selection is pure over a frozen policy, actual packet(s), current readiness observation, and a candidate-specific planned call/cost assessment. Economy order is eligible local execution with no provider invoice first, then comparable known hosted packet estimates, then stable catalogue order for unknown/incomparable hosted prices with an explicit unverified-cost label; that last choice is never described as cheapest. Candidate assessment includes batching splits and remaining call allowance, not a per-unit rate alone.

- [ ] **Step 1: Add failing selector tests** covering a text-only question selecting an eligible local Laya configuration over hosted candidates, a pixel-required question excluding Laya, a Clef packet overflow excluding Clef, an unsupported question type exclusion, a binding pin that fails without fallback, and unknown prices that are never labelled cheapest.
- [ ] **Step 2: Run the focused selector tests** with `node --import tsx --test test/provider-selection.test.ts`; expected: failure because there is no cross-provider eligibility and ordering function.
- [ ] **Step 3: Implement the pure selector** so hard capability/fit/question support and binding constraints run before preferences and economy; return stable candidate identity, exclusion reason, fit method/evidence, cost amount/basis or unknown, and the policy decision reason.
- [ ] **Step 4: Add failing preference precedence tests** proving explicit unit pin outranks ordered preferences, ordered preferences outrank saved user preferences, and economy is the final tie-break; hard eligibility always excludes an impossible preferred provider.
- [ ] **Step 5: Run selector and inspection tests**; expected: candidate explanations are complete, stable, secret-free, and no model/provider network inference is called by selection.
- [ ] **Step 6: Commit** the selection policy and its evidence contract.

### Task 4: Assess Candidate Batches and Select Economically

**Files:** Create `src/application/provider-batch-planning.ts`; modify `src/application/run-inspection.ts` and `src/application/provider-selection.ts`; add `test/provider-batch-selection.test.ts` and extend `test/run-inspection.test.ts`, `test/question-worker.test.ts`, and Jev/Laya/Clef adapter tests.

**Consumes:** Task 3 pure selector and candidate evidence types; provider `measure`/`measureBatch` methods; ordered questions sharing one state; batching control; `maxCalls`.

**Produces:** A provider-specific assessment for each eligible candidate/group containing exact admitted split requests, question IDs per physical call, fit evidence, repeated-input size, physical-call total and cost estimate/basis. The selector receives these assessments and excludes a candidate that exceeds the remaining study allowance; ties and unknown costs follow the documented stable and disclosed ordering. This candidate planner is shared by inspection and later execution.

- [ ] **Step 1: Add failing candidate-assessment tests** proving each candidate is measured against the full shared state and exact visual bindings; automatic mode chooses by total batch/split call plan and comparable known charge rather than single-call price; singleton has one question per request; providers without batch support remain singleton; repeated context and remaining `maxCalls` affect the candidate result.
- [ ] **Step 2: Run `node --import tsx --test test/provider-batch-selection.test.ts`**; expected: failure because run inspection only plans batches for one preselected provider.
- [ ] **Step 3: Extract provider-specific batch planning** into `provider-batch-planning.ts`, returning batches, fit evidence, minimum physical calls, input repetition estimate, and a cost amount/basis or explicit unknown; retain existing greedy fitting-split behavior for current explicit-provider runs.
- [ ] **Step 4: Evaluate all eligible automatic candidates with the same pre-group inputs** and pass their complete assessments into Task 3's selector. Apply the remaining study-call allowance to the whole plan; never combine different respondent, context, question group, or sibling answers.
- [ ] **Step 5: Add a captured-request test** proving selected question IDs reach only their declared physical call and singleton mode never sends sibling questions together.
- [ ] **Step 6: Run provider fit, Jev/Laya/Clef, run-inspection, and worker tests**; expected: explicit-provider batching retains current behavior, automatic inspection exposes comparable fit/cost evidence and does no inference, and actual call counts agree with planned counts.
- [ ] **Step 7: Commit** the candidate assessment and batch planning service.

### Task 5: Declare Comparison Membership and Persist Initial Choices

**Files:** Modify `src/domain/run/request.ts`, `src/domain/run/lifecycle.ts`, `src/application/run-service.ts`, `src/application/run-inspection.ts`, `src/application/provider-selection.ts`, `src/infrastructure/sqlite/commands/acceptance.ts`, `src/infrastructure/sqlite/commands/journey-transition.ts`, and `src/infrastructure/sqlite/reads/journeys.ts`; add `test/provider-comparison-locks.test.ts` and extend `test/run-service.test.ts`.

**Consumes:** Task 3 selector, Task 4 candidate batch assessments, authored evaluation-unit keys and comparison constraints, transactional accepted-run snapshots.

**Produces:** Explicit authored comparison-set identity on evaluation units with provider configuration/model equality by default; the first common choice is assessed against every already-known member and frozen before dispatch. For ungrouped known poll units and journey first asks, initial choices are resolved during inspect and acceptance under the pinned catalogue revision; future journey members remain unresolved until reached. Provider-comparison designs may deliberately relax model equality and identify model variation as a treatment. The contract can reference future Plan 4 branch identities without implementing fork topology.

- [ ] **Step 1: Add failing comparison tests** proving different declared respondents or stimuli can share one lock, ordinary adjacent evaluations remain independent, explicit provider comparison is represented as a treatment dimension, and an image/no-image comparison requires one vision-capable provider for both members.
- [ ] **Step 2: Run `node --import tsx --test test/provider-comparison-locks.test.ts`**; expected: failure because no comparison identity, lock selection, or lock persistence exists.
- [ ] **Step 3: Implement authored comparison membership and lock resolution** using stable evaluation references and Task 4's whole-group candidate assessments; check every currently available member packet before saving the common provider and preserve unresolved future members and policy provenance.
- [ ] **Step 4: Resolve all known initial poll units and first journey asks using the same inspection selector; atomically save initial choices, comparison locks, and selection evidence with the accepted catalogue snapshot. Extend `expectedSelectionFingerprint` to include these initial-choice explanations while excluding itself from its hash input.**
- [ ] **Step 5: Add failing acceptance tests** for duplicate/unknown authored member references, mismatched locked initial choices, and a journey lock spanning a known first ask and an unresolved later ask; verify only the first ask is initially selected and the lock identity is retained for later resolution.
- [ ] **Step 6: Run lock, acceptance, stale-fingerprint, idempotency, and persistence/reopen tests**; verify no currently known comparison member is silently dropped, regrouped, or changed from the inspected initial selection.
- [ ] **Step 7: Commit** comparison identity, locks, and acceptance-time initial choices.

### Task 6: Resolve Reached Units Before Dispatch and Preserve Choices on Recovery

**Files:** Modify `src/application/question-worker.ts`, `src/application/run-service.ts`, `src/application/run-store.ts`, `src/entrypoints/worker.ts`, `src/domain/run/request.ts`, `src/infrastructure/run-store.ts`, SQLite tables/schema/acceptance/command/read repositories and journey query, `test/automatic-provider-routing.test.ts`, migration tests, and schema/package version assertions; add the next sequential migration for nullable per-evaluation provider choices.

**Consumes:** Frozen snapshots from Task 2, selector from Task 3, candidate batch assessment from Task 4, comparison locks from Task 5, existing physical-attempt reservation lifecycle.

**Produces:** Acceptance copies inspected initial choices onto their evaluation rows in the acceptance transaction; future rows begin unresolved. Before reservation, the worker resolves an actual reached unit from the frozen catalogue/policy and current packet; it atomically persists the selected configuration, fit/candidate evidence, comparison-lock reference, and packet fingerprint together with the physical reservation. Dispatch is constructed from that persisted choice. A retry or resume loads the saved choice; future unresolved units may resolve when reached, and no provider is substituted after an error. No-eligible and locked-fit journey turns become identified zero-attempt respondent failures. Explicit-provider runs preserve their existing run-wide route without requiring a new selection record.

- [x] **Step 1: Add a failing worker test** that resolves later journey turns using their actual compact visual history, persists provider choices before dispatch, and checks the selected provider receives the corresponding packet.
- [x] **Step 2: Run focused worker tests**; confirmed failure because durable runs initially had one run-wide provider configuration and no per-unit resolver.
- [x] **Step 3: Add the next SQLite migration and evaluation read/write contract** for nullable per-evaluation selection evidence; seed accepted automatic initial choices transactionally, leave future journey rows unresolved, and preserve existing explicit runs.
- [x] **Step 4: Implement actual-unit candidate assessment and atomic resolve-and-reserve**: measure the reached packet against ready candidates from the frozen catalogue, enforce resolved comparison constraints, validate the packet fingerprint and call allowance inside reservation, persist the choice, then reserve. Retries load that choice. No-eligible and locked-fit outcomes are identified zero-attempt failures.
- [x] **Step 5: Add mixed-provider journey tests** for a text-only Laya turn followed by a pixel-required Clef turn with compact prior choice history; assert choices are durable before dispatch and retries use the same provider and packet.
- [x] **Step 6: Add interruption and recovery coverage** for post-dispatch transport loss, datastore reopen, and changed local catalogue settings; dispatched uncertainty follows current accounting and the saved choice is reused.
- [x] **Step 7: Add no-provider and late comparison-lock overflow cases**; both produce zero-attempt identified failures, make no fallback request, preserve prior locks, and allow an unaffected respondent to continue when its packet fits.
- [x] **Step 8: Run migration, worker, reservation, resume, journey visual-history, lock-overflow, failure-isolation and full repository verification suites; commit only after persisted selections, attempts and captured dispatches agree.**

### Task 7: Explain Selection Through CLI, MCP, and Shipped Agent Guidance

**Files:** Modify `src/entrypoints/cli.ts`, `src/entrypoints/mcp.ts`, the provider-settings application contract from Task 2, `scripts/generate-contracts.ts`, generated `skills/stimulus-response-polling/assets/run-request.schema.json` and a provider-settings request schema, `skills/stimulus-response-polling/references/`, `docs/providers/routing.md`, `docs/README.md`, `test/cli.test.ts`, `test/mcp.test.ts`, and the repository's skill scenario fixtures for provider-selection behavior.

**Consumes:** Frozen request fields, inspection explanations, per-unit resolution evidence, comparison locks, batch plans and actual execution records from Tasks 1-6.

**Produces:** One common CLI/MCP workflow for catalogue setup/enablement and preferences without secrets in study requests; inspection distinguishes eligible/rejected candidates, configured preference, binding override, lock, known estimates and basis, unknown prices, resolved initial units and unresolved future units; execution evidence identifies the actual provider/model. Agent guidance teaches the default and available levers without requiring routing implementation details. Settings are read and changed through the same application contract backed by the migrated local store.

- [x] **Step 1: Add failing CLI/MCP schema and workflow tests** for catalogue listing/editing, per-request pin/preference/batching controls, inspection explanations, secret redaction, image-backed choice options mapped to their exact image materials, and identical application behavior across entrypoints. Reconcile the current request validator, which rejects image materials in `materialOptions`, with the Clef guide and provider prompt contract that use those mappings to name candidate images.
- [x] **Step 2: Run focused public-contract, CLI, MCP, and skill behavior tests**; expected: failure because the new selection policy is not discoverable or exposed.
- [x] **Step 3: Implement shared application operations and generated contracts**; do not create parallel CLI/MCP selection logic or hand-edit generated bundles.
- [x] **Step 4: Update shipped agent guidance** with explicit examples: let Sheg select economically, pin Clef only for pixel-required units, map each portrait choice to its exact image material, pin the same model for a stimulus/respondent comparison, use a provider comparison only when model is intentionally varied, and choose singleton when joint question scoring is unwanted. State that an absent/empty catalogue requires setup for automatic mode while old explicit configs still work unless explicitly disabled.
- [x] **Step 5: Run contract generation, guidance checks, focused CLI/MCP tests, and skill behavior tests**; expected: current explicit-provider instructions and requests remain usable.
- [ ] **Step 6: Commit** the public workflow and guidance with generated contract sources only.

### Task 8: Qualify the Installed Runtime and Prepare the Integration PR

**Files:** Modify `test/package.test.ts`, package fixtures as required, `.agents/plans/v0.4.0-visual-studies/roadmap.md`, and generated package output from canonical sources.

**Consumes:** Tasks 1-7 complete, next unique version proposal, Plan 3 contract, all source-owned code/tests/docs/guidance.

**Produces:** A copied-plugin test proving automatic mixed-provider routing works without checkout state; completed full repository verification, generated parity, package validation, and fresh whole-branch review; reviewable PR to `develop` with transparent risk and evidence.

- [ ] **Step 1: Add a failing copied-package scenario** with mocked providers for text-only and pixel-required stages, enabled/disabled configurations, a locked comparison, a reached journey resolution, source catalogue changes after acceptance, and a retry; inspect physical attempts and ensure no live network or credentials are used.
- [ ] **Step 2: Run the copied-package test**; expected: fail against current explicit-provider-only package behavior.
- [ ] **Step 3: Set the unique `0.4.0-dev.N` identity in root `package.json`; run `npm run contracts:build`, `npm run build`, and `npm run plugin:package -- --validate-only`; inspect generated package manifests and confirm tests do not read checkout files or `node_modules`.
- [ ] **Step 4: Run focused tests and `npm run verify`**; expected: complete test, lint, type, guidance and generated parity gates pass, with only documented environment-specific skips.
- [ ] **Step 5: Review source boundaries and staged diff**; confirm selector is the single owner of eligibility/economy, entrypoints share one contract, snapshots exclude secrets, and retries cannot substitute. Commit through the tracked hook.
- [ ] **Step 6: Refresh `develop`, recheck version uniqueness and full branch diff, verify hosted checks and review threads, merge only when gates pass, verify merged tree and advance the roadmap cursor to Plan 4.**

## Slice Exit

An agent can leave provider selection to Sheg or use explicit study/unit controls. Sheg freezes what was enabled and preferred at acceptance, resolves each actual unit only when its input is known, holds declared comparisons to the same provider/model, incorporates provider batching and shared call limits into inspection, records its choice before dispatch, and explains both known and unresolved decisions. Provider readiness changes, bad fits, unknown future contexts, timeouts, and exhausted budgets never trigger an undeclared provider swap. Matched fork authoring/execution, visual follow-ons, and perceptual recipe qualification remain in Plans 4-6.
