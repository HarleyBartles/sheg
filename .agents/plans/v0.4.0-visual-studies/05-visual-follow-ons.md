# Visual Follow-ons and Comparison Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a visual source run safely composable into later studies with exact retained context, explicit pixel reuse, typed visual Choice links, durable image custody, and denominator-complete evidence.

**Architecture:** Extend the existing follow-on request, source resolver, packet compiler, frozen lineage, and evidence readers. A follow-on freezes exact source evaluation/context handles, selected source material and images, and its projection at acceptance. Text descriptions remain compact history; image bytes are attached only when a follow-on question explicitly binds the saved image in pixel mode. The current schema-14 tables and `run_visual_assets` references already pin assets per accepted run; extend the established transaction and payload-codec owners without changing released migrations unless a demonstrated table-level gap requires it.

**Tech Stack:** TypeScript, Zod, SQLite JSON payloads, Drizzle repositories, Node test runner, generated MCP/CLI contracts, copied self-contained plugin.

**Spec:** `.agents/specs/2026-10-04-v0.4.0-visual-studies.md`, sections 4-6 and 8-10, acceptance criteria 5, 7-10, 13 and 15. **Roadmap:** `roadmap.md`, Plan 5.

**Execution Strategy:** `executing-plans` with Native inline execution because follow-on schemas, source selection, packet projection, persisted lineage, asset custody and evidence readers share one snapshot boundary; a single executor can preserve exact compatibility through those coupled contracts, followed by one fresh whole-branch review.

## Global Constraints

- Preserve schema-9 and all already released request, lineage, compiler and attempt evidence. Add no migration unless a demonstrated relational custody gap cannot be met by the existing lineage and asset references.
- Preserve current `recorded`, `fresh-material`, `omit-history`, `continue`, and selected text Choice-material behavior. A missing retained-material subset preserves the established default; an explicitly supplied empty subset means no prior material is retained.
- Keep selected-source-answer inclusion independent from retained material. Continue mode preserves the existing default of appending the selected source answer, with an explicit control to omit that answer; the source packet's already-frozen earlier trajectory stays intact and sibling answers never enter.
- Keep encountered image descriptions, exact captions and typed reactions as compact text history. Image pixels are resent only when the follow-on question explicitly binds that image in `visual.mode: "pixels"`; `described` mode remains text evidence.
- A mapped image Choice is an image reference with its authored descriptor/caption and digest. It must never be coerced into text `selectedMaterial` evidence or exposed as pixel bytes in ordinary query output.
- Resolve source material by exact context lineage; reject missing, unexposed, ambiguous, conflicting or sibling material. Preserve encountered order for retained materials and explicit authored order for newly supplied material.
- Retain accepted asset dependencies after source run deletion and release them only when every dependent run and image derivation is deleted. Verify this through public store operations and foreign-key/integrity checks.
- Preserve matched-pair evidence as observed condition outcomes plus complete/incomplete denominators, provider/model identity, and source selection lineage. Never impute missing responses, convert incomplete pairs to ties, combine provider confidence scales, or claim independent human observations.
- Generate schemas, runtime bundles and skill packages from canonical source. No repo-local path or test fixture becomes a runtime dependency.
- Propose `0.4.0-dev.8` for the eventual integration PR only after checking uniqueness on refreshed `origin/develop`; rebuild all derived identities.

## Review Focus

- An explicit empty retained subset must remove all prior encountered text while keeping profile and only the explicitly selected answer history; it must pass fit and compile to an empty encountered-item list.
- A visual Choice mapped to an image must return exact material identity, digest, supplied alt text and caption for agent-authored follow-on reuse while remaining distinct from text selected-material evidence.
- Pixel reuse from a source visual question must resolve its frozen image after original-file removal, must not attach sibling/unselected pixels, and must be retained after source-run deletion.
- A mapped image absent from the selected context or a digest/metadata mismatch must refuse acceptance before writing a partial run or dispatching a provider call.
- Follow-on denominators must distinguish matched source evaluations, represented respondents, excluded visual selections, and launched follow-on evaluations; incomplete fork pairs remain incomplete and retain the successful counterpart/provider evidence.

## Current Code Seams

`src/domain/run/request.ts` owns `followOnContextSchema`, `followOnLineageSchema`, `FollowOnSourceTurn`, and the stored typed source/evidence shapes. `src/domain/decision/prompt.ts` owns `prepareFollowOnPacket` and compact trajectory composition. `src/application/run-inspection.ts` resolves follow-on groupings, context projections, visual bindings, provider fit and lineage. `src/infrastructure/sqlite/follow-on-queries.ts` loads bounded exact source turns; `evidence-records.ts` resolves context catalogs; `evidence-query.ts` owns result and coverage projection; `commands/prepared-validation.ts` and `commands/acceptance.ts` validate and pin accepted assets; `run-deletion-queries.ts` and `commands/recovery.ts` own source-deletion dependency checks. `test/run-store.test.ts`, `test/prompt.test.ts`, `test/run-inspection.test.ts`, `test/mcp.test.ts`, and `test/package.test.ts` own these existing behaviors. Canonical shipped instructions live in `skills/stimulus-response-polling/` and `skills/study-design/`; human operational detail lives in `docs/providers/clef.md` and `docs/guides/image-preparation.md`.

---

## Task 1: Add an Explicit Continue-Material Projection

**Files:** Modify `src/domain/run/request.ts`, `src/domain/decision/prompt.ts`, and `src/application/run-inspection.ts`; extend `test/prompts.test.ts` and `test/run-store.test.ts`; regenerate request schemas and built runtime from canonical source.

**Consumes:** Existing follow-on `context.mode`, exact selected source packet and profile, `prepareFollowOnPacket`, source material catalog and text `materialIds` behavior.

**Produces:** Optional `context.retainedMaterialIds`, valid only for `continue`, permitting an explicit empty array. Omission preserves all source packet encountered text as today. When present, the compiler retains only listed source-context materials, in source encounter order, and does not treat image material IDs as text items. `context.includeSelectedAnswer` independently controls appending the selected source answer; omission preserves today's inclusion. Existing `context.materialIds` remains the separate additive selection from the source material catalog; both may be used together, with duplicate IDs rejected.

- [x] Add `includeSelectedAnswer: boolean` (optional) to follow-on context so selected-answer visibility is independent of retained-material projection; omitted preserves current mode semantics. Permit it only for continue mode.
- [x] Add `retainedMaterialIds: string[]` (optional, uniqueness enforced but no minimum) for continue mode only. It filters previously encountered items; `materialIds` continues to add references from the source material catalog. Reject duplicate IDs across the two fields.
- [x] Extend `prepareFollowOnPacket` with a resolved `retainedMaterial` projection and an explicit selected-answer flag. Continue mode must keep the source profile and existing trajectory, append retained text in source encounter order, and append exactly the selected source answer only when requested. It must never carry image pixels through `PromptState`.
- [x] In `prepareFollowOnRun`, resolve every requested retained ID against the exact selected source turn's catalog; reject IDs absent from that context and preserve source order even when request order differs. Explicit empty input must produce no encountered items.
- [x] Add packet-level coverage in `test/prompts.test.ts` and store-level tests named `continue follow-on can explicitly retain no prior material while including the selected answer` and `continue follow-on retains only an ordered source-context subset independently of selected-answer inclusion` to `test/run-store.test.ts`. Run `node --import tsx --test test/prompts.test.ts test/run-store.test.ts` and confirm each new assertion fails before implementation because the input schema or compiled packet rejects/retains the wrong projection.
- [x] Implement the schema and projection, then rerun the focused tests. Assert the actual frozen packet state, trajectory response count and exact item order, not helper arguments or source code shape.
- [x] Run `npm run contracts:build`, `npm run build`, and the focused suite; confirm generated schema/plugin changes are derived from the source and the prior text follow-on tests still pass.

## Task 2: Preserve Typed Visual Choice References

**Files:** Modify `src/domain/run/request.ts`, `src/infrastructure/sqlite/follow-on-queries.ts`, `src/infrastructure/sqlite/evidence-query.ts`, `src/infrastructure/sqlite/evidence-records.ts`, `src/infrastructure/sqlite/commands/prepared-validation.ts`, and `src/application/run-inspection.ts`; extend `test/visual-acceptance.test.ts`, `test/mcp.test.ts`, `test/run-store.test.ts`, and schemas. `src/domain/run/lifecycle.ts` re-exports the request-owned evidence contracts, so no local type change is needed there.

**Consumes:** Existing mapped Choice material resolution, context-scoped material catalog, image metadata schemas, query `selectedMaterial`, visual question binding, and Task 1 follow-on context contract.

**Produces:** `selectedVisualMaterial` evidence with material ID, exact asset ID/SHA-256, authored alt text and optional caption, with no bytes. Follow-on lineage can freeze this evidence and make it reusable through existing ordered `materialIds` plus explicit pixel bindings. Text `selectedMaterial` stays text-only.

- [x] Add a strict `selectedVisualMaterial` evidence schema to query items and follow-on source turns. Include image material ID, digest-bound asset metadata, alt text, and optional exact caption; exclude bytes and local paths.
- [x] Update `evidence-query.ts` to return this field only when an answered Choice maps its selected option to an image available in that exact packet/catalog. Keep `selectedMaterial` absent for image selections. Add separate text/image selected-material coverage counts while preserving the existing `selectedMaterials` shape for old consumers.
- [x] Update `follow-on-queries.ts` to resolve mapped image selections through `materialCatalogForRequest` and validate their saved asset metadata; malformed or absent mapped image evidence is a bounded `data_integrity_error`.
- [x] Extend follow-on lineage selection records with optional `selectedVisualMaterial`, preserving parse compatibility for historical records. `includeSelectedMaterial` includes mapped text or image options from authored Choice questions; unresolved mapped images fail as data-integrity errors.
- [x] Add the named store-level test. Assert exact returned metadata, no `selectedMaterial`, no image bytes in query output, a follow-on packet with only the explicitly bound image bytes resolved at dispatch, and a digest-identical lineage snapshot.
- [x] Run the focused store/MCP tests and witness the test fail before adding production code. Use the existing real SQLite image asset repository and injected provider recording the actual request packet; do not mock material lookup. The test exposed missing query evidence and, with a typed Noul follow-on, a validator omission of pixel-bound visual dependencies.
- [x] Update `prepared-validation.ts` to cross-check visual selection lineage against the frozen recipient packet, source catalog, material snapshot and visual binding. Reject metadata substitution and preserve recipient-specific material snapshots.
- [x] Regenerate contract schemas and run focused tests. Confirm historical lineage fixtures without `selectedVisualMaterial` still decode and remain readable. `npm run verify`: 596 passed, 1 Windows symlink capability skip.

## Task 3: Freeze Exact Follow-on Asset and Context Dependencies

**Files:** Modify `src/application/run-inspection.ts`, `src/infrastructure/sqlite/commands/acceptance.ts`, `src/infrastructure/sqlite/evidence-records.ts`, `src/infrastructure/sqlite/follow-on-queries.ts`, `src/infrastructure/sqlite/commands/prepared-validation.ts`, `src/infrastructure/sqlite/run-deletion-queries.ts`, and tests in `test/run-store.test.ts`.

**Consumes:** Task 1 context projection, Task 2 visual references, accepted `run_visual_assets`, image derivation foreign keys, run lineage snapshots and current source-deletion preview.

**Produces:** Every accepted follow-on has enough exact source, asset, and material lineage to remain inspectable and executable after source-run deletion; image assets remain referenced by the follow-on transaction only when that follow-on actually needs them.

- [ ] Trace the existing deletion preview and foreign-key behavior with a source visual run plus an accepted follow-on. Record the observed gap before editing: whether the preview reports the retained child and whether its image bytes remain resolvable after source deletion.
- [ ] Add a failure-first integration test named `accepted visual follow-on retains its selected source image after deleting the source run`. Use imported bytes, start/complete the source through the public store, accept an explicitly pixel-bound child, delete the source, then load and prepare the child solely from its persisted request/lineage and retained asset references.
- [ ] Assert the source deletion preview lists the retained child and that `PRAGMA foreign_key_check` passes after deleting the source. The repository has no public image garbage-collection operation, so do not add one in this plan.
- [ ] If current transactional `run_visual_assets` pinning passes both behaviors, do not change SQL tables or add a migration. If it fails, make the narrowest change within the acceptance transaction and deletion snapshot owners, then prove rollback on a forced insertion/dependency failure.
- [ ] Validate the frozen follow-on source version again at acceptance; source changes between inspect and accept must reject with no run, group, evaluation, or visual-asset rows written.
- [ ] Preserve image order and question-scoped binding through storage and resume. Test a selected image alongside an unrelated source image and prove only the explicitly bound image enters the provider request.
- [ ] Run `node --import tsx --test test/run-store.test.ts test/image-assets.test.ts` and verify legacy text follow-on deletion behavior remains unchanged.

## Task 4: Make Selection and Pair Denominators Explicit

**Files:** Modify `src/domain/run/request.ts`, `src/domain/run/lifecycle.ts`, `src/application/run-inspection.ts`, `src/infrastructure/sqlite/follow-on-queries.ts`, `src/infrastructure/sqlite/evidence-query.ts`, and `test/run-store.test.ts` only where a demonstrated evidence gap exists.

**Consumes:** Exact source turn matches, Plan 4 `JourneyComparisonEvidence`, source selection lineage, selected text/image material evidence and existing result/query views.

**Produces:** Optional additive `lineage.sourceSelection` v1 evidence with `matchedEvaluations`, `includedEvaluations`, `representedContexts`, `representedRespondents`, and `followOnEvaluations`. It describes the frozen selection operation; `excludedSelections` retains exact filtered rows. Matched-branch reports keep complete/incomplete pair denominators and each condition's own typed result, failure and provider evidence.

- [ ] Add a test fixture with two respondents at a two-condition fork, one incomplete pair with a successful counterpart, and a follow-on selected from one answered branch; assert the fork retains its full reached denominator and the child lineage identifies the selected survivor and exact source evaluation/context handles.
- [ ] Add a test that includes a mapped image choice and an unmapped choice in the follow-on selection, then assert matched, included, excluded, distinct respondent and visual/text selected-material counts account for the source rows without double-counting.
- [ ] Inspect the exact existing `JourneyComparisonEvidence` and `run_query` output before changing reporting. Preserve its complete/incomplete pair counts and per-member `result`, `failure`, `providerSelection`, and `execution`; do not add a second aggregate of paired score/confidence values.
- [ ] Add optional `sourceSelection: { version: 1, matchedEvaluations, includedEvaluations, representedContexts, representedRespondents, followOnEvaluations }` to `FollowOnLineage`. Compute it from the loaded source turns, included turn list, resulting unique context/respondent IDs, and prepared evaluations. Do not infer run-wide unmatched respondents from a filtered query. Keep old `selectionCoverage` and records without `sourceSelection` readable.
- [ ] Extend `prepared-validation.ts` to recompute and reject a mismatched `sourceSelection` from lineage selections and child evaluations. Prove a forged count fails before `insertAcceptedRun` writes a child record.
- [ ] Run the store test first and confirm that each added assertion fails for a missing/incorrect denominator or lineage field. Implement at the domain and evidence-read owners, not in MCP or CLI serializers.
- [ ] Reopen the datastore and read both historical text lineage and new image lineage. Confirm any incomplete pair remains labeled incomplete, missing responses stay absent, and provider confidence fields remain attached only to their own evaluation.

## Task 5: Teach and Qualify Visual Follow-on Workflows

**Files:** Modify canonical `skills/stimulus-response-polling/SKILL.md`, its relevant references and behavior fixtures/tests under `skills/stimulus-response-polling/tests/`, plus `docs/providers/clef.md` and `docs/guides/image-preparation.md`; regenerate packaged skills/schemas and extend `test/package.test.ts`.

**Consumes:** Stable follow-on request and evidence contracts from Tasks 1-4, existing skill-owned study-design workflow, image preparation, native Clef, and run/recovery guides.

**Produces:** An installed agent recipe that selects exact source evaluation/context handles; chooses recorded or continue; independently sets retained material and answer visibility; exposes image descriptors/captions/typed reactions as compact history; resends pixels only through explicit question bindings; compares complete and incomplete pairs with correct denominators; and describes model evidence as correlated judgments.

- [ ] Add a behavioral fixture named `visual-follow-on-context-projection` under the existing skill workflow fixtures. The scripted turns require the agent to inspect a mapped image Choice result, distinguish it from text `selectedMaterial`, select a retained subset (including empty where appropriate), explicitly bind pixels for Clef reuse, inspect the exact request, and report incomplete-pair denominators without calling them ties.
- [ ] Add an executable skill behavior test that rejects a workflow which reuses an image through text selection, sends unbound sibling pixels, includes sibling answers, or reports an incomplete pair as a preference. Prove the test fails when the behavior fixture is deliberately changed to omit the explicit image binding, then restore the fixture and confirm it passes.
- [ ] Update the existing follow-on section and tool table rather than adding a parallel high-level recipe. Link provider limits to the Clef guide and human image custody to the image-preparation guide. Keep README unchanged because no first-use task is being added.
- [ ] Extend `test/package.test.ts` to copy the built plugin to an unrelated temp location, run a visual Choice source plus image follow-on through the shipped MCP, delete the source run, reconnect using CLI/MCP as appropriate, and verify the child request, evidence and asset are available without checkout files.
- [ ] Regenerate contracts and plugin using `npm run contracts:build`, `npm run build`, `npm run plugin:package -- --validate-only`, then run `npm run verify` and `node --import tsx --test test/package.test.ts`.

## Task 6: Final Contract Review and Plan Cursor

**Files:** Review all Plan 5 changes, generated projections, `.agents/plans/v0.4.0-visual-studies/roadmap.md`, and relevant source/documentation callers.

**Consumes:** Completed Tasks 1-5 and their focused RED/GREEN evidence.

**Produces:** An integrated Plan 5 implementation with exact follow-on semantics, compatible reads, complete-pair/survivor evidence and installed workflow, plus a roadmap cursor pointing to Plan 6.

- [ ] Inspect the final diff and trace every changed behavior from public CLI/MCP input through schema, service, persistence and result views. Verify source/asset snapshot checks happen inside the transaction and no inference call occurs before admission.
- [ ] Compare every Plan 5 requirement and approved acceptance criterion with its behavior test and runtime owner. Remove any unrelated feature or test that asserts only code shape.
- [ ] Update the roadmap: Plan 5 complete on the merged feature head, Plan 6 pending and JIT after Plan 5. Record only current status/links/ownership, not command receipts or narrative history.
- [ ] Run `npm run verify`, `npm run build`, `npm run contracts:build`, and `npm run plugin:package -- --validate-only`; run the required full Linux verification if the CI/container path is available. Report unavailable checks precisely.
- [ ] Check proposed `0.4.0-dev.8` against refreshed `origin/develop` and tags immediately before publication. If stale or duplicated, reallocate, rebuild, and rerun the complete gate.
- [ ] Commit the final Plan 5 tree, push the exact head, open a reviewable PR into `develop` using the repository's Sheg Agent GitHub workflow, verify required checks and exact merge tree, merge when green, fast-forward canonical `Z:\sheg\develop`, then delete only the verified merged Plan 5 branch and archive its clean worktree.

## Execution Handoff

Execute inline with Native `executing-plans` under the active user instruction to complete each JIT roadmap plan. The nearest alternative, subagent-driven development, adds fresh implementer/reviewer context per task, but these tasks deliberately cross the same source selection, packet snapshot, image pinning and evidence payloads; serial integration context and one final fresh whole-branch review are lower risk and avoid reconstructing mutable SQLite contracts at each handoff.
