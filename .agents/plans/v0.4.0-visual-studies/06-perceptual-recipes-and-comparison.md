# Perceptual Recipes and Comparison Investigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and teach the full v0.4.0 visual-study scope with admitted Clef inputs, complete article/A-B/character recipes, and an evidence-based decision about all-four versus independent pairwise comparison.

**Architecture:** Reuse the durable asset, pixel-binding, same-state batching, matched-fork, follow-on, evidence, and provider-selection contracts completed in Plans 1-5. Fix the confirmed proportional-scaling defect needed to prepare the full six-character input set. Use singleton Clef executions for independent pairs so each wire request contains only its two bound images; never pack sibling pair questions into a request that exposes their union of images. Keep live probe evidence in scratch and ship only behavioral tests, supported guidance, and a concise decision record.

**Tech Stack:** TypeScript, Zod, SQLite run store, Node test runner, native Cloudflare Workers AI Clef REST, canonical Sheg skills and generated self-contained plugin.

**Spec:** `.agents/specs/2026-10-04-v0.4.0-visual-studies.md`, sections 3-5, 8-13 and acceptance criteria 1-4, 10, 14. **Roadmap:** `roadmap.md`, Plan 6, based on merged Plan 5 (`773cbc6`).

**Execution Strategy:** `executing-plans` with Native inline execution because probe results determine which recipe guidance ships, while scaler behavior, exact Clef packet exposure, examples, and behavior fixtures need one integrated evidence trail; an independent implementer per task would repeat paid probes or risk changing the comparison basis.

## Global Constraints

- Use the direct Cloudflare Workers AI REST route and the configured `clef` model; do not use OpenRouter or silently switch model/provider.
- Each Clef call may carry at most four distinct images, and six-image independent pairwise comparisons must expose exactly the two candidates for that pair.
- Keep profile/narrative, criteria, pre-comparison history, model and provider fixed within declared comparisons; pair questions receive no sibling answers.
- Treat whole-article placement as an informed hypothetical, distinct from a staged reached-only journey; never call it first-encounter continuation.
- Preserve capture/input provenance, scaled-image lineage, authored alt text/captions, and explicit selection of prepared assets.
- Describe outcomes as correlated model judgments, not human response rates, real attention, measured clicks, or universal model equivalence.
- Do not add a tournament, numerical ranking formula, statistical equivalence threshold, hidden context trimming, contact-sheet image-limit bypass, or automatic conversion between comparison shapes.
- Keep credentials, raw requests/responses and live run databases outside the repository; do not print or persist secrets.
- Generate canonical contracts, runtime and plugin projections from source. Preserve released v0.3.0 and schema-9 compatibility.

## Review Focus

- Non-integer aspect ratios must scale to the requested bounded dimensions without collapsing toward 1x1 or stretching by more than integer-pixel quantization; test the actual stored candidate and full-image orientation.
- Every independent pair's serialized Clef request must contain only that pair's two images, even when fifteen logical comparisons share one accepted poll; prove singleton planning and wire compilation together.
- Three overlapping four-image selection calls can document three local choices only; they must not be described as completing or aggregating a six-design pairwise ranking.
- Hypothetical placement questions must retain the whole article and state their exposure boundary; staged reading must expose only reached content and retain branch isolation.
- Screenshot readability judgments must not be rescued by accompanying plaintext that gives away the relevant rendered content; capture and font provenance may be unknown but never invented.

---

## Task 1: Repair Proportional Scaling for Non-Integer Ratios

**Files:** Modify `src/application/image-preparation.ts` and `src/infrastructure/images/codecs.ts`; extend `test/image-preparation.test.ts` and `test/image-codecs.test.ts`; update `docs/guides/image-preparation.md` only if the supported scale behavior or limits change.

**Consumes:** Plan 1 asset import, source-preserving derivation and codec contracts; reproduced failure using the approved Klause hero dimensions 1178x1335.

**Produces:** Bounded integer output dimensions chosen once from a common downscale factor, not recursively rounded down. The codec accepts normal integer quantization (at most one pixel from the expected dimension at the limiting factor), rejects larger distortion and upscaling, and still returns a full-frame candidate with exact source/candidate digests and derivation.

- [ ] **Step 1: Add the failing service-level behavior test.** Encode a synthetic 41x29 source through the existing codec, import it through the real preparation service, scale with `maxWidth: 20`, and assert the stored candidate is 20x14, remains non-upscaled and full-frame, and is independently addressable while source bytes remain intact. Also assert the returned dimensions satisfy both authored bounds.
- [ ] **Step 2: Run the focused test and prove RED.** Run `node --import tsx --test --test-name-pattern="non-integer aspect ratio" test/image-preparation.test.ts`; expected: current recursive rounding returns a severely undersized candidate (or fails) instead of the largest proportional bounded candidate.
- [ ] **Step 3: Add the failing codec quantization test.** Pass a decoded 41x29 image to the real codec at the intended rounded 20x14 output and assert the whole image is resized to those exact integer dimensions with orientation normalized and corner/region evidence retained. Keep the existing 40x40 non-proportional rejection.
- [ ] **Step 4: Run the codec test and prove RED.** Run `node --import tsx --test --test-name-pattern="integer-quantized proportional|non-proportional dimensions" test/image-codecs.test.ts`; expected: the valid rounded target is rejected by the current strict exact-floor ratio check while the deliberately distorted target remains rejected.
- [ ] **Step 5: Implement the minimum correction and verify GREEN.** Compute dimensions from one common fit factor and floor once; remove iterative inward recomputation. In the codec, accept at most one-pixel integer quantization per dimension while retaining no-upscale and aspect-error bounds. Run both focused tests and verify the deliberately distorted control still fails.
- [ ] **Step 6: Verify approved candidates through Sheg's built CLI.** Build the runtime, import and scale Klause and Index approved hero sources in an isolated scratch data root, and inspect returned metadata and exported previews. Confirm candidate dimensions respect bounds, look at each complete candidate, and confirm source digest/bytes do not change. Keep source files untouched.

## Task 2: Prove Six-Design Pair Exposure and Compare Shapes

**Files:** Extend `test/provider-batch-selection.test.ts` or the current owner test discovered for actual provider batches; extend `test/clef-provider.test.ts` for serialized image counts/bindings; add/update `docs/providers/clef.md`, `skills/stimulus-response-polling/references/native-clef.md`, and `skills/study-design/references/primitives-and-tools.md` with supported comparison guidance.

**Consumes:** Clef's four-image compiler limit, explicit pixel bindings, provider batch planner's singleton control, image scaling from Task 1, approved Specialist Crew hero references and Writ's accepted character brief in `Z:/adventures-of-patch`.

**Produces:** A complete six-candidate decision record based on six approved, separately scaled portraits and the Writ brief. The full independent-pair condition has 15 questions with `batching: "singleton"`, one physical request per pair, and only the two bound images in each compiled request. A separate condition uses the three four-image sets ABCD, ABEF, CDEF (alphabetical labels map to the six portraits) and reports each four-way selection separately. Do not infer pairwise outcomes from a quartet's winner or merge three quartet choices into one ranking.

- [ ] **Step 1: Add a RED planning/wire behavior test for six candidates.** Construct six distinct saved-image materials and all 15 pair Choice questions against one fixed state. Inspect with singleton Clef and assert 15 planned calls; assert each batch has one question, two image materials, and the expected pair-only bindings. Add a negative automatic-batching case demonstrating that a multi-question batch's image union can exceed the pair's two-image exposure even while remaining under four, so it cannot be called an independent pair study.
- [ ] **Step 2: Run the focused test and prove RED.** Run the named provider-batch and Clef compiler tests; expected: there is no existing end-to-end assertion that the physical wire projection for every singleton contains only the question's pair and preserves all 15 logical pairs.
- [ ] **Step 3: Implement only a necessary packet-boundary correction.** If current code fails the test, correct the owner that assembles singleton questions and their visual materials; preserve question identity, state, allowance reservation and independent result handling. Do not add a pairwise-specific runtime primitive where generic Choice plus singleton already expresses the study.
- [ ] **Step 4: Run the focused tests and verify GREEN.** Assert exact serialized image count and image-index mapping for every pair, no sibling answer in the shared state, and no provider attempt for a five-image question. Confirm four-image direct comparison remains one authored call and fails closed when a fifth bound image is added.
- [ ] **Step 5: Execute the controlled live comparison.** Use one fixed respondent profile, same Writ accepted visual-lock brief, same six scaled portraits, same `clef` model/provider and neutral blinded labels. Run the 15 independent pairs in a balanced first/second order; add reverse-order repeats for three preselected pairs spanning a clear, close and ambiguous result. Separately run the three four-way sets and one reversed-order repeat of the preselected quartet. Use `maxCalls: 23` (22 planned calls plus one retry allowance) and inspect before dispatch. Store raw requests, attempts, results, usage and costs only under `Z:/_agent-scratch/sheg-clef-trials`.
- [ ] **Step 6: Analyze without inventing a winner.** Report each four-way selection, all pair outcomes, ties, disagreements, directed cycles, unpaired coverage, reversed-order instability, per-call usage and supported charge estimates. Compare which six-design relationships each shape directly observes. State that the three quartet calls do not cover all 15 independent pair conditions and cannot be combined into an automatic ranking. Revisit the prior four-design all-four/six-pair probe by reading its recorded answers and usage; do not rerun identical inputs solely to reproduce a desired result.
- [ ] **Step 7: Freeze only the supported author choice in guidance.** If pairwise adds no useful distinction for this bounded decision, recommend the economical four-way shape for up to four candidates while preserving direct separate pair questions as an authored option without marketing a dedicated primitive. If pairwise reveals decision-relevant distinctions, teach both shapes and their different visible alternatives/economics. If the findings do not settle this human-facing choice, stop at this task with concrete evidence and ask the author before changing the live recommendation; do not proceed on an assumed winner.

## Task 3: Ship Article Placement Recipes and Exposure Tests

**Files:** Update `skills/study-design/SKILL.md`, its relevant reference under `skills/study-design/references/`, and `skills/study-design/tests/behavior/{scenarios,evaluators}.json`; extend `test/skill-testing/` only where deterministic harness behavior needs a real scenario checkpoint; regenerate packaged skills.

**Consumes:** Existing poll and journey primitives, ordered text/image materials, same-state question grouping, matched forks, and Plan 5 compact visual history.

**Produces:** One complete whole-article hypothetical recipe with ordered sections, supplied image/alt text/caption, explicit insertion-point definitions, independently authored placement questions and chosen typed dimensions (relevance, continuity, distraction, comprehension, expressed interest). A separate staged recipe stops at the reached insertion point, branches image/no-image only for eligible readers, and resumes from compact history without claiming unseen-future prediction.

- [ ] **Step 1: Add two behavior scenarios and evaluators before editing guidance.** One asks about a five-section article with an image at multiple hypothetical positions and demands the whole article exposure label. One asks whether reached readers continue after section three into section four with/without the image and demands a matched reached-only fork. Criteria must reject sibling-answer leakage, unprovided human evidence, and conflating expressed interest with actual continuation.
- [ ] **Step 2: Run the scenario catalog/harness validation and prove the new checks fail under candidate guidance.** Use repository skill-behavior tooling and its frozen inputs; keep campaign actors, reports and scratch databases outside the repo. Confirm the evaluators distinguish the hypothetical and reached-only evidence bases.
- [ ] **Step 3: Write the two canonical recipes.** Show the exact material order, image descriptor/caption boundary, representative typed question, fork boundary, comparison key/model lock, maxCalls planning, and result queries. Use generic authored content in shipped examples rather than the external Patch assets.
- [ ] **Step 4: Run deterministic recipe/request tests and review the guidance against both frozen scenarios.** Verify article sections and insertion labels remain frozen stimuli, sibling answers are absent, fork members share the same prefix, and failures/unreached branches are not counted as stopping choices.

## Task 4: Ship Rendered Treatment and Character Recipes

**Files:** Update the stimulus-response skill and linked references under `skills/stimulus-response-polling/`, add behavior scenarios/evaluators under its existing `tests/behavior/`, and update `docs/providers/clef.md` or `docs/guides/image-preparation.md` where a human operator needs the admitted-input limit explained.

**Consumes:** Plan 1 explicit scaled candidates and provenance; Plan 2 pixel polls; Plan 3 comparison locks and singleton/automatic controls; Plan 4 matched forks; Task 2's live comparison findings.

**Produces:** Complete rendered A/B instructions for equivalent separate variants versus direct preference, including viewport/capture/font provenance, text-bypass disclosure and image-scaling legibility checks. Complete character recipes distinguish unprompted trait expression, prompted brief fit, matching a named character from bounded script evidence, and protagonist prominence. Both one four-way selection and six isolated pair questions are documented only as supported by Task 2's evidence.

- [ ] **Step 1: Add behavior scenarios for rendered A/B, character brief fit and script identity.** Include a near-miss where plaintext supplies screenshot text (so visual readability is not measured), a sketch matching heroic/intelligent traits, and a script with multiple characters that requires identifying whose design is under test. Add a separate protagonist-prominence request that may not be reported as character-brief fit.
- [ ] **Step 2: Validate the frozen cases against the current guidance and prove the missing distinctions.** Criteria must distinguish independent adequacy from direct preference, record unknown capture provenance honestly, require explicit input selection after scaling, and forbid claims of typography expertise or actual reader conversion.
- [ ] **Step 3: Add concise canonical recipes after the comparison finding is settled.** Reuse matched forks for separate A/B exposure; use a direct joint question only when the author wants a direct preference. For character tasks, keep unprompted and prompted evidence in separate contexts, bind at most four images, identify the script character, and make the candidate set and pair/four-way semantics explicit.
- [ ] **Step 4: Run behavior-fixture validation, generated-skill checks and targeted package tests.** Confirm every new scenario has an evaluator, the skill package includes the canonical references, and no live Patch image/bible path is embedded in shipped guidance or plugin output.

## Task 5: Reconcile Decision Records, Roadmap and Release Evidence

**Files:** Update `.agents/plans/v0.4.0-visual-studies/roadmap.md`, the Plan 6 row and slice contract; update `docs/decisions/README.md` and add one decision record only if the live comparison establishes a durable product choice; regenerate contracts/plugin projections; add appropriate tests in the image, provider and skill owners.

**Consumes:** Tasks 1-4, approved spec acceptance criteria, scratch-only native Clef evidence, and source-quality review.

**Produces:** Plan 6 implementation with the complete recipe coverage in acceptance criteria 1-4 and 10, verified scaler contract for criterion 14, evidence-based four-way/pairwise guidance, and Plan 7 left JIT pending. A supported comparison-shape decision is recorded in an ADR if it changes the previous open design; no live token, request body, user asset, or test receipt enters source control.

- [ ] **Step 1: Trace the spec requirements to changed owners and behavior tests.** Re-read sections 3-5, 8-13 and criteria 1-4, 10, 14; identify any missing behavior and add its owner test before docs are finalized.
- [ ] **Step 2: Update the roadmap cursor without receipts.** Mark Plan 6 complete only after recipe tests and required probe analysis are complete; Plan 7 remains JIT pending after the merged Plan 6 predecessor. Record PR/commit identity after merge, not command narration.
- [ ] **Step 3: Regenerate canonical outputs and run the exact repository gate.** Run `npm run contracts:build`, `npm run build`, `npm run plugin:package -- --validate-only`, `npm run verify`, targeted copied-package tests, and `git diff --check`; inspect generated drift and plugin-owned copies.
- [ ] **Step 4: Conduct a fresh whole-branch review and resolve every actionable finding.** Review source, tests, user-facing recipes, skill behavior fixtures, generated runtime, and decision-record placement against the approved spec.
- [ ] **Step 5: Verify version identity and publish.** Refresh `origin/develop`, ensure the proposed dev identity is unique, rebuild if stale, commit and push the exact verified tree, open a PR to `develop`, verify CI and merge result, fast-forward `Z:/sheg/develop`, and retire only the verified clean Plan 6 worktree and merged branch.

## Execution Handoff

This plan is approved for `executing-plans` under the active goal to execute each just-in-time roadmap plan inline, merge it to `develop`, and clean its worktree and branch. The author has already authorized live Clef investigation without a finite call cap; this plan nevertheless sets a finite 21-call trial plus one retry allowance and requires inspection before dispatch.
