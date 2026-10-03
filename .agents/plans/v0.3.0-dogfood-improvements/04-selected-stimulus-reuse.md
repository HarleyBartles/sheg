# Follow Each Selected Stimulus in One Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an author reuse each respondent's exact mapped Choice material in one isolated follow-on run, with shared material, explicit exclusions, and durable lineage.

**Architecture:** Add an explicit resolver flag to the strict follow-on request, resolve each source answer independently, and freeze its selected material and exclusion evidence into the existing prepared-run lineage. Preserve the current packet context modes when the new flag is absent, and regenerate the copied MCP package from authored source.

**Tech Stack:** TypeScript, Zod request/lineage schemas, SQLite run store, Node test runner, MCP stdio package, skill-owned JSON scenario harness.

**Spec:** [Agreed dogfood improvement scope](../../specs/2026-10-02-v0.3.0-dogfood-improvements.md), section 3.

**Execution Strategy:** `executing-plans` - request resolution, per-source packets, coverage, version-race checks, durable lineage, and copied-package behavior share state and must remain aligned in one implementation context. Independent task delegation would repeat source-contract reconstruction; a fresh whole-branch reviewer supplies the independent review.

## Global Constraints

- Resolve selected material only from an answered Choice's saved `materialOptions` mapping; do not infer or extract passages.
- Preserve exact supplied text, source identity, source digest, and respondent/evaluation provenance.
- Only answered mapped Choice selections produce follow-on groups. Preserve no-fit/unmapped, failed, pending, unreached, and non-Choice exclusions explicitly.
- Keep `responseHistory` and material inclusion separate. The isolated-passage recipe omits source answers and surrounding article text.
- Requests and packets accepted before this addition retain their existing frozen meaning; requests without the new flag retain existing follow-on grouping and packet behavior.
- No paid provider inference, automatic passage extraction, stable release/tag, or harness tool-isolation change is in scope.

## Review Focus

- A mixture of mapped, no-fit/unmapped, failed, pending, unreached, and non-Choice evaluations must report an exact eligible/excluded count and must not treat exclusions as negative judgments. Cover in Tasks 1 and 3.
- Two source answers for one respondent that map to different stimuli must not be collapsed into a shared follow-on context. Cover in Task 2.
- Source deletion after acceptance must not change selected text, source digest, or answer-to-output lineage. Cover in Task 3.
- Inspection followed by source mutation must reject acceptance, while an identical submission retry returns the same frozen run. Cover in Task 3.
- Existing requests without `includeSelectedMaterial` must preserve their packet and grouping behavior. Cover in Tasks 1 and 2.

---

**Status:** Paused by the user on 2026-10-03 pending Plan 3a. Tasks 1-3 are retained through `f09978f`; Task 4 has unfinished preliminary actor trials. Resume by rebasing onto the merged Plan 3a, updating this plan against the new harness, and preserving completed product work.

**Target development version:** `0.3.0-dev.6`. This checkpoint follows Plan 3a, which targets `0.3.0-dev.5`, after Plan 3 merged `0.3.0-dev.4` as PR #14. It is a development candidate, not a stable release, and receives no release tag.

The selected native `executing-plans` lane is inline. Per-answer resolution, no-fit accounting, source-version checks, frozen packets, and durable lineage all meet at follow-on admission. One implementation context keeps those contracts aligned. A fresh whole-branch review is the final code-review gate.

**Authority:** [Agreed dogfood improvement scope](../../specs/2026-10-02-v0.3.0-dogfood-improvements.md), section 3; [roadmap](roadmap.md); repository runbooks and playbooks.

## Contract

- An author can select answered source Choice evaluations and ask Sheg to reuse each respondent's exact mapped stimulus in a single follow-on run. Selection of material is data-driven from the saved answer and `materialOptions`; Sheg does not infer or extract a passage.
- Add an explicit `context.includeSelectedMaterial` request flag. It applies only to isolation contexts (`fresh-material` or `omit-history`) and combines the source answer's mapped material with any explicit shared `context.materialIds` and inline shared `material`, in that order. The resulting packet has no source trajectory or surrounding article text. Existing context modes keep their current meaning when the flag is absent. Recorded context cannot change its material.
- A mapped selected stimulus is resolved independently for each source evaluation. Do not group different source answers together when their selected materials differ. Each output question group for one source answer shares that answer's resolved material and the explicitly shared materials; it never receives another respondent's selected material.
- Only answered Choice evaluations with a valid material mapping produce follow-on groups. Preserve excluded source handles and a typed reason for pending, failed, unreached, non-Choice, and unmapped Choice answers. An unmapped answer includes its stable choice ID and authored meaning when available; do not infer that every unmapped option means no-fit.
- Inspection reports `selectionCoverage: { matched, eligible, excluded: { pending, failed, unreached, nonChoice, unmappedChoice } }` and the exact excluded evaluation/context handles, status, reason, and unmapped Choice ID/meaning. If nothing eligible remains, inspection is invalid and run_start creates no run. A partially eligible selection can be accepted only when its valid groups satisfy normal fit and call-budget rules; the accepted lineage retains its exclusions and coverage.
- At acceptance, freeze the exact source evaluation/context handles, respondent mapping, selected material ID and text digest, source identity and source digest, resolved packet, shared materials, and coverage. A follow-on remains readable after source deletion. Existing source-version race rejection and submission idempotency apply to the expanded contract.
- The source Choice question is part of the selection. Do not apply a Choice answer filter when selecting a varying per-respondent material mapping; querying all source answers for the chosen question allows unmapped/no-fit and incomplete outcomes to be counted.
- The author-facing example is the pull quote plus seven candidate paragraphs: select the Choice answers to the paragraph question, include each selected paragraph and the shared pull quote in isolation, then ask a bounded typed question about whether the paragraph expresses the quote. One run contains the eligible respondents; no-fit and other excluded rows are reported.
- No paid inference, automatic passage extraction, stable release/tag, or harness tool-isolation change is in scope. Immutable tool-use hooks and Devin profiles with tool use disabled remain possible future harness expansions only.

## Source map

- `src/domain/run/request.ts` owns strict follow-on request, evidence, and lineage schemas.
- `src/domain/decision/prompt.ts` owns context-mode packet assembly.
- `src/application/run-inspection.ts` resolves source answers into independently fit-checked follow-on groups.
- `src/infrastructure/run-store.ts` resolves exact saved material, snapshots source versions, enforces acceptance races, and retains lineage for recall after deletion.
- `src/domain/run/lifecycle.ts`, service results, MCP contracts, and `src/entrypoints/mcp.ts` expose safe selection coverage to the author.
- `test/run-inspection.test.ts`, `test/run-store.test.ts`, `test/mcp.test.ts`, `test/package.test.ts`, and relevant request/prompt tests cover schema, packet, persistence, and copied-plugin behavior.
- `skills/stimulus-response-polling/` owns the follow-on recipe and its selected-material/no-fit behavior scenario. Skill tests remain outside shipped plugin artifacts.
- `.agents/plans/v0.3.0-dogfood-improvements/roadmap.md` records the Plan 3 merge and Plan 4 evidence. Generated MCP/runtime output is derived from source.

## Tasks

### Task 1: Define the request and coverage contract

**Files:** Modify `src/domain/run/request.ts`, `src/domain/run/lifecycle.ts`, and `src/application/run-inspection.ts`; regenerate `skills/stimulus-response-polling/assets/run-request.schema.json`, `dist/mcp.js`, and `dist/worker.js` from source; test `test/run-request.test.ts` and `test/run-inspection.test.ts`.

**Interfaces:** `followOnRunRequestSchema` adds optional `context.includeSelectedMaterial: boolean`, valid only for `fresh-material` and `omit-history`. Criteria-based selection requires `selection.criteria.questionId` and forbids `selection.criteria.answer` when the flag is true; explicit source evaluation/context references remain valid. `Inspection` adds optional `selectionCoverage: { matched: number; eligible: number; excluded: { pending: number; failed: number; unreached: number; nonChoice: number; unmappedChoice: number } }`. `FollowOnLineage` adds optional persisted coverage and backward-compatible empty defaults for excluded source handles; old lineages do not receive invented counts.

**Consumes:** The existing strict follow-on selection, context mode, inspection, and lineage schemas.

**Produces:** Parsed flag and coverage types used by Tasks 2 and 3.

- [x] **Step 1: Write failing tests** for flag parsing, backward-compatible omitted flags and old lineage parsing, rejection outside isolation modes, criteria selection requiring a source `questionId` with no answer filter, valid/invalid coverage schema totals, and new admission lineages emitting an empty exclusion list.
- [x] **Step 2: Run the focused tests and verify the new-contract assertions fail** before implementation.
- [x] **Step 3: Add the strict request and typed coverage/exclusion schemas.** Require an explicit source question and no answer criterion for criteria-based variable material selection; exact evaluation/context references remain supported.
- [x] **Step 4: Rerun `node --import tsx --test test/run-request.test.ts test/run-inspection.test.ts` and verify old requests, new validation cases, and new lineage output pass.**
- [x] **Step 5: Regenerate the owned contracts and runtime** with `npm run contracts:build` and `npm run build`.
- [x] **Step 6: Commit the schema, contract tests, and generated outputs** with a focused message.

### Task 2: Resolve and assemble one selected stimulus per source answer (complete)

**Files:** Modify `src/domain/decision/prompt.ts`, `src/application/run-inspection.ts`, `src/infrastructure/run-store.ts`, `src/domain/run/request.ts`, `src/domain/run/lifecycle.ts`, and `test/prompts.test.ts`, `test/run-inspection.test.ts`.

**Interfaces:** `FollowOnSourceTurn` carries status and a verified optional selected-material record derived from its own source answer. `prepareFollowOnRun` combines ordered shared material with that source answer's selected material and creates one context per distinct source evaluation when the flag is enabled. `Inspection.selectionExclusions` lists exact excluded source handles and safe reason details beside aggregate coverage.

**Consumes:** Task 1's parsed `context.includeSelectedMaterial`, coverage, and lineage types.

**Produces:** Fit-measured and prepared packets that use identical per-answer material and stable shared-before-selected ordering.

- [x] **Step 1: Add failing packet and inspection tests** for the four-respondent scenario: two respondents select paragraph 3, one selects paragraph 7, and one selects no-fit. Assert one request prepares exactly three groups. Each packet contains the shared pull quote followed by that respondent's paragraph, no source trajectory or surrounding article, and no other respondent's candidate. Assert `selectionCoverage` distinguishes mapped, unmapped/no-fit, non-Choice, failed, pending, and unreached source rows and reconciles matched, eligible, and excluded totals. Assert `selectionExclusions` identifies each excluded source evaluation/context and preserves the unmapped choice ID and authored meaning.
- [x] **Step 2: Add a repeated-selection test** where one respondent has two separately selected source evaluations; each selection gets a distinct material-specific context, while multiple follow-on questions within one selection share that context.
- [x] **Step 3: Run the focused prompt and inspection tests and verify the assertions fail** before implementation.
- [x] **Step 4: Resolve the saved Choice answer in `src/infrastructure/run-store.ts` through its exact `materialOptions` link and retained source catalog, carrying source status and verified selected material into each source turn.** In `src/application/run-inspection.ts`, compute coverage and exclusions, filter to answered mapped Choice rows, and assemble shared materials before the mapped selection. Keep source identity and digests in lineage, never in provider prompt state. Preserve existing grouping when the flag is absent.
- [x] **Step 5: Run focused run-store and inspection tests; compare fit-measured packets with prepared packets.**
- [x] **Step 6: Commit the per-answer resolver and packet tests.**

### Task 3: Freeze selection lineage and protect acceptance/recall (complete)

**Files:** Modify `src/infrastructure/run-store.ts`, `src/application/run-inspection.ts`, `src/application/run-service.ts`, `src/domain/run/request.ts`, `src/domain/run/lifecycle.ts`, and `src/entrypoints/mcp.ts`; test `test/run-store.test.ts`, `test/mcp.test.ts`, and `test/package.test.ts`.

**Interfaces:** Stored follow-on lineage records eligible source-to-output mappings, exact selected/shared material snapshots, per-source material digests, and excluded source handles with typed reasons. `Inspection.selectionCoverage` reports matched and eligible totals plus exact exclusion counts.

**Consumes:** Tasks 1 and 2's coverage, exclusions, selected-material record, and per-answer group semantics.

**Produces:** Atomic admission validation, durable query/recall evidence, and a copied-MCP one-run integration path.

- [x] **Step 1: Add failing store tests** for coverage and exclusions surviving acceptance, source handles mapping to correct output contexts, exact source/text digest recall after source deletion, rejection after source changes between inspection and acceptance, and idempotent identical submission retry.
- [x] **Step 2: Add a copied-MCP test** that starts a selected-material follow-on, recalls its selected packet and lineage after source deletion, and confirms selection coverage.
- [x] **Step 3: Run the focused store and package tests to witness the missing behavior.**
- [x] **Step 4: Freeze eligible mappings, exclusions, source version, and recipient-specific material evidence in the accepted lineage.** Preserve exact validation between lineage, request, snapshots, and packet state. For selected-material requests, retain shared items, each recipient's selected item, and materials explicitly mapped by the follow-on questions; do not retain unrelated respondents' candidate text in that recipient's catalog. Preserve existing catalog semantics when the flag is absent.
- [x] **Step 5: Run `node --import tsx --test test/run-store.test.ts test/mcp.test.ts test/package.test.ts` and verify query, recall, deletion, race, and retry behavior.**
- [x] **Step 6: Commit the persistence, lineage, and copied-package tests.**

### Task 4: Teach and pressure-test the selected-stimulus workflow

**Files:** Modify `skills/stimulus-response-polling/references/run-and-recovery.md`; version the selected-material scenario in `skills/stimulus-response-polling/tests/behavior/scenarios.json` if its tested interface or criteria changes; retain candidate actor evidence under `skills/stimulus-response-polling/tests/behavior/traces/campaign/`.

**Consumes:** The request field, coverage output, and packet semantics from Tasks 1 through 3.

**Produces:** Current installed-skill instructions for one-run per-answer reuse, plus candidate traces tied to the exact skill digest.

- [ ] **Step 1: Inspect the retained baseline campaign** and run at least five fresh-context trials against current guidance before editing. Keep the fixed request, mock evidence, and existing evaluator criteria unchanged.
- [ ] **Step 2: Update the shipped follow-on reference and versioned scenario guidance** to demonstrate the one-run request shape, source question selection, exact per-answer material reuse, shared quote, isolation, no-fit/unmapped exclusions, and reading selection coverage. State that Sheg does not extract text. Do not recommend one run per paragraph.
- [ ] **Step 3: Run at least five fresh-context candidate trials** with the same requests and controlled evidence, recording model settings and skill digest. Manually inspect all flagged results. Campaign records continue to mark `toolUseAudit: "not-captured"`.
- [ ] **Step 4: Run deterministic scenario/evaluator tests and current skill-hash validation.** Ensure no `tests/behavior/` asset enters the candidate plugin package.
- [ ] **Step 5: Commit only skill source and its owned behavior tests/traces.**

The guidance should show the one-run request shape, source evaluation selection by question, exact per-answer mapped material reuse, explicit shared quote, isolation semantics, no-fit/unmapped exclusions, and how to read selection coverage. It must not recommend one run per paragraph or imply that Sheg extracts text from an answer. Do not add tool-use hooks or Devin tool-disabled profiles.

**Verify:** Run the deterministic scenario tests, validate scenario/evaluator pairing and current guidance hashes, inspect every trial, and ensure behavior test assets remain excluded from the plugin archive.

### Task 5: Set the dev.6 identity and complete the checkpoint

**Files:** Modify `package.json`, `package-lock.json`, `plugin.json`, generated MCP/runtime files, and this roadmap. Keep generated output derived from source.

**Consumes:** Tasks 1 through 4; Plan 3's verified merge evidence.

**Produces:** Aligned `0.3.0-dev.6` manifests, validated candidate ZIP, and a review-ready feature branch.

- [ ] **Step 1: Update the development identity** in all authoritative version fields to `0.3.0-dev.6` and set the roadmap's Plan 3 evidence to PR #14, head `9ce5da28858bcc20da66b6805a630feb2ef92ab2`, merge `be3ff2a2490af73627ba60c096e90036c3fe85a6`, hosted check success, clean fresh review, and 360-test staged gate.
- [ ] **Step 2: Run `npm run build` and `npm run plugin:package -- --validate-only`.**
- [ ] **Step 3: Run the complete `npm run verify` through the tracked staged commit gate.**
- [ ] **Step 4: Package a local no-tag dev.6 ZIP**, record file count and SHA-256 in the plan, and verify it ships the two skill entrypoints while excluding all behavior test assets. Do not tag or publish.
- [ ] **Step 5: Commit the version, generated runtime, plan, roadmap, and candidate evidence.**

Align `package.json`, both root version fields in `package-lock.json`, `plugin.json`, MCP initialization, and generated runtime output at `0.3.0-dev.6`. Update the roadmap with Plan 3's verified merge: PR #14 merged to `develop` at `be3ff2a2490af73627ba60c096e90036c3fe85a6` from exact head `9ce5da28858bcc20da66b6805a630feb2ef92ab2`; hosted `sheg-verify` passed, fresh whole-branch review found no actionable issues, and the staged gate passed all 360 tests.

**Verify:** Run focused tests for every changed boundary, `npm run build`, `npm run plugin:package -- --validate-only`, and the tracked staged `npm run verify` gate before publication. Build a local no-tag candidate with `npm run plugin:package -- --output <scratch>/sheg-v0.3.0-dev.6.zip`; record its file count and SHA-256 and confirm it includes shipped skills but no behavior tests. Do not tag or publish it.

## Review focus

- Does each child packet derive its selected stimulus from that exact source answer's Choice mapping and preserve authored source provenance?
- Can any recipient packet or exposed source-level result contain another respondent's material or the original surrounding article in isolation mode?
- Are no-fit/unmapped, non-Choice, pending, failed, and unreached source rows distinguished from eligible groups and preserved after source deletion?
- Do inspection, packet fit, accepted requests, query/recall, source-version race checks, and submission idempotency agree on the exact selected packet and coverage?
- Are older follow-on requests and frozen runs unchanged when `includeSelectedMaterial` is absent?
- Does the skill demonstrate the feature without inventing a no-fit classification, asking for separate runs, or claiming tool use was audited?

## Readiness and handoff evidence

- Plan 3 merged through [PR #14](https://github.com/HarleyBartles/sheg/pull/14). PR head: `9ce5da28858bcc20da66b6805a630feb2ef92ab2`. Squash merge: `be3ff2a2490af73627ba60c096e90036c3fe85a6`, the current `develop` base for this plan. Hosted `sheg-verify` passed on the exact head.
- Fresh Plan 4 worktree: `Z:/_agent-worktrees/sheg/codex/v0.3.0-selected-stimulus`, branch `codex/v0.3.0-selected-stimulus`, created from `origin/develop` at `be3ff2a2490af73627ba60c096e90036c3fe85a6` with the canonical worktree helper.
- Initial status: clean. `npm test` passed 360 tests, zero failures or skips.
- Current develop candidate is `0.3.0-dev.4`; this plan's merge candidate is `0.3.0-dev.6`.

## Pause and resume dependency

Plan 3a must merge before this plan resumes. Replace Task 4 manual campaign assembly with the runner and layered graders delivered by Plan 3a. Preserve preliminary outputs as historical observations, not completed old/new proof. Rebase the retained branch onto latest develop, inspect shared-file conflicts, refresh generated source and focused product tests, and update the resumed campaign contract before further implementation. The selected-material scenario currently describes the pre-feature interface; freeze the old guidance but grade both arms against the new intended product contract when measuring whether new guidance teaches the implemented feature. Record any rubric/input change as a new experiment, never as an unchanged historical comparison.
