# dev.16 Source Quality Implementation Plan

> **For agentic workers:** Use `/executing-plans` to implement this plan sequentially, checking off completed steps. Read the approved spec and the implementing runbook first.

**Goal:** Complete the source-quality cleanup and install effective prevention mechanisms before the v0.3.0 release, delivering one reviewable feature PR into `develop` as `0.3.0-dev.16`.

**Architecture:** Domain contracts and rules have single owners. Typed read and command repositories hide Drizzle, controlled SQL, decoding, and transaction coordination. `run-store.ts` composes focused implementations; CLI and MCP share application operations. Routed unslop profiles capture demonstrated recurring mistakes and evolve with evidence.

**Tech stack:** Node 24, TypeScript, Zod, pinned Drizzle with native SQLite, esbuild, Node behavior tests, repository-owned AOM subscriptions and certification.

**Spec:** [Approved dev.16 design](../specs/2026-10-05-dev16-code-quality.md).

**Execution strategy:** `/executing-plans`, sequentially in `Z:/_agent-worktrees/sheg/codex/dev16-code-quality` on `codex/dev16-code-quality`. The architectural tasks share boundaries and should not run concurrent edits. Follow [implementing](../runbooks/implementing.md) and [PR](../runbooks/pr.md) routing.

## Global constraints

- Feature base and PR target are `develop`. Preserve the current branch and worktree; inspect live remote state before publication and integrate newer `develop` changes if needed.
- No release tag or publication, paid inference, ORM replacement, speculative framework, or unrelated product redesign. Keep Node 24 and existing dependency pins unless a concrete requirement justifies a change.
- Preserve atomic settlement, physical-call accounting, respondent-local recovery, frozen evidence, secure credentials, historical recall, and release migration guarantees. Provider I/O remains outside synchronous transactions.
- Root README is human-facing; root AGENTS is a small agent router. Markdown prose stays on one physical line per paragraph. No emojis or em-dashes.
- Canonical source remains authoritative. Regenerate distribution output; never edit generated bundles directly. Query assets must work in copied Git and ZIP packages without the repository.
- Tests prove behavior, not source text, file-size targets, or implementation repetition. Add coverage only for real gaps. Keep skill behavior campaigns out of CI/pre-commit and keep run results, audit receipts, and performance measurements off-repo.
- Stage coherent task boundaries and use the tracked hook. Before publication, `npm run verify` must pass on the staged final content. A successful hooked gate need not be repeated without a subsequent change or unresolved concern.
- Keep governing spec and plan through this PR. Retire completed artifacts already merged on the base when their custody policy permits, preserving enduring decisions in code/docs/ADRs. Do not carry planning artifacts into `main`.

## Review focus

- A batch with no valid answers still carries execution evidence: Task 1 rejects wrong identity and excessive attempts independently of answer validity.
- A JSON array or arbitrary record can satisfy a shallow check while its contents are corrupt: Task 2 exercises malformed history, route, and state payloads.
- Splitting settlement can introduce partial commits: Task 5 exercises failure rollback across all related records.
- SQL moved to assets can work in the checkout and fail when installed: Tasks 3 and 9 exercise copied-package resolution.
- Profiles can exist without being read: Task 8 checks actual routes and makes maintenance obligations explicit, without claiming effectiveness before observing it.

## Task 1: Correct execution validation and admission reporting

**Files:** `src/domain/decision/validate.ts`, `src/domain/decision/decision.ts`, `src/application/run-inspection.ts`, `test/decision.test.ts`, relevant existing inspection tests located through their imports.

**Interface:** Introduce shared execution validation consuming `ProviderExecutionEvidence` and the configured validation options. Single and batch validation both invoke it; batch answer failures remain respondent/question-local when execution is valid.

- [x] Extend existing behavior cases to cover empty and explicit-failure batches with wrong provider/model or excessive attempts, plus valid execution with valid and invalid siblings. Run `node --import tsx --test test/decision.test.ts`; confirm the new invalid-execution cases expose the current gap.
- [x] Validate shared execution before mapping batch answers. Preserve bounded typed answer failures and valid sibling retention. Keep execution contract failures separate from per-answer failures.
- [x] Exercise a multi-turn journey whose initial fit fails and assert inspection never claims initial success. Correct the warning without suppressing useful later-turn fit information.
- [x] Run affected tests and typecheck, review error boundaries, and commit the coherent correction through the tracked hook.

## Task 2: Establish canonical contracts and trustworthy codecs

**Files:** `src/domain/decision/{decision,provider,provider-failure,validate}.ts`, `src/domain/study/{task,arm,presentation}.ts`, `src/domain/journey/topology.ts`, `src/domain/run/{request,lifecycle}.ts`, `src/providers/{config,laya}.ts`, `src/infrastructure/sqlite/{rows,payload-codecs,cursors,journey-queries,follow-on-queries}.ts`, affected store reconstruction, `test/sqlite-payload-codecs.test.ts`, `test/types/sqlite-query-contracts.ts` and existing domain tests.

**Interfaces:** Input compatibility uses schema input types; internal parsed tasks use schema output types. Domain-owned vocabularies feed schemas and unions. JSON parsing yields `unknown`; payload decoders return validated domain values. Cursor-specific validation remains explicit.

- [x] Map each duplicated vocabulary/type to its semantic owner. Preserve serialized values and compatibility defaults. Replace expanded topology constructions with the existing alias and replace handwritten schema duplicates with inferred types.
- [x] Separate permissive task input from normalized task output; update consumers to discriminate on the parsed type. Convert the failure-rule table to a module-owned checked mapping instead of constructing and asserting it per call.
- [x] Add malformed persisted history, route, and state behavior cases at the read boundary. Confirm existing shallow checks miss the intended cases before implementing validated codecs. Keep safe failures consistent with the storage error contract.
- [x] Remove generic typed JSON assertions; adapt callers to schema validation or explicit unknown-field checks. Decode execution/result once and reuse it. Do not make low-level generic decision state pretend to be a journey-specific state; validate that stronger contract at the journey boundary.
- [x] Run affected domain, payload, journey and storage tests and typecheck. Check that SQL constraints remain aligned without rewriting historical migrations. Commit.

## Task 3: Build the owned SQL query library and asset pipeline

**Files:** Create `src/infrastructure/sqlite/queries/` with named concern-owned `.sql` assets and typed loader/definitions; update `src/infrastructure/sqlite/{evidence-query,follow-on-queries,journey-queries}.ts`, status queries currently in `run-store.ts`, `scripts/{build,generate-plugin-package,check-generated}.ts`, `test/{build,plugin-package-build,run-store}.test.ts`, `test/types/sqlite-query-contracts.ts`.

**Interfaces:** Each named query has declared bound parameters and a runtime result decoder. The asset resolver is module-relative in source and bundled runtime, never dependent on the caller's working directory. Repositories return application shapes, not statements or raw rows.

- [x] Inspect current bundling/copy rules and define one asset layout for `dist` and `plugins/sheg`. Use Git versions, not a separate query-version registry. Keep SQL assets grouped by repository concern.
- [x] Move complex literal queries into named assets. Keep simple typed Drizzle operations. Share evidence criterion translation between evidence and follow-on queries with bound values and an explicit operator vocabulary.
- [x] Verify behavioral equivalence using existing status, journey, criteria, selected-material/no-fit and pagination cases. Extend only missing cases; do not add source-string inventory tests.
- [x] Add an installed-runtime behavior check that exercises a named query from a copied package in another working directory with no source checkout or dependency installation. Include malformed raw projection rejection.
- [x] Run affected tests, build and generated parity; record the architectural choice in an ADR and update its index. Commit source and generated outputs together.

## Task 4: Finish read repository extraction and remove redundant reads

**Files:** `src/application/{run-store,run-service,question-worker}.ts`, `src/infrastructure/run-store.ts`; create focused `src/infrastructure/sqlite/reads/{identity,status,requests,journeys,contexts,answers,attempts,deletion}.ts` as responsibilities require; reuse existing query modules rather than creating parallel implementations. Update existing run-store, service, worker, evidence and upgrade tests.

**Interfaces:** `RunReadRepository` retains its application-facing methods and validated return shapes. Narrow existence/identity reads have their own internal projections. Multi-query public recall uses one deferred snapshot. Read implementations receive the same connection/transaction owner that commands use.

- [x] Extract reconstruction and projections into their semantic read owners, moving result types/errors to application/domain where appropriate. Keep imports acyclic and remove adapter compatibility re-exports once live callers no longer require them.
- [x] Replace aggregate status calls used only for existence/request-kind checks with narrow reads. Reuse statuses already obtained around reconciliation instead of projecting again. Share result/execution decoding.
- [x] Make deletion preview use a deferred transaction. Preserve source-consistent coverage, stale-cursor rejection and empty-page totals. Do not replace required all-match coverage with page-only counts.
- [x] Use temporary off-repo query instrumentation on increasing run/evaluation sizes to verify removed redundant work. Add stable operation/query-count behavior checks only where they express a meaningful complexity contract; no timing ceilings or stored measurement results.
- [x] Run storage/read/service/worker tests and typecheck. Review declared return shapes and transaction boundaries, then commit.

## Task 5: Finish command extraction while preserving atomic operations

**Files:** `src/infrastructure/run-store.ts`, `src/infrastructure/sqlite/commands/{acceptance,reservation,settlement,journey-transition,lifecycle,recovery}.ts`, `src/infrastructure/sqlite/connection.ts`, `src/application/{run-store,question-worker}.ts`, journey topology and material rule modules, existing settlement/recovery/store tests.

**Interfaces:** Commands own live precondition validation and mutation. A shared synchronous transaction owner exposes deferred reads and immediate writes. Settlement returns affected evaluation outcomes for worker state updates; application callers see no ORM or SQLite objects. `openRunStore` preserves its public composition result.

- [x] Move prepared validation, acceptance, lifecycle reconciliation, settlement, journey advancement and deletion orchestration to focused command owners. Keep operation atomicity explicit rather than distributing implicit nested commits.
- [x] Invoke domain transition matching and shared material consistency rules from persistence. Retain boundary-specific error translation without independently reimplementing rules.
- [x] Return actual affected outcomes from poll settlement and update the worker's local statuses from those outcomes, removing whole-run status reloads after each batch.
- [x] Select eligible expired work in bounded queries and distinguish launch/lease policies by meaning. Reuse established policy owners rather than relying on coincidentally equal numeric literals.
- [x] Exercise injected rollback during settlement, mixed batch outcomes, uncertain charged calls, stale respondent revisions, preserved previous journey answers, resume allowance, and cancellation. Reuse existing cases and fill genuine gaps.
- [x] Verify `run-store.ts` now owns composition and lifecycle of the persistence subsystem, not its operations. No line-count assertion. Run affected tests and commit.

## Task 6: Unify provider execution and application dispatch

**Files:** `src/providers/jev.ts`, create `src/providers/jev/transport.ts` for shared wire execution; `src/domain/decision/provider.ts`, `src/application/{preflight,run-inspection,run-service,run-operations}.ts`, `src/entrypoints/{cli,mcp}.ts`, credential composition boundaries, `test/{jev,jev-config,cli,mcp}.test.ts` and existing service tests.

**Interfaces:** Shared Jev transport returns decoded envelope and execution metadata or bounded provider failure. Single and batch decoders consume that result. Batch capability is coherent for measurement and inference. Shared application view dispatch is exhaustive over the existing operation schema.

- [x] Consolidate credential retrieval, permitted endpoint checks, retries, HTTP/envelope handling and accounting while retaining request-specific decoding. Replace fragile positional error arguments with the existing typed options contract where appropriate.
- [x] Verify mocked single/batch authentication failure, transport failure, HTTP rejection, malformed envelope, invalid typed answer, and call accounting. Preserve bounded validation details consistently and verify no credential appears in returned evidence.
- [x] Align inspection and worker capability selection; test a provider that supports only part of an optional batch capability and define a safe single-call fallback or explicit refusal consistently.
- [x] Share exhaustive CLI/MCP view dispatch. Remove concrete Windows credential types from application policy where a small capability port suffices; keep secure implementations at composition boundaries.
- [x] Run provider and entrypoint tests and typecheck; inspect that a shared helper has not absorbed answer-specific policy. Commit.

## Task 7: Remove remaining audited dead and fragile source

**Files:** `src/domain/attempt-ledger.ts`, `src/infrastructure/legacy/run-archive.ts`, `src/application/legacy/reports.ts`, `src/infrastructure/{data-root,process-lock,run-runtime}.ts`, `src/infrastructure/sqlite/recovery.ts`, relevant domain/material helpers, existing tests and fixtures importing moved helpers.

- [x] Recheck all callers before removing obsolete executable accounting. Move fixture-only construction into `test/helpers`; retain historical types and supported compatibility paths. Never delete vendored upstream APIs solely because current callers do not use them.
- [x] Pass already parsed archive content into migration rather than rereading it. Extract shared comparison accumulation without merging genuinely different report contracts. Name complex intermediate shapes and expand dense multi-statement control flow.
- [x] Remove dead parameters and unnecessary casts found in the audit. Validate lock PIDs as positive safe integers and preserve lock ownership semantics. Replace runtime proxies that falsely claim full service interfaces with an explicit unavailable-service boundary where warranted.
- [x] Make recovery diagnostics truthful when restoration itself fails: distinguish retained recovery files from restored active files. Exercise the corresponding failure path with fault injection if existing coverage does not establish it.
- [x] Run affected legacy, identity, runtime, recovery and domain tests. Re-read changed files for responsibility ownership and accidental behavior changes, then commit.

## Task 8: Adopt routed standards and redesign human orientation

**Files:** `README.md`, `AGENTS.md`, `.agents/doctrine/repo-runbook-policy.md`, `.agents/runbooks/{implementing,pr}.md`, existing/new concern playbooks; create `.agents/contracts/{operating-standards.json,standards-certification.md}` and `.agents/unslop/` profiles. Use repository-owned compliance commands if needed; no placeholder inventory.

- [ ] Resolve immutable upstream definition revisions for `unslop`, `playbook-composition`, and `runbook-composition`; read those definitions and register source repository, commit, path and certification reference. Do not treat installed plugin version alone as a source pin.
- [ ] Assess existing guides against the selected definitions. Keep lifecycle stages in runbooks and cross-stage concerns in playbooks. Correct redundant routing and capability availability claims. Root AGENTS links to subscriptions/certification and stage routing.
- [ ] Author concise guards against the actual corrected patterns with applicability and false-positive boundaries. Link distinct incident references only where useful; do not claim unobserved recurrence, readership or effectiveness.
- [ ] Route implementation and PR stages through applicable concern guides to profiles. Make reading, applying and maintaining profiles explicit at those decision points. Check every route manually and mechanically; verify that routing exists without presenting link checks as proof of behavioral effectiveness.
- [ ] Rewrite README around human purpose, the pull-quote study/follow-up example, supported installation, first-use prompt and useful documentation links. Explain simulation limits and input variation concisely. Keep contribution instructions in their owned documents.
- [ ] Review each changed document for truth, useful specificity, repeated emphasis and stale-receipt risk. Run link/reference integrity checks; use substantive review for semantic compliance. Commit.

## Task 9: Generate dev.16 and verify the integrated package

**Files:** `package.json`, generated lock/manifests/contracts/runtime/plugin output, version/build scripts as required, `test/{package,plugin-package-build,build}.test.ts` and installed-runtime behavior coverage.

- [ ] Set the single authored version to `0.3.0-dev.16`; run canonical generators/build to align generated identity. Verify no second authored version source is introduced.
- [ ] Build the ZIP from the generated package. Compare Git-package and ZIP runtime content; exercise MCP startup and a mock durable study/recall from a copied package, including query assets, schemas, migrations and worker resolution. No paid inference or credential export.
- [ ] Run relevant integration coverage and the full `npm run verify` staged gate. Fix genuine failures rather than weakening tests. Keep outputs and measurements outside the repository.
- [ ] Inspect the final diff for unintended public contract/schema changes, generated parity, secure diagnostics and preserved migration guarantees. Commit the version/generated closeout with the passing hook.

## Task 10: Review and publish the slice

- [ ] Critically re-read every touched source and guidance file. Verify the approved spec's acceptance criteria, transaction ownership, codec guarantees, query resolution and unslop routes against implementation. Resolve findings and rerun relevant checks.
- [ ] Promote consequential decisions into ADRs with index updates, retire eligible completed base planning artifacts under the applicable custody policy, and retain this governing spec/plan through the PR. Do not write completion receipts.
- [ ] Refresh `develop`, integrate any new changes, regenerate and validate if necessary. Push `codex/dev16-code-quality` and use `gh` to open one reviewable PR targeting `develop`, describing final behavior and relevant validation. Attach the created PR to this chat.
- [ ] Report the PR link, meaningful changes, verified checks and any material limitations. Leave human review and merge outside the checklist. Clean the worktree/branch only after verifying merge and preserving any needed untracked work.
