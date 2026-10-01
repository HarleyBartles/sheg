# Query Recorded Evidence and Compose Follow-ons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent can query a run using explicit evidence criteria, select reusable respondent-turn references, and start a new run that uses each selected respondent's saved context or an explicit context variation without replaying the source journey.

**Architecture:** Keep source runs immutable and resolve criteria to concrete evaluation/context references. Query returns bounded machine-readable evidence with page and source completeness separated. A follow-on is a new accepted run whose request and frozen packets retain the selected identities, exact respondent-visible inputs, and source lineage independently of the source run's lifetime. Resolution used for fit measurement is revalidated atomically at acceptance so a progressing source cannot silently change the accepted cohort.

**Tech Stack:** TypeScript, Zod, SQLite (`node:sqlite`), MCP SDK, Node test runner, packaged Codex plugin.

**Spec:** `.agents/specs/2026-10-01-v0.3.0-epic-spec.md`, especially sections 4, 5, 9, and 11.

**Execution Strategy:** `executing-plans` - the selector, snapshot, packet, storage, and MCP contracts are tightly coupled and require one integration context; user explicitly directed inline execution. A fresh whole-branch review remains the final independent check.

## Global Constraints

- No back compatibility or SQLite migration layer is required before v1; unsupported pre-v1 stores give explicit export/reset guidance.
- Agents supply criteria and make relevance/interpretation decisions; Sheg returns evidence and reusable references, not narrative conclusions.
- Source runs and their evidence are immutable. Selection rationale, source lineage, and identifiers stay outside model-visible packets.
- Preserve exact typed Choice, Score, and Noul evidence; preserve missing confidence as missing and never convert mean Noul probability into a yes-count.
- Query and inspection make no inference calls. Execution retains existing selected-provider identity and physical-attempt limits.
- No paid provider calls, release-version changes, release tags, publication, or compatibility shims in this plan.
- Preserve the pre-existing untracked design sketch.

## Review Focus

- A typed lost-interest answer and a terminal departure are distinct criteria; test that departure alone never matches an answer criterion.
- Querying a progressing source reports matches-so-far and incomplete source status; a later query can discover new matches.
- A source that advances between fit measurement and acceptance cannot produce a silently stale selector cohort; test that changed matches reject acceptance without creating a run.
- A selected context with history removed must also omit incidental earlier exposure/order metadata; test the exact persisted/provider packet.
- Deleting a source must leave its accepted follow-on's frozen inputs and lineage readable; test source deletion and follow-on retrieval in SQLite.

---

## Task 1: Define evidence selectors, query projections, and follow-on request contracts

**Files:**
- Modify: `src/domain/run/request.ts`
- Modify: `src/domain/run/lifecycle.ts`
- Test: `test/run-request.test.ts` (or the current domain request test owner)
- Regenerate: `dist/` through `npm run build` because the shared request module is bundled into MCP and worker entrypoints

**Interfaces:**
- Consumes: current `ParsedInlineRunRequest`, `ParsedInlineJourneyRequest`, `AnswerRow`, and typed `DecisionValue` contracts.
- Produces: strict `run_query` criteria and `follow-on` request schemas. Criteria use conjunction across optional respondent ID, evaluation status, question ID, encountered material ID, typed response (`choice` with choice ID, `score` with one of `eq|lt|lte|gt|gte` and a finite value, or `noul` with the same numeric operators), and journey terminal outcome. Follow-on selection is either these criteria for one source run or explicit `{evaluationId, contextId}` references scoped to one source run. Context mode is `recorded`, `fresh-material`, `omit-history`, or `continue`; each request contains one typed question, selected provider, and `maxCalls`. A selected source respondent may appear in multiple turns; each turn remains a distinct evaluation/context, even when respondent IDs repeat. Run discovery criteria add created-after/before and referenced material ID to existing status/label filters.

- [x] Add schema behavior tests in `test/run-request.test.ts` for each typed criterion, AND combination, invalid response-kind/operator pairing, duplicate explicit evaluation/context references, and prohibition on a direct-departure criterion pretending to be a typed lost-interest answer.
- [x] Add follow-on request tests for criteria vs explicit refs, context modes and their required inputs, unique selected evaluation references, and preserving user-authored question/material/provider/call settings.
- [x] Add result/projection type tests in `test/run-request.test.ts` that distinguish source completeness from whether the current result page is exhausted.
- [x] Implement strict schemas and types. Keep selectors finite and explicit; no SQL fragments, arbitrary expressions, free-form relevance scoring, or automatic respondent selection.
- [x] Run `node --import tsx --test test/run-request.test.ts`; expect all schema behavior tests to pass.
- [x] Run `npm run build` and stage its owned bundle outputs before the commit.
- [ ] Commit the domain contract, tests, and generated bundles as `feat: define recorded evidence selectors`.

## Task 2: Add bounded evidence query and honest source completeness

**Files:**
- Modify: `src/infrastructure/run-store.ts`
- Modify: `src/domain/run/lifecycle.ts`
- Test: `test/run-store.test.ts`

**Interfaces:**
- Consumes: Task 1 selector and projection types, current evaluation/attempt/journey tables.
- Produces: `RunStore.queryEvidence(input)` returning `{items, totalMatches, sourceRunId, sourceStatus, sourceComplete, coverage, nextCursor?}`. `coverage` reports total/completed/failed evaluations at the query snapshot. Each item includes source run, respondent/evaluation/context IDs, optional turn/node/occurrence, question/status, typed result with full available distributions/confidence when present, route outcome when available, and provider/model/compiler/context fingerprint provenance. Cursor binds `sourceRunId`, canonical criteria fingerprint, maximum source evaluation ordinal present at the first page, and last returned ordinal.

- [ ] Test query across poll and journey runs, all typed result shapes and comparisons, terminal outcome matching, deterministic ordering, page boundaries, invalid/stale/mismatched cursors, and filters pinned to their cursor.
- [ ] Test incompleteness honestly: running/prepared, interrupted, failed, cancelled, and partial sources remain incomplete; only a completed source is complete. An incomplete query returns its current count and says more may match if queried after further execution.
- [ ] Implement filtering through parameterized bounded SQL plus validated frozen request/result evidence. Use a cursor watermark so later source progress does not duplicate or skip rows within a page sequence; a fresh query sees newer evidence.
- [ ] Extend `RunListQuery` with created-after/created-before and referenced-material criteria; test combined filters and cursor binding in `test/run-store.test.ts`.
- [ ] Keep pagination capped at 200. Do not return whole reports, infer a lost-interest reason from departure, or expose a direct SQL/query language.
- [ ] Run `node --import tsx --test test/run-store.test.ts`; expect query, pagination, completeness, and cursor behavior tests to pass.
- [ ] Commit the read-only query path as `feat: query paginated run evidence`.

## Task 3: Resolve follow-on requests into exact frozen contexts

**Files:**
- Modify: `src/application/run-inspection.ts`
- Modify: `src/domain/run/request.ts`
- Modify: `src/infrastructure/run-store.ts`
- Modify: `src/domain/decision/prompt.ts` only if a reusable pure context transformation belongs there
- Test: `test/run-service.test.ts`, `test/run-store.test.ts`

**Interfaces:**
- Consumes: Task 1 follow-on contract and Task 2 query selector semantics.
- Produces: shared follow-on resolution used by `run_inspect` and `run_start`, plus prepared frozen follow-on inputs. The resolved selection carries exact source references and copied respondent profile/material/packet state. `recorded` replaces only the question; `fresh-material` requires new material and uses the saved perspective plus that material with empty history; `omit-history` retains only the selected context's currently encountered material while removing trajectory and earlier exposure/order history; `continue` retains the exact selected context and prior typed answers, adds only explicitly supplied next material, and asks the explicitly supplied next question. Multiple selected turns for one respondent are allowed and remain distinguishable by evaluation/context ID.

- [ ] Test exact packet equality for `recorded`, separate respondent state, fresh-material with no history, omit-history without earlier exposure/order metadata, and continuation including only explicitly retained history.
- [ ] Test query criteria and explicit references resolve to identical frozen selections when they identify the same evaluations; missing source/evaluation/context IDs fail with actionable errors.
- [ ] Test request inspection performs no writes or inference, reports current matches and source completeness, and fit-checks the exact packets that a start would use.
- [ ] Implement resolution for both poll and journey source packets. Persist a self-contained resolved input snapshot with the accepted follow-on; preserve source run/evaluation/context lineage separately from the respondent-visible packet.
- [ ] Before accept, re-resolve criteria inside the acceptance transaction and compare the exact selected references and packet fingerprints used for fit. If source progress changes that set, return `source_changed_during_acceptance`; do not accept stale work. Once accepted, retrying the same submission returns its original frozen run without resolving again.
- [ ] Preserve original provider route, model/endpoint identity, call ceiling, and existing worker/recovery rules. Provider calls stay outside SQLite transactions.
- [ ] Run `node --import tsx --test test/run-service.test.ts test/run-store.test.ts`; expect all resolver, fit-inspection, frozen selection, and atomic acceptance tests to pass.
- [ ] Commit context resolution and frozen follow-on preparation as `feat: prepare reusable respondent contexts`.

## Task 4: Retain follow-ons across source deletion and expose MCP tools

**Files:**
- Modify: `src/application/run-service.ts`
- Modify: `src/infrastructure/run-store.ts`
- Modify: `src/entrypoints/mcp.ts`
- Modify: `test/mcp.test.ts`, `test/run-service.test.ts`, `test/run-store.test.ts`

**Interfaces:**
- Consumes: Task 2 query and Task 3 resolution/acceptance.
- Produces: MCP `run_query` tool; `run_inspect`/`run_start` accept a follow-on request; `run_get` reports a follow-on's frozen inputs and lineage. Deletion preview reports retained dependent follow-ons and their snapshot-backed status.

- [ ] Add MCP behavior tests for machine-readable query evidence, progressing-source caveat, query pagination, explicit reference reuse, criteria-based follow-on, context variants, and actionable invalid references.
- [ ] Add store tests proving source deletion retains follow-on request, answers, snapshots, and historical lineage; deleted source IDs are labeled as historical and never reported as live resolvable records.
- [ ] Add transaction tests for deletion preview, revalidation, dependent follow-on preservation, and all-or-none deletion/integrity behavior.
- [ ] Register strict MCP schemas and descriptions. Keep results JSON-shaped; never add narrative relevance conclusions. Discovery/query never starts or resumes work.
- [ ] Bump the pre-v1 schema version and return the existing explicit export/reset guidance for older stores; do not add migrations.
- [ ] Run `node --import tsx --test test/mcp.test.ts test/run-service.test.ts test/run-store.test.ts`; expect query/follow-on MCP behavior and deletion invariants to pass.
- [ ] Commit the run service, MCP, and persistence integration as `feat: expose follow-on run operations`.

## Task 5: Teach the agent workflow, package it, and close out the plan

**Files:**
- Modify: `skills/stimulus-response-polling/SKILL.md`, `skills/stimulus-response-polling/references/run-and-recovery.md`, and `test/stimulus-response.test.ts`
- Modify: `README.md` only where user setup/API behavior requires it
- Regenerate: `dist/` through the repository's canonical build
- Modify: `.agents/plans/v0.3.0/roadmap.md`
- Modify: `docs/decisions/README.md` and add one ADR only if implementation establishes a consequential durable contract

- [ ] Teach agents how to query explicit evidence, distinguish typed reasons from routes/departures, assess source completeness, select references, choose context mode, and interpret lineage without treating Sheg as the relevance judge.
- [ ] Add a behavior-level packaged MCP test that starts a journey with a typed lost-interest response and terminal departure, queries the qualifying respondents, starts a follow-on at their saved section-three context, deletes the source, and retrieves the follow-on's exact evidence. Use local fixtures only.
- [ ] Run `npm run build`, then `node --import tsx --test test/package.test.ts test/stimulus-response.test.ts`; expect the copied distributable workflow, shipped-skill checks, and generated contracts to pass.
- [ ] Run focused tests, then stage intended authored/generated files and commit through the tracked hook, which runs `npm run verify` on the staged snapshot. Do not bypass the hook or repeat its successful full gate immediately afterward.
- [ ] Commit guidance, packaged acceptance, and roadmap evidence as `docs: teach agents to query and reuse run evidence`.
- [ ] Review final diff against SHEG-7 and epic sections 4, 5, 9, and 11; update roadmap with commit/head, validation, and remaining release work. Keep SHEG-7 open if any acceptance remains for a later JIT plan; do not prematurely mark later roadmap rows complete.
- [ ] Record completion evidence and remaining limitations. No release publication, version bump, tag, merge, or paid provider call.
