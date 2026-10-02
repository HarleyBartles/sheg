# Source-Linked Material Choices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent can offer exact authored material candidates as Choice options, query the candidate each respondent selected, and use its material ID and original respondent context in a follow-on request.

**Architecture:** Keep Choice, Score, and Noul semantics unchanged. Add an explicit option-to-material mapping to Choice and source identity/digest metadata to bounded material items. Freeze the mapping with each evaluation; return the selected exact material as a machine-readable query handle; snapshot material provenance in follow-on lineage so source-run deletion does not break later work. Keep provenance and mapping metadata out of respondent-visible state.

**Tech Stack:** TypeScript, Zod, SQLite (`node:sqlite`), MCP SDK, Node test runner, packaged Codex plugin.

**Spec:** `.agents/specs/2026-10-01-v0.3.0-epic-spec.md`, especially sections 3, 5, 7, 9, 10, 11, and 12; Linear issue SHEG-8 and the linked v0.3.0 agreed design. **Status:** completed-awaiting-retirement. Whole-branch review package prepared for Plan 7; inline review found no Critical or Important issue. An independent reviewer was not dispatched because this execution is explicitly inline.

**Execution Strategy:** Inline `executing-plans`, as directed by the active goal. The reference shape crosses request validation, frozen decision packets, result queries, follow-on lineage, and packaged agent guidance. Those contracts depend on one another, so one implementation context and sequential behavior tests reduce drift; independent task delegation would duplicate the shared data-flow reasoning.

## User-Visible Contract

- An agent supplies each candidate as an exact bounded material item with a stable material ID and authored source identity plus SHA-256 digest.
- A Choice question may explicitly map an option ID to a material ID. The mapped option's visible text must equal that material item's exact text. Any ordinary option, including a no-fit option, may remain unlinked.
- An answer keeps its normal typed Choice value and distribution. Querying a mapped selection adds `selectedMaterial` containing the material ID, exact text, source identity/digest, and a Sheg-computed SHA-256 digest of the selected text.
- The agent can use the returned evaluation/context handles and selected material ID in an existing follow-on request. The follow-on keeps its own exact material and source snapshot in lineage even after the source run is deleted.
- Sheg does not find candidates, infer boundaries, rewrite material, judge relevance, or add a new response primitive. It validates the authored links and preserves them.
- `sourceId` and `sourceSha256` are provenance supplied by the author; Sheg validates their shape and preserves them but does not fetch source content or assert that the supplied digest matches an external source. Sheg separately computes the digest of the exact candidate text it returns.

## Global Constraints

- Preserve authored text byte-for-byte as a JavaScript string. Do not trim, normalize, summarize, or silently replace a candidate.
- Material IDs and option IDs stay distinct concepts. Only explicit `materialOptions` links identify a Choice answer as a material selection.
- A material mapping is valid only if its option exists, its material exists in the accepted request's frozen material catalog, its visible label equals the exact material text, and the candidate has valid source identity/digest metadata. Candidate catalog membership does not imply respondent exposure. Reject invalid links during inspection before inference.
- Provenance and link metadata stay outside `PromptState` and provider-visible request content. Provider requests receive only the authored Choice instructions/options and current respondent state.
- A no-fit choice remains a normal typed Choice answer and has no selected material reference unless the author explicitly links it.
- Selection provenance is not causal evidence or access to model reasoning. Agent-authored boundaries and relevance decisions remain the agent's responsibility.
- Preserve Sheg's pre-v1 reset/no-migration policy, physical-attempt accounting, explicit follow-on context modes, and deletion integrity.
- Do not add source parsing, candidate-generation tools, paragraph defaults, free-form answers, arbitrary numeric answers, or changes to Score/Noul/journey semantics.
- No live work may include real user content. Paid pilot requests use only fictional synthetic text and `maxCalls: 1`.

## Review Focus

Verify the full reference chain from authored candidate through mapped Choice, query projection, and follow-on material selection. Pay particular attention to the separation between the frozen catalog and respondent exposure, source deletion with retained lineage, no-fit behavior, exact text preservation, and the boundary between author-supplied source metadata and Sheg-computed candidate text digest.

## Task 1: Add explicit material origins and Choice links

**Files:**
- Modify: `src/domain/study/stimulus.ts`, `src/domain/study/task.ts`, `src/domain/study/arm.ts`, `src/domain/decision/decision.ts`, `src/domain/decision/prompt.ts`, `src/domain/run/request.ts`, `src/application/run-inspection.ts`
- Test: `test/run-request.test.ts`, `test/run-inspection.test.ts`, `test/decision.test.ts`, `test/journey.test.ts`

**Interfaces:**
- A bounded material item may carry `{ sourceId, sourceSha256 }`; source IDs use the existing stable identifier form and digests are 64-character hexadecimal SHA-256 values. The material item's stable ID and exact text are the authored candidate boundary.
- A Choice question may carry `materialOptions: Record<optionId, materialId>`. Mappings are optional, may cover only some options, and may not map multiple options to one material.
- Inspection resolves each mapped material against the frozen request catalog, whether or not the respondent encountered it, rejects missing or unprovenanced candidates and labels that differ from exact candidate text, and does not include mapping/provenance metadata in `PromptState` or provider-visible wire questions. Support the same explicit mapping in direct poll questions and journey Choice tasks.

- [x] Add failing domain/request tests for exact material IDs, source metadata, mapped Choice options, unlinked no-fit options, missing/duplicate references, malformed digests, and label/text mismatch.
- [x] Add inspection tests proving a candidate link resolves from the frozen catalog even when not encountered, and fails before provider inference when missing or out of scope. Cover direct poll and journey Choice mappings.
- [x] Implement schemas and cross-reference validation. Preserve all existing Choice/Score/Noul semantics.
- [x] Verify Jev and Laya wire builders send only Choice options/instructions and never source identity, digest, or mapping metadata. Add a provider behavior assertion for the actual outgoing payload.
- [x] Run `node --import tsx --test test/run-request.test.ts test/run-inspection.test.ts test/decision.test.ts test/jev.test.ts test/laya.test.ts test/journey.test.ts`.

## Task 2: Return selected material evidence and preserve it through follow-ons

**Files:**
- Modify: `src/domain/run/request.ts`, `src/infrastructure/run-store.ts`, `src/application/run-inspection.ts`
- Test: `test/run-store.test.ts`, `test/run-service.test.ts`, `test/run-inspection.test.ts`

**Interfaces:**
- A matching Choice result adds an optional `selectedMaterial` projection to `run_query` evidence: exact `materialId`, `text`, `sourceId`, `sourceSha256`, and a Sheg-computed UTF-8 text digest. Unmapped answers have no such projection. The projection is derived from the immutable request/packet evidence, not respondent prompt state.
- Existing `context.materialIds` consumes the returned material ID together with existing `{ evaluationId, contextId }` selection references; the exact frozen context is selected independently from the material.
- Frozen follow-on lineage retains exact material snapshots and source metadata for selectable material IDs in each accepted respondent/context, outside provider-visible packet state, so offered-but-unencountered candidates and multi-run reuse still work after deletion of the original run. Resolve catalogs from poll material, journey items, follow-on inline material, and retained lineage snapshots.

- [x] Add store/service tests proving a mapped answer returns exactly its authored material, source metadata, and computed text digest; an unlinked choice returns no material projection.
- [x] Add a follow-on test that selects an offered-but-unencountered material ID, preserves the exact material in the accepted request/lineage, deletes the source run, and still retrieves the frozen source/material lineage from the follow-on.
- [x] Add a multi-hop test showing retained follow-on material can be referenced by another follow-on after the original source is gone, without copying provenance into `PromptState`.
- [x] Implement the derived query projection and immutable lineage snapshot. Keep lineage outside respondent-visible state and retain correct behavior for old runs with no material links.
- [x] Run `node --import tsx --test test/run-store.test.ts test/run-service.test.ts test/run-inspection.test.ts`.

## Task 3: Teach agents when and how to use selected material

**Files:**
- Modify: `src/entrypoints/mcp.ts`, `README.md`, `skills/study-design/SKILL.md`, `skills/stimulus-response-polling/SKILL.md`, `skills/stimulus-response-polling/references/run-and-recovery.md`, `skills/study-design/references/primitives-and-tools.md`, `skills/stimulus-response-polling/references/interpret-results.md`, `docs/decisions/README.md`
- Create: `docs/decisions/0022-source-linked-material-choices.md`
- Regenerate: request contract assets and packaged `dist/` from canonical sources
- Test: `test/mcp.test.ts`, `test/package.test.ts`

**Interfaces:**
- MCP descriptions explain that a mapped Choice answer returns a selected material reference suitable for `context.materialIds`; query still returns normal typed Choice evidence and denominators.
- Agent guidance distinguishes selecting among authored material candidates (Choice), an authored ordered position/severity judgment (Score), and recording a staged threshold crossing through an authored journey. It says to include a no-fit option when the question needs one, and that the agent authors exact candidate boundaries.
- ADR-0022 records the explicit Choice-to-material identity link and the provenance boundary; index it in the same change.

- [x] Add an MCP behavior test showing query evidence contains an input-compatible selected material reference and that an explicitly constructed follow-on uses it.
- [x] Update study-design and polling skills with a short use pattern and a distinction among Choice selection, Score ordering, and staged journeys. Do not tell the agent to run a broader study when a direct Choice answers the user's question.
- [x] Update MCP descriptions and README with the exact output/input fields and no-fit behavior.
- [x] Add ADR-0022 and update the decision index.
- [x] Run `npm run contracts:build` and `npm run build`; inspect generated schema/package outputs.

## Task 4: Verify the installed-package selection-to-follow-on path

**Files:**
- Modify: `test/package.test.ts`

**Interfaces:**
- The copied packaged MCP runs a synthetic source-linked candidate request on the local fixture provider, queries one selected option, starts a follow-on from the exact evaluation/context/material handles, deletes the source run, and retrieves the retained material evidence from the follow-on. Candidate text remains in the frozen catalog but is not duplicated into the respondent's encountered-item state unless the journey actually exposes it.
- The test uses no network, no real user content, and no checkout or local dependency directory at runtime.

- [x] Add the copied-package behavior test against the actual MCP tool contract, including a no-fit option that remains unlinked and a selected option that resolves to one exact candidate.
- [x] Assert exact option-to-material linkage, stable selected ID, exact text, source identity/digest, same respondent context, no candidate metadata in respondent/provider state, and retained follow-on evidence after source deletion.
- [x] Run `node --import tsx --test test/mcp.test.ts test/package.test.ts test/study-loader.test.ts test/stimulus-response.test.ts`.

## Task 5: Verify the real Jev wire path and close the implementation slice

**Files:**
- Modify: `src/domain/decision/prompt.ts`, `test/run-inspection.test.ts`, this plan, and the v0.3.0 roadmap
- Regenerate: packaged `dist/` from canonical sources
- Inspect: all Task 1-4 changes, `docs/providers/jev.md`, generated contracts and copied plugin

- [x] Run the bounded synthetic OpenRouter pilot after fit inspection with one respondent, two offered candidate excerpts, one unlinked no-fit option, one mapped Choice question, and `maxCalls: 1`. The final confirming request used one physical attempt and returned Choice `setup-excerpt` linked to `candidate-setup`; exact text and source provenance matched, and the respondent state contained no source metadata. Two pre-fix packaged-runtime pilots used one physical attempt each and returned Choice `benefit-excerpt` linked to `candidate-benefit`, while exposing source metadata in direct-poll state; this drove the compiler-boundary correction below. The first pilot's attempt count and answer were not captured before its helper hit a local cleanup error.
- [x] Use an isolated temporary `SHEG_DATA_DIR`; delete each pilot run through `run_delete` and verify `run_storage.integrity` is `ok` with zero runs remaining.
- [x] Attempt temporary-directory cleanup only after Sheg deletion/integrity succeeds. Windows safety blocked both recursive cleanup and a narrower exact-file removal even after confirming the MCP process exited; readback shows only the verified zero-run SQLite database remains. Record this empty OS-temp residue as an environment exception and do not retry through another deletion surface.
- [x] Record the final pilot's route, physical request count, typed answer/selection IDs, metadata-boundary result, and deletion/integrity outcome. Never print credentials or provider headers.
- [x] Fix the direct-poll provenance leak at the shared prompt compiler boundary. Keep source fields in the durable request/catalog, but whitelist only material ID and exact text in respondent-facing state.
- [x] Add a failing behavior test for direct-poll state provenance, then verify the Jev/Laya provider path and copied-package tests.
- [x] Run the focused behavior set from Tasks 1-4 and `npm run verify`; the tracked hook remains authoritative for the staged snapshot.
- [x] Run `git diff --check`; stage only intended source, tests, skill/docs, ADR, plan, roadmap, and generated outputs; commit through the tracked hook as `fix: exclude source provenance from respondent state`.

## Task 6: Review SHEG-8 and record the next JIT boundary

**Files:**
- Modify: `.agents/plans/v0.3.0/06-source-linked-material-choices.md`, `.agents/plans/v0.3.0/roadmap.md`
- Inspect: approved epic spec sections 5, 7, 9, 10, 11, and 12; full SHEG-8 and linked design; all changed files, generated contract, and copied package

- [x] Review source-to-choice-to-query-to-follow-on behavior, exact text/digest preservation, no-fit handling, respondent-local context selection, privacy of provider-visible state, retained lineage after source deletion, and no change to existing typed response semantics.
- [x] Record focused test commands, the actual OpenRouter pilot outcome, the full verification result, and implementation commits here and in the roadmap.
- [x] Mark Plan 6 `completed-awaiting-retirement` only after all agent-owned work passes. Keep SHEG-8 open until the release integration and eventual PR merge are verified.
- [x] Confirm Plan 7 is the next JIT capability: complete packaged section-three acceptance, final issue/project reconciliation, and prepare the whole implementation as the user-requested Draft PR. Do not change product version fields, tag, or publish a release before its release-preparation step.
- [x] Record any technical correction to this plan as an evidence-backed `Ruling` before implementation continues.

**Evidence:** Focused source-linked behavior set passed 96 tests. The bounded final OpenRouter confirmation used one physical attempt and returned exact `setup-excerpt` evidence for `candidate-setup`; it showed no source metadata in respondent state, and deletion plus storage integrity succeeded with zero runs. `npm run verify` passed 310 tests, lint, typecheck, and generated consistency; the commit hook repeated the staged gate. Commits: `fce1524`, `faabf39`, `e484226`, `7c31b2e`, `83d1c8a`. The temporary OS directory still contains only the verified zero-run SQLite file because the safety layer rejected exact cleanup; Sheg-level run deletion and integrity are verified.

**Review:** Prepared the full branch diff from `origin/develop` (`3c5b2f0`) through `83d1c8a`. Reviewed the user-visible reference chain and provider-state boundary against the accepted spec and SHEG-8. No Critical or Important issue found. An independent reviewer was not dispatched under the inline execution constraint. The whole-branch `git diff --check` identified extra EOF blank lines in two new source files (`question-worker.ts`, `run-service.ts`); Plan 7 removed them in commit `b9824f8`.

**Ruling:** The direct-poll provenance correction belongs at the shared `compileDecisionRequest` boundary. Runtime structural typing allowed extra source fields through the direct-poll caller even though journey/follow-on callers projected them; selecting only `{ id, text }` prevents this leak for every caller. Evidence: the new direct-poll behavior test failed before the fix and passed after it, and the final bounded Jev packet inspection confirmed no source metadata. Cost if wrong: source provenance would alter respondent-visible state and reach the provider.

## Plan 6 boundary

This slice provides exact authored candidate identity, Choice-result linkage, and follow-on reuse. It does not implement automated candidate generation, paragraph/section parsing, a source-file crawler, a universal text-span normalizer, Score-position calibration, causal claims, new respondent-visible metadata, or the final section-three release demonstration. Plan 7 owns the combined release acceptance and whole-branch Draft PR handoff.
